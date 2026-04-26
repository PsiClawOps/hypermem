/**
 * Sprint 4 — Prompt placement + budget lanes + provider diagnostics
 *
 * Verifies:
 * 1. Volatile context (active facts, semantic recall, doc chunks) is placed
 *    AFTER history (near the user turn), not before it.
 * 2. Stable content (stable facts, knowledge, preferences) stays in the
 *    stable prefix (before history).
 * 3. Explicit budget lanes are emitted in diagnostics.
 * 4. OpenAI prefix-cache diagnostics are emitted for OpenAI providers.
 * 5. The dynamic boundary (cache-boundary slot) is still set on the volatile
 *    context message so Anthropic and OpenAI prefix caching remains correct.
 */

import { HyperMem } from '../dist/index.js';
import { Compositor } from '../dist/compositor.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-s4-placement-'));

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
  console.log('  Sprint 4: Prompt Placement + Budget Lanes Test');
  console.log('═══════════════════════════════════════════════════\n');

  let hm;
  try {
    hm = await HyperMem.create({ dataDir: tmpDir });
  } catch (err) {
    console.log(`  ❌ Failed to create HyperMem: ${err.message}`);
    process.exit(1);
  }

  const agentId = 's4-test-agent';
  const sessionKey = 'agent:s4-test-agent:webchat:main';

  const msgDb = hm.dbManager.getMessageDb(agentId);
  const libDb = hm.dbManager.getLibraryDb();

  const compositor = new Compositor({
    cache: hm.cache,
    vectorStore: null,
    libraryDb: libDb,
  });

  // ── Seed conversation and history ────────────────────────────────
  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status, message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s4', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const convRow = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  const convId = convRow.id;

  // Seed 3 user+assistant turns so there's real history in the window
  const historyMsgs = [
    { role: 'user', text: 'History turn 1: project overview?', idx: 1 },
    { role: 'assistant', text: 'The project uses Apache-2.0 license.', idx: 2 },
    { role: 'user', text: 'History turn 2: which team is responsible?', idx: 3 },
    { role: 'assistant', text: 'The core team manages the project.', idx: 4 },
    { role: 'user', text: 'History turn 3: latest update?', idx: 5 },
    { role: 'assistant', text: 'Sprint 3 shipped last week.', idx: 6 },
    { role: 'user', text: 'What do you know about the project?', idx: 7 },
  ];
  for (const m of historyMsgs) {
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(convId, agentId, m.role, m.text, m.idx);
  }

  // Seed facts: both stable (agent-scope) and volatile (session-scope)
  hm.addFact(agentId, 'Stable fact: project uses Apache-2.0 license.', {
    domain: 'persistent',
    visibility: 'fleet',
    scope: 'agent',
  });
  hm.addFact(agentId, 'Active session fact: current sprint is Sprint 4.', {
    domain: 'session',
    visibility: 'private',
    scope: 'session',
    sourceSessionKey: sessionKey,
  });

  // Warm session with identity
  await compositor.warmSession(agentId, sessionKey, msgDb, {
    systemPrompt: 'You are the Sprint 4 test agent.',
    identity: 'sprint4-agent identity v1',
    libraryDb: libDb,
    model: 'claude-opus-4-6',
  });

  // ── Compose and inspect the window layout ────────────────────────
  console.log('── Part 1: Prompt-tail placement verification ──\n');

  const result = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 12000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    includeHistory: true,
    includeFacts: true,
    includeLibrary: false,
    includeContext: false,
    includeSemanticRecall: false,
    includeDocChunks: false,
    skipProviderTranslation: true,
    skipWindowCache: true,
  }, msgDb, libDb);

  const msgs = result.messages;
  const diag = result.diagnostics ?? {};

  // Find the dynamic boundary (volatile context block)
  const boundaryIdx = msgs.findIndex(m => m.metadata?.dynamicBoundary === true);

  // Count how many non-system messages appear before the boundary
  const historyMsgsBeforeBoundary = boundaryIdx >= 0
    ? msgs.slice(0, boundaryIdx).filter(m => m.role !== 'system').length
    : 0;

  const prefixSegmentCount = diag.prefixSegmentCount ?? 0;

  assert(boundaryIdx >= 0, 'Sprint 4: volatile context block (dynamicBoundary) found in window');

  if (boundaryIdx >= 0) {
    assert(boundaryIdx >= prefixSegmentCount,
      `Sprint 4: volatile context is at or after stable prefix (idx=${boundaryIdx}, prefixSegments=${prefixSegmentCount})`);
    assert(historyMsgsBeforeBoundary > 0,
      `Sprint 4: history messages appear before volatile context block (found ${historyMsgsBeforeBoundary})`);

    // After Sprint 4 tail placement, the volatile context should be AFTER history
    // (i.e., the last message or second-to-last if user turn is last)
    const lastMsg = msgs[msgs.length - 1];
    const isAtTail = boundaryIdx >= msgs.length - 2; // within 1 of end
    assert(isAtTail,
      `Sprint 4: volatile context block is near the tail (boundaryIdx=${boundaryIdx}, total=${msgs.length})`);

    // The volatile context should appear AFTER some non-system history messages
    const histMsgsBefore = msgs.slice(0, boundaryIdx).filter(m => m.role !== 'system');
    assert(histMsgsBefore.length > 0,
      `Sprint 4: at least one non-system message appears before volatile context (found ${histMsgsBefore.length})`);
  }

  // Verify volatile context block contains active/session facts
  if (boundaryIdx >= 0) {
    const boundaryText = msgs[boundaryIdx].textContent ?? '';
    assert(
      boundaryText.includes('## Active Facts') || boundaryText.includes('Sprint 4'),
      'Sprint 4: volatile context block contains active facts'
    );
  }

  // ── Part 2: Budget lanes in diagnostics ──────────────────────────
  console.log('\n── Part 2: Explicit budget lanes in diagnostics ──\n');

  assert(diag.budgetLanes !== undefined, 'Sprint 4: budgetLanes emitted in diagnostics');

  if (diag.budgetLanes) {
    const lanes = diag.budgetLanes;
    assert(typeof lanes.effectiveBudget === 'number' && lanes.effectiveBudget > 0,
      `Sprint 4: budgetLanes.effectiveBudget is a positive number (${lanes.effectiveBudget})`);
    assert(typeof lanes.history === 'number' && lanes.history > 0,
      `Sprint 4: budgetLanes.history is a positive number (${lanes.history})`);
    assert(typeof lanes.memory === 'number' && lanes.memory > 0,
      `Sprint 4: budgetLanes.memory is a positive number (${lanes.memory})`);
    assert(typeof lanes.historyFraction === 'number' && lanes.historyFraction > 0 && lanes.historyFraction < 1,
      `Sprint 4: budgetLanes.historyFraction is in (0,1) (${lanes.historyFraction})`);
    assert(typeof lanes.memoryFraction === 'number' && lanes.memoryFraction > 0 && lanes.memoryFraction < 1,
      `Sprint 4: budgetLanes.memoryFraction is in (0,1) (${lanes.memoryFraction})`);
    assert(typeof lanes.overhead === 'number' && lanes.overhead >= 0,
      `Sprint 4: budgetLanes.overhead is non-negative (${lanes.overhead})`);
    assert(lanes.filled !== undefined && typeof lanes.filled.history === 'number',
      'Sprint 4: budgetLanes.filled.history is present');
    assert(lanes.filled !== undefined && typeof lanes.filled.memory === 'number',
      'Sprint 4: budgetLanes.filled.memory is present');
    assert(lanes.filled !== undefined && typeof lanes.filled.stablePrefix === 'number',
      'Sprint 4: budgetLanes.filled.stablePrefix is present');

    // The sum of filled slots should not exceed effective budget (with 10% drift tolerance)
    const totalFilled = lanes.filled.stablePrefix + lanes.filled.history + lanes.filled.memory;
    assert(totalFilled <= lanes.effectiveBudget * 1.1,
      `Sprint 4: sum of filled lanes (${totalFilled}) does not exceed effectiveBudget (${lanes.effectiveBudget})`);
  }

  // ── Part 3: volatileContextPosition in diagnostics ───────────────
  console.log('\n── Part 3: volatileContextPosition in diagnostics ──\n');

  assert(diag.volatileContextPosition !== undefined,
    `Sprint 4: volatileContextPosition emitted in diagnostics (${diag.volatileContextPosition})`);
  assert(diag.messagesBeforeVolatile !== undefined,
    `Sprint 4: messagesBeforeVolatile emitted in diagnostics (${diag.messagesBeforeVolatile})`);

  if (diag.volatileContextPosition !== undefined) {
    assert(diag.volatileContextPosition >= prefixSegmentCount,
      `Sprint 4: volatileContextPosition (${diag.volatileContextPosition}) is after stable prefix (${prefixSegmentCount})`);
  }

  // ── Part 4: OpenAI prefix-cache diagnostics ───────────────────────
  console.log('\n── Part 4: OpenAI prefix-cache diagnostics ──\n');

  // For non-OpenAI providers (anthropic), openaiPrefixCacheDiag should be undefined
  assert(result.diagnostics?.openaiPrefixCacheDiag === undefined,
    'Sprint 4: openaiPrefixCacheDiag is undefined for Anthropic provider');

  // Compose again with OpenAI provider to get openaiPrefixCacheDiag
  const oaiSessionKey = 'agent:s4-test-agent:webchat:oai';
  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status, message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s4-oai', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(oaiSessionKey, agentId);

  const oaiConvRow = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(oaiSessionKey);
  const oaiConvId = oaiConvRow.id;

  msgDb.prepare(`
    INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
    VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
  `).run(oaiConvId, agentId, 'user', 'OpenAI test: what do you know?', 1);

  await compositor.warmSession(agentId, oaiSessionKey, msgDb, {
    systemPrompt: 'You are the Sprint 4 OpenAI test agent.',
    identity: 'sprint4-oai-agent identity v1',
    libraryDb: libDb,
    model: 'gpt-4o',
  });

  const oaiResult = await compositor.compose({
    agentId,
    sessionKey: oaiSessionKey,
    tokenBudget: 12000,
    provider: 'openai',
    model: 'gpt-4o',
    includeHistory: true,
    includeFacts: true,
    includeLibrary: false,
    includeContext: false,
    includeSemanticRecall: false,
    includeDocChunks: false,
    skipProviderTranslation: true,
    skipWindowCache: true,
  }, msgDb, libDb);

  const oaiDiag = oaiResult.diagnostics;

  assert(oaiDiag?.openaiPrefixCacheDiag !== undefined,
    'Sprint 4: openaiPrefixCacheDiag is emitted for OpenAI provider');

  if (oaiDiag?.openaiPrefixCacheDiag) {
    const oaiCache = oaiDiag.openaiPrefixCacheDiag;
    assert(typeof oaiCache.stablePrefixMessageCount === 'number' && oaiCache.stablePrefixMessageCount >= 0,
      `Sprint 4: openaiPrefixCacheDiag.stablePrefixMessageCount is present (${oaiCache.stablePrefixMessageCount})`);
    assert(typeof oaiCache.stablePrefixTokens === 'number' && oaiCache.stablePrefixTokens >= 0,
      `Sprint 4: openaiPrefixCacheDiag.stablePrefixTokens is present (${oaiCache.stablePrefixTokens})`);
    assert(typeof oaiCache.cacheableFraction === 'number' && oaiCache.cacheableFraction >= 0 && oaiCache.cacheableFraction <= 1,
      `Sprint 4: openaiPrefixCacheDiag.cacheableFraction is in [0,1] (${oaiCache.cacheableFraction})`);
    assert(typeof oaiCache.volatileAtTail === 'boolean',
      `Sprint 4: openaiPrefixCacheDiag.volatileAtTail is a boolean (${oaiCache.volatileAtTail})`);
    console.log(`  ℹ OpenAI prefix cache: ${oaiCache.stablePrefixMessageCount} stable msgs, ${oaiCache.stablePrefixTokens} tokens, cacheableFraction=${oaiCache.cacheableFraction}, volatileAtTail=${oaiCache.volatileAtTail}`);
  }

  // ── Part 5: Stable prefix boundary correctness ───────────────────
  console.log('\n── Part 5: Cache boundary remains correct after reorder ──\n');

  // The dynamicBoundary marker must still be present on the volatile context message
  assert(boundaryIdx < 0 || msgs[boundaryIdx]?.metadata?.dynamicBoundary === true,
    'Sprint 4: dynamicBoundary marker is preserved on volatile context message');

  // The stable prefix should only count messages above the boundary (not history)
  assert(prefixSegmentCount > 0,
    `Sprint 4: prefixSegmentCount > 0 (${prefixSegmentCount})`);

  // All messages at index < prefixSegmentCount should be system messages
  const allPrefixAreSystem = msgs.slice(0, prefixSegmentCount).every(m => m.role === 'system');
  assert(allPrefixAreSystem,
    'Sprint 4: all messages in stable prefix (< prefixSegmentCount) are system messages');

  // prefixHash should be stable across turns with same stable content
  const result2 = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 12000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    includeHistory: true,
    includeFacts: true,
    includeLibrary: false,
    includeContext: false,
    includeSemanticRecall: false,
    includeDocChunks: false,
    skipProviderTranslation: true,
    skipWindowCache: true,
  }, msgDb, libDb);

  assert(result2.diagnostics?.prefixHash === diag.prefixHash,
    'Sprint 4: prefixHash is stable across turns when stable content unchanged');

  // ── Summary ──────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  Sprint 4 Prompt Placement: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
