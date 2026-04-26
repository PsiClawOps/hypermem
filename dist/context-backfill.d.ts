/**
 * hypermem Context Backfill
 *
 * One-time migration that creates context rows for existing conversations
 * that don't yet have an active context. Designed to be idempotent — running
 * it multiple times produces the same result without modifying existing data.
 *
 * Also provides parent chain backfill (Phase 2): reconstructs parent_id/depth
 * for legacy flat conversations that were created before the Turn DAG model.
 */
import type { DatabaseSync } from 'node:sqlite';
/**
 * Backfill active contexts for all existing conversations.
 *
 * For each conversation without an active context:
 *   1. Creates an active context via getOrCreateActiveContext
 *   2. If the conversation has messages, advances the head pointer
 *      to the highest message ID
 *
 * @returns counts of created and skipped conversations
 */
export declare function backfillContexts(db: DatabaseSync): {
    created: number;
    skipped: number;
};
/**
 * Backfill parent_id and depth for existing messages that lack them.
 *
 * Reconstructs a linear chain per conversation ordered by message_index:
 *   - first message: parent_id = NULL, depth = 0
 *   - each subsequent: parent_id = previous.id, depth = previous.depth + 1
 *
 * Idempotent: only touches messages where parent_id IS NULL AND depth = 0
 * AND there is more than one message or the message is not the first.
 * In practice, we simply skip messages that already have parent_id set.
 *
 * Also stamps context_id on messages that lack it, using the active context
 * for their conversation.
 *
 * @returns counts of messages updated and conversations processed
 */
export declare function backfillParentChains(db: DatabaseSync): {
    conversationsProcessed: number;
    messagesUpdated: number;
};
//# sourceMappingURL=context-backfill.d.ts.map