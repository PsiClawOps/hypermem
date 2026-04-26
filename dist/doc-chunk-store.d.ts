/**
 * hypermem Document Chunk Store
 *
 * Manages doc_chunks in library.db:
 * - Atomic re-indexing by source hash (no stale/fresh coexistence)
 * - FTS5 keyword search fallback
 * - Collection-scoped queries with agent/tier filtering
 * - Source tracking (what's indexed, when, what hash)
 */
import type { DatabaseSync } from 'node:sqlite';
import type { DocChunk } from './doc-chunker.js';
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
export declare class DocChunkStore {
    private db;
    constructor(db: DatabaseSync);
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
    indexChunks(chunks: DocChunk[]): IndexResult;
    /**
     * Query chunks by collection with optional filters.
     * Falls back to FTS5 keyword search when keyword is provided.
     */
    queryChunks(query: ChunkQuery): DocChunkRow[];
    /**
     * FTS5 keyword search across chunks.
     */
    keywordSearch(keyword: string, query: Omit<ChunkQuery, 'keyword'>): DocChunkRow[];
    /**
     * Get a single chunk by ID.
     */
    getChunk(id: string): DocChunkRow | null;
    /**
     * Check if a source file needs re-indexing.
     * Returns true if the file has changed or has never been indexed.
     */
    needsReindex(sourcePath: string, collection: string, currentHash: string): boolean;
    /**
     * List all indexed sources, optionally filtered by agent or collection.
     */
    listSources(opts?: {
        agentId?: string;
        collection?: string;
    }): DocSourceRow[];
    /**
     * Delete all chunks for a specific source file.
     */
    deleteSource(sourcePath: string, collection: string): number;
    /**
     * Remove doc chunks and source tracker rows whose source files no longer exist.
     *
     * This is intentionally limited by an optional source path prefix so workspace
     * seeding can clean its own stale rows without sweeping unrelated agents.
     * Rebuilds the external-content FTS table after deletes because this schema
     * does not install row-level FTS maintenance triggers.
     */
    garbageCollectMissingSources(opts?: {
        sourcePathPrefix?: string;
    }): GarbageCollectResult;
    /**
     * Index simple string chunks with an optional session key (for ephemeral spawn context).
     *
     * Unlike indexChunks() which works with DocChunk objects and hash-based dedup,
     * this method is designed for ad-hoc session-scoped content: it always inserts fresh
     * rows tagged with the sessionKey, without hash-based skip logic.
     *
     * Chunks stored with a sessionKey are ephemeral — use clearSessionChunks() to remove them.
     */
    indexDocChunks(agentId: string, source: string, chunks: string[], options?: {
        sessionKey?: string;
    }): void;
    /**
     * Query doc chunks by agentId+query string, with optional session key scoping.
     * When sessionKey is provided, only chunks tagged with that session key are returned.
     */
    queryDocChunks(agentId: string, query: string, options?: {
        sessionKey?: string;
        limit?: number;
    }): DocChunkRow[];
    /**
     * Delete all doc chunks associated with a specific session key.
     * Call this when a spawn session is complete to release ephemeral storage.
     */
    clearSessionChunks(sessionKey: string): number;
    /**
     * Get chunk stats: count per collection.
     */
    getStats(): Array<{
        collection: string;
        count: number;
        sources: number;
        totalTokens: number;
    }>;
    private mapRow;
}
//# sourceMappingURL=doc-chunk-store.d.ts.map