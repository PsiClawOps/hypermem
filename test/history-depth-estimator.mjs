/**
 * HyperMem History Depth Estimator — Unit/Fixture Test (Phase A Sprint 4)
 *
 * Validates pre-compose history depth tightening:
 *
 *   Scenario 1 — Session classifier: tool-heavy vs plain-chat
 *   Scenario 2 — Density estimator: observed tokens/msg
 *   Scenario 3 — Adaptive depth: tool-heavy sessions get a tighter depth
 *   Scenario 4 — Adaptive depth: plain-chat sessions retain recall (>= historic min)
 *   Scenario 5 — Integration: Compositor diagnostics carry Sprint 4 fields
 *   Scenario 6 — Integration: Tool-heavy fixture does NOT trigger rescue trim after warm compose
 *   Scenario 7 — Integration: Plain-chat fixture retains >= historic default recall depth
 *
 * Notes:
 *   - Scenarios 1-4 test helpers directly from dist.
 *   - Scenarios 5-7 use Compositor directly with in-memory SQLite.
 *   - No Ollama, no Redis, no HyperMem factory required.
 *   - Imports from dist/ (compiled output) via build step.
 */

import { classifySessionType, estimateObservedMsgDensity, computeAdaptiveHistoryDepth, Compositor } from '../dist/compositor.js';
import { CacheLayer } from '../dist/cache.js';
import { migrateLibrary } from '../dist/library-schema.js';
import { migrate } from '../dist/schema.js';
import { MessageStore } from '../dist/message-store.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sprint4-'));

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMessageDb(label) {
  const dbPath = path.join(tmpDir, `msg-${label}-${Date.now()}.db`);
  const db = new DatabaseSync(dbPath);
  migrate(db);
  return db;
}

function makeLibraryDb(label) {
  const dbPath = path.join(tmpDir, `lib-${label}-${Date.now()}.db`);
  const db = new DatabaseSync(dbPath);
  migrateLibrary(db);
  return db;
}

/**
 * Build a plain NeutralMessage (no tools).
 */
function plainMsg(role, chars) {
  return {
    role,
    textContent: 'x'.repeat(chars),
    toolCalls: null,
    toolResults: null,
  };
}

/**
 * Build a NeutralMessage with tool content.
 */
function toolMsg(role, textChars, toolPayloadChars) {
  if (role === 'assistant') {
    return {
      role,
      textContent: 'x'.repeat(textChars),
      toolCalls: [{ id: 'tc-1', name: 'exec', arguments: JSON.stringify({ command: 'y'.repeat(toolPayloadChars) }) }],
      toolResults: null,
    };
  }
  return {
    role,
    textContent: null,
    toolCalls: null,
    toolResults: [{ callId: 'tc-1', name: 'exec', content: 'z'.repeat(toolPayloadChars) }],
  };
}

/**
 * Seed a conversation with messages into a SQLite messages DB.
 * Returns the conversation id.
 */
function seedConversation(db, agentId, sessionKey, msgs) {
  db.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s4-1', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const conv = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  const convId = conv.id;

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const toolCallsJson = m.toolCalls ? JSON.stringify(m.toolCalls) : null;
    const toolResultsJson = m.toolResults ? JSON.stringify(m.toolResults) : null;
    db.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results,
                            message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(convId, agentId, m.role, m.textContent, toolCallsJson, toolResultsJson, i + 1);
  }
  return convId;
}

