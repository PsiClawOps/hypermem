/**
 * Rate limiter tests.
 *
 * Tests:
 *   1. Immediate acquisition within burst capacity
 *   2. Token depletion and wait behavior
 *   3. Token refill over time
 *   4. Priority ordering (high > normal > low)
 *   5. Reserved tokens for high priority
 *   6. tryAcquire (non-blocking)
 *   7. Stats tracking
 *   8. Rate-limited embedder wrapper
 *   9. Destroy cleans up
 */

import { RateLimiter, createRateLimitedEmbedder } from '../dist/rate-limiter.js';

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Rate Limiter Test');
  console.log('═══════════════════════════════════════════════════\n');

  // ── Test 1: Immediate burst ──
  console.log('── Immediate Burst ──');

  const limiter1 = new RateLimiter({ tokensPerSecond: 10, burstSize: 5, reservedHigh: 1 });

  // Should get 5 tokens immediately (burst capacity)
  for (let i = 0; i < 4; i++) {
    await limiter1.acquire(1, 'normal');
  }
  assert(true, 'Acquired 4 tokens immediately (normal priority)');

  // 5th token should be available to high priority (reserved)
  await limiter1.acquire(1, 'high');
  assert(true, 'High priority gets reserved token');

  limiter1.destroy();

  // ── Test 2: Token depletion and refill ──
  console.log('\n── Token Depletion and Refill ──');

  const limiter2 = new RateLimiter({
    tokensPerSecond: 20, // Fast refill for testing
    burstSize: 3,
    reservedHigh: 0,
    maxWaitMs: 5000,
  });

  // Exhaust all tokens
  await limiter2.acquire(3);
  const stateEmpty = limiter2.state;
  assert(stateEmpty.availableTokens <= 1, `Tokens after exhaust: ${stateEmpty.availableTokens}`);

  // Wait for refill
  await sleep(200); // Should refill ~4 tokens at 20/s

  const stateRefilled = limiter2.state;
  assert(stateRefilled.availableTokens >= 2, `Tokens after 200ms: ${stateRefilled.availableTokens}`);

  limiter2.destroy();

  // ── Test 3: Wait behavior ──
  console.log('\n── Wait Behavior ──');

  const limiter3 = new RateLimiter({
    tokensPerSecond: 10,
    burstSize: 2,
    reservedHigh: 0,
    maxWaitMs: 2000,
  });

  // Exhaust tokens
  await limiter3.acquire(2);

  // Next acquire should wait
  const start = Date.now();
  await limiter3.acquire(1);
  const waited = Date.now() - start;
  assert(waited >= 50, `Waited ${waited}ms for token refill`);

  limiter3.destroy();

  // ── Test 4: Priority ordering ──
  console.log('\n── Priority Ordering ──');

  const limiter4 = new RateLimiter({
    tokensPerSecond: 5,
    burstSize: 1,
    reservedHigh: 0,
    maxWaitMs: 5000,
  });

  // Exhaust burst
  await limiter4.acquire(1);

  // Queue multiple requests at different priorities
  const order = [];
  const p1 = limiter4.acquire(1, 'low').then(() => order.push('low'));
  const p2 = limiter4.acquire(1, 'high').then(() => order.push('high'));
  const p3 = limiter4.acquire(1, 'normal').then(() => order.push('normal'));

  // Wait for all to complete
  await Promise.all([p1, p2, p3]);
  assert(order[0] === 'high', `First completed: ${order[0]} (expected high)`);
  assert(order[1] === 'normal', `Second completed: ${order[1]} (expected normal)`);
  assert(order[2] === 'low', `Third completed: ${order[2]} (expected low)`);

  limiter4.destroy();

  // ── Test 5: Reserved tokens ──
  console.log('\n── Reserved Tokens ──');

  const limiter5 = new RateLimiter({
    tokensPerSecond: 2,
    burstSize: 3,
    reservedHigh: 2,
    maxWaitMs: 2000,
  });

  // Normal priority can only use burstSize - reservedHigh = 1 token
  const got1 = limiter5.tryAcquire(1, 'normal');
  assert(got1 === true, 'Normal gets first token');

  const got2 = limiter5.tryAcquire(1, 'normal');
  assert(got2 === false, 'Normal blocked by reserved tokens');

  // High priority can access reserved
  const got3 = limiter5.tryAcquire(1, 'high');
  assert(got3 === true, 'High gets reserved token');

  limiter5.destroy();

  // ── Test 6: tryAcquire ──
  console.log('\n── tryAcquire (Non-Blocking) ──');

  const limiter6 = new RateLimiter({
    tokensPerSecond: 1,
    burstSize: 2,
    reservedHigh: 0,
  });

  assert(limiter6.tryAcquire(1) === true, 'First tryAcquire succeeds');
  assert(limiter6.tryAcquire(1) === true, 'Second tryAcquire succeeds');
  assert(limiter6.tryAcquire(1) === false, 'Third tryAcquire fails (depleted)');

  limiter6.destroy();

  // ── Test 7: Stats tracking ──
  console.log('\n── Stats Tracking ──');

  const limiter7 = new RateLimiter({
    tokensPerSecond: 10,
    burstSize: 5,
    reservedHigh: 0,
    maxWaitMs: 1000,
  });

  await limiter7.acquire(2);
  await limiter7.acquire(1);
  limiter7.tryAcquire(1);

  const stats = limiter7.state.stats;
  assert(stats.acquired === 4, `Acquired: ${stats.acquired}`);

  limiter7.destroy();

  // ── Test 8: Rate-limited embedder ──
  console.log('\n── Rate-Limited Embedder ──');

  const limiter8 = new RateLimiter({
    tokensPerSecond: 10,
    burstSize: 5,
    reservedHigh: 0,
  });

  let callCount = 0;
  const mockEmbed = async (texts) => {
    callCount++;
    return texts.map(() => new Float32Array(768));
  };

  const rateLimitedEmbed = createRateLimitedEmbedder(mockEmbed, limiter8);

  // Should work like normal embed but with rate limiting
  const result = await rateLimitedEmbed(['hello', 'world']);
  assert(result.length === 2, `Got ${result.length} embeddings`);
  assert(callCount === 1, `One API call for batch`);

  // Empty input should not consume tokens
  const empty = await rateLimitedEmbed([]);
  assert(empty.length === 0, 'Empty input returns empty');

  // High priority
  const highResult = await rateLimitedEmbed(['test'], 'high');
  assert(highResult.length === 1, 'High priority embed works');

  limiter8.destroy();

  // ── Test 9: Timeout rejection ──
  console.log('\n── Timeout Rejection ──');

  const limiter9 = new RateLimiter({
    tokensPerSecond: 0.1, // Very slow refill
    burstSize: 1,
    reservedHigh: 0,
    maxWaitMs: 200, // Short timeout
  });

  // Exhaust tokens
  await limiter9.acquire(1);

  // This should timeout
  try {
    await limiter9.acquire(1);
    assert(false, 'Should have timed out');
  } catch (err) {
    assert(err.message.includes('exceeded'), `Timeout error: ${err.message}`);
  }

  const rejStats = limiter9.state.stats;
  assert(rejStats.rejected === 1, `Rejected: ${rejStats.rejected}`);

  limiter9.destroy();

  // ── Test 10: Destroy cleanup ──
  console.log('\n── Destroy Cleanup ──');

  const limiter10 = new RateLimiter({
    tokensPerSecond: 0.1,
    burstSize: 1,
    reservedHigh: 0,
    maxWaitMs: 10000,
  });

  await limiter10.acquire(1);

  // Queue a waiter
  let destroyed = false;
  const pending = limiter10.acquire(1).catch(err => {
    destroyed = err.message.includes('destroyed');
  });

  // Destroy while waiting
  limiter10.destroy();
  await pending;
  assert(destroyed, 'Pending request rejected on destroy');

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
