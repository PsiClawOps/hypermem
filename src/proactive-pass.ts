/**
 * hypermem Proactive Passes
 *
 * Background maintenance passes that run between indexer ticks to keep
 * message storage lean. Two passes:
 *
 *   1. Noise Sweep — deletes low/zero-signal messages outside the recent
 *      window (heartbeats, acks, empty strings, control tokens).
 *
 *   2. Tool Decay — truncates oversized tool_results outside the recent
 *      window in-place, preserving JSON structure but collapsing large
 *      content blobs into a byte-count placeholder.
 *
 * Both passes are:
 *   - Synchronous (DatabaseSync, no async)
 *   - Wrapped in transactions (atomic)
 *   - Best-effort: catch all errors, log, and return a zero-change result
 *
 * Ported and adapted from ClawText proactive-pass.ts.
 * hypermem schema differences vs ClawText:
 *   - No content_type column — we classify on the fly via classifyContentType()
 *   - No external payload store — we truncate content inline in tool_results JSON
 *   - No ClawText-specific dependencies (payload-store, tool-tracker, etc.)
 */

import type { DatabaseSync } from 'node:sqlite';
import { classifyContentType } from './content-type-classifier.js';

// ─── Result types ────────────────────────────────────────────────

export interface NoiseSweepResult {
  messagesDeleted: number;
  passType: 'noise_sweep';
}

export interface ToolDecayResult {
  messagesUpdated: number;
  bytesFreed: number;
  passType: 'tool_decay';
}

// ─── Internal helpers ────────────────────────────────────────────

/**
 * Resolve the safe window to a finite positive integer.
 * Mirrors the ClawText resolveSafeWindow() guard.
 */
function resolveSafeWindow(recentWindowSize: number): number {
  if (Number.isFinite(recentWindowSize) && recentWindowSize > 0) {
    return Math.floor(recentWindowSize);
  }
  return 20;
}

/**
 * Get the maximum message_index for a conversation.
 * Returns -1 if no messages exist.
 */
function getMaxMessageIndex(db: DatabaseSync, conversationId: number): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(message_index), -1) AS max_index FROM messages WHERE conversation_id = ?')
    .get(conversationId) as { max_index: number | null };
  return typeof row.max_index === 'number' ? row.max_index : -1;
}

/**
 * Filter candidate message ids down to rows that are safe to delete without
 * violating HyperMem's FK edges.
 *
 * Current blockers:
 *   - summary_messages.message_id -> messages.id
 *   - messages.parent_id -> messages.id (child rows point at parent rows)
 */
function getDeletableMessageIds(db: DatabaseSync, candidateIds: number[]): {
  deletableIds: number[];
  blockedIds: number[];
} {
  if (candidateIds.length === 0) return { deletableIds: [], blockedIds: [] };

  const placeholders = candidateIds.map(() => '?').join(', ');
  const blocked = db
    .prepare(`
      SELECT DISTINCT id
      FROM (
        SELECT sm.message_id AS id
        FROM summary_messages sm
        WHERE sm.message_id IN (${placeholders})

        UNION

        SELECT parent.id AS id
        FROM messages child
        JOIN messages parent ON parent.id = child.parent_id
        WHERE child.parent_id IN (${placeholders})
      ) blocked
    `)
    .all(...candidateIds, ...candidateIds) as Array<{ id: number }>;

  if (blocked.length === 0) return { deletableIds: candidateIds, blockedIds: [] };

  const blockedIds = blocked.map(row => row.id);
  const blockedSet = new Set(blockedIds);
  return {
    deletableIds: candidateIds.filter(id => !blockedSet.has(id)),
    blockedIds,
  };
}

/**
 * Decide if a message is noise based on content + is_heartbeat flag.
 *
 * A message is noise when:
 *   - is_heartbeat = 1  (explicit heartbeat marker), OR
 *   - text_content is NULL or empty (≤3 chars after trimming), OR
 *   - classifyContentType() returns 'noise' or 'ack'
 *
 * We call the classifier rather than duplicating its patterns here.
 */
function isNoiseMessage(textContent: string | null, isHeartbeat: number): boolean {
  if (isHeartbeat === 1) return true;
  if (textContent === null || textContent.trim().length <= 3) return true;
  const { type } = classifyContentType(textContent);
  return type === 'noise' || type === 'ack';
}

