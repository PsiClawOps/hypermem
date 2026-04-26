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
export interface NoiseSweepResult {
    messagesDeleted: number;
    passType: 'noise_sweep';
}
export interface ToolDecayResult {
    messagesUpdated: number;
    bytesFreed: number;
    passType: 'tool_decay';
}
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
export declare function runNoiseSweep(db: DatabaseSync, conversationId: number, recentWindowSize?: number, maxCandidates?: number): NoiseSweepResult;
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
export declare function runToolDecay(db: DatabaseSync, conversationId: number, recentWindowSize?: number, maxCandidates?: number): ToolDecayResult;
//# sourceMappingURL=proactive-pass.d.ts.map