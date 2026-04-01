/**
 * HyperMem Library Schema — Fleet-Wide Structured Knowledge
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

import type { DatabaseSync } from 'node:sqlite';

export const LIBRARY_SCHEMA_VERSION = 6;

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
      decay_score REAL DEFAULT 0.0
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_agent ON facts(agent_id, scope, domain)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_visibility ON facts(visibility, agent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(agent_id, superseded_by, decay_score, confidence DESC)');

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

// ── Migration runner ──────────────────────────────────────────

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
}
