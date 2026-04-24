/**
 * hypermem Document Chunk Store
 *
 * Manages doc_chunks in library.db:
 * - Atomic re-indexing by source hash (no stale/fresh coexistence)
 * - FTS5 keyword search fallback
 * - Collection-scoped queries with agent/tier filtering
 * - Source tracking (what's indexed, when, what hash)
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { existsSync } from 'node:fs';
import type { DocChunk } from './doc-chunker.js';

// ─── Types ──────────────────────────────────────────────────────

export interface DocChunkRow {
  id: string;
  collection: string;
  sectionPath: string;
  depth: number;
  content: string;
  tokenEstimate: number;
  sourceHash: string;
  sourcePath: string;
  scope: string;
  tier: string | null;
  agentId: string | null;
  parentPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocSourceRow {
  sourcePath: string;
  collection: string;
  scope: string;
  agentId: string | null;
  sourceHash: string;
  chunkCount: number;
  indexedAt: string;
}

export interface IndexResult {
  /** Number of new chunks inserted */
  inserted: number;
  /** Number of stale chunks deleted (from prior version) */
  deleted: number;
  /** Whether this was a full re-index (hash changed) or a no-op (hash unchanged) */
  reindexed: boolean;
  /** Whether this source was already up-to-date */
  skipped: boolean;
}

export interface GarbageCollectResult {
  /** Number of stale doc_chunks rows deleted */
  chunksDeleted: number;
  /** Number of stale doc_sources rows deleted */
  sourcesDeleted: number;
  /** Distinct missing source paths removed */
  missingSources: string[];
}

export interface ChunkQuery {
  /** Collection path to query */
  collection: string;
  /** Filter by scope */
  scope?: string;
  /** Filter by agent ID (for per-agent chunks) */
  agentId?: string;
  /** Filter by tier (for per-tier chunks) */
  tier?: string;
  /** Max number of chunks to return */
  limit?: number;
  /** Keyword search (FTS5) */
  keyword?: string;
}

// ─── Store ──────────────────────────────────────────────────────

export class DocChunkStore {
  constructor(private db: DatabaseSync) {}

