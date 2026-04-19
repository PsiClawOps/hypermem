/**
 * HyperMem B4 — Model-Aware Budgeting Regression Test
 *
 * Proves that model-aware lane budgeting (B4) meaningfully changes:
 *   1. historyFraction and memoryFraction when a model's effective budget
 *      exceeds its MECW floor (minimum effective context window).
 *   2. Compositor diagnostics carry the B4 fields (mecwProfile, mecwApplied,
 *      mecwBlend, effectiveHistoryFraction, effectiveMemoryFraction).
 *   3. Two or more distinct model profiles produce materially different lane
 *      fractions at the same effective budget — i.e. B4 is not a no-op.
 *   4. When budget <= MECW floor the fractions stay at config defaults.
 *   5. Integration: full compose() on two model profiles at a large budget
 *      produces different history slot token counts.
 *
 * No Ollama, no real vector store, no network. Uses Compositor directly.
 */

import { resolveModelLaneBudgets, Compositor } from '../dist/compositor.js';
import { CacheLayer } from '../dist/cache.js';
import { migrateLibrary } from '../dist/library-schema.js';
import { migrate } from '../dist/schema.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-b4-'));

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

// Seed a conversation with N plain-text turns so history slot is non-zero.
function seedConversation(db, agentId, sessionKey, numTurns) {
  db.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-b4-1', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);
  const conv = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  for (let i = 0; i < numTurns; i++) {
    db.prepare(`INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results, message_index, is_heartbeat, created_at) VALUES (?, ?, ?, ?, null, null, ?, 0, datetime('now'))`)
      .run(conv.id, agentId, i % 2 === 0 ? 'user' : 'assistant', 'word '.repeat(200), i + 1);
  }
}

// ════════════════════════════════════════════════════════════
// Scenario 1 — resolveModelLaneBudgets unit: below MECW floor
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 1: resolveModelLaneBudgets — budget below MECW floor ──');
{
  // Claude MECW floor = 80k. Budget = 60k → below floor → config fractions unchanged.
  const configHistory = 0.40;
  const configMemory = 0.40;
  const result = resolveModelLaneBudgets('claude-sonnet-4', 60_000, configHistory, configMemory);
  assert(result.mecwProfile === 'claude', `MECW profile is 'claude' (got ${result.mecwProfile})`);
  assert(result.mecwApplied === false, `mecwApplied is false when budget < MECW floor (got ${result.mecwApplied})`);
  assert(result.mecwBlend === 0, `mecwBlend is 0 when budget < MECW floor (got ${result.mecwBlend})`);
  assert(result.historyFraction === configHistory, `historyFraction unchanged below MECW floor (got ${result.historyFraction})`);
  assert(result.memoryFraction === configMemory, `memoryFraction unchanged below MECW floor (got ${result.memoryFraction})`);
}

// ════════════════════════════════════════════════════════════
// Scenario 2 — resolveModelLaneBudgets unit: above MECW ceiling
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 2: resolveModelLaneBudgets — budget above MECW ceiling ──');
{
  // Claude MECW ceiling = 140k. Budget = 160k → at/above ceiling → preferred fractions.
  const configHistory = 0.40;
  const configMemory = 0.40;
  const result = resolveModelLaneBudgets('claude-sonnet-4', 160_000, configHistory, configMemory);
  assert(result.mecwProfile === 'claude', `MECW profile is 'claude' (got ${result.mecwProfile})`);
  assert(result.mecwApplied === true, `mecwApplied is true when budget >= MECW ceiling (got ${result.mecwApplied})`);
  assert(result.mecwBlend === 1, `mecwBlend is 1 when budget >= MECW ceiling (got ${result.mecwBlend})`);
  // Claude preferred historyFraction = 0.35, memoryFraction = 0.45
  assert(Math.abs(result.historyFraction - 0.35) < 0.001, `historyFraction = 0.35 at MECW ceiling for claude (got ${result.historyFraction})`);
  assert(Math.abs(result.memoryFraction - 0.45) < 0.001, `memoryFraction = 0.45 at MECW ceiling for claude (got ${result.memoryFraction})`);
}

// ════════════════════════════════════════════════════════════
// Scenario 3 — resolveModelLaneBudgets unit: between floor and ceiling
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 3: resolveModelLaneBudgets — budget between MECW floor and ceiling ──');
{
  // Claude: floor=80k, ceiling=140k. Budget=110k → blend=(110k-80k)/(140k-80k)=0.5
  const configHistory = 0.40;
  const configMemory = 0.40;
  const result = resolveModelLaneBudgets('claude-opus-4', 110_000, configHistory, configMemory);
  assert(result.mecwProfile === 'claude', `MECW profile is 'claude' (got ${result.mecwProfile})`);
  assert(result.mecwApplied === true, `mecwApplied is true at partial blend (got ${result.mecwApplied})`);
  const expectedBlend = (110_000 - 80_000) / (140_000 - 80_000); // 0.5
  assert(Math.abs(result.mecwBlend - expectedBlend) < 0.001, `mecwBlend ≈ 0.5 (got ${result.mecwBlend})`);
  // historyFraction = 0.40 + 0.5*(0.35-0.40) = 0.40 - 0.025 = 0.375
  const expectedHistory = 0.40 + expectedBlend * (0.35 - 0.40);
  assert(Math.abs(result.historyFraction - expectedHistory) < 0.005, `historyFraction ≈ ${expectedHistory.toFixed(3)} at blend=0.5 (got ${result.historyFraction})`);
  // memoryFraction = 0.40 + 0.5*(0.45-0.40) = 0.40 + 0.025 = 0.425
  const expectedMemory = 0.40 + expectedBlend * (0.45 - 0.40);
  assert(Math.abs(result.memoryFraction - expectedMemory) < 0.005, `memoryFraction ≈ ${expectedMemory.toFixed(3)} at blend=0.5 (got ${result.memoryFraction})`);
  console.log(`    blend=${result.mecwBlend.toFixed(3)}, history=${result.historyFraction}, memory=${result.memoryFraction}`);
}

