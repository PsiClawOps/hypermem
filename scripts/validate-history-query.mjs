#!/usr/bin/env node
/**
 * Validate the history.query release surface.
 *
 * This is intentionally broader than the unit tests:
 * - core API is exported from the built package
 * - memory plugin registers the agent tool
 * - metadata-only telemetry is wired for the tool path
 * - health CLI reports the surface in --master --json output
 */

import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hm-history-query-validate-'));

function read(rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}

function runNode(args, env = {}) {
  return execFileSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createMinimalDataDir() {
  const dataDir = path.join(tmpDir, 'data');
  const agentDir = path.join(dataDir, 'agents', 'history-val-agent');
  mkdirSync(agentDir, { recursive: true });

  const library = new DatabaseSync(path.join(dataDir, 'library.db'));
  library.exec(`
    CREATE TABLE facts (id INTEGER PRIMARY KEY, agent_id TEXT, superseded_by INTEGER, decay_score REAL);
    CREATE TABLE episodes (id INTEGER PRIMARY KEY, agent_id TEXT, significance REAL);
    CREATE TABLE knowledge (id INTEGER PRIMARY KEY, agent_id TEXT, superseded_by INTEGER);
    CREATE TABLE doc_chunks (id INTEGER PRIMARY KEY, agent_id TEXT);
    CREATE TABLE output_metrics (id INTEGER PRIMARY KEY, agent_id TEXT, latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER);
  `);
  library.close();

  const messages = new DatabaseSync(path.join(agentDir, 'messages.db'));
  messages.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY,
      session_key TEXT,
      agent_id TEXT,
      channel_type TEXT,
      status TEXT,
      message_count INTEGER,
      token_count_in INTEGER,
      token_count_out INTEGER,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER,
      agent_id TEXT,
      role TEXT,
      text_content TEXT,
      tool_calls TEXT,
      tool_results TEXT,
      metadata TEXT,
      token_count INTEGER,
      message_index INTEGER,
      is_heartbeat INTEGER,
      created_at TEXT,
      context_id INTEGER,
      parent_id INTEGER,
      depth INTEGER,
      topic_id TEXT
    );
    CREATE TABLE compaction_fences (
      conversation_id INTEGER PRIMARY KEY,
      fence_message_id INTEGER,
      updated_at TEXT
    );
    INSERT INTO conversations VALUES (1, 'agent:history-val-agent:webchat:main', 'history-val-agent', 'webchat', 'active', 1, 0, 0, '2026-04-28T00:00:00.000Z', '2026-04-28T00:00:00.000Z');
    INSERT INTO messages VALUES (1, 1, 'history-val-agent', 'user', 'history validation ping', NULL, NULL, NULL, 3, 1, 0, '2026-04-28T00:00:00.000Z', 1, NULL, 0, 'validation-topic');
  `);
  messages.close();

  return dataDir;
}

try {
  const coreDts = read('dist/index.d.ts');
  assert.match(coreDts, /queryHistory\(query: HistoryQuery\): HistoryQueryResult/, 'core queryHistory API exported');

  const pluginJs = read('memory-plugin/dist/index.js');
  assert.match(pluginJs, /history_query/, 'memory plugin registers history_query tool');
  assert.match(pluginJs, /history\.query/, 'tool label documents history.query action');
  assert.match(pluginJs, /history-query/, 'history.query telemetry event emitted');
  assert.match(pluginJs, /HYPERMEM_TELEMETRY_PATH/, 'history.query uses standard telemetry path');
  assert.match(pluginJs, /senderIsOwner/, 'raw tool payload opt-in is owner-gated');

  runNode(['--test', 'test/history-query-surface.mjs']);
  runNode(['--test', 'test/sql-safety.test.mjs']);

  const dataDir = createMinimalDataDir();
  const raw = runNode(['bin/hypermem-status.mjs', '--master', '--json'], { HYPERMEM_DATA_DIR: dataDir });
  const status = JSON.parse(raw);
  assert.equal(status.querySurfaces.historyQuery.status, 'ok', 'health surface reports history.query as ok');
  assert.equal(status.querySurfaces.historyQuery.coreApi, true, 'health surface sees core API');
  assert.equal(status.querySurfaces.historyQuery.pluginTool, true, 'health surface sees plugin tool');
  assert.equal(status.querySurfaces.historyQuery.telemetry, true, 'health surface sees telemetry');
  assert.equal(status.querySurfaces.historyQuery.schemaReady, true, 'health surface sees message schema support');

  console.log('✅ history.query validation passed');
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
