/**
 * hypermem Temporal Store
 *
 * Time-range retrieval over indexed facts. Uses the temporal_index table
 * in library.db to answer LoCoMo-style temporal questions:
 *   "What happened before X?"
 *   "What changed between January and March?"
 *   "What was the most recent thing about Y?"
 *
 * occurred_at is initially populated from created_at (ingest time as proxy,
 * confidence=0.5). Future: date extraction from fact text (confidence=0.9).
 *
 * Query path: SQL time-range filter on temporal_index JOIN facts.
 * No vector search involved — purely temporal ordering.
 */

import type { DatabaseSync } from 'node:sqlite';

export interface TemporalFact {
  factId: number;
  agentId: string;
  content: string;
  domain: string | null;
  occurredAt: number;   // unix ms
  ingestAt: number;     // unix ms
  timeRef: string | null;
  confidence: number;
}

export interface TemporalQueryOptions {
  /** Start of time range (unix ms). Omit for open-ended. */
  fromMs?: number;
  /** End of time range (unix ms). Omit for open-ended. */
  toMs?: number;
  /** Only return facts from this agent. */
  agentId?: string;
  /** Only return facts with this domain. */
  domain?: string;
  /** Sort order. Default: DESC (most recent first). */
  order?: 'ASC' | 'DESC';
  /** Max results. Default: 20. */
  limit?: number;
  /** Minimum confidence on temporal placement. Default: 0. */
  minConfidence?: number;
}

/**
 * Temporal signal keywords. If any of these appear in a query string,
 * the temporal retrieval path fires alongside vector/FTS retrieval.
 */
const TEMPORAL_SIGNALS = [
  'before', 'after', 'when', 'during', 'between', 'since', 'until',
  'last', 'first', 'recent', 'earlier', 'later', 'previously', 'at the time',
  'used to', 'now', 'still', 'anymore', 'changed', 'updated', 'latest',
  'yesterday', 'today', 'week', 'month', 'year', 'january', 'february',
  'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december', 'q1', 'q2', 'q3', 'q4',
];

/**
 * Returns true if the query string contains temporal signals.
 */
export function hasTemporalSignals(query: string): boolean {
  const lower = query.toLowerCase();
  return TEMPORAL_SIGNALS.some(signal => lower.includes(signal));
}

export class TemporalStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Index a newly created or updated fact into temporal_index.
   * Uses created_at as occurred_at proxy (confidence=0.5).
   * Safe to call multiple times — uses INSERT OR REPLACE.
   */
  indexFact(
    factId: number,
    agentId: string,
    createdAt: string,
    opts?: { timeRef?: string; confidence?: number; occurredAt?: number }
  ): void {
    const ingestMs = new Date(createdAt).getTime();
    const occurredMs = opts?.occurredAt ?? ingestMs;

    this.db.prepare(`
      INSERT OR REPLACE INTO temporal_index
        (fact_id, agent_id, occurred_at, ingest_at, time_ref, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      factId,
      agentId,
      occurredMs,
      ingestMs,
      opts?.timeRef ?? null,
      opts?.confidence ?? 0.5
    );
  }

  /**
   * Time-range query. Returns facts in temporal order.
   * Joins temporal_index with facts to get content.
   */
  timeRangeQuery(opts: TemporalQueryOptions = {}): TemporalFact[] {
    const limit = opts.limit ?? 20;
    const order = opts.order ?? 'DESC';
    const minConf = opts.minConfidence ?? 0;

    const params: (string | number)[] = [];
    const conditions: string[] = [
      'f.superseded_by IS NULL',
      'f.decay_score < 0.8',
      `t.confidence >= ${minConf}`,
    ];

    if (opts.agentId) {
      conditions.push('t.agent_id = ?');
      params.push(opts.agentId);
    }
    if (opts.domain) {
      conditions.push('f.domain = ?');
      params.push(opts.domain);
    }
    if (opts.fromMs !== undefined) {
      conditions.push('t.occurred_at >= ?');
      params.push(opts.fromMs);
    }
    if (opts.toMs !== undefined) {
      conditions.push('t.occurred_at <= ?');
      params.push(opts.toMs);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const sql = `
      SELECT
        t.fact_id,
        t.agent_id,
        f.content,
        f.domain,
        t.occurred_at,
        t.ingest_at,
        t.time_ref,
        t.confidence
      FROM temporal_index t
      JOIN facts f ON f.id = t.fact_id
      ${where}
      ORDER BY t.occurred_at ${order}
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      factId: r.fact_id as number,
      agentId: r.agent_id as string,
      content: r.content as string,
      domain: (r.domain as string) || null,
      occurredAt: r.occurred_at as number,
      ingestAt: r.ingest_at as number,
      timeRef: (r.time_ref as string) || null,
      confidence: r.confidence as number,
    }));
  }

  /**
   * Get the most recent N facts for an agent (no time bounds).
   * Useful for "what was the last thing about X" style queries.
   */
  mostRecent(agentId: string, limit = 10): TemporalFact[] {
    return this.timeRangeQuery({ agentId, limit, order: 'DESC' });
  }

  /**
   * Get fact count in the temporal index for an agent.
   */
  getIndexedCount(agentId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM temporal_index WHERE agent_id = ?'
    ).get(agentId) as { count: number };
    return row.count;
  }

  /**
   * Backfill any facts not yet in the temporal index.
   * Safe to run multiple times. Uses INSERT OR IGNORE.
   */
  backfill(): number {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO temporal_index (fact_id, agent_id, occurred_at, ingest_at, confidence)
      SELECT
        id,
        agent_id,
        CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER),
        CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER),
        0.5
      FROM facts
      WHERE superseded_by IS NULL
    `).run();

    return (result as unknown as { changes: number }).changes;
  }
}
