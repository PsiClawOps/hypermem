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

import type { DatabaseSync } from 'node:sqlite';

function nowIso(): string {
  return new Date().toISOString();
}

export type DriftStatus = 'ok' | 'drifted' | 'unknown' | 'error';

export interface DesiredStateEntry {
  agentId: string;
  configKey: string;
  desiredValue: unknown;
  actualValue: unknown | null;
  source: string;
  setBy: string | null;
  driftStatus: DriftStatus;
  lastChecked: string | null;
  createdAt: string;
  updatedAt: string;
  notes: string | null;
}

export interface ConfigEvent {
  id: number;
  agentId: string;
  configKey: string;
  eventType: string;
  oldValue: unknown | null;
  newValue: unknown | null;
  changedBy: string | null;
  createdAt: string;
}

function tryParseJson(val: string): unknown {
  try {
    return JSON.parse(val);
  } catch {
    // Value is a bare string (e.g. model names like "copilot-local/claude-sonnet-4.6")
    // stored without JSON quoting — return as-is.
    return val;
  }
}

function parseEntry(row: Record<string, unknown>): DesiredStateEntry {
  return {
    agentId: row.agent_id as string,
    configKey: row.config_key as string,
    desiredValue: row.desired_value ? tryParseJson(row.desired_value as string) : null,
    actualValue: row.actual_value ? tryParseJson(row.actual_value as string) : null,
    source: row.source as string,
    setBy: (row.set_by as string) || null,
    driftStatus: (row.drift_status as DriftStatus) || 'unknown',
    lastChecked: (row.last_checked as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    notes: (row.notes as string) || null,
  };
}

function parseEvent(row: Record<string, unknown>): ConfigEvent {
  return {
    id: row.id as number,
    agentId: row.agent_id as string,
    configKey: row.config_key as string,
    eventType: row.event_type as string,
    oldValue: row.old_value ? tryParseJson(row.old_value as string) : null,
    newValue: row.new_value ? tryParseJson(row.new_value as string) : null,
    changedBy: (row.changed_by as string) || null,
    createdAt: row.created_at as string,
  };
}

export class DesiredStateStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Set desired state for a config key on an agent.
   */
  setDesired(agentId: string, configKey: string, desiredValue: unknown, opts?: {
    source?: string;
    setBy?: string;
    notes?: string;
  }): DesiredStateEntry {
    const now = nowIso();
    const valueJson = JSON.stringify(desiredValue);

    const existing = this.getEntry(agentId, configKey);

    if (existing) {
      // Record change event
      this.db.prepare(`
        INSERT INTO agent_config_events (agent_id, config_key, event_type, old_value, new_value, changed_by, created_at)
        VALUES (?, ?, 'desired_changed', ?, ?, ?, ?)
      `).run(
        agentId, configKey,
        JSON.stringify(existing.desiredValue),
        valueJson,
        opts?.setBy || null,
        now
      );

      this.db.prepare(`
        UPDATE agent_desired_state SET
          desired_value = ?,
          source = COALESCE(?, source),
          set_by = COALESCE(?, set_by),
          drift_status = 'unknown',
          notes = COALESCE(?, notes),
          updated_at = ?
        WHERE agent_id = ? AND config_key = ?
      `).run(
        valueJson,
        opts?.source || null,
        opts?.setBy || null,
        opts?.notes || null,
        now,
        agentId,
        configKey
      );
    } else {
      this.db.prepare(`
        INSERT INTO agent_desired_state (agent_id, config_key, desired_value, source, set_by, drift_status, created_at, updated_at, notes)
        VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?, ?)
      `).run(
        agentId,
        configKey,
        valueJson,
        opts?.source || 'operator',
        opts?.setBy || null,
        now,
        now,
        opts?.notes || null
      );

      // Record creation event
      this.db.prepare(`
        INSERT INTO agent_config_events (agent_id, config_key, event_type, new_value, changed_by, created_at)
        VALUES (?, ?, 'desired_set', ?, ?, ?)
      `).run(agentId, configKey, valueJson, opts?.setBy || null, now);
    }

    return this.getEntry(agentId, configKey)!;
  }

  /**
   * Report actual state observed at runtime.
   * Compares against desired and updates drift status.
   */
  reportActual(agentId: string, configKey: string, actualValue: unknown): DriftStatus {
    const now = nowIso();
    const actualJson = JSON.stringify(actualValue);

    const entry = this.getEntry(agentId, configKey);
    if (!entry) return 'unknown';

    const desiredJson = JSON.stringify(entry.desiredValue);
    const driftStatus: DriftStatus = actualJson === desiredJson ? 'ok' : 'drifted';

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
  reportActualBulk(agentId: string, actuals: Record<string, unknown>): Record<string, DriftStatus> {
    const results: Record<string, DriftStatus> = {};
    for (const [key, value] of Object.entries(actuals)) {
      results[key] = this.reportActual(agentId, key, value);
    }
    return results;
  }

  /**
   * Get a specific desired state entry.
   */
  getEntry(agentId: string, configKey: string): DesiredStateEntry | null {
    const row = this.db.prepare(
      'SELECT * FROM agent_desired_state WHERE agent_id = ? AND config_key = ?'
    ).get(agentId, configKey) as Record<string, unknown> | undefined;

    return row ? parseEntry(row) : null;
  }

  /**
   * Get all desired state for an agent.
   */
  getAgentState(agentId: string): DesiredStateEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_desired_state WHERE agent_id = ? ORDER BY config_key'
    ).all(agentId) as Record<string, unknown>[];

    return rows.map(parseEntry);
  }

  /**
   * Get desired state as a flat config object (key → value).
   */
  getAgentConfig(agentId: string): Record<string, unknown> {
    const entries = this.getAgentState(agentId);
    const config: Record<string, unknown> = {};
    for (const entry of entries) {
      config[entry.configKey] = entry.desiredValue;
    }
    return config;
  }

  /**
   * Get all drifted entries across the fleet.
   */
  getDrifted(): DesiredStateEntry[] {
    const rows = this.db.prepare(
      "SELECT * FROM agent_desired_state WHERE drift_status = 'drifted' ORDER BY agent_id, config_key"
    ).all() as Record<string, unknown>[];

    return rows.map(parseEntry);
  }

  /**
   * Get fleet-wide view of a specific config key.
   */
  getFleetConfig(configKey: string): DesiredStateEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_desired_state WHERE config_key = ? ORDER BY agent_id'
    ).all(configKey) as Record<string, unknown>[];

    return rows.map(parseEntry);
  }

  /**
   * Get config change history for an agent/key.
   */
  getHistory(agentId: string, configKey?: string, limit: number = 20): ConfigEvent[] {
    let sql = 'SELECT * FROM agent_config_events WHERE agent_id = ?';
    const params: (string | number)[] = [agentId];

    if (configKey) {
      sql += ' AND config_key = ?';
      params.push(configKey);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseEvent);
  }

  /**
   * Remove a desired state entry.
   */
  removeDesired(agentId: string, configKey: string, removedBy?: string): void {
    const now = nowIso();
    const existing = this.getEntry(agentId, configKey);

    if (existing) {
      this.db.prepare(`
        INSERT INTO agent_config_events (agent_id, config_key, event_type, old_value, changed_by, created_at)
        VALUES (?, ?, 'desired_removed', ?, ?, ?)
      `).run(agentId, configKey, JSON.stringify(existing.desiredValue), removedBy || null, now);

      this.db.prepare(
        'DELETE FROM agent_desired_state WHERE agent_id = ? AND config_key = ?'
      ).run(agentId, configKey);
    }
  }

  /**
   * Get fleet drift summary.
   */
  getDriftSummary(): { total: number; ok: number; drifted: number; unknown: number; error: number } {
    const rows = this.db.prepare(`
      SELECT drift_status, COUNT(*) as count FROM agent_desired_state GROUP BY drift_status
    `).all() as Array<{ drift_status: string; count: number }>;

    const summary = { total: 0, ok: 0, drifted: 0, unknown: 0, error: 0 };
    for (const row of rows) {
      const count = row.count;
      summary.total += count;
      if (row.drift_status in summary) {
        (summary as Record<string, number>)[row.drift_status] = count;
      }
    }
    return summary;
  }
}
