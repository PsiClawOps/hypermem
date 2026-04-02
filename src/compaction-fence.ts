/**
 * HyperMem Compaction Fence
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

// ─── Types ──────────────────────────────────────────────────────

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

// ─── Schema ─────────────────────────────────────────────────────

/**
 * Add the compaction_fences table to an existing messages.db.
 * Idempotent — safe to call on every startup.
 */
export function ensureCompactionFenceSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compaction_fences (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id),
      fence_message_id INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

// ─── Fence Operations ───────────────────────────────────────────

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
export function updateCompactionFence(
  db: DatabaseSync,
  conversationId: number,
  oldestVisibleMessageId: number
): void {
  const now = new Date().toISOString();

  const existing = db.prepare(
    'SELECT fence_message_id FROM compaction_fences WHERE conversation_id = ?'
  ).get(conversationId) as { fence_message_id: number } | undefined;

  if (!existing) {
    // First fence for this conversation
    db.prepare(
      'INSERT INTO compaction_fences (conversation_id, fence_message_id, updated_at) VALUES (?, ?, ?)'
    ).run(conversationId, oldestVisibleMessageId, now);
    return;
  }

  // Monotone progress: fence only moves forward
  if (oldestVisibleMessageId > existing.fence_message_id) {
    db.prepare(
      'UPDATE compaction_fences SET fence_message_id = ?, updated_at = ? WHERE conversation_id = ?'
    ).run(oldestVisibleMessageId, now, conversationId);
  }
}

/**
 * Get the current compaction fence for a conversation.
 * Returns null if no fence has been set (meaning: no compaction allowed).
 */
export function getCompactionFence(
  db: DatabaseSync,
  conversationId: number
): CompactionFence | null {
  const row = db.prepare(
    'SELECT conversation_id, fence_message_id, updated_at FROM compaction_fences WHERE conversation_id = ?'
  ).get(conversationId) as { conversation_id: number; fence_message_id: number; updated_at: string } | undefined;

  if (!row) return null;

  return {
    conversationId: row.conversation_id,
    fenceMessageId: row.fence_message_id,
    updatedAt: row.updated_at,
  };
}

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
export function getCompactionEligibility(
  db: DatabaseSync,
  conversationId: number
): CompactionEligibility {
  const fence = getCompactionFence(db, conversationId);

  if (!fence) {
    return {
      conversationId,
      eligibleCount: 0,
      oldestEligibleId: null,
      newestEligibleId: null,
      fence: null,
    };
  }

  // Messages below the fence that haven't been summarized yet
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS cnt,
      MIN(m.id) AS oldest_id,
      MAX(m.id) AS newest_id
    FROM messages m
    WHERE m.conversation_id = ?
      AND m.id < ?
      AND m.id NOT IN (
        SELECT sm.message_id FROM summary_messages sm
        JOIN summaries s ON sm.summary_id = s.id
        WHERE s.conversation_id = ?
      )
  `).get(conversationId, fence.fenceMessageId, conversationId) as {
    cnt: number;
    oldest_id: number | null;
    newest_id: number | null;
  };

  return {
    conversationId,
    eligibleCount: stats.cnt,
    oldestEligibleId: stats.oldest_id,
    newestEligibleId: stats.newest_id,
    fence,
  };
}

/**
 * Get messages eligible for compaction (below the fence, not yet summarized).
 *
 * Returns messages in chronological order, ready for clustering.
 * Respects the fence boundary and excludes already-summarized messages.
 */
export function getCompactableMessages(
  db: DatabaseSync,
  conversationId: number,
  limit: number = 100
): Array<{ id: number; role: string; textContent: string; createdAt: string }> {
  const fence = getCompactionFence(db, conversationId);
  if (!fence) return [];

  const rows = db.prepare(`
    SELECT m.id, m.role, m.text_content, m.created_at
    FROM messages m
    WHERE m.conversation_id = ?
      AND m.id < ?
      AND m.text_content IS NOT NULL
      AND m.id NOT IN (
        SELECT sm.message_id FROM summary_messages sm
        JOIN summaries s ON sm.summary_id = s.id
        WHERE s.conversation_id = ?
      )
    ORDER BY m.id ASC
    LIMIT ?
  `).all(conversationId, fence.fenceMessageId, conversationId, limit) as Array<{
    id: number;
    role: string;
    text_content: string;
    created_at: string;
  }>;

  return rows.map(r => ({
    id: r.id,
    role: r.role,
    textContent: r.text_content,
    createdAt: r.created_at,
  }));
}
