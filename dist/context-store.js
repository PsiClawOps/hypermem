/**
 * hypermem Context Store
 *
 * Manages the `contexts` table — a durable record of agent conversation
 * contexts that tracks which session is active, what the current head
 * message is, and supports archival and forking.
 *
 * Each agent + session pair has at most one active context at a time.
 * Contexts are the anchor point for the compositor: they track the
 * head message (most recent message included in composed context) and
 * link back to the underlying conversation.
 *
 * Design principles:
 *   - All functions take DatabaseSync as first arg (standalone, no classes)
 *   - Fully idempotent — safe to call on every startup
 *   - Head pointer is monotone-forward (never moves backward)
 *   - Archive is idempotent (no-op if already archived)
 */
// ─── Internal Helpers ───────────────────────────────────────────
function parseContextRow(row) {
    return {
        id: row.id,
        agentId: row.agent_id,
        sessionKey: row.session_key,
        conversationId: row.conversation_id,
        headMessageId: row.head_message_id ?? null,
        parentContextId: row.parent_context_id ?? null,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metadataJson: row.metadata_json ?? null,
    };
}
function nowIso() {
    return new Date().toISOString();
}
// ─── Schema ─────────────────────────────────────────────────────
/**
 * Add the contexts table and related indexes to an existing messages.db.
 * Also ALTERs the messages table to add a context_id foreign key column.
 * Idempotent — safe to call on every startup.
 */
export function ensureContextSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS contexts (
      id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      conversation_id INTEGER REFERENCES conversations(id),
      head_message_id INTEGER REFERENCES messages(id),
      parent_context_id INTEGER REFERENCES contexts(id),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT
    )
  `);
    db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contexts_active_session
      ON contexts(agent_id, session_key, status)
      WHERE status = 'active'
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contexts_head
      ON contexts(head_message_id)
  `);
    // ALTER messages table to add context_id column (PRAGMA guard)
    const msgCols = db.prepare('PRAGMA table_info(messages)').all().map(r => r.name);
    if (!msgCols.includes('context_id')) {
        db.exec('ALTER TABLE messages ADD COLUMN context_id INTEGER REFERENCES contexts(id)');
    }
}
// ─── Context Operations ─────────────────────────────────────────
/**
 * Get the active context for an agent + session pair.
 * Returns null if no active context exists.
 */
export function getActiveContext(db, agentId, sessionKey) {
    const row = db
        .prepare('SELECT * FROM contexts WHERE agent_id = ? AND session_key = ? AND status = ?')
        .get(agentId, sessionKey, 'active');
    if (!row)
        return null;
    return parseContextRow(row);
}
/**
 * Get the active context for an agent + session, creating one if none exists.
 *
 * If an active context already exists, returns it unchanged.
 * Otherwise INSERTs a new context with status='active', head_message_id=NULL,
 * and the given conversationId.
 *
 * Idempotent — safe to call repeatedly.
 */
export function getOrCreateActiveContext(db, agentId, sessionKey, conversationId) {
    const existing = getActiveContext(db, agentId, sessionKey);
    if (existing)
        return existing;
    const now = nowIso();
    const result = db
        .prepare(`INSERT INTO contexts (agent_id, session_key, conversation_id, head_message_id, parent_context_id, status, created_at, updated_at, metadata_json)
       VALUES (?, ?, ?, NULL, NULL, 'active', ?, ?, NULL)`)
        .run(agentId, sessionKey, conversationId, now, now);
    return {
        id: Number(result.lastInsertRowid),
        agentId,
        sessionKey,
        conversationId,
        headMessageId: null,
        parentContextId: null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        metadataJson: null,
    };
}
/**
 * Update the head message pointer for a context.
 *
 * Monotone forward: only updates if messageId > current head_message_id
 * (or current is NULL). This prevents accidental regression of the head
 * pointer, matching the compaction-fence monotone progress pattern.
 */
export function updateContextHead(db, contextId, messageId) {
    const now = nowIso();
    const row = db
        .prepare('SELECT head_message_id FROM contexts WHERE id = ?')
        .get(contextId);
    if (!row)
        return;
    // Monotone forward: only advance, never regress
    if (row.head_message_id === null || messageId > row.head_message_id) {
        db.prepare('UPDATE contexts SET head_message_id = ?, updated_at = ? WHERE id = ?').run(messageId, now, contextId);
    }
}
/**
 * Archive a context, setting its status to 'archived'.
 * Idempotent — no-op if already archived.
 */
