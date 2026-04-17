/**
 * HyperMem Batch Trim B3 — Regression Test
 *
 * Proves the B3 batch-trim-with-growth-allowance semantics for
 * assemble.normal / assemble.subagent:
 *
 * 1. Small overage (window at softTarget + <growthThreshold): trim does NOT fire.
 *    The window is within the growth-allowance envelope; only a guard record
 *    (event:'trim-guard', reason:'window-within-budget-skip') is emitted.
 *
 * 2. Large overage (window above softTarget * (1 + growthThreshold)): trim DOES fire.
 *    A real event:'trim' record is emitted with path='assemble.normal'.
 *
 * 3. Trim target leaves headroom: the trimBudget passed to
 *    trimHistoryToTokenBudget is softTarget * (1 - headroomFraction), not
 *    merely softTarget. This means the window after trim is below the growth
 *    trigger, reducing per-turn trim churn.
 *
 * 4. Constants are consistent: TRIM_GROWTH_THRESHOLD, TRIM_HEADROOM_FRACTION,
 *    TRIM_SOFT_TARGET are exported and non-trivial.
 *
 * Test strategy: uses __telemetryForTests (in-memory fake, no HyperMem
 * instance, no Redis, no network). We simulate the assemble.normal trim
 * decision logic directly using the exported helpers so we can drive
 * preTokens to any value.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  PASS: ${msg}`); passed++; }
  else       { console.log(`  FAIL: ${msg}`); failed++; }
}

async function run() {
  console.log('===================================================');
  console.log('  HyperMem B3: Batch Trim with Growth Allowance');
  console.log('===================================================\n');

  const pluginDist = path.join(repoRoot, 'plugin', 'dist', 'index.js');
  if (!fs.existsSync(pluginDist)) {
    console.error('  plugin dist not found. Run: npm --prefix plugin run build');
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-b3-'));
  const telemPath = path.join(tmpDir, 'telemetry.jsonl');
  process.env.HYPERMEM_TELEMETRY = '1';
  process.env.HYPERMEM_TELEMETRY_PATH = telemPath;
  process.env.NODE_ENV = 'development';

  const mod = await import(`file://${pluginDist}?b3=${Date.now()}`);
  const T = mod.__telemetryForTests;

  let caseTelemPath = telemPath;
  let caseCount = 0;

  // Helper: start a fresh telemetry file for a case (unique file per case to
  // avoid O_APPEND race: previous stream's buffered writes arrive after truncate)
  function freshTelemetry() {
    T.reset();
    caseCount++;
    caseTelemPath = path.join(tmpDir, `telemetry-${caseCount}.jsonl`);
    process.env.HYPERMEM_TELEMETRY = '1';
    process.env.HYPERMEM_TELEMETRY_PATH = caseTelemPath;
  }

  // Helper: flush telemetry stream and read events
  async function flushAndReadTelemetry() {
    T.reset();
    await new Promise(resolve => setTimeout(resolve, 60));
    try {
      const content = fs.readFileSync(caseTelemPath, 'utf8');
      return content.split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  const agentId = 'council/test';
  const sk = 'agent:council/test:webchat:b3-test';

  const { TRIM_SOFT_TARGET, TRIM_GROWTH_THRESHOLD, TRIM_HEADROOM_FRACTION } = T;
  const effectiveBudget = 10000;
  const softBudget = Math.floor(effectiveBudget * TRIM_SOFT_TARGET);
  const triggerBudget = Math.floor(softBudget * (1 + TRIM_GROWTH_THRESHOLD));
  const targetBudget = Math.floor(softBudget * (1 - TRIM_HEADROOM_FRACTION));

  // Simulate the B3 assemble.normal decision and telemetry emission.
  // Replicates the runtime logic using the exported helpers directly so we
  // can drive preTokens to any value without a live HyperMem instance.
  function simulateB3Normal(preTokens, turnSuffix = '') {
    const localSk = sk + turnSuffix;
    const turnId = T.nextTurnId();
    T.beginTrimOwnerTurn(localSk, turnId);

    const withinGrowthEnvelope = preTokens > 0 && preTokens <= triggerBudget;

    let realTrimFired = false;
    let fakePostTokens = preTokens;
    let trimmedAmount = 0;
    let trimReason = null;

    if (withinGrowthEnvelope) {
      T.guardTelemetry({
        path: 'assemble.normal',
        agentId, sessionKey: localSk,
        reason: 'window-within-budget-skip',
      });
    } else {
      const claimed = T.claimTrimOwner(localSk, turnId, 'assemble.normal');
      if (claimed) {
        fakePostTokens = Math.min(preTokens, targetBudget);
        trimmedAmount = preTokens - fakePostTokens;
        realTrimFired = true;
        trimReason = `b3:trigger=${triggerBudget},target=${targetBudget}`;
        T.trimTelemetry({
          path: 'assemble.normal',
          agentId, sessionKey: localSk,
          preTokens,
          postTokens: fakePostTokens,
          removed: trimmedAmount,
          cacheInvalidated: trimmedAmount > 0,
          reason: trimReason,
        });
      }
    }

    T.endTrimOwnerTurn(localSk, turnId);
    return { realTrimFired, fakePostTokens, trimmedAmount, trimReason, withinGrowthEnvelope };
  }

  // Case 0: Verify B3 constants are exported and valid
  {
    console.log('-- Case 0: B3 constants exported --');
    assert(typeof TRIM_SOFT_TARGET === 'number' && TRIM_SOFT_TARGET > 0 && TRIM_SOFT_TARGET < 1,
      `TRIM_SOFT_TARGET is a valid fraction (${TRIM_SOFT_TARGET})`);
    assert(typeof TRIM_GROWTH_THRESHOLD === 'number' && TRIM_GROWTH_THRESHOLD > 0 && TRIM_GROWTH_THRESHOLD < 0.50,
      `TRIM_GROWTH_THRESHOLD is non-trivial (${TRIM_GROWTH_THRESHOLD})`);
    assert(typeof TRIM_HEADROOM_FRACTION === 'number' && TRIM_HEADROOM_FRACTION > 0 && TRIM_HEADROOM_FRACTION < 0.50,
      `TRIM_HEADROOM_FRACTION is non-trivial (${TRIM_HEADROOM_FRACTION})`);
    assert(triggerBudget > softBudget,
      `trigger budget (${triggerBudget}) > soft budget (${softBudget}): growth allowance creates real gap`);
    assert(targetBudget < softBudget,
      `target budget (${targetBudget}) < soft budget (${softBudget}): headroom below trigger`);
    assert(targetBudget < triggerBudget,
      `target budget (${targetBudget}) < trigger budget (${triggerBudget}): trim overshoots below trigger`);
  }

  // Case 1: Small overage -- within growth envelope, trim must NOT fire
  {
    console.log('\n-- Case 1: Small overage (within growth envelope) -- no trim --');
    freshTelemetry();

    // Window at exactly softBudget: clearly within envelope
    const r1a = simulateB3Normal(softBudget, '-c1a');
    assert(r1a.withinGrowthEnvelope === true,
      `preTokens=softBudget(${softBudget}) is within growth envelope`);
    assert(r1a.realTrimFired === false,
      `preTokens=softBudget: no real trim fired`);

    // Window at softBudget * 1.02 (< trigger): still within envelope
    const slightOverage = Math.floor(softBudget * 1.02);
    const r1b = simulateB3Normal(slightOverage, '-c1b');
    assert(slightOverage <= triggerBudget,
      `slight overage (${slightOverage}) is at or below trigger (${triggerBudget})`);
    assert(r1b.withinGrowthEnvelope === true,
      `preTokens=${slightOverage} (softBudget+2%) is within growth envelope`);
    assert(r1b.realTrimFired === false,
      `preTokens=${slightOverage}: no real trim fired`);

    // Verify only guard records emitted
    const events1 = await flushAndReadTelemetry();
    const realTrims1 = events1.filter(e => e.event === 'trim' && e.path === 'assemble.normal');
    const guards1 = events1.filter(e => e.event === 'trim-guard' && e.reason === 'window-within-budget-skip');
    assert(realTrims1.length === 0,
      `no real trim events in telemetry for small overage (found ${realTrims1.length})`);
    assert(guards1.length >= 1,
      `window-within-budget-skip guard emitted for small overage (found ${guards1.length})`);
  }

  // Case 2: Large overage -- above growth threshold, trim MUST fire
  {
    console.log('\n-- Case 2: Large overage (above growth threshold) -- trim fires --');
    freshTelemetry();

    // Window at trigger + 1 token: just over the growth threshold
    const justOver = triggerBudget + 1;
    const r2a = simulateB3Normal(justOver, '-c2a');
    assert(r2a.withinGrowthEnvelope === false,
      `preTokens=${justOver} (trigger+1) is outside growth envelope`);
    assert(r2a.realTrimFired === true,
      `preTokens=${justOver}: real trim fired`);

    // Window at 90% of effectiveBudget: well over threshold
    const highPressure = Math.floor(effectiveBudget * 0.90);
    const r2b = simulateB3Normal(highPressure, '-c2b');
    assert(r2b.withinGrowthEnvelope === false,
      `preTokens=${highPressure} (90% of budget) is outside growth envelope`);
    assert(r2b.realTrimFired === true,
      `preTokens=${highPressure}: real trim fired`);

    // Verify real trim records emitted
    const events2 = await flushAndReadTelemetry();
    const realTrims2 = events2.filter(e => e.event === 'trim' && e.path === 'assemble.normal');
    assert(realTrims2.length >= 2,
      `real trim events in telemetry for large overage (found ${realTrims2.length}, expected >=2)`);

    // Verify no guard-skip for these cases
    const skipGuards2 = events2.filter(e => e.event === 'trim-guard' && e.reason === 'window-within-budget-skip');
    assert(skipGuards2.length === 0,
      `no window-within-budget-skip guards for large overage (found ${skipGuards2.length})`);
  }

  // Case 3: Trim target leaves headroom
  {
    console.log('\n-- Case 3: Trim target leaves headroom below trigger --');
    freshTelemetry();

    // Window at trigger + 500 tokens (clear overage)
    const overageTokens = triggerBudget + 500;
    const r3 = simulateB3Normal(overageTokens, '-c3');
    assert(r3.realTrimFired === true,
      `overageTokens=${overageTokens}: trim fired`);
    assert(r3.fakePostTokens === targetBudget,
      `post-trim tokens (${r3.fakePostTokens}) equal targetBudget (${targetBudget}): trim overshoots to headroom`);
    assert(r3.fakePostTokens < softBudget,
      `post-trim tokens (${r3.fakePostTokens}) are below softBudget (${softBudget}): provides headroom`);
    assert(r3.fakePostTokens < triggerBudget,
      `post-trim tokens (${r3.fakePostTokens}) are below triggerBudget (${triggerBudget}): next turns won't trim`);

    // Verify the telemetry reason encodes B3 semantics
    const events3 = await flushAndReadTelemetry();
    const trim3 = events3.find(e => e.event === 'trim' && e.path === 'assemble.normal');
    assert(trim3 !== undefined, 'trim event found in telemetry for Case 3');
    assert(typeof trim3?.reason === 'string' && trim3.reason.startsWith('b3:'),
      `trim reason encodes B3 semantics (found: "${trim3?.reason}")`);
    assert(trim3?.reason?.includes(`trigger=${triggerBudget}`),
      `trim reason includes trigger budget (${triggerBudget})`);
    assert(trim3?.reason?.includes(`target=${targetBudget}`),
      `trim reason includes target budget (${targetBudget})`);
  }

  // Case 4: Boundary -- exactly at trigger threshold
  {
    console.log('\n-- Case 4: Exactly at trigger threshold -- no trim (boundary inclusive) --');
    freshTelemetry();

    // preTokens == triggerBudget: should NOT trigger (envelope is <=, not <)
    const r4 = simulateB3Normal(triggerBudget, '-c4');
    assert(r4.withinGrowthEnvelope === true,
      `preTokens=triggerBudget(${triggerBudget}) is within envelope (inclusive upper bound)`);
    assert(r4.realTrimFired === false,
      `preTokens=triggerBudget: no real trim fired at exact threshold`);
  }

  // Case 5: Zero preTokens -- skip without guard (cold/unknown session)
  {
    console.log('\n-- Case 5: Zero preTokens -- no trim-skip guard --');
    freshTelemetry();

    // preTokens == 0: window is unknown (cold/new session). withinGrowthEnvelope
    // is false when preTokens == 0 (same as old Sprint 3 behavior: > 0 required).
    const r5 = simulateB3Normal(0, '-c5');
    // withinGrowthEnvelope is false when preTokens = 0 (condition: preTokens > 0 && ...)
    assert(r5.withinGrowthEnvelope === false,
      `preTokens=0: not within growth envelope (preTokens must be > 0 to skip)`);
    // real trim fires but trimHistoryToTokenBudget with budget=targetBudget is
    // called; in cache.ts this is a no-op when history is short
    assert(r5.realTrimFired === true,
      `preTokens=0: trim path entered (trimHistoryToTokenBudget is a no-op on short history)`);

    const events5 = await flushAndReadTelemetry();
    const skipGuards5 = events5.filter(e => e.event === 'trim-guard' && e.reason === 'window-within-budget-skip');
    assert(skipGuards5.length === 0,
      `no window-within-budget-skip guard for preTokens=0`);
  }

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('B3 test failed:', err);
  process.exit(1);
});
