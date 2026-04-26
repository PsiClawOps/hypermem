/**
 * hypermem Topic Store
 *
 * Cross-session topic tracking. Topics are conversation threads that
 * can span multiple sessions and channels.
 * Lives in the central library DB.
 */
/**
 * Normalize a topic name for dedup purposes.
 * Preserves casing of known product names; lowercases everything else.
 */
const KNOWN_NAMES = {
    hypermem: 'HyperMem',
    hyperbuilder: 'HyperBuilder',
    canvas: 'canvas',
    dashboard: 'dashboard',
    dispatch: 'dispatch',
    clawtext: 'ClawText',
    automation: 'automation',
    council: 'council',
    openclaw: 'OpenClaw',
    clawhub: 'ClawHub',
};
export function normalizeTopicName(name) {
    const lower = name.trim().toLowerCase();
    return KNOWN_NAMES[lower] ?? name.trim();
}
function nowIso() {
    return new Date().toISOString();
}
function parseTopicRow(row) {
    return {
        id: row.id,
        agentId: row.agent_id,
        name: row.name,
        description: row.description || null,
        status: row.status,
        visibility: row.visibility || 'org',
        lastSessionKey: row.last_session_key || null,
        messageCount: row.message_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
export class TopicStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Create a new topic.
     */
    create(agentId, name, description, visibility) {
        const now = nowIso();
        const result = this.db.prepare(`
      INSERT INTO topics (agent_id, name, description, status, visibility, message_count, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, 0, ?, ?)
    `).run(agentId, name, description || null, visibility || 'org', now, now);
        const id = Number(result.lastInsertRowid);
        return {
            id,
            agentId,
            name,
            description: description || null,
            status: 'active',
            visibility: visibility || 'org',
            lastSessionKey: null,
            messageCount: 0,
            createdAt: now,
            updatedAt: now,
        };
    }
    /**
     * Find an existing topic by name (case-insensitive) or create a new one.
     * Prevents duplicate topics for the same logical concept.
     */
    findOrCreate(agentId, rawName, description, visibility) {
        const name = normalizeTopicName(rawName);
        const existing = this.db.prepare(`
      SELECT * FROM topics
      WHERE agent_id = ?
        AND lower(name) = lower(?)
        AND status != 'closed'
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(agentId, name);
        if (existing) {
            return parseTopicRow(existing);
        }
        return this.create(agentId, name, description, visibility);
    }
    /**
     * Touch a topic — update activity tracking.
     */
    touch(topicId, sessionKey, messagesDelta = 1) {
        const now = nowIso();
        this.db.prepare(`
      UPDATE topics
      SET last_session_key = ?,
          message_count = message_count + ?,
          status = 'active',
          updated_at = ?
      WHERE id = ?
    `).run(sessionKey, messagesDelta, now, topicId);
    }
    /**
     * Get active topics for an agent.
     */
    getActive(agentId, limit = 20) {
        const rows = this.db.prepare(`
      SELECT * FROM topics
      WHERE agent_id = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(agentId, limit);
        return rows.map(parseTopicRow);
    }
    /**
     * Get all topics for an agent.
     */
    getAll(agentId, opts) {
        let sql = 'SELECT * FROM topics WHERE agent_id = ?';
        const params = [agentId];
        if (opts?.status) {
            sql += ' AND status = ?';
            params.push(opts.status);
        }
        sql += ' ORDER BY updated_at DESC';
        if (opts?.limit) {
            sql += ' LIMIT ?';
            params.push(opts.limit);
        }
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseTopicRow);
    }
    /**
     * Find topics matching a query.
     */
    search(agentId, query, limit = 10) {
        const rows = this.db.prepare(`
      SELECT * FROM topics
      WHERE agent_id = ?
      AND (name LIKE ? OR description LIKE ?)
      AND status != 'closed'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(agentId, `%${query}%`, `%${query}%`, limit);
        return rows.map(parseTopicRow);
    }
    /**
     * Mark dormant topics (no activity for dormantAfterHours).
     */
    markDormant(agentId, dormantAfterHours = 24) {
        const cutoff = new Date(Date.now() - dormantAfterHours * 60 * 60 * 1000).toISOString();
        const result = this.db.prepare(`
      UPDATE topics
      SET status = 'dormant', updated_at = ?
      WHERE agent_id = ? AND status = 'active' AND updated_at < ?
    `).run(nowIso(), agentId, cutoff);
        return result.changes;
    }
    /**
     * Close dormant topics.
     */
    closeDormant(agentId, closedAfterDays = 7) {
        const cutoff = new Date(Date.now() - closedAfterDays * 24 * 60 * 60 * 1000).toISOString();
        const result = this.db.prepare(`
      UPDATE topics
      SET status = 'closed', updated_at = ?
      WHERE agent_id = ? AND status = 'dormant' AND updated_at < ?
    `).run(nowIso(), agentId, cutoff);
        return result.changes;
    }
}
//# sourceMappingURL=topic-store.js.map