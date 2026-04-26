/**
 * repair-tool-pairs.mjs — Tests for repairToolPairs including Pass 4 adjacency checks.
 */
import { repairToolPairs } from '../dist/repair-tool-pairs.js';

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

console.log('\n═══════════════════════════════════════════════════');
console.log('  repair-tool-pairs');
console.log('═══════════════════════════════════════════════════\n');

// ── Test 1: Pass-through for clean messages ──────────────────────────────
{
  const msgs = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  const result = repairToolPairs(msgs);
  assert(result.length === 2, 'clean messages pass through');
}

// ── Test 2: Drop orphaned toolResult message (pi-agent format) ───────────
{
  const msgs = [
    { role: 'user', content: 'hello' },
    { role: 'toolResult', toolCallId: 'orphan-123', content: 'some result' },
    { role: 'assistant', content: 'done' },
  ];
  const result = repairToolPairs(msgs);
  assert(result.length === 2, 'orphaned pi-agent toolResult dropped');
  assert(result.every(m => m.role !== 'toolResult'), 'no toolResult in output');
}

// ── Test 3: Keep valid toolResult message ────────────────────────────────
{
  const msgs = [
    { role: 'user', content: 'do something' },
    { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'read', input: {} }] },
    { role: 'toolResult', toolCallId: 'call-1', content: 'file contents' },
    { role: 'assistant', content: 'done' },
  ];
  const result = repairToolPairs(msgs);
  assert(result.length === 4, 'valid toolResult kept');
}

// ── Test 4: Drop orphaned Anthropic-native tool_result blocks ────────────
{
  const msgs = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [
      { type: 'text', text: 'running' },
      { type: 'tool_use', id: 'call-A', name: 'exec', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-A', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'call-ORPHAN', content: 'stale' },
    ] },
  ];
  const result = repairToolPairs(msgs);
  const userMsg = result.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
  assert(userMsg !== undefined, 'user message with tool_result kept');
  assert(userMsg.content.length === 1, 'orphaned tool_result block stripped');
  assert(userMsg.content[0].tool_use_id === 'call-A', 'valid block retained');
}

// ── Test 5: Drop assistant message with only unmatched tool_use blocks ───
{
  const msgs = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'call-no-result', name: 'exec', input: {} },
    ] },
    { role: 'assistant', content: 'next thing' },
  ];
  const result = repairToolPairs(msgs);
  assert(result.length === 2, 'pure unmatched tool_use assistant dropped');
}

// ── Test 6: THE BUG — intra-message adjacency orphan ─────────────────────
// tool_result references a tool_use_id that exists in the array (Pass 3 keeps it)
// but NOT in the immediately preceding assistant message (Pass 4 should strip it).
{
  const msgs = [
    { role: 'user', content: 'start' },
    // First assistant has call-X
    { role: 'assistant', content: [
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 'call-X', name: 'read', input: {} },
    ] },
    // Result for call-X (valid)
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-X', content: 'file data' },
    ] },
    // Second assistant has call-Y only
    { role: 'assistant', content: [
      { type: 'text', text: 'now doing' },
      { type: 'tool_use', id: 'call-Y', name: 'exec', input: {} },
    ] },
    // Result claims call-Y AND call-X (call-X is orphaned here — wrong adjacent assistant)
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-Y', content: 'exec ok' },
      { type: 'tool_result', tool_use_id: 'call-X', content: 'stale ref from restart' },
    ] },
  ];
  const result = repairToolPairs(msgs);
  // The last user message should only have call-Y's result
  const lastUser = result.filter(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')).pop();
  assert(lastUser !== undefined, 'adjacency: user message with tool_results exists');
  assert(lastUser.content.length === 1, 'adjacency: orphaned call-X block stripped from last user message');
  assert(lastUser.content[0].tool_use_id === 'call-Y', 'adjacency: only call-Y result remains');
}

// ── Test 7: Adjacency — all blocks orphaned, message removed ─────────────
{
  const msgs = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'call-A', name: 'read', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-A', content: 'ok' },
    ] },
    // New assistant with NO tool_use blocks
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    // Ghost user message with tool_result for call-A (exists globally but wrong adjacent)
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-A', content: 'ghost result' },
    ] },
  ];
  const result = repairToolPairs(msgs);
  // The last user message should be entirely removed (all blocks orphaned by adjacency)
  const toolResultUsers = result.filter(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
  assert(toolResultUsers.length === 1, 'adjacency: ghost user message removed, only valid one kept');
  assert(toolResultUsers[0].content[0].tool_use_id === 'call-A', 'adjacency: valid result is for call-A');
}

// ── Test 8: NeutralMessage format adjacency check ────────────────────────
{
  const msgs = [
    { role: 'user', content: 'go' },
    { role: 'assistant', toolCalls: [{ id: 'nc-1', name: 'read', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'nc-1', content: 'ok' },
    ] },
    { role: 'assistant', toolCalls: [{ id: 'nc-2', name: 'exec', input: {} }] },
    // This user msg references nc-1 (wrong adjacent) AND nc-2 (correct)
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'nc-2', content: 'exec ok' },
      { type: 'tool_result', tool_use_id: 'nc-1', content: 'stale from restart' },
    ] },
  ];
  const result = repairToolPairs(msgs);
  const lastUser = result.filter(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result')).pop();
  assert(lastUser.content.length === 1, 'neutral format adjacency: orphaned nc-1 stripped');
  assert(lastUser.content[0].tool_use_id === 'nc-2', 'neutral format adjacency: nc-2 kept');
}

// ── Test 9: Empty / null input ───────────────────────────────────────────
{
  assert(repairToolPairs([]).length === 0, 'empty array returns empty');
  assert(repairToolPairs(null) === null, 'null returns null (passthrough)');
}

console.log(`\n═══ repair-tool-pairs: ${passed} passed, ${failed} failed ═══\n`);
process.exit(failed > 0 ? 1 : 0);
