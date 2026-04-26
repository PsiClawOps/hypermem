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
import type { DatabaseSync } from 'node:sqlite';
export interface EmbeddingConfig {
    /**
     * Embedding provider. Default: 'ollama'.
     * - 'none': disable all embedding calls — semantic search disabled, FTS5 fallback only
     * - 'ollama': local Ollama instance (nomic-embed-text or any pull'd model)
     * - 'openai': OpenAI Embeddings API (text-embedding-3-small / 3-large)
     * - 'gemini': Google Gemini Embedding API (gemini-embedding-2-preview)
     */
    provider?: 'none' | 'ollama' | 'openai' | 'gemini';
    /** Ollama base URL. Default: http://localhost:11434 */
    ollamaUrl: string;
    /** OpenAI API key. Required when provider is 'openai'. */
    openaiApiKey?: string;
    /** OpenAI base URL. Default: https://api.openai.com/v1 */
    openaiBaseUrl?: string;
    /** Gemini API key. Alternative to OAuth — passed as ?key= query param. */
    geminiApiKey?: string;
    /** Gemini API base URL. Default: https://generativelanguage.googleapis.com */
    geminiBaseUrl?: string;
    /** Gemini task type for indexing. Default: RETRIEVAL_DOCUMENT */
    geminiIndexTaskType?: string;
    /** Gemini task type for queries. Default: RETRIEVAL_QUERY */
    geminiQueryTaskType?: string;
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
/**
 * Clear the embedding cache. Primarily for testing.
 */
export declare function clearEmbeddingCache(): void;
/**
 * Generate embeddings via Ollama API.
 * Supports single and batch embedding.
 * Results are cached per text hash — cache hits skip the Ollama call entirely.
 */
export declare function generateEmbeddings(texts: string[], config?: EmbeddingConfig): Promise<Float32Array[]>;
/**
 * VectorStore — manages vector indexes in an agent's vector database.
 *
 * The vector DB (vectors.db) stores vec0 virtual tables and the index map.
 * Source content (facts, knowledge, episodes) lives in the library DB.
 * The VectorStore needs both: vectorDb for indexes, libraryDb for content.
 */
export declare class VectorStore {
    private readonly db;
    private readonly libraryDb;
    private readonly config;
    constructor(db: DatabaseSync, config?: Partial<EmbeddingConfig>, libraryDb?: DatabaseSync);
    /**
     * Create vector index tables if they don't exist.
     * Safe to call multiple times (idempotent).
     */
    ensureTables(): void;
    /**
     * Index a single content item. Generates embedding and stores in vec table.
     * Skips if content hasn't changed (based on hash).
     */
    /** Allowlisted source tables for vector indexing. Prevents SQL injection via table name interpolation. */
    private static readonly ALLOWED_SOURCE_TABLES;
    private validateSourceTable;
    indexItem(sourceTable: string, sourceId: number, content: string, domain?: string): Promise<boolean>;
    /**
     * Batch index multiple items. More efficient than individual calls.
     */
    indexBatch(items: Array<{
        sourceTable: string;
        sourceId: number;
        content: string;
        domain?: string;
    }>): Promise<{
        indexed: number;
        skipped: number;
    }>;
    /**
     * Semantic KNN search across one or all vector tables.
     *
     * @param precomputedEmbedding — optional pre-computed embedding for the query.
     *   When provided, skips the Ollama call entirely. The precomputed embedding
     *   is still inserted into the LRU cache so subsequent identical queries hit.
     */
    search(query: string, opts?: {
        tables?: string[];
        limit?: number;
        maxDistance?: number;
        precomputedEmbedding?: Float32Array;
    }): Promise<VectorSearchResult[]>;
    /**
     * Get content from a source table by id.
     */
    private getSourceContent;
    /**
     * Index all un-indexed content in the agent's database.
     * Called by the background indexer.
     */
    indexAll(agentId: string): Promise<{
        indexed: number;
        skipped: number;
    }>;
    /**
     * Remove vector index entries for deleted source rows.
     */
    pruneOrphans(): number;
    /**
     * Remove the vector index entry for a single source item.
     *
     * Deletes both the vec table row and the vec_index_map entry for the given
     * (sourceTable, sourceId) pair. Used by the background indexer for immediate
     * point-in-time removal when a supersedes relationship is detected.
     *
     * @returns true if an entry was found and removed, false if nothing was indexed.
     */
    removeItem(sourceTable: string, sourceId: number): boolean;
    /**
     * Check whether a source item already has a vector in the index.
     * Used by the episode backfill to skip already-vectorized entries.
     */
    hasItem(sourceTable: string, sourceId: number): boolean;
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
    tombstoneSuperseded(): number;
    /**
     * Get index statistics.
     */
    getStats(): VectorIndexStats;
}
/**
 * Create vector tables in a library database for session registry search.
 */
export declare function ensureSessionVecTable(db: DatabaseSync, dimensions?: number): void;
//# sourceMappingURL=vector-store.d.ts.map