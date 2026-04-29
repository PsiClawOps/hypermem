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
import { classifyContentType } from './content-type-classifier.js';
// ─── Internal helpers ────────────────────────────────────────────
/**
 * Resolve the safe window to a finite positive integer.
 * Mirrors the ClawText resolveSafeWindow() guard.
 */
function resolveSafeWindow(recentWindowSize) {
    if (Number.isFinite(recentWindowSize) && recentWindowSize > 0) {
        return Math.floor(recentWindowSize);
    }
    return 20;
}
/**
 * Get the maximum message_index for a conversation.
 * Returns -1 if no messages exist.
 */
function getMaxMessageIndex(db, conversationId) {
    const row = db
        .prepare('SELECT COALESCE(MAX(message_index), -1) AS max_index FROM messages WHERE conversation_id = ?')
        .get(conversationId);
    return typeof row.max_index === 'number' ? row.max_index : -1;
}
function quoteIdent(identifier) {
    return `"${identifier.replace(/"/g, '""')}"`;
}
function getDeletableMessageIds(db, candidateIds) {
    if (candidateIds.length === 0)
        return { deletableIds: [], blockedIds: [], blockedRefs: [] };
    const placeholders = candidateIds.map(() => '?').join(', ');
    const blockedSet = new Set();
    const blockedRefs = [];
    const tables = db
        .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
    `)
        .all();
    for (const { name: tableName } of tables) {
        const refs = db
            .prepare(`PRAGMA foreign_key_list(${quoteIdent(tableName)})`)
            .all();
        for (const ref of refs) {
            if (ref.table !== 'messages')
                continue;
            if (ref.to !== null && ref.to !== 'id')
                continue;
            if (typeof ref.on_delete === 'string' && ref.on_delete.toUpperCase() === 'CASCADE')
                continue;
            const rows = db
                .prepare(`
          SELECT ${quoteIdent(ref.from)} AS id, COUNT(*) AS count
          FROM ${quoteIdent(tableName)}
          WHERE ${quoteIdent(ref.from)} IN (${placeholders})
          GROUP BY ${quoteIdent(ref.from)}
        `)
                .all(...candidateIds);
            for (const row of rows) {
                if (typeof row.id === 'number') {
                    blockedSet.add(row.id);
                    blockedRefs.push({
                        messageId: row.id,
                        table: tableName,
                        column: ref.from,
                        count: typeof row.count === 'number' ? row.count : 1,
                    });
                }
            }
        }
    }
    if (blockedSet.size === 0)
        return { deletableIds: candidateIds, blockedIds: [], blockedRefs: [] };
    const blockedIds = [...blockedSet];
    return {
        deletableIds: candidateIds.filter(id => !blockedSet.has(id)),
        blockedIds,
        blockedRefs,
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
function isNoiseMessage(textContent, isHeartbeat) {
    if (isHeartbeat === 1)
        return true;
    if (textContent === null || textContent.trim().length <= 3)
        return true;
    const { type } = classifyContentType(textContent);
    return type === 'noise' || type === 'ack';
}
function formatPassContext(conversationId, context) {
    const agent = context?.agentId ?? 'unknown';
    const dbPath = context?.dbPath ? ` db=${context.dbPath}` : '';
    return `agent=${agent} conversation=${conversationId}${dbPath}`;
}
function summarizeBlockedRefs(blockedRefs, limit = 8) {
    if (blockedRefs.length === 0)
        return 'none';
    return blockedRefs
        .slice(0, limit)
        .map(ref => `${ref.table}.${ref.column}->${ref.messageId}x${ref.count}`)
        .join(', ') + (blockedRefs.length > limit ? `, +${blockedRefs.length - limit} more` : '');
}
function summarizeForeignKeyCheck(db, limit = 8) {
    try {
        const rows = db.prepare('PRAGMA foreign_key_check').all();
        if (rows.length === 0)
            return 'none';
        return rows
            .slice(0, limit)
            .map(row => `${row.table ?? '?'}#${row.rowid ?? '?'} parent=${row.parent ?? '?'} fkid=${row.fkid ?? '?'}`)
            .join(', ') + (rows.length > limit ? `, +${rows.length - limit} more` : '');
    }
    catch (err) {
        return `unavailable:${err instanceof Error ? err.message : String(err)}`;
    }
}
function getConversationIds(db, conversationId) {
    if (typeof conversationId === 'number')
        return [conversationId];
    const rows = db.prepare('SELECT id FROM conversations ORDER BY id').all();
    return rows.map(row => row.id).filter(id => typeof id === 'number');
}
function getNoiseCandidateIds(db, conversationId, recentWindowSize, maxCandidates = Infinity) {
    const safeWindow = resolveSafeWindow(recentWindowSize);
    const maxIndex = getMaxMessageIndex(db, conversationId);
    if (maxIndex < 0)
        return [];
    const cutoff = maxIndex - safeWindow;
    if (cutoff <= 0)
        return [];
    const rows = db
        .prepare(`
      SELECT id, text_content, is_heartbeat
      FROM messages
      WHERE conversation_id = ?
        AND message_index < ?
        AND (tool_results IS NULL OR tool_results = '')
      ORDER BY message_index ASC
    `)
        .all(conversationId, cutoff);
    return rows
        .filter(row => isNoiseMessage(row.text_content, row.is_heartbeat))
        .slice(0, Number.isFinite(maxCandidates) ? maxCandidates : undefined)
        .map(row => row.id);
}
function emptyReferencedNoiseDebt() {
    return {
        passType: 'referenced_noise_debt',
        conversationsScanned: 0,
        noiseCandidates: 0,
        referencedNoise: 0,
        parentReferencedNoise: 0,
        contextReferencedNoise: 0,
        snapshotReferencedNoise: 0,
        otherReferencedNoise: 0,
        sampleRefs: [],
    };
}
/**
 * Measure noise rows that maintenance cannot delete because they are still FK
 * targets. This is health debt, not corruption: the message tree is preserving
 * referential integrity, but low-signal nodes need tree-safe compaction.
 */
