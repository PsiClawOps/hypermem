/**
 * hypermem Vector Store — Semantic Search via sqlite-vec
 *
 * Provides embedding-backed KNN search over facts, knowledge, episodes,
 * and session registry entries. Uses Ollama (local) for embeddings,
 * sqlite-vec for vector indexing, and coexists with existing FTS5.
 *
 * Architecture:
 *   - One vec0 virtual table per indexed content type
 *   - Embeddings generated via local Ollama (nomic-embed-text, 768d)
 *   - Vectors stored alongside content in the same agent DB
 *   - LRU embedding cache (module-level, per-process) to avoid redundant Ollama calls
 *   - Precomputed embedding passthrough: callers can supply an embedding to skip Ollama
 *   - Batch embedding support for bulk indexing
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export interface EmbeddingConfig {
  /**
   * Embedding provider. Default: 'ollama'.
   * - 'ollama': local Ollama instance (nomic-embed-text or any pull'd model)
   * - 'openai': OpenAI Embeddings API (text-embedding-3-small / 3-large)
   */
  provider?: 'ollama' | 'openai';
  /** Ollama base URL. Default: http://localhost:11434 */
  ollamaUrl: string;
  /** OpenAI API key. Required when provider is 'openai'. */
  openaiApiKey?: string;
  /** OpenAI base URL. Default: https://api.openai.com/v1 */
  openaiBaseUrl?: string;
  /** Embedding model name. Default: nomic-embed-text (ollama) or text-embedding-3-small (openai) */
  model: string;
  /** Embedding dimensions. Default: 768 (ollama/nomic) or 1536 (openai/3-small) */
  dimensions: number;
  /** Request timeout ms. Default: 10000 */
  timeout: number;
  /** Max texts per batch request. Default: 32 (ollama) or 128 (openai) */
  batchSize: number;
  /** LRU cache max entries. Default: 128 */
  cacheSize?: number;
}

export interface VectorSearchResult {
  rowid: number;
  distance: number;
  sourceTable: string;
  sourceId: number;
  content: string;
  domain?: string;
  agentId?: string;
  metadata?: string;
}

export interface VectorIndexStats {
  totalVectors: number;
  tableBreakdown: Record<string, number>;
  lastIndexedAt: string | null;
}

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  provider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  openaiBaseUrl: 'https://api.openai.com/v1',
  model: 'nomic-embed-text',
  dimensions: 768,
  timeout: 10000,
  batchSize: 32,
  cacheSize: 128,
};

/** Provider-specific defaults applied when provider is 'openai' and fields are not set. */
const OPENAI_DEFAULTS = {
  model: 'text-embedding-3-small',
  dimensions: 1536,
  batchSize: 128,
} as const;

// ─── LRU Embedding Cache ─────────────────────────────────────────
// Module-level, per-process. Survives across compose calls within the
// same gateway process. Key: SHA-256 hash of text (first 16 chars).

interface CacheEntry {
  embedding: Float32Array;
  timestamp: number;
}

const _embeddingCache = new Map<string, CacheEntry>();

/**
 * Insert an entry into the LRU cache, evicting the oldest if over capacity.
 */
function cachePut(key: string, embedding: Float32Array, maxSize: number): void {
  if (_embeddingCache.has(key)) {
    // Update existing entry (refresh timestamp)
    _embeddingCache.delete(key);
  } else if (_embeddingCache.size >= maxSize) {
    // Evict oldest entry by timestamp
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of _embeddingCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) {
      _embeddingCache.delete(oldestKey);
    }
  }
  _embeddingCache.set(key, { embedding, timestamp: Date.now() });
}

/**
 * Clear the embedding cache. Primarily for testing.
 */
export function clearEmbeddingCache(): void {
  _embeddingCache.clear();
}

/**
 * Generate embeddings via OpenAI Embeddings API.
 * Batches up to batchSize inputs per request.
 */
