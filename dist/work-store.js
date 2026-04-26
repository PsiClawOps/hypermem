/**
 * hypermem Work Item Store
 *
 * Fleet kanban board in SQL. Replaces WORKQUEUE.md.
 * Lives in the central library DB.
 */
function nowIso() {
    return new Date().toISOString();
}
function parseItemRow(row) {
    return {
        id: row.id,
        title: row.title,
        description: row.description || null,
        status: row.status,
        priority: row.priority,
        agentId: row.agent_id || null,
        createdBy: row.created_by,
        domain: row.domain || null,
        parentId: row.parent_id || null,
        blockedBy: row.blocked_by || null,
        sessionKey: row.session_key || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at || null,
        completedAt: row.completed_at || null,
        dueAt: row.due_at || null,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
}
function parseEventRow(row) {
    return {
        id: row.id,
        workItemId: row.work_item_id,
        eventType: row.event_type,
        oldStatus: row.old_status || null,
        newStatus: row.new_status || null,
        agentId: row.agent_id || null,
        comment: row.comment || null,
        createdAt: row.created_at,
    };
}
/**
 * Generate a work item ID candidate.
 * Uses a 6-hex random suffix (~16.7M daily space).
 */
function generateIdCandidate() {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const suffix = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    return `WQ-${date}-${suffix}`;
}
export class WorkStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Create a new work item.
     */
    create(data) {
        const now = nowIso();
        // Use caller-supplied ID if provided, otherwise generate with retry-on-conflict.
        // Random suffix collisions are rare but possible under bulk creation — retry
        // up to 10 times before giving up. Each retry picks a new random suffix.
        const callerSuppliedId = data.metadata?.id;
        let id = callerSuppliedId || generateIdCandidate();
        let attempts = 0;
        while (attempts < 10) {
            const existing = this.db
                .prepare('SELECT id FROM work_items WHERE id = ?')
                .get(id);
            if (!existing)
                break;
            if (callerSuppliedId) {
                throw new Error(`Work item ID already exists: ${id}`);
            }
            id = generateIdCandidate();
            attempts++;
        }
        this.db.prepare(`
      INSERT INTO work_items (id, title, description, status, priority, agent_id,
        created_by, domain, parent_id, created_at, updated_at, due_at, metadata)
      VALUES (?, ?, ?, 'incoming', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.title, data.description || null, data.priority || 3, data.agentId || null, data.createdBy, data.domain || null, data.parentId || null, now, now, data.dueAt || null, data.metadata ? JSON.stringify(data.metadata) : null);
        this.recordEvent(id, 'created', null, 'incoming', data.createdBy);
        return this.getItem(id);
    }
    /**
     * Update the status of a work item.
     */
    updateStatus(id, newStatus, agentId, comment) {
        const now = nowIso();
        const current = this.getItem(id);
        if (!current)
            return null;
        const updates = ['status = ?', 'updated_at = ?'];
        const params = [newStatus, now];
        if (newStatus === 'active' && !current.startedAt) {
            updates.push('started_at = ?');
            params.push(now);
        }
        if (newStatus === 'completed' || newStatus === 'cancelled') {
            updates.push('completed_at = ?');
            params.push(now);
        }
        params.push(id);
        this.db.prepare(`UPDATE work_items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        this.recordEvent(id, 'status_changed', current.status, newStatus, agentId, comment);
        return this.getItem(id);
    }
    /**
     * Assign a work item to an agent.
     */
    assign(id, agentId, assignedBy) {
        const now = nowIso();
        this.db.prepare('UPDATE work_items SET agent_id = ?, updated_at = ? WHERE id = ?').run(agentId, now, id);
        this.recordEvent(id, 'assigned', null, null, assignedBy, `Assigned to ${agentId}`);
        return this.getItem(id);
    }
    /**
     * Block a work item.
     */
    block(id, blockedBy, agentId, reason) {
        const now = nowIso();
        const current = this.getItem(id);
        if (!current)
            return null;
        this.db.prepare("UPDATE work_items SET status = 'blocked', blocked_by = ?, updated_at = ? WHERE id = ?").run(blockedBy, now, id);
        this.recordEvent(id, 'blocked', current.status, 'blocked', agentId, reason || `Blocked by ${blockedBy}`);
        return this.getItem(id);
    }
    /**
     * Get a work item by ID.
     */
    getItem(id) {
        const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?')
            .get(id);
        return row ? parseItemRow(row) : null;
    }
    /**
     * Get active work for an agent.
     */
    getAgentWork(agentId, status) {
        let sql = 'SELECT * FROM work_items WHERE agent_id = ?';
        const params = [agentId];
        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }
        else {
            sql += " AND status NOT IN ('completed', 'cancelled')";
        }
        sql += ' ORDER BY priority, created_at';
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseItemRow);
    }
    /**
     * Get the fleet kanban — all active work grouped by status.
     */
    getKanban(opts) {
        let sql = "SELECT * FROM work_items WHERE status NOT IN ('completed', 'cancelled')";
        const params = [];
        if (opts?.domain) {
            sql += ' AND domain = ?';
            params.push(opts.domain);
        }
        if (opts?.agentId) {
            sql += ' AND agent_id = ?';
            params.push(opts.agentId);
        }
        sql += ' ORDER BY status, priority, created_at';
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseItemRow);
    }
    /**
     * Get blocked items across the fleet.
     */
    getBlocked() {
        const rows = this.db.prepare("SELECT * FROM work_items WHERE status = 'blocked' ORDER BY priority, created_at").all();
        return rows.map(parseItemRow);
    }
    /**
     * Get completion stats for the fleet.
     */
    getStats(opts) {
        let sql = 'SELECT status, COUNT(*) as cnt FROM work_items';
        const params = [];
        const conditions = [];
        if (opts?.agentId) {
            conditions.push('agent_id = ?');
            params.push(opts.agentId);
        }
        if (opts?.since) {
            conditions.push('created_at >= ?');
            params.push(opts.since);
        }
        if (conditions.length)
            sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' GROUP BY status';
        const rows = this.db.prepare(sql).all(...params);
        const counts = {};
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
        const avgParams = [];
        if (opts?.agentId) {
            avgSql += ' AND agent_id = ?';
            avgParams.push(opts.agentId);
        }
        if (opts?.since) {
            avgSql += ' AND completed_at >= ?';
            avgParams.push(opts.since);
        }
        const avgRow = this.db.prepare(avgSql).get(...avgParams);
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
    getEvents(workItemId, limit = 50) {
        const rows = this.db.prepare('SELECT * FROM work_events WHERE work_item_id = ? ORDER BY created_at DESC LIMIT ?').all(workItemId, limit);
        return rows.map(parseEventRow);
    }
    /**
     * Search work items.
     */
    search(query, limit = 20) {
        try {
            const rows = this.db.prepare(`
        SELECT w.* FROM work_items w
        JOIN work_items_fts fts ON w.rowid = fts.rowid
        WHERE work_items_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit);
            return rows.map(parseItemRow);
        }
        catch {
            // FTS fallback
            const rows = this.db.prepare(`
        SELECT * FROM work_items
        WHERE title LIKE ? OR description LIKE ?
        ORDER BY priority, created_at DESC
        LIMIT ?
      `).all(`%${query}%`, `%${query}%`, limit);
            return rows.map(parseItemRow);
        }
    }
    // ── Private helpers ─────────────────────────────────────────
    recordEvent(workItemId, eventType, oldStatus, newStatus, agentId, comment) {
        this.db.prepare(`
      INSERT INTO work_events (work_item_id, event_type, old_status, new_status, agent_id, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(workItemId, eventType, oldStatus, newStatus, agentId || null, comment || null, nowIso());
    }
}
//# sourceMappingURL=work-store.js.map