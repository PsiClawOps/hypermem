/**
 * hypermem Episode Store
 *
 * Significant events in an agent's lifetime.
 * Lives in the central library DB.
 * Replaces daily log files with structured, queryable episodes.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Episode, EpisodeType } from './types.js';
export declare class EpisodeStore {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Record a new episode.
     */
    record(agentId: string, eventType: EpisodeType, summary: string, opts?: {
        significance?: number;
        visibility?: string;
        participants?: string[];
        sessionKey?: string;
        sourceMessageId?: number;
    }): Episode;
    /**
     * Get recent episodes for an agent.
     */
    getRecent(agentId: string, opts?: {
        eventType?: EpisodeType;
        minSignificance?: number;
        limit?: number;
        since?: string;
    }): Episode[];
    /**
     * Get the most significant episodes (across all time).
     */
    getMostSignificant(agentId: string, limit?: number): Episode[];
    /**
     * Decay all episodes.
     */
    decay(agentId: string, decayRate?: number): number;
    /**
     * Prune fully decayed episodes.
     */
    prune(agentId: string): number;
    /**
     * Get episode summary for a time range.
     */
    getDailySummary(agentId: string, date: string): Episode[];
}
//# sourceMappingURL=episode-store.d.ts.map