async function generateOpenAIEmbeddings(
  texts: string[],
  config: EmbeddingConfig
): Promise<Float32Array[]> {
  if (!config.openaiApiKey) {
    throw new Error(
      '[hypermem] OpenAI embedding provider requires openaiApiKey in embedding config. ' +
      'Set it in hypermem.json or fall back to provider: "ollama".'
    );
  }

  const baseUrl = config.openaiBaseUrl ?? 'https://api.openai.com/v1';
  const model = config.model;
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += config.batchSize) {
    const batch = texts.slice(i, i + config.batchSize);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout);

    try {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify({ model, input: batch }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`OpenAI embedding failed: ${response.status} ${response.statusText} — ${body}`);
      }

      const data = await response.json() as { data: Array<{ embedding: number[]; index: number }> };

      // OpenAI returns results in order by default but may not guarantee it — sort by index.
      const sorted = data.data.sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        if (item.embedding.length !== config.dimensions) {
          throw new Error(
            `OpenAI embedding dimension mismatch: expected ${config.dimensions}, got ${item.embedding.length}. ` +
            'If you changed models, re-index via hypermem reindex.'
          );
        }
        results.push(new Float32Array(item.embedding));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}

/**
 * Generate embeddings via Ollama API.
 * Supports single and batch embedding.
 * Results are cached per text hash — cache hits skip the Ollama call entirely.
 */
