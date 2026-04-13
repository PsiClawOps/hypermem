/**
 * Compaction Fence + Preservation Gate Integration Tests
 *
 * Tests:
 *   1. Compaction fence schema creation
 *   2. Fence CRUD operations
 *   3. Monotone progress (fence never moves backward)
 *   4. Compaction eligibility queries
 *   5. Preservation gate — sync path (pre-computed vectors)
 *   6. Preservation gate — pass/fail thresholds
 *   7. Edge cases (empty sources, zero vectors)
 */

import { DatabaseSync } from 'node:sqlite';
import {
  ensureCompactionFenceSchema,
  updateCompactionFence,
  getCompactionFence,
  getCompactionEligibility,
  getCompactableMessages,
} from '../dist/compaction-fence.js';
import {
  verifyPreservationFromVectors,
} from '../dist/preservation-gate.js';
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
  }
}

function assertClose(actual, expected, tolerance, msg) {
  const ok = Math.abs(actual - expected) < tolerance;
  if (ok) {
    console.log(`  ✅ ${msg} (${actual.toFixed(4)} ≈ ${expected})`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg} — got ${actual.toFixed(4)}, expected ~${expected} ±${tolerance}`);
    failed++;
  }
}

/** Create an in-memory messages.db with schema */
function createTestDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  ensureCompactionFenceSchema(db);
  return db;
}

/** Seed a conversation with N messages */
function seedConversation(db, agentId, sessionKey, messageCount) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO conversations (session_key, agent_id, channel_type, status, message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, 'webchat', 'active', 0, 0, 0, ?, ?)
  `).run(sessionKey, agentId, now, now);

  const conv = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);

  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    db.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(conv.id, agentId, role, `Message ${i + 1}`, i, now);
  }

  return conv.id;
}

