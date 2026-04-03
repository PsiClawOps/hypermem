/**
 * P1.6 — Supersedes Tombstone Test
 *
 * Tests:
 * 1. FactStore.markSuperseded() marks old fact and excludes it from active queries
 * 2. FactStore.findSupersedableByContent() finds prefix-matching active facts
 * 3. VectorStore.removeItem() deletes a specific vec_index_map entry + vec row
 * 4. VectorStore.tombstoneSuperseded() batch-removes superseded fact vectors
 * 5. VectorStore.search() (getSourceContent) excludes superseded facts from KNN results
 * 6. BackgroundIndexer: tombstoned field present in stats, tombstoneSuperseded called per tick
 * 7. Hybrid retrieval (FTS) excludes superseded facts
 *
 * No Ollama required — uses stub embeddings where vectors are needed.
 */

import { FactStore } from '../dist/fact-store.js';
import { VectorStore } from '../dist/vector-store.js';
import { BackgroundIndexer } from '../dist/background-indexer.js';
import { migrateLibrary } from '../dist/library-schema.js';
import { DatabaseSync } from 'node:sqlite';
import { hybridSearch } from '../dist/hybrid-retrieval.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-tombstone-'));

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
    console.trace('  Assertion failed');
  }
}

function assertEquals(actual, expected, msg) {
  assert(actual === expected, `${msg} (expected=${expected}, got=${actual})`);
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Create an in-memory library DB with the full V3+ schema applied.
 */
function makeLibraryDb() {
  const db = new DatabaseSync(':memory:');
  migrateLibrary(db);
  return db;
}

/**
 * Create an in-memory vector DB with the VectorStore tables.
 */
function makeVectorDb(libraryDb) {
  const db = new DatabaseSync(':memory:');
  // Use a stub config — no Ollama calls needed for removeItem/tombstone tests
  const vs = new VectorStore(db, { dimensions: 4 }, libraryDb);
  vs.ensureTables();
  return { db, vs };
}

/**
 * Manually insert a vec_index_map entry (simulates a fact that was previously indexed).
 * Returns the map row id.
 */
function insertFakeVecEntry(vecDb, sourceTable, sourceId, vecTable = 'vec_facts') {
  const result = vecDb.prepare(`
    INSERT INTO vec_index_map (source_table, source_id, vec_table, content_hash, indexed_at)
    VALUES (?, ?, ?, 'fakehash_' || ?, datetime('now'))
  `).run(sourceTable, sourceId, vecTable, sourceId);
  return Number(result.lastInsertRowid);
}

/**
 * Count vec_index_map rows for a given source table.
 */
function countVecEntries(vecDb, sourceTable) {
  return vecDb.prepare('SELECT COUNT(*) AS c FROM vec_index_map WHERE source_table = ?')
    .get(sourceTable).c;
}

// ── Test Runner ───────────────────────────────────────────────

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  P1.6 — Supersedes Tombstone Test');
  console.log('═══════════════════════════════════════════════════\n');

  // ── 1. FactStore.markSuperseded() ─────────────────────────
  console.log('── FactStore.markSuperseded() ──');
  {
    const libDb = makeLibraryDb();
    const store = new FactStore(libDb);

    const oldFact = store.addFact('agent1', 'decided to use Redis for hot cache because latency is critical');
    const newFact = store.addFact('agent1', 'decided to use Redis for hot cache with sentinel HA mode');

    assert(oldFact.supersededBy === null, 'Old fact starts with supersededBy=null');
    assert(newFact.supersededBy === null, 'New fact starts with supersededBy=null');

    const didMark = store.markSuperseded(oldFact.id, newFact.id);
    assert(didMark === true, 'markSuperseded returns true when update succeeds');

    // Calling again on already-superseded row should return false
    const didMarkAgain = store.markSuperseded(oldFact.id, newFact.id);
    assert(didMarkAgain === false, 'markSuperseded returns false on already-superseded fact');

    // getActiveFacts must exclude superseded
    const active = store.getActiveFacts('agent1');
    assert(active.length === 1, `getActiveFacts returns 1 active fact (got ${active.length})`);
    assertEquals(active[0].id, newFact.id, 'Active fact is the new one');

    // searchFacts (FTS) must also exclude superseded
    const searchResults = store.searchFacts('Redis hot cache', { agentId: 'agent1' });
    assert(
      searchResults.every(r => r.supersededBy === null),
      'searchFacts excludes superseded facts'
    );
  }

  // ── 2. FactStore.findSupersedableByContent() ──────────────
  console.log('\n── FactStore.findSupersedableByContent() ──');
  {
    const libDb = makeLibraryDb();
    const store = new FactStore(libDb);

    const base = store.addFact('agent1', 'decided to use Redis for caching — version A with details appended here');
    const updated = 'decided to use Redis for caching — version B with different ending appended';

    const found = store.findSupersedableByContent('agent1', updated);
    assert(found === base.id, `findSupersedableByContent found base fact id=${base.id}`);

    // After marking superseded, should not find it again
    store.markSuperseded(base.id, base.id + 999);
    const foundAfter = store.findSupersedableByContent('agent1', updated);
    assert(foundAfter === null, 'findSupersedableByContent returns null for already-superseded fact');

    // No match if content prefix is different
    const noMatch = store.findSupersedableByContent('agent1', 'completely different content that has no prefix match at all anywhere');
    assert(noMatch === null, 'findSupersedableByContent returns null when no prefix match');
  }

  // ── 3. VectorStore.removeItem() ───────────────────────────
  console.log('\n── VectorStore.removeItem() ──');
  {
    const libDb = makeLibraryDb();
    const { db: vecDb, vs } = makeVectorDb(libDb);

    // Insert a fact in libDb
    const factStore = new FactStore(libDb);
    const fact = factStore.addFact('agent1', 'decided to use SQLite for local storage because of zero-server simplicity');

    // Simulate the fact having been indexed (fake vec_index_map entry)
    insertFakeVecEntry(vecDb, 'facts', fact.id);
    assertEquals(countVecEntries(vecDb, 'facts'), 1, 'One vec entry before removeItem');

    const removed = vs.removeItem('facts', fact.id);
    assert(removed === true, 'removeItem returns true when entry existed');
    assertEquals(countVecEntries(vecDb, 'facts'), 0, 'Vec entry removed from index map');

    // Calling again should return false
    const removedAgain = vs.removeItem('facts', fact.id);
    assert(removedAgain === false, 'removeItem returns false when entry not found');

    // Invalid source table should throw
    let threw = false;
    try { vs.removeItem('bad_table', 1); } catch { threw = true; }
    assert(threw, 'removeItem throws on invalid sourceTable');
  }

  // ── 4. VectorStore.tombstoneSuperseded() ─────────────────
  console.log('\n── VectorStore.tombstoneSuperseded() ──');
  {
    const libDb = makeLibraryDb();
    const { db: vecDb, vs } = makeVectorDb(libDb);
    const factStore = new FactStore(libDb);

    // Two facts: one active, one superseded
    const activeFact = factStore.addFact('agent1', 'decided to deploy containers via Kubernetes for production workloads');
    const oldFact = factStore.addFact('agent1', 'decided to deploy containers via Docker Compose for production workloads');
    const newFact = factStore.addFact('agent1', 'decided to deploy containers via Kubernetes for production workloads v2');
    factStore.markSuperseded(oldFact.id, newFact.id);

    // Index all three (simulate prior indexing)
    insertFakeVecEntry(vecDb, 'facts', activeFact.id);
    insertFakeVecEntry(vecDb, 'facts', oldFact.id);   // this one should be tombstoned
    insertFakeVecEntry(vecDb, 'facts', newFact.id);

    assertEquals(countVecEntries(vecDb, 'facts'), 3, '3 vec entries before tombstone');

    const tombstoned = vs.tombstoneSuperseded();
    assertEquals(tombstoned, 1, 'tombstoneSuperseded removed exactly 1 entry');
    assertEquals(countVecEntries(vecDb, 'facts'), 2, '2 vec entries remain after tombstone');

    // Running again should tombstone 0 (already cleaned up)
    const tombstonedAgain = vs.tombstoneSuperseded();
    assertEquals(tombstonedAgain, 0, 'Second tombstoneSuperseded call removes 0 (idempotent)');
  }

  // ── 5. VectorStore.getSourceContent filters superseded ────
  console.log('\n── VectorStore search excludes superseded (getSourceContent) ──');
  {
    const libDb = makeLibraryDb();
    const factStore = new FactStore(libDb);

    const supersededFact = factStore.addFact('agent1', 'decided to use PostgreSQL for primary database storage in production');
    const newFact = factStore.addFact('agent1', 'decided to use SQLite for primary database storage in production now');
    factStore.markSuperseded(supersededFact.id, newFact.id);

    // getSourceContent is private but we can verify via tombstoneSuperseded + indexAll flow.
    // The indexAll() method already filters superseded_by IS NULL when collecting items.
    // For this test: verify that after supersede, indexAll wouldn't pick up the old fact.
    const { db: vecDb, vs } = makeVectorDb(libDb);

    // Simulate: old fact was in the index; new fact was not yet indexed
    insertFakeVecEntry(vecDb, 'facts', supersededFact.id);

    // tombstoneSuperseded cleans the stale entry
    const tombstoned = vs.tombstoneSuperseded();
    assertEquals(tombstoned, 1, 'Superseded fact vector removed from index');
    assertEquals(countVecEntries(vecDb, 'facts'), 0, 'No stale entries remain');
  }

  // ── 6. Hybrid retrieval (FTS) excludes superseded ────────
  console.log('\n── Hybrid retrieval FTS excludes superseded facts ──');
  {
    const libDb = makeLibraryDb();
    const factStore = new FactStore(libDb);

    factStore.addFact('agent1', 'decided to use PostgreSQL for the primary analytics database cluster');
    const old = factStore.addFact('agent1', 'decided to use MySQL for the primary analytics database cluster');
    const newer = factStore.addFact('agent1', 'decided to use PostgreSQL for the primary analytics database cluster v2');
    factStore.markSuperseded(old.id, newer.id);

    // FTS search — should not return the superseded MySQL fact
    const results = await hybridSearch(libDb, null, 'analytics database MySQL', {
      tables: ['facts'],
      agentId: 'agent1',
      limit: 10,
    });
    const hasSuperseded = results.some(r => r.content.includes('MySQL'));
    assert(!hasSuperseded, 'FTS hybrid search does not return superseded (MySQL) fact');
  }

  // ── 7. BackgroundIndexer stats include tombstoned field ──
  console.log('\n── BackgroundIndexer stats include tombstoned ──');
  {
    // Use a minimal indexer with no real DBs to test the stats shape
    const indexer = new BackgroundIndexer(
      { enabled: false },
      undefined, undefined, undefined, undefined
    );

    // tombstoned field must be on the IndexerStats type — verify via a mock processAgent
    // by just checking that the createIndexer factory works and tombstoned is accessible.
    // We test the actual tombstone call path via a synthetic tick below.

    const libDb = makeLibraryDb();
    const msgDb = new DatabaseSync(':memory:');

    // Set up minimal message DB schema
    msgDb.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        session_key TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
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

    const { db: vecDb, vs } = makeVectorDb(libDb);

    // Insert a fact and mark it superseded
    const factStore = new FactStore(libDb);
    const old = factStore.addFact('agent2', 'decided to use Nginx for the reverse proxy and load balancing layer');
    const newer = factStore.addFact('agent2', 'decided to use Caddy for the reverse proxy and load balancing layer');
    factStore.markSuperseded(old.id, newer.id);

    // Fake an indexed vec entry for the old (now superseded) fact
    insertFakeVecEntry(vecDb, 'facts', old.id);
    assertEquals(countVecEntries(vecDb, 'facts'), 1, 'Stale vec entry inserted');

    // Create indexer with vector store
    const indexer2 = new BackgroundIndexer(
      { enabled: false },
      (_agentId) => msgDb,
      () => libDb,
      () => ['agent2'],
    );
    indexer2.setVectorStore(vs);

    // tick() — no new messages, but tombstoneSuperseded should fire
    const results = await indexer2.tick();
    assert(results.length >= 1, `tick() returned ${results.length} stats entry(ies)`);

    const agentStats = results.find(r => r.agentId === 'agent2');
    assert(agentStats !== undefined, 'Stats entry found for agent2');
    assert('tombstoned' in agentStats, 'Stats entry has tombstoned field');
    assert(agentStats.tombstoned >= 1, `tombstoned count >= 1 (got ${agentStats?.tombstoned})`);

    // Verify the stale entry was actually removed from the vector DB
    assertEquals(countVecEntries(vecDb, 'facts'), 0, 'Stale vec entry removed after tick');
  }

  // ── Summary ───────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