export async function generateEmbeddings(
  texts: string[],
  config: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG
): Promise<Float32Array[]> {
  // Apply provider-specific defaults when provider is 'openai' and fields are at Ollama defaults
  if (config.provider === 'openai') {
    // Merge: OpenAI defaults fill in any unset fields, user-supplied values always win
    config = {
      ...DEFAULT_EMBEDDING_CONFIG,
      ...config,
      model: config.model !== DEFAULT_EMBEDDING_CONFIG.model ? config.model : OPENAI_DEFAULTS.model,
      dimensions: config.dimensions !== DEFAULT_EMBEDDING_CONFIG.dimensions ? config.dimensions : OPENAI_DEFAULTS.dimensions,
      batchSize: config.batchSize !== DEFAULT_EMBEDDING_CONFIG.batchSize ? config.batchSize : OPENAI_DEFAULTS.batchSize,
    };
    // OpenAI path — no LRU cache (responses are billed; caching at this layer
    // adds complexity without proportional benefit given async background use).
    return generateOpenAIEmbeddings(texts, config);
  }
  if (texts.length === 0) return [];

  const maxSize = Math.min(
    config.cacheSize ?? DEFAULT_EMBEDDING_CONFIG.cacheSize ?? 128,
    10_000  // Hard cap: prevent unbounded memory growth from operator misconfiguration
  );
  const results: (Float32Array | null)[] = new Array(texts.length).fill(null);

  // Check cache first — build list of texts that need Ollama calls
  const uncachedIndices: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const key = simpleHash(texts[i]);
    const cached = _embeddingCache.get(key);
    if (cached) {
      results[i] = cached.embedding;
    } else {
      uncachedIndices.push(i);
    }
  }

  if (uncachedIndices.length === 0) {
    return results as Float32Array[];
  }

  // Fetch uncached texts from Ollama in batches
  const uncachedTexts = uncachedIndices.map(i => texts[i]);
  const ollamaResults: Float32Array[] = [];

  // Ollama /api/embed supports batch via `input` array
  for (let i = 0; i < uncachedTexts.length; i += config.batchSize) {
    const batch = uncachedTexts.slice(i, i + config.batchSize);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout);

    try {
      const response = await fetch(`${config.ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          input: batch,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as { embeddings: number[][] };

      for (const embedding of data.embeddings) {
        if (embedding.length !== config.dimensions) {
          throw new Error(
            `Embedding dimension mismatch: expected ${config.dimensions}, got ${embedding.length}`
          );
        }
        ollamaResults.push(new Float32Array(embedding));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // Populate cache and fill results array
  for (let j = 0; j < uncachedIndices.length; j++) {
    const origIdx = uncachedIndices[j];
    const embedding = ollamaResults[j];
    results[origIdx] = embedding;
    cachePut(simpleHash(texts[origIdx]), embedding, maxSize);
  }

  return results as Float32Array[];
}

/**
 * Serialize a Float32Array to Uint8Array for sqlite-vec binding.
 */
function vecToBytes(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * VectorStore — manages vector indexes in an agent's vector database.
 *
 * The vector DB (vectors.db) stores vec0 virtual tables and the index map.
 * Source content (facts, knowledge, episodes) lives in the library DB.
 * The VectorStore needs both: vectorDb for indexes, libraryDb for content.
 */
export class VectorStore {
  private readonly db: DatabaseSync;       // vectors.db
  private readonly libraryDb: DatabaseSync | null;  // library.db for source content
  private readonly config: EmbeddingConfig;

  constructor(db: DatabaseSync, config?: Partial<EmbeddingConfig>, libraryDb?: DatabaseSync) {
    this.db = db;
    this.libraryDb = libraryDb || null;
    this.config = { ...DEFAULT_EMBEDDING_CONFIG, ...config };
  }

  /**
   * Create vector index tables if they don't exist.
   * Safe to call multiple times (idempotent).
   */
  ensureTables(): void {
    const dim = this.config.dimensions;

    // Vector index for facts
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts
      USING vec0(embedding float[${dim}])
    `);

    // Vector index for knowledge
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_knowledge
      USING vec0(embedding float[${dim}])
    `);

    // Vector index for episodes
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_episodes
      USING vec0(embedding float[${dim}])
    `);

    // Vector index for session registry (library DB)
    // This is created separately via ensureSessionRegistryTable()

    // Mapping table: links vec rowids to source table rows
    // Using a single mapping table for all vec tables
    this.db.exec(`
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
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_vec_map_source ON vec_index_map(source_table, source_id)'
    );
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_vec_map_vec ON vec_index_map(vec_table, id)'
    );
  }

  /**
   * Index a single content item. Generates embedding and stores in vec table.
   * Skips if content hasn't changed (based on hash).
   */
  /** Allowlisted source tables for vector indexing. Prevents SQL injection via table name interpolation. */
  private static readonly ALLOWED_SOURCE_TABLES = new Set(['facts', 'knowledge', 'episodes', 'sessions']);

  private validateSourceTable(sourceTable: string): void {
    if (!VectorStore.ALLOWED_SOURCE_TABLES.has(sourceTable)) {
      throw new Error(`Invalid sourceTable: "${sourceTable}". Must be one of: ${[...VectorStore.ALLOWED_SOURCE_TABLES].join(', ')}`);
    }
  }

  async indexItem(
    sourceTable: string,
    sourceId: number,
    content: string,
    domain?: string
  ): Promise<boolean> {
    this.validateSourceTable(sourceTable);
    const vecTable = `vec_${sourceTable}`;
    const contentHash = simpleHash(content);

    // Check if already indexed with same content
    const existing = this.db
      .prepare('SELECT id, content_hash FROM vec_index_map WHERE source_table = ? AND source_id = ?')
      .get(sourceTable, sourceId) as { id: number; content_hash: string } | undefined;

    if (existing && existing.content_hash === contentHash) {
      return false; // Already indexed, content unchanged
    }

    // Generate embedding
    const [embedding] = await generateEmbeddings([content], this.config);

    const bytes = vecToBytes(embedding);

    if (existing) {
      // Update: delete old vector, insert new
      this.db.prepare(`DELETE FROM ${vecTable} WHERE rowid = CAST(? AS INTEGER)`).run(existing.id);
      this.db.prepare(`INSERT INTO ${vecTable}(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(existing.id, bytes);
      this.db
        .prepare('UPDATE vec_index_map SET content_hash = ?, indexed_at = ? WHERE id = ?')
        .run(contentHash, new Date().toISOString(), existing.id);
    } else {
      // Insert new mapping row first to get the rowid
      const mapResult = this.db
        .prepare(
          'INSERT INTO vec_index_map (source_table, source_id, vec_table, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(sourceTable, sourceId, vecTable, contentHash, new Date().toISOString());

      const mapRowId = Number(mapResult.lastInsertRowid);

      // Insert vector with matching rowid
      this.db.prepare(`INSERT INTO ${vecTable}(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(mapRowId, bytes);
    }

    return true;
  }

  /**
   * Batch index multiple items. More efficient than individual calls.
   */
  async indexBatch(
    items: Array<{ sourceTable: string; sourceId: number; content: string; domain?: string }>
  ): Promise<{ indexed: number; skipped: number }> {
    let indexed = 0;
    let skipped = 0;

    // Validate all source tables before processing any items
    for (const item of items) {
      this.validateSourceTable(item.sourceTable);
    }

    // Filter out already-indexed items
    const toIndex: typeof items = [];
    for (const item of items) {
      const contentHash = simpleHash(item.content);
      const existing = this.db
        .prepare('SELECT content_hash FROM vec_index_map WHERE source_table = ? AND source_id = ?')
        .get(item.sourceTable, item.sourceId) as { content_hash: string } | undefined;

      if (existing && existing.content_hash === contentHash) {
        skipped++;
      } else {
        toIndex.push(item);
      }
    }

    if (toIndex.length === 0) return { indexed, skipped };

    // Batch generate embeddings
    const texts = toIndex.map(item => item.content);
    const embeddings = await generateEmbeddings(texts, this.config);

    // Insert in a transaction
    this.db.exec('BEGIN');
    try {
      for (let i = 0; i < toIndex.length; i++) {
        const item = toIndex[i];
        const embedding = embeddings[i];
        const vecTable = `vec_${item.sourceTable}`;
        const contentHash = simpleHash(item.content);
        const bytes = vecToBytes(embedding);

        // Check for existing mapping (might need update vs insert)
        const existing = this.db
          .prepare('SELECT id FROM vec_index_map WHERE source_table = ? AND source_id = ?')
          .get(item.sourceTable, item.sourceId) as { id: number } | undefined;

        if (existing) {
          this.db.prepare(`DELETE FROM ${vecTable} WHERE rowid = CAST(? AS INTEGER)`).run(existing.id);
          this.db.prepare(`INSERT INTO ${vecTable}(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(existing.id, bytes);
          this.db
            .prepare('UPDATE vec_index_map SET content_hash = ?, indexed_at = ? WHERE id = ?')
            .run(contentHash, new Date().toISOString(), existing.id);
        } else {
          const mapResult = this.db
            .prepare(
              'INSERT INTO vec_index_map (source_table, source_id, vec_table, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?)'
            )
            .run(item.sourceTable, item.sourceId, vecTable, contentHash, new Date().toISOString());

          const mapRowId = Number(mapResult.lastInsertRowid);
          this.db.prepare(`INSERT INTO ${vecTable}(rowid, embedding) VALUES (CAST(? AS INTEGER), ?)`).run(mapRowId, bytes);
        }

        indexed++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { indexed, skipped };
  }

  /**
   * Semantic KNN search across one or all vector tables.
   *
   * @param precomputedEmbedding — optional pre-computed embedding for the query.
   *   When provided, skips the Ollama call entirely. The precomputed embedding
   *   is still inserted into the LRU cache so subsequent identical queries hit.
   */
  async search(
    query: string,
    opts?: {
      tables?: string[];        // e.g., ['facts', 'knowledge'] — omit for all
      limit?: number;           // default 10
      maxDistance?: number;      // filter out results beyond this distance
      precomputedEmbedding?: Float32Array;
    }
  ): Promise<VectorSearchResult[]> {
    const limit = opts?.limit || 10;
    const tables = opts?.tables || ['facts', 'knowledge', 'episodes'];

    // Validate all table names before any SQL construction
    for (const table of tables) {
      this.validateSourceTable(table);
    }

    // Use precomputed embedding if provided, otherwise call Ollama
    let queryEmbedding: Float32Array;
    if (opts?.precomputedEmbedding) {
      queryEmbedding = opts.precomputedEmbedding;
      // Populate LRU cache so subsequent queries for the same text hit
      const maxSize = this.config.cacheSize ?? 128;
      cachePut(simpleHash(query), queryEmbedding, maxSize);
    } else {
      [queryEmbedding] = await generateEmbeddings([query], this.config);
    }
    const queryBytes = vecToBytes(queryEmbedding);

    const results: VectorSearchResult[] = [];

    for (const table of tables) {
      const vecTable = `vec_${table}`;

      // Check if the vec table exists
      const tableExists = this.db
        .prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name=?")
        .get(vecTable) as { cnt: number };
      if (!tableExists || tableExists.cnt === 0) continue;

      // KNN query
      const rows = this.db
        .prepare(
          `SELECT rowid, distance 
           FROM ${vecTable} 
           WHERE embedding MATCH ? 
           ORDER BY distance 
           LIMIT ?`
        )
        .all(queryBytes, limit) as Array<{ rowid: number; distance: number }>;

      for (const row of rows) {
        if (opts?.maxDistance !== undefined && row.distance > opts.maxDistance) continue;

        // Look up source from mapping table
        const mapping = this.db
          .prepare('SELECT source_table, source_id FROM vec_index_map WHERE id = ?')
          .get(row.rowid) as { source_table: string; source_id: number } | undefined;

        if (!mapping) continue;

        // Fetch actual content from source table
        const sourceContent = this.getSourceContent(mapping.source_table, mapping.source_id);
        if (!sourceContent) continue;

        results.push({
          rowid: row.rowid,
          distance: row.distance,
          sourceTable: mapping.source_table,
          sourceId: mapping.source_id,
          content: sourceContent.content,
          domain: sourceContent.domain,
          agentId: sourceContent.agentId,
          metadata: sourceContent.metadata,
        });
      }
    }

    // Sort all results by distance (cross-table)
    results.sort((a, b) => a.distance - b.distance);
    return results.slice(0, limit);
  }

  /**
   * Get content from a source table by id.
   */
  private getSourceContent(
    table: string,
    id: number
  ): { content: string; domain?: string; agentId?: string; metadata?: string } | null {
    // Source content lives in the library DB (facts, knowledge, episodes)
    // or in the vector DB itself (if old schema). Try library first.
    const sourceDb = this.libraryDb || this.db;

    switch (table) {
      case 'facts': {
        const row = sourceDb
          .prepare('SELECT content, domain, agent_id FROM facts WHERE id = ? AND superseded_by IS NULL')
          .get(id) as { content: string; domain: string; agent_id: string } | undefined;
        return row ? { content: row.content, domain: row.domain, agentId: row.agent_id } : null;
      }
      case 'knowledge': {
        const row = sourceDb
          .prepare('SELECT content, domain, agent_id, key FROM knowledge WHERE id = ? AND superseded_by IS NULL')
          .get(id) as { content: string; domain: string; agent_id: string; key: string } | undefined;
        return row
          ? { content: row.content, domain: row.domain, agentId: row.agent_id, metadata: row.key }
          : null;
      }
      case 'episodes': {
        const row = sourceDb
          .prepare('SELECT summary, event_type, agent_id, participants FROM episodes WHERE id = ?')
          .get(id) as {
          summary: string;
          event_type: string;
          agent_id: string;
          participants: string;
        } | undefined;
        return row
          ? {
              content: row.summary,
              domain: row.event_type,
              agentId: row.agent_id,
              metadata: row.participants,
            }
          : null;
      }
      default:
        return null;
    }
  }

  /**
   * Index all un-indexed content in the agent's database.
   * Called by the background indexer.
   */
  async indexAll(agentId: string): Promise<{ indexed: number; skipped: number }> {
    const items: Array<{ sourceTable: string; sourceId: number; content: string }> = [];
    const sourceDb = this.libraryDb || this.db;

    // Count already-indexed items for accurate skip reporting
    const alreadyIndexed = (this.db
      .prepare('SELECT COUNT(*) as cnt FROM vec_index_map')
      .get() as { cnt: number }).cnt;

    // Get IDs already indexed (in vector DB)
    const indexedFacts = new Set(
      (this.db.prepare("SELECT source_id FROM vec_index_map WHERE source_table = 'facts'")
        .all() as Array<{ source_id: number }>).map(r => r.source_id)
    );
    const indexedKnowledge = new Set(
      (this.db.prepare("SELECT source_id FROM vec_index_map WHERE source_table = 'knowledge'")
        .all() as Array<{ source_id: number }>).map(r => r.source_id)
    );
    const indexedEpisodes = new Set(
      (this.db.prepare("SELECT source_id FROM vec_index_map WHERE source_table = 'episodes'")
        .all() as Array<{ source_id: number }>).map(r => r.source_id)
    );

    // Collect un-indexed facts from library DB
    const facts = sourceDb
      .prepare('SELECT id, content, domain FROM facts WHERE agent_id = ? AND superseded_by IS NULL')
      .all(agentId) as Array<{ id: number; content: string; domain: string }>;
    for (const f of facts) {
      if (!indexedFacts.has(f.id)) {
        items.push({ sourceTable: 'facts', sourceId: f.id, content: f.content });
      }
    }

    // Collect un-indexed knowledge from library DB
    const knowledge = sourceDb
      .prepare('SELECT id, content, domain, key FROM knowledge WHERE agent_id = ? AND superseded_by IS NULL')
      .all(agentId) as Array<{ id: number; content: string; domain: string; key: string }>;
    for (const k of knowledge) {
      if (!indexedKnowledge.has(k.id)) {
        items.push({
          sourceTable: 'knowledge',
          sourceId: k.id,
          content: `${k.key}: ${k.content}`,
        });
      }
    }

    // Collect un-indexed episodes from library DB
    const episodes = sourceDb
      .prepare('SELECT id, summary, event_type FROM episodes WHERE agent_id = ?')
      .all(agentId) as Array<{ id: number; summary: string; event_type: string }>;
    for (const e of episodes) {
      if (!indexedEpisodes.has(e.id)) {
        items.push({ sourceTable: 'episodes', sourceId: e.id, content: e.summary });
      }
    }

    if (items.length === 0) {
      return { indexed: 0, skipped: alreadyIndexed };
    }

    const result = await this.indexBatch(items);
    return { indexed: result.indexed, skipped: result.skipped + alreadyIndexed };
  }

  /**
   * Remove vector index entries for deleted source rows.
   */
  pruneOrphans(): number {
    let pruned = 0;
    const sourceDb = this.libraryDb || this.db;

    for (const table of ['facts', 'knowledge', 'episodes']) {
      // Get all indexed IDs for this table
      const indexed = this.db
        .prepare('SELECT id, vec_table, source_id FROM vec_index_map WHERE source_table = ?')
        .all(table) as Array<{ id: number; vec_table: string; source_id: number }>;

      for (const entry of indexed) {
        // Check if source still exists in library DB
        const exists = sourceDb
          .prepare(`SELECT 1 FROM ${table} WHERE id = ?`)
          .get(entry.source_id);

        if (!exists) {
          this.db.prepare(`DELETE FROM ${entry.vec_table} WHERE rowid = CAST(? AS INTEGER)`).run(entry.id);
          this.db.prepare('DELETE FROM vec_index_map WHERE id = ?').run(entry.id);
          pruned++;
        }
      }
    }

    return pruned;
  }

  /**
   * Remove the vector index entry for a single source item.
   *
   * Deletes both the vec table row and the vec_index_map entry for the given
   * (sourceTable, sourceId) pair. Used by the background indexer for immediate
   * point-in-time removal when a supersedes relationship is detected.
   *
   * @returns true if an entry was found and removed, false if nothing was indexed.
   */
  removeItem(sourceTable: string, sourceId: number): boolean {
    this.validateSourceTable(sourceTable);

    const entry = this.db
      .prepare('SELECT id, vec_table FROM vec_index_map WHERE source_table = ? AND source_id = ?')
      .get(sourceTable, sourceId) as { id: number; vec_table: string } | undefined;

    if (!entry) return false;

    this.db.prepare(`DELETE FROM ${entry.vec_table} WHERE rowid = CAST(? AS INTEGER)`).run(entry.id);
    this.db.prepare('DELETE FROM vec_index_map WHERE id = ?').run(entry.id);
    return true;
  }

  /**
   * Check whether a source item already has a vector in the index.
   * Used by the episode backfill to skip already-vectorized entries.
   */
  hasItem(sourceTable: string, sourceId: number): boolean {
    this.validateSourceTable(sourceTable);
    const row = this.db
      .prepare('SELECT 1 FROM vec_index_map WHERE source_table = ? AND source_id = ? LIMIT 1')
      .get(sourceTable, sourceId);
    return row !== undefined;
  }

  /**
   * Tombstone vector entries for superseded facts and knowledge.
   *
   * When fact A is superseded by fact B (facts.superseded_by = B.id), the old
   * vector for A should not surface in semantic recall. Without this, recalled
   * context can include contradicted/outdated facts alongside their replacements.
   *
   * Strategy: find all indexed facts/knowledge with superseded_by IS NOT NULL
   * and delete their vec_index_map entries + vec table rows. The source row
   * stays in library.db (audit trail) but disappears from recall.
   *
   * @returns Number of vector entries tombstoned.
   */
  tombstoneSuperseded(): number {
    const sourceDb = this.libraryDb || this.db;
    let tombstoned = 0;

    for (const table of ['facts', 'knowledge'] as const) {
      // Find all indexed entries whose source row has been superseded
      const indexed = this.db
        .prepare('SELECT vim.id, vim.vec_table, vim.source_id FROM vec_index_map vim WHERE vim.source_table = ?')
        .all(table) as Array<{ id: number; vec_table: string; source_id: number }>;

      for (const entry of indexed) {
        const row = sourceDb
          .prepare(`SELECT superseded_by FROM ${table} WHERE id = ?`)
          .get(entry.source_id) as { superseded_by: number | null } | undefined;

        if (row?.superseded_by != null) {
          // Remove from vector table
          this.db.prepare(`DELETE FROM ${entry.vec_table} WHERE rowid = CAST(? AS INTEGER)`).run(entry.id);
          // Remove from index map
          this.db.prepare('DELETE FROM vec_index_map WHERE id = ?').run(entry.id);
          tombstoned++;
        }
      }
    }

    if (tombstoned > 0) {
      console.log(`[hypermem-vector] tombstoneSuperseded: removed ${tombstoned} stale vector entries`);
    }
    return tombstoned;
  }

  /**
   * Get index statistics.
   */
  getStats(): VectorIndexStats {
    const breakdown: Record<string, number> = {};
    let total = 0;

    for (const table of ['facts', 'knowledge', 'episodes']) {
      const count = this.db
        .prepare('SELECT COUNT(*) as cnt FROM vec_index_map WHERE source_table = ?')
        .get(table) as { cnt: number };
      breakdown[table] = count.cnt;
      total += count.cnt;
    }

    const lastIndexed = this.db
      .prepare('SELECT MAX(indexed_at) as last_at FROM vec_index_map')
      .get() as { last_at: string | null };

    return {
      totalVectors: total,
      tableBreakdown: breakdown,
      lastIndexedAt: lastIndexed.last_at,
    };
  }
}

/**
 * SHA-256 content hash for change detection and deduplication.
 * Replaces the prior 32-bit rolling hash which had collision risk on large corpora.
 */
function simpleHash(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * Create vector tables in a library database for session registry search.
 */
export function ensureSessionVecTable(db: DatabaseSync, dimensions: number = 768): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_sessions
    USING vec0(embedding float[${dimensions}])
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_session_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    )
  `);
}
