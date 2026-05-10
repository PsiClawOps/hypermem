/**
 * entity-bridge-backfill.ts \u2014 Sprint B
 *
 * operator-run backfill for the entity/grace bridge index.
 *
 * Constraints (Sprint B planner):
 *   - Never runs at startup.
 *   - Only ever invoked through scripts/backfill-entity-bridge.mjs.
 *   - Counts only \u2014 never logs message content.
 *
 * Usage (from script):
 *   const summary = await runEntityBridgeBackfill(db, {
 *     agentId: 'forge',
 *     batchSize: 200,
 *     limit: 5000,
 *     dryRun: false,
 *     resume: true,
 *     sinceMessageId: 12345,
 *     reconcile: false,
 *   });
 */
import type { DatabaseSync } from 'node:sqlite';
export interface BackfillOptions {
    agentId?: string;
    /** Rows fetched per scan tick. Default 200. */
    batchSize?: number;
    /** Hard cap on total messages scanned. Default Infinity. */
    limit?: number;
    /** When true, do not write any rows. Default false. */
    dryRun?: boolean;
    /** When true, skip messages already in entity_bridge_message_index. Default true. */
    resume?: boolean;
    /** Lower bound on message id (exclusive of \u2018already done\u2019 unless reconcile). */
    sinceMessageId?: number;
    /**
     * When true, reprocess messages that already have an index row. Defaults to
     * false. Reconcile mode still respects `limit`.
     */
    reconcile?: boolean;
    /** Optional progress sink. Receives counts only. */
    onProgress?: (s: BackfillProgress) => void;
}
export interface BackfillProgress {
    scanned: number;
    written: number;
    skipped: number;
    failed: number;
    zeroMention: number;
    highestMessageId: number | null;
}
export interface BackfillSummary extends BackfillProgress {
    dryRun: boolean;
    reconcile: boolean;
    agentId?: string;
    durationMs: number;
    bridgeTablesPresent: boolean;
}
/**
 * Run the backfill. Returns a counts-only summary suitable for logging.
 *
 * On any per-message extraction error we record a 'failed' index row (when
 * not in dry-run mode) and continue. The whole run never throws unless the
 * DB itself is broken.
 */
export declare function runEntityBridgeBackfill(db: DatabaseSync, opts?: BackfillOptions): Promise<BackfillSummary>;
//# sourceMappingURL=entity-bridge-backfill.d.ts.map