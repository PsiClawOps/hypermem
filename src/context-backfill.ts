/**
 * hypermem Context Backfill
 *
 * One-time migration that creates context rows for existing conversations
 * that don't yet have an active context. Designed to be idempotent — running
 * it multiple times produces the same result without modifying existing data.
 */

import type { DatabaseSync } from 'node:sqlite';
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
export function backfillContexts(db: DatabaseSync): { created: number; skipped: number } {
  let created = 0;
  let skipped = 0;

  const conversations = db
    .prepare('SELECT id, agent_id, session_key FROM conversations')
    .all() as Array<{ id: number; agent_id: string; session_key: string }>;

  for (const conv of conversations) {
    // Check if an active context already exists for this conversation
    const existing = db
      .prepare(
        "SELECT id FROM contexts WHERE conversation_id = ? AND status = 'active'"
      )
      .get(conv.id) as { id: number } | undefined;

    if (existing) {
      skipped++;
      continue;
    }

    // Find the max message ID for this conversation (may be null if no messages)
    const maxRow = db
      .prepare('SELECT MAX(id) as max_id FROM messages WHERE conversation_id = ?')
      .get(conv.id) as { max_id: number | null } | undefined;

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