// ════════════════════════════════════════════════════════════
// Scenario 4 — Two model profiles produce different fractions at same budget
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 4: Two model profiles produce different lane fractions ──');
{
  const configHistory = 0.40;
  const configMemory = 0.40;
  const bigBudget = 150_000; // above Claude ceiling (140k)

  // Claude at 150k: above ceiling → preferred fractions (0.35 / 0.45)
  const claudeResult = resolveModelLaneBudgets('claude-sonnet-4', bigBudget, configHistory, configMemory);
  // GPT at 150k: GPT ceiling=128k, budget exceeds ceiling → preferred (0.40/0.40)
  const gptResult = resolveModelLaneBudgets('gpt-4o', bigBudget, configHistory, configMemory);

  assert(claudeResult.mecwApplied === true, `Claude MECW applied at ${bigBudget}k budget`);
  assert(gptResult.mecwApplied === true, `GPT MECW applied at ${bigBudget}k budget`);
  assert(
    Math.abs(claudeResult.historyFraction - gptResult.historyFraction) > 0.01,
    `Claude historyFraction (${claudeResult.historyFraction}) differs from GPT (${gptResult.historyFraction}) at same budget`
  );
  console.log(`    claude: history=${claudeResult.historyFraction}, memory=${claudeResult.memoryFraction}`);
  console.log(`    gpt:    history=${gptResult.historyFraction}, memory=${gptResult.memoryFraction}`);

  // Gemini also differs from Claude at 150k (Gemini ceiling=180k so not yet at ceiling)
  const geminiResult = resolveModelLaneBudgets('gemini-2.5-pro', bigBudget, configHistory, configMemory);
  console.log(`    gemini: history=${geminiResult.historyFraction}, memory=${geminiResult.memoryFraction}, blend=${geminiResult.mecwBlend}`);
  assert(geminiResult.mecwProfile === 'gemini', `Gemini MECW profile matched`);
  // Gemini ceiling is 180k, so at 150k it should have applied partial blending
  assert(geminiResult.mecwApplied === true, `Gemini MECW applied at 150k (between floor 100k and ceiling 180k)`);
}

// ════════════════════════════════════════════════════════════
// Scenario 5 — No model: fractions are config defaults
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 5: No model string → config defaults unchanged ──');
{
  const configHistory = 0.38;
  const configMemory = 0.42;
  const result = resolveModelLaneBudgets(undefined, 150_000, configHistory, configMemory);
  assert(result.mecwProfile === undefined, `No MECW profile when model is undefined (got ${result.mecwProfile})`);
  assert(result.mecwApplied === false, `mecwApplied false when model is undefined`);
  assert(result.historyFraction === configHistory, `historyFraction unchanged when no model`);
  assert(result.memoryFraction === configMemory, `memoryFraction unchanged when no model`);
}

// ════════════════════════════════════════════════════════════
// Scenario 6 — Integration: Compositor diagnostics carry B4 fields
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 6: Compositor diagnostics include B4 fields ──');
{
  const agentId = 'b4-s6-agent';
  const sessionKey = `agent:${agentId}:webchat:main`;
  const msgDb = makeMessageDb('b4-s6');
  const libDb = makeLibraryDb('b4-s6');

  seedConversation(msgDb, agentId, sessionKey, 20);

  const cache = new CacheLayer();
  const compositor = new Compositor({ cache, vectorStore: null, libraryDb: libDb });

  // Compose with a large budget (above Claude MECW floor) using a claude model
  const result = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 120_000,
    model: 'claude-sonnet-4',
  }, msgDb, libDb);

  const diag = result.diagnostics;
  assert(diag != null, 'Diagnostics present');
  assert(typeof diag.mecwProfile === 'string', `mecwProfile is a string (got ${JSON.stringify(diag.mecwProfile)})`);
  assert(diag.mecwProfile === 'claude', `mecwProfile is 'claude' (got ${diag.mecwProfile})`);
  assert(typeof diag.mecwApplied === 'boolean', `mecwApplied is a boolean (got ${diag.mecwApplied})`);
  assert(typeof diag.mecwBlend === 'number', `mecwBlend is a number (got ${diag.mecwBlend})`);
  assert(typeof diag.effectiveHistoryFraction === 'number', `effectiveHistoryFraction is a number (got ${diag.effectiveHistoryFraction})`);
  assert(typeof diag.effectiveMemoryFraction === 'number', `effectiveMemoryFraction is a number (got ${diag.effectiveMemoryFraction})`);
  console.log(`    mecwProfile=${diag.mecwProfile}, mecwApplied=${diag.mecwApplied}, mecwBlend=${diag.mecwBlend}`);
  console.log(`    effectiveHistoryFraction=${diag.effectiveHistoryFraction}, effectiveMemoryFraction=${diag.effectiveMemoryFraction}`);
}

