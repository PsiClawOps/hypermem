/**
 * hypermem Episode Store
 *
 * Significant events in an agent's lifetime.
 * Lives in the central library DB.
 * Replaces daily log files with structured, queryable episodes.
 */
import { isSafeForSharedVisibility, requiresScan } from './secret-scanner.js';
function nowIso() {
    return new Date().toISOString();
}
function parseEpisodeRow(row) {
    return {
        id: row.id,
        agentId: row.agent_id,
        eventType: row.event_type,
        summary: row.summary,
        significance: row.significance,
        visibility: row.visibility || 'org',
        participants: row.participants ? JSON.parse(row.participants) : null,
        sessionKey: row.session_key || null,
        createdAt: row.created_at,
        decayScore: row.decay_score,
    };
}
export class EpisodeStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Record a new episode.
     */
    record(agentId, eventType, summary, opts) {
        const now = nowIso();
        const significance = opts?.significance || 0.5;
        // Secret gate: if requested visibility is shared, verify content is clean.
        // Downgrade to 'private' rather than throw — better to lose the share than leak a secret.
        let resolvedVisibility = opts?.visibility || 'org';
        if (requiresScan(resolvedVisibility) && !isSafeForSharedVisibility(summary)) {
            resolvedVisibility = 'private';
        }
        const result = this.db.prepare(`
      INSERT INTO episodes (agent_id, event_type, summary, significance,
        visibility, participants, session_key, source_message_id, created_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0)
    `).run(agentId, eventType, summary, significance, resolvedVisibility, opts?.participants ? JSON.stringify(opts.participants) : null, opts?.sessionKey || null, opts?.sourceMessageId ?? null, now);
        const id = Number(result.lastInsertRowid);
        return {
            id,
            agentId,
            eventType,
            summary,
            significance,
            visibility: resolvedVisibility,
            participants: opts?.participants || null,
            sessionKey: opts?.sessionKey || null,
            createdAt: now,
            decayScore: 0,
        };
    }
    /**
     * Get recent episodes for an agent.
     */
    getRecent(agentId, opts) {
        let sql = 'SELECT * FROM episodes WHERE agent_id = ? AND decay_score < 0.8';
        const params = [agentId];
        if (opts?.eventType) {
            sql += ' AND event_type = ?';
            params.push(opts.eventType);
        }
        if (opts?.minSignificance) {
            sql += ' AND significance >= ?';
            params.push(opts.minSignificance);
        }
        if (opts?.since) {
            sql += ' AND created_at > ?';
            params.push(opts.since);
        }
        sql += ' ORDER BY created_at DESC';
        if (opts?.limit) {
            sql += ' LIMIT ?';
            params.push(opts.limit);
        }
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseEpisodeRow);
    }
    /**
     * Get the most significant episodes (across all time).
     */
    getMostSignificant(agentId, limit = 10) {
        const rows = this.db.prepare(`
      SELECT * FROM episodes
      WHERE agent_id = ? AND decay_score < 0.5
      ORDER BY significance DESC, created_at DESC
      LIMIT ?
    `).all(agentId, limit);
        return rows.map(parseEpisodeRow);
    }
    /**
     * Decay all episodes.
     */
    decay(agentId, decayRate = 0.005) {
        const result = this.db.prepare(`
      UPDATE episodes
      SET decay_score = MIN(decay_score + ?, 1.0)
      WHERE agent_id = ? AND decay_score < 1.0
    `).run(decayRate, agentId);
        return result.changes;
    }
    /**
     * Prune fully decayed episodes.
     */
    prune(agentId) {
        const result = this.db.prepare(`
      DELETE FROM episodes WHERE agent_id = ? AND decay_score >= 1.0
    `).run(agentId);
        return result.changes;
    }
    /**
     * Get episode summary for a time range.
     */
    getDailySummary(agentId, date) {
        const startOfDay = `${date}T00:00:00.000Z`;
        const endOfDay = `${date}T23:59:59.999Z`;
        const rows = this.db.prepare(`
      SELECT * FROM episodes
      WHERE agent_id = ?
      AND created_at >= ? AND created_at <= ?
      ORDER BY significance DESC, created_at ASC
    `).all(agentId, startOfDay, endOfDay);
        return rows.map(parseEpisodeRow);
    }
}
//# sourceMappingURL=episode-store.js.map