function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Compaction Fence + Preservation Gate Tests');
  console.log('═══════════════════════════════════════════════════\n');

  // ─── Compaction Fence Tests ─────────────────────────────────

  console.log('── Compaction Fence ──\n');

  // Test 1: Schema creation is idempotent
  {
    const db = createTestDb();
    ensureCompactionFenceSchema(db); // second call
    ensureCompactionFenceSchema(db); // third call
    const tables = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='compaction_fences'"
    ).get();
    assert(tables.cnt === 1, 'Schema creation is idempotent');
  }

  // Test 2: No fence = no compaction
  {
    const db = createTestDb();
    const convId = seedConversation(db, 'alice', 'agent:alice:webchat:main', 20);
    const fence = getCompactionFence(db, convId);
    assert(fence === null, 'No fence exists by default');

    const elig = getCompactionEligibility(db, convId);
    assert(elig.eligibleCount === 0, 'No fence = zero eligible messages');
    assert(elig.fence === null, 'Eligibility reports null fence');
  }

  // Test 3: Set fence, check eligibility
  {
    const db = createTestDb();
    const convId = seedConversation(db, 'alice', 'agent:alice:webchat:main', 20);

    // Get message IDs
    const msgs = db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY message_index ASC').all(convId);

    // Set fence at message 11 (the 11th message) — messages 1-10 below, 11-20 at/above
    updateCompactionFence(db, convId, msgs[10].id);

    const fence = getCompactionFence(db, convId);
    assert(fence !== null, 'Fence was created');
    assert(fence.fenceMessageId === msgs[10].id, 'Fence is at correct message ID');

    const elig = getCompactionEligibility(db, convId);
    assert(elig.eligibleCount === 10, `10 messages below fence (got ${elig.eligibleCount})`);
    assert(elig.oldestEligibleId === msgs[0].id, 'Oldest eligible is first message');
    assert(elig.newestEligibleId === msgs[9].id, 'Newest eligible is just below fence');
  }

  // Test 4: Monotone progress — fence never moves backward
  {
    const db = createTestDb();
    const convId = seedConversation(db, 'alice', 'agent:alice:webchat:main', 20);
    const msgs = db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY message_index ASC').all(convId);

    // Set fence at message 15
    updateCompactionFence(db, convId, msgs[14].id);

    let fence = getCompactionFence(db, convId);
    assert(fence.fenceMessageId === msgs[14].id, 'Fence initially at message 15');

    // Try to move backward to message 10 — should be silently ignored
    updateCompactionFence(db, convId, msgs[9].id);

    fence = getCompactionFence(db, convId);
    assert(fence.fenceMessageId === msgs[14].id, 'Fence did NOT move backward (monotone)');

    // Move forward to message 18 — should succeed
    updateCompactionFence(db, convId, msgs[17].id);

    fence = getCompactionFence(db, convId);
    assert(fence.fenceMessageId === msgs[17].id, 'Fence moved forward to message 18');
  }

  // Test 5: Compactable messages excludes already-summarized
  {
    const db = createTestDb();
    const convId = seedConversation(db, 'alice', 'agent:alice:webchat:main', 20);
    const msgs = db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY message_index ASC').all(convId);

    // Set fence at message 11
    updateCompactionFence(db, convId, msgs[10].id);

    // Create a summary covering messages 1-5
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO summaries (conversation_id, agent_id, depth, content, created_at, updated_at)
      VALUES (?, 'alice', 0, 'Summary of messages 1-5', ?, ?)
    `).run(convId, now, now);

    const summaryRow = db.prepare('SELECT id FROM summaries WHERE conversation_id = ?').get(convId);

    for (let i = 0; i < 5; i++) {
      db.prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)').run(summaryRow.id, msgs[i].id);
    }

    // Now check — should be 5 eligible (messages 6-10), not 10
    const elig = getCompactionEligibility(db, convId);
    assert(elig.eligibleCount === 5, `5 eligible after summarizing first 5 (got ${elig.eligibleCount})`);

    // Get compactable messages — should return messages 6-10
    const compactable = getCompactableMessages(db, convId);
    assert(compactable.length === 5, `getCompactableMessages returns 5 (got ${compactable.length})`);
    assert(compactable[0].id === msgs[5].id, 'First compactable is message 6');
    assert(compactable[4].id === msgs[9].id, 'Last compactable is message 10');
  }

  // Test 6: No fence = empty compactable set
  {
    const db = createTestDb();
    const convId = seedConversation(db, 'alice', 'agent:alice:webchat:main', 20);
    const compactable = getCompactableMessages(db, convId);
    assert(compactable.length === 0, 'No fence = empty compactable set');
  }

  // ─── Preservation Gate Tests ────────────────────────────────

  console.log('\n── Preservation Gate ──\n');

  // Test 7: Identical vectors = perfect score
  {
    const vec = new Float32Array([1, 0, 0, 0]);
    const result = verifyPreservationFromVectors(vec, [vec, vec, vec]);
    assertClose(result.alignment, 1.0, 0.001, 'Identical vectors: alignment = 1.0');
    assertClose(result.coverage, 1.0, 0.001, 'Identical vectors: coverage = 1.0');
    assertClose(result.score, 1.0, 0.001, 'Identical vectors: score = 1.0');
    assert(result.passed === true, 'Identical vectors pass the gate');
  }

  // Test 8: Orthogonal summary = zero score
  {
    const summary = new Float32Array([1, 0, 0, 0]);
    const sources = [
      new Float32Array([0, 1, 0, 0]),
      new Float32Array([0, 0, 1, 0]),
      new Float32Array([0, 0, 0, 1]),
    ];
    const result = verifyPreservationFromVectors(summary, sources);
    assertClose(result.alignment, 0, 0.001, 'Orthogonal: alignment ≈ 0');
    assertClose(result.coverage, 0, 0.001, 'Orthogonal: coverage ≈ 0');
    assert(result.passed === false, 'Orthogonal vectors fail the gate');
  }

  // Test 9: Partially aligned summary
  {
    const summary = new Float32Array([0.8, 0.6, 0, 0]); // partially overlaps
    const sources = [
      new Float32Array([1, 0, 0, 0]),
      new Float32Array([0, 1, 0, 0]),
    ];
    const result = verifyPreservationFromVectors(summary, sources);
    assert(result.alignment > 0.5, `Partial alignment > 0.5 (got ${result.alignment.toFixed(4)})`);
    assert(result.coverage > 0.3, `Partial coverage > 0.3 (got ${result.coverage.toFixed(4)})`);
    assert(result.score > 0.4, `Combined score > 0.4 (got ${result.score.toFixed(4)})`);
  }

  // Test 10: Custom threshold
  {
    const vec = new Float32Array([0.7, 0.7, 0, 0]);
    const sources = [new Float32Array([1, 0, 0, 0])];
    
    // With strict threshold
    const strict = verifyPreservationFromVectors(vec, sources, { threshold: 0.9 });
    assert(strict.passed === false, 'Strict threshold (0.9) rejects moderate alignment');
    assert(strict.threshold === 0.9, 'Reports custom threshold');
    
    // With lenient threshold
    const lenient = verifyPreservationFromVectors(vec, sources, { threshold: 0.3 });
    assert(lenient.passed === true, 'Lenient threshold (0.3) accepts moderate alignment');
  }

  // Test 11: Empty sources = fail
  {
    const summary = new Float32Array([1, 0, 0, 0]);
    const result = verifyPreservationFromVectors(summary, []);
    assert(result.passed === false, 'Empty sources always fail');
    assert(result.score === 0, 'Empty sources score = 0');
  }

  // Test 12: Zero vector handling
  {
    const summary = new Float32Array([0, 0, 0, 0]);
    const sources = [new Float32Array([1, 0, 0, 0])];
    const result = verifyPreservationFromVectors(summary, sources);
    assert(result.alignment === 0, 'Zero summary vector: alignment = 0');
    assert(result.passed === false, 'Zero summary vector fails');
  }

  // Test 13: Score clamping
  {
    // Verify score is always in [0, 1] even with adversarial inputs
    const summary = new Float32Array([1, 1, 1, 1]);
    const sources = [
      new Float32Array([1, 1, 1, 1]),
      new Float32Array([1, 1, 1, 1]),
    ];
    const result = verifyPreservationFromVectors(summary, sources);
    assert(result.score >= 0 && result.score <= 1, `Score clamped to [0,1] (got ${result.score})`);
  }

  // Test 14: Single source message
  {
    const summary = new Float32Array([0.9, 0.1, 0, 0]);
    const source = new Float32Array([1, 0, 0, 0]);
    const result = verifyPreservationFromVectors(summary, [source]);
    // With single source, centroid = source, so alignment = coverage
    assertClose(result.alignment, result.coverage, 0.001, 'Single source: alignment ≈ coverage');
    assert(result.passed === true, 'Good single-source summary passes');
  }

  // ─── Summary ────────────────────────────────────────────────

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`═══════════════════════════════════════════════════`);

  process.exit(failed > 0 ? 1 : 0);
}

run();
