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
export declare class DesiredStateStore {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Set desired state for a config key on an agent.
     */
    setDesired(agentId: string, configKey: string, desiredValue: unknown, opts?: {
        source?: string;
        setBy?: string;
        notes?: string;
    }): DesiredStateEntry;
    /**
     * Report actual state observed at runtime.
     * Compares against desired and updates drift status.
     */
    reportActual(agentId: string, configKey: string, actualValue: unknown): DriftStatus;
    /**
     * Bulk report actual state for an agent (e.g., on heartbeat).
     */
    reportActualBulk(agentId: string, actuals: Record<string, unknown>): Record<string, DriftStatus>;
    /**
     * Get a specific desired state entry.
     */
    getEntry(agentId: string, configKey: string): DesiredStateEntry | null;
    /**
     * Get all desired state for an agent.
     */
    getAgentState(agentId: string): DesiredStateEntry[];
    /**
     * Get desired state as a flat config object (key → value).
     */
    getAgentConfig(agentId: string): Record<string, unknown>;
    /**
     * Get all drifted entries across the fleet.
     */
    getDrifted(): DesiredStateEntry[];
    /**
     * Get fleet-wide view of a specific config key.
     */
    getFleetConfig(configKey: string): DesiredStateEntry[];
    /**
     * Get config change history for an agent/key.
     */
    getHistory(agentId: string, configKey?: string, limit?: number): ConfigEvent[];
    /**
     * Remove a desired state entry.
     */
    removeDesired(agentId: string, configKey: string, removedBy?: string): void;
    /**
     * Get fleet drift summary.
     */
    getDriftSummary(): {
        total: number;
        ok: number;
        drifted: number;
        unknown: number;
        error: number;
    };
}
//# sourceMappingURL=desired-state-store.d.ts.map