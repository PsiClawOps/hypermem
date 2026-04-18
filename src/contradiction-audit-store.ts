/**
 * hypermem Contradiction Audit Store
 *
 * Lightweight audit trail for contradiction detections during background indexing.
 * Records when the indexer identifies a new fact candidate that contradicts an
 * existing stored fact, without auto-resolving (autoResolve: false path).
 *
 * Stored in library.db under the contradiction_audits table (created on demand).
 * Used for observability and future contradiction resolution tooling.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ContradictionCandidate } from './contradiction-detector.js';

export interface ContradictionAuditEntry {
  id: number;
  agentId: string;
  newContent: string;
  newDomain: string | null;
  existingFactId: number;
  existingContent: string;
  similarityScore: number;
  contradictionScore: number;
  reason: string;
  sourceRef: string | null;
  createdAt: string;
}

export class ContradictionAuditStore {
  constructor(private readonly db: DatabaseSync) {
    this.ensureTable();
  }

  private ensureTable(): void {
    // Synced with library-schema.ts v19 shape so in-memory test DBs match production.
    // In real usage, setupLibraryDb() runs first and this CREATE TABLE is a no-op.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contradiction_audits (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id             TEXT NOT NULL,
        entity_type          TEXT NOT NULL CHECK(entity_type IN ('fact')),
        new_content          TEXT NOT NULL,
        new_domain           TEXT,
        existing_fact_id     INTEGER NOT NULL,
        existing_content     TEXT NOT NULL,
        similarity_score     REAL NOT NULL DEFAULT 0,
        contradiction_score  REAL NOT NULL DEFAULT 0,
        reason               TEXT NOT NULL,
        detector             TEXT NOT NULL DEFAULT 'heuristic_v1',
        suggested_resolution TEXT NOT NULL DEFAULT 'review',
        source_ref           TEXT,
        status               TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'accepted', 'dismissed', 'auto-superseded', 'auto-invalidated')),
        resolution_notes     TEXT,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_contradiction_audits_agent_status
        ON contradiction_audits (agent_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contradiction_audits_existing_fact
        ON contradiction_audits (existing_fact_id, status);
      CREATE INDEX IF NOT EXISTS idx_contradiction_audits_agent
        ON contradiction_audits (agent_id, created_at DESC);
    `);
  }

  /**
   * Record a detected contradiction between a new fact candidate and an existing fact.
   *
   * @param agentId     - Agent whose fact was being indexed
   * @param newFact     - The incoming fact candidate (not yet stored)
   * @param candidate   - The contradiction candidate from ContradictionDetector
   * @param opts        - Optional metadata (sourceRef = "msg:<id>" etc.)
   */
  recordFactAudit(
    agentId: string,
    newFact: { content: string; domain?: string | null },
    candidate: ContradictionCandidate,
    opts?: { sourceRef?: string; status?: string }
  ): void {
    const status = opts?.status ?? 'pending';
    this.db.prepare(`
      INSERT INTO contradiction_audits
        (agent_id, entity_type, new_content, new_domain, existing_fact_id, existing_content,
         similarity_score, contradiction_score, reason, source_ref, status, created_at)
      VALUES (?, 'fact', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      agentId,
      newFact.content,
      newFact.domain ?? null,
      candidate.existingFactId,
      candidate.existingContent,
      candidate.similarityScore,
      candidate.contradictionScore,
      candidate.reason,
      opts?.sourceRef ?? null,
      status,
    );
  }

  /**
   * Fetch recent audit entries for an agent (most recent first).
   */
  getRecentAudits(agentId: string, limit = 20): ContradictionAuditEntry[] {
    return this.db.prepare(`
      SELECT
        id, agent_id, new_content, new_domain, existing_fact_id, existing_content,
        similarity_score, contradiction_score, reason, source_ref, created_at
      FROM contradiction_audits
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(agentId, limit) as unknown as ContradictionAuditEntry[];
  }

  /**
   * Count unresolved audits for an agent.
   */
  countAudits(agentId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM contradiction_audits WHERE agent_id = ?'
    ).get(agentId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}
