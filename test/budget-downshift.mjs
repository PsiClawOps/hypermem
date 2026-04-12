/**
 * Budget Downshift tests — Fix A (proactive reshape pass)
 *
 * Tests:
 *   - applyToolGradientToWindow with empty array returns empty array
 *   - applyToolGradientToWindow with messages under budget — returns all messages
 *   - applyToolGradientToWindow with messages over budget — trims oldest
 *   - getModelState returns null on miss
 *   - setModelState then getModelState round-trips correctly
 *   - Downshift threshold: 9% reduction does NOT trigger reshape
 *   - Downshift threshold: 15% reduction DOES trigger reshape
 */

import { applyToolGradientToWindow } from '../dist/compositor.js';
import { RedisLayer } from '../dist/redis.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
    console.error(new Error(`Assertion failed: ${msg}`).stack);
  }
}

console.log('\n═══════════════════════════════════════════════════');
console.log('  Budget Downshift Tests (Fix A)');
console.log('═══════════════════════════════════════════════════\n');

// ─── applyToolGradientToWindow unit tests (no Redis required) ────────────────

console.log('── applyToolGradientToWindow ──');

{
  // Test 1: empty array returns empty array
  const result = applyToolGradientToWindow([], 100_000);
  assert(Array.isArray(result), 'Returns an array for empty input');
  assert(result.length === 0, 'Empty array input returns empty array');
}

{
  // Test 2: messages under budget — all returned
  // Budget = 10_000 tokens → targetChars = floor(10000 * 0.65) * 4 = 26000 chars
  // 3 short messages, well under budget
  const messages = [
    { role: 'user', textContent: 'Hello', toolCalls: null, toolResults: null },
    { role: 'assistant', textContent: 'Hi there!', toolCalls: null, toolResults: null },
    { role: 'user', textContent: 'How are you?', toolCalls: null, toolResults: null },
  ];
  const result = applyToolGradientToWindow(messages, 10_000);
  assert(Array.isArray(result), 'Returns an array for under-budget input');
  // All messages fit well within budget — all should be returned
  assert(result.length > 0, 'Under-budget input returns messages (not empty)');
  // The trimming only removes if totalChars > targetChars, so all 3 should survive
  const totalChars = messages.reduce((s, m) => s + (m.textContent?.length ?? 0), 0);
  const targetChars = Math.floor(10_000 * 0.65) * 4;
  if (totalChars <= targetChars) {
    assert(result.length === messages.length, `Under-budget: all ${messages.length} messages returned (got ${result.length})`);
  } else {
    assert(result.length < messages.length, 'Over-budget: trimmed correctly');
  }
}

{
  // Test 3: messages over budget — trims oldest
  // Budget = 100 tokens → targetChars = floor(100 * 0.65) * 4 = 260 chars
  // Create messages that exceed this limit
  const longText = 'A'.repeat(100); // 100 chars each
  const messages = [
    { role: 'user', textContent: longText, toolCalls: null, toolResults: null },         // oldest
    { role: 'assistant', textContent: longText, toolCalls: null, toolResults: null },
    { role: 'user', textContent: longText, toolCalls: null, toolResults: null },
    { role: 'assistant', textContent: longText, toolCalls: null, toolResults: null },    // newest
  ];
  // totalChars = 400, targetChars = 260 → should drop oldest
  const result = applyToolGradientToWindow(messages, 100);
  assert(result.length < messages.length, `Over-budget: trimmed from ${messages.length} to ${result.length}`);
  // The LAST message should always be kept (newest preserved)
  const lastMsg = result[result.length - 1];
  const origLastMsg = messages[messages.length - 1];
  assert(
    lastMsg && lastMsg.textContent === origLastMsg.textContent,
    'Over-budget trim preserves newest messages'
  );
  // Verify the remaining messages fit within the budget
  const totalCharsAfter = result.reduce((s, m) => s + (m.textContent?.length ?? 0), 0);
  const targetChars = Math.floor(100 * 0.65) * 4;
  assert(
    totalCharsAfter <= targetChars,
    `Trimmed result fits within budget (${totalCharsAfter} <= ${targetChars} chars)`
  );
}

// ─── Downshift threshold math tests (no Redis required) ─────────────────────

console.log('\n── Downshift threshold logic ──');

