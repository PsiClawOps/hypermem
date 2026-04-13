/**
 * SessionTopicMap tests (P3.3)
 *
 * Tests all five methods: getActiveTopic, activateTopic, createTopic,
 * listTopics, incrementMessageCount.
 *
 * Uses an in-memory SQLite DB (v6 schema) — no Redis required.
 */

import { DatabaseSync } from 'node:sqlite';
import { SessionTopicMap } from '../dist/session-topic-map.js';
import { migrate } from '../dist/schema.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
    // Print stack for easier debugging
    console.error(new Error(`Assertion failed: ${msg}`).stack);
  }
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

function run() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  SessionTopicMap tests');
  console.log('═══════════════════════════════════════════════════\n');

  const SK = 'agent:alice:webchat:main';
  const SK2 = 'agent:alice:webchat:other';

  // ── createTopic ──────────────────────────────────────────────
  console.log('── createTopic ──');
  {
    const db = makeDb();
    const map = new SessionTopicMap(db);

    const id1 = map.createTopic(SK, 'Hypermem architecture');
    assert(typeof id1 === 'string' && id1.length > 0, 'createTopic returns non-empty string id');

    const id2 = map.createTopic(SK, 'Redis eviction handling');
    assert(id1 !== id2, 'Two createTopic calls return distinct ids');

    // Topic name truncated at 40 chars
    const longName = 'A very long topic name that exceeds forty chars for sure';
    const id3 = map.createTopic(SK, longName);
    assert(typeof id3 === 'string', 'createTopic with long name succeeds');

    const rows = db.prepare('SELECT name FROM topics WHERE id = ?').all(id3);
    assert(rows.length === 1, 'Long-name topic stored in DB');
    assert(rows[0].name.length <= 40, `Name truncated to ≤40 chars (got ${rows[0].name.length})`);
  }

  // ── getActiveTopic ────────────────────────────────────────────
  console.log('\n── getActiveTopic ──');
  {
    const db = makeDb();
    const map = new SessionTopicMap(db);

    // Empty session → null
    const none = map.getActiveTopic(SK);
    assert(none === null, 'getActiveTopic returns null when no topics');

    // Create two topics — second should be "most recent"
    const id1 = map.createTopic(SK, 'First topic');
    // Small sleep to ensure last_active_at differs
    const t1 = Date.now();
    while (Date.now() === t1) { /* spin */ }
    const id2 = map.createTopic(SK, 'Second topic');

    const active = map.getActiveTopic(SK);
    assert(active !== null, 'getActiveTopic returns topic after creation');
    assert(active.id === id2, `getActiveTopic returns most recently created (got ${active.id})`);
    assert(active.name === 'Second topic', `getActiveTopic returns correct name (got ${active.name})`);

    // Different session → null
    const otherNone = map.getActiveTopic(SK2);
    assert(otherNone === null, 'getActiveTopic returns null for unrelated session');

    // Create topic in other session
    map.createTopic(SK2, 'Other session topic');
    const otherActive = map.getActiveTopic(SK2);
    assert(otherActive !== null, 'getActiveTopic returns topic for other session');
    assert(otherActive.name === 'Other session topic', 'getActiveTopic cross-session isolation');

    // SK1 still returns id2
    const stillActive = map.getActiveTopic(SK);
    assert(stillActive?.id === id2, 'SK1 unaffected by SK2 topic');
  }

  // ── activateTopic ─────────────────────────────────────────────
  console.log('\n── activateTopic ──');
  {
    const db = makeDb();
    const map = new SessionTopicMap(db);

    const id1 = map.createTopic(SK, 'Topic A');
    const t1 = Date.now();
    while (Date.now() === t1) { /* spin */ }
    const id2 = map.createTopic(SK, 'Topic B');

    // id2 is currently active (more recent)
    assert(map.getActiveTopic(SK)?.id === id2, 'Pre-condition: id2 is active');

    // Activate id1 → it should become active
    const t2 = Date.now();
    while (Date.now() === t2) { /* spin */ }
    map.activateTopic(SK, id1);
    const nowActive = map.getActiveTopic(SK);
    assert(nowActive?.id === id1, `activateTopic makes id1 active (got ${nowActive?.id})`);

    // Activating a non-existent topic is a no-op
    map.activateTopic(SK, 'nonexistent-uuid');
    assert(map.getActiveTopic(SK)?.id === id1, 'activateTopic with bad id is no-op');
  }

  // ── listTopics ────────────────────────────────────────────────
  console.log('\n── listTopics ──');
  {
    const db = makeDb();
    const map = new SessionTopicMap(db);

    // Empty
    const empty = map.listTopics(SK);
    assert(Array.isArray(empty) && empty.length === 0, 'listTopics returns empty array when no topics');

    const ids = [];
    for (let i = 0; i < 3; i++) {
      // Ensure different timestamps
      const tNow = Date.now();
      while (Date.now() === tNow) { /* spin */ }
      ids.push(map.createTopic(SK, `Topic ${i}`));
    }

    const list = map.listTopics(SK);
    assert(list.length === 3, `listTopics returns all topics (got ${list.length})`);

    // Should be ordered by last_active_at DESC → last created is first
    assert(list[0].id === ids[2], `listTopics: most recent first (got ${list[0].id})`);
    assert(list[2].id === ids[0], `listTopics: oldest last (got ${list[2].id})`);

    // Check shape
    const t = list[0];
    assert(typeof t.id === 'string', 'listTopics item has string id');
    assert(typeof t.name === 'string', 'listTopics item has string name');
    assert(typeof t.messageCount === 'number', 'listTopics item has number messageCount');
    assert(typeof t.lastActiveAt === 'number', 'listTopics item has number lastActiveAt');

    // Cross-session isolation
    map.createTopic(SK2, 'SK2 topic');
    assert(map.listTopics(SK).length === 3, 'listTopics does not bleed across sessions');
    assert(map.listTopics(SK2).length === 1, 'listTopics returns only SK2 topics for SK2');
  }

  // ── incrementMessageCount ─────────────────────────────────────
  console.log('\n── incrementMessageCount ──');
  {
    const db = makeDb();
    const map = new SessionTopicMap(db);

    const id = map.createTopic(SK, 'Count topic');
    const before = map.listTopics(SK)[0];
    assert(before.messageCount === 0, `Initial messageCount is 0 (got ${before.messageCount})`);

    map.incrementMessageCount(id);
    map.incrementMessageCount(id);
    map.incrementMessageCount(id);

    const after = map.listTopics(SK)[0];
    assert(after.messageCount === 3, `messageCount is 3 after 3 increments (got ${after.messageCount})`);

    // No-op for nonexistent id
    map.incrementMessageCount('no-such-id');
    const unchanged = map.listTopics(SK)[0];
    assert(unchanged.messageCount === 3, 'incrementMessageCount on bad id is no-op');
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

run();
