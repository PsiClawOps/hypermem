/**
 * hypermem Expertise Store
 *
 * Stores domain expertise patterns — learned behaviors that make the Nth run
 * better than the 1st. Two-phase lifecycle:
 *   1. Observations: raw learnings logged from conversations, pipelines, reviews
 *   2. Patterns: graduated observations with N≥3 confirming instances
 *
 * Patterns are agent-scoped but domain-tagged, enabling cross-agent queries.
 * Patterns have confidence, frequency tracking, and decay on counter-evidence.
 */
import type { DatabaseSync } from 'node:sqlite';
export interface ExpertiseObservation {
    id: number;
    agentId: string;
    domain: string;
    context: string | null;
    observationText: string;
    sourceType: 'conversation' | 'pipeline' | 'review' | 'manual';
    sourceRef: string | null;
    createdAt: string;
}
export interface ExpertisePattern {
    id: number;
    agentId: string;
    domain: string;
    patternText: string;
    confidence: number;
    frequency: number;
    firstSeen: string;
    lastConfirmed: string;
    invalidatedAt: string | null;
    invalidationReason: string | null;
    decayScore: number;
}
export interface ExpertiseEvidence {
    observationId: number;
    patternId: number;
    relationship: 'confirms' | 'contradicts';
    createdAt: string;
}
export declare class ExpertiseStore {
    private readonly db;
    private readonly graduationThreshold;
    constructor(db: DatabaseSync, graduationThreshold?: number);
    /**
     * Record a raw observation from any source.
     */
    record(agentId: string, observationText: string, domain: string, opts?: {
        context?: string;
        sourceType?: ExpertiseObservation['sourceType'];
        sourceRef?: string;
    }): ExpertiseObservation;
    /**
     * Get observations for an agent, optionally filtered by domain.
     */
    getObservations(agentId: string, opts?: {
        domain?: string;
        limit?: number;
    }): ExpertiseObservation[];
    /**
     * Retrieve active expertise patterns for current work context.
     * Returns patterns sorted by confidence DESC, frequency DESC.
     * Excludes invalidated patterns by default.
     */
    query(agentId: string, domain: string, opts?: {
        context?: string;
        includeInvalidated?: boolean;
        limit?: number;
        minConfidence?: number;
    }): ExpertisePattern[];
    /**
     * Cross-agent query: get patterns from any agent in a given domain.
     * Useful for fleet-wide expertise ("what has any agent learned about X?").
     */
    queryFleet(domain: string, opts?: {
        limit?: number;
        minConfidence?: number;
    }): ExpertisePattern[];
    /**
     * Graduate an observation to a pattern.
     *
     * If a similar pattern already exists (same agent, domain, and pattern text prefix match),
     * increments its frequency and updates lastConfirmed instead of creating a duplicate.
     *
     * Auto-graduation happens when an observation has N≥graduationThreshold confirming
     * evidence links. Can also be called manually.
     */
    graduate(agentId: string, observationId: number, opts?: {
        patternText?: string;
        confidence?: number;
    }): ExpertisePattern | null;
    /**
     * Record evidence linking an observation to a pattern.
     * If this pushes a pattern's contradicting evidence past threshold,
     * auto-invalidates the pattern.
     */
    addEvidence(observationId: number, patternId: number, relationship: 'confirms' | 'contradicts'): void;
    /**
     * Check if any observations are ready for auto-graduation.
     * An observation graduates when it has N≥threshold confirming evidence links.
     * Returns the number of newly graduated patterns.
     */
    autoGraduate(agentId: string): number;
    /**
     * Mark a pattern as invalidated.
     */
    invalidate(patternId: number, reason: string): boolean;
    /**
     * List all active patterns for an agent, optionally filtered by domain.
     */
    list(agentId: string, opts?: {
        domain?: string;
        includeInvalidated?: boolean;
    }): ExpertisePattern[];
    /**
     * Decay all patterns by a fixed rate. Similar to fact decay.
     */
    decayPatterns(agentId: string, decayRate?: number): number;
    /**
     * Get pattern and observation counts for an agent.
     */
    getStats(agentId: string): {
        observations: number;
        activePatterns: number;
        invalidatedPatterns: number;
    };
}
//# sourceMappingURL=expertise-store.d.ts.map