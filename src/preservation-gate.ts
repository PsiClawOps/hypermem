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

import { generateEmbeddings, type EmbeddingConfig } from './vector-store.js';

// ─── Types ──────────────────────────────────────────────────────

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

const DEFAULT_PRESERVATION_CONFIG: PreservationConfig = {
  threshold: 0.65,
};

// ─── Math Utilities ─────────────────────────────────────────────

/**
 * Cosine similarity between two Float32Arrays.
 * Returns value in [-1, 1]. Handles zero-norm vectors gracefully (returns 0).
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

/**
 * Compute the centroid (element-wise mean) of an array of vectors.
 */
function computeCentroid(vectors: Float32Array[]): Float32Array {
  if (vectors.length === 0) {
    throw new Error('Cannot compute centroid of empty vector set');
  }

  const dim = vectors[0].length;
  const centroid = new Float32Array(dim);

  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += vec[i];
    }
  }

  const n = vectors.length;
  for (let i = 0; i < dim; i++) {
    centroid[i] /= n;
  }

  return centroid;
}

// ─── Preservation Gate ──────────────────────────────────────────

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
export function verifyPreservationFromVectors(
  summaryEmbedding: Float32Array,
  sourceEmbeddings: Float32Array[],
  config: Partial<PreservationConfig> = {}
): PreservationResult {
  const threshold = config.threshold ?? DEFAULT_PRESERVATION_CONFIG.threshold;

  if (sourceEmbeddings.length === 0) {
    return {
      alignment: 0,
      coverage: 0,
      score: 0,
      passed: false,
      threshold,
    };
  }

  // 1. Centroid alignment
  const centroid = computeCentroid(sourceEmbeddings);
  const alignment = cosineSimilarity(summaryEmbedding, centroid);

  // 2. Source coverage (average positive cosine similarity)
  let coverageSum = 0;
  for (const src of sourceEmbeddings) {
    coverageSum += Math.max(0, cosineSimilarity(summaryEmbedding, src));
  }
  const coverage = coverageSum / sourceEmbeddings.length;

  // 3. Combined score, clamped to [0, 1]
  const rawScore = (alignment + coverage) / 2;
  const score = Math.max(0, Math.min(1, rawScore));

  return {
    alignment,
    coverage,
    score,
    passed: score >= threshold,
    threshold,
  };
}

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
export async function verifyPreservation(
  summaryText: string,
  sourceTexts: string[],
  config: Partial<PreservationConfig> = {}
): Promise<PreservationResult> {
  const threshold = config.threshold ?? DEFAULT_PRESERVATION_CONFIG.threshold;

  if (sourceTexts.length === 0) {
    return {
      alignment: 0,
      coverage: 0,
      score: 0,
      passed: false,
      threshold,
    };
  }

  // Batch all texts into one embedding call for efficiency
  const allTexts = [summaryText, ...sourceTexts];
  const allEmbeddings = await generateEmbeddings(allTexts, config.embedding as EmbeddingConfig | undefined);

  const summaryEmbedding = allEmbeddings[0];
  const sourceEmbeddings = allEmbeddings.slice(1);

  return verifyPreservationFromVectors(summaryEmbedding, sourceEmbeddings, config);
}
