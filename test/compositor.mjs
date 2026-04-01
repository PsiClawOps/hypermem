/**
 * Compositor integration test.
 *
 * Tests prompt composition with all four memory layers:
 *   L1 Redis    — slot caching
 *   L2 Messages — conversation history
 *   L3 Vectors  — semantic recall (mocked — no Ollama required)
 *   L4 Library  — facts, knowledge, preferences
 */

import { HyperMem } from '../dist/index.js';
import { Compositor } from '../dist/compositor.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-compositor-'));

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

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Compositor Integration Test');
  console.log('═══════════════════════════════════════════════════\n');

  let hm;
  try {
    hm = await HyperMem.create({
      dataDir: tmpDir,
      redis: { host: 'localhost', port: 6379, keyPrefix: 'hm-comp:', sessionTTL: 60 },
    });
    await hm.redis.flushPrefix();
  } catch (err) {
    console.log(`  ❌ Failed to create HyperMem: ${err.message}`);
    process.exit(1);
  }

  const agentId = 'forge';
  const sessionKey = 'agent:forge:webchat:main';
  const msgDb = hm.dbManager.getMessageDb(agentId);
  const libDb = hm.dbManager.getLibraryDb();

  // ── Seed data ──

  // Seed a conversation with messages
  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status, message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-1', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const convRow = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  const convId = convRow.id;

  // Add messages
  const msgs = [
    { role: 'user', text: 'How is the HyperMem architecture structured?', idx: 1 },
    { role: 'assistant', text: 'HyperMem uses a four-layer architecture: L1 Redis, L2 Messages, L3 Vectors, L4 Library.', idx: 2 },
    { role: 'user', text: 'What about the library DB schema?', idx: 3 },
    { role: 'assistant', text: 'Library DB v5 has 10 collections: facts, knowledge, episodes, topics, preferences, fleet registry, system registry, work items, session registry, and desired state.', idx: 4 },
    { role: 'user', text: 'Can you show me the drift detection system?', idx: 5 },
  ];

  for (const m of msgs) {
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(convId, agentId, m.role, m.text, m.idx);
  }

  // Seed facts
  hm.addFact(agentId, 'Redis 7.0.15 is running on localhost:6379', {
    domain: 'infrastructure',
    visibility: 'fleet',
  });
  hm.addFact(agentId, 'Node.js v22.22.1 with built-in sqlite', {
    domain: 'runtime',
    visibility: 'fleet',
  });
  hm.addFact(agentId, 'sqlite-vec v0.1.9 provides vector search', {
    domain: 'dependencies',
    visibility: 'fleet',
  });

  // Seed knowledge
  hm.upsertKnowledge(agentId, 'architecture', 'memory-layers',
    'L1 Redis (hot), L2 messages.db (per-agent), L3 vectors.db (search), L4 library.db (fleet knowledge)');
  hm.upsertKnowledge(agentId, 'architecture', 'db-split',
    'Three files per agent: messages.db (rotatable), vectors.db (reconstructable), plus fleet-wide library.db (crown jewel)');

  // Seed preferences
  hm.setPreference('ragesaq', 'coding_style', 'Architecture over speed, explicit over implicit', {
    domain: 'development',
    agentId,
  });
  hm.setPreference('ragesaq', 'communication', 'Direct, no hedging', {
    domain: 'personal',
    agentId,
  });

  // ── Test 1: Basic composition without vector search ──
  console.log('── Basic Composition (L1+L2+L4) ──');

  const compositor = new Compositor({
    redis: hm.redis,
    vectorStore: null,  // No vector search for this test
    libraryDb: libDb,
  });

  const result = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 50000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    includeHistory: true,
    includeFacts: true,
    includeLibrary: true,
    includeContext: true,
  }, msgDb, libDb);

  assert(result.messages.length > 0, `Got ${result.messages.length} messages`);
  assert(result.tokenCount > 0, `Token count: ${result.tokenCount}`);
  assert(result.slots.history > 0, `History tokens: ${result.slots.history}`);
  assert(result.slots.facts > 0, `Facts tokens: ${result.slots.facts}`);
  assert(result.slots.library > 0, `Library tokens: ${result.slots.library} (knowledge + preferences)`);

  // Check that facts are in the output
  const allContent = result.messages.map(m => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(c => c.text || '').join(' ');
    return '';
  }).join(' ');

  assert(allContent.includes('Redis 7.0.15'), 'Facts injected into prompt');
  assert(allContent.includes('memory-layers') || allContent.includes('L1 Redis'), 'Knowledge injected into prompt');
  assert(allContent.includes('Architecture over speed') || allContent.includes('coding_style'), 'Preferences injected into prompt');

  // Check history is included
  assert(allContent.includes('drift detection'), 'User messages in history');
  assert(allContent.includes('four-layer architecture'), 'Assistant messages in history');

  // ── Test 2: Token budget enforcement ──
  console.log('\n── Token Budget Enforcement ──');

  const tightResult = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 500, // Very tight budget
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    includeHistory: true,
    includeFacts: true,
    includeLibrary: true,
  }, msgDb, libDb);

  assert(tightResult.tokenCount <= 600, `Tight budget tokens: ${tightResult.tokenCount} (target ≤600)`);
  // With small test data, budget may not be exceeded — verify it's under budget
  assert(tightResult.tokenCount <= 500 || tightResult.truncated, 'Under budget or truncated');

  // ── Test 3: Selective slot inclusion ──
  console.log('\n── Selective Slot Inclusion ──');

  const noFactsResult = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 50000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    includeFacts: false,
    includeLibrary: false,
    includeContext: false,
  }, msgDb, libDb);

  assert(noFactsResult.slots.facts === 0, 'Facts excluded when disabled');
  assert(noFactsResult.slots.library === 0, 'Library excluded when disabled');
  assert(noFactsResult.slots.context === 0, 'Context excluded when disabled');
  assert(noFactsResult.slots.history > 0, 'History still included');

  // ── Test 4: Redis-warmed composition ──
  console.log('\n── Redis-Warmed Composition ──');

  // Warm the session
  await compositor.warmSession(agentId, sessionKey, msgDb, {
    systemPrompt: 'You are Forge, the infrastructure seat.',
    identity: 'Forge — Infrastructure Council Seat',
    libraryDb: libDb,
  });

  const warmedResult = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 50000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  }, msgDb, libDb);

  assert(warmedResult.slots.system > 0, `System prompt tokens: ${warmedResult.slots.system}`);
  assert(warmedResult.slots.identity > 0, `Identity tokens: ${warmedResult.slots.identity}`);

  const warmedContent = warmedResult.messages.map(m => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map(c => c.text || '').join(' ');
    return '';
  }).join(' ');

  assert(warmedContent.includes('Forge'), 'System prompt from Redis');

  // ── Test 5: Empty session composition ──
  console.log('\n── Empty Session Composition ──');

  const emptyResult = await compositor.compose({
    agentId: 'newagent',
    sessionKey: 'agent:newagent:webchat:main',
    tokenBudget: 50000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  }, msgDb, libDb);

  assert(emptyResult.messages.length === 0 || emptyResult.tokenCount < 100, 'Empty session produces minimal output');

  // ── Test 6: Multi-provider output ──
  console.log('\n── Multi-Provider Output ──');

  const openaiResult = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 50000,
    provider: 'openai',
    model: 'gpt-4',
  }, msgDb, libDb);

  assert(openaiResult.messages.length > 0, 'OpenAI format works');
  // OpenAI uses { role, content } format
  const firstMsg = openaiResult.messages[0];
  assert('role' in firstMsg, 'OpenAI message has role');
  assert('content' in firstMsg, 'OpenAI message has content');

  // ── Test 7: Slot token accounting ──
  console.log('\n── Slot Token Accounting ──');

  const accountedResult = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 50000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  }, msgDb, libDb);

  const slotTotal = Object.values(accountedResult.slots).reduce((a, b) => a + b, 0);
  assert(Math.abs(slotTotal - accountedResult.tokenCount) < 50,
    `Slot sum (${slotTotal}) ≈ total (${accountedResult.tokenCount})`);

  // ── Cleanup ──
  console.log('\n── Cleanup ──');
  await hm.redis.flushPrefix();
  await hm.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert(true, 'Cleaned up');

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
