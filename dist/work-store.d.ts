/**
 * hypermem Work Item Store
 *
 * Fleet kanban board in SQL. Replaces WORKQUEUE.md.
 * Lives in the central library DB.
 */
import type { DatabaseSync } from 'node:sqlite';
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
export declare class WorkStore {
    private readonly db;
    constructor(db: DatabaseSync);
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
    }): WorkItem;
    /**
     * Update the status of a work item.
     */
    updateStatus(id: string, newStatus: WorkStatus, agentId?: string, comment?: string): WorkItem | null;
    /**
     * Assign a work item to an agent.
     */
    assign(id: string, agentId: string, assignedBy?: string): WorkItem | null;
    /**
     * Block a work item.
     */
    block(id: string, blockedBy: string, agentId?: string, reason?: string): WorkItem | null;
    /**
     * Get a work item by ID.
     */
    getItem(id: string): WorkItem | null;
    /**
     * Get active work for an agent.
     */
    getAgentWork(agentId: string, status?: WorkStatus): WorkItem[];
    /**
     * Get the fleet kanban — all active work grouped by status.
     */
    getKanban(opts?: {
        domain?: string;
        agentId?: string;
    }): WorkItem[];
    /**
     * Get blocked items across the fleet.
     */
    getBlocked(): WorkItem[];
    /**
     * Get completion stats for the fleet.
     */
    getStats(opts?: {
        agentId?: string;
        since?: string;
    }): {
        total: number;
        incoming: number;
        active: number;
        blocked: number;
        review: number;
        completed: number;
        cancelled: number;
        avgDurationHours: number | null;
    };
    /**
     * Get events for a work item.
     */
    getEvents(workItemId: string, limit?: number): WorkEvent[];
    /**
     * Search work items.
     */
    search(query: string, limit?: number): WorkItem[];
    private recordEvent;
}
//# sourceMappingURL=work-store.d.ts.map