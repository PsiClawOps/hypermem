#!/usr/bin/env node
/**
 * cleanup-duplicate-user-envelopes.mjs
 *
 * Finds and removes duplicate user message rows that arise from the dual-recording
 * bug fixed in v0.4.1. Each user message was recorded twice:
 *   1. A bare row (just the message text, possibly with a bracket timestamp prefix)
 *   2. An envelope row ("Sender (untrusted metadata): ..." prepended)
 *
 * The envelope row is the duplicate — it's the same content with metadata noise.
 * This script identifies envelope rows whose canonicalized content matches a nearby
 * bare row in the same conversation, and deletes the envelope row.
 *
 * Confidence tiers (from diagnose-envelope-pairs.mjs classifier):
 *   safe_duplicate     (≥70)  → deleted by default
 *   probably_duplicate (≥45)  → deleted with --include-probable, else logged only
 *   needs_review       (≥25)  → never deleted, always logged
 *   do_not_touch       (<25)  → never touched
 *
 * Usage:
 *   node scripts/cleanup-duplicate-user-envelopes.mjs [--agent <id>|--all] [--apply] [--include-probable]
 *
 * Options:
 *   --agent <id>         Target a single agent (default: all)
 *   --all                All agents (default if --agent not given)
 *   --apply              Execute deletes (default: dry-run)
 *   --include-probable   Also delete probably_duplicate tier (conf ≥ 45)
 *   --data-dir <dir>     Override data directory (default: ~/.openclaw/hypermem)
 *   --verbose            Print full candidate list per envelope
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// ── Args ──────────────────────────────────────────────────────────────────────

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return (idx !== -1 && idx + 1 < process.argv.length) ? process.argv[idx + 1] : fallback;
}
function hasFlag(name) { return process.argv.includes(name); }

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`Usage: node scripts/cleanup-duplicate-user-envelopes.mjs [--agent <id>|--all] [--apply] [--include-probable]

  --agent <id>         Target single agent
  --all                All agents (default)
  --apply              Execute deletes (default is dry-run)
  --include-probable   Also delete probably_duplicate tier (confidence ≥ 45)
  --data-dir <dir>     Override data dir (default: ~/.openclaw/hypermem)
  --verbose            Print all candidates per envelope
`);
  process.exit(0);
}

const dataDir = argValue('--data-dir', path.join(os.homedir(), '.openclaw', 'hypermem'));
const agentsDir = path.join(dataDir, 'agents');
const apply = hasFlag('--apply');
const includeProbable = hasFlag('--include-probable');
const singleAgent = argValue('--agent');
const verbose = hasFlag('--verbose');

// ── Text normalization (mirrors diagnose-envelope-pairs.mjs) ─────────────────

function stripEnvelopeHeader(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^Sender \(untrusted metadata\):/i.test(line)) {
      i++;
      while (i < lines.length) {
        if (lines[i].trim() === '' || lines[i].trim() === '```') { i++; break; }
        i++;
      }
      while (i < lines.length && lines[i].trim() === '') i++;
      continue;
    }
    if (/^```json\s*$/i.test(line)) {
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
        while (i < lines.length && lines[i].trim() === '') i++;
        continue;
      }
      out.push(...blockLines);
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n').trim();
}

function canonicalize(text) {
  if (!text) return '';
  let t = stripEnvelopeHeader(text);
  // Strip bracket timestamp prefix on first line: [Sun 2026-04-05 13:17 MST]
  t = t.replace(/^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/m, '');
  // Strip ISO timestamp lines
  t = t.split('\n')
    .filter(l => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(l.trim()))
    .join('\n').trim();
  // Collapse whitespace, lowercase
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isoMs(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  // Approximate for long strings
  if (a.length > 500 || b.length > 500) return Math.abs(a.length - b.length);
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

function classifyMatch(envelopeCanon, candidateCanon, idGap, deltaMs) {
  if (!envelopeCanon || !candidateCanon) {
    return { confidence: 0, classification: 'do_not_touch', reasons: ['empty'] };
  }
  const exactMatch = envelopeCanon === candidateCanon;
  const editDist = exactMatch ? 0 : levenshtein(envelopeCanon.slice(0, 500), candidateCanon.slice(0, 500));
  const maxLen = Math.max(envelopeCanon.length, candidateCanon.length, 1);
  const similarity = 1 - (editDist / maxLen);
  const lenRatio = Math.min(envelopeCanon.length, candidateCanon.length) / maxLen;

  let score = 0;
  const reasons = [];

  if (exactMatch) {
    score += 50; reasons.push('exact_canon_match');
  } else if (similarity >= 0.95) {
    score += 40; reasons.push(`high_similarity(${similarity.toFixed(3)})`);
  } else if (similarity >= 0.85) {
    score += 25; reasons.push(`good_similarity(${similarity.toFixed(3)})`);
  } else if (envelopeCanon.startsWith(candidateCanon) || candidateCanon.startsWith(envelopeCanon)) {
    score += 20; reasons.push('starts_with_match');
  } else if (similarity >= 0.5) {
    score += 10; reasons.push(`moderate_similarity(${similarity.toFixed(3)})`);
  } else {
    reasons.push(`low_similarity(${similarity.toFixed(3)})`);
  }

  if (deltaMs != null) {
    if (deltaMs <= 30_000)       { score += 25; reasons.push(`time_close(${(deltaMs/1000).toFixed(1)}s)`); }
    else if (deltaMs <= 120_000) { score += 15; reasons.push(`time_near(${(deltaMs/1000).toFixed(1)}s)`); }
    else if (deltaMs <= 600_000) { score += 5;  reasons.push(`time_far(${(deltaMs/1000).toFixed(1)}s)`); }
    else                         { reasons.push(`time_too_far(${(deltaMs/1000).toFixed(1)}s)`); }
  }

  if (idGap <= 3)       { score += 20; reasons.push(`id_close(${idGap})`); }
  else if (idGap <= 6)  { score += 10; reasons.push(`id_near(${idGap})`); }
  else if (idGap <= 15) { score += 3;  reasons.push(`id_far(${idGap})`); }
  else                  { reasons.push(`id_too_far(${idGap})`); }

  if (lenRatio < 0.5) { score -= 15; reasons.push(`length_mismatch(${lenRatio.toFixed(2)})`); }

  const confidence = Math.max(0, Math.min(100, score));
  let classification;
  if (confidence >= 70)      classification = 'safe_duplicate';
  else if (confidence >= 45) classification = 'probably_duplicate';
  else if (confidence >= 25) classification = 'needs_review';
  else                       classification = 'do_not_touch';

  return { confidence, classification, reasons, similarity: similarity.toFixed(3) };
}

// ── Per-agent processing ──────────────────────────────────────────────────────

function processAgent(agentId) {
  const dbPath = path.join(agentsDir, agentId, 'messages.db');
  if (!fs.existsSync(dbPath)) return null;

  const db = new DatabaseSync(dbPath);

  const envelopes = db.prepare(`
    SELECT id, conversation_id, text_content, created_at
    FROM messages
    WHERE role = 'user'
      AND text_content LIKE 'Sender (untrusted metadata):%'
    ORDER BY id ASC
  `).all();

  const getPriors = db.prepare(`
    SELECT id, text_content, created_at
    FROM messages
    WHERE conversation_id = ?
      AND role = 'user'
      AND id < ?
    ORDER BY id DESC
    LIMIT 10
  `);

  const toDelete = [];   // envelope row ids classified safe_duplicate
  const probable = [];   // envelope row ids classified probably_duplicate
  const skipped = [];    // needs_review / do_not_touch

  for (const env of envelopes) {
    const envCanon = canonicalize(env.text_content);
    const priors = getPriors.all(env.conversation_id, env.id);

    let best = null;
    for (const p of priors) {
      const pCanon = canonicalize(p.text_content);
      const idGap = env.id - p.id;
      const envMs = isoMs(env.created_at);
      const pMs = isoMs(p.created_at);
      const deltaMs = (envMs != null && pMs != null) ? envMs - pMs : null;

      const match = classifyMatch(envCanon, pCanon, idGap, deltaMs);
      if (!best || match.confidence > best.confidence) {
        best = { priorId: p.id, priorText: p.text_content, ...match, idGap, deltaMs };
      }
    }

    if (!best || best.classification === 'do_not_touch' || best.classification === 'needs_review') {
      skipped.push({
        envelopeId: env.id,
        confidence: best?.confidence ?? 0,
        classification: best?.classification ?? 'no_candidate',
        reasons: best?.reasons ?? [],
        preview: (env.text_content || '').slice(0, 120),
      });
    } else if (best.classification === 'safe_duplicate') {
      toDelete.push({ envelopeId: env.id, ...best, preview: envCanon.slice(0, 80) });
    } else if (best.classification === 'probably_duplicate') {
      probable.push({ envelopeId: env.id, ...best, preview: envCanon.slice(0, 80) });
    }
  }

  const deleteIds = [
    ...toDelete.map(r => r.envelopeId),
    ...(includeProbable ? probable.map(r => r.envelopeId) : []),
  ];

  if (apply && deleteIds.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const del = db.prepare('DELETE FROM messages WHERE id = ?');
      for (const id of deleteIds) del.run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    agentId,
    dbPath,
    total: envelopes.length,
    safe: toDelete.length,
    probable: probable.length,
    skipped: skipped.length,
    deleted: apply ? deleteIds.length : 0,
    wouldDelete: deleteIds.length,
    toDelete: verbose ? toDelete : toDelete.slice(0, 3),
    probableRows: verbose ? probable : probable.slice(0, 3),
    skippedRows: verbose ? skipped : skipped.slice(0, 3),
  };
}

// ── Run ───────────────────────────────────────────────────────────────────────

const agents = singleAgent
  ? [singleAgent]
  : fs.readdirSync(agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();

const results = agents.map(processAgent).filter(Boolean);

// Summary table
const totals = results.reduce((acc, r) => {
  acc.total += r.total;
  acc.safe += r.safe;
  acc.probable += r.probable;
  acc.skipped += r.skipped;
  acc.wouldDelete += r.wouldDelete;
  acc.deleted += r.deleted;
  return acc;
}, { total: 0, safe: 0, probable: 0, skipped: 0, wouldDelete: 0, deleted: 0 });

console.log(`\n═══ DUPLICATE ENVELOPE CLEANUP — ${apply ? 'APPLY' : 'DRY-RUN'}${includeProbable ? ' (+probable)' : ''} ═══\n`);
console.log('Agent          | Total | Safe | Probable | Skipped | WouldDel | Deleted');
console.log('───────────────|───────|──────|──────────|─────────|──────────|────────');
for (const r of results) {
  if (r.total === 0) continue;
  console.log(
    `${r.agentId.padEnd(15)}| ${String(r.total).padStart(5)} | ${String(r.safe).padStart(4)} | ` +
    `${String(r.probable).padStart(8)} | ${String(r.skipped).padStart(7)} | ` +
    `${String(r.wouldDelete).padStart(8)} | ${String(r.deleted).padStart(6)}`
  );
}
console.log('───────────────|───────|──────|──────────|─────────|──────────|────────');
console.log(
  `${'TOTAL'.padEnd(15)}| ${String(totals.total).padStart(5)} | ${String(totals.safe).padStart(4)} | ` +
  `${String(totals.probable).padStart(8)} | ${String(totals.skipped).padStart(7)} | ` +
  `${String(totals.wouldDelete).padStart(8)} | ${String(totals.deleted).padStart(6)}`
);

// Skipped rows (need_review / do_not_touch) — always print, these need human eyes
const allSkipped = results.flatMap(r => r.skippedRows.map(s => ({ agentId: r.agentId, ...s })));
if (allSkipped.length > 0) {
  console.log('\n── Skipped (needs_review / do_not_touch) ──');
  for (const s of allSkipped) {
    console.log(`  ${s.agentId} #${s.envelopeId} [${s.classification}, conf=${s.confidence}]: ${s.preview}`);
    if (s.reasons.length) console.log(`    reasons: ${s.reasons.join(', ')}`);
  }
}

// Probable rows (logged even if not deleted)
if (!includeProbable) {
  const allProbable = results.flatMap(r => r.probableRows.map(p => ({ agentId: r.agentId, ...p })));
  if (allProbable.length > 0) {
    console.log('\n── Probable duplicates (logged, not deleted — use --include-probable to delete) ──');
    for (const p of allProbable.slice(0, 20)) {
      console.log(`  ${p.agentId} #${p.envelopeId} [conf=${p.confidence}, sim=${p.similarity}]: ${p.preview}`);
    }
    if (allProbable.length > 20) console.log(`  ... and ${allProbable.length - 20} more`);
  }
}

if (!apply) {
  console.log(`\nDry-run complete. Run with --apply to execute deletes.`);
  if (includeProbable) {
    console.log(`Would delete: ${totals.wouldDelete} rows (safe + probable tiers).`);
  } else {
    console.log(`Would delete: ${totals.wouldDelete} rows (safe tier only). Add --include-probable for ${totals.probable} more.`);
  }
} else {
  console.log(`\nDeleted ${totals.deleted} duplicate envelope rows.`);
}
