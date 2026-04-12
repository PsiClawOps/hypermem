/**
 * Retrieval Policy Unit Tests (W1)
 *
 * Tests for checkScope() and filterByScope() from src/retrieval-policy.ts.
 * Uses only Node.js built-ins; runs against compiled dist output.
 */

import { checkScope, filterByScope } from '../dist/retrieval-policy.js';

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

console.log('═══════════════════════════════════════════════════');
console.log('  Retrieval Policy Tests (W1)');
console.log('═══════════════════════════════════════════════════\n');

const ctx = { agentId: 'forge', sessionKey: 'agent:forge:webchat:main' };

// ── Test 1: checkScope — agent scope allowed (matching agentId) ──
console.log('── checkScope: agent scope ──');
{
  const result = checkScope('agent', 'forge', null, ctx);
  assert(result.allowed === true, 'Test 1: agent scope allowed when agentId matches');
  assert(result.reason === 'allowed', 'Test 1: reason is "allowed"');
}

// ── Test 2: checkScope — agent scope denied (mismatched agentId) ──
{
  const result = checkScope('agent', 'compass', null, ctx);
  assert(result.allowed === false, 'Test 2: agent scope denied when agentId mismatches');
  assert(result.reason === 'scope_filtered', 'Test 2: reason is "scope_filtered"');
}

// ── Test 2b: checkScope — null/undefined scope defaults to agent behavior ──
{
  const result1 = checkScope(null, 'forge', null, ctx);
  assert(result1.allowed === true, 'Test 2b: null scope defaults to agent (matching agentId)');

  const result2 = checkScope(undefined, 'other-agent', null, ctx);
  assert(result2.allowed === false, 'Test 2b: undefined scope defaults to agent (mismatched agentId denied)');
}

// ── Test 2c: checkScope — null agentId is global (agent scope) ──
{
  const result = checkScope('agent', null, null, ctx);
  assert(result.allowed === true, 'Test 2c: null itemAgentId is global — allowed for any agent');
}

// ── Test 3: checkScope — session scope allowed (both match) ──
console.log('\n── checkScope: session scope ──');
{
  const result = checkScope('session', 'forge', 'agent:forge:webchat:main', ctx);
  assert(result.allowed === true, 'Test 3: session scope allowed when both agentId and sessionKey match');
  assert(result.reason === 'allowed', 'Test 3: reason is "allowed"');
}

// ── Test 4: checkScope — session scope denied (sessionKey differs) ──
{
  const result = checkScope('session', 'forge', 'agent:forge:webchat:other', ctx);
  assert(result.allowed === false, 'Test 4: session scope denied when sessionKey differs');
  assert(result.reason === 'scope_filtered', 'Test 4: reason is "scope_filtered"');
}

// ── Test 4b: checkScope — session scope denied (agentId differs) ──
{
  const result = checkScope('session', 'compass', 'agent:forge:webchat:main', ctx);
  assert(result.allowed === false, 'Test 4b: session scope denied when agentId differs');
}

// ── Test 5: checkScope — global scope always allowed ──
console.log('\n── checkScope: global scope ──');
{
  const result1 = checkScope('global', 'compass', 'agent:compass:webchat:other', ctx);
  assert(result1.allowed === true, 'Test 5a: global scope allowed regardless of agentId');

  const result2 = checkScope('global', null, null, ctx);
  assert(result2.allowed === true, 'Test 5b: global scope with null IDs still allowed');

  const result3 = checkScope('global', 'totally-different-agent', 'different-session', ctx);
  assert(result3.allowed === true, 'Test 5c: global scope with completely different context allowed');
}

// ── Test 5d: checkScope — user scope ──
console.log('\n── checkScope: user scope ──');
{
  const result1 = checkScope('user', 'forge', null, ctx);
  assert(result1.allowed === true, 'Test 5d: user scope allowed when agentId matches');

  const result2 = checkScope('user', 'compass', null, ctx);
  assert(result2.allowed === false, 'Test 5d: user scope denied when agentId mismatches');
}

// ── Test 6: checkScope — unknown scope → ambiguous_scope denied ──
console.log('\n── checkScope: unknown/ambiguous scope ──');
{
  const result1 = checkScope('fleet', 'forge', null, ctx);
  assert(result1.allowed === false, 'Test 6a: unknown scope "fleet" → denied');
  assert(result1.reason === 'ambiguous_scope', 'Test 6a: reason is "ambiguous_scope"');

  const result2 = checkScope('org', null, null, ctx);
  assert(result2.allowed === false, 'Test 6b: unknown scope "org" → denied');
  assert(result2.reason === 'ambiguous_scope', 'Test 6b: reason is "ambiguous_scope"');
}

// ── Test 7: filterByScope — mixed array, verify allowed count and filteredCount ──
console.log('\n── filterByScope: mixed array ──');
{
  const items = [
    // Should be allowed: agent scope, matching agentId
    { agentId: 'forge', sessionKey: null, scope: 'agent', content: 'fact-1' },
    // Should be allowed: global scope
    { agentId: 'compass', sessionKey: null, scope: 'global', content: 'fact-2' },
    // Should be allowed: null scope (defaults to agent), matching agentId
    { agentId: 'forge', sessionKey: null, scope: null, content: 'fact-3' },
    // Should be allowed: null agentId (global fact)
    { agentId: null, sessionKey: null, scope: 'agent', content: 'fact-4' },
    // Should be filtered: agent scope, wrong agentId
    { agentId: 'compass', sessionKey: null, scope: 'agent', content: 'fact-5' },
    // Should be filtered: session scope, wrong session
    { agentId: 'forge', sessionKey: 'agent:forge:webchat:other', scope: 'session', content: 'fact-6' },
    // Should be filtered: ambiguous scope
    { agentId: 'forge', sessionKey: null, scope: 'org', content: 'fact-7' },
  ];

  const { allowed, filteredCount } = filterByScope(items, ctx);
  assert(allowed.length === 4, `Test 7: allowed count is 4 (got ${allowed.length})`);
  assert(filteredCount === 3, `Test 7: filteredCount is 3 (got ${filteredCount})`);
  assert(allowed.every(item => ['fact-1', 'fact-2', 'fact-3', 'fact-4'].includes(item.content)),
    'Test 7: correct items allowed (fact-1, fact-2, fact-3, fact-4)');

  // Verify empty array works
  const emptyResult = filterByScope([], ctx);
  assert(emptyResult.allowed.length === 0 && emptyResult.filteredCount === 0,
    'Test 7: empty array returns empty allowed + 0 filtered');
}

console.log('\n═══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`  ALL ${passed} TESTS PASSED ✅`);
} else {
  console.log(`  ${passed} passed, ${failed} FAILED ❌`);
}
console.log('═══════════════════════════════════════════════════');

process.exit(failed > 0 ? 1 : 0);
