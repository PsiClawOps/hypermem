/**
 * hypermem Compaction Fence
 *
 * Protects the recent conversation tail from being compacted.
 *
 * The fence is a per-conversation high-water mark (message ID) that divides
 * the message timeline into two zones:
 *
 *   - ABOVE the fence: messages the LLM can currently see (recent tail).
 *     These are off-limits to compaction.
 *   - BELOW the fence: older messages eligible for compaction/summarization.
 *
 * The compositor updates the fence every compose cycle by recording the
 * oldest message ID that was included in the composed context. This means
 * the fence automatically advances as conversations grow.
 *
 * Safety defaults:
 *   - No fence row = no compaction allowed (explicit opt-in)
 *   - Fence never moves backward (monotone progress)
 *   - Fence update is idempotent (same value = no-op)
 *
 * Inspired by the continuity model in openclaw-memory-libravdb, which
 * formally proves that compaction must never touch the recent tail.
 */
import type { DatabaseSync } from 'node:sqlite';
export interface CompactionFence {
    conversationId: number;
    /** Message ID of the oldest message currently visible to the LLM */
    fenceMessageId: number;
    /** Timestamp of the last fence update */
    updatedAt: string;
}
export interface CompactionEligibility {
    conversationId: number;
    /** Total messages below the fence (eligible for compaction) */
    eligibleCount: number;
    /** Message ID of the oldest eligible message */
    oldestEligibleId: number | null;
    /** Message ID of the newest eligible message (just below fence) */
    newestEligibleId: number | null;
    /** The fence itself */
    fence: CompactionFence | null;
}
export interface UpdateCompactionFenceOptions {
    /**
     * Minimum number of most-recent non-system messages that must remain above
     * the fence. Prevents compaction from fencing off the live conversational
     * tail under pressure.
     */
    minTailMessages?: number;
}
/**
 * Add the compaction_fences table to an existing messages.db.
 * Idempotent — safe to call on every startup.
 */
export declare function ensureCompactionFenceSchema(db: DatabaseSync): void;
/**
 * Update the compaction fence for a conversation.
 *
 * Called by the compositor after assembling context, passing the ID of
 * the oldest message that was included in the composed history.
 *
 * The fence only moves forward (monotone progress). If the new fence
 * is lower than the existing one, the update is silently ignored.
 * This prevents a short compose window from accidentally exposing
 * already-compacted messages.
 */
export declare function updateCompactionFence(db: DatabaseSync, conversationId: number, oldestVisibleMessageId: number, opts?: UpdateCompactionFenceOptions): void;
/**
 * Get the current compaction fence for a conversation.
 * Returns null if no fence has been set (meaning: no compaction allowed).
 */
export declare function getCompactionFence(db: DatabaseSync, conversationId: number): CompactionFence | null;
/**
 * Query compaction eligibility for a conversation.
 *
 * Returns the count and range of messages that are below the fence
 * and therefore eligible for compaction. If no fence exists, returns
 * zero eligible (safe default: no fence = no compaction).
 *
 * Excludes messages that are already covered by a summary
 * (via the summary_messages junction table).
 */
export declare function getCompactionEligibility(db: DatabaseSync, conversationId: number): CompactionEligibility;
/**
 * Get messages eligible for compaction (below the fence, not yet summarized).
 *
 * Returns messages in chronological order, ready for clustering.
 * Respects the fence boundary and excludes already-summarized messages.
 */
export declare function getCompactableMessages(db: DatabaseSync, conversationId: number, limit?: number): Array<{
    id: number;
    role: string;
    textContent: string;
    createdAt: string;
}>;
//# sourceMappingURL=compaction-fence.d.ts.map