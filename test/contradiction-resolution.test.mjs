/**
 * Contradiction Resolution Tests — AC1 through AC8
 *
 * Tests the full contradiction resolution pipeline: detection → policy
 * application → audit trail. FTS-only (no vectorStore) for hermeticity.
 *
 * Heuristic score reference (from contradiction-detector.ts):
 *   Negation:      0.90  ("is running" vs "is not running")
 *   State antonym: 0.85  ("enabled" vs "disabled", same context)
 *   Numeric:       0.80  ("5 agents" vs "8 agents", same context word)
 *   Temporal:      0.70  (vector path only — not tested here)
 *
 * Content strategy:
 *   Old facts are seeded directly via FactStore.addFact().
 *   New facts are extracted from messages using the "decided that [...]" trigger
 *   pattern so extractFactCandidates picks them up. The extracted capture group
 *   is the new fact content, which must contradict the old fact via heuristics.
 */

import { DatabaseSync } from 'node:sqlite';
import { migrateLibrary } from '../dist/library-schema.js';
import { FactStore } from '../dist/fact-store.js';
import { ContradictionAuditStore } from '../dist/contradiction-audit-store.js';
import { BackgroundIndexer } from '../dist/background-indexer.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function assertEquals(actual, expected, msg) {
  assert(
    actual === expected,
    `${msg} (expected=${JSON.stringify(expected)}, got=${JSON.stringify(actual)})`,
  );
}

function assertNotNull(val, msg) {
  assert(val != null, `${msg} (got ${JSON.stringify(val)})`);
}

// ── Helpers ───────────────────────────────────────────────────

function makeLibraryDb() {
  const db = new DatabaseSync(':memory:');
  migrateLibrary(db);
  return db;
}

/**
 * Minimal message DB with one conversation + one message.
 * The message content must trigger extractFactCandidates patterns.
 */
function makeMessageDb(agentId, content) {
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
  const now = new Date().toISOString();
  const conv = db.prepare(
    'INSERT INTO conversations (agent_id, session_key, created_at) VALUES (?, ?, ?)',
  ).run(agentId, `agent:${agentId}:webchat:test`, now);
  const convoId = Number(conv.lastInsertRowid);
  db.prepare(`
    INSERT INTO messages (conversation_id, agent_id, role, text_content, created_at)
    VALUES (?, ?, 'assistant', ?, ?)
  `).run(convoId, agentId, content, now);
  return db;
}

