/**
 * HyperMem Work Item Store
 *
 * Fleet kanban board in SQL. Replaces WORKQUEUE.md.
 * Lives in the central library DB.
 */

import type { DatabaseSync } from 'node:sqlite';

function nowIso(): string {
  return new Date().toISOString();
}

export type WorkStatus = 'incoming' | 'active' | 'blocked' | 'review' | 'completed' | 'cancelled';

export interface WorkItem {
  id: string;
  title: string;
  description: string | null;
  status: WorkStatus;
  priority: number;
  agentId: string | null;
  createdBy: string;
  domain: string | null;
  parentId: string | null;
  blockedBy: string | null;
  sessionKey: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  dueAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface WorkEvent {
  id: number;
  workItemId: string;
  eventType: string;
  oldStatus: string | null;
  newStatus: string | null;
  agentId: string | null;
  comment: string | null;
  createdAt: string;
}

function parseItemRow(row: Record<string, unknown>): WorkItem {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) || null,
    status: row.status as WorkStatus,
    priority: row.priority as number,
    agentId: (row.agent_id as string) || null,
    createdBy: row.created_by as string,
    domain: (row.domain as string) || null,
    parentId: (row.parent_id as string) || null,
    blockedBy: (row.blocked_by as string) || null,
    sessionKey: (row.session_key as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    startedAt: (row.started_at as string) || null,
    completedAt: (row.completed_at as string) || null,
    dueAt: (row.due_at as string) || null,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  };
}

function parseEventRow(row: Record<string, unknown>): WorkEvent {
  return {
    id: row.id as number,
    workItemId: row.work_item_id as string,
    eventType: row.event_type as string,
    oldStatus: (row.old_status as string) || null,
    newStatus: (row.new_status as string) || null,
    agentId: (row.agent_id as string) || null,
    comment: (row.comment as string) || null,
    createdAt: row.created_at as string,
  };
}

/**
 * Generate a work item ID.
 * Uses a 6-hex random suffix (~16.7M daily space) to avoid collisions
 * even under high-frequency bulk creation.
 */
function generateId(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `WQ-${date}-${suffix}`;
}

