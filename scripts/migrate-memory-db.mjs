#!/usr/bin/env node
/**
 * OpenClaw memory.db → HyperMem Migration
 *
 * Imports facts and preferences from OpenClaw's built-in memory store
 * (~/.openclaw/memory.db) into HyperMem's library.db fact store.
 *
 * Dry-run by default. Pass --apply to actually write.
 *
 * Usage:
 *   node scripts/migrate-memory-db.mjs
 *   node scripts/migrate-memory-db.mjs --apply
 *   node scripts/migrate-memory-db.mjs --apply --agent forge
 *   node scripts/migrate-memory-db.mjs --apply --agent forge --memory-db /path/to/memory.db
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'apply':       { type: 'boolean', default: false },
    'agent':       { type: 'string',  default: 'main' },
    'memory-db':   { type: 'string',  default: path.join(os.homedir(), '.openclaw/memory.db') },
    'hypermem-dir':{ type: 'string',  default: path.join(os.homedir(), '.openclaw/hypermem') },
    'limit':       { type: 'string',  default: '0' },
  }
});

const DRY_RUN    = !args['apply'];
const AGENT_ID   = args['agent'];
const SRC_PATH   = args['memory-db'];
const HM_DIR     = args['hypermem-dir'];
const LIMIT      = parseInt(args['limit'], 10);
const LIBRARY_DB = path.join(HM_DIR, 'library.db');

// Map OpenClaw memory type to HyperMem domain
function mapDomain(type) {
  switch ((type || '').toLowerCase()) {
    case 'preference': return 'preference';
    case 'fact':       return 'fact';
    case 'context':    return 'context';
    case 'project':    return 'project';
    default:           return type || 'fact';
  }
}

// Map OpenClaw source to HyperMem source_type
function mapSourceType(source) {
  switch ((source || '').toLowerCase()) {
    case 'user':  return 'conversation';
    case 'agent': return 'extracted';
    default:      return 'migrated';
  }
}

function toIso(unixMs) {
  if (!unixMs) return new Date().toISOString();
  return new Date(Number(unixMs)).toISOString();
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`[migrate-memory-db] OpenClaw memory.db → HyperMem`);
console.log(`[migrate-memory-db] Source  : ${SRC_PATH}`);
console.log(`[migrate-memory-db] Target  : ${LIBRARY_DB}`);
console.log(`[migrate-memory-db] Agent   : ${AGENT_ID}`);
console.log(`[migrate-memory-db] Dry run : ${DRY_RUN}`);
console.log('');

if (!fs.existsSync(SRC_PATH)) {
  console.error(`[migrate-memory-db] ERROR: memory.db not found at ${SRC_PATH}`);
  console.error(`[migrate-memory-db] Is OpenClaw's built-in memory plugin enabled on this install?`);
  process.exit(1);
}

if (!fs.existsSync(LIBRARY_DB)) {
  console.error(`[migrate-memory-db] ERROR: HyperMem library.db not found at ${LIBRARY_DB}`);
  console.error(`[migrate-memory-db] Has HyperMem been installed and started at least once?`);
  process.exit(1);
}

const srcDb = new DatabaseSync(SRC_PATH, { readOnly: true });

// Read source rows
const query = `
  SELECT id, content, type, source, priority, created_at, metadata
  FROM memories
  WHERE content IS NOT NULL AND trim(content) != ''
  ORDER BY created_at ASC
  ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
`;
const rows = srcDb.prepare(query).all();
console.log(`[migrate-memory-db] Found ${rows.length} rows in memory.db`);
console.log('');

const stats = { total: rows.length, imported: 0, skipped: 0, errors: 0 };

if (!DRY_RUN) {
  const hmDb = new DatabaseSync(LIBRARY_DB);
  hmDb.exec('PRAGMA journal_mode = WAL');

  // Build a set of already-migrated original IDs to detect duplicates
  const existing = new Set(
    hmDb.prepare(`SELECT source_ref FROM facts WHERE source_type = 'migrated' AND source_ref LIKE 'openclaw-memory-db:%'`)
      .all()
      .map(r => r.source_ref)
  );

  const insert = hmDb.prepare(`
    INSERT INTO facts
      (agent_id, scope, domain, content, confidence, visibility, source_type, source_ref, created_at, updated_at)
    VALUES
      (?, 'agent', ?, ?, ?, 'private', 'migrated', ?, ?, ?)
  `);

  for (const row of rows) {
    const sourceRef = `openclaw-memory-db:${row.id}`;
    if (existing.has(sourceRef)) {
      stats.skipped++;
      continue;
    }
    try {
      const iso = toIso(row.created_at);
      insert.run(
        AGENT_ID,
        mapDomain(row.type),
        row.content,
        typeof row.priority === 'number' ? row.priority : 1.0,
        sourceRef,
        iso,
        iso
      );
      stats.imported++;
    } catch (err) {
      console.warn(`[migrate-memory-db] Error importing ${row.id}: ${err.message}`);
      stats.errors++;
    }
  }

  hmDb.close();
} else {
  // Dry-run: just report what would happen, check duplicates against live DB
  const hmDb = new DatabaseSync(LIBRARY_DB, { readOnly: true });
  const existing = new Set(
    hmDb.prepare(`SELECT source_ref FROM facts WHERE source_type = 'migrated' AND source_ref LIKE 'openclaw-memory-db:%'`)
      .all()
      .map(r => r.source_ref)
  );
  hmDb.close();

  for (const row of rows) {
    const sourceRef = `openclaw-memory-db:${row.id}`;
    if (existing.has(sourceRef)) {
      stats.skipped++;
      continue;
    }
    console.log(`[dry-run] would import (${mapDomain(row.type)}): ${truncate(row.content, 80)}`);
    stats.imported++;
  }
}

srcDb.close();

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`[migrate-memory-db] === Results ===`);
console.log(`[migrate-memory-db] Total found   : ${stats.total}`);
console.log(`[migrate-memory-db] Imported       : ${stats.imported}`);
console.log(`[migrate-memory-db] Skipped (dup)  : ${stats.skipped}`);
console.log(`[migrate-memory-db] Errors         : ${stats.errors}`);

if (DRY_RUN) {
  console.log('');
  console.log(`[migrate-memory-db] *** DRY RUN — no data was written ***`);
  console.log(`[migrate-memory-db] Run with --apply to execute.`);
} else {
  console.log('');
  console.log(`[migrate-memory-db] Migration complete.`);
  console.log(`[migrate-memory-db] The background indexer will pick up new facts on its next tick.`);
  console.log(`[migrate-memory-db] To force immediate indexing: restart the gateway.`);
}