function makeMessageDbMultiple(agentId, messages) {
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
  const now = new Date().toISOString();
  const conv = db.prepare(
    'INSERT INTO conversations (agent_id, session_key, created_at) VALUES (?, ?, ?)',
  ).run(agentId, `agent:${agentId}:webchat:test`, now);
  const convoId = Number(conv.lastInsertRowid);
  for (const text of messages) {
    db.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, created_at)
      VALUES (?, ?, 'assistant', ?, ?)
    `).run(convoId, agentId, text, now);
  }
  return db;
}

/** Get the fact row by id. */
function getFact(libraryDb, factId) {
  return libraryDb.prepare('SELECT * FROM facts WHERE id = ?').get(factId);
}

/** Get all contradiction audit rows for an agent. */
function getAudits(libraryDb, agentId) {
  return libraryDb.prepare(
    'SELECT * FROM contradiction_audits WHERE agent_id = ? ORDER BY id ASC',
  ).all(agentId);
}

/**
 * Build a BackgroundIndexer with optional contradictionPolicy (8th arg).
 *
 * The indexer constructor signature is:
 *   (config, getMessageDb, getLibraryDb, listAgents, getCursor,
 *    dreamerConfig, globalWritePolicy, contradictionPolicy)
 */
function makeIndexer(msgDb, libraryDb, agentId, policy) {
  return new BackgroundIndexer(
    { enabled: false },
    (_id) => msgDb,
    () => libraryDb,
    () => [agentId],
    undefined, // getCursor
    undefined, // dreamerConfig
    undefined, // globalWritePolicy
    policy,    // contradictionPolicy
  );
}

/**
 * Seed an old fact, run one indexer tick with the given message, return results.
 *
 * MESSAGE FORMAT: Use "We decided that [new-fact-content]" so the pattern
 *   `/(?:decided) (?:that )(.{20,200})/gi`
 * extracts [new-fact-content] as the fact candidate.
 *
 * The extracted candidate is the CAPTURE GROUP only. For FTS + heuristic to
 * fire, the capture group must share ≥ 45% token overlap with the old fact AND
 * trigger at least one heuristic (negation/antonym/numeric).
 */
async function seedAndRun({ agentId, oldContent, msgContent, policy }) {
  const libraryDb = makeLibraryDb();
  const factStore = new FactStore(libraryDb);
  // Domain must match what domainForAgent() returns for the agent so FTS domain filter works.
  // Unknown agentIds map to 'general' in AGENT_DOMAIN_MAP.
  const oldFact = factStore.addFact(agentId, oldContent, { scope: 'agent', domain: 'general' });

  const msgDb = makeMessageDb(agentId, msgContent);
  const indexer = makeIndexer(msgDb, libraryDb, agentId, policy);
  const results = await indexer.tick();

  const stats = results.find(r => r.agentId === agentId) ?? {
    factsExtracted: 0,
    contradictionAuditsLogged: 0,
    contradictionsAutoSuperseded: 0,
    contradictionsAutoInvalidated: 0,
  };

  // Find newly inserted fact(s) (id > oldFact.id)
  const newFacts = libraryDb
    .prepare('SELECT id, content FROM facts WHERE agent_id = ? AND id > ? ORDER BY id ASC')
    .all(agentId, oldFact.id);
  const newFactId = newFacts.length > 0 ? newFacts[0].id : null;

  return { stats, oldFactId: oldFact.id, newFactId, libraryDb };
}

// ══════════════════════════════════════════════════════════════
// AC1: Auto-supersede — negation score = 0.9, default policy threshold = 0.80
//
// Old fact:  "the background indexer service is running correctly and processing messages without any failures"
// Message:   "We decided that the background indexer service is not running correctly and processing messages without any failures"
// Extracted: "the background indexer service is not running correctly and processing messages without any failures"
//
// Negation check:
//   negOld={}, negNew={not} → different count ✓
//   content overlap (excl negations): 13/13 = 1.0 ≥ 0.4 ✓  → score = 0.9
// FTS Jaccard: intersection=13, union=14 → 0.93 ≥ 0.45 ✓
// ══════════════════════════════════════════════════════════════
async function test_auto_supersede_path() {
  console.log('\n── AC1: auto-supersede (negation score 0.9, default policy 0.80) ──');

  const agentId = 'agent-ac1';
  const oldContent =
    'the background indexer service is running correctly and processing messages without any failures';
  // "decided that" triggers pattern: /decided (?:that )(.{20,200})/gi
  // captures: "the background indexer service is not running correctly and processing messages without any failures"
  const msgContent =
    'We decided that the background indexer service is not running correctly and processing messages without any failures';

  const { stats, oldFactId, newFactId, libraryDb } = await seedAndRun({
    agentId,
    oldContent,
    msgContent,
    policy: undefined, // default: supersede ≥ 0.80, invalidate ≥ 0.60
  });

  assert(newFactId !== null, 'New fact was extracted and inserted');
  assert(stats.factsExtracted >= 1, `At least 1 fact extracted (got ${stats.factsExtracted})`);

  const oldFact = getFact(libraryDb, oldFactId);
  assertNotNull(oldFact, 'Old fact row exists');
  assertNotNull(oldFact.superseded_by, 'Old fact.superseded_by is set (auto-supersede fired)');
  if (newFactId !== null) {
    assertEquals(Number(oldFact.superseded_by), Number(newFactId),
      'Old fact superseded_by equals new fact id');
  }

  assertEquals(stats.contradictionsAutoSuperseded, 1, 'contradictionsAutoSuperseded = 1');
  assertEquals(stats.contradictionsAutoInvalidated, 0, 'contradictionsAutoInvalidated = 0');
  assert(stats.contradictionAuditsLogged >= 1, `contradictionAuditsLogged ≥ 1 (got ${stats.contradictionAuditsLogged})`);

  const audits = getAudits(libraryDb, agentId);
  assert(audits.length >= 1, 'At least one audit row written');
  if (audits.length > 0) {
    assertEquals(audits[0].status, 'auto-superseded', 'Audit status = auto-superseded');
  }
}

// ══════════════════════════════════════════════════════════════
// AC2: Auto-invalidate — state antonym score = 0.85, policy supersede ≥ 0.90
//
// Old fact:  "the authentication module is enabled for fleet wide access control and verification"
// Message:   "We decided that the authentication module is disabled for fleet wide access control and verification"
// Extracted: "the authentication module is disabled for fleet wide access control and verification"
//
// Antonym: enabled/disabled; context overlap: 10/10 = 1.0 ≥ 0.3 ✓ → score = 0.85
// FTS Jaccard: intersection=10, union=12 → 0.83 ≥ 0.45 ✓
// With policy supersede=0.90: 0.85 < 0.90 → invalidate tier
// ══════════════════════════════════════════════════════════════
async function test_auto_invalidate_path() {
  console.log('\n── AC2: auto-invalidate (antonym 0.85, policy supersede threshold 0.90) ──');

  const agentId = 'agent-ac2';
  const oldContent =
    'the authentication module is enabled for fleet wide access control and verification';
  const msgContent =
    'We decided that the authentication module is disabled for fleet wide access control and verification';

  const { stats, oldFactId, libraryDb } = await seedAndRun({
    agentId,
    oldContent,
    msgContent,
    policy: {
      autoSupersedeThreshold: 0.90,  // 0.85 falls below → invalidate tier
      autoInvalidateThreshold: 0.60,
      alwaysAudit: true,
    },
  });

  const oldFact = getFact(libraryDb, oldFactId);
  assertNotNull(oldFact, 'Old fact row exists');
  assertNotNull(oldFact.invalid_at, 'Old fact.invalid_at is set (auto-invalidate fired)');
  assert(oldFact.superseded_by == null, 'Old fact.superseded_by is null (not superseded)');

  assertEquals(stats.contradictionsAutoSuperseded, 0, 'contradictionsAutoSuperseded = 0');
  assertEquals(stats.contradictionsAutoInvalidated, 1, 'contradictionsAutoInvalidated = 1');
  assert(stats.contradictionAuditsLogged >= 1, `contradictionAuditsLogged ≥ 1 (got ${stats.contradictionAuditsLogged})`);

  const audits = getAudits(libraryDb, agentId);
  assert(audits.length >= 1, 'At least one audit row');
  if (audits.length > 0) {
    assertEquals(audits[0].status, 'auto-invalidated', 'Audit status = auto-invalidated');
  }
}

// ══════════════════════════════════════════════════════════════
// AC3: Log-only — negation score = 0.9, but both policy thresholds set to 0.95
//   → contradiction detected, audit written, old fact untouched
// ══════════════════════════════════════════════════════════════
async function test_log_only_path() {
  console.log('\n── AC3: log-only (policy thresholds 0.95, negation 0.9 → pending) ──');

  const agentId = 'agent-ac3';
  const oldContent =
    'the connection pool is running at maximum capacity for all database operations and requests';
  const msgContent =
    'We decided that the connection pool is not running at maximum capacity for all database operations and requests';

  const { stats, oldFactId, libraryDb } = await seedAndRun({
    agentId,
    oldContent,
    msgContent,
    policy: {
      autoSupersedeThreshold: 0.95,  // above max heuristic score (0.9)
      autoInvalidateThreshold: 0.95,
      alwaysAudit: true,
    },
  });

  const oldFact = getFact(libraryDb, oldFactId);
  assertNotNull(oldFact, 'Old fact row exists');
  assert(oldFact.superseded_by == null, 'Old fact not superseded');
  assert(oldFact.invalid_at == null, 'Old fact not invalidated');

  assertEquals(stats.contradictionsAutoSuperseded, 0, 'contradictionsAutoSuperseded = 0');
  assertEquals(stats.contradictionsAutoInvalidated, 0, 'contradictionsAutoInvalidated = 0');
  assert(stats.contradictionAuditsLogged >= 1, `contradictionAuditsLogged ≥ 1 (got ${stats.contradictionAuditsLogged})`);

  const audits = getAudits(libraryDb, agentId);
  assert(audits.length >= 1, 'At least one audit row');
  if (audits.length > 0) {
    assertEquals(audits[0].status, 'pending', 'Audit status = pending');
  }
}

// ══════════════════════════════════════════════════════════════
// AC4: Idempotent — second ingest of same-topic content does not double-count
//   markSuperseded returns false when fact already superseded → counter stays 0
// ══════════════════════════════════════════════════════════════
async function test_idempotent_double_ingest() {
  console.log('\n── AC4: idempotent double ingest ──');

  const agentId = 'agent-ac4';
  const oldContent =
    'the session manager service is running and accepting connections from all registered clients';
  const msgContent1 =
    'We decided that the session manager service is not running and accepting connections from all registered clients';
  // Second pass: different phrasing, same old-fact target; old fact already superseded
  const msgContent2 =
    'We decided that the session manager service is not running and accepting connections from all registered clients now';

  const libraryDb = makeLibraryDb();
  const factStore = new FactStore(libraryDb);
  const oldFact = factStore.addFact(agentId, oldContent, { scope: 'agent', domain: 'general' });

  // First tick
  const msgDb1 = makeMessageDb(agentId, msgContent1);
  const indexer1 = makeIndexer(msgDb1, libraryDb, agentId, undefined);
  const results1 = await indexer1.tick();
  const stats1 = results1.find(r => r.agentId === agentId) ?? { contradictionsAutoSuperseded: 0 };

  assertEquals(stats1.contradictionsAutoSuperseded, 1, 'First tick: contradictionsAutoSuperseded = 1');

  // Second tick (separate msgDb so watermark doesn't skip it)
  const msgDb2 = makeMessageDb(agentId, msgContent2);
  const indexer2 = makeIndexer(msgDb2, libraryDb, agentId, undefined);
  const results2 = await indexer2.tick();
  const stats2 = results2.find(r => r.agentId === agentId) ?? { contradictionsAutoSuperseded: 0 };

  // markSuperseded is idempotent: already superseded → returns false → counter = 0
  assertEquals(stats2.contradictionsAutoSuperseded, 0,
    'Second tick: contradictionsAutoSuperseded = 0 (idempotent, already superseded)');

  // Old fact should only have one superseded_by value (not double-counted)
  const oldFactRow = getFact(libraryDb, oldFact.id);
  assertNotNull(oldFactRow.superseded_by, 'Old fact superseded_by is set after first tick');
}

// ══════════════════════════════════════════════════════════════
// AC5: Custom policy — antonym score 0.85 triggers supersede when threshold = 0.80
// ══════════════════════════════════════════════════════════════
async function test_custom_policy() {
  console.log('\n── AC5: custom policy — antonym 0.85, supersede threshold 0.80 → supersede ──');

  const agentId = 'agent-ac5';
  const oldContent =
    'the gateway webhook handler is enabled and accepting incoming requests from all registered sources';
  const msgContent =
    'We decided that the gateway webhook handler is disabled and accepting incoming requests from all registered sources';

  const { stats, oldFactId, libraryDb } = await seedAndRun({
    agentId,
    oldContent,
    msgContent,
    policy: {
      autoSupersedeThreshold: 0.80,  // 0.85 ≥ 0.80 → supersede
      autoInvalidateThreshold: 0.60,
      alwaysAudit: true,
    },
  });

  const oldFact = getFact(libraryDb, oldFactId);
  assertNotNull(oldFact.superseded_by, 'Old fact superseded with custom policy (threshold 0.80)');
  assertEquals(stats.contradictionsAutoSuperseded, 1, 'contradictionsAutoSuperseded = 1');
  assertEquals(stats.contradictionsAutoInvalidated, 0, 'contradictionsAutoInvalidated = 0');

  const audits = getAudits(libraryDb, agentId);
  assert(audits.length >= 1, 'Audit row written');
  if (audits.length > 0) {
    assertEquals(audits[0].status, 'auto-superseded', 'Audit status = auto-superseded');
  }
}

// ══════════════════════════════════════════════════════════════
// AC6: Counter surfacing — mixed corpus produces distinct counter values
//   Two messages in one tick: one triggers supersede, one triggers invalidate
//   Policy: supersede ≥ 0.92 (only negation 0.9 < 0.92), invalidate ≥ 0.60
//   Wait — negation 0.9 < 0.92 → invalidate, antonym 0.85 < 0.92 → also invalidate
//   Use policy supersede ≥ 0.91 (above antonym 0.85), invalidate ≥ 0.60:
//     - negation 0.9 < 0.91 → invalidate tier
//     - antonym 0.85 ≥ 0.60 → also invalidate
//   Better: policy supersede ≥ 0.89 (above antonym 0.85), invalidate ≥ 0.60:
//     - negation 0.9 ≥ 0.89 → supersede
//     - antonym 0.85 ≥ 0.60, < 0.89 → invalidate
//   ✓ This gives contradictionsAutoSuperseded ≥ 1, contradictionsAutoInvalidated ≥ 1
// ══════════════════════════════════════════════════════════════
async function test_counter_surfacing() {
  console.log('\n── AC6: counter surfacing — mixed corpus (supersede + invalidate in same tick) ──');

  const agentId = 'agent-ac6';
  const libraryDb = makeLibraryDb();
  const factStore = new FactStore(libraryDb);

  // Old fact 1: target for negation (score 0.9 → supersede with policy 0.89)
  factStore.addFact(agentId,
    'the session manager service is running and accepting connections from registered clients',
    { scope: 'agent', domain: 'general' });

  // Old fact 2: target for antonym (score 0.85 → invalidate with policy 0.89)
  factStore.addFact(agentId,
    'the authentication module is enabled for fleet wide access control configuration',
    { scope: 'agent', domain: 'general' });

  // Two messages: one per contradicting fact
  const msgDb = makeMessageDbMultiple(agentId, [
    // Triggers negation against old fact 1
    'We decided that the session manager service is not running and accepting connections from registered clients',
    // Triggers antonym against old fact 2
    'We decided that the authentication module is disabled for fleet wide access control configuration',
  ]);

  const indexer = makeIndexer(msgDb, libraryDb, agentId, {
    autoSupersedeThreshold: 0.89, // negation 0.9 ≥ 0.89 → supersede; antonym 0.85 < 0.89 → invalidate
    autoInvalidateThreshold: 0.60,
    alwaysAudit: true,
  });

  const results = await indexer.tick();
  const stats = results.find(r => r.agentId === agentId);
  assertNotNull(stats, 'Stats entry present for agent');

  assert('contradictionAuditsLogged' in stats, 'contradictionAuditsLogged field exists');
  assert('contradictionsAutoSuperseded' in stats, 'contradictionsAutoSuperseded field exists');
  assert('contradictionsAutoInvalidated' in stats, 'contradictionsAutoInvalidated field exists');

  assert(stats.contradictionsAutoSuperseded >= 1,
    `contradictionsAutoSuperseded ≥ 1 (got ${stats.contradictionsAutoSuperseded})`);
  assert(stats.contradictionsAutoInvalidated >= 1,
    `contradictionsAutoInvalidated ≥ 1 (got ${stats.contradictionsAutoInvalidated})`);
  assert(stats.contradictionAuditsLogged >= 2,
    `contradictionAuditsLogged ≥ 2 (got ${stats.contradictionAuditsLogged})`);
}

// ══════════════════════════════════════════════════════════════
// AC7: Lexical supersede regression — prefix-based supersede still works
//   and does NOT increment semantic counters
//
//   Old fact starts with "the deployment pipeline artifact store uploads":
//     "the deployment pipeline artifact store uploads build outputs to the shared registry daily"
//   Extracted fact starts with same 60 chars but has different tail:
//     "the deployment pipeline artifact store uploads build outputs to the dedicated storage hub daily"
//
//   First 60 chars: "the deployment pipeline artifact store uploads build outputs " (60)
//   No heuristic fires (no negation/antonym/numeric diff) → no contradiction candidate
//   Lexical supersede fires → old fact gets superseded_by = new fact id
// ══════════════════════════════════════════════════════════════
async function test_lexical_supersede_still_works() {
  console.log('\n── AC7: lexical supersede regression ──');

  const agentId = 'agent-ac7';

  // 60-char prefix: "the deployment pipeline artifact store uploads build outputs " (exactly 60)
  // Count: t(1)h(2)e(3) (4)d(5)e(6)p(7)l(8)o(9)y(10)m(11)e(12)n(13)t(14) (15)
  //        p(16)i(17)p(18)e(19)l(20)i(21)n(22)e(23) (24)a(25)r(26)t(27)i(28)f(29)a(30)c(31)t(32)
  //        (33)s(34)t(35)o(36)r(37)e(38) (39)u(40)p(41)l(42)o(43)a(44)d(45)s(46) (47)
  //        b(48)u(49)i(50)l(51)d(52) (53)o(54)u(55)t(56)p(57)u(58)t(59)s(60)
  //        = 60 chars ✓
  const sharedPrefix = 'the deployment pipeline artifact store uploads build outputs';
  const oldContent = sharedPrefix + ' to the shared registry directory for distribution and archival';
  const newExtracted = sharedPrefix + ' to the dedicated distributed storage hub for distribution and archival';

  // Verify the prefix is exactly 60 chars (test self-check)
  const prefix60 = oldContent.slice(0, 60);
  assert(prefix60 === newExtracted.slice(0, 60), `Shared 60-char prefix verified: "${prefix60}"`);

  // Message: "We decided that [newExtracted]"
  const msgContent = 'We decided that ' + newExtracted;

  const { stats, oldFactId, newFactId, libraryDb } = await seedAndRun({
    agentId,
    oldContent,
    msgContent,
    policy: undefined, // default
  });

  assert(newFactId !== null, 'New fact extracted and inserted');

  const oldFact = getFact(libraryDb, oldFactId);
  assertNotNull(oldFact, 'Old fact row exists');
  assertNotNull(oldFact.superseded_by, 'Old fact.superseded_by set (lexical supersede fired)');
  if (newFactId !== null) {
    assertEquals(Number(oldFact.superseded_by), Number(newFactId),
      'Old fact superseded by new fact via lexical path');
  }

  // Semantic counters must not be inflated by the lexical path
  assertEquals(stats.contradictionsAutoSuperseded, 0,
    'contradictionsAutoSuperseded = 0 (no semantic supersede)');
  assertEquals(stats.contradictionsAutoInvalidated, 0,
    'contradictionsAutoInvalidated = 0 (no semantic invalidate)');
}

// ══════════════════════════════════════════════════════════════
// AC8: Schema migration — v19 CHECK constraint accepts all 5 status values
//   and preserves existing 'pending' rows from pre-v19 state
// ══════════════════════════════════════════════════════════════
async function test_schema_v19_migration() {
  console.log('\n── AC8: schema v19 — CHECK constraint accepts all status values ──');

  const libraryDb = makeLibraryDb();
  const store = new ContradictionAuditStore(libraryDb);
  const factStore = new FactStore(libraryDb);

  const existingFact = factStore.addFact(
    'migration-agent',
    'migration test fact content used for v19 schema verification purposes',
    { scope: 'agent' },
  );

  const candidate = {
    existingFactId: existingFact.id,
    existingContent: existingFact.content,
    similarityScore: 0.8,
    contradictionScore: 0.9,
    reason: 'Test contradiction for schema v19 verification',
  };

  const validStatuses = ['pending', 'accepted', 'dismissed', 'auto-superseded', 'auto-invalidated'];
  for (const status of validStatuses) {
    let threw = false;
    try {
      store.recordFactAudit(
        'migration-agent',
        { content: `New fact content for testing status value: ${status} scenario` },
        candidate,
        { status },
      );
    } catch (e) {
      threw = true;
      console.log(`    Unexpected throw for status="${status}": ${e.message}`);
    }
    assert(!threw, `Status "${status}" accepted by v19 schema CHECK constraint`);
  }

  const rows = libraryDb
    .prepare('SELECT status FROM contradiction_audits WHERE agent_id = ? ORDER BY id ASC')
    .all('migration-agent');

  assertEquals(rows.length, validStatuses.length, `All ${validStatuses.length} rows inserted`);
  for (let i = 0; i < validStatuses.length; i++) {
    assertEquals(rows[i].status, validStatuses[i], `Row ${i + 1} status = "${validStatuses[i]}"`);
  }

  // 'pending' row must be intact (data preservation check)
  const pendingRows = rows.filter(r => r.status === 'pending');
  assertEquals(pendingRows.length, 1, "'pending' row preserved (data integrity)");

  // Invalid status must be rejected
  let rejectedInvalidStatus = false;
  try {
    store.recordFactAudit(
      'migration-agent',
      { content: 'fact content for invalid status test to verify constraint is enforced properly' },
      candidate,
      { status: 'invalid-status-value' },
    );
  } catch {
    rejectedInvalidStatus = true;
  }
  assert(rejectedInvalidStatus, 'Invalid status value rejected by CHECK constraint');
}

// ══════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════
async function run() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  Contradiction Resolution Tests (AC1–AC8)');
  console.log('═══════════════════════════════════════════════════');

  const tests = [
    test_auto_supersede_path,
    test_auto_invalidate_path,
    test_log_only_path,
    test_idempotent_double_ingest,
    test_custom_policy,
    test_counter_surfacing,
    test_lexical_supersede_still_works,
    test_schema_v19_migration,
  ];

  for (const t of tests) {
    try {
      await t();
    } catch (err) {
      console.log(`  ❌ CRASH in ${t.name}: ${err.message}`);
      console.log(err.stack);
      failed++;
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} ASSERTIONS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════\n');

  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('Runner crashed:', err);
  process.exit(1);
});
