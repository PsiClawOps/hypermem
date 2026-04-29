/**
 * Proactive Pass Tests (P2.3)
 *
 * Tests: noise sweep, tool decay, and background indexer integration.
 * Uses a temp HyperMem instance with a seeded conversation of 101 messages.
 */

import { HyperMem } from '../dist/index.js';
import { collectReferencedNoiseDebt, runNoiseSweep, runToolDecay, runTreeSafeNoiseCompaction } from '../dist/proactive-pass.js';
import { BackgroundIndexer } from '../dist/background-indexer.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-proactive-'));

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

// ─── Setup ───────────────────────────────────────────────────────

let hm;

async function setup() {
  hm = await HyperMem.create({
    dataDir: tmpDir,
  });
}

/**
 * Seed a conversation with a controlled mix of message types.
 * Returns { db, convId } so tests can query directly.
 *
 * Message layout (201 messages, indices 0–200):
 *   - Indices 0–159: OUTSIDE tool decay window (cutoff = 200 - 40 = 160)
 *     - 0: heartbeat (is_heartbeat=1) → noise sweep target
 *     - 1: "ok" (ack) → noise sweep target
 *     - 2: "👍" (ack) → noise sweep target
 *     - 3: "NO_REPLY" (noise) → noise sweep target
 *     - 4: "" empty string → noise sweep target
 *     - 5: "hi" (≤3 chars) → noise sweep target
 *     - 6–9: normal messages → NOT deleted
 *     - 10–19: messages with large tool_results (>2000 chars) → tool decay target
 *     - 20–24: messages with small tool_results (<2000 chars) → NOT decayed
 *     - 25–159: normal messages → NOT touched
 *   - Indices 160–179: INSIDE tool decay window, OUTSIDE noise sweep window
 *     - 160–164: normal messages → NOT touched
 *     - 165–174: messages with large tool_results → NOT decayed (in decay window)
 *     - 175–179: normal messages → NOT touched
 *   - Indices 180–200: INSIDE recent window for both passes (cutoff = 200 - 20 = 180)
 *     - 180: heartbeat (is_heartbeat=1) → NOT deleted (in window)
 *     - 181: "ok" (ack) → NOT deleted (in window)
 *     - 182: normal message → NOT deleted
 *     - 183–189: messages with large tool_results → NOT decayed (in window)
 *     - 190–200: normal messages → NOT touched
 *
 * With maxIndex=200:
 *   - Noise sweep cutoff = 200 - 20 = 180, so indices < 180 are eligible
 *   - Tool decay cutoff = 200 - 40 = 160, so indices < 160 are eligible
 */
