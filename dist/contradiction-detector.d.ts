/**
 * Contradiction Detector — heuristic-based contradiction detection for the fact store.
 *
 * Detects when a newly ingested fact contradicts existing active facts using
 * vector similarity (when available) and FTS candidate retrieval, scored by
 * pattern-based heuristics (negation, numeric conflict, state conflict, temporal).
 *
 * No LLM calls — v1 is purely heuristic. LLM-enhanced scoring is a future item.
 */
import type { FactStore } from './fact-store.js';
import type { VectorStore } from './vector-store.js';
export interface ContradictionCandidate {
    existingFactId: number;
    existingContent: string;
    similarityScore: number;
    contradictionScore: number;
    reason: string;
}
export interface ContradictionResult {
    contradictions: ContradictionCandidate[];
    autoResolved: boolean;
    resolvedCount: number;
}
export interface ContradictionDetectorConfig {
    /** Minimum similarity to consider as candidate. Default: 0.6 */
    minSimilarity?: number;
    /** Minimum contradiction score for auto-resolution. Default: 0.85 */
    autoResolveThreshold?: number;
    /** Max candidates to evaluate per ingest. Default: 10 */
    maxCandidates?: number;
    /** Enable auto-resolution. Default: true */
    autoResolve?: boolean;
}
export declare class ContradictionDetector {
    private readonly factStore;
    private readonly vectorStore?;
    private readonly config;
    constructor(factStore: FactStore, vectorStore?: VectorStore | undefined, config?: ContradictionDetectorConfig);
    /**
     * On fact ingest, check if the new fact contradicts existing active facts.
     * Uses vector similarity (when available) + FTS to find candidates, then
     * scores each candidate with heuristic contradiction checks.
     */
    detectOnIngest(agentId: string, newFact: {
        content: string;
        domain?: string;
    }): Promise<ContradictionResult>;
    /**
     * Resolve a detected contradiction between an existing fact and a new fact.
     */
    resolveContradiction(oldFactId: number, newFactId: number, resolution: 'supersede' | 'keep-both' | 'reject-new'): void;
    /**
     * Auto-resolve high-confidence contradictions: newer supersedes older.
     * Only resolves candidates above the autoResolveThreshold.
     *
     * @param agentId - The agent whose facts are being resolved (for audit trail)
     * @param candidates - Scored contradiction candidates from detectOnIngest
     * @returns Count of auto-resolved contradictions
     */
    autoResolve(_agentId: string, candidates: ContradictionCandidate[]): Promise<number>;
    /**
     * Find candidate facts that might contradict the new fact.
     * Uses vector search (if available) and FTS, deduplicates, and returns
     * up to maxCandidates results above minSimilarity.
     */
    private findCandidates;
    /**
     * Score a candidate fact against the new fact content for contradiction.
     * Returns a ContradictionCandidate if any heuristic fires, null otherwise.
     */
    private scoreContradiction;
    /**
     * Compute Jaccard-like token overlap between two texts.
     * Returns 0-1 where 1 means identical token sets.
     */
    private tokenOverlapSimilarity;
}
//# sourceMappingURL=contradiction-detector.d.ts.map