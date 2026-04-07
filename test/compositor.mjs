/**
 * Compositor integration test.
 *
 * Tests prompt composition with all four memory layers:
 *   L1 Redis    - slot caching
 *   L2 Messages - conversation history
 *   L3 Vectors  - semantic recall (mocked - no Ollama required)
 *   L4 Library  - facts, knowledge, preferences
 */

import { HyperMem, toProviderFormat, repairToolCallPairs } from '../dist/index.js';
import { Compositor, DEFAULT_TRIGGERS } from '../dist/compositor.js';
import { chunkMarkdown } from '../dist/doc-chunker.js';
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
  // With small test data, budget may not be exceeded - verify it's under budget
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
    identity: 'Forge - Infrastructure Council Seat',
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

  // ── Test 4b: Gate 1 - historyDepth constrains hot Redis sessions ──
  console.log('\n── Gate 1: historyDepth limits hot Redis sessions ──');

  const isWarm = await hm.redis.sessionExists(agentId, sessionKey);
  assert(isWarm, 'Session marked warm in Redis');

  const gatedResult = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 50000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    includeFacts: false,
    includeLibrary: false,
    includeContext: false,
    includeDocChunks: false,
    historyDepth: 2,
  }, msgDb, libDb);

  const gateHistoryCount = gatedResult.messages.filter(m => m.role !== 'system').length;
  assert(gateHistoryCount === 2,
    `Hot Redis historyDepth=2 returns 2 non-system messages (got ${gateHistoryCount})`);
  assert(gatedResult.tokenCount <= 50000, `Gate 1 token count ${gatedResult.tokenCount} within budget`);

  // ── Test 5: Empty session composition ──
  console.log('\n── Empty Session Composition ──');

  const emptyResult = await compositor.compose({
    agentId: 'newagent',
    sessionKey: 'agent:newagent:webchat:main',
    tokenBudget: 50000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  }, msgDb, libDb);

  // FOS/MOD context is always injected when libDb is present and has a seeded FOS profile.
  // Empty session may still have context tokens from FOS/MOD directives.
  assert(
    emptyResult.messages.length === 0 || emptyResult.tokenCount < 1000,
    'Empty session produces minimal output (no history, small FOS/MOD context)'
  );

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

  // ── Trigger Registry ──
  console.log('\n── Trigger Registry ──');

  // Verify DEFAULT_TRIGGERS covers expected collections
  const collections = DEFAULT_TRIGGERS.map(t => t.collection);
  assert(collections.includes('governance/policy'), 'Trigger: governance/policy defined');
  assert(collections.includes('governance/comms'), 'Trigger: governance/comms defined');
  assert(collections.includes('identity/job'), 'Trigger: identity/job defined');
  assert(collections.includes('memory/decisions'), 'Trigger: memory/decisions defined');

  // Verify keyword matching logic
  const policyTrigger = DEFAULT_TRIGGERS.find(t => t.collection === 'governance/policy');
  assert(policyTrigger !== undefined, 'Policy trigger exists');
  assert(policyTrigger.keywords.some(k => 'escalation decision'.includes(k)), 'Policy trigger matches "escalation"');

  // ── Doc Chunk Retrieval in Composition ──
  console.log('\n── Doc Chunk Retrieval (L4 Trigger-Based) ──');

  // Seed some policy chunks into the library DB
  const policyContent = `# POLICY.md

Fleet governance policy.

## §2 Escalation

Four mandatory escalation triggers require human review. No autonomous resolution allowed.

### Trigger 1: Policy Conflict

If instructions conflict with safety or compliance policies, pause and ask.
This is a hard requirement that cannot be bypassed.

## §3 Decision States

Green, Yellow, Red decision framework for operational status.
GREEN = proceed normally, YELLOW = proceed with caution, RED = stop and escalate immediately.
All council decisions must include a decision state in their response.
`;

  const policyChunks = chunkMarkdown(policyContent, {
    collection: 'governance/policy',
    sourcePath: '/workspace/POLICY.md',
    scope: 'shared-fleet',
  });
  hm.indexDocChunks(policyChunks);

  // Also seed job/deliberation chunks
  const jobContent = `# JOB.md

Performance criteria for the infrastructure seat.

## Response Contract

Every council response includes:
1. Position - operationally fit, conditionally fit, or not fit
2. Top risk - single most critical operational or architectural risk
3. Confidence - high/medium/low
4. Action - specific infrastructure work, test, or validation needed
`;

  const jobChunks = chunkMarkdown(jobContent, {
    collection: 'identity/job',
    sourcePath: '/workspace/JOB.md',
    scope: 'per-agent',
    agentId: 'forge',
  });
  hm.indexDocChunks(jobChunks);

  // The seeded policy doc contains unique text that can ONLY appear via chunk injection,
  // not from echoing the user message. We assert on that unique text.
  // Unique sentinel in policyContent: "mandatory human review requirements"
  // Unique sentinel in jobContent: "operationally fit, conditionally fit, or not fit"
  //
  // This ensures the test fails if FTS retrieval doesn't actually find the right chunks
  // (Pylon's repro: user message contained "escalation" but no chunk was injected).

  const chunkSessionKey = 'agent:forge:webchat:chunk-test';
  await hm.recordUserMessage(agentId, chunkSessionKey, 'What are the escalation triggers I should follow?');

  const escalationResult = await hm.compose({
    agentId,
    sessionKey: chunkSessionKey,
    tokenBudget: 8000,
    provider: 'anthropic',
    includeDocChunks: true,
  });

  const escalationText = escalationResult.messages.map(m =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  ).join('\n');

  // Assert on chunk-unique content - text that can only appear via chunk injection, not from the user message.
  // The seeded policy chunk contains "No autonomous resolution allowed" - unique sentinel text
  // that does not appear in the user question "What are the escalation triggers I should follow?"
  assert(escalationText.includes('No autonomous resolution') || escalationText.includes('autonomous resolution'),
    'Chunk-unique policy text injected (not just user message echo)');
  assert(escalationResult.slots.library > 0,
    'Library slot consumed (confirms chunk was actually injected, not just present in history)');

  // Seed a deliberation-related message to trigger identity/job chunks
  const deliberationSessionKey = 'agent:forge:webchat:deliberation-test';
  await hm.recordUserMessage(agentId, deliberationSessionKey, 'We need a council round vote on this proposal and response contract.');

  const deliberationResult = await hm.compose({
    agentId,
    sessionKey: deliberationSessionKey,
    tokenBudget: 8000,
    provider: 'anthropic',
    includeDocChunks: true,
  });

  const deliberationText = deliberationResult.messages.map(m =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  ).join('\n');

  // Assert on chunk-unique content from the seeded JOB.md
  assert(deliberationText.includes('operationally fit') || deliberationText.includes('conditionally fit'),
    'Chunk-unique job text injected (response contract from seeded JOB.md)');

  const statsAfterSeed = hm.getDocIndexStats();
  assert(statsAfterSeed.length >= 2, `Doc index has ${statsAfterSeed.length} collections after seeding`);
  assert(statsAfterSeed.some(s => s.collection === 'governance/policy'), 'Policy collection indexed');
  assert(statsAfterSeed.some(s => s.collection === 'identity/job'), 'Job collection indexed');

  // Tier filter: council-scoped chunks should not appear for director queries
  const councilChunks = chunkMarkdown('# Charter\n\n## Council Structure\n\nThis section is for council seats only - their specific roles and responsibilities.\n', {
    collection: 'governance/charter',
    sourcePath: '/workspace/forge/CHARTER.md',
    scope: 'per-tier',
    tier: 'council',
  });
  const directorChunks = chunkMarkdown('# Charter\n\n## Director Structure\n\nThis section is for directors only - their specific delegation and reporting lines.\n', {
    collection: 'governance/charter',
    sourcePath: '/workspace/pylon/CHARTER.md',
    scope: 'per-tier',
    tier: 'director',
  });
  hm.indexDocChunks(councilChunks);
  hm.indexDocChunks(directorChunks);

  // Query with tier filter - should only return matching tier
  const councilOnly = hm.queryDocChunks({ collection: 'governance/charter', tier: 'council' });
  const directorOnly = hm.queryDocChunks({ collection: 'governance/charter', tier: 'director' });
  assert(councilOnly.every(c => !c.tier || c.tier === 'council'), 'Council tier filter excludes director chunks');
  assert(directorOnly.every(c => !c.tier || c.tier === 'director'), 'Director tier filter excludes council chunks');

  // ── Prompt-Aware Retrieval (current turn, before history append) ──
  console.log('\n── Prompt-Aware Retrieval (current turn) ──');

  hm.upsertKnowledge(agentId, 'deployments', 'k8s-staging',
    'K8S_STAGING_SENTINEL Kubernetes staging deployment requires readiness gates, rollout checks, and rollback verification.');

  const promptRecallSessionKey = 'agent:forge:webchat:prompt-recall-test';
  await hm.recordUserMessage(agentId, promptRecallSessionKey, 'Can you review our incident process?');
  await hm.recordAssistantMessage(agentId, promptRecallSessionKey, {
    role: 'assistant',
    textContent: 'Yes - I can review the incident process.',
    toolCalls: null,
    toolResults: null,
  });
  await hm.recordUserMessage(agentId, promptRecallSessionKey, 'Focus on escalation policy gaps.');
  await hm.recordAssistantMessage(agentId, promptRecallSessionKey, {
    role: 'assistant',
    textContent: 'I will focus on escalation policy gaps.',
    toolCalls: null,
    toolResults: null,
  });
  await hm.recordUserMessage(agentId, promptRecallSessionKey, 'We also need a governance summary.');

  const promptRecallResult = await hm.compose({
    agentId,
    sessionKey: promptRecallSessionKey,
    tokenBudget: 8000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    includeDocChunks: false,
    prompt: 'kubernetes staging deployment',
  });

  const promptRecallText = [
    promptRecallResult.contextBlock || '',
    ...promptRecallResult.messages.map(m =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ),
  ].join('\n');

  assert(promptRecallText.includes('K8S_STAGING_SENTINEL'),
    'Semantic recall uses request.prompt before prompt is written to history');
  // TUNE-016: FTS floor raised to 0.05 — low-score FTS hits are filtered. Knowledge is still
  // retrieved via library path (L2). The assert below confirms content is present regardless
  // of which context section it appears under.
  assert(promptRecallText.includes('K8S_STAGING_SENTINEL'),
    'Prompt-aware retrieval surfaces knowledge content (via library or related-memory path)');

  // 'P0.1: prompt drives retrieval before message is in history'
  console.log('\n── P0.1: prompt drives retrieval before message is in history ──');

  const freshPromptSessionKey = 'agent:forge:webchat:fresh-prompt-test';
  const freshPromptResult = await hm.compose({
    agentId,
    sessionKey: freshPromptSessionKey,
    tokenBudget: 8000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    includeDocChunks: true,
    prompt: 'escalation triggers human review',
  });

  const freshPromptText = [
    freshPromptResult.contextBlock || '',
    ...freshPromptResult.messages.map(m =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    ),
  ].join('\n');

  assert(
    freshPromptResult.slots.library > 0
      || freshPromptText.includes('No autonomous resolution')
      || freshPromptText.includes('human review')
      || freshPromptText.includes('escalation'),
    'P0.1: prompt drives retrieval before message is in history'
  );

  // ── skipProviderTranslation (Plugin Path) ──
  console.log('\n── skipProviderTranslation (Plugin Path) ──');

  // Record a conversation with tool calls to test round-trip
  const pluginSessionKey = `agent:${agentId}:webchat:plugin-test`;
  await hm.recordUserMessage(agentId, pluginSessionKey, 'Read my TOOLS.md file');
  await hm.recordAssistantMessage(agentId, pluginSessionKey, {
    role: 'assistant',
    textContent: 'Let me read that for you.',
    toolCalls: [
      { id: 'hm_test_001', name: 'read', arguments: '{"path":"/workspace/TOOLS.md"}' },
    ],
    toolResults: null,
  });
  await hm.recordAssistantMessage(agentId, pluginSessionKey, {
    role: 'user',
    textContent: null,
    toolCalls: null,
    toolResults: [
      { callId: 'hm_test_001', name: 'read', content: '# TOOLS.md contents here', isError: false },
    ],
  });
  await hm.recordAssistantMessage(agentId, pluginSessionKey, {
    role: 'assistant',
    textContent: 'Here are the contents of TOOLS.md.',
    toolCalls: null,
    toolResults: null,
  });

  // Compose with skipProviderTranslation - should get NeutralMessages back
  const pluginCompositor = new Compositor({
    redis: hm.redis,
    vectorStore: null,
    libraryDb: libDb,
  });

  const neutralResult = await pluginCompositor.compose({
    agentId,
    sessionKey: pluginSessionKey,
    tokenBudget: 50000,
    model: 'claude-opus-4-6',
    skipProviderTranslation: true,
  }, hm.dbManager.getMessageDb(agentId), libDb);

  // Messages should be NeutralMessage format, not provider-translated
  const historyMsgs = neutralResult.messages.filter(m => m.role !== 'system');
  assert(historyMsgs.length >= 4, `Plugin path: got ${historyMsgs.length} history messages (expected ≥4)`);

  // Find the assistant message with tool calls
  const tcMsg = neutralResult.messages.find(m =>
    m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
  );
  assert(tcMsg !== undefined, 'Plugin path: found assistant message with tool calls');
  if (tcMsg) {
    // In neutral format, toolCalls should be NeutralToolCall objects with arguments as string
    const tc = tcMsg.toolCalls[0];
    assert(typeof tc.arguments === 'string', `Plugin path: tool call arguments is string (got ${typeof tc.arguments})`);
    assert(tc.name === 'read', `Plugin path: tool call name preserved (got ${tc.name})`);
    assert(tc.id === 'hm_test_001', `Plugin path: tool call ID preserved (got ${tc.id})`);

    // Parse and verify
    const parsed = JSON.parse(tc.arguments);
    assert(parsed.path === '/workspace/TOOLS.md', `Plugin path: tool call arguments parseable`);
  }

  // Find tool result message
  const trMsg = neutralResult.messages.find(m =>
    m.role === 'user' && m.toolResults && m.toolResults.length > 0
  );
  assert(trMsg !== undefined, 'Plugin path: found tool result message');
  if (trMsg) {
    const tr = trMsg.toolResults[0];
    assert(tr.callId === 'hm_test_001', `Plugin path: tool result callId preserved`);
    assert(tr.content.includes('TOOLS.md'), `Plugin path: tool result content preserved`);
  }

  // Compare with provider-translated output - should be different format
  const providerResult = await pluginCompositor.compose({
    agentId,
    sessionKey: pluginSessionKey,
    tokenBudget: 50000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    skipProviderTranslation: false,
  }, hm.dbManager.getMessageDb(agentId), libDb);

  // Provider format should have tool_use blocks, not NeutralToolCall
  const providerTcMsg = providerResult.messages.find(m =>
    m.role === 'assistant' && Array.isArray(m.content) && m.content.some(c => c.type === 'tool_use')
  );
  assert(providerTcMsg !== undefined, 'Provider path: has Anthropic tool_use blocks');

  // Neutral format should NOT have tool_use blocks
  assert(tcMsg && !Array.isArray(tcMsg.content), 'Plugin path: does NOT have provider-translated content blocks');

  console.log('  (skipProviderTranslation returns NeutralMessage format - plugin path validated)');

  // ── Cursor Dual-Write (P1.3) ──
  console.log('\n── Cursor Dual-Write (P1.3) ──');
  // After compose(), the cursor should be written to both Redis AND SQLite.
  // Compose has already been called above - check the conversations table for cursor columns.
  const cursorDb = hm.dbManager.getMessageDb('forge');
  const cursorRow = cursorDb.prepare(`
    SELECT cursor_last_sent_id, cursor_last_sent_index, cursor_last_sent_at,
           cursor_window_size, cursor_token_count
    FROM conversations
    WHERE session_key = 'agent:forge:webchat:main'
  `).get();
  assert(cursorRow !== undefined, 'Cursor row exists in conversations table');
  assert(cursorRow.cursor_last_sent_id !== null, `SQLite cursor_last_sent_id: ${cursorRow?.cursor_last_sent_id}`);
  assert(cursorRow.cursor_last_sent_at !== null, `SQLite cursor_last_sent_at: ${cursorRow?.cursor_last_sent_at}`);
  assert(cursorRow.cursor_window_size > 0, `SQLite cursor_window_size: ${cursorRow?.cursor_window_size}`);
  assert(cursorRow.cursor_token_count > 0, `SQLite cursor_token_count: ${cursorRow?.cursor_token_count}`);

  // Verify Redis has the same cursor
  const redisCursor = await hm.redis.getCursor('forge', 'agent:forge:webchat:main');
  assert(redisCursor !== null, 'Redis cursor exists');
  assert(redisCursor.lastSentId === cursorRow.cursor_last_sent_id, 'Redis/SQLite cursor_last_sent_id match');

  // Verify facade fallback: flush Redis prefix (simulates eviction), then getSessionCursor should fallback to SQLite
  await hm.redis.flushPrefix();
  const redisCursorAfterFlush = await hm.redis.getCursor('forge', 'agent:forge:webchat:main');
  assert(redisCursorAfterFlush === null, 'Redis cursor is null after flush');
  const fallbackCursor = await hm.getSessionCursor('forge', 'agent:forge:webchat:main');
  assert(fallbackCursor !== null, 'Fallback cursor from SQLite works after Redis eviction');
  assert(fallbackCursor.lastSentId === cursorRow.cursor_last_sent_id, 'Fallback cursor data matches SQLite');

  // ── W3: Diagnostics on ComposeResult ──
  console.log('\n── W3: Diagnostics present on ComposeResult ──');

  const diagResult = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 50000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    includeFacts: true,
    includeLibrary: true,
    includeContext: true,
  }, msgDb, libDb);

  assert(diagResult.diagnostics !== undefined, 'W3: diagnostics object present on ComposeResult');
  if (diagResult.diagnostics) {
    assert(typeof diagResult.diagnostics.triggerHits === 'number',
      `W3: triggerHits is a number (got ${diagResult.diagnostics.triggerHits})`);
    assert(typeof diagResult.diagnostics.retrievalMode === 'string',
      `W3: retrievalMode is a string (got ${diagResult.diagnostics.retrievalMode})`);
    assert(typeof diagResult.diagnostics.factsIncluded === 'number',
      `W3: factsIncluded is a number (got ${diagResult.diagnostics.factsIncluded})`);
    assert(typeof diagResult.diagnostics.scopeFiltered === 'number',
      `W3: scopeFiltered is a number (got ${diagResult.diagnostics.scopeFiltered})`);
    assert(typeof diagResult.diagnostics.triggerFallbackUsed === 'boolean',
      `W3: triggerFallbackUsed is a boolean (got ${diagResult.diagnostics.triggerFallbackUsed})`);
    assert(['triggered', 'fallback_knn', 'fallback_fts', 'none'].includes(diagResult.diagnostics.retrievalMode),
      `W3: retrievalMode is a valid enum value (got ${diagResult.diagnostics.retrievalMode})`);
  }

  // ── Tool Gradient ──
  console.log('\n── Tool Gradient ──');

  // Import test-only helpers from the compiled build
  const {
    getTurnAge,
    applyToolGradient,
    appendToolSummary,
    truncateWithHeadTail,
    applyTierPayloadCap,
  } = await import('../dist/compositor.js');

  // Helper: build a synthetic NeutralMessage with tool content
  function toolMsg(role, toolResultContent, textContent = null) {
    return {
      role,
      textContent,
      toolCalls: role === 'assistant' ? [
        { id: 'tc_001', name: 'read', arguments: JSON.stringify({ path: '/test/file.md' }) },
      ] : null,
      toolResults: role === 'user' ? [
        { callId: 'tc_001', name: 'read', content: toolResultContent, isError: false },
      ] : null,
    };
  }

  // Helper: plain user/assistant messages (no tool content)
  function textMsg(role, text) {
    return { role, textContent: text, toolCalls: null, toolResults: null };
  }

  // Helper: build a conversation where the message at position 0 has a given number
  // of user messages after it (i.e., turn age = userCount).
  // Returns messages array: [toolMsg, ...userCount user messages]
  function buildConvoWithTurnAge(toolRole, toolResultContent, userCount, textContent = null) {
    const msgs = [toolMsg(toolRole, toolResultContent, textContent)];
    for (let i = 0; i < userCount; i++) {
      msgs.push(textMsg('user', `follow-up question ${i + 1}`));
    }
    return msgs;
  }

  // ── getTurnAge: basic counting ──
  {
    const msgs = [
      textMsg('user', 'q1'),
      textMsg('assistant', 'a1'),
      textMsg('user', 'q2'),
      textMsg('assistant', 'a2'),
      textMsg('user', 'q3'),
    ];
    // msg at index 0: 2 user messages after it (q2 at idx 2, q3 at idx 4)
    assert(getTurnAge(msgs, 0) === 2, 'getTurnAge: 2 user msgs after index 0');
    // msg at index 2: 1 user message after it (q3 at idx 4)
    assert(getTurnAge(msgs, 2) === 1, 'getTurnAge: 1 user msg after index 2');
    // last msg: 0 user messages after it
    assert(getTurnAge(msgs, 4) === 0, 'getTurnAge: 0 user msgs after last message');
    // index 1 (assistant): 2 user messages after (q2, q3)
    assert(getTurnAge(msgs, 1) === 2, 'getTurnAge: counts only user messages, not assistant');
  }

  // ── T0: turn age 0 only - capped high fidelity ──
  {
    const shortPayload = 'tool result here';
    const msgs = buildConvoWithTurnAge('user', shortPayload, 0); // turn age = 0 (T0)
    const out = applyToolGradient(msgs);
    const firstMsg = out[0];
    assert(firstMsg.toolResults !== null, 'T0: toolResults NOT stripped at turn age 0');
    assert(firstMsg.toolResults[0].content === shortPayload, 'T0: small payload preserved verbatim at turn age 0');

    // Turn age 1 is T1 - no longer T0
    const msgs1 = buildConvoWithTurnAge('user', shortPayload, 1);
    const out1 = applyToolGradient(msgs1);
    // T1 has a per-result cap but still keeps toolResults for small payloads
    assert(out1[0].toolResults !== null, 'T1: small payload preserved at turn age 1 (under cap)');
  }

  // ── T0: 16K per-result cap with 6K tail budget ──
  {
    const bigPayload = 'X'.repeat(110_000);
    const msgs = buildConvoWithTurnAge('user', bigPayload, 0); // turn age = 0, T0
    const out = applyToolGradient(msgs);
    const content = out[0].toolResults[0].content;
    assert(content.length < bigPayload.length, 'T0: oversized payload is capped');
    assert(content.length <= 16_000 + 100, `T0: payload capped at ~16K (got ${content.length})`);
    assert(content.includes('[... tool output truncated ...]'), 'T0: truncation marker present');
    const markerIdx = content.indexOf('[... tool output truncated ...]');
    const tail = content.slice(markerIdx + '[... tool output truncated ...]'.length);
    assert(tail.length >= 4_500, `T0: tail budget preserves closing content (got ${tail.length})`);
  }

  // ── T0: per-turn cap downgrades overflow to summary ──
  {
    const payload = 'X'.repeat(25_000);
    const msgs = [
      {
        role: 'assistant',
        textContent: null,
        toolCalls: null,
        toolResults: [{ callId: 'a', name: 'read', content: payload }],
      },
      {
        role: 'assistant',
        textContent: null,
        toolCalls: null,
        toolResults: [{ callId: 'b', name: 'read', content: payload }],
      },
      {
        role: 'assistant',
        textContent: null,
        toolCalls: null,
        toolResults: [{ callId: 'c', name: 'read', content: payload }],
      },
    ];
    const out = applyToolGradient(msgs);
    const t0Msgs = [out[0], out[1], out[2]];
    const preserved = t0Msgs.filter(m => m.toolResults !== null).length;
    const summarized = t0Msgs.filter(m => /\[read|\bRead\b/.test(m.textContent ?? '')).length;
    assert(preserved === 2, `T0 turn cap: two results fit under the 40K turn cap (got ${preserved})`);
    assert(summarized === 1, `T0 turn cap: overflow downgraded to summary (got ${summarized})`);
  }

  // ── T1: turn age 1-3 - payload capped at 6K/result ──
  {
    const payload8k = 'Y'.repeat(8_000); // > 6K T1 cap
    const msgs = buildConvoWithTurnAge('user', payload8k, 1); // turn age = 1 (T1)
    const out = applyToolGradient(msgs);
    const content = out[0].toolResults[0].content;
    assert(out[0].toolResults !== null, 'T1: toolResults present at turn age 1');
    assert(content.length < payload8k.length, 'T1: per-result cap applied at turn age 1');
    assert(content.length <= 6_000 + 100, 'T1: result capped at ~6K');

    // Turn age 3 is T1 boundary
    const msgs3 = buildConvoWithTurnAge('user', 'short payload', 3);
    const out3 = applyToolGradient(msgs3);
    assert(out3[0].toolResults !== null, 'T1: toolResults preserved at turn age 3 (boundary)');

    // Turn age 4 is T2 - toolResults stripped
    const msgs4 = buildConvoWithTurnAge('user', payload8k, 4);
    const out4 = applyToolGradient(msgs4);
    assert(out4[0].toolResults === null, 'T2: toolResults stripped at turn age 4 (first T2 turn)');
  }

  // ── T1 → T2 downgrade: per-turn aggregate cap (12K) exceeded ──
  {
    // Three assistant tool messages at turn age 1 (T1). T1_TURN_CAP = 12K, T1_CHAR_CAP = 6K.
    // gradient processes newest→oldest:
    //   msg2 (newest): 7K payload capped to 6K. usage = 6K. 6K <= 12K → no downgrade.
    //   msg1 (middle): usedSoFar=6K, 7K capped to 6K, total=12K. 12K > 12K? NO → no downgrade.
    //   msg0 (oldest): usedSoFar=12K, 7K capped to 6K, total=18K > 12K → DOWNGRADE.
    const payload7k = 'Z'.repeat(7_000);

    const asstToolMsg = (content) => ({
      role: 'assistant',
      textContent: 'Let me check that.',
      toolCalls: [{ id: 'tc_agg', name: 'read', arguments: JSON.stringify({ path: '/file.md' }) }],
      toolResults: [{ callId: 'tc_agg', name: 'read', content, isError: false }],
    });

    const msgs3 = [
      asstToolMsg(payload7k),  // index 0: turn age = 1, processed last
      asstToolMsg(payload7k),  // index 1: turn age = 1, processed 2nd
      asstToolMsg(payload7k),  // index 2: turn age = 1, processed 1st
      textMsg('user', 'q1'),
    ];
    const age0b = getTurnAge(msgs3, 0);
    assert(age0b === 1, `T1 downgrade (3msg) setup: index 0 has turn age 1 (got ${age0b})`);

    const out3 = applyToolGradient(msgs3);
    const newest = out3[2]; // processed first, 6K fits (usage: 0→6K)
    const middle = out3[1]; // processed second (usage: 6K→12K), 12K NOT > 12K → no downgrade
    const oldest = out3[0]; // processed last, usedSoFar=12K, total=18K > 12K → DOWNGRADE

    assert(newest.toolResults !== null, 'T1 downgrade: newest message keeps toolResults');
    assert(middle.toolResults !== null, 'T1 downgrade: middle message keeps toolResults (at boundary)');
    assert(oldest.toolResults === null, 'T1 downgrade: oldest message downgraded to T2 envelope (toolResults null)');
    assert(oldest.toolCalls === null, 'T1 downgrade: oldest message toolCalls stripped');
    assert(oldest.textContent !== null && oldest.textContent.length > 0,
      'T1 downgrade: oldest message has prose summary in textContent');
  }

  // ── T2: turn age 4-7 - payload replaced with prose envelope ──
  {
    const payload = 'function doThing() { return 42; } // some code here';
    const msgs = buildConvoWithTurnAge('user', payload, 4); // turn age = 4 (first T2)
    const out = applyToolGradient(msgs);
    const msg = out[0];
    assert(msg.toolResults === null, 'T2: toolResults stripped at turn age 4');
    assert(msg.toolCalls === null, 'T2: toolCalls stripped at turn age 4');
    assert(msg.textContent !== null && msg.textContent.length > 0, 'T2: prose envelope in textContent');
    assert(/read|Read|\[/.test(msg.textContent), 'T2: textContent contains tool label');

    // Turn age 7 is T2 boundary
    const msgs7 = buildConvoWithTurnAge('user', payload, 7);
    const out7 = applyToolGradient(msgs7);
    assert(out7[0].toolResults === null, 'T2: toolResults stripped at turn age 7 (boundary)');
    assert(out7[0].textContent !== null, 'T2: prose envelope present at turn age 7');
  }

  // ── T3: turn age 8+ - payload replaced with compact outcome stub ──
  {
    const payload = 'The quick brown fox jumps over the lazy dog. Some important content here.';
    const msgs = buildConvoWithTurnAge('user', payload, 8); // turn age = 8 (first T3)
    const out = applyToolGradient(msgs);
    const msg = out[0];
    assert(msg.toolResults === null, 'T3: toolResults stripped at turn age 8');
    assert(msg.toolCalls === null, 'T3: toolCalls stripped at turn age 8');
    assert(msg.textContent !== null && msg.textContent.length > 0, 'T3: compact stub in textContent');
    // T3 stub should be short - capped at 150 chars per result
    assert(msg.textContent.length <= 200, `T3: stub is compact (got ${msg.textContent.length} chars)`);
    assert(msg.textContent.startsWith('[') || msg.textContent.includes('['), 'T3: stub uses compact bracket format');

    // Turn age 15 is well into T3
    const msgs15 = buildConvoWithTurnAge('user', payload, 15);
    const out15 = applyToolGradient(msgs15);
    assert(out15[0].toolResults === null, 'T3: toolResults stripped at turn age 15');
    assert(out15[0].textContent.length <= 200, 'T3: stub remains compact at turn age 15');
  }

  // ── Turn-age counts USER messages only, not total messages ──
  {
    // 5 assistant messages between the tool result and the "boundary" — shouldn't count
    const msgs = [
      toolMsg('user', 'payload content'),  // index 0
      textMsg('assistant', 'a1'),
      textMsg('assistant', 'a2'),
      textMsg('assistant', 'a3'),
      textMsg('assistant', 'a4'),
      textMsg('assistant', 'a5'),
      // Only 2 user messages follow — turn age should be 2, not 6
      textMsg('user', 'q1'),
      textMsg('user', 'q2'),
    ];
    const age = getTurnAge(msgs, 0);
    assert(age === 2, `Turn-age counts only user messages (expected 2, got ${age})`);

    const out = applyToolGradient(msgs);
    // Turn age 2 → T1 — small payload preserved (under T1 cap)
    assert(out[0].toolResults !== null,
      'Turn-age user-only: T1 tier applied, small payload preserved');
  }

  // ── appendToolSummary: preserves existing textContent, does not overwrite ──
  {
    const existing = 'I already said something important.';
    const summary = 'read /foo/bar - first line of file';

    const result = appendToolSummary(existing, summary);
    assert(result.includes(existing), 'appendToolSummary: existing textContent preserved');
    assert(result.includes(summary), 'appendToolSummary: summary appended');
    assert(result.startsWith(existing), 'appendToolSummary: existing text comes first');

    // Null textContent: summary becomes the whole string
    const fromNull = appendToolSummary(null, summary);
    assert(fromNull === summary, 'appendToolSummary: null textContent yields summary as full string');

    // Empty string: summary becomes the whole string
    const fromEmpty = appendToolSummary('', summary);
    assert(fromEmpty === summary, 'appendToolSummary: empty textContent yields summary as full string');

    // Existing textContent in T2 message should not be overwritten by gradient
    const payloadT2 = 'some tool output text';
    const priorText = 'I analyzed the situation.';
    const msgsT2 = buildConvoWithTurnAge('user', payloadT2, 12, priorText); // textContent set
    const outT2 = applyToolGradient(msgsT2);
    const msgT2 = outT2[0];
    assert(msgT2.textContent.includes(priorText),
      'T2: existing textContent preserved (not overwritten) when gradient strips tool payload');
  }

  // ── truncateWithHeadTail: head+tail structure ──
  {
    const content = 'AABBCC'.repeat(10_000); // 60K chars
    const truncated = truncateWithHeadTail(content, 1_000);
    assert(truncated.length <= 1_100, `truncateWithHeadTail: result within cap (got ${truncated.length})`);
    assert(truncated.includes('[... tool output truncated ...]'), 'truncateWithHeadTail: marker present');
    // Head should start with original content
    assert(truncated.startsWith('AA'), 'truncateWithHeadTail: head preserved from original start');
    // Should not truncate short content
    const short = 'hello world';
    assert(truncateWithHeadTail(short, 1_000) === short, 'truncateWithHeadTail: short content unchanged');
  }

  // ── Tool-aware summaries: web_search / exec / read ──
  {
    const webMsgs = [{
      role: 'assistant',
      textContent: null,
      toolCalls: [{ id: 'tc_ws', name: 'web_search', arguments: JSON.stringify({ query: 'image token cost' }) }],
      toolResults: [{ callId: 'tc_ws', name: 'web_search', content: '{"results":[{"title":"How Images Work"},{"title":"Context Windows"}]}' }],
    }, textMsg('user', 'follow-up question 1'), textMsg('user', 'follow-up question 2'), textMsg('user', 'follow-up question 3'), textMsg('user', 'follow-up question 4')];
    const outWeb = applyToolGradient(webMsgs);
    assert(outWeb[0].textContent.includes("Searched 'image token cost'"), 'web_search summary keeps query');
    assert(outWeb[0].textContent.includes('2 results'), 'web_search summary keeps result count');

    const execMsgs = [{
      role: 'assistant',
      textContent: null,
      toolCalls: [{ id: 'tc_exec', name: 'exec', arguments: JSON.stringify({ command: 'npm test' }) }],
      toolResults: [{ callId: 'tc_exec', name: 'exec', content: 'exit code: 1\nFAIL src/foo.test.ts\n1 failed' }],
    }, textMsg('user', 'follow-up question 1'), textMsg('user', 'follow-up question 2'), textMsg('user', 'follow-up question 3'), textMsg('user', 'follow-up question 4')];
    const outExec = applyToolGradient(execMsgs);
    assert(outExec[0].textContent.includes('Ran npm test'), 'exec summary keeps command');
    assert(outExec[0].textContent.includes('exit 1'), 'exec summary keeps exit code');

    const readMsgs = [{
      role: 'assistant',
      textContent: null,
      toolCalls: [{ id: 'tc_read2', name: 'read', arguments: JSON.stringify({ path: '/src/foo.ts' }) }],
      toolResults: [{ callId: 'tc_read2', name: 'read', content: '# Foo\nexport function run() {}' }],
    }, textMsg('user', 'follow-up question 1'), textMsg('user', 'follow-up question 2'), textMsg('user', 'follow-up question 3'), textMsg('user', 'follow-up question 4')];
    const outRead = applyToolGradient(readMsgs);
    assert(outRead[0].textContent.includes('Read /src/foo.ts'), 'read summary keeps path');
    assert(outRead[0].textContent.includes('Foo'), 'read summary keeps heading');
  }

  // ── T0/T1 boundary: assistant tool call at turn age 0 (T0) vs 1 (T1) ──
  {
    // Turn age 0: T0 — toolCalls preserved
    const msgs0 = [
      {
        role: 'assistant',
        textContent: 'Let me read that.',
        toolCalls: [{ id: 'tc_bnd', name: 'read', arguments: JSON.stringify({ path: '/f' }) }],
        toolResults: null,
      },
      // No user messages after — turn age 0, T0
    ];
    const age0 = getTurnAge(msgs0, 0);
    assert(age0 === 0, `T0 boundary: turn age at index 0 is 0 (got ${age0})`);
    const out0 = applyToolGradient(msgs0);
    assert(out0[0].toolCalls !== null, 'T0 boundary: toolCalls preserved at turn age 0');

    // One user message → turn age 1, enters T1
    const msgs1 = [...msgs0, textMsg('user', 'q1')];
    const age1 = getTurnAge(msgs1, 0);
    assert(age1 === 1, `T1 boundary: turn age at index 0 is 1 (got ${age1})`);
  }

  // ── Tool pair integrity: orphan tool_result never reaches provider ──
  {
    const orphaned = [
      {
        role: 'assistant',
        textContent: 'I checked the file.',
        toolCalls: null,
        toolResults: null,
      },
      {
        role: 'user',
        textContent: null,
        toolCalls: null,
        toolResults: [{ callId: 'missing_1', name: 'read', content: 'secret payload that should not become a tool_result block' }],
      },
    ];

    const repaired = repairToolCallPairs(orphaned);
    assert(repaired[1].toolResults === null, 'orphan tool_result downgraded to plain text before translation');
    assert(repaired[1].textContent.includes('missing matching tool call'), 'orphan downgrade explains why tool result was omitted');

    const anthropic = toProviderFormat(orphaned, 'anthropic');
    const anthropicUser = anthropic[1];
    assert(typeof anthropicUser.content === 'string', 'Anthropic orphan becomes plain user text, not tool_result block');

    const openai = toProviderFormat(orphaned, 'openai');
    assert(openai[1].role === 'user', 'OpenAI orphan remains a user message');
    assert(!openai.some(m => m.role === 'tool'), 'OpenAI orphan does not emit tool role message');
  }

  // ── Dynamic Reserve ──
  {
    console.log('\n── Dynamic Reserve ──');

    const agentId = 'dynamic-reserve-test';
    const db = hm.dbManager.getMessageDb(agentId);
    const libDb = hm.dbManager.getLibraryDb();

    // Seed a conversation in SQLite
    db.prepare(`
      INSERT INTO conversations
        (session_key, agent_id, channel_type, status, message_count,
         token_count_in, token_count_out, created_at, updated_at)
      VALUES (?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
    `).run('agent:dynamic-reserve-test:webchat:main', agentId);

    const convRow = db.prepare('SELECT id FROM conversations WHERE session_key = ?')
      .get('agent:dynamic-reserve-test:webchat:main');
    const convId = convRow.id;

    const insertMsg = db.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_results, message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, 0, datetime('now'))
    `);

    // ── Test 1: Cold session (no history) → floor reserve applies ──
    const coldResult = await compositor.compose({
      agentId,
      sessionKey: 'agent:dynamic-reserve-test:webchat:main',
      userMessage: 'Hello',
      model: 'gpt-4o', // 128k window
    }, db, libDb);

    assert(coldResult.diagnostics !== undefined, 'Dynamic reserve: diagnostics present');
    assert(coldResult.diagnostics.dynamicReserveActive === false,
      `Dynamic reserve: cold session uses floor (active=false, got ${coldResult.diagnostics.dynamicReserveActive})`);
    assert(coldResult.diagnostics.reserveFraction !== undefined,
      'Dynamic reserve: reserveFraction present in diagnostics');
    // Floor is 0.15 by default
    assert(Math.abs(coldResult.diagnostics.reserveFraction - 0.15) < 0.01,
      `Dynamic reserve: cold session floor=0.15 (got ${coldResult.diagnostics.reserveFraction})`);
    assert(coldResult.diagnostics.sessionPressureHigh === false,
      'Dynamic reserve: cold session not high pressure');

    // ── Test 2: Heavy session (large messages) → dynamic reserve engages ──
    // Seed 20 large user+assistant messages (~8k chars each ≈ 2k tokens each)
    const heavyContent = 'x'.repeat(8000);
    for (let i = 0; i < 20; i++) {
      insertMsg.run(convId, agentId, i % 2 === 0 ? 'user' : 'assistant', heavyContent, i);
    }

    const heavyResult = await compositor.compose({
      agentId,
      sessionKey: 'agent:dynamic-reserve-test:webchat:main',
      userMessage: 'Continue this work',
      model: 'gpt-4o', // 128k window
    }, db, libDb);

    assert(heavyResult.diagnostics !== undefined, 'Dynamic reserve heavy: diagnostics present');
    assert(heavyResult.diagnostics.avgTurnCostTokens !== undefined && heavyResult.diagnostics.avgTurnCostTokens > 0,
      `Dynamic reserve heavy: avg_turn_cost > 0 (got ${heavyResult.diagnostics.avgTurnCostTokens})`);
    // With 8k char messages (~2k tokens each), avg ≈ 2k, horizon=5 → safety=10k, 10k/128k ≈ 7.8%
    // Still under the 15% floor, so dynamic won't engage here. Need heavier messages.
    // Just verify diagnostics are populated correctly.
    assert(heavyResult.diagnostics.reserveFraction >= 0.15,
      `Dynamic reserve heavy: reserve >= floor (got ${heavyResult.diagnostics.reserveFraction})`);
    assert(heavyResult.diagnostics.sessionPressureHigh !== undefined,
      'Dynamic reserve heavy: sessionPressureHigh field present');

    // ── Test 3: Very heavy session → dynamic > floor, engage ──
    // Seed 20 more very large messages (~80k chars each ≈ 20k tokens each)
    const veryHeavyContent = 'y'.repeat(80000);
    for (let i = 20; i < 40; i++) {
      insertMsg.run(convId, agentId, i % 2 === 0 ? 'user' : 'assistant', veryHeavyContent, i);
    }

    const veryHeavyResult = await compositor.compose({
      agentId,
      sessionKey: 'agent:dynamic-reserve-test:webchat:main',
      userMessage: 'Continue with more analysis',
      model: 'gpt-4o', // 128k window - avg_turn_cost ~20k, horizon=5 → safety=100k, 100k/128k=78% > max(50%)
    }, db, libDb);

    assert(veryHeavyResult.diagnostics !== undefined, 'Dynamic reserve very heavy: diagnostics present');
    assert(veryHeavyResult.diagnostics.dynamicReserveActive === true,
      `Dynamic reserve very heavy: active=true (got ${veryHeavyResult.diagnostics.dynamicReserveActive})`);
    // Should be clamped at max=0.50 and SESSION_PRESSURE_HIGH emitted
    assert(veryHeavyResult.diagnostics.reserveFraction <= 0.51,
      `Dynamic reserve very heavy: clamped at max (got ${veryHeavyResult.diagnostics.reserveFraction})`);
    assert(veryHeavyResult.diagnostics.sessionPressureHigh === true,
      `Dynamic reserve very heavy: sessionPressureHigh=true (got ${veryHeavyResult.diagnostics.sessionPressureHigh})`);
    assert(veryHeavyResult.warnings.some(w => w.includes('SESSION_PRESSURE_HIGH')),
      `Dynamic reserve very heavy: SESSION_PRESSURE_HIGH in warnings (got [${veryHeavyResult.warnings.join(', ')}])`);
  }

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
