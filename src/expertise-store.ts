/**
 * hypermem Expertise Store
 *
 * Stores domain expertise patterns — learned behaviors that make the Nth run
 * better than the 1st. Two-phase lifecycle:
 *   1. Observations: raw learnings logged from conversations, pipelines, reviews
 *   2. Patterns: graduated observations with N≥3 confirming instances
 *
 * Patterns are agent-scoped but domain-tagged, enabling cross-agent queries.
 * Patterns have confidence, frequency tracking, and decay on counter-evidence.
 */

import type { DatabaseSync } from 'node:sqlite';

// ── Types ──

export interface ExpertiseObservation {
  id: number;
  agentId: string;
  domain: string;
  context: string | null;
  observationText: string;
  sourceType: 'conversation' | 'pipeline' | 'review' | 'manual';
  sourceRef: string | null;
  createdAt: string;
}

export interface ExpertisePattern {
  id: number;
  agentId: string;
  domain: string;
  patternText: string;
  confidence: number;
  frequency: number;       // confirming instance count
  firstSeen: string;
  lastConfirmed: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  decayScore: number;
}

export interface ExpertiseEvidence {
  observationId: number;
  patternId: number;
  relationship: 'confirms' | 'contradicts';
  createdAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseObservationRow(row: Record<string, unknown>): ExpertiseObservation {
  return {
    id: row.id as number,
    agentId: row.agent_id as string,
    domain: row.domain as string,
    context: (row.context as string) || null,
    observationText: row.observation_text as string,
    sourceType: (row.source_type as string) as ExpertiseObservation['sourceType'],
    sourceRef: (row.source_ref as string) || null,
    createdAt: row.created_at as string,
  };
}

function parsePatternRow(row: Record<string, unknown>): ExpertisePattern {
  return {
    id: row.id as number,
    agentId: row.agent_id as string,
    domain: row.domain as string,
    patternText: row.pattern_text as string,
    confidence: row.confidence as number,
    frequency: row.frequency as number,
    firstSeen: row.first_seen as string,
    lastConfirmed: row.last_confirmed as string,
    invalidatedAt: (row.invalidated_at as string) || null,
    invalidationReason: (row.invalidation_reason as string) || null,
    decayScore: row.decay_score as number,
  };
}

// ── Graduation threshold ──
const DEFAULT_GRADUATION_THRESHOLD = 3;

export class ExpertiseStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly graduationThreshold: number = DEFAULT_GRADUATION_THRESHOLD
  ) {}

  // ── Observations ──

  /**
   * Record a raw observation from any source.
   */
  record(
    agentId: string,
    observationText: string,
    domain: string,
    opts?: {
      context?: string;
      sourceType?: ExpertiseObservation['sourceType'];
      sourceRef?: string;
    }
  ): ExpertiseObservation {
    const now = nowIso();
    const result = this.db.prepare(`
      INSERT INTO expertise_observations
        (agent_id, domain, context, observation_text, source_type, source_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      agentId,
      domain,
      opts?.context || null,
      observationText,
      opts?.sourceType || 'conversation',
      opts?.sourceRef || null,
      now
    );

    const id = Number((result as unknown as { lastInsertRowid: bigint }).lastInsertRowid);

    return {
      id,
      agentId,
      domain,
      context: opts?.context || null,
      observationText,
      sourceType: opts?.sourceType || 'conversation',
      sourceRef: opts?.sourceRef || null,
      createdAt: now,
    };
  }

  /**
   * Get observations for an agent, optionally filtered by domain.
   */
  getObservations(
    agentId: string,
    opts?: { domain?: string; limit?: number }
  ): ExpertiseObservation[] {
    let sql = 'SELECT * FROM expertise_observations WHERE agent_id = ?';
    const params: (string | number)[] = [agentId];

    if (opts?.domain) {
      sql += ' AND domain = ?';
      params.push(opts.domain);
    }

    sql += ' ORDER BY created_at DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseObservationRow);
  }

  // ── Patterns ──

  /**
   * Retrieve active expertise patterns for current work context.
   * Returns patterns sorted by confidence DESC, frequency DESC.
   * Excludes invalidated patterns by default.
   */
  query(
    agentId: string,
    domain: string,
    opts?: {
      context?: string;
      includeInvalidated?: boolean;
      limit?: number;
      minConfidence?: number;
    }
  ): ExpertisePattern[] {
    let sql = `
      SELECT * FROM expertise_patterns
      WHERE agent_id = ? AND domain = ?
      AND decay_score < 0.8
    `;
    const params: (string | number)[] = [agentId, domain];

    if (!opts?.includeInvalidated) {
      sql += ' AND invalidated_at IS NULL';
    }

    if (opts?.minConfidence) {
      sql += ' AND confidence >= ?';
      params.push(opts.minConfidence);
    }

    sql += ' ORDER BY confidence DESC, frequency DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parsePatternRow);
  }

  /**
   * Cross-agent query: get patterns from any agent in a given domain.
   * Useful for fleet-wide expertise ("what has any agent learned about X?").
   */
  queryFleet(
    domain: string,
    opts?: { limit?: number; minConfidence?: number }
  ): ExpertisePattern[] {
    let sql = `
      SELECT * FROM expertise_patterns
      WHERE domain = ?
      AND invalidated_at IS NULL
      AND decay_score < 0.8
    `;
    const params: (string | number)[] = [domain];

    if (opts?.minConfidence) {
      sql += ' AND confidence >= ?';
      params.push(opts.minConfidence);
    }

    sql += ' ORDER BY confidence DESC, frequency DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parsePatternRow);
  }

  /**
   * Graduate an observation to a pattern.
   *
   * If a similar pattern already exists (same agent, domain, and pattern text prefix match),
   * increments its frequency and updates lastConfirmed instead of creating a duplicate.
   *
   * Auto-graduation happens when an observation has N≥graduationThreshold confirming
   * evidence links. Can also be called manually.
   */
  graduate(
    agentId: string,
    observationId: number,
    opts?: { patternText?: string; confidence?: number }
  ): ExpertisePattern | null {
    // Get the observation
    const obsRow = this.db.prepare(
      'SELECT * FROM expertise_observations WHERE id = ? AND agent_id = ?'
    ).get(observationId, agentId) as Record<string, unknown> | undefined;

    if (!obsRow) return null;

    const obs = parseObservationRow(obsRow);
    const patternText = opts?.patternText || obs.observationText;
    const confidence = opts?.confidence || 0.7;
    const now = nowIso();

    // Check for existing similar pattern (same domain, prefix match)
    const prefix = patternText.slice(0, 80);
    const existing = this.db.prepare(`
      SELECT * FROM expertise_patterns
      WHERE agent_id = ? AND domain = ? AND pattern_text LIKE ?
      AND invalidated_at IS NULL
      LIMIT 1
    `).get(agentId, obs.domain, `${prefix}%`) as Record<string, unknown> | undefined;

    if (existing) {
      // Increment frequency and update
      this.db.prepare(`
        UPDATE expertise_patterns
        SET frequency = frequency + 1,
            confidence = MAX(confidence, ?),
            last_confirmed = ?,
            decay_score = MAX(decay_score - 0.1, 0)
        WHERE id = ?
      `).run(confidence, now, existing.id as number);

      // Link evidence
      this.db.prepare(`
        INSERT INTO expertise_evidence (observation_id, pattern_id, relationship, created_at)
        VALUES (?, ?, 'confirms', ?)
      `).run(observationId, existing.id as number, now);

      // Return updated pattern
      const updated = this.db.prepare('SELECT * FROM expertise_patterns WHERE id = ?')
        .get(existing.id as number) as Record<string, unknown>;
      return parsePatternRow(updated);
    }

    // Create new pattern
    const result = this.db.prepare(`
      INSERT INTO expertise_patterns
        (agent_id, domain, pattern_text, confidence, frequency, first_seen, last_confirmed, decay_score)
      VALUES (?, ?, ?, ?, 1, ?, ?, 0.0)
    `).run(agentId, obs.domain, patternText, confidence, now, now);

    const patternId = Number((result as unknown as { lastInsertRowid: bigint }).lastInsertRowid);

    // Link the graduating observation as evidence
    this.db.prepare(`
      INSERT INTO expertise_evidence (observation_id, pattern_id, relationship, created_at)
      VALUES (?, ?, 'confirms', ?)
    `).run(observationId, patternId, now);

    return {
      id: patternId,
      agentId,
      domain: obs.domain,
      patternText,
      confidence,
      frequency: 1,
      firstSeen: now,
      lastConfirmed: now,
      invalidatedAt: null,
      invalidationReason: null,
      decayScore: 0,
    };
  }

  /**
   * Record evidence linking an observation to a pattern.
   * If this pushes a pattern's contradicting evidence past threshold,
   * auto-invalidates the pattern.
   */
  addEvidence(
    observationId: number,
    patternId: number,
    relationship: 'confirms' | 'contradicts'
  ): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO expertise_evidence (observation_id, pattern_id, relationship, created_at)
      VALUES (?, ?, ?, ?)
    `).run(observationId, patternId, relationship, now);

    if (relationship === 'confirms') {
      // Boost the pattern
      this.db.prepare(`
        UPDATE expertise_patterns
        SET frequency = frequency + 1,
            last_confirmed = ?,
            decay_score = MAX(decay_score - 0.05, 0)
        WHERE id = ?
      `).run(now, patternId);
    } else {
      // Contradicting: increase decay, check if should invalidate
      this.db.prepare(`
        UPDATE expertise_patterns
        SET decay_score = MIN(decay_score + 0.2, 1.0)
        WHERE id = ?
      `).run(patternId);

      // Count contradictions vs confirmations
      const counts = this.db.prepare(`
        SELECT relationship, COUNT(*) as cnt
        FROM expertise_evidence
        WHERE pattern_id = ?
        GROUP BY relationship
      `).all(patternId) as Array<{ relationship: string; cnt: number }>;

      const confirms = counts.find(c => c.relationship === 'confirms')?.cnt ?? 0;
      const contradicts = counts.find(c => c.relationship === 'contradicts')?.cnt ?? 0;

      // Auto-invalidate if contradictions exceed confirmations
      if (contradicts > confirms) {
        this.invalidate(patternId, 'auto: contradicting evidence exceeded confirmations');
      }
    }
  }

  /**
   * Check if any observations are ready for auto-graduation.
   * An observation graduates when it has N≥threshold confirming evidence links.
   * Returns the number of newly graduated patterns.
   */
  autoGraduate(agentId: string): number {
    // Find observations with enough confirming evidence that aren't already patterns
    const candidates = this.db.prepare(`
      SELECT e.observation_id, COUNT(*) as confirm_count
      FROM expertise_evidence e
      JOIN expertise_observations o ON o.id = e.observation_id
      WHERE o.agent_id = ?
      AND e.relationship = 'confirms'
      AND e.observation_id NOT IN (
        SELECT DISTINCT e2.observation_id FROM expertise_evidence e2
        JOIN expertise_patterns p ON p.id = e2.pattern_id
        WHERE p.agent_id = ?
      )
      GROUP BY e.observation_id
      HAVING COUNT(*) >= ?
    `).all(agentId, agentId, this.graduationThreshold) as Array<{ observation_id: number; confirm_count: number }>;

    let graduated = 0;
    for (const candidate of candidates) {
      const result = this.graduate(agentId, candidate.observation_id);
      if (result) graduated++;
    }
    return graduated;
  }

  /**
   * Mark a pattern as invalidated.
   */
  invalidate(patternId: number, reason: string): boolean {
    const now = nowIso();
    const result = this.db.prepare(`
      UPDATE expertise_patterns
      SET invalidated_at = ?, invalidation_reason = ?, updated_at = ?
      WHERE id = ? AND invalidated_at IS NULL
    `).run(now, reason, now, patternId);
    return (result as unknown as { changes: number }).changes > 0;
  }

  /**
   * List all active patterns for an agent, optionally filtered by domain.
   */
  list(
    agentId: string,
    opts?: { domain?: string; includeInvalidated?: boolean }
  ): ExpertisePattern[] {
    let sql = 'SELECT * FROM expertise_patterns WHERE agent_id = ?';
    const params: (string | number)[] = [agentId];

    if (opts?.domain) {
      sql += ' AND domain = ?';
      params.push(opts.domain);
    }

    if (!opts?.includeInvalidated) {
      sql += ' AND invalidated_at IS NULL';
    }

    sql += ' ORDER BY confidence DESC, frequency DESC';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parsePatternRow);
  }

  /**
   * Decay all patterns by a fixed rate. Similar to fact decay.
   */
  decayPatterns(agentId: string, decayRate: number = 0.005): number {
    const result = this.db.prepare(`
      UPDATE expertise_patterns
      SET decay_score = MIN(decay_score + ?, 1.0)
      WHERE agent_id = ? AND decay_score < 1.0 AND invalidated_at IS NULL
    `).run(decayRate, agentId);
    return (result as unknown as { changes: number }).changes;
  }

  /**
   * Get pattern and observation counts for an agent.
   */
  getStats(agentId: string): { observations: number; activePatterns: number; invalidatedPatterns: number } {
    const obs = this.db.prepare(
      'SELECT COUNT(*) as count FROM expertise_observations WHERE agent_id = ?'
    ).get(agentId) as { count: number };
    const active = this.db.prepare(
      'SELECT COUNT(*) as count FROM expertise_patterns WHERE agent_id = ? AND invalidated_at IS NULL'
    ).get(agentId) as { count: number };
    const invalidated = this.db.prepare(
      'SELECT COUNT(*) as count FROM expertise_patterns WHERE agent_id = ? AND invalidated_at IS NOT NULL'
    ).get(agentId) as { count: number };
    return {
      observations: obs.count,
      activePatterns: active.count,
      invalidatedPatterns: invalidated.count,
    };
  }
}
