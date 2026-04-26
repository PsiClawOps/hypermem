/**
 * hypermem Topic Store
 *
 * Cross-session topic tracking. Topics are conversation threads that
 * can span multiple sessions and channels.
 * Lives in the central library DB.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Topic, TopicStatus } from './types.js';
export declare function normalizeTopicName(name: string): string;
export declare class TopicStore {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Create a new topic.
     */
    create(agentId: string, name: string, description?: string, visibility?: string): Topic;
    /**
     * Find an existing topic by name (case-insensitive) or create a new one.
     * Prevents duplicate topics for the same logical concept.
     */
    findOrCreate(agentId: string, rawName: string, description?: string, visibility?: string): Topic;
    /**
     * Touch a topic — update activity tracking.
     */
    touch(topicId: number, sessionKey: string, messagesDelta?: number): void;
    /**
     * Get active topics for an agent.
     */
    getActive(agentId: string, limit?: number): Topic[];
    /**
     * Get all topics for an agent.
     */
    getAll(agentId: string, opts?: {
        status?: TopicStatus;
        limit?: number;
    }): Topic[];
    /**
     * Find topics matching a query.
     */
    search(agentId: string, query: string, limit?: number): Topic[];
    /**
     * Mark dormant topics (no activity for dormantAfterHours).
     */
    markDormant(agentId: string, dormantAfterHours?: number): number;
    /**
     * Close dormant topics.
     */
    closeDormant(agentId: string, closedAfterDays?: number): number;
}
//# sourceMappingURL=topic-store.d.ts.map