/**
 * HyperMem Episode Store
 *
 * Significant events in an agent's lifetime.
 * Lives in the central library DB.
 * Replaces daily log files with structured, queryable episodes.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Episode, EpisodeType } from './types.js';
import { isSafeForSharedVisibility, requiresScan } from './secret-scanner.js';

function nowIso(): string {
  return new Date().toISOString();
}

function parseEpisodeRow(row: Record<string, unknown>): Episode {
  return {
    id: row.id as number,
    agentId: row.agent_id as string,
    eventType: row.event_type as EpisodeType,
    summary: row.summary as string,
    significance: row.significance as number,
    visibility: (row.visibility as string) || 'org',
    participants: row.participants ? JSON.parse(row.participants as string) : null,
    sessionKey: (row.session_key as string) || null,
    createdAt: row.created_at as string,
    decayScore: row.decay_score as number,
  };
}

export class EpisodeStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Record a new episode.
   */
  record(
    agentId: string,
    eventType: EpisodeType,
    summary: string,
    opts?: {
      significance?: number;
      visibility?: string;
      participants?: string[];
      sessionKey?: string;
    }
  ): Episode {
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
        visibility, participants, session_key, created_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.0)
    `).run(
      agentId,
      eventType,
      summary,
      significance,
      resolvedVisibility,
      opts?.participants ? JSON.stringify(opts.participants) : null,
      opts?.sessionKey || null,
      now
    );

    const id = Number((result as unknown as { lastInsertRowid: bigint }).lastInsertRowid);

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
  getRecent(
    agentId: string,
    opts?: {
      eventType?: EpisodeType;
      minSignificance?: number;
      limit?: number;
      since?: string;
    }
  ): Episode[] {
    let sql = 'SELECT * FROM episodes WHERE agent_id = ? AND decay_score < 0.8';
    const params: (string | number)[] = [agentId];

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

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseEpisodeRow);
  }

  /**
   * Get the most significant episodes (across all time).
   */
  getMostSignificant(agentId: string, limit: number = 10): Episode[] {
    const rows = this.db.prepare(`
      SELECT * FROM episodes
      WHERE agent_id = ? AND decay_score < 0.5
      ORDER BY significance DESC, created_at DESC
      LIMIT ?
    `).all(agentId, limit) as Record<string, unknown>[];

    return rows.map(parseEpisodeRow);
  }

  /**
   * Decay all episodes.
   */
  decay(agentId: string, decayRate: number = 0.005): number {
    const result = this.db.prepare(`
      UPDATE episodes
      SET decay_score = MIN(decay_score + ?, 1.0)
      WHERE agent_id = ? AND decay_score < 1.0
    `).run(decayRate, agentId);

    return (result as unknown as { changes: number }).changes;
  }

  /**
   * Prune fully decayed episodes.
   */
  prune(agentId: string): number {
    const result = this.db.prepare(`
      DELETE FROM episodes WHERE agent_id = ? AND decay_score >= 1.0
    `).run(agentId);

    return (result as unknown as { changes: number }).changes;
  }

  /**
   * Get episode summary for a time range.
   */
  getDailySummary(agentId: string, date: string): Episode[] {
    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;

    const rows = this.db.prepare(`
      SELECT * FROM episodes
      WHERE agent_id = ?
      AND created_at >= ? AND created_at <= ?
      ORDER BY significance DESC, created_at ASC
    `).all(agentId, startOfDay, endOfDay) as Record<string, unknown>[];

    return rows.map(parseEpisodeRow);
  }
}
