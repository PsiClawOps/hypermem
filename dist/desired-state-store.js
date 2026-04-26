/**
 * hypermem Agent Desired State Store
 *
 * Stores intended configuration for each agent and tracks drift.
 * Enables fleet-wide config visibility and enforcement.
 *
 * Config keys are dot-path strings matching openclaw.json structure:
 *   model, thinkingDefault, provider, workspace, tools.exec.host, etc.
 *
 * Drift statuses:
 *   - 'ok'       — actual matches desired
 *   - 'drifted'  — actual differs from desired
 *   - 'unknown'  — not yet checked
 *   - 'error'    — check failed
 */
function nowIso() {
    return new Date().toISOString();
}
function tryParseJson(val) {
    try {
        return JSON.parse(val);
    }
    catch {
        // Value is a bare string (e.g. model names like "copilot-local/claude-sonnet-4.6")
        // stored without JSON quoting — return as-is.
        return val;
    }
}
function parseEntry(row) {
    return {
        agentId: row.agent_id,
        configKey: row.config_key,
        desiredValue: row.desired_value ? tryParseJson(row.desired_value) : null,
        actualValue: row.actual_value ? tryParseJson(row.actual_value) : null,
        source: row.source,
        setBy: row.set_by || null,
        driftStatus: row.drift_status || 'unknown',
        lastChecked: row.last_checked || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        notes: row.notes || null,
    };
}
function parseEvent(row) {
    return {
        id: row.id,
        agentId: row.agent_id,
        configKey: row.config_key,
        eventType: row.event_type,
        oldValue: row.old_value ? tryParseJson(row.old_value) : null,
        newValue: row.new_value ? tryParseJson(row.new_value) : null,
        changedBy: row.changed_by || null,
        createdAt: row.created_at,
    };
}
export class DesiredStateStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Set desired state for a config key on an agent.
     */
    setDesired(agentId, configKey, desiredValue, opts) {
        const now = nowIso();
        const valueJson = JSON.stringify(desiredValue);
        const existing = this.getEntry(agentId, configKey);
        if (existing) {
            // Record change event
            this.db.prepare(`
        INSERT INTO agent_config_events (agent_id, config_key, event_type, old_value, new_value, changed_by, created_at)
        VALUES (?, ?, 'desired_changed', ?, ?, ?, ?)
      `).run(agentId, configKey, JSON.stringify(existing.desiredValue), valueJson, opts?.setBy || null, now);
            this.db.prepare(`
        UPDATE agent_desired_state SET
          desired_value = ?,
          source = COALESCE(?, source),
          set_by = COALESCE(?, set_by),
          drift_status = 'unknown',
          notes = COALESCE(?, notes),
          updated_at = ?
        WHERE agent_id = ? AND config_key = ?
      `).run(valueJson, opts?.source || null, opts?.setBy || null, opts?.notes || null, now, agentId, configKey);
        }
        else {
            this.db.prepare(`
        INSERT INTO agent_desired_state (agent_id, config_key, desired_value, source, set_by, drift_status, created_at, updated_at, notes)
        VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?, ?)
      `).run(agentId, configKey, valueJson, opts?.source || 'operator', opts?.setBy || null, now, now, opts?.notes || null);
            // Record creation event
            this.db.prepare(`
        INSERT INTO agent_config_events (agent_id, config_key, event_type, new_value, changed_by, created_at)
        VALUES (?, ?, 'desired_set', ?, ?, ?)
      `).run(agentId, configKey, valueJson, opts?.setBy || null, now);
        }
        return this.getEntry(agentId, configKey);
    }
    /**
     * Report actual state observed at runtime.
     * Compares against desired and updates drift status.
     */
    reportActual(agentId, configKey, actualValue) {
        const now = nowIso();
        const actualJson = JSON.stringify(actualValue);
        const entry = this.getEntry(agentId, configKey);
        if (!entry)
            return 'unknown';
        const desiredJson = JSON.stringify(entry.desiredValue);
        const driftStatus = actualJson === desiredJson ? 'ok' : 'drifted';
        this.db.prepare(`
      UPDATE agent_desired_state SET
        actual_value = ?,
        drift_status = ?,
        last_checked = ?,
        updated_at = ?
      WHERE agent_id = ? AND config_key = ?
    `).run(actualJson, driftStatus, now, now, agentId, configKey);
        if (driftStatus === 'drifted' && actualJson !== JSON.stringify(entry.actualValue)) {
            this.db.prepare(`
        INSERT INTO agent_config_events (agent_id, config_key, event_type, old_value, new_value, changed_by, created_at)
        VALUES (?, ?, 'drift_detected', ?, ?, 'system', ?)
      `).run(agentId, configKey, JSON.stringify(entry.actualValue), actualJson, now);
        }
        return driftStatus;
    }
    /**
     * Bulk report actual state for an agent (e.g., on heartbeat).
     */
    reportActualBulk(agentId, actuals) {
        const results = {};
        for (const [key, value] of Object.entries(actuals)) {
            results[key] = this.reportActual(agentId, key, value);
        }
        return results;
    }
    /**
     * Get a specific desired state entry.
     */
    getEntry(agentId, configKey) {
        const row = this.db.prepare('SELECT * FROM agent_desired_state WHERE agent_id = ? AND config_key = ?').get(agentId, configKey);
        return row ? parseEntry(row) : null;
    }
    /**
     * Get all desired state for an agent.
     */
    getAgentState(agentId) {
        const rows = this.db.prepare('SELECT * FROM agent_desired_state WHERE agent_id = ? ORDER BY config_key').all(agentId);
        return rows.map(parseEntry);
    }
    /**
     * Get desired state as a flat config object (key → value).
     */
    getAgentConfig(agentId) {
        const entries = this.getAgentState(agentId);
        const config = {};
        for (const entry of entries) {
            config[entry.configKey] = entry.desiredValue;
        }
        return config;
    }
    /**
     * Get all drifted entries across the fleet.
     */
    getDrifted() {
        const rows = this.db.prepare("SELECT * FROM agent_desired_state WHERE drift_status = 'drifted' ORDER BY agent_id, config_key").all();
        return rows.map(parseEntry);
    }
    /**
     * Get fleet-wide view of a specific config key.
     */
    getFleetConfig(configKey) {
        const rows = this.db.prepare('SELECT * FROM agent_desired_state WHERE config_key = ? ORDER BY agent_id').all(configKey);
        return rows.map(parseEntry);
    }
    /**
     * Get config change history for an agent/key.
     */
    getHistory(agentId, configKey, limit = 20) {
        let sql = 'SELECT * FROM agent_config_events WHERE agent_id = ?';
        const params = [agentId];
        if (configKey) {
            sql += ' AND config_key = ?';
            params.push(configKey);
        }
        sql += ' ORDER BY created_at DESC LIMIT ?';
        params.push(limit);
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseEvent);
    }
    /**
     * Remove a desired state entry.
     */
    removeDesired(agentId, configKey, removedBy) {
        const now = nowIso();
        const existing = this.getEntry(agentId, configKey);
        if (existing) {
            this.db.prepare(`
        INSERT INTO agent_config_events (agent_id, config_key, event_type, old_value, changed_by, created_at)
        VALUES (?, ?, 'desired_removed', ?, ?, ?)
      `).run(agentId, configKey, JSON.stringify(existing.desiredValue), removedBy || null, now);
            this.db.prepare('DELETE FROM agent_desired_state WHERE agent_id = ? AND config_key = ?').run(agentId, configKey);
        }
    }
    /**
     * Get fleet drift summary.
     */
    getDriftSummary() {
        const rows = this.db.prepare(`
      SELECT drift_status, COUNT(*) as count FROM agent_desired_state GROUP BY drift_status
    `).all();
        const summary = { total: 0, ok: 0, drifted: 0, unknown: 0, error: 0 };
        for (const row of rows) {
            const count = row.count;
            summary.total += count;
            if (row.drift_status in summary) {
                summary[row.drift_status] = count;
            }
        }
        return summary;
    }
}
//# sourceMappingURL=desired-state-store.js.map