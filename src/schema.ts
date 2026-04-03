/**
 * HyperMem Agent Message Schema
 *
 * Per-agent database: ~/.openclaw/hypermem/agents/{agentId}/messages.db
 * Write-heavy, temporal, rotatable.
 * Contains ONLY conversation data — structured knowledge lives in library.db.
 */

import type { DatabaseSync } from 'node:sqlite';

export const LATEST_SCHEMA_VERSION = 5;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * V1–V3: Legacy schema (monolithic agent DB with facts/knowledge/episodes).
 * Kept for migration detection — if we open an old DB, we know what version it is.
 */

/**
 * V4: Messages-only schema.
 * Facts, knowledge, episodes, topics moved to library.db.
 * Agent DB now contains only conversations, messages, summaries, and agent metadata.
 */
function applyV4MessagesOnly(db: DatabaseSync): void {
  // -- Agent metadata (kept here for self-identification) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_meta (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      tier TEXT,
      org TEXT,
      config TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // -- Conversations (sessions) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL UNIQUE,
      session_id TEXT,
      agent_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      channel_id TEXT,
      provider TEXT,
      model TEXT,
      status TEXT DEFAULT 'active',
      message_count INTEGER DEFAULT 0,
      token_count_in INTEGER DEFAULT 0,
      token_count_out INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agent_id, status, updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_conv_channel ON conversations(agent_id, channel_type, channel_id)');

  // -- Messages (provider-neutral, structured) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text_content TEXT,
      tool_calls TEXT,
      tool_results TEXT,
      metadata TEXT,
      token_count INTEGER,
      message_index INTEGER NOT NULL,
      is_heartbeat INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, message_index)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_msg_agent_time ON messages(agent_id, created_at DESC)');

  // -- FTS5 for message full-text search --
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text_content,
      content='messages',
      content_rowid='id'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS msg_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text_content) VALUES (new.id, new.text_content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS msg_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text_content) VALUES('delete', old.id, old.text_content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS msg_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text_content) VALUES('delete', old.id, old.text_content);
      INSERT INTO messages_fts(rowid, text_content) VALUES (new.id, new.text_content);
    END
  `);

  // -- Summaries (hierarchical compaction) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      agent_id TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_summaries_conv ON summaries(conversation_id, depth)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_messages (
      summary_id INTEGER NOT NULL REFERENCES summaries(id),
      message_id INTEGER NOT NULL REFERENCES messages(id),
      PRIMARY KEY (summary_id, message_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS summary_parents (
      parent_summary_id INTEGER NOT NULL REFERENCES summaries(id),
      child_summary_id INTEGER NOT NULL REFERENCES summaries(id),
      PRIMARY KEY (parent_summary_id, child_summary_id)
    )
  `);

  // -- Index events (for tracking what's been vectorized) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      target_table TEXT,
      target_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_index_events ON index_events(agent_id, created_at DESC)');
}

/**
 * Run migrations on an agent message database.
 */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const row = db
    .prepare('SELECT MAX(version) AS version FROM schema_version')
    .get() as { version?: number | null } | undefined;

  const currentVersion = typeof row?.version === 'number' ? row.version : 0;

  if (currentVersion > LATEST_SCHEMA_VERSION) {
    console.warn(
      `[hypermem] Database schema version (${currentVersion}) is newer than this engine (${LATEST_SCHEMA_VERSION}).`
    );
    return;
  }

  // For fresh DBs (version 0), jump straight to v4 (messages-only).
  // For existing DBs (v1–v3), we skip the old schema — those tables will be
  // left in place but unused. Data migration to library is a separate step.
  if (currentVersion < 4) {
    if (currentVersion === 0) {
      // Fresh DB — create messages-only schema directly
      applyV4MessagesOnly(db);
    } else {
      // Existing DB with old schema (v1–v3).
      // The old tables (facts, knowledge, episodes, topics, agents) remain
      // but are no longer written to. New tables get created alongside.
      applyV4MessagesOnly(db);
      // Note: old tables like 'facts', 'knowledge', etc. are left in place
      // for data migration. A separate migration tool will move them to library.db.
    }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(4, nowIso());
  }

  // v4 → v5: add cursor columns to conversations table for dual-write durability
  if (currentVersion < 5) {
    // ALTER TABLE ADD COLUMN is safe on existing rows — all default to NULL
    const cols = (db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>)
      .map(r => r.name);
    if (!cols.includes('cursor_last_sent_id')) {
      db.exec('ALTER TABLE conversations ADD COLUMN cursor_last_sent_id INTEGER');
    }
    if (!cols.includes('cursor_last_sent_index')) {
      db.exec('ALTER TABLE conversations ADD COLUMN cursor_last_sent_index INTEGER');
    }
    if (!cols.includes('cursor_last_sent_at')) {
      db.exec('ALTER TABLE conversations ADD COLUMN cursor_last_sent_at TEXT');
    }
    if (!cols.includes('cursor_window_size')) {
      db.exec('ALTER TABLE conversations ADD COLUMN cursor_window_size INTEGER');
    }
    if (!cols.includes('cursor_token_count')) {
      db.exec('ALTER TABLE conversations ADD COLUMN cursor_token_count INTEGER');
    }
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(5, nowIso());
  }
}

export { LATEST_SCHEMA_VERSION as SCHEMA_VERSION };
