import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = process.cwd();
const home = mkdtempSync(path.join(tmpdir(), 'hypermem-embed-existing-'));
const dataDir = path.join(home, '.openclaw', 'hypermem');
mkdirSync(dataDir, { recursive: true });

try {
  const libraryDb = new DatabaseSync(path.join(dataDir, 'library.db'));
  libraryDb.exec(`
    CREATE TABLE facts (
      id INTEGER PRIMARY KEY,
      content TEXT NOT NULL,
      domain TEXT,
      superseded_by INTEGER,
      decay_score REAL DEFAULT 0,
      confidence REAL DEFAULT 1
    );
    CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY,
      content TEXT NOT NULL,
      domain TEXT,
      key TEXT,
      superseded_by INTEGER,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY,
      summary TEXT NOT NULL,
      event_type TEXT,
      significance REAL DEFAULT 1
    );
    INSERT INTO facts (id, content, domain, confidence) VALUES (1, 'eligible fact', 'test', 0.9);
    INSERT INTO knowledge (id, content, domain, key) VALUES (10, 'active knowledge one', 'test', 'one');
    INSERT INTO knowledge (id, content, domain, key) VALUES (11, 'active knowledge two', 'test', 'two');
    INSERT INTO knowledge (id, content, domain, key, superseded_by) VALUES (12, 'superseded knowledge', 'test', 'old', 10);
    INSERT INTO episodes (id, summary, event_type, significance) VALUES (20, 'eligible episode', 'test', 0.8);
    INSERT INTO episodes (id, summary, event_type, significance) VALUES (21, 'low-value episode', 'test', 0.2);
  `);
  libraryDb.close();

  const vectorsDb = new DatabaseSync(path.join(dataDir, 'vectors.db'));
  vectorsDb.exec(`
    CREATE TABLE vec_index_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_table TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      vec_table TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      UNIQUE(source_table, source_id)
    );
    INSERT INTO vec_index_map (source_table, source_id, vec_table, content_hash, indexed_at)
    VALUES ('knowledge', 10, 'vec_knowledge', 'abc', datetime('now'));
  `);
  vectorsDb.close();

  const output = execFileSync(
    process.execPath,
    ['scripts/embed-existing.mjs', '--dry-run', '--coverage-report', '--table', 'knowledge'],
    {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }
  );

  assert.match(output, /Tables:\s+knowledge/);
  assert.match(output, /knowledge: 2 eligible, 1 already embedded, 1 to embed/);
  assert.match(output, /knowledge: total=2 eligible=2 indexed=1 missing=1 intentionally_skipped=0 coverage=50\.0%/);
  assert.doesNotMatch(output, /superseded knowledge/);

  console.log('embed-existing coverage regression passed');
} finally {
  rmSync(home, { recursive: true, force: true });
}
