/**
 * hypermem Hybrid Retrieval — FTS5 + KNN Score Fusion
 *
 * Merges keyword (FTS5/BM25) and semantic (KNN/vector) results into a
 * single ranked list using Reciprocal Rank Fusion (RRF). This avoids
 * vocabulary mismatch (KNN-only misses exact terms) and semantic gap
 * (FTS5-only misses paraphrases).
 *
 * Architecture:
 *   - FTS5 results from library.db (facts_fts, knowledge_fts, episodes_fts)
 *   - KNN results from vectors.db via VectorStore
 *   - RRF merges both ranked lists with configurable k constant
 *   - Deduplication by (sourceTable, sourceId)
 *   - Token-budgeted output for compositor consumption
 */
import type { DatabaseSync } from 'node:sqlite';
import type { VectorStore } from './vector-store.js';
import type { RerankerProvider } from './reranker.js';
export type RerankerStatus = 'applied' | 'bypass_no_provider' | 'bypass_below_threshold' | 'failed' | 'timeout';
export interface RerankerTelemetry {
    /** Provider name (e.g. 'zeroentropy', 'openrouter', 'ollama') or null when no provider. */
    provider: string | null;
    /** Number of fused candidates seen by the reranker hook. */
    candidates: number;
    /** Outcome for this invocation. */
    status: RerankerStatus;
}
export interface HybridSearchResult {
    sourceTable: string;
    sourceId: number;
    content: string;
    domain?: string;
    agentId?: string;
    metadata?: string;
    /** ISO timestamp from source row — used for recency decay (TUNE-015) */
    createdAt?: string;
    /** Combined RRF score (higher = more relevant) */
    score: number;
    /** Which retrieval paths contributed */
    sources: ('fts' | 'knn')[];
}
export interface HybridSearchOptions {
    /** Content types to search. Default: ['facts', 'knowledge', 'episodes'] */
    tables?: string[];
    /** Max results to return. Default: 10 */
    limit?: number;
    /** Max KNN distance (filters low-quality vectors). Default: 1.2 */
    maxKnnDistance?: number;
    /** RRF k constant. Higher = less weight to top ranks. Default: 60 */
    rrfK?: number;
    /** Agent ID filter for FTS queries */
    agentId?: string;
    /** Weight for FTS results in fusion. Default: 1.0 */
    ftsWeight?: number;
    /** Weight for KNN results in fusion. Default: 1.0 */
    knnWeight?: number;
    /** Minimum number of FTS terms to attempt a query (skip if fewer). Default: 1 */
    minFtsTerms?: number;
    /** Pre-computed embedding for the query — skips Ollama call in VectorStore.search() */
    precomputedEmbedding?: Float32Array;
    /**
     * Optional reranker applied after RRF fusion. Only runs on the fused path
     * (both FTS and KNN produced results). FTS-only and KNN-only branches are
     * unchanged. Null/undefined disables reranking.
     */
    reranker?: RerankerProvider | null;
    /**
     * Minimum fused-candidate count required to invoke the reranker.
     * Below this, the reranker is bypassed and original RRF order is returned.
     * Default: 2.
     */
    rerankerMinCandidates?: number;
    /**
     * Max documents sent to the reranker. Clamps provider cost when the fused
     * candidate list is large. Defaults to fused.length (all candidates).
     */
    rerankerMaxDocuments?: number;
    /** Top-K passed to the reranker. Defaults to the sliced candidate count. */
    rerankerTopK?: number;
    /**
     * External guard timeout for the reranker call in ms. Provider timeouts are
     * enforced inside each RerankerProvider; this is a belt-and-suspenders
     * ceiling that also distinguishes 'timeout' from 'failed' in telemetry.
     * Default: 3000.
     */
    rerankerTimeoutMs?: number;
    /** Optional telemetry sink. When omitted, falls back to emitRerankerLog. */
    onRerankerTelemetry?: (ev: RerankerTelemetry) => void;
}
/**
 * Build an FTS5 query from a natural language string.
 * Extracts meaningful words, removes stop words, uses OR conjunction.
 */
export declare function buildFtsQuery(input: string): string;
/**
 * Hybrid search combining FTS5 keyword search and KNN vector search.
 *
 * When vectorStore is null, falls back to FTS5-only.
 * When FTS5 query is empty (all stop words), falls back to KNN-only.
 */
export declare function hybridSearch(libraryDb: DatabaseSync, vectorStore: VectorStore | null, query: string, opts?: HybridSearchOptions): Promise<HybridSearchResult[]>;
//# sourceMappingURL=hybrid-retrieval.d.ts.map