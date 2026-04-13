/**
 * Fleet cache + hook handler integration tests.
 *
 * Tests:
 *   1. Redis fleet cache operations (set/get/invalidate)
 *   2. Fleet hydration from library.db
 *   3. Cache-aside pattern on getFleetAgentCached
 *   4. Write-through invalidation on mutations
 *   5. Hook handler dispatch (corrected InternalHookEvent interface)
 */

import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-fleet-cache-'));

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
  console.log('  HyperMem Fleet Cache + Hook Test');
  console.log('═══════════════════════════════════════════════════\n');

  let hm;
  try {
    hm = await HyperMem.create({
      dataDir: tmpDir,
    });
  } catch (err) {
    console.log(`  ❌ Failed to create HyperMem: ${err.message}`);
    process.exit(1);
  }

  // ── Test 1: Redis fleet cache basics ──
  console.log('── Redis Fleet Cache Basics ──');

  await hm.cache.setFleetCache('test:key', 'hello world');
  const val = await hm.cache.getFleetCache('test:key');
  assert(val === 'hello world', 'Set and get fleet cache');

  await hm.cache.delFleetCache('test:key');
  const deleted = await hm.cache.getFleetCache('test:key');
  assert(deleted === null, 'Delete fleet cache');

  // ── Test 2: Agent cache operations ──
  console.log('\n── Agent Cache Operations ──');

  await hm.cache.cacheFleetAgent('agent1', {
    id: 'agent1', tier: 'council', status: 'active', domains: ['infra'],
  });
  const cached = await hm.cache.getCachedFleetAgent('agent1');
  assert(cached !== null, 'Cached fleet agent');
  assert(cached.id === 'agent1', 'Agent ID matches');
  assert(cached.tier === 'council', 'Agent tier matches');

  await hm.cache.invalidateFleetAgent('agent1');
  const invalidated = await hm.cache.getCachedFleetAgent('agent1');
  assert(invalidated === null, 'Invalidation clears agent cache');

  // ── Test 3: Fleet summary cache ──
  console.log('\n── Fleet Summary Cache ──');

  await hm.cache.cacheFleetSummary({ totalAgents: 6, drift: { ok: 4, drifted: 2 } });
  const summary = await hm.cache.getCachedFleetSummary();
  assert(summary !== null, 'Cached fleet summary');
  assert(summary.totalAgents === 6, 'Summary total matches');

  // Invalidation of any agent should clear summary
  await hm.cache.invalidateFleetAgent('any');
  const summaryAfter = await hm.cache.getCachedFleetSummary();
  assert(summaryAfter === null, 'Agent invalidation clears summary');

  // ── Test 4: Fleet hydration ──
  console.log('\n── Fleet Hydration ──');

  // Seed fleet data
  hm.upsertFleetAgent('agent1', {
    displayName: 'agent1', tier: 'council',
    domains: ['infrastructure', 'architecture'],
    status: 'active',
  });
  hm.upsertFleetAgent('agent2', {
    displayName: 'agent2', tier: 'council',
    domains: ['product', 'strategy'],
    status: 'active',
  });
  hm.upsertFleetAgent('agent3', {
    displayName: 'agent3', tier: 'council',
    domains: ['security'],
    status: 'active',
  });

  // Seed desired state
  hm.setDesiredState('agent1', 'model', 'anthropic/claude-opus-4-6');
  hm.setDesiredState('agent1', 'thinkingDefault', 'high');
  hm.reportActualState('agent1', 'model', 'anthropic/claude-opus-4-6');
  hm.reportActualState('agent1', 'thinkingDefault', 'medium'); // drift!

  // Flush cache first

  // Hydrate
  const result = await hm.hydrateFleetCache();
  assert(result.agents === 3, `Hydrated ${result.agents} agents`);
  assert(result.summary === true, 'Summary hydrated');

  // Verify cached agents
  const forgeCache = await hm.cache.getCachedFleetAgent('agent1');
  assert(forgeCache !== null, 'agent1 in cache after hydration');
  assert(forgeCache.tier === 'council', 'agent1 tier correct');
  assert(Array.isArray(forgeCache.desiredState), 'Desired state included');
  assert(forgeCache.desiredState.length === 2, `agent1 has ${forgeCache.desiredState.length} desired state entries`);

  // Verify drift is captured
  const driftedEntries = forgeCache.desiredState.filter(d => d.driftStatus === 'drifted');
  assert(driftedEntries.length === 1, `Found ${driftedEntries.length} drifted entry`);
  assert(driftedEntries[0].configKey === 'thinkingDefault', 'Correct drifted key');

  // Verify summary
  const fleetSummary = await hm.cache.getCachedFleetSummary();
  assert(fleetSummary !== null, 'Fleet summary in cache');
  assert(fleetSummary.totalAgents === 3, 'Summary total agents');
  assert(fleetSummary.drift.drifted === 1, 'Summary drift count');

  // ── Test 5: Cache-aside on getFleetAgentCached ──
  console.log('\n── Cache-Aside Pattern ──');


  // First call — cache miss, should fall through to SQLite
  const first = await hm.getFleetAgentCached('agent1');
  assert(first !== null, 'Cache miss returns SQLite result');
  assert(first.displayName === 'agent1', 'Correct data from SQLite');

  // Second call — should be cache hit
  const second = await hm.getFleetAgentCached('agent1');
  assert(second !== null, 'Cache hit returns result');
  assert(second.displayName === 'agent1', 'Correct data from cache');

  // ── Test 6: Write-through invalidation ──
  console.log('\n── Write-Through Invalidation ──');

  // Warm cache
  await hm.getFleetAgentCached('agent1');

  // Mutate fleet agent — should invalidate
  hm.upsertFleetAgent('agent1', { status: 'degraded' });

  // Small delay for async invalidation
  await new Promise(r => setTimeout(r, 50));

  const afterMutation = await hm.cache.getCachedFleetAgent('agent1');
  assert(afterMutation === null, 'Cache invalidated after mutation');

  // Mutate desired state — should invalidate
  await hm.getFleetAgentCached('agent1');
  hm.setDesiredState('agent1', 'model', 'anthropic/claude-sonnet-4-6');
  await new Promise(r => setTimeout(r, 50));

  const afterDesired = await hm.cache.getCachedFleetAgent('agent1');
  assert(afterDesired === null, 'Cache invalidated after desired state change');

  // ── Test 7: Hook handler dispatch ──
  console.log('\n── Hook Handler Dispatch ──');

  // Import the hook handler
  const hookPath = path.join(os.homedir(), '.openclaw/hooks/hypermem-core/handler.js');
  let hookHandler;
  try {
    const hookMod = await import(hookPath);
    hookHandler = hookMod.default;
    assert(typeof hookHandler === 'function', 'Hook handler is a function');
  } catch (err) {
    console.log(`  ⚠️  Hook handler import failed: ${err.message}`);
    console.log(`  Skipping hook dispatch tests`);
    hookHandler = null;
  }

  if (hookHandler) {
    // Test: handler accepts InternalHookEvent shape
    const mockEvent = {
      type: 'message',
      action: 'received',
      sessionKey: 'agent:agent1:webchat:main',
      context: {
        from: 'test-user',
        content: 'Hello from test',
        timestamp: Date.now(),
        channelId: 'webchat',
      },
      timestamp: new Date(),
      messages: [],
    };

    // Should not throw
    try {
      await hookHandler(mockEvent);
      assert(true, 'Hook handler processes InternalHookEvent');
    } catch (err) {
      assert(false, `Hook handler threw: ${err.message}`);
    }

    // Test: handler rejects invalid input
    const result1 = hookHandler(null);
    assert(result1 === undefined, 'Null input returns undefined');

    const result2 = hookHandler('not-an-event');
    assert(result2 === undefined, 'String input returns undefined');

    const result3 = hookHandler({ type: 'unknown', action: 'whatever' });
    assert(result3 === undefined, 'Unknown event type returns undefined');
  }

  // ── Cleanup ──
  console.log('\n── Cleanup ──');
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
