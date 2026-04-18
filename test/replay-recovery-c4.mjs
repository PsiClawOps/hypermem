import {
  decideReplayRecovery,
  REPLAY_RECOVERY_POLICY,
} from '../dist/replay-recovery.js';

let failures = 0;

function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`  ❌ ${message}`);
  } else {
    console.log(`  ✅ ${message}`);
  }
}

console.log('');
console.log('── HyperMem Phase C4: Replay Recovery Isolation ──');

{
  const decision = decideReplayRecovery({
    currentState: null,
    runtimeTokens: 112_000,
    redisTokens: 0,
    effectiveBudget: 128_000,
  });

  assert(decision.active, 'cold restart enters replay recovery');
  assert(decision.shouldSkipCacheReplay, 'cache replay is disabled while entering');
  assert(decision.trimTargetOverride === REPLAY_RECOVERY_POLICY.enterTrimTarget, 'entering uses bounded trim target');
  assert(decision.historyDepthCap === REPLAY_RECOVERY_POLICY.historyDepthCap, 'entering caps history depth');
  assert(decision.emittedMarker?.state === 'entering', 'entering marker emitted');
  assert(decision.emittedMarker?.reason === 'replay_cold_redis', 'entering marker uses canonical reason');
  assert(decision.nextState === 'stabilizing', 'entering advances persistent state to stabilizing');
}

{
  const decision = decideReplayRecovery({
    currentState: 'stabilizing',
    runtimeTokens: 94_000,
    redisTokens: 2_000,
    effectiveBudget: 128_000,
  });

  assert(decision.active, 'stabilizing remains active while window is still hot');
  assert(decision.shouldSkipCacheReplay, 'stabilizing still skips cache replay');
  assert(decision.trimTargetOverride === REPLAY_RECOVERY_POLICY.stabilizingTrimTarget, 'stabilizing uses bounded trim target');
  assert(decision.emittedMarker?.state === 'stabilizing', 'stabilizing marker emitted');
  assert(decision.emittedMarker?.reason === 'replay_stabilizing', 'stabilizing marker uses canonical reason');
  assert(decision.nextState === 'stabilizing', 'stabilizing persists until recovered');
}

{
  const decision = decideReplayRecovery({
    currentState: 'stabilizing',
    runtimeTokens: 54_000,
    redisTokens: 32_000,
    effectiveBudget: 128_000,
  });

  assert(!decision.active, 'replay recovery exits after stabilization');
  assert(!decision.shouldSkipCacheReplay, 'exit returns cache replay to normal behavior');
  assert(decision.emittedMarker?.state === 'exited', 'exit marker emitted');
  assert(decision.emittedMarker?.reason === 'replay_exited', 'exit marker uses canonical reason');
  assert(decision.nextState === null, 'exit clears persistent replay state');
}

{
  const decision = decideReplayRecovery({
    currentState: null,
    runtimeTokens: 41_000,
    redisTokens: 36_000,
    effectiveBudget: 128_000,
  });

  assert(!decision.active, 'steady-state turn does not enter replay recovery');
  assert(decision.emittedMarker == null, 'steady-state turn emits no replay marker');
  assert(decision.nextState === null, 'steady-state turn leaves replay state unset');
}

if (failures > 0) {
  console.error(`\nReplay recovery test failed with ${failures} assertion(s).`);
  process.exit(1);
}

console.log('\nAll replay recovery assertions passed.');
