/**
 * hypermem Topic Store
 *
 * Cross-session topic tracking. Topics are conversation threads that
 * can span multiple sessions and channels.
 * Lives in the central library DB.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Topic, TopicStatus } from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function parseTopicRow(row: Record<string, unknown>): Topic {
  return {
    id: row.id as number,
    agentId: row.agent_id as string,
    name: row.name as string,
    description: (row.description as string) || null,
    status: row.status as TopicStatus,
    visibility: (row.visibility as string) || 'org',
    lastSessionKey: (row.last_session_key as string) || null,
    messageCount: row.message_count as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class TopicStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Create a new topic.
   */
  create(agentId: string, name: string, description?: string, visibility?: string): Topic {
    const now = nowIso();

    const result = this.db.prepare(`
      INSERT INTO topics (agent_id, name, description, status, visibility, message_count, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, 0, ?, ?)
    `).run(agentId, name, description || null, visibility || 'org', now, now);

    const id = Number((result as unknown as { lastInsertRowid: bigint }).lastInsertRowid);

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
   * Touch a topic — update activity tracking.
   */
  touch(topicId: number, sessionKey: string, messagesDelta: number = 1): void {
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
  getActive(agentId: string, limit: number = 20): Topic[] {
    const rows = this.db.prepare(`
      SELECT * FROM topics
      WHERE agent_id = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(agentId, limit) as Record<string, unknown>[];

    return rows.map(parseTopicRow);
  }

  /**
   * Get all topics for an agent.
   */
  getAll(
    agentId: string,
    opts?: { status?: TopicStatus; limit?: number }
  ): Topic[] {
    let sql = 'SELECT * FROM topics WHERE agent_id = ?';
    const params: (string | number)[] = [agentId];

    if (opts?.status) {
      sql += ' AND status = ?';
      params.push(opts.status);
    }

    sql += ' ORDER BY updated_at DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseTopicRow);
  }

  /**
   * Find topics matching a query.
   */
  search(agentId: string, query: string, limit: number = 10): Topic[] {
    const rows = this.db.prepare(`
      SELECT * FROM topics
      WHERE agent_id = ?
      AND (name LIKE ? OR description LIKE ?)
      AND status != 'closed'
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(agentId, `%${query}%`, `%${query}%`, limit) as Record<string, unknown>[];

    return rows.map(parseTopicRow);
  }

  /**
   * Mark dormant topics (no activity for dormantAfterHours).
   */
  markDormant(agentId: string, dormantAfterHours: number = 24): number {
    const cutoff = new Date(Date.now() - dormantAfterHours * 60 * 60 * 1000).toISOString();

    const result = this.db.prepare(`
      UPDATE topics
      SET status = 'dormant', updated_at = ?
      WHERE agent_id = ? AND status = 'active' AND updated_at < ?
    `).run(nowIso(), agentId, cutoff);

    return (result as unknown as { changes: number }).changes;
  }

  /**
   * Close dormant topics.
   */
  closeDormant(agentId: string, closedAfterDays: number = 7): number {
    const cutoff = new Date(Date.now() - closedAfterDays * 24 * 60 * 60 * 1000).toISOString();

    const result = this.db.prepare(`
      UPDATE topics
      SET status = 'closed', updated_at = ?
      WHERE agent_id = ? AND status = 'dormant' AND updated_at < ?
    `).run(nowIso(), agentId, cutoff);

    return (result as unknown as { changes: number }).changes;
  }
}
