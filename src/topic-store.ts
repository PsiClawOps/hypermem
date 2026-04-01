/**
 * HyperMem Topic Store
 *
 * Cross-session topic tracking. Topics are conversation threads that
 * can span multiple sessions and channels.
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
    lastConversationId: (row.last_conversation_id as number) || null,
    lastMessageId: (row.last_message_id as number) || null,
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
  create(agentId: string, name: string, description?: string): Topic {
    const now = nowIso();

    const result = this.db.prepare(`
      INSERT INTO topics (agent_id, name, description, status, message_count, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 0, ?, ?)
    `).run(agentId, name, description || null, now, now);

    const id = (result as unknown as { lastInsertRowid: number }).lastInsertRowid;

    return {
      id,
      agentId,
      name,
      description: description || null,
      status: 'active',
      lastConversationId: null,
      lastMessageId: null,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Link a message to a topic.
   */
  linkMessage(
    topicId: number,
    messageId: number,
    conversationId: number,
    relevance: number = 1.0
  ): void {
    const now = nowIso();

    this.db.prepare(`
      INSERT OR IGNORE INTO topic_messages (topic_id, message_id, conversation_id, relevance)
      VALUES (?, ?, ?, ?)
    `).run(topicId, messageId, conversationId, relevance);

    this.db.prepare(`
      UPDATE topics
      SET last_conversation_id = ?,
          last_message_id = ?,
          message_count = message_count + 1,
          status = 'active',
          updated_at = ?
      WHERE id = ?
    `).run(conversationId, messageId, now, topicId);
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
   * Find topics matching a query (by name or description).
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
   * Close dormant topics (no activity for closedAfterDays).
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

  /**
   * Get topics that are active in a specific conversation.
   */
  getConversationTopics(conversationId: number): Topic[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT t.* FROM topics t
      JOIN topic_messages tm ON t.id = tm.topic_id
      WHERE tm.conversation_id = ?
      ORDER BY t.updated_at DESC
    `).all(conversationId) as Record<string, unknown>[];

    return rows.map(parseTopicRow);
  }
}
