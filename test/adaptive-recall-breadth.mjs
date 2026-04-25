/**
 * HyperMem 0.9.0 adaptive recall breadth tests.
 *
 * Locks the contract that semantic recall budget and candidate limit are
 * scaled exclusively by the adaptive lifecycle policy's smartRecallMultiplier:
 *   - /new or topic-shift surge → wider recall
 *   - bootstrap / warmup       → moderately wider recall
 *   - steady / elevated        → unchanged from base 0.12 / 0.10 / limit=10
 *   - high                     → narrower recall
 *   - critical                 → narrower recall, harder
 *
 * Also asserts the includeSemanticRecall=false bypass remains intact: even
 * with a surge multiplier, the helper produces values that compose() does
 * not consume because that gate is checked before recall runs.
 */

import { resolveAdaptiveLifecyclePolicy } from '../dist/adaptive-lifecycle.js';
import { scaleRecallBreadth, RECALL_BREADTH_BASE } from '../dist/compositor.js';
import { HyperMem } from '../dist/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

const BASE_REMAINING = 10_000;

// Compose the recall breadth a compose() pass would derive from a policy.
function recallFor(policyInput) {
  const policy = resolveAdaptiveLifecyclePolicy(policyInput);
  const breadth = scaleRecallBreadth(BASE_REMAINING, policy.smartRecallMultiplier);
  return { policy, breadth };
}

console.log('\n── Scenario 1: steady baseline preserves prior recall envelope ──');
{
  const { policy, breadth } = recallFor({ userTurnCount: 20, pressureFraction: 0.50 });
  assert(policy.band === 'steady', `band steady (got ${policy.band})`);
  assert(policy.smartRecallMultiplier === 1.0, 'steady multiplier=1.0');
  assert(breadth.mainBudgetTokens === Math.floor(BASE_REMAINING * 0.12),
    `steady main budget == base 12% (got ${breadth.mainBudgetTokens})`);
  assert(breadth.fallbackBudgetTokens === Math.floor(BASE_REMAINING * 0.10),
    `steady fallback budget == base 10% (got ${breadth.fallbackBudgetTokens})`);
  assert(breadth.candidateLimit === RECALL_BREADTH_BASE.candidateLimit,
    `steady candidate limit == 10 (got ${breadth.candidateLimit})`);
}

console.log('\n── Scenario 2: elevated preserves baseline recall envelope ──');
{
  const { policy, breadth } = recallFor({ userTurnCount: 20, pressureFraction: 0.70 });
  assert(policy.band === 'elevated', `band elevated (got ${policy.band})`);
  assert(policy.smartRecallMultiplier === 1.0, 'elevated multiplier=1.0');
  assert(breadth.mainBudgetTokens === Math.floor(BASE_REMAINING * 0.12),
    'elevated main budget unchanged');
  assert(breadth.candidateLimit === 10, 'elevated candidate limit unchanged');
}

console.log('\n── Scenario 3: explicit /new widens recall token budget and candidate limit ──');
{
  const { policy: steadyPolicy, breadth: steady } = recallFor({ userTurnCount: 20, pressureFraction: 0.50 });
  const { policy, breadth } = recallFor({
    explicitNewSession: true,
    userTurnCount: 0,
    pressureFraction: 0.10,
  });
  assert(policy.band === 'bootstrap', `band bootstrap (got ${policy.band})`);
  assert(policy.smartRecallMultiplier === 1.5, 'explicit /new surge multiplier=1.5');
  assert(breadth.mainBudgetTokens > steady.mainBudgetTokens,
    `/new widens main recall budget (${breadth.mainBudgetTokens} > ${steady.mainBudgetTokens})`);
  assert(breadth.fallbackBudgetTokens > steady.fallbackBudgetTokens,
    '/new widens fallback recall budget');
  assert(breadth.candidateLimit > steady.candidateLimit,
    `/new widens candidate limit (${breadth.candidateLimit} > ${steady.candidateLimit})`);
  assert(breadth.candidateLimit <= RECALL_BREADTH_BASE.candidateLimitMax,
    'candidate limit clamped to max');
  void steadyPolicy;
}

console.log('\n── Scenario 4: warmup widens moderately, less than /new ──');
{
  const { breadth: surge } = recallFor({ explicitNewSession: true, userTurnCount: 0, pressureFraction: 0 });
  const { policy, breadth } = recallFor({ userTurnCount: 3, pressureFraction: 0.20 });
  assert(policy.band === 'warmup', `band warmup (got ${policy.band})`);
  assert(policy.smartRecallMultiplier === 1.25, 'warmup multiplier=1.25');
  assert(breadth.mainBudgetTokens > Math.floor(BASE_REMAINING * 0.12),
    'warmup widens main recall budget vs steady');
  assert(breadth.mainBudgetTokens < surge.mainBudgetTokens,
    'warmup widens less than /new surge');
}