// ─── Noise Sweep ─────────────────────────────────────────────────

/**
 * Delete noise and heartbeat messages outside the recent window.
 *
 * "Outside the recent window" means message_index < maxIndex - recentWindowSize.
 * Messages inside the window are never deleted, even if they are noise —
 * the model may still reference them in the current turn.
 *
 * Deletions are wrapped in a single transaction. The FTS5 trigger handles
 * index cleanup automatically (msg_fts_ad fires on DELETE).
 */
export function runNoiseSweep(
  db: DatabaseSync,
  conversationId: number,
  recentWindowSize: number = 20,
  maxCandidates: number = Infinity,
): NoiseSweepResult {
  const ZERO: NoiseSweepResult = { messagesDeleted: 0, passType: 'noise_sweep' };

  try {
    const safeWindow = resolveSafeWindow(recentWindowSize);
    const maxIndex = getMaxMessageIndex(db, conversationId);

    if (maxIndex < 0) return ZERO;

    // Messages with message_index strictly below this value are eligible.
    const cutoff = maxIndex - safeWindow;
    if (cutoff <= 0) return ZERO;  // Not enough history yet

    // Fetch all candidate messages outside the recent window.
    // Exclude messages whose content lives entirely in tool_results — those
    // are tool result rows handled by runToolDecay(), not noise sweep.
    // We deliberately avoid a content-based WHERE clause for the classifier
    // because SQLite can't use the index for JS classification logic;
    // it's cheaper to fetch a small batch and classify in JS.
    const candidates = db
      .prepare(`
        SELECT id, text_content, is_heartbeat
        FROM messages
        WHERE conversation_id = ?
          AND message_index < ?
          AND (tool_results IS NULL OR tool_results = '')
      `)
      .all(conversationId, cutoff) as Array<{
        id: number;
        text_content: string | null;
        is_heartbeat: number;
      }>;

    if (candidates.length === 0) return ZERO;

    // Filter to noise messages, respecting per-pass candidate cap
    const toDelete = candidates.filter(row =>
      isNoiseMessage(row.text_content, row.is_heartbeat)
    ).slice(0, Number.isFinite(maxCandidates) ? maxCandidates : undefined);

    if (toDelete.length === 0) {
      console.log(
        `[proactive-pass] Noise sweep conversation=${conversationId} candidates=${candidates.length} noise=0 deleted=0 skippedReferenced=0 cutoff=${cutoff}`
      );
      return ZERO;
    }

    const candidateIds = toDelete.map(r => r.id);
    const { deletableIds: ids, blockedIds } = getDeletableMessageIds(db, candidateIds);

    if (ids.length === 0) {
      console.log(
        `[proactive-pass] Noise sweep conversation=${conversationId} candidates=${candidates.length} noise=${candidateIds.length} deleted=0 skippedReferenced=${blockedIds.length} cutoff=${cutoff}`
      );
      return ZERO;
    }

    // Delete in a transaction; use chunked IN clauses to avoid
    // SQLite's SQLITE_LIMIT_VARIABLE_NUMBER (default 999).
    let totalDeleted = 0;
    const CHUNK = 500;

    db.prepare('BEGIN').run();
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(', ');
        const result = db
          .prepare(`DELETE FROM messages WHERE id IN (${placeholders})`)
          .run(...chunk) as { changes?: number };
        totalDeleted += typeof result.changes === 'number' ? result.changes : chunk.length;
      }
      db.prepare('COMMIT').run();
    } catch (innerErr) {
      db.prepare('ROLLBACK').run();
      throw innerErr;
    }

    console.log(
      `[proactive-pass] Noise sweep conversation=${conversationId} candidates=${candidates.length} noise=${candidateIds.length} deleted=${totalDeleted} skippedReferenced=${blockedIds.length} cutoff=${cutoff}`
    );

    return { messagesDeleted: totalDeleted, passType: 'noise_sweep' };

  } catch (err) {
    console.warn(
      `[proactive-pass] Noise sweep failed for conversation ${conversationId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return ZERO;
  }
}

// ─── Tool Decay ──────────────────────────────────────────────────

/**
 * Truncate oversized tool_results outside the recent window.
 *
 * Strategy:
 *   1. Find messages whose tool_results JSON string is > 2000 chars total,
 *      outside the recent window.
 *   2. Parse the JSON array.
 *   3. For each result entry where the `content` field exceeds 500 chars,
 *      replace `content` with `[tool result truncated — N bytes]`.
 *   4. Re-serialize and write back.
 *
 * The JSON structure is preserved (array of result objects). Only the
 * oversized `content` values are collapsed.
 *
 * Mutations are committed in a single transaction.
 */
export function runToolDecay(
  db: DatabaseSync,
  conversationId: number,
  recentWindowSize: number = 40,
  maxCandidates: number = Infinity,
): ToolDecayResult {
  const ZERO: ToolDecayResult = { messagesUpdated: 0, bytesFreed: 0, passType: 'tool_decay' };

  try {
    const safeWindow = resolveSafeWindow(recentWindowSize);
    const maxIndex = getMaxMessageIndex(db, conversationId);

    if (maxIndex < 0) {
      console.log(`[proactive-pass] Tool decay conversation=${conversationId} candidates=0 updated=0 bytesFreed=0 cutoff=none reason=empty`);
      return ZERO;
    }

    const cutoff = maxIndex - safeWindow;
    if (cutoff <= 0) {
      console.log(`[proactive-pass] Tool decay conversation=${conversationId} candidates=0 updated=0 bytesFreed=0 cutoff=${cutoff} reason=within-window`);
      return ZERO;
    }

    // Fetch messages with large tool_results outside the recent window.
    const candidates = db
      .prepare(`
        SELECT id, tool_results
        FROM messages
        WHERE conversation_id = ?
          AND message_index < ?
          AND tool_results IS NOT NULL
          AND length(tool_results) > 2000
      `)
      .all(conversationId, cutoff) as Array<{ id: number; tool_results: string }>;

    if (candidates.length === 0) {
      console.log(`[proactive-pass] Tool decay conversation=${conversationId} candidates=0 updated=0 bytesFreed=0 cutoff=${cutoff} reason=no-large-tool-results`);
      return ZERO;
    }

    // Build the update list by processing each candidate, respecting per-pass cap.
    const cappedCandidates = Number.isFinite(maxCandidates) ? candidates.slice(0, maxCandidates) : candidates;
    const updates: Array<{ id: number; newJson: string; savedBytes: number }> = [];

    for (const row of cappedCandidates) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.tool_results);
      } catch {
        // Corrupt JSON — skip this row
        continue;
      }

      if (!Array.isArray(parsed)) continue;

      let changed = false;
      const newResults = (parsed as Array<Record<string, unknown>>).map(entry => {
        const content = entry.content;
        if (typeof content === 'string' && content.length > 500) {
          const originalBytes = Buffer.byteLength(content, 'utf8');
          changed = true;
          return {
            ...entry,
            content: `[tool result truncated — ${originalBytes} bytes]`,
          };
        }
        return entry;
      });

      if (!changed) continue;

      const newJson = JSON.stringify(newResults);
      const savedBytes = row.tool_results.length - newJson.length;

      if (savedBytes > 0) {
        updates.push({ id: row.id, newJson, savedBytes });
      }
    }

    if (updates.length === 0) {
      console.log(
        `[proactive-pass] Tool decay conversation=${conversationId} candidates=${candidates.length} updated=0 bytesFreed=0 cutoff=${cutoff} reason=no-truncatable-entries`
      );
      return ZERO;
    }

    let totalUpdated = 0;
    let totalBytesFreed = 0;

    db.prepare('BEGIN').run();
    try {
      const stmt = db.prepare('UPDATE messages SET tool_results = ? WHERE id = ?');
      for (const { id, newJson, savedBytes } of updates) {
        stmt.run(newJson, id);
        totalUpdated++;
        totalBytesFreed += savedBytes;
      }
      db.prepare('COMMIT').run();
    } catch (innerErr) {
      db.prepare('ROLLBACK').run();
      throw innerErr;
    }

    console.log(
      `[proactive-pass] Tool decay conversation=${conversationId} candidates=${candidates.length} updated=${totalUpdated} bytesFreed=${totalBytesFreed} cutoff=${cutoff}`
    );

    return {
      messagesUpdated: totalUpdated,
      bytesFreed: totalBytesFreed,
      passType: 'tool_decay',
    };

  } catch (err) {
    console.warn(
      `[proactive-pass] Tool decay failed for conversation ${conversationId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return ZERO;
  }
}