// ════════════════════════════════════════════════════════════
// Scenario 1 — Session classifier
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 1: Session classifier ──');
{
  // All plain chat → plain-chat
  const plainHistory = [];
  for (let i = 0; i < 10; i++) {
    plainHistory.push(plainMsg('user', 400));
    plainHistory.push(plainMsg('assistant', 600));
  }
  assert(classifySessionType(plainHistory) === 'plain-chat', 'All-prose session classified as plain-chat');

  // Empty → plain-chat (cold session)
  assert(classifySessionType([]) === 'plain-chat', 'Empty session classified as plain-chat');

  // 5 user + 5 assistant (all prose) + 4 tool pairs (8 tool msgs) = 18 total, 8/18 ~= 44% tool → tool-heavy
  const toolHistory = [...plainHistory.slice(0, 10)]; // 5 user + 5 assistant
  for (let i = 0; i < 4; i++) {
    toolHistory.push(toolMsg('assistant', 100, 2000));
    toolHistory.push(toolMsg('user', 0, 500));
  }
  assert(classifySessionType(toolHistory) === 'tool-heavy', 'Session with >20% tool messages classified as tool-heavy');

  // 1 tool pair out of 20 messages = 2/20 = 10% → plain-chat (below 20% threshold)
  const lightToolHistory = [...plainHistory]; // 10 user + 10 asst = 20 msgs
  lightToolHistory.push(toolMsg('assistant', 100, 500));
  lightToolHistory.push(toolMsg('user', 0, 200));
  // 22 msgs, 2 tool msgs = 9% → plain-chat
  assert(classifySessionType(lightToolHistory) === 'plain-chat', 'Session with <20% tool messages classified as plain-chat');
}

// ════════════════════════════════════════════════════════════
// Scenario 2 — Density estimator
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 2: Density estimator ──');
{
  // 10 messages at ~100 tokens each (400 chars / 4 = 100 tokens, +4 overhead = 104)
  const msgs = [];
  for (let i = 0; i < 10; i++) {
    msgs.push(plainMsg('user', 400));
    msgs.push(plainMsg('assistant', 400));
  }
  const density = estimateObservedMsgDensity(msgs);
  // Each message: ceil(400/4) + 4 = 104 tokens
  assert(density >= 100 && density <= 120, `Plain density in expected range (got ${density})`);

  // Tool messages are denser (length/2 for payloads)
  const toolMsgs = [
    toolMsg('assistant', 100, 4000), // textContent 25tok + toolCalls ceil(4100chars/2)=2050 = 2079tok
    toolMsg('user', 0, 4000),        // toolResults ceil(4000chars/2)=2000 + 4 overhead = 2004tok
  ];
  const toolDensity = estimateObservedMsgDensity(toolMsgs);
  // Average of two dense messages should be > 1000 tokens
  assert(toolDensity > 1000, `Tool message density > 1000 tokens/msg (got ${toolDensity})`);

  // Empty sample → floor value (100)
  assert(estimateObservedMsgDensity([]) === 100, 'Empty sample returns density floor 100');
}

// ════════════════════════════════════════════════════════════
// Scenario 3 — Adaptive depth: tool-heavy gets tighter depth
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 3: Adaptive depth — tool-heavy tightening ──');
{
  // Simulate a tool-heavy session: dense messages at ~2000 tok/msg
  // historyBudget = 40000 tokens (historyFraction=0.4 × 100k budget)
  const historyBudget = 40_000;
  const maxHistory = 250;

  // plain-chat: 100 tok/msg → ~340 messages at 85% budget fill
  const plainDepth = computeAdaptiveHistoryDepth('plain-chat', 100, historyBudget, maxHistory);
  assert(plainDepth <= maxHistory, `Plain-chat depth bounded by maxHistoryMessages (got ${plainDepth})`);
  assert(plainDepth >= 20, `Plain-chat depth >= 20 messages (got ${plainDepth})`);

  // tool-heavy: 2000 tok/msg pre-gradient, 0.30 factor → 600 tok/msg post-gradient
  // 40000 * 0.85 / 600 ~= 56 messages
  const toolDepth = computeAdaptiveHistoryDepth('tool-heavy', 2000, historyBudget, maxHistory);
  assert(toolDepth < plainDepth, `Tool-heavy depth < plain-chat depth (tool=${toolDepth}, plain=${plainDepth})`);
  assert(toolDepth >= 15, `Tool-heavy depth >= 15 messages (got ${toolDepth})`);
  assert(toolDepth <= 80, `Tool-heavy depth <= 80 for dense sessions (got ${toolDepth})`);

  console.log(`    plain-chat adaptive depth = ${plainDepth}, tool-heavy adaptive depth = ${toolDepth}`);
}

