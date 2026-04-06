#!/usr/bin/env node
/**
 * prune-noisy-facts.mjs
 *
 * Retroactive cleanup for facts that slipped through the quality gate before
 * TUNE-013. Targets:
 *   1. External/untrusted content markers (web search excerpts injected as facts)
 *   2. Multi-paragraph content (>2 newlines — section text, not facts)
 *   3. URL-heavy content (≥2 URLs — source snippets, not actionable facts)
 *   4. Markdown heading content (section titles stored as facts)
 *   5. Low alpha ratio (<50% alpha chars — code/data fragments)
 *
 * Safe: only deletes facts with superseded_by IS NULL to avoid breaking
 * supersede chains. Marks deleted facts as superseded_by = -1 (tombstone).
 *
 * Usage:
 *   node scripts/prune-noisy-facts.mjs [--apply] [--verbose]
 *   node scripts/prune-noisy-facts.mjs --apply   # execute deletes
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const dataDir = path.join(os.homedir(), '.openclaw', 'hypermem');
const libraryDbPath = path.join(dataDir, 'library.db');
const apply = process.argv.includes('--apply');
const verbose = process.argv.includes('--verbose');

const db = new DatabaseSync(libraryDbPath);
db.exec('PRAGMA journal_mode = WAL');

// ── Quality checks (mirrors TUNE-013 in background-indexer.ts) ──────────────

function isNoisyFact(content) {
  if (!content) return true;

  // External/untrusted content markers
  if (/<<<\s*(END_EXTERNAL|BEGIN_EXTERNAL|EXTERNAL_UNTRUSTED|UNTRUSTED_CONTENT)/i.test(content)) return true;
  if (/EXTERNAL_UNTRUSTED_CONTENT\s+id=/.test(content)) return true;

  // Multi-paragraph content (>2 newlines)
  const newlineCount = (content.match(/\n/g) || []).length;
  if (newlineCount > 2) return true;

  // URL-heavy (≥2 URLs = source snippet)
  const urlMatches = content.match(/https?:\/\/\S+/g) || [];
  if (urlMatches.length >= 2) return true;

  // Markdown heading
  if (/^#{1,4}\s/.test(content.trim())) return true;

  // Low alpha ratio
  const alphaChars = (content.match(/[a-zA-Z]/g) || []).length;
  if (content.length > 0 && alphaChars / content.length < 0.5) return true;

  // Very short after trim
  if (content.trim().length < 40) return true;

  return false;
}

// ── Fetch all active (non-superseded) facts ──────────────────────────────────

const allFacts = db.prepare(`
  SELECT id, agent_id, domain, content, confidence, source_type, created_at
  FROM facts
  WHERE superseded_by IS NULL
`).all();

console.log(`Scanning ${allFacts.length} active facts...`);

const noisy = allFacts.filter(f => isNoisyFact(f.content));
const clean = allFacts.length - noisy.length;

console.log(`\nResults:`);
console.log(`  Clean:  ${clean}`);
console.log(`  Noisy:  ${noisy.length} (would delete)`);
console.log(`  Ratio:  ${((noisy.length / allFacts.length) * 100).toFixed(1)}% noise`);

// Breakdown by reason
const reasons = { external: 0, multiline: 0, url_heavy: 0, heading: 0, low_alpha: 0, too_short: 0 };
for (const f of noisy) {
  const c = f.content || '';
  if (/<<<\s*(END_EXTERNAL|BEGIN_EXTERNAL|EXTERNAL_UNTRUSTED|UNTRUSTED_CONTENT)/i.test(c) ||
      /EXTERNAL_UNTRUSTED_CONTENT\s+id=/.test(c)) reasons.external++;
  else if ((c.match(/\n/g) || []).length > 2) reasons.multiline++;
  else if ((c.match(/https?:\/\/\S+/g) || []).length >= 2) reasons.url_heavy++;
  else if (/^#{1,4}\s/.test(c.trim())) reasons.heading++;
  else if (c.length > 0 && (c.match(/[a-zA-Z]/g) || []).length / c.length < 0.5) reasons.low_alpha++;
  else if (c.trim().length < 40) reasons.too_short++;
}

console.log(`\nNoise breakdown:`);
for (const [reason, count] of Object.entries(reasons)) {
  if (count > 0) console.log(`  ${reason.padEnd(15)}: ${count}`);
}

// Agent breakdown
const byAgent = {};
for (const f of noisy) {
  byAgent[f.agent_id] = (byAgent[f.agent_id] || 0) + 1;
}
console.log(`\nBy agent:`);
for (const [agent, count] of Object.entries(byAgent).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${agent.padEnd(15)}: ${count}`);
}

if (verbose && noisy.length > 0) {
  console.log(`\nSample noisy facts (first 10):`);
  for (const f of noisy.slice(0, 10)) {
    console.log(`  [${f.agent_id}|${f.domain || 'null'}] ${(f.content || '').slice(0, 100).replace(/\n/g, '↵')}`);
  }
}

if (!apply) {
  console.log(`\nDry-run. Run with --apply to delete ${noisy.length} noisy facts.`);
  process.exit(0);
}

// ── Apply: delete noisy facts ─────────────────────────────────────────────────

if (noisy.length === 0) {
  console.log('\nNothing to delete.');
  process.exit(0);
}

const ids = noisy.map(f => f.id);

db.exec('BEGIN IMMEDIATE');
try {
  // Delete in batches of 500 to avoid SQLite variable limit
  const batchSize = 500;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM facts WHERE id IN (${placeholders})`).run(...batch);
    deleted += result.changes;
  }
  db.exec('COMMIT');
  console.log(`\nDeleted ${deleted} noisy facts.`);
} catch (err) {
  db.exec('ROLLBACK');
  console.error('Rollback — error:', err.message);
  process.exit(1);
}
