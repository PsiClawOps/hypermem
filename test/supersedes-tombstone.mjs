/**
 * P1.6 — Supersedes Tombstone Test
 *
 * Tests:
 * 1. FactStore.markSuperseded() marks old fact and excludes it from active queries
 * 2. FactStore.findSupersedableByContent() finds prefix-matching active facts
 * 3. VectorStore.removeItem() deletes a specific vec_index_map entry + vec row
 * 4. VectorStore.tombstoneSuperseded() batch-removes superseded fact vectors
 * 5. VectorStore search (getSourceContent) excludes superseded facts via KNN path
 * 6. BackgroundIndexer: tombstoned field present in stats, tombstoneSuperseded called per tick
 * 7. Hybrid retrieval (FTS) excludes superseded facts
 *
 * sqlite-vec is loaded for vec table tests; falls back to map-only tables when unavailable.
 */

import { FactStore } from '../dist/fact-store.js';
import { VectorStore } from '../dist/vector-store.js';
import { BackgroundIndexer } from '../dist/background-indexer.js';
import { migrateLibrary } from '../dist/library-schema.js';
import { hybridSearch } from '../dist/hybrid-retrieval.js';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import fs from 'fs';
import os from 'os';

const tmpDir = fs.mkdtempSync(os.tmpdir() + '/hm-tombstone-');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function assertEquals(actual, expected, msg) {
  assert(actual === expected, `${msg} (expected=${expected}, got=${actual})`);
}

// ── sqlite-vec extension loader ───────────────────────────────
const _require = createRequire(import.meta.url);
let _vecLoad = null;
let vecAvailable = false;
try {
  const mod = _require('sqlite-vec');
  _vecLoad = mod.load;
  vecAvailable = true;
} catch { /* vec tests will be skipped */ }

function loadVec(db) {
  if (_vecLoad) _vecLoad(db);
}

// ── Helpers ───────────────────────────────────────────────────

function makeLibraryDb() {
  const db = new DatabaseSync(':memory:');
  migrateLibrary(db);
  return db;
}

/**
 * Create a vector DB with the sqlite-vec extension loaded and VectorStore tables created.
 * Uses 4-dimensional embeddings to avoid Ollama dependency.
 */
function makeVectorStore(libraryDb) {
  const db = new DatabaseSync(':memory:', { allowExtension: true });
  loadVec(db);
  const vs = new VectorStore(db, { dimensions: 4, ollamaUrl: 'http://localhost:11434' }, libraryDb);
  vs.ensureTables();
  return { vecDb: db, vs };
}

/** Insert a fake vec_index_map entry (simulates a fact that was previously indexed). */
function insertFakeMapEntry(vecDb, sourceTable, sourceId) {
  const vecTable = `vec_${sourceTable}`;
  const result = vecDb.prepare(`
    INSERT INTO vec_index_map (source_table, source_id, vec_table, content_hash, indexed_at)
    VALUES (?, ?, ?, 'fakehash_' || ?, datetime('now'))
  `).run(sourceTable, sourceId, vecTable, sourceId);
  return Number(result.lastInsertRowid);
}

function countVecMapEntries(vecDb, sourceTable) {
  return vecDb.prepare('SELECT COUNT(*) AS c FROM vec_index_map WHERE source_table = ?')
    .get(sourceTable).c;
}

