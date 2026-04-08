/**
 * embed-existing.mjs — One-time bulk embedding migration
 *
 * Embeds all existing clean facts and high-significance episodes
 * into vectors.db. Supports Ollama (local) and OpenAI-compatible
 * providers (OpenRouter, OpenAI) via hypermem config.
 *
 * Usage:
 *   node scripts/embed-existing.mjs [--dry-run] [--batch-size 32] [--table facts|episodes|all]
 *
 * Safe to re-run: skips items already embedded (content hash check).
 * NOTE: If switching providers/models, clear vectors.db first —
 *       dimensions change and existing vectors are incompatible.
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
const BATCH_SIZE_ARG = parseInt(args.find((_, i) => args[i - 1] === '--batch-size') ?? '0') || 0;
const LIMIT = parseInt(args.find((_, i) => args[i - 1] === '--limit') ?? '0') || 0;

const DATA_DIR = path.join(process.env.HOME || '/home/lumadmin', '.openclaw', 'hypermem');
const LIBRARY_DB_PATH = path.join(DATA_DIR, 'library.db');
const VECTORS_DB_PATH = path.join(DATA_DIR, 'vectors.db');

// ── Load hypermem config ──────────────────────────────────────
const HYPERMEM_CONFIG_PATH = path.join(DATA_DIR, 'config.json');
let hypermemConfig = {};
try {
  hypermemConfig = JSON.parse(fs.readFileSync(HYPERMEM_CONFIG_PATH, 'utf8'));
} catch { /* no config, use defaults */ }

const embeddingCfg = hypermemConfig.embedding ?? {};
const PROVIDER = embeddingCfg.provider ?? 'ollama';
const OLLAMA_URL = embeddingCfg.ollamaUrl ?? 'http://localhost:11434';
const EMBED_MODEL = embeddingCfg.model ?? (PROVIDER === 'openai' ? 'qwen/qwen3-embedding-8b' : 'nomic-embed-text');
const DIM = embeddingCfg.dimensions ?? (PROVIDER === 'openai' ? 4096 : 768);
const BATCH_SIZE = BATCH_SIZE_ARG || (embeddingCfg.batchSize ?? (PROVIDER === 'openai' ? 128 : 32));

// OpenAI-compatible: resolve API key
let OPENAI_API_KEY = embeddingCfg.openaiApiKey ?? null;
const OPENAI_BASE_URL = embeddingCfg.openaiBaseUrl ?? 'https://api.openai.com/v1';
if (PROVIDER === 'openai' && !OPENAI_API_KEY) {
  // Fall back to auth-profiles.json
  try {
    const authPath = path.join(process.env.HOME || '/home/lumadmin', '.openclaw', 'auth-profiles.json');
    const authProfiles = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    // Try openrouter first, then openai
    OPENAI_API_KEY = authProfiles?.openrouter?.apiKey
      ?? authProfiles?.openrouter?.key
      ?? authProfiles?.openai?.apiKey
      ?? authProfiles?.openai?.key
      ?? null;
  } catch { /* no auth file */ }
}
if (PROVIDER === 'openai' && !OPENAI_API_KEY) {
  // Fall back to openclaw.json env vars (gateway stores keys there)
  try {
    const oclawPath = path.join(process.env.HOME || '/home/lumadmin', '.openclaw', 'openclaw.json');
    const oclawCfg = JSON.parse(fs.readFileSync(oclawPath, 'utf8'));
    const envVars = oclawCfg?.env?.vars ?? {};
    OPENAI_API_KEY = envVars.OPENROUTER_API_KEY ?? envVars.OPENAI_API_KEY ?? null;
  } catch { /* no openclaw config */ }
}
if (PROVIDER === 'openai' && !OPENAI_API_KEY) {
  // Fall back to environment variables
  OPENAI_API_KEY = process.env.OPENROUTER_API_KEY
    ?? process.env.OPENAI_API_KEY
    ?? null;
}
if (PROVIDER === 'openai' && !OPENAI_API_KEY) {
  console.error('[embed-existing] ERROR: openai provider configured but no API key found.');
  console.error('  Set embedding.openaiApiKey in hypermem/config.json or configure openrouter in auth-profiles.json');
  process.exit(1);
}

// ── Setup ─────────────────────────────────────────────────────
console.log(`[embed-existing] Starting${DRY_RUN ? ' (DRY RUN)' : ''}`);
console.log(`  Provider:   ${PROVIDER === 'openai' ? `openai-compatible (${OPENAI_BASE_URL})` : 'ollama'}`);
console.log(`  Model:      ${EMBED_MODEL}`);
console.log(`  Dimensions: ${DIM}`);
console.log(`  Library DB: ${LIBRARY_DB_PATH}`);
console.log(`  Vectors DB: ${VECTORS_DB_PATH}`);
console.log(`  Tables:     ${TABLE}`);
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
// Check for dimension mismatch on existing tables
try {
  const existingRow = vecDb.prepare(`SELECT vector_extract(embedding) FROM vec_facts LIMIT 1`).get();
  if (existingRow) {
    const existingLen = JSON.parse(existingRow['vector_extract(embedding)']).length;
    if (existingLen !== DIM) {
      console.error(`[embed-existing] DIMENSION MISMATCH: vectors.db has ${existingLen}d, config expects ${DIM}d.`);
      console.error('  Clear vectors.db before switching providers: rm ~/.openclaw/hypermem/vectors.db');
      process.exit(1);
    }
  }
} catch { /* table doesn't exist yet, safe to create */ }

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
async function embedBatchOllama(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.embeddings; // float[][]
}

async function embedBatchOpenAI(texts) {
  const res = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI embed failed: ${res.status} ${res.statusText} — ${body}`);
  }
  const data = await res.json();
  // OpenAI returns { data: [{ embedding: float[], index: number }] }
  return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

const embedBatch = PROVIDER === 'openai' ? embedBatchOpenAI : embedBatchOllama;

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
