/**
 * hypermem Library Schema — Fleet-Wide Structured Knowledge
 *
 * Single database: ~/.openclaw/hypermem/library.db
 * The "crown jewel" — durable, backed up, low-write-frequency.
 *
 * Collections:
 *   1. Library entries (versioned docs, specs, reference material)
 *   2. Facts (agent-learned truths)
 *   3. Preferences (behavioral patterns)
 *   4. Knowledge (structured domain knowledge, supersedable)
 *   5. Episodes (significant events)
 *   6. Fleet registry (agents, orgs)
 *   7. System registry (server state, config)
 *   8. Session registry (lifecycle tracking)
 *   9. Work items (fleet kanban)
 *  10. Topics (cross-session thread tracking)
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { join as pathJoin, dirname } from 'node:path';

export const LIBRARY_SCHEMA_VERSION = 18;

function nowIso(): string {
  return new Date().toISOString();
}

// ── V1: Original library + subscriptions + changelog ──────────

function applyV1Schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT,
      version INTEGER DEFAULT 1,
      source TEXT,
      agent_id TEXT,
      visibility TEXT DEFAULT 'fleet',
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      superseded_at TEXT,
      superseded_by INTEGER,
      UNIQUE(domain, key, version)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_lib_entries_domain ON library_entries(domain, key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_lib_entries_active ON library_entries(domain, key, superseded_by)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS library_changelog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      library_entry_id INTEGER NOT NULL REFERENCES library_entries(id),
      change_type TEXT NOT NULL,
      changed_by TEXT NOT NULL,
      diff_summary TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_lib_changelog_item ON library_changelog(library_entry_id, created_at DESC)');

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

  // FTS on library content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(
      key,
      content,
      content='library_entries',
      content_rowid='id'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lib_fts_ai AFTER INSERT ON library_entries BEGIN
      INSERT INTO library_fts(rowid, key, content) VALUES (new.id, new.key, new.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lib_fts_ad AFTER DELETE ON library_entries BEGIN
      INSERT INTO library_fts(library_fts, rowid, key, content) VALUES('delete', old.id, old.key, old.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS lib_fts_au AFTER UPDATE ON library_entries BEGIN
      INSERT INTO library_fts(library_fts, rowid, key, content) VALUES('delete', old.id, old.key, old.content);
      INSERT INTO library_fts(rowid, key, content) VALUES (new.id, new.key, new.content);
    END
  `);
}

// ── V2: Session registry ──────────────────────────────────────

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

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
      summary,
      content='session_registry',
      content_rowid='rowid'
    )
  `);
}

// ── V3: Centralized collections ───────────────────────────────
// Facts, preferences, knowledge, episodes, topics move here from per-agent DBs.
// Fleet registry, system registry, work items are new.

function applyV3Collections(db: DatabaseSync): void {

  // ── Facts (agent-learned truths) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'agent',
      domain TEXT,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      visibility TEXT NOT NULL DEFAULT 'private',
      source_type TEXT DEFAULT 'conversation',
      source_session_key TEXT,
      source_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      superseded_by INTEGER,
      decay_score REAL DEFAULT 0.0,
      valid_from TEXT,
      invalid_at TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_agent ON facts(agent_id, scope, domain)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_visibility ON facts(visibility, agent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(agent_id, superseded_by, decay_score, confidence DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_temporal_validity ON facts(agent_id, valid_from, invalid_at)');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
      content,
      domain,
      content='facts',
      content_rowid='id'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS facts_fts_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts(rowid, content, domain) VALUES (new.id, new.content, new.domain);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS facts_fts_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content, domain) VALUES('delete', old.id, old.content, old.domain);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS facts_fts_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts(facts_fts, rowid, content, domain) VALUES('delete', old.id, old.content, old.domain);
      INSERT INTO facts_fts(rowid, content, domain) VALUES (new.id, new.content, new.domain);
    END
  `);

  // ── Preferences (behavioral patterns) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      domain TEXT NOT NULL DEFAULT 'general',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      visibility TEXT NOT NULL DEFAULT 'fleet',
      source_type TEXT DEFAULT 'observation',
      source_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(subject, domain, key)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_prefs_subject ON preferences(subject, domain)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_prefs_agent ON preferences(agent_id)');

  // ── Knowledge (structured domain knowledge, supersedable) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      visibility TEXT NOT NULL DEFAULT 'private',
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      superseded_by INTEGER,
      UNIQUE(agent_id, domain, key)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_agent ON knowledge(agent_id, domain)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_visibility ON knowledge(visibility, agent_id)');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      key,
      content,
      domain,
      content='knowledge',
      content_rowid='id'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, key, content, domain) VALUES (new.id, new.key, new.content, new.domain);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, key, content, domain) VALUES('delete', old.id, old.key, old.content, old.domain);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, key, content, domain) VALUES('delete', old.id, old.key, old.content, old.domain);
      INSERT INTO knowledge_fts(rowid, key, content, domain) VALUES (new.id, new.key, new.content, new.domain);
    END
  `);

  // ── Knowledge relationships (DAG edges) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_type TEXT NOT NULL,
      from_id INTEGER NOT NULL,
      to_type TEXT NOT NULL,
      to_id INTEGER NOT NULL,
      link_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(from_type, from_id, to_type, to_id, link_type)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_klinks_from ON knowledge_links(from_type, from_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_klinks_to ON knowledge_links(to_type, to_id)');

  // ── Episodes (significant events) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      significance REAL NOT NULL DEFAULT 0.5,
      visibility TEXT NOT NULL DEFAULT 'org',
      participants TEXT,
      session_key TEXT,
      created_at TEXT NOT NULL,
      decay_score REAL DEFAULT 0.0
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_agent ON episodes(agent_id, significance DESC, created_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_visibility ON episodes(visibility, agent_id)');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      summary,
      event_type,
      content='episodes',
      content_rowid='id'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodes_fts_ai AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, summary, event_type) VALUES (new.id, new.summary, new.event_type);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodes_fts_ad AFTER DELETE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, summary, event_type) VALUES('delete', old.id, old.summary, old.event_type);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS episodes_fts_au AFTER UPDATE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, summary, event_type) VALUES('delete', old.id, old.summary, old.event_type);
      INSERT INTO episodes_fts(rowid, summary, event_type) VALUES (new.id, new.summary, new.event_type);
    END
  `);

  // ── Topics (cross-session thread tracking) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active',
      visibility TEXT NOT NULL DEFAULT 'org',
      last_session_key TEXT,
      message_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_topics_agent ON topics(agent_id, status, updated_at DESC)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_dedup ON topics(agent_id, lower(name))');

  // ── Fleet registry ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_agents (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'unknown',
      org_id TEXT,
      reports_to TEXT,
      domains TEXT,
      session_keys TEXT,
      status TEXT DEFAULT 'active',
      last_seen TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_fleet_agents_tier ON fleet_agents(tier, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_fleet_agents_org ON fleet_agents(org_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_orgs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lead_agent_id TEXT REFERENCES fleet_agents(id),
      mission TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // ── System registry ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      ttl TEXT,
      UNIQUE(category, key)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_system_state_cat ON system_state(category)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS system_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      agent_id TEXT,
      created_at TEXT NOT NULL,
      metadata TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_system_events ON system_events(category, key, created_at DESC)');

  // ── Work items (fleet kanban) ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'incoming',
      priority INTEGER NOT NULL DEFAULT 3,
      agent_id TEXT,
      created_by TEXT NOT NULL,
      domain TEXT,
      parent_id TEXT,
      blocked_by TEXT,
      session_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      due_at TEXT,
      metadata TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_status ON work_items(status, priority)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_agent ON work_items(agent_id, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_domain ON work_items(domain, status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_parent ON work_items(parent_id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      event_type TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      agent_id TEXT,
      comment TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_work_events ON work_events(work_item_id, created_at DESC)');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS work_items_fts USING fts5(
      title,
      description,
      content='work_items',
      content_rowid='rowid'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS work_fts_ai AFTER INSERT ON work_items BEGIN
      INSERT INTO work_items_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS work_fts_ad AFTER DELETE ON work_items BEGIN
      INSERT INTO work_items_fts(work_items_fts, rowid, title, description) VALUES('delete', old.rowid, old.title, old.description);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS work_fts_au AFTER UPDATE ON work_items BEGIN
      INSERT INTO work_items_fts(work_items_fts, rowid, title, description) VALUES('delete', old.rowid, old.title, old.description);
      INSERT INTO work_items_fts(rowid, title, description) VALUES (new.rowid, new.title, new.description);
    END
  `);
}

// ── V4: Agent capabilities ────────────────────────────────────
// Skills, tools, MCP servers registered per agent for fleet-wide discoverability.

function applyV4Capabilities(db: DatabaseSync): void {
  // Add capabilities column to fleet_agents
  db.exec('ALTER TABLE fleet_agents ADD COLUMN capabilities TEXT');

  // Structured capabilities table for queryable skill/tool lookups
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_capabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL REFERENCES fleet_agents(id),
      cap_type TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT,
      source TEXT,
      config TEXT,
      status TEXT DEFAULT 'active',
      last_verified TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id, cap_type, name)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_caps_agent ON agent_capabilities(agent_id, cap_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_caps_type ON agent_capabilities(cap_type, name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agent_caps_status ON agent_capabilities(status, cap_type)');
}

// ── V5: Agent desired state ───────────────────────────────────
// Stores intended configuration for each agent: model, thinking, provider, etc.
// Enables drift detection (desired vs actual) and fleet-wide config visibility.

function applyV5DesiredState(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_desired_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      config_key TEXT NOT NULL,
      desired_value TEXT NOT NULL,
      actual_value TEXT,
      source TEXT NOT NULL DEFAULT 'operator',
      set_by TEXT,
      drift_status TEXT DEFAULT 'unknown',
      last_checked TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      notes TEXT,
      UNIQUE(agent_id, config_key)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_desired_agent ON agent_desired_state(agent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_desired_drift ON agent_desired_state(drift_status)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_desired_key ON agent_desired_state(config_key)');

  // Change log for desired state modifications
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_config_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      config_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      created_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_config_events_agent ON agent_config_events(agent_id, config_key, created_at DESC)');
}

// ── V6: Document chunks ───────────────────────────────────────
// Stores chunked ACA workspace documents for semantic retrieval.
// Enables ACA offload: governance docs, identity files, memory → demand-loaded.
//
// Key design:
// - Each chunk has a source_hash — atomic re-indexing via hash-based swap
// - collection path mirrors ACA_COLLECTIONS (governance/policy, etc.)
// - scope: shared-fleet | per-tier | per-agent
// - FTS5 virtual table for keyword fallback when no embedder configured

function applyV6DocChunks(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_chunks (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      section_path TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 2,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL DEFAULT 0,
      source_hash TEXT NOT NULL,
      source_path TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'shared-fleet',
      tier TEXT,
      agent_id TEXT,
      parent_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_doc_chunks_collection ON doc_chunks(collection, scope)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_doc_chunks_agent ON doc_chunks(agent_id, collection)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_doc_chunks_hash ON doc_chunks(source_hash)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_doc_chunks_source ON doc_chunks(source_path)');

  // Source file tracking: one row per indexed file
  // Used to detect when a file has changed and needs re-indexing
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_sources (
      source_path TEXT NOT NULL,
      collection TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'shared-fleet',
      agent_id TEXT,
      source_hash TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (source_path, collection)
    )
  `);

  db.exec('CREATE INDEX IF NOT EXISTS idx_doc_sources_collection ON doc_sources(collection)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_doc_sources_agent ON doc_sources(agent_id)');

  // FTS5 for keyword-based fallback retrieval
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
      content,
      section_path,
      collection,
      content='doc_chunks',
      content_rowid='rowid'
    )
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS doc_chunks_fts_ai AFTER INSERT ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(rowid, content, section_path, collection)
      VALUES (new.rowid, new.content, new.section_path, new.collection);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS doc_chunks_fts_ad AFTER DELETE ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, section_path, collection)
      VALUES ('delete', old.rowid, old.content, old.section_path, old.collection);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS doc_chunks_fts_au AFTER UPDATE ON doc_chunks BEGIN
      INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content, section_path, collection)
      VALUES ('delete', old.rowid, old.content, old.section_path, old.collection);
      INSERT INTO doc_chunks_fts(rowid, content, section_path, collection)
      VALUES (new.rowid, new.content, new.section_path, new.collection);
    END
  `);
}

// ── V7: Fix knowledge versioning ─────────────────────────────
// The V1 knowledge table had UNIQUE(agent_id, domain, key) which prevented
// true versioning — upsert would overwrite in-place, creating self-superseding rows.
//
// V7 recreates the knowledge table with:
// - version INTEGER NOT NULL DEFAULT 1
// - UNIQUE(agent_id, domain, key, version) — allows multiple versions per key
// - Preserves existing data (current rows become version 1)

function applyV7KnowledgeVersioning(db: DatabaseSync): void {
  // Rename existing table
  db.exec('ALTER TABLE knowledge RENAME TO knowledge_v6');

  // Create new table with versioned unique constraint
  db.exec(`
    CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      key TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      visibility TEXT NOT NULL DEFAULT 'private',
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      superseded_by INTEGER,
      UNIQUE(agent_id, domain, key, version)
    )
  `);

  // Recreate indexes
  db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_agent ON knowledge(agent_id, domain, key)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_knowledge_active ON knowledge(agent_id, superseded_by)');

  // Migrate existing data (all become version 1, preserve visibility)
  db.exec(`
    INSERT INTO knowledge (id, agent_id, domain, key, version, content, confidence, visibility,
                           source_type, source_ref, created_at, updated_at, expires_at, superseded_by)
    SELECT id, agent_id, domain, key, 1, content, confidence,
           COALESCE(visibility, 'private'),
           source_type, source_ref, created_at, updated_at, expires_at, superseded_by
    FROM knowledge_v6
  `);

  // Drop old table
  db.exec('DROP TABLE knowledge_v6');

  // Recreate FTS5 virtual table (was created in V3 but references knowledge)
  // FTS tables can't be migrated — drop and recreate
  try {
    db.exec('DROP TABLE IF EXISTS knowledge_fts');
  } catch { /* ignore */ }

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
      content,
      domain,
      key,
      content='knowledge',
      content_rowid='id'
    )
  `);

  // Repopulate FTS index from migrated data
  db.exec(`INSERT INTO knowledge_fts(rowid, content, domain, key) SELECT id, content, domain, key FROM knowledge`);

  // Recreate triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_ai AFTER INSERT ON knowledge BEGIN
      INSERT INTO knowledge_fts(rowid, content, domain, key) VALUES (new.id, new.content, new.domain, new.key);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_au AFTER UPDATE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content, domain, key) VALUES('delete', old.id, old.content, old.domain, old.key);
      INSERT INTO knowledge_fts(rowid, content, domain, key) VALUES (new.id, new.content, new.domain, new.key);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS knowledge_fts_ad AFTER DELETE ON knowledge BEGIN
      INSERT INTO knowledge_fts(knowledge_fts, rowid, content, domain, key) VALUES('delete', old.id, old.content, old.domain, old.key);
    END
  `);
}