// ════════════════════════════════════════════════════════════
// Scenario 4 — Adaptive depth: plain-chat retains recall
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 4: Adaptive depth — plain-chat recall preserved ──');
{
  // Typical council agent: 100k budget, historyFraction=0.40, plain prose at 150 tok/msg
  const budget = 100_000;
  const historyBudget = Math.floor(budget * 0.40); // 40000
  const depth = computeAdaptiveHistoryDepth('plain-chat', 150, historyBudget, 250);
  // 40000 * 0.85 / 150 = 226 messages — well above the "historic default" of 50
  assert(depth >= 50, `Plain-chat depth >= 50 (historic default recall floor) (got ${depth})`);
  assert(depth <= 250, `Plain-chat depth <= maxHistoryMessages (got ${depth})`);
}

// ════════════════════════════════════════════════════════════
// Scenario 5 — Compositor diagnostics carry Sprint 4 fields
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 5: Compositor diagnostics — Sprint 4 fields present ──');
{
  const agentId = 's4-s5-agent';
  const sessionKey = `agent:${agentId}:webchat:main`;

  const msgDb = makeMessageDb('s5');
  const libDb = makeLibraryDb('s5');

  // Seed a plain-chat conversation
  const plainMsgs = [];
  for (let i = 0; i < 10; i++) {
    plainMsgs.push({ role: 'user', textContent: `Question ${i}`, toolCalls: null, toolResults: null });
    plainMsgs.push({ role: 'assistant', textContent: `Answer ${i}`, toolCalls: null, toolResults: null });
  }

  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s5', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);
  const conv5 = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  for (let i = 0; i < plainMsgs.length; i++) {
    const m = plainMsgs[i];
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results,
                            message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(conv5.id, agentId, m.role, m.textContent, null, null, i + 1);
  }

  const cache = new CacheLayer();
  const compositor = new Compositor({ cache, vectorStore: null, libraryDb: libDb });

  const result = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 100_000,
  }, msgDb, libDb);

  const diag = result.diagnostics;
  assert(diag != null, 'Diagnostics object is present');
  assert(diag.sessionType === 'plain-chat', `sessionType is plain-chat (got ${diag.sessionType})`);
  assert(typeof diag.historyDepthChosen === 'number' && diag.historyDepthChosen > 0, `historyDepthChosen is a positive number (got ${diag.historyDepthChosen})`);
  assert(typeof diag.estimatedMsgDensityTokens === 'number', `estimatedMsgDensityTokens is present (got ${diag.estimatedMsgDensityTokens})`);
  assert(typeof diag.rescueTrimFired === 'boolean', `rescueTrimFired is a boolean (got ${diag.rescueTrimFired})`);
}

