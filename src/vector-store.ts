/**
 * HyperMem Vector Store — Semantic Search via sqlite-vec
 *
 * Provides embedding-backed KNN search over facts, knowledge, episodes,
 * and session registry entries. Uses Ollama (local) for embeddings,
 * sqlite-vec for vector indexing, and coexists with existing FTS5.
 *
 * Architecture:
 *   - One vec0 virtual table per indexed content type
 *   - Embeddings generated via local Ollama (nomic-embed-text, 768d)
 *   - Vectors stored alongside content in the same agent DB
 *   - Embedding cache to avoid redundant API calls
 *   - Batch embedding support for bulk indexing
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';

export interface EmbeddingConfig {
  /** Ollama base URL. Default: http://localhost:11434 */
  ollamaUrl: string;
  /** Embedding model name. Default: nomic-embed-text */
  model: string;
  /** Embedding dimensions. Default: 768 */
  dimensions: number;
  /** Request timeout ms. Default: 10000 */
  timeout: number;
  /** Max texts per batch request. Default: 32 */
  batchSize: number;
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
  ollamaUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
  timeout: 10000,
  batchSize: 32,
};

/**
 * Generate embeddings via Ollama API.
 * Supports single and batch embedding.
 */
export async function generateEmbeddings(
  texts: string[],
  config: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  const results: Float32Array[] = [];

  // Ollama /api/embed supports batch via `input` array
  for (let i = 0; i < texts.length; i += config.batchSize) {
    const batch = texts.slice(i, i + config.batchSize);

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
        results.push(new Float32Array(embedding));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return results;
}

/**
 * Serialize a Float32Array to Uint8Array for sqlite-vec binding.
 */
function vecToBytes(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * VectorStore — manages vector indexes in an agent's SQLite database.
 *
 * Creates vec0 virtual tables alongside existing content tables.
 * Provides KNN search with optional domain/type filtering.
 */
export class VectorStore {
  private readonly db: DatabaseSync;
  private readonly config: EmbeddingConfig;

  constructor(db: DatabaseSync, config?: Partial<EmbeddingConfig>) {
    this.db = db;
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
  async indexItem(
    sourceTable: string,
    sourceId: number,
    content: string,
    domain?: string
  ): Promise<boolean> {
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
   */
  async search(
    query: string,
    opts?: {
      tables?: string[];        // e.g., ['facts', 'knowledge'] — omit for all
      limit?: number;           // default 10
      maxDistance?: number;      // filter out results beyond this distance
    }
  ): Promise<VectorSearchResult[]> {
    const limit = opts?.limit || 10;
    const tables = opts?.tables || ['facts', 'knowledge', 'episodes'];

    // Generate query embedding
    const [queryEmbedding] = await generateEmbeddings([query], this.config);
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
    switch (table) {
      case 'facts': {
        const row = this.db
          .prepare('SELECT content, domain, agent_id FROM facts WHERE id = ?')
          .get(id) as { content: string; domain: string; agent_id: string } | undefined;
        return row ? { content: row.content, domain: row.domain, agentId: row.agent_id } : null;
      }
      case 'knowledge': {
        const row = this.db
          .prepare('SELECT content, domain, agent_id, key FROM knowledge WHERE id = ?')
          .get(id) as { content: string; domain: string; agent_id: string; key: string } | undefined;
        return row
          ? { content: row.content, domain: row.domain, agentId: row.agent_id, metadata: row.key }
          : null;
      }
      case 'episodes': {
        const row = this.db
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

    // Count already-indexed items for accurate skip reporting
    const alreadyIndexed = (this.db
      .prepare('SELECT COUNT(*) as cnt FROM vec_index_map')
      .get() as { cnt: number }).cnt;

    // Collect un-indexed facts
    const facts = this.db
      .prepare(
        `SELECT f.id, f.content, f.domain 
         FROM facts f 
         LEFT JOIN vec_index_map m ON m.source_table = 'facts' AND m.source_id = f.id 
         WHERE f.agent_id = ? AND m.id IS NULL`
      )
      .all(agentId) as Array<{ id: number; content: string; domain: string }>;
    for (const f of facts) {
      items.push({ sourceTable: 'facts', sourceId: f.id, content: f.content });
    }

    // Collect un-indexed knowledge
    const knowledge = this.db
      .prepare(
        `SELECT k.id, k.content, k.domain, k.key 
         FROM knowledge k 
         LEFT JOIN vec_index_map m ON m.source_table = 'knowledge' AND m.source_id = k.id 
         WHERE k.agent_id = ? AND k.superseded_by IS NULL AND m.id IS NULL`
      )
      .all(agentId) as Array<{ id: number; content: string; domain: string; key: string }>;
    for (const k of knowledge) {
      items.push({
        sourceTable: 'knowledge',
        sourceId: k.id,
        content: `${k.key}: ${k.content}`,
      });
    }

    // Collect un-indexed episodes
    const episodes = this.db
      .prepare(
        `SELECT e.id, e.summary, e.event_type 
         FROM episodes e 
         LEFT JOIN vec_index_map m ON m.source_table = 'episodes' AND m.source_id = e.id 
         WHERE e.agent_id = ? AND m.id IS NULL`
      )
      .all(agentId) as Array<{ id: number; summary: string; event_type: string }>;
    for (const e of episodes) {
      items.push({ sourceTable: 'episodes', sourceId: e.id, content: e.summary });
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

    for (const table of ['facts', 'knowledge', 'episodes']) {
      const orphans = this.db
        .prepare(
          `SELECT m.id, m.vec_table 
           FROM vec_index_map m 
           LEFT JOIN ${table} t ON t.id = m.source_id 
           WHERE m.source_table = ? AND t.id IS NULL`
        )
        .all(table) as Array<{ id: number; vec_table: string }>;

      for (const orphan of orphans) {
        this.db.prepare(`DELETE FROM ${orphan.vec_table} WHERE rowid = CAST(? AS INTEGER)`).run(orphan.id);
        this.db.prepare('DELETE FROM vec_index_map WHERE id = ?').run(orphan.id);
        pruned++;
      }
    }

    return pruned;
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
 * Simple content hash for change detection.
 * Not cryptographic — just for dedup.
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
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
