/**
 * hypermem Contradiction Audit Store
 *
 * Lightweight audit trail for contradiction detections during background indexing.
 * Records when the indexer identifies a new fact candidate that contradicts an
 * existing stored fact, without auto-resolving (autoResolve: false path).
 *
 * Stored in library.db under the contradiction_audits table (created on demand).
 * Used for observability and future contradiction resolution tooling.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ContradictionCandidate } from './contradiction-detector.js';
export interface ContradictionAuditEntry {
    id: number;
    agentId: string;
    newContent: string;
    newDomain: string | null;
    existingFactId: number;
    existingContent: string;
    similarityScore: number;
    contradictionScore: number;
    reason: string;
    sourceRef: string | null;
    createdAt: string;
}
export declare class ContradictionAuditStore {
    private readonly db;
    constructor(db: DatabaseSync);
    private ensureTable;
    /**
     * Record a detected contradiction between a new fact candidate and an existing fact.
     *
     * @param agentId     - Agent whose fact was being indexed
     * @param newFact     - The incoming fact candidate (not yet stored)
     * @param candidate   - The contradiction candidate from ContradictionDetector
     * @param opts        - Optional metadata (sourceRef = "msg:<id>" etc.)
     */
    recordFactAudit(agentId: string, newFact: {
        content: string;
        domain?: string | null;
    }, candidate: ContradictionCandidate, opts?: {
        sourceRef?: string;
        status?: string;
    }): void;
    /**
     * Fetch recent audit entries for an agent (most recent first).
     */
    getRecentAudits(agentId: string, limit?: number): ContradictionAuditEntry[];
    /**
     * Count unresolved audits for an agent.
     */
    countAudits(agentId: string): number;
}
//# sourceMappingURL=contradiction-audit-store.d.ts.map