function seedConversation(db, convId, agentId) {
  const LARGE_CONTENT = 'x'.repeat(600);  // >500 chars → triggers per-result truncation
  const SMALL_CONTENT = 'y'.repeat(100);  // <500 chars → not truncated

  function largeToolResults() {
    // Array of 4 results, each with >500-char content → total >2000 chars
    return JSON.stringify([
      { role: 'tool', callId: 'call_1', content: LARGE_CONTENT },
      { role: 'tool', callId: 'call_2', content: LARGE_CONTENT },
      { role: 'tool', callId: 'call_3', content: LARGE_CONTENT },
      { role: 'tool', callId: 'call_4', content: LARGE_CONTENT },
    ]);
  }

  function smallToolResults() {
    // Array of 2 results, small content → total <2000 chars
    return JSON.stringify([
      { role: 'tool', callId: 'call_s1', content: SMALL_CONTENT },
      { role: 'tool', callId: 'call_s2', content: SMALL_CONTENT },
    ]);
  }

  const insertMsg = db.prepare(`
    INSERT INTO messages
      (conversation_id, agent_id, role, text_content, tool_results, message_index, is_heartbeat, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date().toISOString();

  // 201 messages (indices 0–200). maxIndex=200.
  // Noise sweep cutoff = 200 - 20 = 180 (indices < 180 eligible)
  // Tool decay cutoff  = 200 - 40 = 160 (indices < 160 eligible)
  for (let i = 0; i <= 200; i++) {
    let textContent = `Normal message number ${i} with enough content to be significant.`;
    let toolResults = null;
    let isHeartbeat = 0;
    let role = i % 2 === 0 ? 'user' : 'assistant';

    if (i === 0) {
      textContent = 'HEARTBEAT_OK';
      isHeartbeat = 1;
    } else if (i === 1) {
      textContent = 'ok';
    } else if (i === 2) {
      textContent = '👍';
    } else if (i === 3) {
      textContent = 'NO_REPLY';
    } else if (i === 4) {
      textContent = '';
    } else if (i === 5) {
      textContent = 'hi';
    } else if (i >= 10 && i <= 19) {
      // Outside tool decay window (< 160) — large tool_results → decay targets
      textContent = null;
      toolResults = largeToolResults();
      role = 'tool';
    } else if (i >= 20 && i <= 24) {
      // Outside tool decay window — small tool_results → NOT decayed (<2000 chars)
      textContent = null;
      toolResults = smallToolResults();
      role = 'tool';
    } else if (i >= 165 && i <= 174) {
      // Inside tool decay window (>= 160) — large tool_results → NOT decayed
      textContent = null;
      toolResults = largeToolResults();
      role = 'tool';
    } else if (i === 180) {
      textContent = 'HEARTBEAT_OK';
      isHeartbeat = 1;
    } else if (i === 181) {
      textContent = 'ok';
    } else if (i >= 183 && i <= 189) {
      // Inside noise sweep window (>= 180) — large tool_results → NOT decayed
      textContent = null;
      toolResults = largeToolResults();
      role = 'tool';
    }

    insertMsg.run(convId, agentId, role, textContent, toolResults, i, isHeartbeat, now);
  }
}

// ─── Test helpers ────────────────────────────────────────────────

function countMessages(db, convId) {
  return db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(convId).n;
}

function getMessageByIndex(db, convId, idx) {
  return db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND message_index = ?').get(convId, idx);
}

function getToolResultsAtIndex(db, convId, idx) {
  const row = db.prepare('SELECT tool_results FROM messages WHERE conversation_id = ? AND message_index = ?').get(convId, idx);
  return row ? row.tool_results : null;
}

// ─── Noise Sweep Tests ───────────────────────────────────────────

async function testNoiseSweep() {
  console.log('\n── Noise Sweep ──\n');

  const agentId = 'proactive-noise-test';
  const db = hm.dbManager.getMessageDb(agentId);
  const sessionKey = 'agent:proactive-noise-test:webchat:main';

  db.prepare(`
    INSERT INTO conversations
      (session_key, agent_id, channel_type, status, message_count,
       token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const convRow = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  const convId = convRow.id;

  seedConversation(db, convId, agentId);
  assert(countMessages(db, convId) === 201, 'Setup: 201 messages seeded');

  const result = runNoiseSweep(db, convId);
  assert(result.passType === 'noise_sweep', 'passType is noise_sweep');

  assert(getMessageByIndex(db, convId, 0) === undefined, 'Heartbeat (idx 0) outside window deleted');
  assert(getMessageByIndex(db, convId, 1) === undefined, '"ok" (idx 1) outside window deleted');
  assert(getMessageByIndex(db, convId, 2) === undefined, '"👍" (idx 2) outside window deleted');
  assert(getMessageByIndex(db, convId, 3) === undefined, '"NO_REPLY" (idx 3) outside window deleted');
  assert(getMessageByIndex(db, convId, 4) === undefined, 'Empty (idx 4) outside window deleted');
  assert(getMessageByIndex(db, convId, 5) === undefined, '"hi" (idx 5) outside window deleted');

  assert(getMessageByIndex(db, convId, 6) !== undefined, 'Normal msg (idx 6) outside window preserved');
  assert(getMessageByIndex(db, convId, 9) !== undefined, 'Normal msg (idx 9) outside window preserved');

  assert(getMessageByIndex(db, convId, 180) !== undefined, 'Heartbeat (idx 180) inside window preserved');
  assert(getMessageByIndex(db, convId, 181) !== undefined, '"ok" (idx 181) inside window preserved');

  assert(result.messagesDeleted === 6, `messagesDeleted = 6 (got ${result.messagesDeleted})`);
  assert(countMessages(db, convId) === 195, `195 messages remain after sweep (got ${countMessages(db, convId)})`);  
}


async function testNoiseSweepSkipsAllMessageFkReferences() {
  console.log('\n── Noise Sweep FK Safety ──\n');

  const agentId = 'proactive-fk-test';
  const db = hm.dbManager.getMessageDb(agentId);
  const sessionKey = 'agent:proactive-fk-test:webchat:main';

  db.prepare(`
    INSERT INTO conversations
      (session_key, agent_id, channel_type, status, message_count,
       token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const convId = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey).id;
  seedConversation(db, convId, agentId);

  const byIndex = (idx) => db
    .prepare('SELECT id FROM messages WHERE conversation_id = ? AND message_index = ?')
    .get(convId, idx).id;

  const ids = {
    summary: byIndex(0),
    parent: byIndex(1),
    artifact: byIndex(2),
    context: byIndex(3),
    snapshot: byIndex(4),
    unreferenced: byIndex(5),
  };

  db.prepare(`
    INSERT INTO summaries (conversation_id, agent_id, depth, content, created_at, updated_at)
    VALUES (?, ?, 0, 'summary', datetime('now'), datetime('now'))
  `).run(convId, agentId);
  const summaryId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare('INSERT INTO summary_messages (summary_id, message_id) VALUES (?, ?)')
    .run(summaryId, ids.summary);

  db.prepare(`
    INSERT INTO messages
      (conversation_id, agent_id, role, text_content, message_index, parent_id, is_heartbeat, created_at)
    VALUES (?, ?, 'assistant', 'child referencing ack parent', 201, ?, 0, datetime('now'))
  `).run(convId, agentId, ids.parent);

  db.prepare(`
    INSERT INTO tool_artifacts
      (id, content_hash, agent_id, session_key, conversation_id, message_id, tool_name,
       content_type, size_bytes, token_estimate, payload, created_at, last_used_at)
    VALUES ('artifact-fk-test', 'hash', ?, ?, ?, ?, 'exec', 'text/plain', 4, 1, 'test', datetime('now'), datetime('now'))
  `).run(agentId, sessionKey, convId, ids.artifact);

  db.prepare(`
    INSERT INTO contexts
      (agent_id, session_key, conversation_id, head_message_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(agentId, sessionKey, convId, ids.context);
  const contextId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  db.prepare(`
    INSERT INTO composition_snapshots
      (context_id, head_message_id, captured_at, model, context_window, total_tokens,
       fill_pct, snapshot_kind, repair_depth, slots_json, slots_integrity_hash, created_at)
    VALUES (?, ?, datetime('now'), 'test/model', 1000, 10, 0.01, 'full', 0, '{}', 'hash', datetime('now'))
  `).run(contextId, ids.snapshot);

  const result = runNoiseSweep(db, convId, 20, 6);

  assert(result.messagesDeleted === 1, `Only unreferenced FK candidate deleted (got ${result.messagesDeleted})`);
  assert(getMessageByIndex(db, convId, 0) !== undefined, 'summary_messages FK target preserved');
  assert(getMessageByIndex(db, convId, 1) !== undefined, 'messages.parent_id FK target preserved');
  assert(getMessageByIndex(db, convId, 2) !== undefined, 'tool_artifacts.message_id FK target preserved');
  assert(getMessageByIndex(db, convId, 3) !== undefined, 'contexts.head_message_id FK target preserved');
  assert(getMessageByIndex(db, convId, 4) !== undefined, 'composition_snapshots.head_message_id FK target preserved');
  assert(getMessageByIndex(db, convId, 5) === undefined, 'unreferenced noise candidate deleted');

  const fkRows = db.prepare('PRAGMA foreign_key_check').all();
  assert(fkRows.length === 0, `No FK violations after noise sweep (got ${fkRows.length})`);
}


async function testReferencedNoiseDebtAndCompaction() {
  console.log('\n── Referenced Noise Debt + Tree-Safe Compaction ──\n');

  const agentId = 'proactive-tree-compact-test';
  const db = hm.dbManager.getMessageDb(agentId);
  const sessionKey = 'agent:proactive-tree-compact-test:webchat:main';

  db.prepare(`
    INSERT INTO conversations
      (session_key, agent_id, channel_type, status, message_count,
       token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const convId = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey).id;
  const insertMsg = db.prepare(`
    INSERT INTO messages
      (conversation_id, agent_id, role, text_content, message_index, parent_id, depth, is_heartbeat, created_at)
    VALUES (?, ?, 'assistant', ?, ?, ?, ?, 0, datetime('now'))
  `);

  insertMsg.run(convId, agentId, 'normal root message', 0, null, 0);
  const rootId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  insertMsg.run(convId, agentId, 'ok', 1, rootId, 1);
  const noiseId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  insertMsg.run(convId, agentId, 'normal child message', 2, noiseId, 2);
  const childId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  for (let i = 3; i <= 12; i++) insertMsg.run(convId, agentId, `normal filler ${i}`, i, childId, 3);

  const beforeDebt = collectReferencedNoiseDebt(db, convId, 2);
  assert(beforeDebt.referencedNoise === 1, `Referenced noise detected before compaction (got ${beforeDebt.referencedNoise})`);
  assert(beforeDebt.parentReferencedNoise === 1, `Parent-referenced noise detected before compaction (got ${beforeDebt.parentReferencedNoise})`);

  const compact = runTreeSafeNoiseCompaction(db, convId, 2, 10);
  assert(compact.deleted === 1, `Tree-safe compaction deleted one noise node (got ${compact.deleted})`);
  assert(compact.reparented === 1, `Tree-safe compaction reparented one noise node (got ${compact.reparented})`);
  assert(compact.fkCheck === 'none', `Tree-safe compaction FK check clean (${compact.fkCheck})`);

  const child = db.prepare('SELECT parent_id, depth FROM messages WHERE id = ?').get(childId);
  assert(child.parent_id === rootId, 'Child reparented to deleted noise node parent');
  assert(child.depth === 1, `Child depth decremented after compaction (got ${child.depth})`);
  assert(db.prepare('SELECT id FROM messages WHERE id = ?').get(noiseId) === undefined, 'Noise node deleted after reparent');

  const afterDebt = collectReferencedNoiseDebt(db, convId, 2);
  assert(afterDebt.referencedNoise === 0, `Referenced noise cleared after compaction (got ${afterDebt.referencedNoise})`);
  const fkRows = db.prepare('PRAGMA foreign_key_check').all();
  assert(fkRows.length === 0, `No FK violations after tree-safe compaction (got ${fkRows.length})`);
}


async function testReferencedNoiseCompactionRepairsContextAndSnapshotHeads() {
  console.log('\n── Referenced Noise Context/Snapshot Head Repair ──\n');

  const agentId = 'proactive-head-repair-test';
  const db = hm.dbManager.getMessageDb(agentId);
  const sessionKey = 'agent:proactive-head-repair-test:webchat:main';

  db.prepare(`
    INSERT INTO conversations
      (session_key, agent_id, channel_type, status, message_count,
       token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const convId = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey).id;
  const insertMsg = db.prepare(`
    INSERT INTO messages
      (conversation_id, agent_id, role, text_content, message_index, parent_id, depth, is_heartbeat, created_at)
    VALUES (?, ?, 'assistant', ?, ?, ?, ?, 0, datetime('now'))
  `);

  insertMsg.run(convId, agentId, 'normal root message', 0, null, 0);
  const rootId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  insertMsg.run(convId, agentId, 'ok', 1, rootId, 1);
  const noiseId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  insertMsg.run(convId, agentId, 'normal child message', 2, noiseId, 2);
  const childId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  for (let i = 3; i <= 12; i++) insertMsg.run(convId, agentId, `normal filler ${i}`, i, childId, 3);

  db.prepare(`
    INSERT INTO contexts
      (agent_id, session_key, conversation_id, head_message_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
  `).run(agentId, sessionKey, convId, noiseId);
  const contextId = db.prepare('SELECT last_insert_rowid() AS id').get().id;

  db.prepare(`
    INSERT INTO composition_snapshots
      (context_id, head_message_id, captured_at, model, context_window, total_tokens,
       fill_pct, snapshot_kind, repair_depth, slots_json, slots_integrity_hash, created_at)
    VALUES (?, ?, datetime('now'), 'test/model', 1000, 10, 0.01, 'full', 0, '{}', 'hash', datetime('now'))
  `).run(contextId, noiseId);

  const beforeDebt = collectReferencedNoiseDebt(db, convId, 2);
  assert(beforeDebt.referencedNoise === 1, `Referenced noise detected before head repair (got ${beforeDebt.referencedNoise})`);
  assert(beforeDebt.parentReferencedNoise === 1, `Parent ref detected before head repair (got ${beforeDebt.parentReferencedNoise})`);
  assert(beforeDebt.contextReferencedNoise === 1, `Context head ref detected before head repair (got ${beforeDebt.contextReferencedNoise})`);
  assert(beforeDebt.snapshotReferencedNoise === 1, `Snapshot head ref detected before head repair (got ${beforeDebt.snapshotReferencedNoise})`);

  const compact = runTreeSafeNoiseCompaction(db, convId, 2, 10);
  assert(compact.deleted === 1, `Head repair compaction deleted one noise node (got ${compact.deleted})`);
  assert(compact.reparented === 1, `Head repair compaction reparented child node (got ${compact.reparented})`);
  assert(compact.repairedContextHeads === 1, `Context head repaired once (got ${compact.repairedContextHeads})`);
  assert(compact.repairedSnapshotHeads === 1, `Snapshot head repaired once (got ${compact.repairedSnapshotHeads})`);
  assert(compact.fkCheck === 'none', `Head repair compaction FK check clean (${compact.fkCheck})`);

  const ctx = db.prepare('SELECT head_message_id FROM contexts WHERE id = ?').get(contextId);
  assert(ctx.head_message_id === rootId, `Context head moved to parent root (got ${ctx.head_message_id})`);
  const snap = db.prepare('SELECT head_message_id, repair_depth FROM composition_snapshots WHERE context_id = ?').get(contextId);
  assert(snap.head_message_id === rootId, `Snapshot head moved to parent root (got ${snap.head_message_id})`);
  assert(snap.repair_depth === 1, `Snapshot repair_depth incremented (got ${snap.repair_depth})`);

  const child = db.prepare('SELECT parent_id, depth FROM messages WHERE id = ?').get(childId);
  assert(child.parent_id === rootId, 'Child reparented to repaired head parent');
  assert(child.depth === 1, `Child depth decremented after head repair (got ${child.depth})`);
  assert(db.prepare('SELECT id FROM messages WHERE id = ?').get(noiseId) === undefined, 'Noise head deleted after repair');

  const afterDebt = collectReferencedNoiseDebt(db, convId, 2);
  assert(afterDebt.referencedNoise === 0, `Referenced noise cleared after head repair (got ${afterDebt.referencedNoise})`);
  const fkRows = db.prepare('PRAGMA foreign_key_check').all();
  assert(fkRows.length === 0, `No FK violations after head repair compaction (got ${fkRows.length})`);
}

// ─── Tool Decay Tests ────────────────────────────────────────────

async function testToolDecay() {
  console.log('\n── Tool Decay ──\n');

  const agentId = 'proactive-decay-test';
  const db = hm.dbManager.getMessageDb(agentId);
  const sessionKey = 'agent:proactive-decay-test:webchat:main';

  db.prepare(`
    INSERT INTO conversations
      (session_key, agent_id, channel_type, status, message_count,
       token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const convRow = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  const convId = convRow.id;

  seedConversation(db, convId, agentId);

  const originalLarge = getToolResultsAtIndex(db, convId, 10);
  const originalSmall = getToolResultsAtIndex(db, convId, 20);
  const originalInWindow = getToolResultsAtIndex(db, convId, 165);

  assert(originalLarge !== null, 'Setup: large tool_results exist at idx 10');
  assert(originalSmall !== null, 'Setup: small tool_results exist at idx 20');
  assert(originalInWindow !== null, 'Setup: large tool_results exist at idx 165 (in decay window)');
  assert(originalLarge.length > 2000, `Setup: large tool_results > 2000 chars (${originalLarge.length})`);

  const result = runToolDecay(db, convId);
  assert(result.passType === 'tool_decay', 'passType is tool_decay');

  const decayedLarge = getToolResultsAtIndex(db, convId, 10);
  assert(decayedLarge !== null, 'tool_results at idx 10 still exists (not deleted)');
  assert(decayedLarge !== originalLarge, 'Large tool_results at idx 10 was modified');
  assert(decayedLarge.includes('[tool result truncated'), 'Truncated placeholder present in idx 10');
  assert(decayedLarge.length < originalLarge.length, `Decayed tool_results smaller (${decayedLarge.length} < ${originalLarge.length})`);

  let parsed;
  try { parsed = JSON.parse(decayedLarge); } catch { parsed = null; }
  assert(Array.isArray(parsed), 'Decayed tool_results is still valid JSON array');
  assert(parsed !== null && parsed.length === 4, `JSON array still has 4 entries (got ${parsed?.length})`);
  assert(
    parsed !== null && parsed.every(entry => typeof entry.callId === 'string'),
    'All entries preserve callId field'
  );
  assert(
    parsed !== null && parsed.every(entry => entry.content.startsWith('[tool result truncated')),
    'All entries have truncated placeholder content'
  );

  assert(
    parsed !== null && parsed[0].content.includes('bytes'),
    'Placeholder includes original byte count'
  );

  const unchangedSmall = getToolResultsAtIndex(db, convId, 20);
  assert(unchangedSmall === originalSmall, 'Small tool_results at idx 20 unchanged (<2000 chars total)');

  const unchangedInWindow = getToolResultsAtIndex(db, convId, 165);
  assert(unchangedInWindow === originalInWindow, 'Large tool_results at idx 165 (inside decay window) unchanged');

  assert(result.messagesUpdated === 10, `messagesUpdated = 10 (indices 10–19) (got ${result.messagesUpdated})`);
  assert(result.bytesFreed > 0, `bytesFreed > 0 (got ${result.bytesFreed})`);
}

// ─── Edge Cases ───────────────────────────────────────────────────

async function testEdgeCases() {
  console.log('\n── Edge Cases ──\n');

  const agentId = 'proactive-edge-test';
  const db = hm.dbManager.getMessageDb(agentId);
  const sessionKey = 'agent:proactive-edge-test:webchat:main';

  db.prepare(`
    INSERT INTO conversations
      (session_key, agent_id, channel_type, status, message_count,
       token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const convRow = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  const convId = convRow.id;

  const noiseEmpty = runNoiseSweep(db, convId);
  assert(noiseEmpty.messagesDeleted === 0, 'Noise sweep on empty conversation returns 0 deleted');
  assert(noiseEmpty.passType === 'noise_sweep', 'Empty noise sweep has correct passType');

  const decayEmpty = runToolDecay(db, convId);
  assert(decayEmpty.messagesUpdated === 0, 'Tool decay on empty conversation returns 0 updated');
  assert(decayEmpty.passType === 'tool_decay', 'Empty tool decay has correct passType');

  const insertMsg = db.prepare(`
    INSERT INTO messages
      (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
    VALUES (?, ?, 'user', ?, ?, 0, datetime('now'))
  `);
  for (let i = 0; i < 5; i++) {
    insertMsg.run(convId, agentId, 'ok', i);
  }

  const noiseShort = runNoiseSweep(db, convId);
  assert(noiseShort.messagesDeleted === 0, 'Noise sweep on short conv (all in window) deletes nothing');

  const noiseNone = runNoiseSweep(db, 99999);
  assert(noiseNone.messagesDeleted === 0, 'Noise sweep on non-existent convId returns 0');

  const decayNone = runToolDecay(db, 99999);
  assert(decayNone.messagesUpdated === 0, 'Tool decay on non-existent convId returns 0');

  const agentId2 = 'proactive-window-test';
  const db2 = hm.dbManager.getMessageDb(agentId2);
  const sessionKey2 = 'agent:proactive-window-test:webchat:main';

  db2.prepare(`
    INSERT INTO conversations
      (session_key, agent_id, channel_type, status, message_count,
       token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey2, agentId2);

  const convRow2 = db2.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey2);
  const convId2 = convRow2.id;

  const insertMsg2 = db2.prepare(`
    INSERT INTO messages
      (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
    VALUES (?, ?, 'user', 'ok', ?, 0, datetime('now'))
  `);
  for (let i = 0; i < 10; i++) {
    insertMsg2.run(convId2, agentId2, i);
  }

  const noiseCustomWindow = runNoiseSweep(db2, convId2, 5);
  assert(noiseCustomWindow.messagesDeleted === 4, `Custom window=5: 4 noise msgs deleted (got ${noiseCustomWindow.messagesDeleted})`);

  const noiseFullWindow = runNoiseSweep(db2, convId2, 100);
  assert(noiseFullWindow.messagesDeleted === 0, 'Window=100 protects all remaining messages');
}

// ─── Integration Test (Indexer Tick) ─────────────────────────────

async function testIndexerIntegration() {
  console.log('\n── Indexer Integration ──\n');

  const agentId = 'proactive-indexer-test';
  const db = hm.dbManager.getMessageDb(agentId);
  const sessionKey = 'agent:proactive-indexer-test:webchat:main';

  db.prepare(`
    INSERT INTO conversations
      (session_key, agent_id, channel_type, status, message_count,
       token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const convRow = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  const convId = convRow.id;

  seedConversation(db, convId, agentId);

  const beforeCount = countMessages(db, convId);
  assert(beforeCount === 201, `Before tick: 201 messages (got ${beforeCount})`);

  const largeBefore = db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND message_index < 160 AND tool_results IS NOT NULL AND length(tool_results) > 2000`
  ).get(convId).n;
  assert(largeBefore === 10, `Before tick: 10 large tool_results outside decay window (got ${largeBefore})`);

  const libraryDb = hm.dbManager.getLibraryDb();

  const indexer = new BackgroundIndexer(
    { enabled: false },
    (id) => hm.dbManager.getMessageDb(id),
    () => libraryDb,
    () => [agentId],
  );

  await indexer.tick();

  const afterCount = countMessages(db, convId);
  assert(afterCount < beforeCount, `After tick: message count reduced (${beforeCount} → ${afterCount})`);
  assert(afterCount === 195, `After tick: exactly 195 messages remain (got ${afterCount})`);

  const largeAfter = db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND message_index < 160 AND tool_results IS NOT NULL AND length(tool_results) > 2000`
  ).get(convId).n;
  assert(largeAfter === 0, `After tick: 0 large tool_results outside decay window (got ${largeAfter})`);

  const insideWindowCount = db.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND message_index >= 180`
  ).get(convId).n;
  assert(insideWindowCount === 21, `After tick: 21 messages inside noise window untouched (got ${insideWindowCount})`);
}

// ─── Cleanup ─────────────────────────────────────────────────────

async function cleanup() {
  if (hm) await hm.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ─── Run ─────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════');
console.log('  HyperMem Proactive Passes Test (P2.3)');
console.log('═══════════════════════════════════════════════════');

try {
  await setup();
  await testNoiseSweep();
  await testNoiseSweepSkipsAllMessageFkReferences();
  await testReferencedNoiseDebtAndCompaction();
  await testReferencedNoiseCompactionRepairsContextAndSnapshotHeads();
  await testToolDecay();
  await testEdgeCases();
  await testIndexerIntegration();
  await cleanup();

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error('❌ Test suite crashed:', err);
  try { await cleanup(); } catch { /* ignore */ }
  process.exit(1);
}
