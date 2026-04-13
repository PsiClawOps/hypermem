/**
 * hypermem Preference Store
 *
 * Behavioral patterns observed about people, systems, and workflows.
 * Lives in the central library DB.
 * "operator prefers architectural stability" is a preference, not a fact.
 */

import type { DatabaseSync } from 'node:sqlite';

function nowIso(): string {
  return new Date().toISOString();
}

export interface Preference {
  id: number;
  subject: string;
  domain: string;
  key: string;
  value: string;
  agentId: string;
  confidence: number;
  visibility: string;
  sourceType: string;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseRow(row: Record<string, unknown>): Preference {
  return {
    id: row.id as number,
    subject: row.subject as string,
    domain: row.domain as string,
    key: row.key as string,
    value: row.value as string,
    agentId: row.agent_id as string,
    confidence: row.confidence as number,
    visibility: (row.visibility as string) || 'fleet',
    sourceType: (row.source_type as string) || 'observation',
    sourceRef: (row.source_ref as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export class PreferenceStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Set or update a preference. Upserts on (subject, domain, key).
   */
  set(
    subject: string,
    key: string,
    value: string,
    opts?: {
      domain?: string;
      agentId?: string;
      confidence?: number;
      visibility?: string;
      sourceType?: string;
      sourceRef?: string;
    }
  ): Preference {
    const now = nowIso();
    const domain = opts?.domain || 'general';

    const result = this.db.prepare(`
      INSERT INTO preferences (subject, domain, key, value, agent_id, confidence,
        visibility, source_type, source_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject, domain, key) DO UPDATE SET
        value = excluded.value,
        confidence = excluded.confidence,
        agent_id = excluded.agent_id,
        source_type = excluded.source_type,
        source_ref = excluded.source_ref,
        updated_at = excluded.updated_at
    `).run(
      subject,
      domain,
      key,
      value,
      opts?.agentId || 'system',
      opts?.confidence || 1.0,
      opts?.visibility || 'fleet',
      opts?.sourceType || 'observation',
      opts?.sourceRef || null,
      now,
      now
    );

    const id = Number((result as unknown as { lastInsertRowid: bigint }).lastInsertRowid);

    return {
      id,
      subject,
      domain,
      key,
      value,
      agentId: opts?.agentId || 'system',
      confidence: opts?.confidence || 1.0,
      visibility: opts?.visibility || 'fleet',
      sourceType: opts?.sourceType || 'observation',
      sourceRef: opts?.sourceRef || null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Get a specific preference.
   */
  get(subject: string, key: string, domain: string = 'general'): Preference | null {
    const row = this.db.prepare(
      'SELECT * FROM preferences WHERE subject = ? AND domain = ? AND key = ?'
    ).get(subject, domain, key) as Record<string, unknown> | undefined;

    return row ? parseRow(row) : null;
  }

  /**
   * Get all preferences for a subject.
   */
  getForSubject(subject: string, domain?: string): Preference[] {
    let sql = 'SELECT * FROM preferences WHERE subject = ?';
    const params: string[] = [subject];

    if (domain) {
      sql += ' AND domain = ?';
      params.push(domain);
    }

    sql += ' ORDER BY domain, key';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseRow);
  }

  /**
   * Search preferences by value content.
   */
  search(query: string, subject?: string): Preference[] {
    let sql = 'SELECT * FROM preferences WHERE (value LIKE ? OR key LIKE ?)';
    const params: string[] = [`%${query}%`, `%${query}%`];

    if (subject) {
      sql += ' AND subject = ?';
      params.push(subject);
    }

    sql += ' ORDER BY confidence DESC LIMIT 20';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseRow);
  }

  /**
   * Delete a preference.
   */
  delete(subject: string, key: string, domain: string = 'general'): boolean {
    const result = this.db.prepare(
      'DELETE FROM preferences WHERE subject = ? AND domain = ? AND key = ?'
    ).run(subject, domain, key);

    return (result as unknown as { changes: number }).changes > 0;
  }
}
