/**
 * Topic Touch Regression — background indexer must call touch() on every
 * topic-bearing message, not just when it mints a new topic. Without this,
 * message_count stays at 0 forever and every topic becomes an orphan by
 * construction (hit by the 48h lint and eventually pruned at 14d).
 *
 * Root cause of the 2026-04-17 "111 orphan topics" report: the else-branch
 * of the findOrCreate check did nothing, so no topic ever accumulated
 * activity counts.
 */

import { DatabaseSync } from 'node:sqlite';
import { migrateLibrary } from '../dist/library-schema.js';
import { TopicStore } from '../dist/topic-store.js';
import { BackgroundIndexer } from '../dist/background-indexer.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ FAIL: ${msg}`); failed++; }
}

function makeLibraryDb() {
  const db = new DatabaseSync(':memory:');
  migrateLibrary(db);
  return db;
}

/**
 * Build a minimal message-source DB matching the shape background-indexer expects
 * (matches the schema used in supersedes-tombstone.mjs test).
 */
function makeMessageDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      session_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text_content TEXT,
      tool_calls TEXT,
      tool_results TEXT,
      metadata TEXT,
      message_index INTEGER DEFAULT 0,
      token_count INTEGER,
      is_heartbeat INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

async function runTest() {
  console.log('\n── Topic Touch Regression ──\n');

  const libraryDb = makeLibraryDb();
  const messageDb = makeMessageDb();
  const topicStore = new TopicStore(libraryDb);
  const agentId = 'forge';
  const sessionKey = 'agent:forge:webchat:topic-touch-test';
  const now = new Date().toISOString();

  // Create one conversation, insert a few messages whose content will trigger
  // detectTopic on the same canonical topic ("hypermem"). We need enough
  // lexical signal in the text for detectTopic to return a topic name.
  const convoResult = messageDb.prepare(
    `INSERT INTO conversations (agent_id, session_key, created_at) VALUES (?, ?, ?)`
  ).run(agentId, sessionKey, now);
  const convoId = Number(convoResult.lastInsertRowid);

  const insertMsg = (role, text) => messageDb.prepare(`
    INSERT INTO messages (conversation_id, agent_id, role, text_content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(convoId, agentId, role, text, now);

  // Three messages about hypermem — detectTopic should resolve these to a
  // stable topic name.
  insertMsg('user',
    'Looking at the hypermem compositor performance this morning. The hypermem cache hit rate seems off.');
  insertMsg('assistant',
    'Reviewing hypermem schema migrations and the topic-store touch() semantics. The hypermem indexer never increments counts.');
  insertMsg('user',
    'The hypermem background indexer needs a touch() call on every topic hit — not just on creation. Fix hypermem.');

  // Build indexer using the (config, getMessageDb, getLibraryDb, listAgents, getCursor)
  // constructor form used elsewhere in the test suite.
  const indexer = new BackgroundIndexer(
    { enabled: false },
    (_agentId) => messageDb,
    () => libraryDb,
    () => [agentId],
  );

  await indexer.tick();

  // Assertion 1: at least one topic was created
  const topics = topicStore.getActive(agentId, 100);
  assert(topics.length >= 1, `at least one topic recorded (got ${topics.length})`);

  // Assertion 2: at least one topic has message_count > 0 (the regression check)
  const withActivity = topics.filter((t) => t.messageCount > 0);
  assert(withActivity.length >= 1,
    `at least one topic has message_count > 0 — orphan bug fix (topics: ${topics.map((t) => `${t.name}=${t.messageCount}`).join(', ')})`);

  // Assertion 3: last_session_key was recorded on the touched topic
  const touched = withActivity[0];
  if (touched) {
    assert(touched.lastSessionKey === sessionKey,
      `last_session_key propagated (got ${touched.lastSessionKey})`);
  }

  // Assertion 4: a second tick with no new messages must not double-count
  const countsBefore = topics.map((t) => [t.name, t.messageCount]);
  await indexer.tick();
  const topics2 = topicStore.getActive(agentId, 100);
  let stable = true;
  for (const [name, count] of countsBefore) {
    const t = topics2.find((x) => x.name === name);
    if (!t || t.messageCount !== count) { stable = false; break; }
  }
  assert(stable, `cursor prevents double-count on second tick`);

  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
  process.exit(failed === 0 ? 0 : 1);
}

runTest().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
