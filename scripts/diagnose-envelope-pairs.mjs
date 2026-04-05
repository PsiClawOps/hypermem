#!/usr/bin/env node
/**
 * diagnose-envelope-pairs.mjs
 *
 * For each envelope-shaped user row, prints a neighborhood view:
 *   - the envelope row itself (raw + all normalized forms)
 *   - the N nearest prior user rows in the same conversation
 *   - the first assistant row after the envelope
 *   - id gap, time delta, match confidence
 *
 * Usage:
 *   node scripts/diagnose-envelope-pairs.mjs --agent forge [--limit 20] [--verbose]
 *   node scripts/diagnose-envelope-pairs.mjs --all [--limit 5]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const dataDir = path.join(os.homedir(), '.openclaw', 'hypermem', 'agents');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return (i !== -1 && i + 1 < process.argv.length) ? process.argv[i + 1] : fallback;
}
function flag(name) { return process.argv.includes(name); }

const agentFilter = arg('--agent');
const limitPerAgent = parseInt(arg('--limit', '20'), 10);
const verbose = flag('--verbose');
const all = flag('--all') || !agentFilter;

// ── Normalization layers ──────────────────────────────────────────────────────

/** Strip the full envelope header: Sender block + JSON + bracket timestamp line */
function stripEnvelopeHeader(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Skip "Sender (untrusted metadata):" and everything until blank line or code fence end
    if (/^Sender \(untrusted metadata\):/i.test(line)) {
      i++;
      // Skip JSON block that follows
      while (i < lines.length) {
        if (lines[i].trim() === '') { i++; break; }
        if (lines[i].trim() === '```') { i++; break; }
        i++;
      }
      // Skip any trailing blank lines
      while (i < lines.length && lines[i].trim() === '') i++;
      continue;
    }

    // Skip ```json ... ``` blocks containing openclaw/sender metadata
    if (/^```json\s*$/i.test(line)) {
      const blockStart = i;
      let j = i + 1;
      const blockLines = [line];
      while (j < lines.length) {
        blockLines.push(lines[j]);
        if (lines[j].trim() === '```') { j++; break; }
        j++;
      }
      const blockText = blockLines.join('\n');
      if (blockText.includes('"label":') || blockText.includes('"username":') || blockText.includes('openclaw')) {
        i = j;
        // Skip trailing blank lines
        while (i < lines.length && lines[i].trim() === '') i++;
        continue;
      }
      // Not a metadata block, keep it
      out.push(...blockLines);
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }
  return out.join('\n').trim();
}

/** Remove bracket timestamp prefix: [Sun 2026-04-05 13:17 MST] ... → ... */
function stripBracketTimestamp(text) {
  if (!text) return '';
  // Multi-line: only strip from the first line
  const lines = text.split('\n');
  lines[0] = lines[0].replace(/^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/, '');
  return lines.join('\n').trim();
}

/** Remove ISO timestamp lines */
function stripIsoTimestamp(text) {
  if (!text) return '';
  return text.split('\n')
    .filter(l => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(l.trim()))
    .join('\n').trim();
}

/** Collapse whitespace for fuzzy comparison */
function normalizeWhitespace(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Full canonicalization pipeline */
function canonicalize(text) {
  let t = stripEnvelopeHeader(text);
  t = stripBracketTimestamp(t);
  t = stripIsoTimestamp(t);
  t = normalizeWhitespace(t);
  return t;
}

function isoMs(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Levenshtein distance (for short strings only) */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length > 500 || b.length > 500) return Math.abs(a.length - b.length); // approximate for long strings
  const dp = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array(b.length + 1);
    row[0] = i;
    return row;
  });
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[a.length][b.length];
}

