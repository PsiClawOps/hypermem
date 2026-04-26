/**
 * SessionTopicMap (P3.3)
 *
 * Manages per-session topic state in messages.db.
 * Topics table: id(TEXT), session_key, name, created_at, last_active_at,
 *               message_count, metadata
 */
import { randomUUID } from 'node:crypto';
export class SessionTopicMap {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Get the active topic for a session (most recently active).
     */
    getActiveTopic(sessionKey) {
        const row = this.db.prepare(`
      SELECT id, name
      FROM topics
      WHERE session_key = ?
      ORDER BY last_active_at DESC
      LIMIT 1
    `).get(sessionKey);
        return row ?? null;
    }
    /**
     * Activate a topic: update last_active_at to now.
     */
    activateTopic(sessionKey, topicId) {
        this.db.prepare(`
      UPDATE topics
      SET last_active_at = ?
      WHERE id = ? AND session_key = ?
    `).run(Date.now(), topicId, sessionKey);
    }
    /**
     * Create a new topic and activate it. Returns the new topicId.
     */
    createTopic(sessionKey, name) {
        const id = randomUUID();
        const now = Date.now();
        this.db.prepare(`
      INSERT INTO topics (id, session_key, name, created_at, last_active_at, message_count, metadata)
      VALUES (?, ?, ?, ?, ?, 0, NULL)
    `).run(id, sessionKey, name.slice(0, 40), now, now);
        return id;
    }
    /**
     * List all topics for a session, ordered by last_active_at DESC.
     */
    listTopics(sessionKey) {
        const rows = this.db.prepare(`
      SELECT id, name, message_count, last_active_at
      FROM topics
      WHERE session_key = ?
      ORDER BY last_active_at DESC
    `).all(sessionKey);
        return rows.map(r => ({
            id: r.id,
            name: r.name,
            messageCount: r.message_count,
            lastActiveAt: r.last_active_at,
        }));
    }
    /**
     * Increment message count for the given topic.
     */
    incrementMessageCount(topicId) {
        this.db.prepare(`
      UPDATE topics
      SET message_count = message_count + 1
      WHERE id = ?
    `).run(topicId);
    }
}
//# sourceMappingURL=session-topic-map.js.map