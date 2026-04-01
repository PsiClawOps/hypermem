/**
 * HyperMem SQLite Schema — Agent Database
 *
 * One database per agent: ~/.openclaw/hypermem/{agentId}.db
 * Provider-neutral message storage with structured fields.
 * Agent-centric: conversations are a dimension, not the root entity.
 */

import type { DatabaseSync } from 'node:sqlite';

export const LATEST_SCHEMA_VERSION = 2;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Apply the complete HyperMem v1 schema.
 * Designed as a single migration for clean installs.
 * Future versions add incremental migrations.
 */
function applyV1Schema(db: DatabaseSync): void {
  // -- Agent registry --
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      tier TEXT,
      org TEXT,
      profile TEXT,
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
      agent_id TEXT NOT NULL REFERENCES agents(id),
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agent_id, status, updated_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(agent_id, channel_type, channel_id)');

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
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, message_index)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_agent_time ON messages(agent_id, created_at DESC)');

  // -- FTS5 for message full-text search --
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text_content,
      content='messages',
      content_rowid='id'
    )
  `);

  // -- Triggers to keep FTS in sync --
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text_content) VALUES (new.id, new.text_content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text_content) VALUES('delete', old.id, old.text_content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text_content) VALUES('delete', old.id, old.text_content);
      INSERT INTO messages_fts(rowid, text_content) VALUES (new.id, new.text_content);
    END
  `);

  // -- Facts (cross-session extracted knowledge) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      domain TEXT,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      visibility TEXT NOT NULL DEFAULT 'private',
      source_conversation_id INTEGER REFERENCES conversations(id),
      source_message_id INTEGER REFERENCES messages(id),
      contradicts_fact_id INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      decay_score REAL DEFAULT 0.0
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_agent_scope ON facts(agent_id, scope, domain)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(agent_id, decay_score, confidence DESC)');

  // -- Topics (cross-session thread tracking) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active',
      last_conversation_id INTEGER REFERENCES conversations(id),
      last_message_id INTEGER REFERENCES messages(id),
      message_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_topics_agent_status ON topics(agent_id, status, updated_at DESC)');

  // -- Topic-message junction --
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_messages (
      topic_id INTEGER NOT NULL REFERENCES topics(id),
      message_id INTEGER NOT NULL REFERENCES messages(id),
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      relevance REAL DEFAULT 1.0,
      PRIMARY KEY (topic_id, message_id)
    )
  `);

  // -- Knowledge (long-term, replaces MEMORY.md) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      visibility TEXT NOT NULL DEFAULT 'private',
      source_type TEXT NOT NULL,
      source_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      superseded_by INTEGER,
      UNIQUE(agent_id, domain, key)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_agent_domain ON knowledge(agent_id, domain)');

  // -- Knowledge relationships --
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL REFERENCES knowledge(id),
      to_id INTEGER NOT NULL REFERENCES knowledge(id),
      link_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // -- Episodes (significant events) --
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      significance REAL NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'org',
      participants TEXT,
      conversation_id INTEGER REFERENCES conversations(id),
      message_range_start INTEGER,
      message_range_end INTEGER,
      created_at TEXT NOT NULL,
      decay_score REAL DEFAULT 0.0
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agent_id, significance DESC, created_at DESC)');

  // -- Summaries (hierarchical, carried from ClawText) --
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_summaries_conversation ON summaries(conversation_id, depth)');

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

  // -- Agent state snapshots --
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      active_topics TEXT,
      active_work TEXT,
      profile_hash TEXT,
      knowledge_count INTEGER,
      fact_count INTEGER,
      created_at TEXT NOT NULL
    )
  `);

  // -- Index events (indexer audit trail) --
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_index_events_agent ON index_events(agent_id, created_at DESC)');
}

/**
 * Run all pending migrations on an agent database.
 */
export function migrate(db: DatabaseSync): void {
  // Ensure schema_version table exists
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

  if (currentVersion < 1) {
    applyV1Schema(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(1, nowIso());
  }

  if (currentVersion < 2) {
    applyV2Visibility(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(2, nowIso());
  }

  // Future migrations go here:
  // if (currentVersion < 3) { ... }
}

/**
 * V2: Add visibility column to facts, knowledge, episodes.
 * Supports cross-agent memory access with scoped permissions.
 */
function applyV2Visibility(db: DatabaseSync): void {
  // Add visibility columns (safe: ALTER TABLE ADD is idempotent-ish in practice,
  // but we guard with try/catch since SQLite doesn't have IF NOT EXISTS for columns)
  const addCol = (table: string, defaultVal: string) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN visibility TEXT NOT NULL DEFAULT '${defaultVal}'`);
    } catch {
      // Column already exists (from fresh v2 schema) — safe to ignore
    }
  };

  addCol('facts', 'private');
  addCol('knowledge', 'private');
  addCol('episodes', 'org');
}

export { LATEST_SCHEMA_VERSION as SCHEMA_VERSION };