/** Classify a candidate pair */
function classifyMatch(envelopeCanon, candidateCanon, idGap, deltaMs) {
  if (!envelopeCanon || !candidateCanon) return { confidence: 0, classification: 'do_not_touch', reason: 'empty' };

  const exactMatch = envelopeCanon === candidateCanon;
  const editDist = exactMatch ? 0 : levenshtein(envelopeCanon.slice(0, 500), candidateCanon.slice(0, 500));
  const maxLen = Math.max(envelopeCanon.length, candidateCanon.length, 1);
  const similarity = 1 - (editDist / maxLen);

  // Starts-with check: envelope text often has the bare text as a suffix
  const startsWith = envelopeCanon.startsWith(candidateCanon) || candidateCanon.startsWith(envelopeCanon);

  let score = 0;
  const reasons = [];

  // Text similarity
  if (exactMatch) {
    score += 50;
    reasons.push('exact_canon_match');
  } else if (similarity >= 0.95) {
    score += 40;
    reasons.push(`high_similarity(${similarity.toFixed(3)})`);
  } else if (similarity >= 0.85) {
    score += 25;
    reasons.push(`good_similarity(${similarity.toFixed(3)})`);
  } else if (startsWith) {
    score += 20;
    reasons.push('starts_with_match');
  } else if (similarity >= 0.5) {
    score += 10;
    reasons.push(`moderate_similarity(${similarity.toFixed(3)})`);
  } else {
    reasons.push(`low_similarity(${similarity.toFixed(3)})`);
  }

  // Time proximity
  if (deltaMs != null) {
    if (deltaMs <= 30_000) { score += 25; reasons.push(`time_close(${(deltaMs/1000).toFixed(1)}s)`); }
    else if (deltaMs <= 120_000) { score += 15; reasons.push(`time_near(${(deltaMs/1000).toFixed(1)}s)`); }
    else if (deltaMs <= 600_000) { score += 5; reasons.push(`time_far(${(deltaMs/1000).toFixed(1)}s)`); }
    else { reasons.push(`time_too_far(${(deltaMs/1000).toFixed(1)}s)`); }
  }

  // ID proximity
  if (idGap <= 3) { score += 20; reasons.push(`id_close(${idGap})`); }
  else if (idGap <= 6) { score += 10; reasons.push(`id_near(${idGap})`); }
  else if (idGap <= 15) { score += 3; reasons.push(`id_far(${idGap})`); }
  else { reasons.push(`id_too_far(${idGap})`); }

  // Length ratio check — if one is much longer, less likely a duplicate
  const lenRatio = Math.min(envelopeCanon.length, candidateCanon.length) / maxLen;
  if (lenRatio < 0.5) {
    score -= 15;
    reasons.push(`length_mismatch(${lenRatio.toFixed(2)})`);
  }

  const confidence = Math.max(0, Math.min(100, score));

  let classification;
  if (confidence >= 70) classification = 'safe_duplicate';
  else if (confidence >= 45) classification = 'probably_duplicate';
  else if (confidence >= 25) classification = 'needs_review';
  else classification = 'do_not_touch';

  return { confidence, classification, reasons, similarity: similarity.toFixed(3), editDist, lenRatio: lenRatio.toFixed(2) };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function diagnoseAgent(agentId) {
  const dbPath = path.join(dataDir, agentId, 'messages.db');
  if (!fs.existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);

  const envelopes = db.prepare(`
    SELECT id, conversation_id, text_content, created_at
    FROM messages
    WHERE role = 'user'
      AND text_content LIKE 'Sender (untrusted metadata):%'
    ORDER BY id ASC
    LIMIT ?
  `).all(limitPerAgent);

  const getPriorUsers = db.prepare(`
    SELECT id, text_content, created_at
    FROM messages
    WHERE conversation_id = ?
      AND role = 'user'
      AND id < ?
    ORDER BY id DESC
    LIMIT 10
  `);

  const getNextAssistant = db.prepare(`
    SELECT id, text_content, created_at
    FROM messages
    WHERE conversation_id = ?
      AND role = 'assistant'
      AND id > ?
    ORDER BY id ASC
    LIMIT 1
  `);

  const groups = [];

  for (const env of envelopes) {
    const envelopeCanon = canonicalize(env.text_content);
    const envelopeStripped = stripEnvelopeHeader(env.text_content);
    const envelopeNoBracket = stripBracketTimestamp(envelopeStripped);

    const priors = getPriorUsers.all(env.conversation_id, env.id);
    const nextAssistant = getNextAssistant.all(env.conversation_id, env.id);

    const candidates = priors.map(p => {
      const pCanon = canonicalize(p.text_content);
      const idGap = env.id - p.id;
      const envMs = isoMs(env.created_at);
      const pMs = isoMs(p.created_at);
      const deltaMs = (envMs != null && pMs != null) ? envMs - pMs : null;

      const match = classifyMatch(envelopeCanon, pCanon, idGap, deltaMs);

      return {
        id: p.id,
        created_at: p.created_at,
        raw_preview: (p.text_content || '').slice(0, 120),
        canonicalized: pCanon.slice(0, 120),
        id_gap: idGap,
        delta_ms: deltaMs,
        delta_s: deltaMs != null ? (deltaMs / 1000).toFixed(1) : null,
        ...match,
      };
    });

    // Sort candidates by confidence descending
    candidates.sort((a, b) => b.confidence - a.confidence);

    const bestMatch = candidates[0] || null;

    groups.push({
      envelope: {
        id: env.id,
        conversation_id: env.conversation_id,
        created_at: env.created_at,
        raw_preview: (env.text_content || '').slice(0, 200),
        stripped_preview: envelopeStripped.slice(0, 200),
        no_bracket_preview: envelopeNoBracket.slice(0, 200),
        canonicalized: envelopeCanon.slice(0, 200),
      },
      best_match: bestMatch ? {
        id: bestMatch.id,
        raw_preview: bestMatch.raw_preview,
        canonicalized: bestMatch.canonicalized,
        confidence: bestMatch.confidence,
        classification: bestMatch.classification,
        id_gap: bestMatch.id_gap,
        delta_s: bestMatch.delta_s,
        similarity: bestMatch.similarity,
        reasons: bestMatch.reasons,
      } : null,
      next_assistant: nextAssistant[0] ? {
        id: nextAssistant[0].id,
        preview: (nextAssistant[0].text_content || '').slice(0, 120),
      } : null,
      all_candidates: verbose ? candidates.slice(0, 5) : undefined,
    });
  }

  // Summary counts
  const counts = { safe_duplicate: 0, probably_duplicate: 0, needs_review: 0, do_not_touch: 0, no_candidate: 0 };
  for (const g of groups) {
    if (!g.best_match) counts.no_candidate++;
    else counts[g.best_match.classification]++;
  }

  return { agentId, total_envelopes: envelopes.length, counts, groups };
}

const agents = all
  ? fs.readdirSync(dataDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
  : [agentFilter];

const results = agents.map(a => diagnoseAgent(a)).filter(Boolean);

// Print summary table first
console.log('\n═══ ENVELOPE DIAGNOSIS SUMMARY ═══\n');
console.log('Agent          | Total | Safe | Probable | Review | Skip | NoCand');
console.log('───────────────|───────|──────|──────────|────────|──────|───────');
for (const r of results) {
  const c = r.counts;
  console.log(`${r.agentId.padEnd(15)}| ${String(r.total_envelopes).padStart(5)} | ${String(c.safe_duplicate).padStart(4)} | ${String(c.probably_duplicate).padStart(8)} | ${String(c.needs_review).padStart(6)} | ${String(c.do_not_touch).padStart(4)} | ${String(c.no_candidate).padStart(5)}`);
}

const totals = results.reduce((acc, r) => {
  acc.total += r.total_envelopes;
  for (const k of Object.keys(r.counts)) acc[k] = (acc[k] || 0) + r.counts[k];
  return acc;
}, { total: 0 });
console.log('───────────────|───────|──────|──────────|────────|──────|───────');
console.log(`${'TOTAL'.padEnd(15)}| ${String(totals.total).padStart(5)} | ${String(totals.safe_duplicate || 0).padStart(4)} | ${String(totals.probably_duplicate || 0).padStart(8)} | ${String(totals.needs_review || 0).padStart(6)} | ${String(totals.do_not_touch || 0).padStart(4)} | ${String(totals.no_candidate || 0).padStart(5)}`);

// Print detail for each agent
for (const r of results) {
  if (r.total_envelopes === 0) continue;
  console.log(`\n\n═══ ${r.agentId.toUpperCase()} — ${r.total_envelopes} envelope rows ═══\n`);
  for (const g of r.groups) {
    const bm = g.best_match;
    console.log(`── Envelope #${g.envelope.id} (${g.envelope.created_at}) ──`);
    console.log(`   Canon: ${g.envelope.canonicalized}`);
    if (bm) {
      const tag = bm.classification === 'safe_duplicate' ? '✅' :
                  bm.classification === 'probably_duplicate' ? '🟡' :
                  bm.classification === 'needs_review' ? '🟠' : '⛔';
      console.log(`   ${tag} Best match: #${bm.id} (gap=${bm.id_gap}, Δ=${bm.delta_s}s, conf=${bm.confidence}, sim=${bm.similarity})`);
      console.log(`      Canon: ${bm.canonicalized}`);
      console.log(`      Reasons: ${bm.reasons.join(', ')}`);
    } else {
      console.log(`   ⛔ No candidate found`);
    }
    if (g.next_assistant) {
      console.log(`   Next asst: #${g.next_assistant.id}: ${g.next_assistant.preview.slice(0, 80)}`);
    }
    console.log('');
  }
}
