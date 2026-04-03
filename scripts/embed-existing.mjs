/**
 * embed-existing.mjs — One-time bulk embedding migration
 *
 * Embeds all existing clean facts and high-significance episodes
 * into vectors.db via nomic-embed-text (Ollama).
 *
 * Usage:
 *   node scripts/embed-existing.mjs [--dry-run] [--batch-size 32] [--table facts|episodes|all]
 *
 * Safe to re-run: VectorStore.indexItem() skips items already embedded (content hash check).
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TABLE = args.find((_, i) => args[i - 1] === '--table') ?? 'all';
const BATCH_SIZE = parseInt(args.find((_, i) => args[i - 1] === '--batch-size') ?? '32') || 32;
const LIMIT = parseInt(args.find((_, i) => args[i - 1] === '--limit') ?? '0') || 0;

const DATA_DIR = path.join(process.env.HOME || '/home/lumadmin', '.openclaw', 'hypermem');
const LIBRARY_DB_PATH = path.join(DATA_DIR, 'library.db');
const VECTORS_DB_PATH = path.join(DATA_DIR, 'vectors.db');
const OLLAMA_URL = 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';
const DIM = 768;

// ── Setup ─────────────────────────────────────────────────────
console.log(`[embed-existing] Starting${DRY_RUN ? ' (DRY RUN)' : ''}`);
console.log(`  Library DB: ${LIBRARY_DB_PATH}`);
console.log(`  Vectors DB: ${VECTORS_DB_PATH}`);
console.log(`  Tables: ${TABLE}`);
console.log(`  Batch size: ${BATCH_SIZE}`);

const libDb = new DatabaseSync(LIBRARY_DB_PATH);

// Create vectors.db dir and open with extension support
fs.mkdirSync(path.dirname(VECTORS_DB_PATH), { recursive: true });
const vecDb = new DatabaseSync(VECTORS_DB_PATH, { allowExtension: true });
vecDb.enableLoadExtension(true);

// Load sqlite-vec
let sqliteVec;
try {
  sqliteVec = require('sqlite-vec');
  sqliteVec.load(vecDb);
  console.log('[embed-existing] sqlite-vec loaded');
} catch (err) {
  console.error('[embed-existing] Failed to load sqlite-vec:', err.message);
  process.exit(1);
}

// Ensure vector tables
vecDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(embedding float[${DIM}])`);
vecDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_knowledge USING vec0(embedding float[${DIM}])`);
vecDb.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_episodes USING vec0(embedding float[${DIM}])`);
vecDb.exec(`
  CREATE TABLE IF NOT EXISTS vec_index_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_table TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    vec_table TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    UNIQUE(source_table, source_id)
  )
`);
vecDb.exec('CREATE INDEX IF NOT EXISTS idx_vec_map_source ON vec_index_map(source_table, source_id)');

// ── Embedding ─────────────────────────────────────────────────
async function embedBatch(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.embeddings; // float[][] 
}

function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16);
}

async function indexItems(items, tableName, vecTable) {
  const alreadyDone = new Set(
    vecDb.prepare('SELECT source_id FROM vec_index_map WHERE source_table = ?')
      .all(tableName)
      .map(r => r.source_id)
  );

  let pending = items.filter(r => !alreadyDone.has(r.id));
  if (LIMIT > 0) pending = pending.slice(0, LIMIT);
  console.log(`  ${tableName}: ${items.length} total, ${alreadyDone.size} already embedded, ${pending.length} to embed${LIMIT ? ` (limited to ${LIMIT})` : ''}`);

  if (DRY_RUN || pending.length === 0) return;

  let embedded = 0;
  let errors = 0;

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const texts = batch.map(r => r.content);

    try {
      const embeddings = await embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const item = batch[j];
        const vec = embeddings[j];
        if (!vec || vec.length !== DIM) continue;

        const hash = simpleHash(item.content);
        const vecBuf = Buffer.from(new Float32Array(vec).buffer);

        try {
          // Insert map row first to get its AUTOINCREMENT id,
          // then insert vec with that same rowid (matches VectorStore.indexItem() contract)
          const mapResult = vecDb.prepare(`
            INSERT OR IGNORE INTO vec_index_map (source_table, source_id, vec_table, content_hash, indexed_at)
            VALUES (?, ?, ?, ?, datetime('now'))
          `).run(tableName, item.id, vecTable, hash);

          const mapRowId = Number(mapResult.lastInsertRowid);
          if (mapRowId === 0) continue; // Already exists (IGNORE)

          // Insert vector with matching rowid
          vecDb.prepare(`INSERT INTO ${vecTable}(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`).
            run(mapRowId, vecBuf);

          embedded++;
        } catch (e) {
          if (embedded === 0 && j === 0) console.error(`\n  Insert error (${tableName}/${item.id}):`, e.message);
        }
      }

      process.stdout.write(`\r  ${tableName}: embedded ${embedded}/${pending.length}...`);
    } catch (err) {
      errors++;
      console.error(`\n  Batch ${i}-${i + BATCH_SIZE} failed:`, err.message);
    }
  }

  console.log(`\n  ${tableName}: done — ${embedded} embedded, ${errors} batch errors`);
}

// ── Facts ─────────────────────────────────────────────────────
if (TABLE === 'all' || TABLE === 'facts') {
  const facts = libDb.prepare(`
    SELECT id, content, domain FROM facts
    WHERE superseded_by IS NULL
    AND decay_score < 1.0
    AND confidence >= 0.5
    ORDER BY confidence DESC, id ASC
  `).all();
  await indexItems(facts, 'facts', 'vec_facts');
}

// ── Episodes ──────────────────────────────────────────────────
if (TABLE === 'all' || TABLE === 'episodes') {
  const episodes = libDb.prepare(`
    SELECT id, summary as content, event_type as domain FROM episodes
    WHERE decay_score < 0.8
    AND significance >= 0.7
    ORDER BY significance DESC, id ASC
  `).all();
  await indexItems(episodes, 'episodes', 'vec_episodes');
}

// ── Summary ───────────────────────────────────────────────────
const vecCount = vecDb.prepare('SELECT COUNT(*) as cnt FROM vec_index_map').get().cnt;
console.log(`\n[embed-existing] Complete. Total indexed: ${vecCount} items in vec_index_map`);

libDb.close();
vecDb.close();
