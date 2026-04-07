#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrateLibrary } from '../dist/library-schema.js';

const db = new DatabaseSync(':memory:');

// Simulate a legacy/bad state seen in production:
// schema_version says 11, but meta table is absent.
db.exec(`
  CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`);
db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
  .run(11, new Date().toISOString());

// Minimal tables that migrateLibrary expects for newer schemas to exist.
db.exec(`
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    source_message_id INTEGER,
    domain TEXT,
    confidence REAL DEFAULT 1.0,
    created_at TEXT NOT NULL,
    superseded_by INTEGER,
    metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT,
    content TEXT NOT NULL,
    domain TEXT,
    source_refs TEXT,
    confidence REAL DEFAULT 1.0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    supersedes_id INTEGER,
    metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    summary TEXT NOT NULL,
    participants TEXT,
    topic TEXT,
    outcome TEXT,
    source_message_id INTEGER,
    created_at TEXT NOT NULL,
    metadata TEXT
  );
  CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    metadata TEXT
  );
`);

migrateLibrary(db, 'test-engine');

const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'engine_version'").get();
assert.equal(metaRow.value, 'test-engine');

console.log('✅ migrateLibrary heals missing meta table at schema>=10');
