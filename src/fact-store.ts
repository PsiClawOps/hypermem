/**
 * HyperMem Fact Store
 *
 * CRUD operations for facts (extracted knowledge that spans sessions).
 * Facts have scope (agent/session/user), confidence, and decay.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Fact, FactScope } from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function parseFactRow(row: Record<string, unknown>): Fact {
  return {
    id: row.id as number,
    agentId: row.agent_id as string,
    scope: row.scope as FactScope,
    domain: (row.domain as string) || null,
    content: row.content as string,
    confidence: row.confidence as number,
    sourceConversationId: (row.source_conversation_id as number) || null,
    sourceMessageId: (row.source_message_id as number) || null,
    contradictsFactId: (row.contradicts_fact_id as number) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: (row.expires_at as string) || null,
    decayScore: row.decay_score as number,
  };
}

export class FactStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Add a new fact. Checks for duplicates by content similarity.
   */
  addFact(
    agentId: string,
    content: string,
    opts?: {
      scope?: FactScope;
      domain?: string;
      confidence?: number;
      sourceConversationId?: number;
      sourceMessageId?: number;
      contradictsFactId?: number;
      expiresAt?: string;
    }
  ): Fact {
    const now = nowIso();
    const scope = opts?.scope || 'agent';

    // Check for exact duplicate
    const existing = this.db.prepare(`
      SELECT * FROM facts WHERE agent_id = ? AND content = ? AND scope = ?
    `).get(agentId, content, scope) as Record<string, unknown> | undefined;

    if (existing) {
      // Update confidence and timestamp instead of creating duplicate
      this.db.prepare(`
        UPDATE facts SET confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?
      `).run(opts?.confidence || 1.0, now, existing.id as number);

      return parseFactRow({ ...existing, updated_at: now });
    }

    // If this fact contradicts another, mark the old one
    if (opts?.contradictsFactId) {
      this.db.prepare(`
        UPDATE facts SET decay_score = 0.9, updated_at = ? WHERE id = ?
      `).run(now, opts.contradictsFactId);
    }

    const result = this.db.prepare(`
      INSERT INTO facts (agent_id, scope, domain, content, confidence,
        source_conversation_id, source_message_id, contradicts_fact_id,
        created_at, updated_at, expires_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0)
    `).run(
      agentId,
      scope,
      opts?.domain || null,
      content,
      opts?.confidence || 1.0,
      opts?.sourceConversationId || null,
      opts?.sourceMessageId || null,
      opts?.contradictsFactId || null,
      now,
      now,
      opts?.expiresAt || null
    );

    const id = (result as unknown as { lastInsertRowid: number }).lastInsertRowid;

    return {
      id,
      agentId,
      scope,
      domain: opts?.domain || null,
      content,
      confidence: opts?.confidence || 1.0,
      sourceConversationId: opts?.sourceConversationId || null,
      sourceMessageId: opts?.sourceMessageId || null,
      contradictsFactId: opts?.contradictsFactId || null,
      createdAt: now,
      updatedAt: now,
      expiresAt: opts?.expiresAt || null,
      decayScore: 0,
    };
  }

  /**
   * Get active facts for an agent.
   */
  getActiveFacts(
    agentId: string,
    opts?: {
      scope?: FactScope;
      domain?: string;
      limit?: number;
      minConfidence?: number;
    }
  ): Fact[] {
    let sql = `
      SELECT * FROM facts
      WHERE agent_id = ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      AND decay_score < 0.8
    `;
    const params: (string | number)[] = [agentId];

    if (opts?.scope) {
      sql += ' AND scope = ?';
      params.push(opts.scope);
    }
    if (opts?.domain) {
      sql += ' AND domain = ?';
      params.push(opts.domain);
    }
    if (opts?.minConfidence) {
      sql += ' AND confidence >= ?';
      params.push(opts.minConfidence);
    }

    sql += ' ORDER BY confidence DESC, decay_score ASC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseFactRow);
  }

  /**
   * Search facts by content.
   */
  searchFacts(agentId: string, query: string, limit: number = 10): Fact[] {
    // Simple LIKE search — FTS could be added later if needed
    const rows = this.db.prepare(`
      SELECT * FROM facts
      WHERE agent_id = ?
      AND content LIKE ?
      AND decay_score < 0.8
      ORDER BY confidence DESC
      LIMIT ?
    `).all(agentId, `%${query}%`, limit) as Record<string, unknown>[];

    return rows.map(parseFactRow);
  }

  /**
   * Decay all facts by a fixed rate.
   * Called periodically by the indexer.
   */
  decayFacts(agentId: string, decayRate: number = 0.01): number {
    const result = this.db.prepare(`
      UPDATE facts
      SET decay_score = MIN(decay_score + ?, 1.0),
          updated_at = ?
      WHERE agent_id = ?
      AND decay_score < 1.0
    `).run(decayRate, nowIso(), agentId);

    return (result as unknown as { changes: number }).changes;
  }

  /**
   * Remove expired and fully decayed facts.
   */
  pruneFacts(agentId: string): number {
    const result = this.db.prepare(`
      DELETE FROM facts
      WHERE agent_id = ?
      AND (
        (expires_at IS NOT NULL AND expires_at < datetime('now'))
        OR decay_score >= 1.0
      )
    `).run(agentId);

    return (result as unknown as { changes: number }).changes;
  }

  /**
   * Get fact count for an agent.
   */
  getFactCount(agentId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM facts WHERE agent_id = ?'
    ).get(agentId) as { count: number };
    return row.count;
  }
}
