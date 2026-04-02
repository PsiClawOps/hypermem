/**
 * HyperMem Fact Store
 *
 * CRUD operations for facts (extracted knowledge that spans sessions).
 * Facts live in the central library DB, tagged by agent_id.
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
    visibility: (row.visibility as string) || 'private',
    sourceType: (row.source_type as string) || 'conversation',
    sourceSessionKey: (row.source_session_key as string) || null,
    sourceRef: (row.source_ref as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: (row.expires_at as string) || null,
    supersededBy: (row.superseded_by as number) || null,
    decayScore: row.decay_score as number,
  };
}

export class FactStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Add a new fact. Checks for duplicates by content.
   */
  addFact(
    agentId: string,
    content: string,
    opts?: {
      scope?: FactScope;
      domain?: string;
      confidence?: number;
      visibility?: string;
      sourceType?: string;
      sourceSessionKey?: string;
      sourceRef?: string;
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
      this.db.prepare(`
        UPDATE facts SET confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?
      `).run(opts?.confidence || 1.0, now, existing.id as number);

      return parseFactRow({ ...existing, updated_at: now });
    }

    const result = this.db.prepare(`
      INSERT INTO facts (agent_id, scope, domain, content, confidence,
        visibility, source_type, source_session_key, source_ref,
        created_at, updated_at, expires_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0)
    `).run(
      agentId,
      scope,
      opts?.domain || null,
      content,
      opts?.confidence || 1.0,
      opts?.visibility || 'private',
      opts?.sourceType || 'conversation',
      opts?.sourceSessionKey || null,
      opts?.sourceRef || null,
      now,
      now,
      opts?.expiresAt || null
    );

    const id = Number((result as unknown as { lastInsertRowid: bigint }).lastInsertRowid);

    return {
      id,
      agentId,
      scope,
      domain: opts?.domain || null,
      content,
      confidence: opts?.confidence || 1.0,
      visibility: opts?.visibility || 'private',
      sourceType: opts?.sourceType || 'conversation',
      sourceSessionKey: opts?.sourceSessionKey || null,
      sourceRef: opts?.sourceRef || null,
      createdAt: now,
      updatedAt: now,
      expiresAt: opts?.expiresAt || null,
      supersededBy: null,
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
      AND superseded_by IS NULL
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
   * Full-text search facts.
   */
  searchFacts(query: string, opts?: {
    agentId?: string;
    domain?: string;
    visibility?: string;
    limit?: number;
  }): Fact[] {
    const limit = opts?.limit || 20;
    const hasFilters = !!(opts?.agentId || opts?.domain || opts?.visibility);
    const innerLimit = hasFilters ? limit * 4 : limit;

    // Two-phase: FTS in subquery, then filter on small set.  See hybrid-retrieval.ts.
    let sql = `
      SELECT f.* FROM (
        SELECT rowid, rank FROM facts_fts WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?
      ) sub
      JOIN facts f ON f.id = sub.rowid
      WHERE f.superseded_by IS NULL
      AND f.decay_score < 0.8
    `;
    const params: (string | number)[] = [query, innerLimit];

    if (opts?.agentId) {
      sql += ' AND f.agent_id = ?';
      params.push(opts.agentId);
    }
    if (opts?.domain) {
      sql += ' AND f.domain = ?';
      params.push(opts.domain);
    }
    if (opts?.visibility) {
      sql += ' AND f.visibility = ?';
      params.push(opts.visibility);
    }

    sql += ' ORDER BY sub.rank LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseFactRow);
  }

  /**
   * Decay all facts by a fixed rate.
   */
  decayFacts(agentId: string, decayRate: number = 0.01): number {
    const result = this.db.prepare(`
      UPDATE facts
      SET decay_score = MIN(decay_score + ?, 1.0), updated_at = ?
      WHERE agent_id = ? AND decay_score < 1.0
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
