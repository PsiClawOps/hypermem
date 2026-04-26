/**
 * hypermem System Registry Store
 *
 * Server config, service states, operational flags.
 * Lives in the central library DB.
 * The source of truth for "what's running and what state is it in."
 */
import type { DatabaseSync } from 'node:sqlite';
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
export declare class SystemStore {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Set a system state value. Records a change event if the value changed.
     */
    set(category: string, key: string, value: unknown, opts?: {
        updatedBy?: string;
        ttl?: string;
    }): SystemState;
    /**
     * Get a system state value.
     */
    get(category: string, key: string): SystemState | null;
    /**
     * Get all state in a category.
     */
    getCategory(category: string): SystemState[];
    /**
     * Delete a system state entry.
     */
    delete(category: string, key: string, agentId?: string): boolean;
    /**
     * Record an event without changing state (e.g., restart, error, warning).
     */
    recordEvent(category: string, key: string, eventType: string, opts?: {
        agentId?: string;
        metadata?: Record<string, unknown>;
    }): void;
    /**
     * Get recent events for a category/key.
     */
    getEvents(opts?: {
        category?: string;
        key?: string;
        eventType?: string;
        since?: string;
        limit?: number;
    }): SystemEvent[];
    /**
     * Prune expired TTL entries.
     */
    pruneExpired(): number;
}
//# sourceMappingURL=system-store.d.ts.map