import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { collectMetrics, formatMetricsSummary } from '../dist/index.js';

function createMainDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _meta (schema_version INTEGER NOT NULL)');
  db.exec('INSERT INTO _meta (schema_version) VALUES (11)');
  return db;
}

function createLibraryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _library_meta (schema_version INTEGER NOT NULL)');
  db.exec('INSERT INTO _library_meta (schema_version) VALUES (19)');
  db.exec(`
    CREATE TABLE doc_chunks (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      section_path TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 2,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      source_hash TEXT NOT NULL,
      source_path TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'shared-fleet',
      tier TEXT,
      agent_id TEXT,
      parent_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE output_metrics (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      fos_version INTEGER,
      mod_version INTEGER,
      mod_id TEXT,
      task_type TEXT,
      output_tokens INTEGER NOT NULL,
      input_tokens INTEGER,
      cache_read_tokens INTEGER,
      corrections_fired TEXT DEFAULT '[]',
      latency_ms INTEGER,
      created_at TEXT NOT NULL
    )
  `);

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO doc_chunks (
      id, collection, section_path, depth, content, token_estimate, source_hash,
      source_path, scope, tier, agent_id, parent_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'chunk-1', 'ops/tools', 'README.md', 2, 'release dashboard doc chunk', 8,
    'hash-1', '/docs/readme.md', 'shared-fleet', 'council', 'agent-1', null, now, now,
  );
  db.prepare(`
    INSERT INTO output_metrics (
      id, timestamp, agent_id, session_key, model_id, provider,
      fos_version, mod_version, mod_id, task_type,
      output_tokens, input_tokens, cache_read_tokens, corrections_fired,
      latency_ms, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'metric-1', now, 'agent-1', 'agent:agent-1:webchat:status', 'qwen/qwen3-embedding-8b', 'openrouter',
    1, 2, 'qwen/qwen3-embedding-8b', 'turn', 42, 1000, 250, '[]', 500, now,
  );

  return db;
}

function createVectorDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE vec_index_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      vec_table TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    )
  `);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO vec_index_map (source_table, source_id, vec_table, content_hash, indexed_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('doc_chunks', 'chunk-1', 'vec_doc_chunks', 'vec-hash-1', now);
  return db;
}

const mainDb = createMainDb();
const libraryDb = createLibraryDb();
const vectorDb = createVectorDb();

try {
  const metrics = await collectMetrics(
    mainDb,
    libraryDb,
    { embeddingProvider: 'openrouter', embeddingModel: 'qwen/qwen3-embedding-8b' },
    vectorDb,
  );

  assert.equal(metrics.docChunks.totalDocChunks, 1, 'doc chunk count comes from library.db');
  assert.equal(metrics.vectors.totalVectors, 1, 'vector count comes from vectors.db');
  assert.equal(metrics.composition.totalTurns, 1, 'composition metrics come from library.db output_metrics');
  assert.equal(metrics.composition.avgOutputTokens, 42, 'output tokens are read from output_metrics');
  assert.equal(metrics.health.embeddingProvider, 'openrouter', 'embedding provider is surfaced in health');
  assert.equal(metrics.health.embeddingModel, 'qwen/qwen3-embedding-8b', 'embedding model is surfaced in health');

  const summary = formatMetricsSummary(metrics);
  assert(summary.includes('## Embedding'), 'summary includes embedding section');
  assert(summary.includes('provider: openrouter'), 'summary prints resolved embedding provider');
  assert(summary.includes('doc chunks: 1 total'), 'summary prints doc chunk count');
  assert(summary.includes('vectors:  1 indexed'), 'summary prints vector count');
  assert(summary.includes('avg out:  42 tokens'), 'summary prints composition output tokens');
} finally {
  mainDb.close();
  libraryDb.close();
  vectorDb.close();
}