export function collectReferencedNoiseDebt(db, conversationId, recentWindowSize = 20, maxCandidatesPerConversation = Infinity) {
    const result = emptyReferencedNoiseDebt();
    for (const convId of getConversationIds(db, conversationId)) {
        result.conversationsScanned += 1;
        const candidateIds = getNoiseCandidateIds(db, convId, recentWindowSize, maxCandidatesPerConversation);
        result.noiseCandidates += candidateIds.length;
        if (candidateIds.length === 0)
            continue;
        const refs = getDeletableMessageIds(db, candidateIds).blockedRefs;
        const referenced = new Set(refs.map(ref => ref.messageId));
        result.referencedNoise += referenced.size;
        const parent = new Set();
        const context = new Set();
        const snapshot = new Set();
        const other = new Set();
        for (const ref of refs) {
            if (ref.table === 'messages' && ref.column === 'parent_id')
                parent.add(ref.messageId);
            else if (ref.table === 'contexts')
                context.add(ref.messageId);
            else if (ref.table === 'composition_snapshots')
                snapshot.add(ref.messageId);
            else
                other.add(ref.messageId);
            if (result.sampleRefs.length < 12) {
                result.sampleRefs.push(`${ref.table}.${ref.column}->${ref.messageId}x${ref.count}`);
            }
        }
        result.parentReferencedNoise += parent.size;
        result.contextReferencedNoise += context.size;
        result.snapshotReferencedNoise += snapshot.size;
        result.otherReferencedNoise += other.size;
    }
    return result;
}
function isRepairableNoiseReference(ref) {
    return (ref.table === 'messages' && ref.column === 'parent_id')
        || (ref.table === 'contexts' && ref.column === 'head_message_id')
        || (ref.table === 'composition_snapshots' && ref.column === 'head_message_id');
}
function isRepairableNoiseReferenced(refs) {
    return refs.length > 0 && refs.every(isRepairableNoiseReference);
}
function hasParentReference(refs) {
    return refs.some(ref => ref.table === 'messages' && ref.column === 'parent_id');
}
function reparentChildrenAndDelete(db, messageId) {
    const row = db
        .prepare('SELECT id, parent_id, depth FROM messages WHERE id = ?')
        .get(messageId);
    if (!row)
        return false;
    db.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM messages WHERE parent_id = ?
      UNION ALL
      SELECT m.id FROM messages m JOIN subtree s ON m.parent_id = s.id
    )
    UPDATE messages
    SET depth = CASE WHEN depth > 0 THEN depth - 1 ELSE 0 END
    WHERE id IN (SELECT id FROM subtree)
  `).run(messageId);
    db.prepare('UPDATE messages SET parent_id = ? WHERE parent_id = ?').run(row.parent_id, messageId);
    const deleted = db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
    return (deleted.changes ?? 0) > 0;
}
function repairContextAndSnapshotHeads(db, messageId, replacementHeadId) {
    const contextResult = db
        .prepare("UPDATE contexts SET head_message_id = ?, updated_at = datetime('now') WHERE head_message_id = ?")
        .run(replacementHeadId, messageId);
    const snapshotResult = db
        .prepare('UPDATE composition_snapshots SET head_message_id = ?, repair_depth = repair_depth + 1 WHERE head_message_id = ?')
        .run(replacementHeadId, messageId);
    return {
        repairedContextHeads: contextResult.changes ?? 0,
        repairedSnapshotHeads: snapshotResult.changes ?? 0,
    };
}
/**
 * Safely collapse referenced noise nodes by moving children and durable head
 * pointers to the deleted node's parent. The repair only handles known safe
 * message-head references: messages.parent_id, contexts.head_message_id, and
 * composition_snapshots.head_message_id. Other FK blockers remain preserved.
 */
export function runTreeSafeNoiseCompaction(db, conversationId, recentWindowSize = 20, maxMutations = 100) {
    const result = {
        passType: 'tree_safe_noise_compaction',
        conversationsScanned: 0,
        candidates: 0,
        reparented: 0,
        repairedContextHeads: 0,
        repairedSnapshotHeads: 0,
        deleted: 0,
        skippedBlocked: 0,
        skippedRoot: 0,
        fkCheck: 'not-run',
    };
    db.prepare('BEGIN IMMEDIATE').run();
    try {
        for (const convId of getConversationIds(db, conversationId)) {
            if (result.deleted >= maxMutations)
                break;
            result.conversationsScanned += 1;
            const remaining = maxMutations - result.deleted;
            const candidateIds = getNoiseCandidateIds(db, convId, recentWindowSize, remaining);
            result.candidates += candidateIds.length;
            for (const id of candidateIds) {
                if (result.deleted >= maxMutations)
                    break;
                const refs = getDeletableMessageIds(db, [id]).blockedRefs;
                if (refs.length === 0) {
                    const deleted = db.prepare('DELETE FROM messages WHERE id = ?').run(id);
                    result.deleted += deleted.changes ?? 0;
                    continue;
                }
                if (!isRepairableNoiseReferenced(refs)) {
                    result.skippedBlocked += 1;
                    continue;
                }
                const row = db.prepare('SELECT parent_id FROM messages WHERE id = ?').get(id);
                if (!row || row.parent_id == null) {
                    result.skippedRoot += 1;
                    continue;
                }
                const repaired = repairContextAndSnapshotHeads(db, id, row.parent_id);
                result.repairedContextHeads += repaired.repairedContextHeads;
                result.repairedSnapshotHeads += repaired.repairedSnapshotHeads;
                if (reparentChildrenAndDelete(db, id)) {
                    if (hasParentReference(refs))
                        result.reparented += 1;
                    result.deleted += 1;
                }
            }
        }
        result.fkCheck = summarizeForeignKeyCheck(db);
        if (result.fkCheck !== 'none')
            throw new Error(`foreign_key_check failed: ${result.fkCheck}`);
        db.prepare('COMMIT').run();
        return result;
    }
    catch (err) {
        db.prepare('ROLLBACK').run();
        result.fkCheck = summarizeForeignKeyCheck(db);
        console.warn(`[proactive-pass] Tree-safe noise compaction failed fkCheck=${result.fkCheck} error=${err instanceof Error ? err.message : String(err)}`);
        return { ...result, deleted: 0, reparented: 0 };
    }
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
export function runNoiseSweep(db, conversationId, recentWindowSize = 20, maxCandidates = Infinity, context) {
    const ZERO = { messagesDeleted: 0, passType: 'noise_sweep' };
    try {
        const safeWindow = resolveSafeWindow(recentWindowSize);
        const maxIndex = getMaxMessageIndex(db, conversationId);
        if (maxIndex < 0)
            return ZERO;
        // Messages with message_index strictly below this value are eligible.
        const cutoff = maxIndex - safeWindow;
        if (cutoff <= 0)
            return ZERO; // Not enough history yet
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
            .all(conversationId, cutoff);
        if (candidates.length === 0)
            return ZERO;
        // Filter to noise messages, respecting per-pass candidate cap
        const toDelete = candidates.filter(row => isNoiseMessage(row.text_content, row.is_heartbeat)).slice(0, Number.isFinite(maxCandidates) ? maxCandidates : undefined);
        if (toDelete.length === 0) {
            return ZERO;
        }
        const candidateIds = toDelete.map(r => r.id);
        // Delete in a transaction; use chunked IN clauses to avoid
        // SQLite's SQLITE_LIMIT_VARIABLE_NUMBER (default 999).
        // Eligibility is intentionally recomputed inside the transaction. Live
        // context/snapshot writers can add FK sidecars between the candidate scan
        // and DELETE; checking blockers outside the write transaction turns the
        // sweep into a race.
        let totalDeleted = 0;
        let blockedIds = [];
        let blockedRefs = [];
        const CHUNK = 500;
        db.prepare('BEGIN IMMEDIATE').run();
        try {
            const resolved = getDeletableMessageIds(db, candidateIds);
            const ids = resolved.deletableIds;
            blockedIds = resolved.blockedIds;
            blockedRefs = resolved.blockedRefs;
            if (ids.length === 0) {
                db.prepare('COMMIT').run();
                if (blockedIds.length > 0) {
                    console.log(`[proactive-pass] Noise sweep skipped referenced ${formatPassContext(conversationId, context)} candidates=${candidates.length} noise=${candidateIds.length} skippedReferenced=${blockedIds.length} refs=${summarizeBlockedRefs(blockedRefs)}`);
                }
                return ZERO;
            }
            for (let i = 0; i < ids.length; i += CHUNK) {
                const chunk = ids.slice(i, i + CHUNK);
                const placeholders = chunk.map(() => '?').join(', ');
                const result = db
                    .prepare(`DELETE FROM messages WHERE id IN (${placeholders})`)
                    .run(...chunk);
                totalDeleted += typeof result.changes === 'number' ? result.changes : chunk.length;
            }
            db.prepare('COMMIT').run();
        }
        catch (innerErr) {
            db.prepare('ROLLBACK').run();
            console.warn(`[proactive-pass] Noise sweep delete failed ${formatPassContext(conversationId, context)} candidates=${candidates.length} noise=${candidateIds.length} skippedReferenced=${blockedIds.length} refs=${summarizeBlockedRefs(blockedRefs)} fkCheck=${summarizeForeignKeyCheck(db)} error=${innerErr instanceof Error ? innerErr.message : String(innerErr)}`);
            throw innerErr;
        }
        if (totalDeleted > 0) {
            console.log(`[proactive-pass] Noise sweep ${formatPassContext(conversationId, context)} candidates=${candidates.length} noise=${candidateIds.length} deleted=${totalDeleted} skippedReferenced=${blockedIds.length} cutoff=${cutoff}`);
        }
        return { messagesDeleted: totalDeleted, passType: 'noise_sweep' };
    }
    catch (err) {
        console.warn(`[proactive-pass] Noise sweep failed ${formatPassContext(conversationId, context)}: ${err instanceof Error ? err.message : String(err)}`);
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
export function runToolDecay(db, conversationId, recentWindowSize = 40, maxCandidates = Infinity, context) {
    const ZERO = { messagesUpdated: 0, bytesFreed: 0, passType: 'tool_decay' };
    try {
        const safeWindow = resolveSafeWindow(recentWindowSize);
        const maxIndex = getMaxMessageIndex(db, conversationId);
        if (maxIndex < 0) {
            return ZERO;
        }
        const cutoff = maxIndex - safeWindow;
        if (cutoff <= 0) {
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
            .all(conversationId, cutoff);
        if (candidates.length === 0) {
            return ZERO;
        }
        // Build the update list by processing each candidate, respecting per-pass cap.
        const cappedCandidates = Number.isFinite(maxCandidates) ? candidates.slice(0, maxCandidates) : candidates;
        const updates = [];
        for (const row of cappedCandidates) {
            let parsed;
            try {
                parsed = JSON.parse(row.tool_results);
            }
            catch {
                // Corrupt JSON — skip this row
                continue;
            }
            if (!Array.isArray(parsed))
                continue;
            let changed = false;
            const newResults = parsed.map(entry => {
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
            if (!changed)
                continue;
            const newJson = JSON.stringify(newResults);
            const savedBytes = row.tool_results.length - newJson.length;
            if (savedBytes > 0) {
                updates.push({ id: row.id, newJson, savedBytes });
            }
        }
        if (updates.length === 0) {
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
        }
        catch (innerErr) {
            db.prepare('ROLLBACK').run();
            throw innerErr;
        }
        if (totalUpdated > 0) {
            console.log(`[proactive-pass] Tool decay ${formatPassContext(conversationId, context)} candidates=${candidates.length} updated=${totalUpdated} bytesFreed=${totalBytesFreed} cutoff=${cutoff}`);
        }
        return {
            messagesUpdated: totalUpdated,
            bytesFreed: totalBytesFreed,
            passType: 'tool_decay',
        };
    }
    catch (err) {
        console.warn(`[proactive-pass] Tool decay failed ${formatPassContext(conversationId, context)}: ${err instanceof Error ? err.message : String(err)}`);
        return ZERO;
    }
}
//# sourceMappingURL=proactive-pass.js.map