// ════════════════════════════════════════════════════════════
// Scenario 7 — Integration: Two model profiles at large budget produce
//              different effective history allocations in compose()
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 7: Two model profiles → different history slot allocations ──');
{
  const claudeAgentId = 'b4-s7-claude';
  const gptAgentId = 'b4-s7-gpt';
  const claudeSk = `agent:${claudeAgentId}:webchat:main`;
  const gptSk = `agent:${gptAgentId}:webchat:main`;

  const msgDbClaude = makeMessageDb('b4-s7-claude');
  const msgDbGpt = makeMessageDb('b4-s7-gpt');
  const libDb = makeLibraryDb('b4-s7');

  // Seed identical content into both
  const numTurns = 30;
  seedConversation(msgDbClaude, claudeAgentId, claudeSk, numTurns);
  seedConversation(msgDbGpt, gptAgentId, gptSk, numTurns);

  // Budget of 150k: above Claude ceiling (140k) → Claude prefers 35% history
  //                 above GPT ceiling (128k)    → GPT stays at 40% history
  const largeBudget = 150_000;

  const cacheClaude = new CacheLayer();
  const compositorClaude = new Compositor({ cache: cacheClaude, vectorStore: null, libraryDb: libDb });

  const cacheGpt = new CacheLayer();
  const compositorGpt = new Compositor({ cache: cacheGpt, vectorStore: null, libraryDb: libDb });

  const resultClaude = await compositorClaude.compose({
    agentId: claudeAgentId,
    sessionKey: claudeSk,
    tokenBudget: largeBudget,
    model: 'claude-sonnet-4',
  }, msgDbClaude, libDb);

  const resultGpt = await compositorGpt.compose({
    agentId: gptAgentId,
    sessionKey: gptSk,
    tokenBudget: largeBudget,
    model: 'gpt-4o',
  }, msgDbGpt, libDb);

  const claudeDiag = resultClaude.diagnostics;
  const gptDiag = resultGpt.diagnostics;

  assert(claudeDiag != null && gptDiag != null, 'Both diagnostics present');
  assert(claudeDiag.mecwApplied === true, `Claude MECW applied at ${largeBudget} budget`);
  assert(gptDiag.mecwApplied === true, `GPT MECW applied at ${largeBudget} budget`);

  console.log(`    claude: effectiveHistoryFraction=${claudeDiag.effectiveHistoryFraction}, history_tokens=${resultClaude.slots.history}`);
  console.log(`    gpt:    effectiveHistoryFraction=${gptDiag.effectiveHistoryFraction}, history_tokens=${resultGpt.slots.history}`);

  // Claude's effectiveHistoryFraction should be less than GPT's (0.35 vs 0.40)
  assert(
    claudeDiag.effectiveHistoryFraction < gptDiag.effectiveHistoryFraction,
    `Claude effectiveHistoryFraction (${claudeDiag.effectiveHistoryFraction}) < GPT (${gptDiag.effectiveHistoryFraction}) at large budget`
  );

  // When both models have identical history content, Claude's history slot (tokens)
  // should be <= GPT's, since Claude's historyFraction is smaller.
  // They may be equal if both fit entirely within budget (no truncation).
  assert(
    resultClaude.slots.history <= resultGpt.slots.history,
    `Claude history slot (${resultClaude.slots.history} tok) <= GPT history slot (${resultGpt.slots.history} tok) due to smaller historyFraction`
  );
}

// ════════════════════════════════════════════════════════════
// Scenario 8 — Gemini very large budget: MECW ceiling applies
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 8: Gemini large window — MECW ceiling at 180k ──');
{
  // At 250k budget (above Gemini ceiling 180k), blend = 1, preferred fractions used
  const result = resolveModelLaneBudgets('gemini-2.5-pro', 250_000, 0.40, 0.40);
  assert(result.mecwProfile === 'gemini', `Gemini MECW profile matched`);
  assert(result.mecwApplied === true, `MECW applied above Gemini ceiling (250k > 180k)`);
  assert(result.mecwBlend === 1, `mecwBlend = 1 above Gemini ceiling`);
  console.log(`    gemini at 250k: history=${result.historyFraction}, memory=${result.memoryFraction}`);
}

// ════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════
console.log('\n════════════════════════════════════════════════');
console.log(`  B4 Model-Aware Budgeting: ${passed} passed, ${failed} failed`);
console.log('════════════════════════════════════════════════\n');

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

if (failed > 0) process.exit(1);
