/**
 * HyperMem Library Schema — Shared Fleet Knowledge
 *
 * Single database: ~/.openclaw/hypermem/library.db
 * Read by all agents, written by designated agents or the indexer.
 */

import type { DatabaseSync } from 'node:sqlite';

export const LIBRARY_SCHEMA_VERSION = 2;

function nowIso(): string {
  return new Date().toISOString();
}

function applyV1Schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_type TEXT NOT NULL,
      domain TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER DEFAULT 1,
      author_agent TEXT,
      visibility TEXT DEFAULT 'fleet',
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_library_domain ON library(domain, item_type)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS library_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      domain TEXT,
      item_type TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(agent_id, domain, item_type)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS library_changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_item_id INTEGER NOT NULL REFERENCES library(id),
      change_type TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      diff_summary TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_library_changelog_item ON library_changelog(library_item_id, created_at DESC)');

  // FTS on library content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(
      title,
      content,
      content='library',
      content_rowid='id'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS library_ai AFTER INSERT ON library BEGIN
      INSERT INTO library_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS library_ad AFTER DELETE ON library BEGIN
      INSERT INTO library_fts(library_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS library_au AFTER UPDATE ON library BEGIN
      INSERT INTO library_fts(library_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content);
      INSERT INTO library_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
    END
  `);
}

export function migrateLibrary(db: DatabaseSync): void {
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

  if (currentVersion > LIBRARY_SCHEMA_VERSION) {
    console.warn(
      `[hypermem-library] Database schema version (${currentVersion}) is newer than this engine (${LIBRARY_SCHEMA_VERSION}).`
    );
    return;
  }

  if (currentVersion < 1) {
    applyV1Schema(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(1, nowIso());
  }

  if (currentVersion < 2) {
    applyV2SessionRegistry(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(2, nowIso());
  }
}

/**
 * V2: Session registry + session events for fleet-wide session tracking.
 * Also adds vec0 table for semantic search over session summaries.
 */
function applyV2SessionRegistry(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_registry (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      channel TEXT,
      channel_type TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT DEFAULT 'active',
      summary TEXT,
      decisions_made INTEGER DEFAULT 0,
      facts_extracted INTEGER DEFAULT 0,
      messages_count INTEGER DEFAULT 0
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_agent ON session_registry(agent_id, status, started_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_status ON session_registry(status, started_at DESC)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES session_registry(id),
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payload TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_events ON session_events(session_id, timestamp DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type, timestamp DESC)');

  // FTS on session summaries
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      summary,
      content='session_registry',
      content_rowid='rowid'
    )
  `);
}