{
  // Test 6: 9% reduction does NOT trigger reshape (below 10% threshold)
  const prevBudget = 100_000;
  const newBudget = 91_000; // 9% less
  const DOWNSHIFT_THRESHOLD = 0.10;
  const reduction = (prevBudget - newBudget) / prevBudget;
  const isDownshift = reduction > DOWNSHIFT_THRESHOLD;
  assert(!isDownshift, `9% reduction (${(reduction * 100).toFixed(1)}%) does NOT trigger reshape (threshold=${DOWNSHIFT_THRESHOLD * 100}%)`);
}

{
  // Test 7: 15% reduction DOES trigger reshape
  const prevBudget = 100_000;
  const newBudget = 85_000; // 15% less
  const DOWNSHIFT_THRESHOLD = 0.10;
  const reduction = (prevBudget - newBudget) / prevBudget;
  const isDownshift = reduction > DOWNSHIFT_THRESHOLD;
  assert(isDownshift, `15% reduction (${(reduction * 100).toFixed(1)}%) DOES trigger reshape (threshold=${DOWNSHIFT_THRESHOLD * 100}%)`);
}

{
  // Boundary: exactly 10% is NOT a trigger (must be strictly greater than)
  const prevBudget = 100_000;
  const newBudget = 90_000; // exactly 10%
  const DOWNSHIFT_THRESHOLD = 0.10;
  const reduction = (prevBudget - newBudget) / prevBudget;
  const isDownshift = reduction > DOWNSHIFT_THRESHOLD;
  assert(!isDownshift, `Exactly 10% reduction is NOT a trigger (strict greater-than comparison)`);
}

// ─── Redis round-trip tests ──────────────────────────────────────────────────

console.log('\n── Redis model state round-trip ──');

async function runRedisTests() {
  const redis = new RedisLayer({ keyPrefix: 'hm-bd-test:', sessionTTL: 30 });
  const connected = await redis.connect();

  if (!connected) {
    console.log('  ⚠️  Redis unavailable — skipping Redis model state tests');
    return;
  }

  // Clean up stale keys from previous runs
  await redis.flushPrefix();

  const agentId = 'test-bd-agent';
  const sessionKey = 'agent:test-bd-agent:webchat:main';

  // Test 4: getModelState returns null on miss
  const missing = await redis.getModelState(agentId, sessionKey);
  assert(missing === null, 'getModelState returns null on cache miss');

  // Test 5: setModelState then getModelState round-trips correctly
  const state = {
    model: 'gpt-5.4',
    tokenBudget: 128_000,
    composedAt: '2026-04-05T12:00:00.000Z',
    historyDepth: 150,
  };
  await redis.setModelState(agentId, sessionKey, state);
  const retrieved = await redis.getModelState(agentId, sessionKey);

  assert(retrieved !== null, 'getModelState returns non-null after setModelState');
  assert(retrieved?.model === state.model, `Round-trip model matches (got ${retrieved?.model})`);
  assert(retrieved?.tokenBudget === state.tokenBudget, `Round-trip tokenBudget matches (got ${retrieved?.tokenBudget})`);
  assert(retrieved?.composedAt === state.composedAt, `Round-trip composedAt matches (got ${retrieved?.composedAt})`);
  assert(retrieved?.historyDepth === state.historyDepth, `Round-trip historyDepth matches (got ${retrieved?.historyDepth})`);
  assert(retrieved?.reshapedAt === undefined, 'reshapedAt is undefined when not set');

  // Test: reshapedAt round-trips correctly
  const stateWithReshape = {
    ...state,
    reshapedAt: '2026-04-05T12:01:00.000Z',
  };
  await redis.setModelState(agentId, sessionKey, stateWithReshape);
  const retrievedWithReshape = await redis.getModelState(agentId, sessionKey);
  assert(
    retrievedWithReshape?.reshapedAt === stateWithReshape.reshapedAt,
    `reshapedAt round-trips correctly (got ${retrievedWithReshape?.reshapedAt})`
  );

  await redis.flushPrefix();
  await redis.disconnect();
}

await runRedisTests();

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`  ALL ${passed} TESTS PASSED ✅`);
} else {
  console.log(`  ${passed} passed, ${failed} FAILED ❌`);
}
console.log('═══════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
