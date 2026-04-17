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

import type { DatabaseSync } from 'node:sqlite';

// ─── Types ──────────────────────────────────────────────────────

export interface Context {
  id: number;
  agentId: string;
  sessionKey: string;
  conversationId: number;
  headMessageId: number | null;
  parentContextId: number | null;
  status: 'active' | 'archived' | 'forked';
  createdAt: string;
  updatedAt: string;
  metadataJson: string | null;
}

// ─── Internal Helpers ───────────────────────────────────────────

function parseContextRow(row: Record<string, unknown>): Context {
  return {
    id: row.id as number,
    agentId: row.agent_id as string,
    sessionKey: row.session_key as string,
    conversationId: row.conversation_id as number,
    headMessageId: (row.head_message_id as number | null) ?? null,
    parentContextId: (row.parent_context_id as number | null) ?? null,
    status: row.status as 'active' | 'archived' | 'forked',
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    metadataJson: (row.metadata_json as string | null) ?? null,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Schema ─────────────────────────────────────────────────────

/**
 * Add the contexts table and related indexes to an existing messages.db.
 * Also ALTERs the messages table to add a context_id foreign key column.
 * Idempotent — safe to call on every startup.
 */
export function ensureContextSchema(db: DatabaseSync): void {
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
  const msgCols = (
    db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
  ).map(r => r.name);

  if (!msgCols.includes('context_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN context_id INTEGER REFERENCES contexts(id)');
  }
}

// ─── Context Operations ─────────────────────────────────────────

/**
 * Get the active context for an agent + session pair.
 * Returns null if no active context exists.
 */
export function getActiveContext(
  db: DatabaseSync,
  agentId: string,
  sessionKey: string
): Context | null {
  const row = db
    .prepare(
      'SELECT * FROM contexts WHERE agent_id = ? AND session_key = ? AND status = ?'
    )
    .get(agentId, sessionKey, 'active') as Record<string, unknown> | undefined;

  if (!row) return null;
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
export function getOrCreateActiveContext(
  db: DatabaseSync,
  agentId: string,
  sessionKey: string,
  conversationId: number
): Context {
  const existing = getActiveContext(db, agentId, sessionKey);
  if (existing) return existing;

  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO contexts (agent_id, session_key, conversation_id, head_message_id, parent_context_id, status, created_at, updated_at, metadata_json)
       VALUES (?, ?, ?, NULL, NULL, 'active', ?, ?, NULL)`
    )
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
export function updateContextHead(
  db: DatabaseSync,
  contextId: number,
  messageId: number
): void {
  const now = nowIso();

  const row = db
    .prepare('SELECT head_message_id FROM contexts WHERE id = ?')
    .get(contextId) as { head_message_id: number | null } | undefined;

  if (!row) return;

  // Monotone forward: only advance, never regress
  if (row.head_message_id === null || messageId > row.head_message_id) {
    db.prepare(
      'UPDATE contexts SET head_message_id = ?, updated_at = ? WHERE id = ?'
    ).run(messageId, now, contextId);
  }
}

/**
 * Archive a context, setting its status to 'archived'.
 * Idempotent — no-op if already archived.
 */
export function archiveContext(
  db: DatabaseSync,
  contextId: number
): void {
  const now = nowIso();

  db.prepare(
    `UPDATE contexts SET status = 'archived', updated_at = ? WHERE id = ? AND status != 'archived'`
  ).run(now, contextId);
}

// ─── Phase 4.1: Context Inspection and Fork APIs ──────────────────────────

/**
 * Get any context row by its primary key (any status).
 * Returns null if no context with that id exists.
 * Used by operator inspection and archived-mining read surfaces.
 */
export function getContextById(
  db: DatabaseSync,
  contextId: number
): Context | null {
  const row = db
    .prepare('SELECT * FROM contexts WHERE id = ?')
    .get(contextId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return parseContextRow(row);
}

export interface ListContextsOpts {
  status?: 'active' | 'archived' | 'forked' | 'all';
}

/**
 * List all context rows for a given (agentId, sessionKey) pair,
 * optionally filtered by status. Sorted newest-updated first.
 *
 * opts.status defaults to 'all' — callers opt in to which slice they want.
 */
export function listContextsForSession(
  db: DatabaseSync,
  agentId: string,
  sessionKey: string,
  opts?: ListContextsOpts
): Context[] {
  const status = opts?.status ?? 'all';

  let rows: Array<Record<string, unknown>>;
  if (status === 'all') {
    rows = db
      .prepare(
        'SELECT * FROM contexts WHERE agent_id = ? AND session_key = ? ORDER BY updated_at DESC'
      )
      .all(agentId, sessionKey) as Array<Record<string, unknown>>;
  } else {
    rows = db
      .prepare(
        'SELECT * FROM contexts WHERE agent_id = ? AND session_key = ? AND status = ? ORDER BY updated_at DESC'
      )
      .all(agentId, sessionKey, status) as Array<Record<string, unknown>>;
  }

  return rows.map(parseContextRow);
}

/**
 * Convenience wrapper: list only archived contexts for a given session.
 * Naming signals intent — no boolean footgun.
 */
export function listArchivedContextsForSession(
  db: DatabaseSync,
  agentId: string,
  sessionKey: string
): Context[] {
  return listContextsForSession(db, agentId, sessionKey, { status: 'archived' });
}

/**
 * Create an explicit branch fork:
 *   1. Archives the source context (within the same transaction).
 *   2. Creates a new active child context with parent_context_id pointing
 *      at the source and head_message_id set to the given headMessageId.
 *
 * This is distinct from rotateSessionContext (which handles restart rotation).
 * Use this for deliberate branch forking.
 *
 * Returns the newly created active context.
 * Throws if the source context does not exist.
 */
export function createForkedContext(
  db: DatabaseSync,
  sourceContextId: number,
  headMessageId: number,
  agentId: string,
  sessionKey: string,
  metadata?: Record<string, unknown>
): Context {
  const source = getContextById(db, sourceContextId);
  if (!source) {
    throw new Error(`createForkedContext: source context ${sourceContextId} not found`);
  }

  const now = nowIso();
  const metadataJson = metadata != null ? JSON.stringify(metadata) : null;

  // Run archive + insert in a single transaction for atomicity.
  let newId: number;
  db.exec('BEGIN');
  try {
    // Archive the source context (idempotent if already archived).
    db.prepare(
      `UPDATE contexts SET status = 'archived', updated_at = ? WHERE id = ? AND status != 'archived'`
    ).run(now, sourceContextId);

    // Insert the new forked context as active.
    const result = db
      .prepare(
        `INSERT INTO contexts
           (agent_id, session_key, conversation_id, head_message_id, parent_context_id, status, created_at, updated_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(
        agentId,
        sessionKey,
        source.conversationId,
        headMessageId,
        sourceContextId,
        now,
        now,
        metadataJson
      );

    newId = Number(result.lastInsertRowid);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    id: newId!,
    agentId,
    sessionKey,
    conversationId: source.conversationId,
    headMessageId,
    parentContextId: sourceContextId,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    metadataJson,
  };
}

/**
 * Merge a metadata patch into an existing context's metadata_json blob.
 * Creates the JSON object from scratch if metadata_json is currently null.
 * Useful for annotating archive/fork origin or adding operator-level notes.
 */
export function setContextMetadata(
  db: DatabaseSync,
  contextId: number,
  patch: Record<string, unknown>
): void {
  const row = db
    .prepare('SELECT metadata_json FROM contexts WHERE id = ?')
    .get(contextId) as { metadata_json: string | null } | undefined;

  if (!row) return;

  const existing: Record<string, unknown> =
    row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {};

  const merged = { ...existing, ...patch };
  const now = nowIso();

  db.prepare(
    'UPDATE contexts SET metadata_json = ?, updated_at = ? WHERE id = ?'
  ).run(JSON.stringify(merged), now, contextId);
}

// ─── Session Context Rotation ────────────────────────────────────────────────

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
export function rotateSessionContext(
  db: DatabaseSync,
  agentId: string,
  sessionKey: string,
  conversationId: number
): Context {
  const existing = getActiveContext(db, agentId, sessionKey);

  if (existing) {
    archiveContext(db, existing.id);
  }

  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO contexts (agent_id, session_key, conversation_id, head_message_id, parent_context_id, status, created_at, updated_at, metadata_json)
       VALUES (?, ?, ?, NULL, ?, 'active', ?, ?, NULL)`
    )
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
