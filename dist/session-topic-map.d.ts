/**
 * SessionTopicMap (P3.3)
 *
 * Manages per-session topic state in messages.db.
 * Topics table: id(TEXT), session_key, name, created_at, last_active_at,
 *               message_count, metadata
 */
import type { DatabaseSync } from 'node:sqlite';
export declare class SessionTopicMap {
    private db;
    constructor(db: DatabaseSync);
    /**
     * Get the active topic for a session (most recently active).
     */
    getActiveTopic(sessionKey: string): {
        id: string;
        name: string;
    } | null;
    /**
     * Activate a topic: update last_active_at to now.
     */
    activateTopic(sessionKey: string, topicId: string): void;
    /**
     * Create a new topic and activate it. Returns the new topicId.
     */
    createTopic(sessionKey: string, name: string): string;
    /**
     * List all topics for a session, ordered by last_active_at DESC.
     */
    listTopics(sessionKey: string): Array<{
        id: string;
        name: string;
        messageCount: number;
        lastActiveAt: number;
    }>;
    /**
     * Increment message count for the given topic.
     */
    incrementMessageCount(topicId: string): void;
}
//# sourceMappingURL=session-topic-map.d.ts.map