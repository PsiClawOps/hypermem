/**
 * hypermem System Registry Store
 *
 * Server config, service states, operational flags.
 * Lives in the central library DB.
 * The source of truth for "what's running and what state is it in."
 */
function nowIso() {
    return new Date().toISOString();
}
function parseStateRow(row) {
    let value;
    try {
        value = JSON.parse(row.value);
    }
    catch {
        value = row.value;
    }
    return {
        id: row.id,
        category: row.category,
        key: row.key,
        value,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by || null,
        ttl: row.ttl || null,
    };
}
function parseEventRow(row) {
    let oldValue;
    let newValue;
    let metadata = null;
    try {
        oldValue = row.old_value ? JSON.parse(row.old_value) : null;
    }
    catch {
        oldValue = row.old_value;
    }
    try {
        newValue = row.new_value ? JSON.parse(row.new_value) : null;
    }
    catch {
        newValue = row.new_value;
    }
    try {
        metadata = row.metadata ? JSON.parse(row.metadata) : null;
    }
    catch { /* ignore */ }
    return {
        id: row.id,
        category: row.category,
        key: row.key,
        eventType: row.event_type,
        oldValue,
        newValue,
        agentId: row.agent_id || null,
        createdAt: row.created_at,
        metadata,
    };
}
export class SystemStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Set a system state value. Records a change event if the value changed.
     */
    set(category, key, value, opts) {
        const now = nowIso();
        const valueStr = JSON.stringify(value);
        // Get old value for change tracking
        const old = this.db.prepare('SELECT value FROM system_state WHERE category = ? AND key = ?').get(category, key);
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
        return this.get(category, key);
    }
    /**
     * Get a system state value.
     */
    get(category, key) {
        const row = this.db.prepare('SELECT * FROM system_state WHERE category = ? AND key = ?').get(category, key);
        if (!row)
            return null;
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
    getCategory(category) {
        const rows = this.db.prepare('SELECT * FROM system_state WHERE category = ? ORDER BY key').all(category);
        return rows.map(parseStateRow).filter(s => {
            if (s.ttl && new Date(s.ttl) < new Date())
                return false;
            return true;
        });
    }
    /**
     * Delete a system state entry.
     */
    delete(category, key, agentId) {
        const old = this.db.prepare('SELECT value FROM system_state WHERE category = ? AND key = ?').get(category, key);
        const result = this.db.prepare('DELETE FROM system_state WHERE category = ? AND key = ?').run(category, key);
        if (old && result.changes > 0) {
            this.db.prepare(`
        INSERT INTO system_events (category, key, event_type, old_value, agent_id, created_at)
        VALUES (?, ?, 'deleted', ?, ?, ?)
      `).run(category, key, old.value, agentId || null, nowIso());
        }
        return result.changes > 0;
    }
    /**
     * Record an event without changing state (e.g., restart, error, warning).
     */
    recordEvent(category, key, eventType, opts) {
        this.db.prepare(`
      INSERT INTO system_events (category, key, event_type, agent_id, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(category, key, eventType, opts?.agentId || null, nowIso(), opts?.metadata ? JSON.stringify(opts.metadata) : null);
    }
    /**
     * Get recent events for a category/key.
     */
    getEvents(opts) {
        let sql = 'SELECT * FROM system_events WHERE 1=1';
        const params = [];
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
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseEventRow);
    }
    /**
     * Prune expired TTL entries.
     */
    pruneExpired() {
        const now = nowIso();
        const result = this.db.prepare("DELETE FROM system_state WHERE ttl IS NOT NULL AND ttl < ?").run(now);
        return result.changes;
    }
}
//# sourceMappingURL=system-store.js.map