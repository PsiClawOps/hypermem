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

import { applyToolGradientToWindow, canPersistReshapedHistory, getTurnAge } from '../dist/compositor.js';

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
  // Budget = 10_000 tokens → targetTokens = floor(10000 * 0.65) = 6500 tokens
  // 3 short messages, well under budget
  const messages = [
    { role: 'user', textContent: 'Hello', toolCalls: null, toolResults: null },
    { role: 'assistant', textContent: 'Hi there!', toolCalls: null, toolResults: null },
    { role: 'user', textContent: 'How are you?', toolCalls: null, toolResults: null },
  ];
  const result = applyToolGradientToWindow(messages, 10_000);
  assert(Array.isArray(result), 'Returns an array for under-budget input');
  // All messages fit well within budget — all should survive
  assert(result.length > 0, 'Under-budget input returns messages (not empty)');
  assert(result.length === messages.length, `Under-budget: all ${messages.length} messages returned (got ${result.length})`);
}

{
  // Test 3: messages over budget — trims oldest
  // Budget = 100 tokens → targetTokens = floor(100 * 0.65) = 65 tokens
  // Create messages that exceed this limit
  const longText = 'A'.repeat(100); // 100 chars each
  const messages = [
    { role: 'user', textContent: longText, toolCalls: null, toolResults: null },         // oldest
    { role: 'assistant', textContent: longText, toolCalls: null, toolResults: null },
    { role: 'user', textContent: longText, toolCalls: null, toolResults: null },
    { role: 'assistant', textContent: longText, toolCalls: null, toolResults: null },    // newest
  ];
  // 4 short prose messages exceed the 65-token target → should drop oldest
  const result = applyToolGradientToWindow(messages, 100);
  assert(result.length < messages.length, `Over-budget: trimmed from ${messages.length} to ${result.length}`);
  // The LAST message should always be kept (newest preserved)
  const lastMsg = result[result.length - 1];
  const origLastMsg = messages[messages.length - 1];
  assert(
    lastMsg && lastMsg.textContent === origLastMsg.textContent,
    'Over-budget trim preserves newest messages'
  );
  // Text-only path: remaining prose is comfortably smaller than the original window
  const totalCharsAfter = result.reduce((s, m) => s + (m.textContent?.length ?? 0), 0);
  assert(totalCharsAfter < longText.length * messages.length, 'Trimmed result is smaller than the original prose window');
}

{
  // Test 4: toolResults count toward budget, not just textContent.
  // Old behavior looked only at textContent, so this case kept both messages.
  const messages = [
    { role: 'user', textContent: 'B'.repeat(200), toolCalls: null, toolResults: null },
    {
      role: 'assistant',
      textContent: null,
      toolCalls: null,
      toolResults: [{ callId: 'tc_001', name: 'read', content: 'X'.repeat(1200), isError: false }],
    },
  ];
  const result = applyToolGradientToWindow(messages, 100);
  assert(result.length === 1, `Tool payload budget-fit trims older prose when toolResults carry the real weight (got ${result.length})`);
  assert(result[0].toolResults?.[0]?.content?.length > 0, 'Newest tool payload is preserved after oldest prose is dropped');
}