export function archiveContext(db, contextId) {
    const now = nowIso();
    db.prepare(`UPDATE contexts SET status = 'archived', updated_at = ? WHERE id = ? AND status != 'archived'`).run(now, contextId);
}
/**
 * Get any context by id, regardless of status.
 * Returns null if not found.
 *
 * @boundary INSPECTION ONLY — not a mining entry point.
 * @policy See specs/DAG_HELPER_POLICY.md for helper classifications.
 * Do not use this function to retrieve messages for active composition or
 * historical mining. Use getArchivedContext + mineArchivedContext for archived
 * mining, and getActiveContext for composition-path access.
 */
export function getContextById(db, contextId) {
    const row = db
        .prepare('SELECT * FROM contexts WHERE id = ?')
        .get(contextId);
    if (!row)
        return null;
    return parseContextRow(row);
}
/**
 * Get all archived or forked contexts for an agent.
 * Optionally filter by sessionKey and/or limit.
 * Returns in reverse-chronological order (most recently updated first).
 *
 * @policy See specs/DAG_HELPER_POLICY.md. This is the operator-safe
 * archived-context enumeration path.
 */
export function getArchivedContexts(db, agentId, opts) {
    let sql = "SELECT * FROM contexts WHERE agent_id = ? AND status IN ('archived', 'forked')";
    const params = [agentId];
    if (opts?.sessionKey) {
        sql += ' AND session_key = ?';
        params.push(opts.sessionKey);
    }
    sql += ' ORDER BY updated_at DESC';
    if (opts?.limit) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
    }
    const rows = db.prepare(sql).all(...params);
    return rows.map(parseContextRow);
}
/**
 * Get an archived or forked context by id.
 * Returns null if the context does not exist OR if it is active.
 *
 * @policy See specs/DAG_HELPER_POLICY.md. This is the operator-safe
 * single-context lookup path.
 */
export function getArchivedContext(db, contextId) {
    const row = db
        .prepare("SELECT * FROM contexts WHERE id = ? AND status IN ('archived', 'forked')")
        .get(contextId);
    if (!row)
        return null;
    return parseContextRow(row);
}
/**
 * Walk the parent_context_id chain upward from the given context.
 * Returns contexts in leaf-to-root order (starting context first).
 * Includes the starting context itself.
 * Caps traversal depth at 100 to avoid corrupt loops.
 *
 * @boundary STATUS-CROSSING BY DESIGN — this function traverses across
 * active, archived, and forked contexts without filtering by status.
 * @policy See specs/DAG_HELPER_POLICY.md for the call-site filtering rule.
 * If you need only archived/forked contexts in the lineage chain, filter
 * the returned array at the call site (e.g. `.filter(c => c.status !== 'active')`).
 */
export function getContextLineage(db, contextId) {
    const lineage = [];
    const visited = new Set();
    let currentId = contextId;
    while (currentId !== null && lineage.length < 100) {
        if (visited.has(currentId))
            break; // loop guard
        visited.add(currentId);
        const row = db
            .prepare('SELECT * FROM contexts WHERE id = ?')
            .get(currentId);
        if (!row)
            break;
        const ctx = parseContextRow(row);
        lineage.push(ctx);
        currentId = ctx.parentContextId;
    }
    return lineage;
}
/**
 * Get direct fork children of a context (contexts with parent_context_id = parentContextId).
 * Returns in ascending creation order.
 *
 * @boundary STATUS-CROSSING BY DESIGN — returns children regardless of their status
 * (may include active, archived, or forked children).
 * @policy See specs/DAG_HELPER_POLICY.md for the call-site filtering rule.
 * Filter at the call site if archived-only results are needed.
 */
export function getForkChildren(db, parentContextId) {
    const rows = db
        .prepare('SELECT * FROM contexts WHERE parent_context_id = ? ORDER BY created_at ASC')
        .all(parentContextId);
    return rows.map(parseContextRow);
}
/**
 * Rotate a session's active context: archive the current active context
 * and create a new one, optionally linking back via parent_context_id.
 *
 * Used on session restarts/rotations so the new context starts with a
 * clean head pointer instead of inheriting the stale tail.
 *
 * Returns the newly created active context.
 * If no active context exists, simply creates one (no archive step).
 */
export function rotateSessionContext(db, agentId, sessionKey, conversationId) {
    const existing = getActiveContext(db, agentId, sessionKey);
    if (existing) {
        archiveContext(db, existing.id);
    }
    const now = nowIso();
    const result = db
        .prepare(`INSERT INTO contexts (agent_id, session_key, conversation_id, head_message_id, parent_context_id, status, created_at, updated_at, metadata_json)
       VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, NULL)`)
        .run(agentId, sessionKey, conversationId, existing?.id ?? null, now, now);
    return {
        id: Number(result.lastInsertRowid),
        agentId,
        sessionKey,
        conversationId,
        headMessageId: null,
        parentContextId: existing?.id ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        metadataJson: null,
    };
}
//# sourceMappingURL=context-store.js.map