// ── V9: Add session_key to doc_chunks ───────────────────────
// Enables ephemeral session-scoped doc chunks for subagent context inheritance.
// Chunks stored with a session_key are transient — clearSessionChunks() removes them.

function applyV9DocChunkSessionKey(db: DatabaseSync): void {
  const cols = (db.prepare('PRAGMA table_info(doc_chunks)').all() as Array<{ name: string }>)
    .map(r => r.name);
  if (!cols.includes('session_key')) {
    db.exec('ALTER TABLE doc_chunks ADD COLUMN session_key TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_doc_chunks_session ON doc_chunks(session_key) WHERE session_key IS NOT NULL');
}

// ── V8: Add source_message_id to episodes ───────────────────

function applyV8EpisodeSourceMessageId(db: DatabaseSync): void {
  // ALTER TABLE ADD COLUMN is safe — existing rows get NULL for new column
  const cols = (db.prepare('PRAGMA table_info(episodes)').all() as Array<{ name: string }>)
    .map(r => r.name);
  if (!cols.includes('source_message_id')) {
    db.exec('ALTER TABLE episodes ADD COLUMN source_message_id INTEGER');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_episodes_source_msg ON episodes(agent_id, source_message_id)');
}

// ── V12: FOS / MOD tables + builtin seed data ──────────────

function applyV12FosMod(db: DatabaseSync): void {
  // fleet_output_standard: fleet-wide output formatting standards
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_output_standard (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      directives        TEXT NOT NULL,
      task_variants     TEXT DEFAULT '{}',
      token_budget      INTEGER DEFAULT 250,
      active            INTEGER DEFAULT 0,
      source            TEXT DEFAULT 'builtin',
      version           INTEGER DEFAULT 1,
      last_validated_at TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )
  `);

  // model_output_directives: per-model corrections and calibration
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_output_directives (
      id                TEXT PRIMARY KEY,
      match_pattern     TEXT NOT NULL,
      priority          INTEGER DEFAULT 0,
      corrections       TEXT NOT NULL,
      calibration       TEXT NOT NULL,
      task_overrides    TEXT DEFAULT '{}',
      token_budget      INTEGER DEFAULT 150,
      version           INTEGER DEFAULT 1,
      source            TEXT DEFAULT 'builtin',
      enabled           INTEGER DEFAULT 1,
      last_validated_at TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    )
  `);

  // output_metrics: per-request telemetry for drift analytics
  db.exec(`
    CREATE TABLE IF NOT EXISTS output_metrics (
      id                TEXT PRIMARY KEY,
      timestamp         TEXT NOT NULL,
      agent_id          TEXT NOT NULL,
      session_key       TEXT NOT NULL,
      model_id          TEXT NOT NULL,
      provider          TEXT NOT NULL,
      fos_version       INTEGER,
      mod_version       INTEGER,
      mod_id            TEXT,
      task_type         TEXT,
      output_tokens     INTEGER NOT NULL,
      input_tokens      INTEGER,
      cache_read_tokens INTEGER,
      corrections_fired TEXT DEFAULT '[]',
      latency_ms        INTEGER,
      created_at        TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_output_metrics_model ON output_metrics(model_id, timestamp)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_output_metrics_agent ON output_metrics(agent_id, timestamp)');

  // ── Seed builtin FOS profile ──
  const now = nowIso();

  const fosDirectives = JSON.stringify({
    structural: [
      'Lead with the answer. Conclusion first, reasoning after.',
      'Headers earn their place. Under 200 words: no headers.',
      'Lists cap at 7 items. Technical enumerations exempt.',
      'One metaphor lands. Two is the limit.',
    ],
    anti_patterns: [
      'No sycophantic openings: Great question, Certainly, Absolutely, Of course',
      'No em dashes',
      'No preamble restating the question',
      'No: Let me know if you need anything else',
      'No AI vocabulary: delve, tapestry, pivotal, fostering, garner, underscore, vibrant, leverage, noteworthy, realm',
      'No unverifiable references — don\'t cite "you mentioned earlier" or "as discussed" without a direct quote',
      'No claiming actions completed without tool results to back them up',
      'No attributing statements to people without quoting the actual message',
    ],
    density_targets: {
      simple: '1-3 sentences',
      analysis: '200-500 words',
      code: 'code first, explain only non-obvious parts',
    },
    voice: [
      'Every sentence states a fact, makes a decision, or advances an argument',
      'Numbers over adjectives',
      'Vary sentence length deliberately',
      'Match confidence to evidence: facts zero hedges, inference one hedge max',
    ],
  });

  const fosVariants = JSON.stringify({
    'council-deliberation': {
      density_target: '400-800 words. Depth over brevity.',
      structure: 'Headers required. Position statement, risk assessment, confidence, action.',
    },
    'code-generation': {
      density_target: 'Minimize prose. Code is the deliverable.',
      list_cap: 'DISABLED',
    },
    'quick-answer': {
      density_target: '1-3 sentences.',
      structure: 'No headers. No lists unless the answer is genuinely a list.',
    },
  });

  const existingFos = db.prepare("SELECT id FROM fleet_output_standard WHERE id = 'psiclawops-default'").get();
  if (!existingFos) {
    db.prepare(`
      INSERT INTO fleet_output_standard (id, name, directives, task_variants, token_budget, active, source, version, created_at, updated_at)
      VALUES ('psiclawops-default', 'PsiClawOps Default', ?, ?, 250, 1, 'builtin', 1, ?, ?)
    `).run(fosDirectives, fosVariants, now, now);
  }

  // ── Seed builtin MOD profiles ──

  const mods = [
    {
      id: 'gpt-5.4',
      match_pattern: 'gpt-5.4*',
      priority: 10,
      corrections: JSON.stringify([
        { id: 'plan-loop', rule: 'If 2+ responses without concrete output, execute immediately. Ship partial.', severity: 'hard' },
        { id: 'first-person-opening', rule: 'Do not open with I.', severity: 'medium' },
        { id: 'throat-clearing', rule: 'No preamble before the answer.', severity: 'medium' },
        { id: 'conditional-hedging', rule: 'Decision questions: answer + 1-2 reasons. No if-X-then-Y branching.', severity: 'medium' },
      ]),
      calibration: JSON.stringify([
        { id: 'verbosity-offset', fos_target: 'analysis: 200-500 words', model_tendency: '~600 words vs Opus baseline', adjustment: 'Actively compress. Your natural output is ~2x the target. Cut first drafts in half.' },
        { id: 'list-length-offset', fos_target: '7 items max', model_tendency: 'defaults to 12-15 items', adjustment: 'After drafting a list, cut the bottom half.' },
      ]),
    },
    {
      id: 'claude-opus-4.6',
      match_pattern: 'claude-opus-4*',
      priority: 10,
      corrections: JSON.stringify([
        { id: 'over-structuring', rule: 'Resist adding headers and sections to short answers.', severity: 'medium' },
        { id: 'premature-enumeration', rule: "Don't list when prose works. Lists require 3+ genuinely distinct items.", severity: 'medium' },
      ]),
      calibration: JSON.stringify([
        { id: 'verbosity-offset', fos_target: 'analysis: 200-500 words', model_tendency: '1.1x target', adjustment: 'Near target. Minor compression on detailed analysis.' },
      ]),
    },
    {
      id: 'claude-sonnet-4.6',
      match_pattern: 'claude-sonnet-4*',
      priority: 10,
      corrections: JSON.stringify([
        { id: 'caveat-frontloading', rule: "Don't open with caveats. State the answer, then caveats if needed.", severity: 'medium' },
        { id: 'safety-hedging', rule: 'Minimize safety qualifiers on unambiguous requests.', severity: 'medium' },
      ]),
      calibration: JSON.stringify([
        { id: 'verbosity-offset', fos_target: 'analysis: 200-500 words', model_tendency: '1.3x target', adjustment: 'Compress by ~25%. Cut qualifications and restatements.' },
      ]),
    },
    {
      id: 'gemini-3.1',
      match_pattern: 'gemini-3.1*',
      priority: 10,
      corrections: JSON.stringify([
        { id: 'numbered-list-default', rule: "Don't default to numbered lists. Use prose unless order matters.", severity: 'hard' },
        { id: 'source-attribution-noise', rule: 'Skip attribution boilerplate unless sourcing is specifically requested.', severity: 'medium' },
      ]),
      calibration: JSON.stringify([
        { id: 'list-length-offset', fos_target: '7 items max', model_tendency: '1.5x target', adjustment: 'Cut lists to 7 items. Merge or drop the rest.' },
      ]),
    },
    {
      id: 'default',
      match_pattern: '*',
      priority: 0,
      corrections: JSON.stringify([]),
      calibration: JSON.stringify([]),
    },
  ];

  for (const mod of mods) {
    const existing = db.prepare('SELECT id FROM model_output_directives WHERE id = ?').get(mod.id);
    if (!existing) {
      db.prepare(`
        INSERT INTO model_output_directives (id, match_pattern, priority, corrections, calibration, task_overrides, token_budget, version, source, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '{}', 150, 1, 'builtin', 1, ?, ?)
      `).run(mod.id, mod.match_pattern, mod.priority, mod.corrections, mod.calibration, now, now);
    }
  }
}

// ── Repair utility ───────────────────────────────────────────
// Safe to call BEFORE opening the main DB connection.
// Handles the case where library.db has duplicate topics AND B-tree corruption,
// making in-place DELETE impossible.
//
// Strategy:
//   1. Detect duplicates (read-only: works on corrupt DBs)
//   2. VACUUM INTO temp file (writes to a new clean file)
//   3. Dedup + integrity check in temp
//   4. Backup original via VACUUM INTO backups dir
//   5. Atomic rename temp → original

export function repairLibraryDb(dbPath: string): { repaired: boolean; backupPath?: string; message: string } {
  if (!existsSync(dbPath)) {
    return { repaired: false, message: `DB not found at ${dbPath}. Nothing to repair.` };
  }

  const backupsDir = pathJoin(dirname(dbPath), 'backups');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tempPath = `${dbPath}.repair-${ts}.sqlite`;
  const backupPath = pathJoin(backupsDir, `library.db.pre-repair-${ts}.sqlite`);

  const src = new DatabaseSync(dbPath);

  // Step 1: detect duplicates
  const dupeRow = src.prepare(`
    SELECT COUNT(*) AS cnt FROM (
      SELECT agent_id, lower(name) FROM topics
      GROUP BY agent_id, lower(name) HAVING COUNT(*) > 1
    )
  `).get() as { cnt: number };

  if (dupeRow.cnt === 0) {
    src.close();
    return { repaired: false, message: 'No duplicate topics found. No repair needed.' };
  }

  console.log(`[hypermem-repair] ${dupeRow.cnt} duplicate topic group(s) found. Starting repair...`);

  // Step 2: VACUUM INTO temp (reads clean pages, writes fresh file)
  try {
    src.exec(`VACUUM INTO '${tempPath}'`);
  } catch (err) {
    src.close();
    throw new Error(`[hypermem-repair] VACUUM INTO failed: ${(err as Error).message}. Cannot auto-repair.`);
  }
  src.close();

  // Step 3: dedup + verify in temp
  const tmp = new DatabaseSync(tempPath);
  try {
    tmp.exec(`
      DELETE FROM topics WHERE id IN (
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY agent_id, lower(name)
            ORDER BY updated_at DESC, created_at DESC, id DESC
          ) AS rn FROM topics
        )
        SELECT id FROM ranked WHERE rn > 1
      )
    `);
    tmp.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_dedup ON topics(agent_id, lower(name))');
    const integ = tmp.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (integ.integrity_check !== 'ok') {
      throw new Error(`Repaired DB failed integrity check: ${integ.integrity_check}`);
    }
  } finally {
    tmp.close();
  }

  // Step 4: backup original
  mkdirSync(backupsDir, { recursive: true });
  let savedBackup = false;
  try {
    const srcForBackup = new DatabaseSync(dbPath);
    srcForBackup.exec(`VACUUM INTO '${backupPath}'`);
    srcForBackup.close();
    savedBackup = true;
    console.log(`[hypermem-repair] Backup saved → ${backupPath}`);
  } catch {
    console.warn('[hypermem-repair] Could not save backup, proceeding with repair anyway.');
  }

  // Step 5: atomic swap
  renameSync(tempPath, dbPath);

  const msg = [
    `Repair complete. ${dupeRow.cnt} duplicate topic group(s) removed.`,
    savedBackup ? `Original backed up to: ${backupPath}` : 'Note: backup could not be saved.',
  ].join(' ');

  console.log(`[hypermem-repair] ${msg}`);
  return { repaired: true, backupPath: savedBackup ? backupPath : undefined, message: msg };
}

// ── Migration runner ──────────────────────────────────────────

export function migrateLibrary(db: DatabaseSync, engineVersion?: string): void {
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

  if (currentVersion < 3) {
    applyV3Collections(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(3, nowIso());
  }

  if (currentVersion < 4) {
    applyV4Capabilities(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(4, nowIso());
  }

  if (currentVersion < 5) {
    applyV5DesiredState(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(5, nowIso());
  }

  if (currentVersion < 6) {
    applyV6DocChunks(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(6, nowIso());
  }

  if (currentVersion < 7) {
    applyV7KnowledgeVersioning(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(7, nowIso());
  }

  if (currentVersion < 8) {
    applyV8EpisodeSourceMessageId(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(8, nowIso());
  }

  if (currentVersion < 9) {
    applyV9DocChunkSessionKey(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(9, nowIso());
  }

  if (currentVersion < 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(10, nowIso());
  }

  // ── V11: Topics FTS + indexer watermarks ──────────────────
  // topics_fts was missing from V3 (topics table was created without FTS).
  // indexer_watermarks tracks per-agent indexer progress for resumable indexing.
  if (currentVersion < 11) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS topics_fts USING fts5(
        name,
        description,
        content='topics',
        content_rowid='id'
      )
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS topics_fts_ai AFTER INSERT ON topics BEGIN
        INSERT INTO topics_fts(rowid, name, description) VALUES (new.id, new.name, new.description);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS topics_fts_ad AFTER DELETE ON topics BEGIN
        INSERT INTO topics_fts(topics_fts, rowid, name, description) VALUES('delete', old.id, old.name, old.description);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS topics_fts_au AFTER UPDATE ON topics BEGIN
        INSERT INTO topics_fts(topics_fts, rowid, name, description) VALUES('delete', old.id, old.name, old.description);
        INSERT INTO topics_fts(rowid, name, description) VALUES (new.id, new.name, new.description);
      END
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS indexer_watermarks (
        agent_id TEXT PRIMARY KEY,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT NOT NULL
      )
    `);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(11, nowIso());
  }

  // ── V12: FOS/MOD tables + builtin seed data ──────────────
  // fleet_output_standard: fleet-wide output standards
  // model_output_directives: per-model correction & calibration profiles
  // output_metrics: per-request telemetry for drift analytics
  if (currentVersion < 12) {
    applyV12FosMod(db);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(12, nowIso());
  }

  // ── V13: Temporal index ──────────────────────────────────────────────────
  // Maps fact_id → occurred_at (unix ms). Initially backfilled from created_at
  // (ingest time as proxy). Enables time-range retrieval for LoCoMo temporal
  // questions without vector similarity.
  if (currentVersion < 13) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_index (
        fact_id     INTEGER PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
        agent_id    TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        ingest_at   INTEGER NOT NULL,
        time_ref    TEXT,
        confidence  REAL NOT NULL DEFAULT 0.5
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_temporal_agent_time ON temporal_index(agent_id, occurred_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_temporal_occurred ON temporal_index(occurred_at DESC)');

    // Backfill existing facts using created_at as occurred_at proxy
    db.exec(`
      INSERT OR IGNORE INTO temporal_index (fact_id, agent_id, occurred_at, ingest_at, confidence)
      SELECT
        id,
        agent_id,
        CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER),
        CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER),
        0.5
      FROM facts
      WHERE superseded_by IS NULL
    `);

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(13, nowIso());
  }

  // ── V14: Temporal validity columns on facts ──────────────────────────
  // valid_from / invalid_at enable "what was true on date X?" queries.
  if (currentVersion < 14) {
    try { db.exec('ALTER TABLE facts ADD COLUMN valid_from TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE facts ADD COLUMN invalid_at TEXT'); } catch { /* already exists */ }
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_temporal_validity ON facts(agent_id, valid_from, invalid_at)'); } catch { /* already exists */ }
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(14, nowIso());
  }

  // ── V15: Expertise tables (domain expertise patterns) ──────────────
  // expertise_observations: raw learnings from conversations, pipelines, reviews
  // expertise_patterns: graduated observations with confirming evidence
  // expertise_evidence: links observations to patterns (confirms/contradicts)
  if (currentVersion < 15) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS expertise_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        context TEXT,
        observation_text TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'conversation',
        source_ref TEXT,
        created_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_expertise_obs_agent ON expertise_observations(agent_id, domain)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS expertise_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        pattern_text TEXT NOT NULL,
        confidence REAL DEFAULT 0.7,
        frequency INTEGER DEFAULT 1,
        first_seen TEXT NOT NULL,
        last_confirmed TEXT NOT NULL,
        invalidated_at TEXT,
        invalidation_reason TEXT,
        decay_score REAL DEFAULT 0.0,
        updated_at TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_expertise_patterns_agent ON expertise_patterns(agent_id, domain, invalidated_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_expertise_patterns_active ON expertise_patterns(agent_id, invalidated_at, confidence DESC)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS expertise_evidence (
        observation_id INTEGER NOT NULL,
        pattern_id INTEGER NOT NULL,
        relationship TEXT NOT NULL CHECK(relationship IN ('confirms', 'contradicts')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (observation_id, pattern_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_expertise_evidence_pattern ON expertise_evidence(pattern_id, relationship)');

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(15, nowIso());
  }

  if (currentVersion < 16) {
    // contradiction_audits table — tracks detected contradictions for review
    db.exec(`
      CREATE TABLE IF NOT EXISTS contradiction_audits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK(entity_type IN ('fact')),
        new_content TEXT NOT NULL,
        new_domain TEXT,
        existing_fact_id INTEGER NOT NULL,
        existing_content TEXT NOT NULL,
        similarity_score REAL NOT NULL,
        contradiction_score REAL NOT NULL,
        reason TEXT NOT NULL,
        detector TEXT NOT NULL DEFAULT 'heuristic_v1',
        suggested_resolution TEXT NOT NULL DEFAULT 'review',
        source_ref TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'dismissed')),
        resolution_notes TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_contradiction_audits_agent_status ON contradiction_audits(agent_id, status, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_contradiction_audits_existing_fact ON contradiction_audits(existing_fact_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_contradiction_audits_agent ON contradiction_audits(agent_id, created_at DESC)');
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(16, nowIso());
  }

  if (currentVersion < 17) {
    // Stamp v17 — previously applied by an older engine build alongside contradiction_audits.
    // No additional DDL needed; the table was already created in v16.
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(17, nowIso());
  }

  if (currentVersion < 18) {
    // V18: collapse duplicate topics, then enforce unique constraint.
    //
    // Safety pattern for existing users who may have both duplicates AND B-tree corruption
    // (e.g. from a WAL desync during a gateway crash):
    //  1. Detect duplicates up front (read-only — works even on malformed DBs)
    //  2. If dupes found: VACUUM INTO a backup file first (reads clean pages, writes new file)
    //  3. Attempt in-place DELETE (works on healthy DBs)
    //  4. If DELETE fails: throw a clear error pointing to the backup + repair command
    const dupeCheck = db.prepare(`
      SELECT COUNT(*) AS cnt FROM (
        SELECT agent_id, lower(name) FROM topics
        GROUP BY agent_id, lower(name) HAVING COUNT(*) > 1
      )
    `).get() as { cnt: number };

    let v18BackupPath: string | undefined;

    if (dupeCheck.cnt > 0) {
      // Auto-backup via VACUUM INTO before any writes.
      // VACUUM INTO reads clean pages and writes to a new file — works even on marginally
      // corrupt DBs where regular writes fail.
      const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
      const backupsDir = pathJoin(home, '.openclaw', 'hypermem', 'backups');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      v18BackupPath = pathJoin(backupsDir, `library.db.v18-pre-dedup-${ts}.sqlite`);

      try {
        mkdirSync(backupsDir, { recursive: true });
        db.exec(`VACUUM INTO '${v18BackupPath}'`);
        console.log(`[hypermem-library] V18: backup saved → ${v18BackupPath}`);
      } catch (e) {
        console.warn(`[hypermem-library] V18: backup failed (${(e as Error).message}), proceeding without backup`);
        v18BackupPath = undefined;
      }

      try {
        db.exec(`
          DELETE FROM topics
          WHERE id IN (
            WITH ranked AS (
              SELECT
                id,
                ROW_NUMBER() OVER (
                  PARTITION BY agent_id, lower(name)
                  ORDER BY updated_at DESC, created_at DESC, id DESC
                ) AS rn
              FROM topics
            )
            SELECT id FROM ranked WHERE rn > 1
          )
        `);
      } catch (err) {
        const backupMsg = v18BackupPath
          ? `A VACUUM backup was saved to:\n  ${v18BackupPath}\nRun: hypermem repair-library to recover automatically.`
          : 'Run: hypermem repair-library to recover.';
        throw new Error(
          `[hypermem-library] V18 migration: failed to deduplicate topics (${(err as Error).message}).\n` +
          `Your library.db has ${dupeCheck.cnt} duplicate topic group(s) that could not be removed in-place.\n` +
          `This usually indicates B-tree corruption from a previous gateway crash.\n` +
          backupMsg
        );
      }
    }

    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_dedup ON topics(agent_id, lower(name))');
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(18, nowIso());
  }

  // Always ensure meta exists before stamping the running engine version.
  // Some legacy/stale DBs reached schema >=10 without the V10 migration having
  // actually created the table, which would make startup fail with
  // "no such table: meta" during an otherwise unrelated init path.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Always stamp the running engine version so any query can surface it.
  if (engineVersion) {
    db.prepare(`
      INSERT INTO meta (key, value, updated_at) VALUES ('engine_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(engineVersion, nowIso());
  }
}
