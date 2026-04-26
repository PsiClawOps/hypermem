/**
 * hypermem Document Chunk Store
 *
 * Manages doc_chunks in library.db:
 * - Atomic re-indexing by source hash (no stale/fresh coexistence)
 * - FTS5 keyword search fallback
 * - Collection-scoped queries with agent/tier filtering
 * - Source tracking (what's indexed, when, what hash)
 */
import { existsSync } from 'node:fs';
// ─── Store ──────────────────────────────────────────────────────
export class DocChunkStore {
    db;
    constructor(db) {
        this.db = db;
    }
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
    indexChunks(chunks) {
        if (chunks.length === 0) {
            return { inserted: 0, deleted: 0, reindexed: false, skipped: true };
        }
        const first = chunks[0];
        const { sourcePath, collection, sourceHash, scope, agentId } = first;
        const now = new Date().toISOString();
        // Check current indexed state
        const existing = this.db
            .prepare('SELECT source_hash, chunk_count FROM doc_sources WHERE source_path = ? AND collection = ?')
            .get(sourcePath, collection);
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
                deleted = result.changes;
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
                insertChunk.run(chunk.id, chunk.collection, chunk.sectionPath, chunk.depth, chunk.content, chunk.tokenEstimate, chunk.sourceHash, chunk.sourcePath, chunk.scope, chunk.tier ?? null, chunk.agentId ?? null, chunk.parentPath ?? null, now, now);
                inserted++;
            }
            // Update source tracking
            this.db.prepare(`
        INSERT OR REPLACE INTO doc_sources
          (source_path, collection, scope, agent_id, source_hash, chunk_count, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sourcePath, collection, scope, agentId ?? null, sourceHash, inserted, now);
            this.db.exec('COMMIT');
        }
        catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
        return { inserted, deleted, reindexed: !!existing, skipped: false };
    }
    /**
     * Query chunks by collection with optional filters.
     * Falls back to FTS5 keyword search when keyword is provided.
     */
    queryChunks(query) {
        const { collection, scope, agentId, tier, limit = 20, keyword } = query;
        if (keyword) {
            return this.keywordSearch(keyword, query);
        }
        // Build WHERE clause
        const conditions = ['collection = ?'];
        const params = [collection];
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
            .all(...params);
        return rows.map(this.mapRow);
    }
    /**
     * FTS5 keyword search across chunks.
     */
    keywordSearch(keyword, query) {
        const { collection, agentId, tier, limit = 20 } = query;
        // Two-phase: FTS first, then metadata filters before applying the final limit.
        // Do not cap the FTS subquery before collection filtering. If memory/daily or
        // another broad collection dominates the raw BM25 top N, a pre-filter LIMIT can
        // starve the canonical collection and make scoped doctrine retrieval look empty.
        let sql = `
      SELECT c.id, c.collection, c.section_path, c.depth, c.content, c.token_estimate,
             c.source_hash, c.source_path, c.scope, c.tier, c.agent_id, c.parent_path,
             c.created_at, c.updated_at
      FROM (
        SELECT rowid, rank FROM doc_chunks_fts WHERE doc_chunks_fts MATCH ?
      ) sub
      JOIN doc_chunks c ON c.rowid = sub.rowid
      WHERE c.collection = ?
    `;
        const params = [keyword, collection];
        if (agentId) {
            sql += ' AND (c.agent_id = ? OR c.agent_id IS NULL)';
            params.push(agentId);
        }
        if (tier) {
            sql += " AND (c.tier = ? OR c.tier IS NULL OR c.tier = 'all')";
            params.push(tier);
        }
        sql += ' ORDER BY sub.rank LIMIT ?';
        params.push(limit * 10); // over-fetch to allow dedup across shared-fleet copies
        const rows = this.db.prepare(sql).all(...params);
        // Deduplicate by source_hash to avoid returning identical content
        // from multiple agent-specific copies of shared-fleet docs.
        const seenHashes = new Set();
        const deduped = rows.filter(r => {
            const hash = r['source_hash'];
            if (!hash)
                return true;
            if (seenHashes.has(hash))
                return false;
            seenHashes.add(hash);
            return true;
        });
        return deduped.slice(0, limit).map(this.mapRow);
    }
    /**
     * Get a single chunk by ID.
     */
    getChunk(id) {
        const row = this.db
            .prepare(`
        SELECT id, collection, section_path, depth, content, token_estimate,
               source_hash, source_path, scope, tier, agent_id, parent_path,
               created_at, updated_at
        FROM doc_chunks WHERE id = ?
      `)
            .get(id);
        return row ? this.mapRow(row) : null;
    }
    /**
     * Check if a source file needs re-indexing.
     * Returns true if the file has changed or has never been indexed.
     */
    needsReindex(sourcePath, collection, currentHash) {
        const row = this.db
            .prepare('SELECT source_hash FROM doc_sources WHERE source_path = ? AND collection = ?')
            .get(sourcePath, collection);
        return !row || row.source_hash !== currentHash;
    }
    /**
     * List all indexed sources, optionally filtered by agent or collection.
     */
    listSources(opts) {
        const conditions = [];
        const params = [];
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
            .all(...params);
        return rows.map(r => ({
            sourcePath: r['source_path'],
            collection: r['collection'],
            scope: r['scope'],
            agentId: r['agent_id'],
            sourceHash: r['source_hash'],
            chunkCount: r['chunk_count'],
            indexedAt: r['indexed_at'],
        }));
    }
    /**
     * Delete all chunks for a specific source file.
     */
    deleteSource(sourcePath, collection) {
        this.db.exec('BEGIN');
        try {
            const result = this.db
                .prepare('DELETE FROM doc_chunks WHERE source_path = ? AND collection = ?')
                .run(sourcePath, collection);
            this.db.prepare('DELETE FROM doc_sources WHERE source_path = ? AND collection = ?')
                .run(sourcePath, collection);
            this.db.exec('COMMIT');
            return result.changes;
        }
        catch (err) {
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
    garbageCollectMissingSources(opts = {}) {
        const prefix = opts.sourcePathPrefix?.replace(/\/+$/, '');
        const prefixClause = prefix ? 'WHERE source_path = ? OR source_path LIKE ?' : '';
        const chunkParams = prefix ? [prefix, `${prefix}/%`] : [];
        const sourceParams = prefix ? [prefix, `${prefix}/%`] : [];
        const rows = this.db
            .prepare(`
        SELECT DISTINCT source_path FROM (
          SELECT source_path FROM doc_chunks ${prefixClause}
          UNION
          SELECT source_path FROM doc_sources ${prefixClause}
        )
      `)
            .all(...chunkParams, ...sourceParams);
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
                chunksDeleted += deleteChunks.run(sourcePath).changes;
                sourcesDeleted += deleteSources.run(sourcePath).changes;
            }
            this.db.prepare("INSERT INTO doc_chunks_fts(doc_chunks_fts) VALUES('rebuild')").run();
            this.db.exec('COMMIT');
        }
        catch (err) {
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
    indexDocChunks(agentId, source, chunks, options) {
        if (chunks.length === 0)
            return;
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
                insert.run(id, collection, `${source}#chunk-${idx}`, 2, chunkContent, tokenEstimate, `spawn-${Date.now()}-${idx}`, // non-deduped hash
                source, 'per-agent', null, agentId, null, sessionKey, now, now);
            });
            this.db.exec('COMMIT');
        }
        catch (err) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch { /* ignore */ }
            console.warn('[hypermem:doc-chunk-store] indexDocChunks failed:', err.message);
        }
    }
    /**
     * Query doc chunks by agentId+query string, with optional session key scoping.
     * When sessionKey is provided, only chunks tagged with that session key are returned.
     */
    queryDocChunks(agentId, query, options) {
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
                const params = [query, limit * 3, collection];
                if (sessionKey !== undefined) {
                    sql += ' AND c.session_key = ?';
                    params.push(sessionKey);
                }
                sql += ' ORDER BY sub.rank LIMIT ?';
                params.push(limit);
                const rows = this.db.prepare(sql).all(...params);
                return rows.map(this.mapRow);
            }
            else {
                // Fallback: return most recent chunks for this session
                let sql = `
          SELECT id, collection, section_path, depth, content, token_estimate,
                 source_hash, source_path, scope, tier, agent_id, parent_path,
                 created_at, updated_at
          FROM doc_chunks
          WHERE collection = ?
        `;
                const params = [collection];
                if (sessionKey !== undefined) {
                    sql += ' AND session_key = ?';
                    params.push(sessionKey);
                }
                sql += ' ORDER BY created_at DESC LIMIT ?';
                params.push(limit);
                const rows = this.db.prepare(sql).all(...params);
                return rows.map(this.mapRow);
            }
        }
        catch (err) {
            console.warn('[hypermem:doc-chunk-store] queryDocChunks failed:', err.message);
            return [];
        }
    }
    /**
     * Delete all doc chunks associated with a specific session key.
     * Call this when a spawn session is complete to release ephemeral storage.
     */
    clearSessionChunks(sessionKey) {
        try {
            const result = this.db
                .prepare('DELETE FROM doc_chunks WHERE session_key = ?')
                .run(sessionKey);
            return result.changes;
        }
        catch (err) {
            console.warn('[hypermem:doc-chunk-store] clearSessionChunks failed:', err.message);
            return 0;
        }
    }
    /**
     * Get chunk stats: count per collection.
     */
    getStats() {
        const rows = this.db.prepare(`
      SELECT collection,
             COUNT(*) as count,
             COUNT(DISTINCT source_path) as sources,
             SUM(token_estimate) as total_tokens
      FROM doc_chunks
      GROUP BY collection
      ORDER BY collection
    `).all();
        return rows.map(r => ({
            collection: r['collection'],
            count: r['count'],
            sources: r['sources'],
            totalTokens: r['total_tokens'] ?? 0,
        }));
    }
    mapRow(r) {
        return {
            id: r['id'],
            collection: r['collection'],
            sectionPath: r['section_path'],
            depth: r['depth'],
            content: r['content'],
            tokenEstimate: r['token_estimate'],
            sourceHash: r['source_hash'],
            sourcePath: r['source_path'],
            scope: r['scope'],
            tier: r['tier'],
            agentId: r['agent_id'],
            parentPath: r['parent_path'],
            createdAt: r['created_at'],
            updatedAt: r['updated_at'],
        };
    }
}
//# sourceMappingURL=doc-chunk-store.js.map