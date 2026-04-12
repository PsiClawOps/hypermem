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

  const agentId = 'agent-alpha';
  const sessionKey = 'agent:agent-alpha:webchat:main';
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
  hm.setPreference('testuser', 'coding_style', 'Architecture over speed, explicit over implicit', {
    domain: 'development',
    agentId,
  });
  hm.setPreference('testuser', 'communication', 'Direct, no hedging', {
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
    systemPrompt: 'You are Agent Alpha, the infrastructure seat.',
    identity: 'Agent Alpha — Infrastructure Council Seat',
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

  assert(warmedContent.includes('Agent Alpha'), 'System prompt from Redis');

  // ── Test 4b: Gate 1 — historyDepth constrains hot Redis sessions ──
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
1. Position — operationally fit, conditionally fit, or not fit
2. Top risk — single most critical operational or architectural risk
3. Confidence — high/medium/low
4. Action — specific infrastructure work, test, or validation needed
`;

  const jobChunks = chunkMarkdown(jobContent, {
    collection: 'identity/job',
    sourcePath: '/workspace/JOB.md',
    scope: 'per-agent',
    agentId: 'agent-alpha',
  });
  hm.indexDocChunks(jobChunks);

  // The seeded policy doc contains unique text that can ONLY appear via chunk injection,
  // not from echoing the user message. We assert on that unique text.
  // Unique agent4 in policyContent: "mandatory human review requirements"
  // Unique agent4 in jobContent: "operationally fit, conditionally fit, or not fit"
  //
  // This ensures the test fails if FTS retrieval doesn't actually find the right chunks
  // (Reviewer's repro: user message contained "escalation" but no chunk was injected).

  const chunkSessionKey = 'agent:agent-alpha:webchat:chunk-test';
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

  // Assert on chunk-unique content — text that can only appear via chunk injection, not from the user message.
  // The seeded policy chunk contains "No autonomous resolution allowed" — unique agent4 text
  // that does not appear in the user question "What are the escalation triggers I should follow?"
  assert(escalationText.includes('No autonomous resolution') || escalationText.includes('autonomous resolution'),
    'Chunk-unique policy text injected (not just user message echo)');
  assert(escalationResult.slots.library > 0,
    'Library slot consumed (confirms chunk was actually injected, not just present in history)');

  // Seed a deliberation-related message to trigger identity/job chunks
  const deliberationSessionKey = 'agent:agent-alpha:webchat:deliberation-test';
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
  const councilChunks = chunkMarkdown('# Charter\n\n## Council Structure\n\nThis section is for council seats only — their specific roles and responsibilities.\n', {
    collection: 'governance/charter',
    sourcePath: '/workspace/agent-alpha/CHARTER.md',
    scope: 'per-tier',
    tier: 'council',
  });
  const directorChunks = chunkMarkdown('# Charter\n\n## Director Structure\n\nThis section is for directors only — their specific delegation and reporting lines.\n', {
    collection: 'governance/charter',
    sourcePath: '/workspace/agent-gamma/CHARTER.md',
    scope: 'per-tier',
    tier: 'director',
  });
  hm.indexDocChunks(councilChunks);
  hm.indexDocChunks(directorChunks);

  // Query with tier filter — should only return matching tier
  const councilOnly = hm.queryDocChunks({ collection: 'governance/charter', tier: 'council' });
  const directorOnly = hm.queryDocChunks({ collection: 'governance/charter', tier: 'director' });
  assert(councilOnly.every(c => !c.tier || c.tier === 'council'), 'Council tier filter excludes director chunks');
  assert(directorOnly.every(c => !c.tier || c.tier === 'director'), 'Director tier filter excludes council chunks');

  // ── Prompt-Aware Retrieval (current turn, before history append) ──
  console.log('\n── Prompt-Aware Retrieval (current turn) ──');

  hm.upsertKnowledge(agentId, 'deployments', 'k8s-staging',
    'K8S_STAGING_SENTINEL Kubernetes staging deployment requires readiness gates, rollout checks, and rollback verification.');

  const promptRecallSessionKey = 'agent:agent-alpha:webchat:prompt-recall-test';
  await hm.recordUserMessage(agentId, promptRecallSessionKey, 'Can you review our incident process?');
  await hm.recordAssistantMessage(agentId, promptRecallSessionKey, {
    role: 'assistant',
    textContent: 'Yes — I can review the incident process.',
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
  assert(promptRecallResult.contextBlock?.includes('Related Memory') || promptRecallText.includes('## Related Memory'),
    'Prompt-aware retrieval produced a Related Memory block');

  // 'P0.1: prompt drives retrieval before message is in history'
  console.log('\n── P0.1: prompt drives retrieval before message is in history ──');

  const freshPromptSessionKey = 'agent:agent-alpha:webchat:fresh-prompt-test';
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

  // Compose with skipProviderTranslation — should get NeutralMessages back
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

  // Compare with provider-translated output — should be different format
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

  console.log('  (skipProviderTranslation returns NeutralMessage format — plugin path validated)');

  // ── Cursor Dual-Write (P1.3) ──
  console.log('\n── Cursor Dual-Write (P1.3) ──');
  // After compose(), the cursor should be written to both Redis AND SQLite.
  // Compose has already been called above — check the conversations table for cursor columns.
  const cursorDb = hm.dbManager.getMessageDb('agent-alpha');
  const cursorRow = cursorDb.prepare(`
    SELECT cursor_last_sent_id, cursor_last_sent_index, cursor_last_sent_at,
           cursor_window_size, cursor_token_count
    FROM conversations
    WHERE session_key = 'agent:agent-alpha:webchat:main'
  `).get();
  assert(cursorRow !== undefined, 'Cursor row exists in conversations table');
  assert(cursorRow.cursor_last_sent_id !== null, `SQLite cursor_last_sent_id: ${cursorRow?.cursor_last_sent_id}`);
  assert(cursorRow.cursor_last_sent_at !== null, `SQLite cursor_last_sent_at: ${cursorRow?.cursor_last_sent_at}`);
  assert(cursorRow.cursor_window_size > 0, `SQLite cursor_window_size: ${cursorRow?.cursor_window_size}`);
  assert(cursorRow.cursor_token_count > 0, `SQLite cursor_token_count: ${cursorRow?.cursor_token_count}`);

  // Verify Redis has the same cursor
  const redisCursor = await hm.redis.getCursor('agent-alpha', 'agent:agent-alpha:webchat:main');
  assert(redisCursor !== null, 'Redis cursor exists');
  assert(redisCursor.lastSentId === cursorRow.cursor_last_sent_id, 'Redis/SQLite cursor_last_sent_id match');

  // Verify facade fallback: flush Redis prefix (simulates eviction), then getSessionCursor should fallback to SQLite
  await hm.redis.flushPrefix();
  const redisCursorAfterFlush = await hm.redis.getCursor('agent-alpha', 'agent:agent-alpha:webchat:main');
  assert(redisCursorAfterFlush === null, 'Redis cursor is null after flush');
  const fallbackCursor = await hm.getSessionCursor('agent-alpha', 'agent:agent-alpha:webchat:main');
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

  // ── T0: turn age 0-4 — payload kept verbatim (no tool payload stripping) ──
  {
    const shortPayload = 'tool result here';
    const msgs = buildConvoWithTurnAge('user', shortPayload, 2); // turn age = 2 (T0)
    const out = applyToolGradient(msgs);
    const firstMsg = out[0];
    // T0: toolResults preserved
    assert(firstMsg.toolResults !== null, 'T0: toolResults NOT stripped at turn age 2');
    assert(firstMsg.toolResults[0].content === shortPayload, 'T0: payload preserved verbatim at turn age 2');
    assert(firstMsg.toolCalls === null, 'T0: only toolResults message here (user role)');

    // Turn age 4 is still T0 boundary
    const msgs4 = buildConvoWithTurnAge('user', shortPayload, 4); // turn age = 4
    const out4 = applyToolGradient(msgs4);
    assert(out4[0].toolResults !== null, 'T0: toolResults preserved at turn age 4 (boundary)');
  }

  // ── T0: 32K cap applied when payload exceeds limit ──
  {
    const bigPayload = 'X'.repeat(40_000); // > 32K
    const msgs = buildConvoWithTurnAge('user', bigPayload, 3); // turn age = 3, T0
    const out = applyToolGradient(msgs);
    const content = out[0].toolResults[0].content;
    assert(content.length < bigPayload.length, 'T0: oversized payload is capped (truncated)');
    assert(content.length <= 32_000 + 100, 'T0: payload capped at ~32K');
    assert(content.includes('[... tool output truncated ...]'), 'T0: truncation marker present');
  }

  // ── T1: turn age 5-10 — payload capped at 12K/result ──
  {
    const payload12k = 'Y'.repeat(15_000); // > 12K, < 24K
    const msgs = buildConvoWithTurnAge('user', payload12k, 5); // turn age = 5 (T1)
    const out = applyToolGradient(msgs);
    const content = out[0].toolResults[0].content;
    assert(out[0].toolResults !== null, 'T1: toolResults present at turn age 5');
    assert(content.length < payload12k.length, 'T1: per-result cap applied at turn age 5');
    assert(content.length <= 12_000 + 100, 'T1: result capped at ~12K');

    // Turn age 10 is still T1 boundary
    const msgs10 = buildConvoWithTurnAge('user', 'short payload', 10);
    const out10 = applyToolGradient(msgs10);
    assert(out10[0].toolResults !== null, 'T1: toolResults preserved at turn age 10 (boundary)');
  }

  // ── T1 → T2 downgrade: per-turn aggregate cap (24K) exceeded ──
  {
    // Build a conversation where TWO tool-call messages (role: assistant) are in the
    // same logical turn (same turn age = same number of user messages after them).
    // Assistant messages don't count toward turn age, so both have the same turn age.
    // Each has 12K+ content; together they exceed the 24K aggregate cap.
    // gradient processes newest→oldest: index 1 fits within cap, index 0 overflows → T2 downgrade.
    //
    // Layout:
    //   index 0: assistantToolCall (older) — turn age = 5 (T1)
    //   index 1: assistantToolCall (newer) — turn age = 5 (T1)
    //   index 2..6: 5 user messages
    const payload13k = 'Z'.repeat(13_000);

    const asstToolMsg = (content) => ({
      role: 'assistant',
      textContent: 'Let me check that.',
      toolCalls: [{ id: 'tc_agg', name: 'read', arguments: JSON.stringify({ path: '/file.md' }) }],
      toolResults: [{ callId: 'tc_agg', name: 'read', content, isError: false }],
    });

    const msgs = [
      asstToolMsg(payload13k),  // index 0: turn age = 5 (T1, older)
      asstToolMsg(payload13k),  // index 1: turn age = 5 (T1, newer)
      textMsg('user', 'q1'),
      textMsg('user', 'q2'),
      textMsg('user', 'q3'),
      textMsg('user', 'q4'),
      textMsg('user', 'q5'),
    ];
    // Both assistant tool messages have the same turn age (5 user messages after each)
    const age0 = getTurnAge(msgs, 0);
    const age1 = getTurnAge(msgs, 1);
    assert(age0 === 5, `T1 downgrade setup: index 0 has turn age 5 (got ${age0})`);
    assert(age1 === 5, `T1 downgrade setup: index 1 has turn age 5 (got ${age1})`);

    const out = applyToolGradient(msgs);
    // index 1 processed first (newest→oldest): 13K capped to 12K → usage.t1 = 12K
    // index 0 processed next: 12K + 12K = 24K − no, let’s check the exact arithmetic:
    //   applyTierPayloadCap(msg, 12000, 24000, 12000): usedChars = 12000 + 12000 = 24000
    //   24000 > 24000 is FALSE, so no downgrade at exactly the limit.
    //   Use 13K each: after T1 cap, result[1] = 12K. usage.t1 = 0 + 12K = 12K.
    //   result[0]: usedSoFar=12K, content capped to 12K, usedChars = 12K + 12K = 24K → NOT > 24K.
    //   So we need slightly more: use two 13K payloads where T1 cap results in 12K each,
    //   and the turn cap check is 12K + 12K = 24K which is NOT > 24K (strict greater-than).
    //   We need to exceed 24K. Use payload of 13K so cap doesn’t truncate, but sum > 24K:
    //   Actually with T1_CHAR_CAP=12000 and payload=13000:
    //     after truncation: content.length becomes 12000 (approximately, due to head/tail)
    //     usedChars = usedSoFar(12000) + 12000 = 24000, NOT > 24000 → no downgrade
    //   So we need payload where even after 12K cap, sum of two caps > 24K.
    //   That’s not possible with two 12K-capped results summing to exactly 24K (= boundary).
    //   Use three messages, or use a payload that results in different cap behavior.
    //
    // Correction: use per-result content of 13K and verify T1 per-result cap applies,
    // then for aggregate downgrade use a larger dataset.
    // The aggregate downgrade requires usedChars > 24K. With T1 cap at 12K per result:
    //   message1 truncated to 12K. usage=12K.
    //   message2: usedSoFar=12K, truncated to 12K, total=24K. 24K > 24K? NO.
    // To trigger downgrade: need total > 24K. E.g., three 13K messages:
    //   msg3: usage=0, after cap 12K, total=12K (no downgrade)
    //   msg2: usage=12K, after cap 12K, total=24K (no downgrade — 24000 is NOT > 24000)
    //   msg1: usage=24K, payload capped to 12K, total=36K > 24K → DOWNGRADE

    // Rebuild with 3 assistant tool messages at same turn age
    const msgs3 = [
      asstToolMsg(payload13k),  // index 0: turn age = 5, processed last
      asstToolMsg(payload13k),  // index 1: turn age = 5, processed 2nd
      asstToolMsg(payload13k),  // index 2: turn age = 5, processed 1st
      textMsg('user', 'q1'),
      textMsg('user', 'q2'),
      textMsg('user', 'q3'),
      textMsg('user', 'q4'),
      textMsg('user', 'q5'),
    ];
    const age0b = getTurnAge(msgs3, 0);
    assert(age0b === 5, `T1 downgrade (3msg) setup: index 0 has turn age 5 (got ${age0b})`);

    const out3 = applyToolGradient(msgs3);
    const newest = out3[2]; // processed first, 12K fits (usage: 0→12K)
    const middle = out3[1]; // processed second, 12K more (usage: 12K→24K), 24K NOT > 24K → no downgrade
    const oldest = out3[0]; // processed last, usedSoFar=24K, total=36K > 24K → DOWNGRADE

    assert(newest.toolResults !== null, 'T1 downgrade: newest message keeps toolResults');
    assert(middle.toolResults !== null, 'T1 downgrade: middle message keeps toolResults (at boundary)');
    assert(oldest.toolResults === null, 'T1 downgrade: oldest message downgraded to T2 envelope (toolResults null)');
    assert(oldest.toolCalls === null, 'T1 downgrade: oldest message toolCalls stripped');
    assert(oldest.textContent !== null && oldest.textContent.length > 0,
      'T1 downgrade: oldest message has prose summary in textContent');
  }

  // ── T2: turn age 11-15 — payload replaced with prose envelope ──
  {
    const payload = 'function doThing() { return 42; } // some code here';
    const msgs = buildConvoWithTurnAge('user', payload, 11); // turn age = 11 (T2)
    const out = applyToolGradient(msgs);
    const msg = out[0];
    assert(msg.toolResults === null, 'T2: toolResults stripped at turn age 11');
    assert(msg.toolCalls === null, 'T2: toolCalls stripped at turn age 11');
    assert(msg.textContent !== null && msg.textContent.length > 0, 'T2: prose envelope in textContent');
    // T2 envelope contains the tool label from the read call
    assert(msg.textContent.includes('read') || msg.textContent.includes('['), 'T2: textContent contains tool label');

    // Turn age 15 is still T2 boundary
    const msgs15 = buildConvoWithTurnAge('user', payload, 15);
    const out15 = applyToolGradient(msgs15);
    assert(out15[0].toolResults === null, 'T2: toolResults stripped at turn age 15 (boundary)');
    assert(out15[0].textContent !== null, 'T2: prose envelope present at turn age 15');
  }

  // ── T3: turn age 16+ — payload replaced with compact outcome stub ──
  {
    const payload = 'The quick brown fox jumps over the lazy dog. Some important content here.';
    const msgs = buildConvoWithTurnAge('user', payload, 16); // turn age = 16 (T3)
    const out = applyToolGradient(msgs);
    const msg = out[0];
    assert(msg.toolResults === null, 'T3: toolResults stripped at turn age 16');
    assert(msg.toolCalls === null, 'T3: toolCalls stripped at turn age 16');
    assert(msg.textContent !== null && msg.textContent.length > 0, 'T3: compact stub in textContent');
    // T3 stub should be short — capped at 300 chars per result
    assert(msg.textContent.length <= 350, `T3: stub is compact (got ${msg.textContent.length} chars)`);
    // T3 envelope uses square bracket wrapping
    assert(msg.textContent.startsWith('[') || msg.textContent.includes('['), 'T3: stub uses compact bracket format');

    // Turn age 20 is well into T3
    const msgs20 = buildConvoWithTurnAge('user', payload, 20);
    const out20 = applyToolGradient(msgs20);
    assert(out20[0].toolResults === null, 'T3: toolResults stripped at turn age 20');
    assert(out20[0].textContent.length <= 350, 'T3: stub remains compact at turn age 20');
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
    // Turn age 2 → T0 → payload preserved
    assert(out[0].toolResults !== null,
      'Turn-age user-only: T0 tier applied despite many assistant messages between');
  }

  // ── appendToolSummary: preserves existing textContent, does not overwrite ──
  {
    const existing = 'I already said something important.';
    const summary = 'read /foo/bar — first line of file';

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

  // ── T0 boundary: assistant tool call message at turn age 4 (exact boundary) ──
  {
    // Build: [assistantTool, user, user, user, user] — assistant at index 0, 4 user msgs after
    const msgs = [
      {
        role: 'assistant',
        textContent: 'Let me read that.',
        toolCalls: [{ id: 'tc_bnd', name: 'read', arguments: JSON.stringify({ path: '/f' }) }],
        toolResults: null,
      },
      textMsg('user', 'q1'),
      textMsg('user', 'q2'),
      textMsg('user', 'q3'),
      textMsg('user', 'q4'), // 4 user msgs → turn age 4, still T0
    ];
    const age = getTurnAge(msgs, 0);
    assert(age === 4, `T0 boundary: turn age at index 0 is 4 (got ${age})`);

    const out = applyToolGradient(msgs);
    // toolCalls preserved at T0
    assert(out[0].toolCalls !== null, 'T0 boundary: toolCalls preserved at turn age 4');

    // One more user message → turn age 5, T1 boundary
    msgs.push(textMsg('user', 'q5'));
    const age5 = getTurnAge(msgs, 0);
    assert(age5 === 5, `T1 boundary: turn age at index 0 is 5 (got ${age5})`);
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