// ════════════════════════════════════════════════════════════
// Scenario 6 — Tool-heavy fixture: no rescue trim after warm compose
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 6: Tool-heavy — no rescue trim after warm compose ──');
{
  const agentId = 's4-s6-agent';
  const sessionKey = `agent:${agentId}:webchat:main`;

  const msgDb = makeMessageDb('s6');
  const libDb = makeLibraryDb('s6');

  // Build a realistic tool-heavy history: 20 rounds of
  //   user (real turn) → assistant (tool call) → user (tool result)
  // Each round has a 4kB tool result payload (~2000 tok dense).
  // The real user messages create turn boundaries so the gradient can
  // compress older rounds into stubs, preventing budget overflow.
  const toolHistory = [];
  for (let i = 0; i < 20; i++) {
    // Real user turn (turn boundary for getTurnAge)
    toolHistory.push({
      role: 'user',
      textContent: `Round ${i}: please run the analysis command`,
      toolCalls: null,
      toolResults: null,
    });
    // Assistant calls a tool
    toolHistory.push({
      role: 'assistant',
      textContent: `Running command for round ${i}`,
      toolCalls: JSON.stringify([{ id: `tc-${i}`, name: 'exec', arguments: JSON.stringify({ command: `analyze-${i}` }) }]),
      toolResults: null,
    });
    // User delivers the tool result
    toolHistory.push({
      role: 'user',
      textContent: null,
      toolCalls: null,
      toolResults: JSON.stringify([{ callId: `tc-${i}`, name: 'exec', content: 'z'.repeat(4096) }]),
    });
  }
  // Final plain turn so the last batch has a proper turn boundary
  toolHistory.push({ role: 'user', textContent: 'What is the overall status?', toolCalls: null, toolResults: null });
  toolHistory.push({ role: 'assistant', textContent: 'All systems running.', toolCalls: null, toolResults: null });

  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s6', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);
  const conv6 = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);

  for (let i = 0; i < toolHistory.length; i++) {
    const m = toolHistory[i];
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results,
                            message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(conv6.id, agentId, m.role, m.textContent, m.toolCalls, m.toolResults, i + 1);
  }

  const cache6 = new CacheLayer();
  const compositor6 = new Compositor({ cache: cache6, vectorStore: null, libraryDb: libDb });

  const result6 = await compositor6.compose({
    agentId,
    sessionKey,
    tokenBudget: 100_000,
  }, msgDb, libDb);

  const diag6 = result6.diagnostics;
  assert(diag6 != null, 'Diagnostics present for tool-heavy session');
  assert(diag6.sessionType === 'tool-heavy', `Tool-heavy session classified correctly (got ${diag6.sessionType})`);
  assert(diag6.rescueTrimFired === false, `No rescue trim fired after warm compose (rescueTrimFired=${diag6.rescueTrimFired})`);
  assert(diag6.historyDepthChosen != null, `historyDepthChosen is set (got ${diag6.historyDepthChosen})`);
  console.log(`    tool-heavy depth chosen=${diag6.historyDepthChosen}, density=${diag6.estimatedMsgDensityTokens} tok/msg`);
}

// ════════════════════════════════════════════════════════════
// Scenario 7 — Plain-chat fixture: depth >= historic default recall
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 7: Plain-chat — recall depth preserved ──');
{
  const agentId = 's4-s7-agent';
  const sessionKey = `agent:${agentId}:webchat:main`;

  const msgDb = makeMessageDb('s7');
  const libDb = makeLibraryDb('s7');

  // Seed 50 plain-chat turns (100 messages)
  const chatHistory = [];
  for (let i = 0; i < 50; i++) {
    chatHistory.push({ role: 'user', text: `User message ${i}` });
    chatHistory.push({ role: 'assistant', text: `Assistant reply ${i}` });
  }

  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s7', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);
  const conv7 = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);

  for (let i = 0; i < chatHistory.length; i++) {
    const m = chatHistory[i];
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results,
                            message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(conv7.id, agentId, m.role, m.text, null, null, i + 1);
  }

  const cache7 = new CacheLayer();
  const compositor7 = new Compositor({ cache: cache7, vectorStore: null, libraryDb: libDb });

  const result7 = await compositor7.compose({
    agentId,
    sessionKey,
    tokenBudget: 100_000,
  }, msgDb, libDb);

  const diag7 = result7.diagnostics;
  assert(diag7 != null, 'Diagnostics present for plain-chat session');
  assert(diag7.sessionType === 'plain-chat', `Plain-chat session classified correctly (got ${diag7.sessionType})`);
  // Historic default recall floor is 50 messages. Adaptive depth should be >= 50.
  assert(diag7.historyDepthChosen >= 50, `Plain-chat depth >= 50 (got ${diag7.historyDepthChosen})`);
  assert(diag7.rescueTrimFired === false, `No rescue trim for plain-chat session (rescueTrimFired=${diag7.rescueTrimFired})`);
  console.log(`    plain-chat depth chosen=${diag7.historyDepthChosen}, density=${diag7.estimatedMsgDensityTokens} tok/msg`);
}

// ════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════');
console.log(`  Sprint 4 History Depth Estimator: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