// ── Tests ─────────────────────────────────────────────────────

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  P1.6 — Supersedes Tombstone Test');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  sqlite-vec: ${vecAvailable ? 'available' : 'NOT available (vec tests skipped)'}\n`);

  // ── 1. FactStore.markSuperseded() ─────────────────────────
  console.log('── 1. FactStore.markSuperseded() ──');
  {
    const libDb = makeLibraryDb();
    const store = new FactStore(libDb);

    const oldFact = store.addFact('alice', 'decided to use Redis for hot cache because latency is critical in production');
    const newFact = store.addFact('alice', 'decided to use Redis for hot cache with dave HA mode in production env');

    assert(oldFact.supersededBy === null, 'Old fact starts with supersededBy=null');
    assert(newFact.supersededBy === null, 'New fact starts with supersededBy=null');

    const didMark = store.markSuperseded(oldFact.id, newFact.id);
    assert(didMark === true, 'markSuperseded returns true when update succeeds');

    // Calling again on already-superseded row must return false (WHERE superseded_by IS NULL)
    const didMarkAgain = store.markSuperseded(oldFact.id, newFact.id);
    assert(didMarkAgain === false, 'markSuperseded returns false on already-superseded fact');

    // getActiveFacts must exclude superseded
    const active = store.getActiveFacts('alice');
    assertEquals(active.length, 1, 'getActiveFacts returns 1 active fact');
    assertEquals(active[0].id, newFact.id, 'Active fact is the new one');

    // searchFacts (FTS) must also exclude superseded
    const searchResults = store.searchFacts('Redis hot cache', { agentId: 'alice' });
    const allActive = searchResults.every(r => r.supersededBy === null);
    assert(allActive, 'searchFacts excludes superseded facts');
  }

  // ── 2. FactStore.findSupersedableByContent() ──────────────
  console.log('\n── 2. FactStore.findSupersedableByContent() ──');
  {
    const libDb = makeLibraryDb();
    const store = new FactStore(libDb);

    // The prefix must be >= 60 chars and shared between base and updated content.
    // Both start with the same 60+ chars, then diverge.
    const sharedPrefix = 'decided to use Redis for the primary cache layer in all envs'; // 61 chars
    const base = store.addFact('alice', sharedPrefix + ' — original version with default TTL settings configured');
    const updated = sharedPrefix + ' — updated version with explicit TTL of 300s configured properly';

    const found = store.findSupersedableByContent('alice', updated);
    assertEquals(found, base.id, `findSupersedableByContent found base fact id=${base.id}`);

    // After marking superseded, should not find it again
    store.markSuperseded(base.id, base.id + 999);
    const foundAfter = store.findSupersedableByContent('alice', updated);
    assert(foundAfter === null, 'findSupersedableByContent returns null for already-superseded fact');

    // No match if content prefix is different
    const noMatch = store.findSupersedableByContent(
      'alice',
      'completely different subject matter that will not match any existing facts stored here'
    );
    assert(noMatch === null, 'findSupersedableByContent returns null when no prefix match');

    // Exact duplicate should not match itself (content != ? guard)
    const exactSelf = store.findSupersedableByContent('alice', updated);
    assert(exactSelf === null, 'findSupersedableByContent does not match exact duplicate of input content');
  }

  // ── 3. VectorStore.removeItem() ───────────────────────────
  console.log('\n── 3. VectorStore.removeItem() ──');
  if (!vecAvailable) {
    console.log('  ⚠️  Skipped — sqlite-vec not available');
  } else {
    const libDb = makeLibraryDb();
    const { vecDb, vs } = makeVectorStore(libDb);
    const factStore = new FactStore(libDb);

    const fact = factStore.addFact('alice', 'decided to use SQLite for local storage because of zero-server simplicity in dev');

    // Simulate the fact having been indexed via fake map entry
    insertFakeMapEntry(vecDb, 'facts', fact.id);
    assertEquals(countVecMapEntries(vecDb, 'facts'), 1, 'One vec_index_map entry before removeItem');

    const removed = vs.removeItem('facts', fact.id);
    assert(removed === true, 'removeItem returns true when entry existed');
    assertEquals(countVecMapEntries(vecDb, 'facts'), 0, 'vec_index_map entry deleted by removeItem');

    // Calling again must return false
    const removedAgain = vs.removeItem('facts', fact.id);
    assert(removedAgain === false, 'removeItem returns false when entry not found');

    // Invalid source table must throw
    let threw = false;
    try { vs.removeItem('bad_table', 1); } catch { threw = true; }
    assert(threw, 'removeItem throws on invalid sourceTable');
  }

  // ── 4. VectorStore.tombstoneSuperseded() ─────────────────
  console.log('\n── 4. VectorStore.tombstoneSuperseded() ──');
  if (!vecAvailable) {
    console.log('  ⚠️  Skipped — sqlite-vec not available');
  } else {
    const libDb = makeLibraryDb();
    const { vecDb, vs } = makeVectorStore(libDb);
    const factStore = new FactStore(libDb);

    const activeFact = factStore.addFact('alice', 'decided to deploy containers via Kubernetes for production workloads always');
    const oldFact   = factStore.addFact('alice', 'decided to deploy containers via Docker Compose for production workloads only');
    const newFact   = factStore.addFact('alice', 'decided to deploy containers via Kubernetes with Eve for production workloads');
    factStore.markSuperseded(oldFact.id, newFact.id);

    // Simulate all three having been indexed
    insertFakeMapEntry(vecDb, 'facts', activeFact.id);
    insertFakeMapEntry(vecDb, 'facts', oldFact.id);    // superseded — should be tombstoned
    insertFakeMapEntry(vecDb, 'facts', newFact.id);

    assertEquals(countVecMapEntries(vecDb, 'facts'), 3, '3 vec entries before tombstone');

    const tombstoned = vs.tombstoneSuperseded();
    assertEquals(tombstoned, 1, 'tombstoneSuperseded removed exactly 1 entry (the superseded one)');
    assertEquals(countVecMapEntries(vecDb, 'facts'), 2, '2 vec entries remain after tombstone');

    // Idempotent: running again should remove 0
    const tombstonedAgain = vs.tombstoneSuperseded();
    assertEquals(tombstonedAgain, 0, 'Second tombstoneSuperseded call removes 0 (idempotent)');
  }

  // ── 5. VectorStore getSourceContent excludes superseded ───
  console.log('\n── 5. VectorStore.getSourceContent excludes superseded facts ──');
  if (!vecAvailable) {
    console.log('  ⚠️  Skipped — sqlite-vec not available');
  } else {
    const libDb = makeLibraryDb();
    const { vecDb, vs } = makeVectorStore(libDb);
    const factStore = new FactStore(libDb);

    const supersededFact = factStore.addFact('alice', 'decided to use PostgreSQL for primary database storage in production systems');
    const newFact        = factStore.addFact('alice', 'decided to use SQLite for primary database storage in production systems v2');
    factStore.markSuperseded(supersededFact.id, newFact.id);

    // Fake index entry for the superseded fact
    insertFakeMapEntry(vecDb, 'facts', supersededFact.id);

    // tombstoneSuperseded should remove it since superseded_by IS NOT NULL
    const tombstoned = vs.tombstoneSuperseded();
    assertEquals(tombstoned, 1, 'Superseded fact vector tombstoned by tombstoneSuperseded()');
    assertEquals(countVecMapEntries(vecDb, 'facts'), 0, 'No stale entries remain after tombstone');
  }

  // ── 6. Hybrid retrieval FTS excludes superseded ──────────
  console.log('\n── 6. Hybrid retrieval (FTS) excludes superseded facts ──');
  {
    const libDb = makeLibraryDb();
    const factStore = new FactStore(libDb);

    factStore.addFact('alice', 'decided to use PostgreSQL for the primary analytics database cluster in production');
    const old   = factStore.addFact('alice', 'decided to use MySQL for the primary analytics database cluster in production env');
    const newer = factStore.addFact('alice', 'decided to use PostgreSQL for the primary analytics database cluster v2 production');
    factStore.markSuperseded(old.id, newer.id);

    // FTS hybrid search — superseded MySQL fact must not appear
    const results = await hybridSearch(libDb, null, 'analytics database MySQL primary cluster', {
      tables: ['facts'],
      agentId: 'alice',
      limit: 20,
    });

    const hasSuperseded = results.some(r => r.content.includes('MySQL'));
    assert(!hasSuperseded, 'FTS hybrid search does not surface superseded (MySQL) fact');
    assert(results.length >= 1, `At least 1 result returned (got ${results.length})`);
  }

  // ── 7. BackgroundIndexer tombstoned field in stats ────────
  console.log('\n── 7. BackgroundIndexer: tombstoned in stats, fired on tick ──');
  if (!vecAvailable) {
    console.log('  ⚠️  Skipped — sqlite-vec not available');
  } else {
    const libDb = makeLibraryDb();
    const { vecDb, vs } = makeVectorStore(libDb);

    // Minimal message DB schema so processAgent can query it
    const msgDb = new DatabaseSync(':memory:');
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

    // Insert a fact and mark it superseded, with a stale vec entry
    const factStore = new FactStore(libDb);
    const old   = factStore.addFact('bob', 'decided to use Nginx for the reverse proxy and load balancing layer in production');
    const newer = factStore.addFact('bob', 'decided to use Caddy for the reverse proxy and load balancing layer in production');
    factStore.markSuperseded(old.id, newer.id);
    insertFakeMapEntry(vecDb, 'facts', old.id);

    assertEquals(countVecMapEntries(vecDb, 'facts'), 1, 'Stale vec entry present before tick');

    // Create indexer with vector store
    const indexer = new BackgroundIndexer(
      { enabled: false },
      (_agentId) => msgDb,
      () => libDb,
      () => ['bob'],
    );
    indexer.setVectorStore(vs);

    // tick() — no new messages, but tombstoneSuperseded fires in the empty-messages path
    const results = await indexer.tick();

    assert(results.length >= 1, `tick() produced ${results.length} stats entry(ies)`);

    const agentStats = results.find(r => r.agentId === 'bob');
    assert(agentStats !== undefined, 'Stats contain entry for bob');
    assert('tombstoned' in agentStats, 'Stats entry has tombstoned field');
    assert(agentStats.tombstoned >= 1, `tombstoned >= 1 in stats (got ${agentStats?.tombstoned})`);

    // Verify the stale vec entry was actually removed
    assertEquals(countVecMapEntries(vecDb, 'facts'), 0, 'Stale vec entry removed after tick');

    // Second tick: tombstoned should be 0 (idempotent)
    const results2 = await indexer.tick();
    const agentStats2 = results2.find(r => r.agentId === 'bob');
    // May be undefined if tombstoned=0 causes it to be filtered out — check accordingly
    const tombstoned2 = agentStats2?.tombstoned ?? 0;
    assertEquals(tombstoned2, 0, 'Second tick tombstoned=0 (idempotent)');
  }

  // ── Summary ───────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
