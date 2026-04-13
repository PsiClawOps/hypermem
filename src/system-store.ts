/**
 * hypermem System Registry Store
 *
 * Server config, service states, operational flags.
 * Lives in the central library DB.
 * The source of truth for "what's running and what state is it in."
 */

import type { DatabaseSync } from 'node:sqlite';

function nowIso(): string {
  return new Date().toISOString();
}

export interface SystemState {
  id: number;
  category: string;
  key: string;
  value: unknown;
  updatedAt: string;
  updatedBy: string | null;
  ttl: string | null;
}

export interface SystemEvent {
  id: number;
  category: string;
  key: string;
  eventType: string;
  oldValue: unknown;
  newValue: unknown;
  agentId: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

function parseStateRow(row: Record<string, unknown>): SystemState {
  let value: unknown;
  try { value = JSON.parse(row.value as string); } catch { value = row.value; }
  return {
    id: row.id as number,
    category: row.category as string,
    key: row.key as string,
    value,
    updatedAt: row.updated_at as string,
    updatedBy: (row.updated_by as string) || null,
    ttl: (row.ttl as string) || null,
  };
}

function parseEventRow(row: Record<string, unknown>): SystemEvent {
  let oldValue: unknown;
  let newValue: unknown;
  let metadata: Record<string, unknown> | null = null;
  try { oldValue = row.old_value ? JSON.parse(row.old_value as string) : null; } catch { oldValue = row.old_value; }
  try { newValue = row.new_value ? JSON.parse(row.new_value as string) : null; } catch { newValue = row.new_value; }
  try { metadata = row.metadata ? JSON.parse(row.metadata as string) : null; } catch { /* ignore */ }

  return {
    id: row.id as number,
    category: row.category as string,
    key: row.key as string,
    eventType: row.event_type as string,
    oldValue,
    newValue,
    agentId: (row.agent_id as string) || null,
    createdAt: row.created_at as string,
    metadata,
  };
}

export class SystemStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Set a system state value. Records a change event if the value changed.
   */
  set(
    category: string,
    key: string,
    value: unknown,
    opts?: {
      updatedBy?: string;
      ttl?: string;
    }
  ): SystemState {
    const now = nowIso();
    const valueStr = JSON.stringify(value);

    // Get old value for change tracking
    const old = this.db.prepare(
      'SELECT value FROM system_state WHERE category = ? AND key = ?'
    ).get(category, key) as { value: string } | undefined;

    this.db.prepare(`
      INSERT INTO system_state (category, key, value, updated_at, updated_by, ttl)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(category, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by,
        ttl = COALESCE(excluded.ttl, ttl)
    `).run(category, key, valueStr, now, opts?.updatedBy || null, opts?.ttl || null);

    // Record change event if value actually changed
    if (!old || old.value !== valueStr) {
      this.db.prepare(`
        INSERT INTO system_events (category, key, event_type, old_value, new_value, agent_id, created_at)
        VALUES (?, ?, 'changed', ?, ?, ?, ?)
      `).run(category, key, old?.value || null, valueStr, opts?.updatedBy || null, now);
    }

    return this.get(category, key)!;
  }

  /**
   * Get a system state value.
   */
  get(category: string, key: string): SystemState | null {
    const row = this.db.prepare(
      'SELECT * FROM system_state WHERE category = ? AND key = ?'
    ).get(category, key) as Record<string, unknown> | undefined;

    if (!row) return null;

    // Check TTL
    const state = parseStateRow(row);
    if (state.ttl) {
      const ttlDate = new Date(state.ttl);
      if (ttlDate < new Date()) {
        // Expired — delete and return null
        this.db.prepare('DELETE FROM system_state WHERE category = ? AND key = ?')
          .run(category, key);
        return null;
      }
    }

    return state;
  }

  /**
   * Get all state in a category.
   */
  getCategory(category: string): SystemState[] {
    const rows = this.db.prepare(
      'SELECT * FROM system_state WHERE category = ? ORDER BY key'
    ).all(category) as Record<string, unknown>[];

    return rows.map(parseStateRow).filter(s => {
      if (s.ttl && new Date(s.ttl) < new Date()) return false;
      return true;
    });
  }

  /**
   * Delete a system state entry.
   */
  delete(category: string, key: string, agentId?: string): boolean {
    const old = this.db.prepare(
      'SELECT value FROM system_state WHERE category = ? AND key = ?'
    ).get(category, key) as { value: string } | undefined;

    const result = this.db.prepare(
      'DELETE FROM system_state WHERE category = ? AND key = ?'
    ).run(category, key);

    if (old && (result as unknown as { changes: number }).changes > 0) {
      this.db.prepare(`
        INSERT INTO system_events (category, key, event_type, old_value, agent_id, created_at)
        VALUES (?, ?, 'deleted', ?, ?, ?)
      `).run(category, key, old.value, agentId || null, nowIso());
    }

    return (result as unknown as { changes: number }).changes > 0;
  }

  /**
   * Record an event without changing state (e.g., restart, error, warning).
   */
  recordEvent(
    category: string,
    key: string,
    eventType: string,
    opts?: {
      agentId?: string;
      metadata?: Record<string, unknown>;
    }
  ): void {
    this.db.prepare(`
      INSERT INTO system_events (category, key, event_type, agent_id, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      category,
      key,
      eventType,
      opts?.agentId || null,
      nowIso(),
      opts?.metadata ? JSON.stringify(opts.metadata) : null
    );
  }

  /**
   * Get recent events for a category/key.
   */
  getEvents(opts?: {
    category?: string;
    key?: string;
    eventType?: string;
    since?: string;
    limit?: number;
  }): SystemEvent[] {
    let sql = 'SELECT * FROM system_events WHERE 1=1';
    const params: (string | number)[] = [];

    if (opts?.category) {
      sql += ' AND category = ?';
      params.push(opts.category);
    }
    if (opts?.key) {
      sql += ' AND key = ?';
      params.push(opts.key);
    }
    if (opts?.eventType) {
      sql += ' AND event_type = ?';
      params.push(opts.eventType);
    }
    if (opts?.since) {
      sql += ' AND created_at > ?';
      params.push(opts.since);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(opts?.limit || 50);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseEventRow);
  }

  /**
   * Prune expired TTL entries.
   */
  pruneExpired(): number {
    const now = nowIso();
    const result = this.db.prepare(
      "DELETE FROM system_state WHERE ttl IS NOT NULL AND ttl < ?"
    ).run(now);

    return (result as unknown as { changes: number }).changes;
  }
}
