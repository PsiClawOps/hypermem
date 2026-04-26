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
export function hasTemporalSignals(query) {
    const lower = query.toLowerCase();
    return TEMPORAL_SIGNALS.some(signal => lower.includes(signal));
}
export class TemporalStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Index a newly created or updated fact into temporal_index.
     * Uses created_at as occurred_at proxy (confidence=0.5).
     * Safe to call multiple times — uses INSERT OR REPLACE.
     */
    indexFact(factId, agentId, createdAt, opts) {
        const ingestMs = new Date(createdAt).getTime();
        const occurredMs = opts?.occurredAt ?? ingestMs;
        this.db.prepare(`
      INSERT OR REPLACE INTO temporal_index
        (fact_id, agent_id, occurred_at, ingest_at, time_ref, confidence)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(factId, agentId, occurredMs, ingestMs, opts?.timeRef ?? null, opts?.confidence ?? 0.5);
    }
    /**
     * Time-range query. Returns facts in temporal order.
     * Joins temporal_index with facts to get content.
     */
    timeRangeQuery(opts = {}) {
        const limit = opts.limit ?? 20;
        const order = opts.order ?? 'DESC';
        const minConf = opts.minConfidence ?? 0;
        const params = [minConf];
        const conditions = [
            'f.superseded_by IS NULL',
            'f.decay_score < 0.8',
            't.confidence >= ?',
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
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(r => ({
            factId: r.fact_id,
            agentId: r.agent_id,
            content: r.content,
            domain: r.domain || null,
            occurredAt: r.occurred_at,
            ingestAt: r.ingest_at,
            timeRef: r.time_ref || null,
            confidence: r.confidence,
        }));
    }
    /**
     * Get the most recent N facts for an agent (no time bounds).
     * Useful for "what was the last thing about X" style queries.
     */
    mostRecent(agentId, limit = 10) {
        return this.timeRangeQuery({ agentId, limit, order: 'DESC' });
    }
    /**
     * Get fact count in the temporal index for an agent.
     */
    getIndexedCount(agentId) {
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM temporal_index WHERE agent_id = ?').get(agentId);
        return row.count;
    }
    /**
     * Backfill any facts not yet in the temporal index.
     * Safe to run multiple times. Uses INSERT OR IGNORE.
     */
    backfill() {
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
        return result.changes;
    }
}
//# sourceMappingURL=temporal-store.js.map