console.log('\n── Scenario 5: high pressure narrows recall budget and candidate limit ──');
{
  const { breadth: steady } = recallFor({ userTurnCount: 20, pressureFraction: 0.50 });
  const { policy, breadth } = recallFor({ userTurnCount: 20, pressureFraction: 0.80 });
  assert(policy.band === 'high', `band high (got ${policy.band})`);
  assert(policy.smartRecallMultiplier === 0.85, 'high multiplier=0.85');
  assert(breadth.mainBudgetTokens < steady.mainBudgetTokens,
    `high narrows main budget (${breadth.mainBudgetTokens} < ${steady.mainBudgetTokens})`);
  assert(breadth.fallbackBudgetTokens < steady.fallbackBudgetTokens,
    'high narrows fallback budget');
  assert(breadth.candidateLimit <= steady.candidateLimit,
    `high candidate limit at most steady (${breadth.candidateLimit} <= ${steady.candidateLimit})`);
  assert(breadth.candidateLimit >= RECALL_BREADTH_BASE.candidateLimitMin,
    'high candidate limit above floor');
}

console.log('\n── Scenario 6: critical pressure narrows harder than high ──');
{
  const { breadth: high } = recallFor({ userTurnCount: 20, pressureFraction: 0.80 });
  const { policy, breadth } = recallFor({ userTurnCount: 20, pressureFraction: 0.92 });
  assert(policy.band === 'critical', `band critical (got ${policy.band})`);
  assert(policy.smartRecallMultiplier === 0.65, 'critical multiplier=0.65');
  assert(breadth.mainBudgetTokens < high.mainBudgetTokens,
    `critical narrows harder than high (${breadth.mainBudgetTokens} < ${high.mainBudgetTokens})`);
  assert(breadth.candidateLimit <= high.candidateLimit,
    'critical candidate limit ≤ high candidate limit');
  assert(breadth.candidateLimit >= RECALL_BREADTH_BASE.candidateLimitMin,
    `critical candidate limit clamped to floor (got ${breadth.candidateLimit})`);
}

console.log('\n── Scenario 7: candidate limit clamps respect [6, 16] ──');
{
  const tiny = scaleRecallBreadth(BASE_REMAINING, 0.1);
  const huge = scaleRecallBreadth(BASE_REMAINING, 5.0);
  assert(tiny.candidateLimit === RECALL_BREADTH_BASE.candidateLimitMin,
    `tiny multiplier clamped to floor=${RECALL_BREADTH_BASE.candidateLimitMin} (got ${tiny.candidateLimit})`);
  assert(huge.candidateLimit === RECALL_BREADTH_BASE.candidateLimitMax,
    `huge multiplier clamped to ceiling=${RECALL_BREADTH_BASE.candidateLimitMax} (got ${huge.candidateLimit})`);
}

console.log('\n── Scenario 8: includeSemanticRecall:false bypass invariant ──');
{
  const tmp = await mkdtemp(path.join(tmpdir(), 'hypermem-recall-bypass-'));
  const hm = await HyperMem.create({ dataDir: tmp });
  let calls = 0;

  hm.compositor.buildSemanticRecall = async () => {
    calls++;
    return 'semantic recall should not run';
  };

  const result = await hm.compose({
    agentId: 'adaptive-recall-bypass-agent',
    sessionKey: 'adaptive-recall-bypass-session',
    tokenBudget: 16_000,
    provider: 'anthropic',
    includeHistory: false,
    includeFacts: false,
    includeLibrary: false,
    includeDocChunks: true,
    includeSemanticRecall: false,
    prompt: '/new what do we know about adaptive recall?',
  });

  assert(calls === 0,
    `includeSemanticRecall:false bypasses primary and fallback semantic recall (calls=${calls})`);
  assert(result.diagnostics?.retrievalMode !== 'fallback_knn',
    `includeSemanticRecall:false does not report fallback_knn (mode=${result.diagnostics?.retrievalMode})`);
  assert(result.diagnostics?.adaptiveRecallBudgetTokens === undefined,
    'includeSemanticRecall:false does not set recall budget diagnostics');
  assert(result.diagnostics?.adaptiveRecallCandidateLimit === undefined,
    'includeSemanticRecall:false does not set recall candidate diagnostics');

  await hm.close();
  await rm(tmp, { recursive: true, force: true });
}

console.log('\n── Scenario 9: multiplier source — recall scaling derives only from policy ──');
{
  // Same remaining tokens, two different policies => two different breadths,
  // proving recall breadth tracks the policy multiplier and nothing else.
  const a = scaleRecallBreadth(
    BASE_REMAINING,
    resolveAdaptiveLifecyclePolicy({ explicitNewSession: true }).smartRecallMultiplier,
  );
  const b = scaleRecallBreadth(
    BASE_REMAINING,
    resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.92 }).smartRecallMultiplier,
  );
  assert(a.mainBudgetTokens > b.mainBudgetTokens,
    'recall breadth tracks lifecycle multiplier (surge > critical)');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
