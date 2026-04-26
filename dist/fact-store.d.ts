/**
 * hypermem Fact Store
 *
 * CRUD operations for facts (extracted knowledge that spans sessions).
 * Facts live in the central library DB, tagged by agent_id.
 * Facts have scope (agent/session/user), confidence, and decay.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Fact, FactScope } from './types.js';
export declare class FactStore {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Add a new fact. Checks for duplicates by content.
     */
    addFact(agentId: string, content: string, opts?: {
        scope?: FactScope;
        domain?: string;
        confidence?: number;
        visibility?: string;
        sourceType?: string;
        sourceSessionKey?: string;
        sourceRef?: string;
        expiresAt?: string;
    }): Fact;
    /**
     * Get active facts for an agent.
     */
    getActiveFacts(agentId: string, opts?: {
        scope?: FactScope;
        domain?: string;
        limit?: number;
        minConfidence?: number;
    }): Fact[];
    /**
     * Full-text search facts.
     */
    searchFacts(query: string, opts?: {
        agentId?: string;
        domain?: string;
        visibility?: string;
        limit?: number;
    }): Fact[];
    /**
     * Mark an old fact as superseded by a new one.
     *
     * Sets `superseded_by` on the old fact row so it is excluded from active
     * retrieval queries (both FTS and KNN paths check `superseded_by IS NULL`).
     * Returns false if the fact is already superseded or does not exist.
     */
    markSuperseded(oldFactId: number, newFactId: number): boolean;
    /**
     * Find the most recent active fact for an agent whose content is a near-duplicate
     * of the given content (same first 100 chars, different suffix, or same domain+topic).
     * Used by the background indexer to detect supersedes relationships.
     *
     * Returns the existing fact id if a candidate is found, otherwise null.
     */
    findSupersedableByContent(agentId: string, content: string, opts?: {
        domain?: string;
    }): number | null;
    /**
     * Decay all facts by a fixed rate.
     */
    decayFacts(agentId: string, decayRate?: number): number;
    /**
     * Remove expired and fully decayed facts.
     */
    pruneFacts(agentId: string): number;
    /**
     * Get fact count for an agent.
     */
    getFactCount(agentId: string): number;
    /**
     * Get facts that were valid at a specific point in time.
     * Returns facts where valid_from <= dateMs AND (invalid_at IS NULL OR invalid_at > dateMs).
     * This enables "what was true on date X?" queries (Zep-competitive).
     */
    getFactsValidAt(agentId: string, dateMs: number, opts?: {
        domain?: string;
        limit?: number;
    }): Fact[];
    /**
     * Mark a fact as invalid at a specific time (or now).
     * Unlike supersede, this doesn't require a replacement fact.
     * Used by contradiction detection to mark stale facts.
     */
    invalidateFact(factId: number, atDate?: string): boolean;
}
//# sourceMappingURL=fact-store.d.ts.map