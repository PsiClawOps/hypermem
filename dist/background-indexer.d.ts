/**
 * hypermem Background Indexer
 *
 * Processes message history to extract structured knowledge:
 *   - Facts: atomic pieces of learned information
 *   - Episodes: significant events worth remembering
 *   - Topics: conversation threads and their lifecycle
 *   - Knowledge: durable structured entries (domain + key)
 *
 * Runs as a periodic background task, processing unindexed messages
 * in batches. Each batch is scored, classified, and stored in L4 (library.db).
 *
 * Design principles:
 *   - No LLM dependency: extraction uses pattern matching + heuristics
 *   - Idempotent: tracks watermarks per agent to avoid reprocessing
 *   - Bounded: processes N messages per tick to avoid blocking
 *   - Observable: logs extraction stats for monitoring
 */
import type { DatabaseSync } from 'node:sqlite';
import type { IndexerConfig, SessionCursor, MaintenanceTickDiagnostics } from './types.js';
import { type DreamerConfig } from './dreaming-promoter.js';
import { type ContradictionResolutionPolicy } from './contradiction-resolution-policy.js';
import type { VectorStore } from './vector-store.js';
export interface IndexerStats {
    agentId: string;
    messagesProcessed: number;
    factsExtracted: number;
    episodesRecorded: number;
    topicsUpdated: number;
    knowledgeUpserted: number;
    /** Number of superseded fact vectors tombstoned from the vector index this tick. */
    tombstoned: number;
    /** Number of contradiction audits recorded for review this tick. */
    contradictionAuditsLogged: number;
    /** Number of old facts auto-superseded via contradiction policy this tick. */
    contradictionsAutoSuperseded: number;
    /** Number of old facts auto-invalidated via contradiction policy this tick. */
    contradictionsAutoInvalidated: number;
    elapsedMs: number;
    /** Number of messages that were post-cursor (unseen by model, high-signal priority). */
    postCursorMessages: number;
}
/**
 * Optional callback to fetch the session cursor for an agent+session.
 * When provided, the indexer uses the cursor to prioritize unseen messages.
 * The cursor boundary separates "model has seen this" from "new since last compose".
 */
export type CursorFetcher = (agentId: string, sessionKey: string) => Promise<SessionCursor | null>;
export interface WatermarkState {
    agentId: string;
    lastMessageId: number;
    lastRunAt: string;
}
export declare class BackgroundIndexer {
    private getMessageDb?;
    private getLibraryDb?;
    private listAgents?;
    private getCursor?;
    private readonly config;
    private readonly dreamerConfig;
    private readonly globalWritePolicy;
    private readonly contradictionPolicy;
    private intervalHandle;
    private running;
    private vectorStore;
    private synthesizer;
    private tickCount;
    /** Circuit breaker: consecutive tick failure count. Resets on success. */
    private consecutiveFailures;
    /** True when the indexer is running in backoff mode due to repeated failures. */
    private inBackoff;
    private readonly _conversationLastProcessed;
    lastMaintenanceDiagnostics: MaintenanceTickDiagnostics | null;
    constructor(config?: Partial<IndexerConfig>, getMessageDb?: ((agentId: string) => DatabaseSync) | undefined, getLibraryDb?: (() => DatabaseSync) | undefined, listAgents?: (() => string[]) | undefined, getCursor?: CursorFetcher | undefined, dreamerConfig?: Partial<DreamerConfig>, globalWritePolicy?: import('./types.js').GlobalWritePolicy, contradictionPolicy?: ContradictionResolutionPolicy);
    /**
     * Set the vector store for embedding new facts/episodes at index time.
     * Optional — if not set, indexer runs without embedding (FTS5-only mode).
     */
    setVectorStore(vs: VectorStore): void;
    /**
     * Start periodic indexing.
     */
    start(): void;
    /**
     * Circuit breaker for tick failures.
     *
     * - Tracks consecutive failures.
     * - After 3 failures, logs actionable recovery guidance once, then switches
     *   the indexer to 10× backoff interval so it stops spamming the log.
     * - On the next successful tick, resets state and restores normal interval.
     */
    private _handleTickError;
    /**
     * Reset the circuit breaker and restore normal interval after a successful tick.
     * Called at the end of a successful tick().
     */
    private _resetCircuitBreaker;
    /**
     * Stop periodic indexing.
     */
    stop(): void;
    /**
     * Run one indexing pass across all agents.
     */
    tick(): Promise<IndexerStats[]>;
    /**
     * Process a single agent's unindexed messages.
     *
     * When a cursor fetcher is available, messages are split into two tiers:
     *   - Post-cursor (id > cursor.lastSentId): "unseen" by the model, high-signal priority
     *   - Pre-cursor (id <= cursor.lastSentId): already in the model's context window, lower priority
     * Post-cursor messages are processed first. This ensures the indexer prioritizes
     * content the model hasn't seen yet — decisions, incidents, and discoveries that
     * happened between context windows.
     */
    private processAgent;
    /**
     * Fetch unindexed messages for an agent.
     */
    private getUnindexedMessages;
    /**
     * Get the session key for a conversation ID.
     */
    private getSessionKeyForMessage;
    /**
     * Get the indexing watermark for an agent.
     */
    private getWatermark;
    /**
     * Set the indexing watermark for an agent.
     */
    private setWatermark;
    /**
     * Apply time-based decay to facts.
     * Increases decay_score for older facts, making them less relevant.
     */
    private applyDecay;
    /**
     * Parse a duration string like "24h", "7d" into seconds.
     */
    private parseDuration;
    /**
     * One-time backfill: embed episodes with sig>=0.5 that were missed by the
     * old >=0.7 vectorization threshold.
     *
     * Gated by a system_state flag 'indexer:episode_backfill_v1' so it runs
     * exactly once even across gateway restarts. Safe to re-run manually
     * (delete the flag row first) if re-backfill is ever needed.
     */
    backfillEpisodeVectors(): Promise<void>;
    /**
     * Get current watermarks for all agents.
     */
    getWatermarks(libraryDb: DatabaseSync): WatermarkState[];
}
/**
 * Create and start a background indexer connected to hypermem databases.
 * Used by the hook or a standalone daemon.
 */
export declare function createIndexer(getMessageDb: (agentId: string) => DatabaseSync, getLibraryDb: () => DatabaseSync, listAgents: () => string[], config?: Partial<IndexerConfig>, getCursor?: CursorFetcher, vectorStore?: VectorStore, dreamerConfig?: Partial<DreamerConfig>, globalWritePolicy?: import('./types.js').GlobalWritePolicy): BackgroundIndexer;
//# sourceMappingURL=background-indexer.d.ts.map