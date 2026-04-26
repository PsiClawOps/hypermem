/**
 * hypermem Temporal Store
 *
 * Time-range retrieval over indexed facts. Uses the temporal_index table
 * in library.db to answer LoCoMo-style temporal questions:
 *   "What happened before X?"
 *   "What changed between January and March?"
 *   "What was the most recent thing about Y?"
 *
 * occurred_at is initially populated from created_at (ingest time as proxy,
 * confidence=0.5). Future: date extraction from fact text (confidence=0.9).
 *
 * Query path: SQL time-range filter on temporal_index JOIN facts.
 * No vector search involved — purely temporal ordering.
 */
import type { DatabaseSync } from 'node:sqlite';
export interface TemporalFact {
    factId: number;
    agentId: string;
    content: string;
    domain: string | null;
    occurredAt: number;
    ingestAt: number;
    timeRef: string | null;
    confidence: number;
}
export interface TemporalQueryOptions {
    /** Start of time range (unix ms). Omit for open-ended. */
    fromMs?: number;
    /** End of time range (unix ms). Omit for open-ended. */
    toMs?: number;
    /** Only return facts from this agent. */
    agentId?: string;
    /** Only return facts with this domain. */
    domain?: string;
    /** Sort order. Default: DESC (most recent first). */
    order?: 'ASC' | 'DESC';
    /** Max results. Default: 20. */
    limit?: number;
    /** Minimum confidence on temporal placement. Default: 0. */
    minConfidence?: number;
}
/**
 * Returns true if the query string contains temporal signals.
 */
export declare function hasTemporalSignals(query: string): boolean;
export declare class TemporalStore {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Index a newly created or updated fact into temporal_index.
     * Uses created_at as occurred_at proxy (confidence=0.5).
     * Safe to call multiple times — uses INSERT OR REPLACE.
     */
    indexFact(factId: number, agentId: string, createdAt: string, opts?: {
        timeRef?: string;
        confidence?: number;
        occurredAt?: number;
        validFrom?: string;
    }): void;
    /**
     * Time-range query. Returns facts in temporal order.
     * Joins temporal_index with facts to get content.
     */
    timeRangeQuery(opts?: TemporalQueryOptions): TemporalFact[];
    /**
     * Get the most recent N facts for an agent (no time bounds).
     * Useful for "what was the last thing about X" style queries.
     */
    mostRecent(agentId: string, limit?: number): TemporalFact[];
    /**
     * Get fact count in the temporal index for an agent.
     */
    getIndexedCount(agentId: string): number;
    /**
     * Backfill any facts not yet in the temporal index.
     * Safe to run multiple times. Uses INSERT OR IGNORE.
     */
    backfill(): number;
}
//# sourceMappingURL=temporal-store.d.ts.map