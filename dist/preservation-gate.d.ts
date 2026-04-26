/**
 * hypermem Preservation Gate
 *
 * Verifies that a proposed compaction summary preserves the semantic
 * content of its source messages by measuring geometric fidelity in
 * embedding space.
 *
 * Before a summary replaces raw messages, it must pass two checks:
 *
 *   1. Centroid Alignment — the summary embedding must be close to the
 *      centroid of the source message embeddings (cos similarity).
 *
 *   2. Source Coverage — the summary must have positive cosine similarity
 *      with each individual source message (averaged).
 *
 * If the combined preservation score falls below the threshold, the
 * summary is rejected. The caller should fall back to extractive
 * compaction (concatenation/selection) rather than accepting a
 * semantically drifted summary.
 *
 * This prevents the silent failure mode where a confident summarizer
 * produces fluent text that has drifted away from the original meaning
 * in vector space — making it unretrievable by the very system that
 * will later search for it.
 *
 * Inspired by the Nomic-space preservation gate in openclaw-memory-libravdb
 * (mathematics-v2.md §5.3), adapted for our Ollama + sqlite-vec stack.
 */
import { type EmbeddingConfig } from './vector-store.js';
export interface PreservationResult {
    /** Cosine similarity between summary and source centroid */
    alignment: number;
    /** Average positive cosine similarity between summary and each source */
    coverage: number;
    /** Combined score: (alignment + coverage) / 2, clamped to [0, 1] */
    score: number;
    /** Whether the summary passed the preservation gate */
    passed: boolean;
    /** The threshold used for the gate */
    threshold: number;
}
export interface PreservationConfig {
    /**
     * Minimum combined preservation score for a summary to be accepted.
     * Default: 0.65 (same as libravdb's shipped default).
     *
     * At 0.65, the summary must be meaningfully close to the source cluster.
     * Lower values accept more drift; higher values are stricter.
     * Range: [0, 1].
     */
    threshold: number;
    /** Embedding config for Ollama calls (used by async path only) */
    embedding?: Partial<EmbeddingConfig>;
}
/**
 * Verify that a summary preserves its source content in embedding space.
 *
 * SYNCHRONOUS PATH — for when you already have pre-computed embeddings
 * (e.g., from the background indexer or vector store cache).
 *
 * This is the preferred path: no network calls, no async, deterministic.
 *
 * @param summaryEmbedding - The embedding of the proposed summary
 * @param sourceEmbeddings - Embeddings of the source messages being replaced
 * @param config - Preservation threshold config
 */
export declare function verifyPreservationFromVectors(summaryEmbedding: Float32Array, sourceEmbeddings: Float32Array[], config?: Partial<PreservationConfig>): PreservationResult;
/**
 * Verify that a summary preserves its source content in embedding space.
 *
 * ASYNC PATH — generates embeddings via Ollama on demand.
 * Use when pre-computed embeddings aren't available.
 *
 * This makes N+1 embedding calls (1 for summary, N for sources if not cached).
 * For batch compaction, prefer pre-computing embeddings and using the sync path.
 *
 * @param summaryText - The proposed summary text
 * @param sourceTexts - The source message texts being replaced
 * @param config - Preservation threshold and embedding config
 */
export declare function verifyPreservation(summaryText: string, sourceTexts: string[], config?: Partial<PreservationConfig>): Promise<PreservationResult>;
//# sourceMappingURL=preservation-gate.d.ts.map