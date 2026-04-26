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
import { getOrCreateActiveContext, updateContextHead } from './context-store.js';
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
export function backfillContexts(db) {
    let created = 0;
    let skipped = 0;
    const conversations = db
        .prepare('SELECT id, agent_id, session_key FROM conversations')
        .all();
    for (const conv of conversations) {
        // Check if an active context already exists for this conversation
        const existing = db
            .prepare("SELECT id FROM contexts WHERE conversation_id = ? AND status = 'active'")
            .get(conv.id);
        if (existing) {
            skipped++;
            continue;
        }
        // Find the max message ID for this conversation (may be null if no messages)
        const maxRow = db
            .prepare('SELECT MAX(id) as max_id FROM messages WHERE conversation_id = ?')
            .get(conv.id);
        const maxId = maxRow?.max_id ?? null;
        // Create the active context
        const context = getOrCreateActiveContext(db, conv.agent_id, conv.session_key, conv.id);
        // If conversation has messages, advance head to the latest
        if (maxId !== null) {
            updateContextHead(db, context.id, maxId);
        }
        created++;
    }
    return { created, skipped };
}
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
export function backfillParentChains(db) {
    let conversationsProcessed = 0;
    let messagesUpdated = 0;
    // Get all conversations that have at least one non-first message without parent_id.
    // This is the idempotency guard: after backfill, all messages at index > 0
    // have parent_id set. The first message (index 0) legitimately has parent_id = NULL.
    const conversations = db
        .prepare(`SELECT DISTINCT conversation_id
       FROM messages
       WHERE message_index > 0 AND parent_id IS NULL
       ORDER BY conversation_id`)
        .all();
    const updateStmt = db.prepare('UPDATE messages SET parent_id = ?, depth = ?, context_id = COALESCE(context_id, ?) WHERE id = ?');
    for (const { conversation_id: convId } of conversations) {
        // Get active context for this conversation (if any)
        const ctxRow = db
            .prepare("SELECT id FROM contexts WHERE conversation_id = ? AND status = 'active' LIMIT 1")
            .get(convId);
        const contextId = ctxRow?.id ?? null;
        // Get all messages for this conversation without parent_id, ordered by message_index
        const messages = db
            .prepare('SELECT id, message_index FROM messages WHERE conversation_id = ? AND parent_id IS NULL ORDER BY message_index ASC')
            .all(convId);
        if (messages.length === 0)
            continue;
        // Also get the last message that already HAS a parent_id (if any),
        // so we can chain the backfilled messages after it.
        const lastChainedRow = db
            .prepare('SELECT id, depth FROM messages WHERE conversation_id = ? AND parent_id IS NOT NULL ORDER BY message_index DESC LIMIT 1')
            .get(convId);
        let prevId = lastChainedRow?.id ?? null;
        let prevDepth = lastChainedRow?.depth ?? -1;
        // If there's no prior chain AND the first unlinked message is truly
        // message_index 0, start the chain from scratch
        for (const msg of messages) {
            const depth = prevDepth + 1;
            updateStmt.run(prevId, depth, contextId, msg.id);
            prevId = msg.id;
            prevDepth = depth;
            messagesUpdated++;
        }
        conversationsProcessed++;
    }
    return { conversationsProcessed, messagesUpdated };
}
//# sourceMappingURL=context-backfill.js.map