  /**
   * Index a set of chunks for a source file.
   *
   * Atomic re-indexing:
   * 1. Check if source_hash has changed
   * 2. If unchanged: skip (idempotent)
   * 3. If changed: delete all chunks with old hash, insert new chunks — in one transaction
   *
   * This ensures no window where stale and fresh chunks coexist.
   */
  indexChunks(chunks: DocChunk[]): IndexResult {
    if (chunks.length === 0) {
      return { inserted: 0, deleted: 0, reindexed: false, skipped: true };
    }

    const first = chunks[0];
    const { sourcePath, collection, sourceHash, scope, agentId } = first;
    const now = new Date().toISOString();

    // Check current indexed state
    const existing = this.db
      .prepare('SELECT source_hash, chunk_count FROM doc_sources WHERE source_path = ? AND collection = ?')
      .get(sourcePath, collection) as { source_hash: string; chunk_count: number } | undefined;

    if (existing && existing.source_hash === sourceHash) {
      // Hash unchanged — no-op
      return { inserted: 0, deleted: 0, reindexed: false, skipped: true };
    }

    // Hash changed (or first index) — atomic swap
    let deleted = 0;
    let inserted = 0;

    // Use a transaction for atomicity
    const run = this.db.prepare('SELECT 1').get; // warm
    
    try {
      // Begin transaction via exec
      this.db.exec('BEGIN');

      // Delete stale chunks for this source
      if (existing) {
        const result = this.db
          .prepare('DELETE FROM doc_chunks WHERE source_path = ? AND collection = ?')
          .run(sourcePath, collection);
        deleted = result.changes as number;
      }

      // Insert new chunks
      const insertChunk = this.db.prepare(`
        INSERT OR REPLACE INTO doc_chunks
          (id, collection, section_path, depth, content, token_estimate,
           source_hash, source_path, scope, tier, agent_id, parent_path,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const chunk of chunks) {
        insertChunk.run(
          chunk.id,
          chunk.collection,
          chunk.sectionPath,
          chunk.depth,
          chunk.content,
          chunk.tokenEstimate,
          chunk.sourceHash,
          chunk.sourcePath,
          chunk.scope,
          chunk.tier ?? null,
          chunk.agentId ?? null,
          chunk.parentPath ?? null,
          now,
          now
        );
        inserted++;
      }

      // Update source tracking
      this.db.prepare(`
        INSERT OR REPLACE INTO doc_sources
          (source_path, collection, scope, agent_id, source_hash, chunk_count, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sourcePath, collection, scope, agentId ?? null, sourceHash, inserted, now);

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { inserted, deleted, reindexed: !!existing, skipped: false };
  }

  /**
   * Query chunks by collection with optional filters.
   * Falls back to FTS5 keyword search when keyword is provided.
   */
  queryChunks(query: ChunkQuery): DocChunkRow[] {
    const { collection, scope, agentId, tier, limit = 20, keyword } = query;

    if (keyword) {
      return this.keywordSearch(keyword, query);
    }

    // Build WHERE clause
    const conditions: string[] = ['collection = ?'];
    const params: SQLInputValue[] = [collection];

    if (scope) {
      conditions.push('scope = ?');
      params.push(scope);
    }

    if (agentId) {
      conditions.push('(agent_id = ? OR agent_id IS NULL)');
      params.push(agentId);
    }

    if (tier) {
      conditions.push('(tier = ? OR tier IS NULL OR tier = \'all\')');
      params.push(tier);
    }

    params.push(limit);

    const rows = this.db
      .prepare(`
        SELECT id, collection, section_path, depth, content, token_estimate,
               source_hash, source_path, scope, tier, agent_id, parent_path,
               created_at, updated_at
        FROM doc_chunks
        WHERE ${conditions.join(' AND ')}
        ORDER BY depth ASC, section_path ASC
        LIMIT ?
      `)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map(this.mapRow);
  }

  /**
   * FTS5 keyword search across chunks.
   */
  keywordSearch(keyword: string, query: Omit<ChunkQuery, 'keyword'>): DocChunkRow[] {
    const { collection, agentId, tier, limit = 20 } = query;

    const hasFilters = !!(agentId || tier);
    const innerLimit = hasFilters ? limit * 4 : limit;

    // Two-phase: FTS in subquery, metadata filter on small result set.
    let sql = `
      SELECT c.id, c.collection, c.section_path, c.depth, c.content, c.token_estimate,
             c.source_hash, c.source_path, c.scope, c.tier, c.agent_id, c.parent_path,
             c.created_at, c.updated_at
      FROM (
        SELECT rowid, rank FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ? ORDER BY rank LIMIT ?
      ) sub
      JOIN doc_chunks c ON c.rowid = sub.rowid
      WHERE c.collection = ?
    `;
    const params: SQLInputValue[] = [keyword, innerLimit, collection];

    if (agentId) {
      sql += ' AND (c.agent_id = ? OR c.agent_id IS NULL)';
      params.push(agentId);
    }

    if (tier) {
      sql += " AND (c.tier = ? OR c.tier IS NULL OR c.tier = 'all')";
      params.push(tier);
    }

    sql += ' ORDER BY sub.rank LIMIT ?';
    params.push(limit * 3); // over-fetch to allow dedup

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    // Deduplicate by source_hash to avoid returning identical content
    // from multiple agent-specific copies of shared-fleet docs.
    const seenHashes = new Set<string>();
    const deduped = rows.filter(r => {
      const hash = r['source_hash'] as string | null;
      if (!hash) return true;
      if (seenHashes.has(hash)) return false;
      seenHashes.add(hash);
      return true;
    });

    return deduped.slice(0, limit).map(this.mapRow);
  }

  /**
   * Get a single chunk by ID.
   */
  getChunk(id: string): DocChunkRow | null {
    const row = this.db
      .prepare(`
        SELECT id, collection, section_path, depth, content, token_estimate,
               source_hash, source_path, scope, tier, agent_id, parent_path,
               created_at, updated_at
        FROM doc_chunks WHERE id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /**
   * Check if a source file needs re-indexing.
   * Returns true if the file has changed or has never been indexed.
   */
  needsReindex(sourcePath: string, collection: string, currentHash: string): boolean {
    const row = this.db
      .prepare('SELECT source_hash FROM doc_sources WHERE source_path = ? AND collection = ?')
      .get(sourcePath, collection) as { source_hash: string } | undefined;
    return !row || row.source_hash !== currentHash;
  }

  /**
   * List all indexed sources, optionally filtered by agent or collection.
   */
  listSources(opts?: { agentId?: string; collection?: string }): DocSourceRow[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];

    if (opts?.agentId) {
      conditions.push('agent_id = ?');
      params.push(opts.agentId);
    }

    if (opts?.collection) {
      conditions.push('collection = ?');
      params.push(opts.collection);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = this.db
      .prepare(`
        SELECT source_path, collection, scope, agent_id, source_hash, chunk_count, indexed_at
        FROM doc_sources ${where}
        ORDER BY indexed_at DESC
      `)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map(r => ({
      sourcePath: r['source_path'] as string,
      collection: r['collection'] as string,
      scope: r['scope'] as string,
      agentId: r['agent_id'] as string | null,
      sourceHash: r['source_hash'] as string,
      chunkCount: r['chunk_count'] as number,
      indexedAt: r['indexed_at'] as string,
    }));
  }

  /**
   * Delete all chunks for a specific source file.
   */
  deleteSource(sourcePath: string, collection: string): number {
    this.db.exec('BEGIN');
    try {
      const result = this.db
        .prepare('DELETE FROM doc_chunks WHERE source_path = ? AND collection = ?')
        .run(sourcePath, collection);
      this.db.prepare('DELETE FROM doc_sources WHERE source_path = ? AND collection = ?')
        .run(sourcePath, collection);
      this.db.exec('COMMIT');
      return result.changes as number;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Remove doc chunks and source tracker rows whose source files no longer exist.
   *
   * This is intentionally limited by an optional source path prefix so workspace
   * seeding can clean its own stale rows without sweeping unrelated agents.
   * Rebuilds the external-content FTS table after deletes because this schema
   * does not install row-level FTS maintenance triggers.
   */
  garbageCollectMissingSources(opts: { sourcePathPrefix?: string } = {}): GarbageCollectResult {
    const prefix = opts.sourcePathPrefix?.replace(/\/+$/, '');
    const prefixClause = prefix ? 'WHERE source_path = ? OR source_path LIKE ?' : '';
    const chunkParams: SQLInputValue[] = prefix ? [prefix, `${prefix}/%`] : [];
    const sourceParams: SQLInputValue[] = prefix ? [prefix, `${prefix}/%`] : [];

    const rows = this.db
      .prepare(`
        SELECT DISTINCT source_path FROM (
          SELECT source_path FROM doc_chunks ${prefixClause}
          UNION
          SELECT source_path FROM doc_sources ${prefixClause}
        )
      `)
      .all(...chunkParams, ...sourceParams) as Array<{ source_path: string }>;

    const missingSources = rows
      .map(r => r.source_path)
      .filter(sourcePath => !existsSync(sourcePath))
      .sort();

    if (missingSources.length === 0) {
      return { chunksDeleted: 0, sourcesDeleted: 0, missingSources: [] };
    }

    let chunksDeleted = 0;
    let sourcesDeleted = 0;

    this.db.exec('BEGIN');
    try {
      const deleteChunks = this.db.prepare('DELETE FROM doc_chunks WHERE source_path = ?');
      const deleteSources = this.db.prepare('DELETE FROM doc_sources WHERE source_path = ?');
      for (const sourcePath of missingSources) {
        chunksDeleted += deleteChunks.run(sourcePath).changes as number;
        sourcesDeleted += deleteSources.run(sourcePath).changes as number;
      }
      this.db.prepare("INSERT INTO doc_chunks_fts(doc_chunks_fts) VALUES('rebuild')").run();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return { chunksDeleted, sourcesDeleted, missingSources };
  }

  /**
   * Index simple string chunks with an optional session key (for ephemeral spawn context).
   *
   * Unlike indexChunks() which works with DocChunk objects and hash-based dedup,
   * this method is designed for ad-hoc session-scoped content: it always inserts fresh
   * rows tagged with the sessionKey, without hash-based skip logic.
   *
   * Chunks stored with a sessionKey are ephemeral — use clearSessionChunks() to remove them.
   */
  indexDocChunks(
    agentId: string,
    source: string,
    chunks: string[],
    options?: { sessionKey?: string }
  ): void {
    if (chunks.length === 0) return;
    const now = new Date().toISOString();
    const sessionKey = options?.sessionKey ?? null;
    // Use a stable collection name derived from source path
    const collection = `spawn/${agentId}`;

    try {
      this.db.exec('BEGIN');
      const insert = this.db.prepare(`
        INSERT INTO doc_chunks
          (id, collection, section_path, depth, content, token_estimate,
           source_hash, source_path, scope, tier, agent_id, parent_path,
           session_key, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      chunks.forEach((chunkContent, idx) => {
        const id = `spawn:${agentId}:${sessionKey ?? 'none'}:${source}:${idx}:${Date.now()}`;
        const tokenEstimate = Math.ceil(chunkContent.length / 4);
        insert.run(
          id,
          collection,
          `${source}#chunk-${idx}`,
          2,
          chunkContent,
          tokenEstimate,
          `spawn-${Date.now()}-${idx}`, // non-deduped hash
          source,
          'per-agent',
          null,
          agentId,
          null,
          sessionKey,
          now,
          now
        );
      });
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      console.warn('[hypermem:doc-chunk-store] indexDocChunks failed:', (err as Error).message);
    }
  }

  /**
   * Query doc chunks by agentId+query string, with optional session key scoping.
   * When sessionKey is provided, only chunks tagged with that session key are returned.
   */
  queryDocChunks(
    agentId: string,
    query: string,
    options?: { sessionKey?: string; limit?: number }
  ): DocChunkRow[] {
    const limit = options?.limit ?? 10;
    const sessionKey = options?.sessionKey;
    const collection = `spawn/${agentId}`;

    try {
      if (query.trim() && query.trim().length >= 3) {
        // FTS5 keyword search
        let sql = `
          SELECT c.id, c.collection, c.section_path, c.depth, c.content, c.token_estimate,
                 c.source_hash, c.source_path, c.scope, c.tier, c.agent_id, c.parent_path,
                 c.created_at, c.updated_at
          FROM (
            SELECT rowid, rank FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ? ORDER BY rank LIMIT ?
          ) sub
          JOIN doc_chunks c ON c.rowid = sub.rowid
          WHERE c.collection = ?
        `;
        const params: (string | number | null)[] = [query, limit * 3, collection];

        if (sessionKey !== undefined) {
          sql += ' AND c.session_key = ?';
          params.push(sessionKey);
        }
        sql += ' ORDER BY sub.rank LIMIT ?';
        params.push(limit);

        const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
        return rows.map(this.mapRow);
      } else {
        // Fallback: return most recent chunks for this session
        let sql = `
          SELECT id, collection, section_path, depth, content, token_estimate,
                 source_hash, source_path, scope, tier, agent_id, parent_path,
                 created_at, updated_at
          FROM doc_chunks
          WHERE collection = ?
        `;
        const params: (string | number | null)[] = [collection];

        if (sessionKey !== undefined) {
          sql += ' AND session_key = ?';
          params.push(sessionKey);
        }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);

        const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
        return rows.map(this.mapRow);
      }
    } catch (err) {
      console.warn('[hypermem:doc-chunk-store] queryDocChunks failed:', (err as Error).message);
      return [];
    }
  }

  /**
   * Delete all doc chunks associated with a specific session key.
   * Call this when a spawn session is complete to release ephemeral storage.
   */
  clearSessionChunks(sessionKey: string): number {
    try {
      const result = this.db
        .prepare('DELETE FROM doc_chunks WHERE session_key = ?')
        .run(sessionKey);
      return result.changes as number;
    } catch (err) {
      console.warn('[hypermem:doc-chunk-store] clearSessionChunks failed:', (err as Error).message);
      return 0;
    }
  }

  /**
   * Get chunk stats: count per collection.
   */
  getStats(): Array<{ collection: string; count: number; sources: number; totalTokens: number }> {
    const rows = this.db.prepare(`
      SELECT collection,
             COUNT(*) as count,
             COUNT(DISTINCT source_path) as sources,
             SUM(token_estimate) as total_tokens
      FROM doc_chunks
      GROUP BY collection
      ORDER BY collection
    `).all() as Array<Record<string, unknown>>;

    return rows.map(r => ({
      collection: r['collection'] as string,
      count: r['count'] as number,
      sources: r['sources'] as number,
      totalTokens: (r['total_tokens'] as number) ?? 0,
    }));
  }

  private mapRow(r: Record<string, unknown>): DocChunkRow {
    return {
      id: r['id'] as string,
      collection: r['collection'] as string,
      sectionPath: r['section_path'] as string,
      depth: r['depth'] as number,
      content: r['content'] as string,
      tokenEstimate: r['token_estimate'] as number,
      sourceHash: r['source_hash'] as string,
      sourcePath: r['source_path'] as string,
      scope: r['scope'] as string,
      tier: r['tier'] as string | null,
      agentId: r['agent_id'] as string | null,
      parentPath: r['parent_path'] as string | null,
      createdAt: r['created_at'] as string,
      updatedAt: r['updated_at'] as string,
    };
  }
}
