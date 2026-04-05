#!/usr/bin/env node
/**
 * envelope-queries.mjs — Reusable envelope duplicate detection queries
 * 
 * Usage:
 *   node scripts/envelope-queries.mjs --agent forge --query pairs --window 2000
 *   node scripts/envelope-queries.mjs --all --query summary
 *   node scripts/envelope-queries.mjs --agent forge --query safe-candidates
 *   node scripts/envelope-queries.mjs --agent forge --query unmatched
 *   node scripts/envelope-queries.mjs --all --query fleet-summary
 *   node scripts/envelope-queries.mjs --agent forge --query delete-wave1 [--apply]
 * 
 * Queries:
 *   pairs           — Show all matched bare/envelope pairs with metadata
 *   summary         — Counts: total user rows, envelope rows, matched pairs, hit rate
 *   safe-candidates — Envelope rows safe to delete (high confidence pairs only)
 *   unmatched       — Envelope rows with no safe match (needs review)
 *   fleet-summary   — Per-agent summary across the fleet
 *   delete-wave1    — Dry-run (or --apply) deletion of safe candidates
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

// ── CLI args ──────────────────────────────────────────────────────────────────
function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}
function hasFlag(name) { return process.argv.includes(name); }

const dataDir = argValue('--data-dir', path.join(os.homedir(), '.openclaw', 'hypermem'));
const agentsDir = path.join(dataDir, 'agents');
const singleAgent = argValue('--agent');
const all = hasFlag('--all') || !singleAgent;
const query = argValue('--query', 'summary');
const window_ = parseInt(argValue('--window', '0'), 10);  // 0 = all messages
const apply = hasFlag('--apply');

// ── Thresholds for safe vs probable vs review ─────────────────────────────────
const SAFE_MAX_ID_GAP = 3;
const SAFE_MAX_DELTA_S = 120;    // 2 minutes
const PROBABLE_MAX_ID_GAP = 10;
const PROBABLE_MAX_DELTA_S = 300; // 5 minutes

// ── DB helpers ────────────────────────────────────────────────────────────────
function openDb(agentId) {
  const dbPath = path.join(agentsDir, agentId, 'messages.db');
  if (!fs.existsSync(dbPath)) return null;
  return new DatabaseSync(dbPath);
}

function getAgentIds() {
  if (!all) return [singleAgent];
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '_shared')
    .map(d => d.name)
    .sort();
}

// ── Core pair query ───────────────────────────────────────────────────────────
// Finds bare/envelope pairs using suffix containment.
// The envelope row's text_content ends with the bare row's text_content.
function findPairsSQL(windowClause) {
  return `
    WITH scope AS (
      SELECT id, conversation_id, text_content, created_at, role
      FROM messages
      ${windowClause}
    ),
    envelopes AS (
      SELECT id, conversation_id, text_content, created_at
      FROM scope
      WHERE role = 'user'
        AND text_content LIKE 'Sender (untrusted metadata):%'
    ),
    bare AS (
      SELECT id, conversation_id, text_content, created_at
      FROM scope
      WHERE role = 'user'
        AND text_content NOT LIKE 'Sender (untrusted metadata):%'
    ),
    pairs AS (
      SELECT
        b.id AS bare_id,
        e.id AS env_id,
        e.conversation_id,
        (e.id - b.id) AS id_gap,
        ROUND((julianday(e.created_at) - julianday(b.created_at)) * 86400, 1) AS delta_s,
        length(b.text_content) AS bare_len,
        length(e.text_content) AS env_len,
        b.text_content AS bare_text,
        e.text_content AS env_text,
        b.created_at AS bare_created,
        e.created_at AS env_created,
        'suffix' AS match_type,
        ROW_NUMBER() OVER (PARTITION BY e.id ORDER BY (e.id - b.id) ASC) AS rn
      FROM envelopes e
      JOIN bare b
        ON b.conversation_id = e.conversation_id
        AND b.id < e.id
        AND (e.id - b.id) <= 100
        AND substr(e.text_content, -length(b.text_content)) = b.text_content
        AND length(b.text_content) >= 3
    )
    SELECT * FROM pairs WHERE rn = 1
    ORDER BY env_id ASC
  `;
}

function windowClause(db) {
  if (!window_) return '';
  // Get the max id, then scope to last N rows
  const row = db.prepare('SELECT MAX(id) as max_id FROM messages').get();
  const maxId = row?.max_id ?? 0;
  const minId = Math.max(1, maxId - window_ + 1);
  return `WHERE id >= ${minId}`;
}

// ── Classification ────────────────────────────────────────────────────────────
function classify(pair) {
  const gap = pair.id_gap;
  const delta = Math.abs(pair.delta_s);
  if (gap <= SAFE_MAX_ID_GAP && delta <= SAFE_MAX_DELTA_S) return 'safe';
  if (gap <= PROBABLE_MAX_ID_GAP && delta <= PROBABLE_MAX_DELTA_S) return 'probable';
  return 'review';
}

// ── Query implementations ─────────────────────────────────────────────────────

function runPairs(agentId) {
  const db = openDb(agentId);
  if (!db) return { agentId, error: 'no db' };
  const wc = windowClause(db);
  const rows = db.prepare(findPairsSQL(wc)).all();
  const classified = rows.map(r => ({ ...r, classification: classify(r) }));
  return { agentId, pairs: classified };
}

function runSummary(agentId) {
  const db = openDb(agentId);
  if (!db) return { agentId, error: 'no db' };
  const wc = windowClause(db);
  
  const totalUser = db.prepare(`
    SELECT COUNT(*) as cnt FROM messages ${wc ? wc + ' AND' : 'WHERE'} role = 'user'
  `).get()?.cnt ?? 0;
  
  const totalEnvelope = db.prepare(`
    SELECT COUNT(*) as cnt FROM messages 
    ${wc ? wc + ' AND' : 'WHERE'} role = 'user' 
    AND text_content LIKE 'Sender (untrusted metadata):%'
  `).get()?.cnt ?? 0;
  
  const pairs = db.prepare(findPairsSQL(wc)).all();
  const classified = pairs.map(r => ({ ...r, classification: classify(r) }));
  const safe = classified.filter(p => p.classification === 'safe').length;
  const probable = classified.filter(p => p.classification === 'probable').length;
  const review = classified.filter(p => p.classification === 'review').length;
  
  return {
    agentId,
    totalUser,
    totalEnvelope,
    totalBare: totalUser - totalEnvelope,
    matchedPairs: pairs.length,
    unmatchedEnvelopes: totalEnvelope - pairs.length,
    hitRate: totalEnvelope > 0 ? ((pairs.length / totalEnvelope) * 100).toFixed(1) + '%' : 'n/a',
    safe,
    probable,
    review,
  };
}

function runSafeCandidates(agentId) {
  const db = openDb(agentId);
  if (!db) return { agentId, error: 'no db' };
  const wc = windowClause(db);
  const pairs = db.prepare(findPairsSQL(wc)).all();
  const classified = pairs.map(r => ({ ...r, classification: classify(r) }));
  const safePairs = classified.filter(p => p.classification === 'safe');
  return {
    agentId,
    safeCandidateCount: safePairs.length,
    candidates: safePairs.map(p => ({
      bareId: p.bare_id,
      envId: p.env_id,
      idGap: p.id_gap,
      deltaS: p.delta_s,
      barePreview: (p.bare_text || '').slice(0, 100),
      envCreated: p.env_created,
    })),
  };
}

function runUnmatched(agentId) {
  const db = openDb(agentId);
  if (!db) return { agentId, error: 'no db' };
  const wc = windowClause(db);

  // Get all envelope ids
  const allEnvelopes = db.prepare(`
    SELECT id, text_content, created_at FROM messages
    ${wc ? wc + ' AND' : 'WHERE'} role = 'user'
    AND text_content LIKE 'Sender (untrusted metadata):%'
    ORDER BY id ASC
  `).all();

  // Get matched envelope ids
  const pairs = db.prepare(findPairsSQL(wc)).all();
  const matchedEnvIds = new Set(pairs.map(p => p.env_id));

  const unmatched = allEnvelopes
    .filter(e => !matchedEnvIds.has(e.id))
    .map(e => ({
      envId: e.id,
      createdAt: e.created_at,
      preview: (e.text_content || '').slice(0, 200),
    }));

  return { agentId, unmatchedCount: unmatched.length, unmatched };
}

function runDeleteWave1(agentId) {
  const db = openDb(agentId);
  if (!db) return { agentId, error: 'no db' };
  const wc = windowClause(db);
  const pairs = db.prepare(findPairsSQL(wc)).all();
  const classified = pairs.map(r => ({ ...r, classification: classify(r) }));
  const safePairs = classified.filter(p => p.classification === 'safe');
  const envIdsToDelete = [...new Set(safePairs.map(p => p.env_id))];

  if (!apply) {
    return {
      agentId,
      mode: 'dry-run',
      wouldDelete: envIdsToDelete.length,
      envIds: envIdsToDelete,
      samples: safePairs.slice(0, 10).map(p => ({
        bareId: p.bare_id,
        envId: p.env_id,
        idGap: p.id_gap,
        deltaS: p.delta_s,
        barePreview: (p.bare_text || '').slice(0, 80),
      })),
    };
  }

  // APPLY mode — backup first
  const dbPath = path.join(agentsDir, agentId, 'messages.db');
  const backupPath = dbPath + `.pre-cleanup-${Date.now()}.bak`;
  fs.copyFileSync(dbPath, backupPath);

  db.exec('BEGIN IMMEDIATE');
  try {
    const del = db.prepare('DELETE FROM messages WHERE id = ?');
    for (const id of envIdsToDelete) del.run(id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { agentId, mode: 'apply', error: err.message, deleted: 0 };
  }

  return {
    agentId,
    mode: 'apply',
    deleted: envIdsToDelete.length,
    backupPath,
    envIds: envIdsToDelete,
  };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
const agents = getAgentIds();

if (query === 'fleet-summary') {
  const summaries = agents.map(runSummary).filter(s => !s.error);
  const totals = summaries.reduce((acc, s) => {
    acc.totalUser += s.totalUser;
    acc.totalEnvelope += s.totalEnvelope;
    acc.matchedPairs += s.matchedPairs;
    acc.unmatchedEnvelopes += s.unmatchedEnvelopes;
    acc.safe += s.safe;
    acc.probable += s.probable;
    acc.review += s.review;
    return acc;
  }, { totalUser: 0, totalEnvelope: 0, matchedPairs: 0, unmatchedEnvelopes: 0, safe: 0, probable: 0, review: 0 });

  // Table output
  console.log('Agent            | Users | Envelopes | Matched | Unmatched | Safe | Probable | Review | Hit Rate');
  console.log('─────────────────|───────|───────────|─────────|───────────|──────|──────────|────────|─────────');
  for (const s of summaries) {
    if (s.totalEnvelope === 0 && !hasFlag('--show-clean')) continue;
    console.log(
      `${s.agentId.padEnd(17)}| ${String(s.totalUser).padStart(5)} | ${String(s.totalEnvelope).padStart(9)} | ${String(s.matchedPairs).padStart(7)} | ${String(s.unmatchedEnvelopes).padStart(9)} | ${String(s.safe).padStart(4)} | ${String(s.probable).padStart(8)} | ${String(s.review).padStart(6)} | ${s.hitRate}`
    );
  }
  console.log('─────────────────|───────|───────────|─────────|───────────|──────|──────────|────────|─────────');
  const totalHitRate = totals.totalEnvelope > 0
    ? ((totals.matchedPairs / totals.totalEnvelope) * 100).toFixed(1) + '%'
    : 'n/a';
  console.log(
    `${'TOTAL'.padEnd(17)}| ${String(totals.totalUser).padStart(5)} | ${String(totals.totalEnvelope).padStart(9)} | ${String(totals.matchedPairs).padStart(7)} | ${String(totals.unmatchedEnvelopes).padStart(9)} | ${String(totals.safe).padStart(4)} | ${String(totals.probable).padStart(8)} | ${String(totals.review).padStart(6)} | ${totalHitRate}`
  );
  process.exit(0);
}

// Single-agent or --all dispatch
for (const agentId of agents) {
  let result;
  switch (query) {
    case 'pairs':           result = runPairs(agentId); break;
    case 'summary':         result = runSummary(agentId); break;
    case 'safe-candidates': result = runSafeCandidates(agentId); break;
    case 'unmatched':       result = runUnmatched(agentId); break;
    case 'delete-wave1':    result = runDeleteWave1(agentId); break;
    default:
      console.error(`Unknown query: ${query}`);
      process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}
