/**
 * HyperMem 0.9.0 adaptive context lifecycle policy tests.
 *
 * These tests lock the pure policy kernel before wiring it into compose,
 * afterTurn, recall, and eviction paths. The kernel is the single source of
 * pressure-band decisions so 0.9.0 does not grow independent trim heuristics.
 */

import {
  resolveAdaptiveLifecyclePolicy,
  resolveAdaptiveEvictionPlan,
} from '../dist/adaptive-lifecycle.js';
import { resolveTrimBudgets } from '../dist/budget-policy.js';

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

console.log('\n── Scenario 1: cold /new emits breadcrumb package and recall surge ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    explicitNewSession: true,
    userTurnCount: 0,
    pressureFraction: 0.10,
  });

  assert(policy.band === 'bootstrap', `band bootstrap (got ${policy.band})`);
  assert(policy.emitBreadcrumbPackage === true, 'breadcrumb package enabled for /new');
  assert(policy.smartRecallMultiplier === 1.5, `smart recall surge 1.5 (got ${policy.smartRecallMultiplier})`);
  assert(policy.warmHistoryBudgetFraction === 0.55,
    `bootstrap keeps largest warm history lane (got ${policy.warmHistoryBudgetFraction})`);
}

console.log('\n── Scenario 2: early warmup widens history without compaction ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 3,
    usedTokens: 20_000,
    effectiveBudget: 100_000,
  });

  assert(policy.band === 'warmup', `band warmup (got ${policy.band})`);
  assert(policy.smartRecallMultiplier === 1.25,
    `warmup recall multiplier 1.25 (got ${policy.smartRecallMultiplier})`);
  assert(policy.triggerProactiveCompaction === false, 'warmup does not trigger proactive compaction');
  assert(policy.enableTopicCentroidEviction === false, 'warmup does not enable centroid eviction');
}

console.log('\n── Scenario 3: steady pressure preserves existing trim target ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 20,
    pressureFraction: 0.64,
  });

  assert(policy.band === 'steady', `band steady below 65% (got ${policy.band})`);
  assert(policy.trimSoftTarget === 0.65, `steady trim target stays 0.65 (got ${policy.trimSoftTarget})`);
  assert(policy.compactionTargetFraction === 0.62,
    `steady compaction target 0.62 (got ${policy.compactionTargetFraction})`);
}

console.log('\n── Scenario 4: elevated pressure enables topic-centroid eviction only ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 20,
    pressureFraction: 0.70,
  });

  assert(policy.band === 'elevated', `band elevated at 70% (got ${policy.band})`);
  assert(policy.enableTopicCentroidEviction === true, 'elevated enables centroid eviction');
  assert(policy.triggerProactiveCompaction === false, 'elevated does not yet trigger compaction');
  assert(policy.warmHistoryBudgetFraction < 0.40, 'elevated narrows warm history lane');
}

console.log('\n── Scenario 5: high pressure gates recall and triggers compaction ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 20,
    pressureFraction: 0.80,
  });

  assert(policy.band === 'high', `band high at 80% (got ${policy.band})`);
  assert(policy.triggerProactiveCompaction === true, 'high pressure triggers proactive compaction');
  assert(policy.smartRecallMultiplier < 1, `high pressure gates recall (got ${policy.smartRecallMultiplier})`);
  assert(policy.trimSoftTarget === 0.54, `high pressure trim target 0.54 (got ${policy.trimSoftTarget})`);
}

console.log('\n── Scenario 6: critical pressure is stricter than high ──');
{
  const high = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.80 });
  const critical = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.91 });

  assert(critical.band === 'critical', `band critical above 85% (got ${critical.band})`);
  assert(critical.warmHistoryBudgetFraction < high.warmHistoryBudgetFraction,
    'critical narrows warm history more than high');
  assert(critical.compactionTargetFraction < high.compactionTargetFraction,
    'critical compaction target is stricter than high');
}

console.log('\n── Scenario 7: topic shift surges recall without overriding pressure band ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 12,
    pressureFraction: 0.70,
    topicShiftConfidence: 0.90,
  });

  assert(policy.band === 'elevated', `topic shift preserves pressure band (got ${policy.band})`);
  assert(policy.smartRecallMultiplier === 1.5,
    `topic shift recall surge 1.5 (got ${policy.smartRecallMultiplier})`);
  assert(policy.reasons.some(r => r.startsWith('topic-shift:')), 'topic shift reason recorded');
}

