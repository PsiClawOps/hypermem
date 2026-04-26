import type { DatabaseSync } from 'node:sqlite';
import { type SnapshotIntegrityVerification, type SnapshotSlotsRecord } from './composition-snapshot-integrity.js';
export interface CompositionSnapshotRecord {
    id: number;
    contextId: number;
    headMessageId: number | null;
    schemaVersion: number;
    capturedAt: string;
    model: string;
    contextWindow: number;
    totalTokens: number;
    fillPct: number;
    snapshotKind: string;
    repairDepth: number;
    slotsJson: string;
    slotsIntegrityHash: string;
    createdAt: string;
}
export interface InsertCompositionSnapshotInput {
    contextId: number;
    headMessageId?: number | null;
    schemaVersion?: number;
    capturedAt?: string;
    model: string;
    contextWindow: number;
    totalTokens: number;
    fillPct: number;
    snapshotKind?: string;
    repairDepth?: number;
    slots: SnapshotSlotsRecord | string;
    createdAt?: string;
}
export interface LatestValidCompositionSnapshot {
    snapshot: CompositionSnapshotRecord;
    verification: SnapshotIntegrityVerification;
    fallbackUsed: boolean;
}
export declare const MAX_WARM_RESTORE_REPAIR_DEPTH = 1;
export declare function insertCompositionSnapshot(db: DatabaseSync, input: InsertCompositionSnapshotInput): CompositionSnapshotRecord;
export declare function listCompositionSnapshots(db: DatabaseSync, contextId: number, limit?: number): CompositionSnapshotRecord[];
export declare function getCompositionSnapshot(db: DatabaseSync, snapshotId: number): CompositionSnapshotRecord | null;
export declare function verifyCompositionSnapshot(snapshot: CompositionSnapshotRecord): SnapshotIntegrityVerification;
export declare function getLatestValidCompositionSnapshot(db: DatabaseSync, contextId: number): LatestValidCompositionSnapshot | null;
//# sourceMappingURL=composition-snapshot-store.d.ts.map