export class WorkStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Create a new work item.
   */
  create(data: {
    title: string;
    description?: string;
    priority?: number;
    agentId?: string;
    createdBy: string;
    domain?: string;
    parentId?: string;
    dueAt?: string;
    metadata?: Record<string, unknown>;
  }): WorkItem {
    const now = nowIso();
    const id = data.metadata?.id as string || generateId();

    this.db.prepare(`
      INSERT INTO work_items (id, title, description, status, priority, agent_id,
        created_by, domain, parent_id, created_at, updated_at, due_at, metadata)
      VALUES (?, ?, ?, 'incoming', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      data.title,
      data.description || null,
      data.priority || 3,
      data.agentId || null,
      data.createdBy,
      data.domain || null,
      data.parentId || null,
      now,
      now,
      data.dueAt || null,
      data.metadata ? JSON.stringify(data.metadata) : null
    );

    this.recordEvent(id, 'created', null, 'incoming', data.createdBy);

    return this.getItem(id)!;
  }

  /**
   * Update the status of a work item.
   */
  updateStatus(id: string, newStatus: WorkStatus, agentId?: string, comment?: string): WorkItem | null {
    const now = nowIso();
    const current = this.getItem(id);
    if (!current) return null;

    const updates: string[] = ['status = ?', 'updated_at = ?'];
    const params: (string | number | null)[] = [newStatus, now];

    if (newStatus === 'active' && !current.startedAt) {
      updates.push('started_at = ?');
      params.push(now);
    }
    if (newStatus === 'completed' || newStatus === 'cancelled') {
      updates.push('completed_at = ?');
      params.push(now);
    }

    params.push(id);
    this.db.prepare(
      `UPDATE work_items SET ${updates.join(', ')} WHERE id = ?`
    ).run(...params);

    this.recordEvent(id, 'status_changed', current.status, newStatus, agentId, comment);

    return this.getItem(id);
  }

  /**
   * Assign a work item to an agent.
   */
  assign(id: string, agentId: string, assignedBy?: string): WorkItem | null {
    const now = nowIso();
    this.db.prepare(
      'UPDATE work_items SET agent_id = ?, updated_at = ? WHERE id = ?'
    ).run(agentId, now, id);

    this.recordEvent(id, 'assigned', null, null, assignedBy, `Assigned to ${agentId}`);

    return this.getItem(id);
  }

  /**
   * Block a work item.
   */
  block(id: string, blockedBy: string, agentId?: string, reason?: string): WorkItem | null {
    const now = nowIso();
    const current = this.getItem(id);
    if (!current) return null;

    this.db.prepare(
      "UPDATE work_items SET status = 'blocked', blocked_by = ?, updated_at = ? WHERE id = ?"
    ).run(blockedBy, now, id);

    this.recordEvent(id, 'blocked', current.status, 'blocked', agentId, reason || `Blocked by ${blockedBy}`);

    return this.getItem(id);
  }

  /**
   * Get a work item by ID.
   */
  getItem(id: string): WorkItem | null {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;

    return row ? parseItemRow(row) : null;
  }

  /**
   * Get active work for an agent.
   */
  getAgentWork(agentId: string, status?: WorkStatus): WorkItem[] {
    let sql = 'SELECT * FROM work_items WHERE agent_id = ?';
    const params: (string | number)[] = [agentId];

    if (status) {
      sql += ' AND status = ?';
      params.push(status);
    } else {
      sql += " AND status NOT IN ('completed', 'cancelled')";
    }

    sql += ' ORDER BY priority, created_at';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseItemRow);
  }

  /**
   * Get the fleet kanban — all active work grouped by status.
   */
  getKanban(opts?: { domain?: string; agentId?: string }): WorkItem[] {
    let sql = "SELECT * FROM work_items WHERE status NOT IN ('completed', 'cancelled')";
    const params: string[] = [];

    if (opts?.domain) {
      sql += ' AND domain = ?';
      params.push(opts.domain);
    }
    if (opts?.agentId) {
      sql += ' AND agent_id = ?';
      params.push(opts.agentId);
    }

    sql += ' ORDER BY status, priority, created_at';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseItemRow);
  }

  /**
   * Get blocked items across the fleet.
   */
  getBlocked(): WorkItem[] {
    const rows = this.db.prepare(
      "SELECT * FROM work_items WHERE status = 'blocked' ORDER BY priority, created_at"
    ).all() as Record<string, unknown>[];

    return rows.map(parseItemRow);
  }

  /**
   * Get completion stats for the fleet.
   */
  getStats(opts?: { agentId?: string; since?: string }): {
    total: number;
    incoming: number;
    active: number;
    blocked: number;
    review: number;
    completed: number;
    cancelled: number;
    avgDurationHours: number | null;
  } {
    let sql = 'SELECT status, COUNT(*) as cnt FROM work_items';
    const params: string[] = [];
    const conditions: string[] = [];

    if (opts?.agentId) {
      conditions.push('agent_id = ?');
      params.push(opts.agentId);
    }
    if (opts?.since) {
      conditions.push('created_at >= ?');
      params.push(opts.since);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' GROUP BY status';

    const rows = this.db.prepare(sql).all(...params) as Array<{ status: string; cnt: number }>;

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      counts[r.status] = r.cnt;
      total += r.cnt;
    }

    // Avg duration for completed items
    let avgSql = `
      SELECT AVG(julianday(completed_at) - julianday(started_at)) * 24 as avg_hours
      FROM work_items WHERE status = 'completed' AND started_at IS NOT NULL
    `;
    const avgParams: string[] = [];
    if (opts?.agentId) {
      avgSql += ' AND agent_id = ?';
      avgParams.push(opts.agentId);
    }
    if (opts?.since) {
      avgSql += ' AND completed_at >= ?';
      avgParams.push(opts.since);
    }

    const avgRow = this.db.prepare(avgSql).get(...avgParams) as { avg_hours: number | null };

    return {
      total,
      incoming: counts['incoming'] || 0,
      active: counts['active'] || 0,
      blocked: counts['blocked'] || 0,
      review: counts['review'] || 0,
      completed: counts['completed'] || 0,
      cancelled: counts['cancelled'] || 0,
      avgDurationHours: avgRow?.avg_hours || null,
    };
  }

  /**
   * Get events for a work item.
   */
  getEvents(workItemId: string, limit: number = 50): WorkEvent[] {
    const rows = this.db.prepare(
      'SELECT * FROM work_events WHERE work_item_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(workItemId, limit) as Record<string, unknown>[];

    return rows.map(parseEventRow);
  }

  /**
   * Search work items.
   */
  search(query: string, limit: number = 20): WorkItem[] {
    try {
      const rows = this.db.prepare(`
        SELECT w.* FROM work_items w
        JOIN work_items_fts fts ON w.rowid = fts.rowid
        WHERE work_items_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit) as Record<string, unknown>[];

      return rows.map(parseItemRow);
    } catch {
      // FTS fallback
      const rows = this.db.prepare(`
        SELECT * FROM work_items
        WHERE title LIKE ? OR description LIKE ?
        ORDER BY priority, created_at DESC
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, limit) as Record<string, unknown>[];

      return rows.map(parseItemRow);
    }
  }

  // ── Private helpers ─────────────────────────────────────────

  private recordEvent(
    workItemId: string,
    eventType: string,
    oldStatus: string | null,
    newStatus: string | null,
    agentId?: string,
    comment?: string
  ): void {
    this.db.prepare(`
      INSERT INTO work_events (work_item_id, event_type, old_status, new_status, agent_id, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workItemId, eventType, oldStatus, newStatus, agentId || null, comment || null, nowIso());
  }
}