console.log('\n── Scenario 8: invalid budget inputs are safe ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({ usedTokens: 5_000, effectiveBudget: 0, userTurnCount: 10 });
  assert(policy.pressureFraction === 0, `zero budget pressure clamps to 0 (got ${policy.pressureFraction})`);
  assert(policy.band === 'steady', `zero budget with established session is steady (got ${policy.band})`);
}

console.log('\n── Scenario 9: lifecycle trim target can drive shared trim budgets ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.80 });
  const budgets = resolveTrimBudgets(100_000, { trimSoftTarget: policy.trimSoftTarget });

  assert(policy.trimSoftTarget === 0.54, `high-pressure lifecycle trim target 0.54 (got ${policy.trimSoftTarget})`);
  assert(budgets.softBudget === 54_000, `adaptive soft budget 54k (got ${budgets.softBudget})`);
  assert(budgets.triggerBudget === 56_700, `growth trigger follows adaptive soft budget (got ${budgets.triggerBudget})`);
  assert(budgets.targetBudget === 48_600, `headroom target follows adaptive soft budget (got ${budgets.targetBudget})`);
}

console.log('\n── Scenario 10: adaptive eviction plan tracks band, no extra thresholds ──');
{
  // bootstrap/warmup/steady preserve historical eviction order.
  for (const band of ['bootstrap', 'warmup', 'steady']) {
    const plan = resolveAdaptiveEvictionPlan(band);
    assert(plan.band === band, `${band}: plan.band matches`);
    assert(plan.preferTopicAwareDrop === false,
      `${band}: does NOT prefer topic-aware drop (preserves baseline order)`);
    assert(plan.steps[plan.steps.length - 1] === 'oldest-cluster-drop',
      `${band}: ends in oldest-cluster-drop`);
    assert(!plan.steps.includes('topic-aware-cluster-drop'),
      `${band}: baseline plan does NOT include topic-aware-cluster-drop`);
  }

  // elevated/high/critical promote topic-aware drop before oldest-first.
  for (const band of ['elevated', 'high', 'critical']) {
    const plan = resolveAdaptiveEvictionPlan(band);
    assert(plan.band === band, `${band}: plan.band matches`);
    assert(plan.preferTopicAwareDrop === true,
      `${band}: prefers topic-aware drop before oldest-first`);
    const tIdx = plan.steps.indexOf('topic-aware-cluster-drop');
    const oIdx = plan.steps.indexOf('oldest-cluster-drop');
    assert(tIdx >= 0 && oIdx >= 0 && tIdx < oIdx,
      `${band}: topic-aware-cluster-drop ordered before oldest-cluster-drop`);
    // Ballast steps run first (no parallel pressure brain).
    assert(plan.steps[0] === 'tool-gradient',
      `${band}: ballast reduction (tool-gradient) runs first`);
    assert(plan.preferBallastFirst === true,
      `${band}: ballast-first remains the default for the cluster-drop pass`);
  }
}

console.log('\n── Scenario 11: lifecycle policy carries the eviction plan derived from band ──');
{
  const steady = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.50 });
  const elevated = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.70 });
  const high = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.80 });
  const critical = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.92 });

  assert(steady.evictionPlan && steady.evictionPlan.band === 'steady',
    'steady policy attaches band-derived eviction plan');
  assert(steady.evictionPlan.preferTopicAwareDrop === false,
    'steady eviction plan keeps historical order');
  assert(elevated.evictionPlan.preferTopicAwareDrop === true,
    'elevated eviction plan promotes topic-aware drop');
  assert(high.evictionPlan.preferTopicAwareDrop === true,
    'high eviction plan promotes topic-aware drop');
  assert(critical.evictionPlan.preferTopicAwareDrop === true,
    'critical eviction plan promotes topic-aware drop');

  // No new pressure constants leak onto the policy: all band-sensitive
  // decisions stay routed through the existing fields. Spot-check shape.
  const keys = Object.keys(steady).sort();
  const expected = [
    'band', 'compactionTargetFraction', 'emitBreadcrumbPackage',
    'enableTopicCentroidEviction', 'evictionPlan', 'pressureFraction',
    'pressurePct', 'reasons', 'smartRecallMultiplier', 'triggerProactiveCompaction',
    'trimSoftTarget', 'warmHistoryBudgetFraction',
  ].sort();
  assert(JSON.stringify(keys) === JSON.stringify(expected),
    `policy shape unchanged except for evictionPlan addition (got ${keys.join(',')})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
