import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const cleanup = path.join(root, 'bin', 'hypermem-cleanup.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hypermem-cleanup-'));
const agentDir = path.join(tmp, 'agents', 'forge');
mkdirSync(agentDir, { recursive: true });
const dbPath = path.join(agentDir, 'messages.db');

const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_key TEXT UNIQUE,
    agent_id TEXT,
    channel_type TEXT,
    message_count INTEGER DEFAULT 0,
    updated_at TEXT
  );
  CREATE TABLE messages (
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
    created_at TEXT NOT NULL,
    parent_id INTEGER REFERENCES messages(id),
    depth INTEGER NOT NULL DEFAULT 0,
    context_id INTEGER
  );
  CREATE VIRTUAL TABLE messages_fts USING fts5(text_content, content='messages', content_rowid='id');
  CREATE TRIGGER msg_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text_content) VALUES (new.id, new.text_content);
  END;
  CREATE TRIGGER msg_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text_content) VALUES('delete', old.id, old.text_content);
  END;
  CREATE TABLE summary_messages (summary_id INTEGER NOT NULL, message_id INTEGER NOT NULL REFERENCES messages(id), PRIMARY KEY(summary_id, message_id));
  CREATE TABLE contexts (id INTEGER PRIMARY KEY, head_message_id INTEGER REFERENCES messages(id));
  CREATE TABLE composition_snapshots (id INTEGER PRIMARY KEY, head_message_id INTEGER REFERENCES messages(id));
  CREATE TABLE tool_artifacts (id TEXT PRIMARY KEY, message_id INTEGER REFERENCES messages(id));
  CREATE TABLE entity_bridge_message_index (message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, agent_id TEXT, conversation_id INTEGER);
`);
db.prepare('INSERT INTO conversations (id, session_key, agent_id, channel_type, message_count, updated_at) VALUES (1, ?, ?, ?, 0, ?)')
  .run('agent:forge:webchat:forge-main', 'forge', 'webchat', '2026-05-10T00:00:00.000Z');

function insertMessage(text, idx, createdAt, parentId = null) {
  return db.prepare(`INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, created_at, parent_id)
                     VALUES (1, 'forge', 'user', ?, ?, ?, ?)`).run(text, idx, createdAt, parentId).lastInsertRowid;
}

const stamped = '[Sat 2026-05-09 18:49 MST] Ok';
const keepId = insertMessage(stamped, 1, '2026-05-10T01:49:33.103Z');
const dupId = insertMessage(stamped, 2, '2026-05-10T01:50:44.432Z');
const childId = insertMessage('[Sat 2026-05-09 18:50 MST] Different message', 3, '2026-05-10T01:51:00.000Z', dupId);
const unstampedRepeat1 = insertMessage('ok', 4, '2026-05-10T01:52:00.000Z');
const unstampedRepeat2 = insertMessage('ok', 5, '2026-05-10T01:53:00.000Z');

db.prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (10, ?)').run(dupId);
db.prepare('INSERT INTO contexts (id, head_message_id) VALUES (1, ?)').run(dupId);
db.prepare('INSERT INTO composition_snapshots (id, head_message_id) VALUES (1, ?)').run(dupId);
db.prepare('INSERT INTO tool_artifacts (id, message_id) VALUES (?, ?)').run('artifact-1', dupId);
db.prepare('INSERT INTO entity_bridge_message_index (message_id, agent_id, conversation_id) VALUES (?, ?, ?)').run(dupId, 'forge', 1);
db.prepare('UPDATE conversations SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = 1)').run();
db.close();

let result = spawnSync(process.execPath, [cleanup, '--data-dir', tmp, '--agent', 'forge', '--json'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr || result.stdout);
let parsed = JSON.parse(result.stdout);
assert.equal(parsed.dryRun, true);
assert.equal(parsed.total.duplicateGroups, 1);
assert.equal(parsed.total.duplicateRows, 1);
assert.equal(parsed.total.deletedRows, 0);

let checkDb = new DatabaseSync(dbPath);
assert.equal(checkDb.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 5, 'dry-run does not delete rows');
checkDb.close();

result = spawnSync(process.execPath, [cleanup, '--data-dir', tmp, '--agent', 'forge', '--apply', '--json'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr || result.stdout);
parsed = JSON.parse(result.stdout);
assert.equal(parsed.dryRun, false);
assert.equal(parsed.total.duplicateGroups, 1);
assert.equal(parsed.total.duplicateRows, 1);
assert.equal(parsed.total.deletedRows, 1);
assert.equal(parsed.results[0].postApplyDuplicateGroups, 0);
assert(parsed.results[0].backupPath, 'apply mode creates a backup by default');
readFileSync(parsed.results[0].backupPath);

checkDb = new DatabaseSync(dbPath);
assert.equal(checkDb.prepare('SELECT COUNT(*) AS c FROM messages').get().c, 4, 'apply deletes only stamped duplicate row');
assert.equal(checkDb.prepare('SELECT COUNT(*) AS c FROM messages WHERE text_content = ?').get(stamped).c, 1);
assert.equal(checkDb.prepare('SELECT COUNT(*) AS c FROM messages WHERE text_content = ?').get('ok').c, 2, 'unstamped short repeats are preserved');
assert.equal(checkDb.prepare('SELECT parent_id FROM messages WHERE id = ?').get(childId).parent_id, keepId, 'child parent is rewired to canonical row');
assert.equal(checkDb.prepare('SELECT message_id FROM summary_messages WHERE summary_id = 10').get().message_id, keepId, 'summary reference is moved');
assert.equal(checkDb.prepare('SELECT head_message_id FROM contexts WHERE id = 1').get().head_message_id, keepId, 'context head is moved');
assert.equal(checkDb.prepare('SELECT head_message_id FROM composition_snapshots WHERE id = 1').get().head_message_id, keepId, 'snapshot head is moved');
assert.equal(checkDb.prepare('SELECT message_id FROM tool_artifacts WHERE id = ?').get('artifact-1').message_id, keepId, 'tool artifact is moved');
assert.equal(checkDb.prepare('SELECT COUNT(*) AS c FROM entity_bridge_message_index WHERE message_id = ?').get(dupId).c, 0, 'derived duplicate index row is removed');
assert.equal(checkDb.prepare('SELECT message_count FROM conversations WHERE id = 1').get().message_count, 4, 'conversation message_count is reconciled');
assert.deepEqual(checkDb.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]), ['ok']);
assert.equal(checkDb.prepare('PRAGMA foreign_key_check').all().length, 0);
checkDb.close();

console.log('cleanup-cli tests passed');
