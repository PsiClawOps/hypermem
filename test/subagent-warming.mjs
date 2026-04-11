/**
 * Test: subagent warming control
 *
 * Verifies that ComposeRequest flags (includeLibrary, includeSemanticRecall,
 * includeKeystones) correctly gate compositor behavior for subagent light mode.
 */
import { HyperMem } from '../dist/index.js';
import { Compositor } from '../dist/compositor.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `hypermem-subagent-warming-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

let failures = 0;
function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures++;
  }
}

function seedSession(msgDb, sk, agentId, msgCount) {
  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
      message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sk, `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`, agentId);

  const convRow = msgDb.prepare(
    'SELECT id FROM conversations WHERE session_key = ? ORDER BY id DESC LIMIT 1'
  ).get(sk);

  for (let i = 0; i < msgCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content,
        message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(convRow.id, agentId, role, `Message ${i + 1} about infrastructure from ${role}`, i + 1);
  }
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Subagent Warming Control Tests');
  console.log('═══════════════════════════════════════════════════\n');

  let hm;
  try {
    hm = await HyperMem.create({ dataDir: tmpDir });
  } catch (err) {
    console.log(`  ❌ Failed to create HyperMem: ${err.message}`);
    process.exit(1);
  }

  const agentId = 'alice';
  const parentSk = 'agent:alice:webchat:main';
  const subagentSk = 'subagent:alice:task-abc123';
  const msgDb = hm.dbManager.getMessageDb(agentId);
  const libDb = hm.dbManager.getLibraryDb();

  // Seed sessions
  seedSession(msgDb, parentSk, agentId, 10);
  seedSession(msgDb, subagentSk, agentId, 10);

  // Seed facts
  hm.addFact(agentId, 'Redis 7.0.15 is running on localhost:6379', {
    domain: 'infrastructure', visibility: 'fleet',
  });
  hm.addFact(agentId, 'Node.js v22.22.1 with built-in sqlite', {
    domain: 'runtime', visibility: 'fleet',
  });

  // Seed knowledge
  hm.upsertKnowledge(agentId, 'architecture', 'memory-layers',
    'L1 Redis hot cache, L2 messages.db per-agent, L3 vectors.db search, L4 library.db fleet knowledge');

  const compositor = new Compositor({
    cache: hm.cache,
    vectorStore: null,
    libraryDb: libDb,
  });

  // ── Test 1: Full mode baseline ──
  console.log('── Test 1: Full Mode (all layers) ──');
  {
    const result = await compositor.compose({
      agentId,
      sessionKey: parentSk,
      tokenBudget: 50000,
      historyDepth: 50,
    }, msgDb, libDb);

    assert('Has messages', result.messages.length > 0);
    const ctx = result.contextBlock || '';
    assert('Facts included', ctx.includes('Redis') || ctx.includes('Active Facts'));
    assert('Knowledge included', ctx.includes('memory-layers') || ctx.includes('Knowledge'));
  }

  // ── Test 2: Light mode (skip library, semantic, keystones) ──
  console.log('\n── Test 2: Light Mode (skip library + semantic + keystones) ──');
  {
    const result = await compositor.compose({
      agentId,
      sessionKey: subagentSk,
      tokenBudget: 50000,
      historyDepth: 50,
      includeLibrary: false,
      includeSemanticRecall: false,
      includeKeystones: false,
    }, msgDb, libDb);

    assert('Has messages', result.messages.length > 0);
    const ctx = result.contextBlock || '';
    assert('Facts still included', ctx.includes('Redis') || ctx.includes('Active Facts'));
    assert('Knowledge excluded', !ctx.includes('memory-layers'));
  }

  // ── Test 3: Light mode produces smaller context ──
  console.log('\n── Test 3: Light mode uses fewer tokens ──');
  {
    const fullResult = await compositor.compose({
      agentId,
      sessionKey: parentSk,
      tokenBudget: 50000,
      historyDepth: 50,
    }, msgDb, libDb);

    const lightResult = await compositor.compose({
      agentId,
      sessionKey: subagentSk,
      tokenBudget: 50000,
      historyDepth: 50,
      includeLibrary: false,
      includeSemanticRecall: false,
      includeKeystones: false,
      includeDocChunks: false,
    }, msgDb, libDb);

    const fullLen = (fullResult.contextBlock || '').length;
    const lightLen = (lightResult.contextBlock || '').length;
    assert(`Light context (${lightLen} chars) <= full (${fullLen} chars)`, lightLen <= fullLen);
  }

  // ── Test 4: All retrieval off ──
  console.log('\n── Test 4: Everything off (minimal assembly) ──');
  {
    const result = await compositor.compose({
      agentId,
      sessionKey: subagentSk,
      tokenBudget: 50000,
      historyDepth: 50,
      includeFacts: false,
      includeLibrary: false,
      includeSemanticRecall: false,
      includeKeystones: false,
      includeDocChunks: false,
    }, msgDb, libDb);

    const ctx = result.contextBlock || '';
    assert('Facts excluded', !ctx.includes('Redis'));
    assert('Knowledge excluded', !ctx.includes('memory-layers'));
    assert('Still has messages (history preserved)', result.messages.length > 0);
  }

  // ── Test 5: Flags default to include (undefined = full) ──
  console.log('\n── Test 5: Undefined flags = full inclusion ──');
  {
    const explicitFull = await compositor.compose({
      agentId,
      sessionKey: parentSk,
      tokenBudget: 50000,
      historyDepth: 50,
      includeLibrary: undefined,
      includeSemanticRecall: undefined,
      includeKeystones: undefined,
    }, msgDb, libDb);

    const implicitFull = await compositor.compose({
      agentId,
      sessionKey: parentSk,
      tokenBudget: 50000,
      historyDepth: 50,
    }, msgDb, libDb);

    assert('Explicit undefined = implicit default (same context length)',
      (explicitFull.contextBlock || '').length === (implicitFull.contextBlock || '').length);
  }

  // ── Cleanup ──
  console.log('\n── Cleanup ──');
  try {
    hm.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('  ✅ Cleaned up');
  } catch (e) {
    console.log(`  ⚠️ Cleanup: ${e.message}`);
  }

  console.log('\n═══════════════════════════════════════════════════');
  if (failures > 0) {
    console.log(`  ${failures} TEST(S) FAILED ❌`);
    process.exit(1);
  } else {
    console.log('  ALL TESTS PASSED ✅');
  }
  console.log('═══════════════════════════════════════════════════');
}

run();