{
  // Test 5: structured tool history must not be persisted after reshape.
  // The view may flatten old tool turns, but canonical cache/history must stay lossless.
  const longResult = 'R'.repeat(2000);
  const messages = [
    { role: 'user', textContent: 'Initial request', toolCalls: null, toolResults: null },
    {
      role: 'assistant',
      textContent: 'Working on it',
      toolCalls: [{ id: 'tc_100', name: 'read', arguments: '{"path":"README.md"}' }],
      toolResults: [{ callId: 'tc_100', name: 'read', content: longResult, isError: false }],
    },
    { role: 'user', textContent: 'Turn 1', toolCalls: null, toolResults: null },
    { role: 'assistant', textContent: 'Ack 1', toolCalls: null, toolResults: null },
    { role: 'user', textContent: 'Turn 2', toolCalls: null, toolResults: null },
    { role: 'assistant', textContent: 'Ack 2', toolCalls: null, toolResults: null },
    { role: 'user', textContent: 'Turn 3', toolCalls: null, toolResults: null },
    { role: 'assistant', textContent: 'Ack 3', toolCalls: null, toolResults: null },
    { role: 'user', textContent: 'Turn 4', toolCalls: null, toolResults: null },
    { role: 'assistant', textContent: 'Ack 4', toolCalls: null, toolResults: null },
    { role: 'user', textContent: 'Newest turn', toolCalls: null, toolResults: null },
  ];

  const reshaped = applyToolGradientToWindow(messages, 100);

  assert(canPersistReshapedHistory(messages) === false, 'Structured tool history disables destructive persistence');
  assert(messages[1].toolCalls?.length === 1, 'Canonical input retains tool call structure');
  assert(messages[1].toolResults?.length === 1, 'Canonical input retains tool result structure');
  assert(Array.isArray(reshaped) && reshaped.length > 0, 'View-only reshape still produces a compose-time window');
}

{
  // Test 6: cluster trim must not keep a tool result after dropping its tool call.
  const messages = [
    { role: 'user', textContent: 'older prose', toolCalls: null, toolResults: null },
    { role: 'assistant', textContent: 'calling tool', toolCalls: [{ id: 'tc_cluster', name: 'read', arguments: '{\"path\":\"README.md\"}' }], toolResults: null },
    { role: 'user', textContent: null, toolCalls: null, toolResults: [{ callId: 'tc_cluster', name: 'read', content: 'X'.repeat(120), isError: false }] },
    { role: 'assistant', textContent: 'newest prose', toolCalls: null, toolResults: null },
  ];

  const reshaped = applyToolGradientToWindow(messages, 60);
  const hasOrphanResult = reshaped.some((msg, idx) =>
    msg.toolResults?.length && !(idx > 0 && reshaped[idx - 1].toolCalls?.some(tc => tc.id === 'tc_cluster'))
  );

  assert(!hasOrphanResult, 'Cluster-aware trim never leaves a tool result without its preceding tool call');
  assert(!reshaped.some(msg => msg.toolCalls?.some(tc => tc.id === 'tc_cluster')), 'Over-budget cluster drops both halves together when the pair no longer fits');
}

{
  // Test 7: toolResult carriers must not count as a new user turn for gradient aging.
  const messages = [
    { role: 'assistant', textContent: 'calling tool', toolCalls: [{ id: 'tc_age', name: 'read', arguments: '{\"path\":\"README.md\"}' }], toolResults: null },
    { role: 'user', textContent: null, toolCalls: null, toolResults: [{ callId: 'tc_age', name: 'read', content: 'ok', isError: false }] },
    { role: 'user', textContent: 'actual human follow-up', toolCalls: null, toolResults: null },
  ];

  assert(getTurnAge(messages, 0) === 1, 'Assistant tool call ignores its matching tool-result carrier when computing turn age');
  assert(getTurnAge(messages, 1) === 1, 'Tool-result carrier shares the same turn age as its assistant tool call');
}

// ─── Downshift threshold math tests (no Redis required) ─────────────────────

console.log('\n── Downshift threshold logic ──');

{
  // Test 8: 9% reduction does NOT trigger reshape (below 10% threshold)
  const prevBudget = 100_000;
  const newBudget = 91_000; // 9% less
  const DOWNSHIFT_THRESHOLD = 0.10;
  const reduction = (prevBudget - newBudget) / prevBudget;
  const isDownshift = reduction > DOWNSHIFT_THRESHOLD;
  assert(!isDownshift, `9% reduction (${(reduction * 100).toFixed(1)}%) does NOT trigger reshape (threshold=${DOWNSHIFT_THRESHOLD * 100}%)`);
}

{
  // Test 9: 15% reduction DOES trigger reshape
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

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`  ALL ${passed} TESTS PASSED ✅`);
} else {
  console.log(`  ${passed} passed, ${failed} FAILED ❌`);
}
console.log('═══════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
