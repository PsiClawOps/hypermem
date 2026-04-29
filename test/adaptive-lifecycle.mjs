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
  isTopicBearingTurn,
  countTopicBearingTurns,
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
  assert(policy.smartRecallMultiplier === 1.75, `smart recall surge 1.75 (got ${policy.smartRecallMultiplier})`);
  assert(policy.warmHistoryBudgetFraction === 0.62,
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
  assert(policy.smartRecallMultiplier === 1.4,
    `warmup recall multiplier 1.4 (got ${policy.smartRecallMultiplier})`);
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
  assert(policy.smartRecallMultiplier === 1.75,
    `topic shift recall surge 1.75 (got ${policy.smartRecallMultiplier})`);
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
    'pressurePct', 'protectedWarmingMetadata', 'reasons', 'smartRecallMultiplier',
    'triggerProactiveCompaction', 'trimSoftTarget', 'warmHistoryBudgetFraction',
  ].sort();
  assert(JSON.stringify(keys) === JSON.stringify(expected),
    `policy shape unchanged except for evictionPlan addition (got ${keys.join(',')})`);
}


console.log('\n── Scenario 12: forked-context children skip cold bootstrap ──');
{
  const lightFork = resolveAdaptiveLifecyclePolicy({
    forkedContext: true,
    userTurnCount: 0,
    pressureFraction: 0.05,
    forkedParentPressureFraction: 0.10,
    forkedParentUserTurnCount: 1,
  });
  const establishedFork = resolveAdaptiveLifecyclePolicy({
    forkedContext: true,
    userTurnCount: 0,
    pressureFraction: 0.05,
    forkedParentPressureFraction: 0.82,
    forkedParentUserTurnCount: 12,
  });
  const inheritedHistoryFork = resolveAdaptiveLifecyclePolicy({
    forkedContext: true,
    userTurnCount: 12,
    pressureFraction: 0.91,
    forkedParentPressureFraction: 0.82,
    forkedParentUserTurnCount: 12,
  });
  const explicitNew = resolveAdaptiveLifecyclePolicy({
    forkedContext: true,
    explicitNewSession: true,
    userTurnCount: 0,
    forkedParentPressureFraction: 0.82,
    forkedParentUserTurnCount: 12,
  });

  assert(lightFork.band === 'warmup', `light parent fork starts warmup (got ${lightFork.band})`);
  assert(lightFork.emitBreadcrumbPackage === false,
    'forked warmup does not emit bootstrap breadcrumb package');
  assert(lightFork.reasons.includes('forked-context'), 'forked-context reason recorded');
  assert(establishedFork.band === 'steady',
    `established/high-pressure parent fork starts steady, not bootstrap/high (got ${establishedFork.band})`);
  assert(establishedFork.triggerProactiveCompaction === false,
    'forked first turn does not trigger child compaction from parent pressure alone');
  assert(inheritedHistoryFork.band === 'steady',
    `forked inherited history is still bounded to steady (got ${inheritedHistoryFork.band})`);
  assert(inheritedHistoryFork.triggerProactiveCompaction === false,
    'forked inherited history does not trigger child compaction before post-fork turns');
  assert(explicitNew.band === 'bootstrap',
    'explicit /new still wins over forked-context seed');
}

console.log('\n── Scenario 13: protected-warming metadata exposed on all bands ──');
{
  const bootstrap = resolveAdaptiveLifecyclePolicy({ userTurnCount: 0, pressureFraction: 0.10 });
  const steady = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.50 });
  const elevated = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.70 });
  const high = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.80 });
  const critical = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.92 });

  assert(bootstrap.protectedWarmingMetadata.isProtected === true,
    'bootstrap protectedWarmingMetadata.isProtected is true');
  assert(bootstrap.protectedWarmingMetadata.floor === 0.372,
    `bootstrap protectedWarmingMetadata.floor is 0.372 (got ${bootstrap.protectedWarmingMetadata.floor})`);
  assert(steady.protectedWarmingMetadata.isProtected === false,
    'steady protectedWarmingMetadata.isProtected is false');
  assert(elevated.protectedWarmingMetadata.isProtected === false,
    'elevated protectedWarmingMetadata.isProtected is false');
  assert(high.protectedWarmingMetadata.isProtected === true,
    'high protectedWarmingMetadata.isProtected is true');
  assert(high.protectedWarmingMetadata.floor === 0.28,
    `high protectedWarmingMetadata.floor is 0.28 (got ${high.protectedWarmingMetadata.floor})`);
  assert(critical.protectedWarmingMetadata.isProtected === true,
    'critical protectedWarmingMetadata.isProtected is true');
  assert(critical.protectedWarmingMetadata.floor === 0.20,
    `critical protectedWarmingMetadata.floor is 0.20 (got ${critical.protectedWarmingMetadata.floor})`);
}

console.log('\n── Scenario 14: lifecycle band warming values match Packet 1 targets ──');
{
  const bootstrap = resolveAdaptiveLifecyclePolicy({ explicitNewSession: true, userTurnCount: 0, pressureFraction: 0.10 });
  const warmup = resolveAdaptiveLifecyclePolicy({ userTurnCount: 2, pressureFraction: 0.30 });
  const steady = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.50 });
  const elevated = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.70 });
  const high = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.80 });
  const critical = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.92 });

  assert(bootstrap.warmHistoryBudgetFraction === 0.62,
    `bootstrap warming 0.62 (got ${bootstrap.warmHistoryBudgetFraction})`);
  assert(warmup.warmHistoryBudgetFraction === 0.55,
    `warmup warming 0.55 (got ${warmup.warmHistoryBudgetFraction})`);
  assert(steady.warmHistoryBudgetFraction === 0.45,
    `steady warming 0.45 (got ${steady.warmHistoryBudgetFraction})`);
  assert(elevated.warmHistoryBudgetFraction === 0.34,
    `elevated warming unchanged at 0.34 (got ${elevated.warmHistoryBudgetFraction})`);
  assert(high.warmHistoryBudgetFraction === 0.28,
    `high warming unchanged at 0.28 (got ${high.warmHistoryBudgetFraction})`);
  assert(critical.warmHistoryBudgetFraction === 0.20,
    `critical warming unchanged at 0.20 (got ${critical.warmHistoryBudgetFraction})`);
}

console.log('\n── Scenario 15: smart recall multipliers match Packet 1 targets ──');
{
  const bootstrap = resolveAdaptiveLifecyclePolicy({ userTurnCount: 0, pressureFraction: 0.10 });
  const warmup = resolveAdaptiveLifecyclePolicy({ userTurnCount: 2, pressureFraction: 0.30 });
  const newSession = resolveAdaptiveLifecyclePolicy({ explicitNewSession: true, userTurnCount: 0, pressureFraction: 0.10 });
  const topicShift = resolveAdaptiveLifecyclePolicy({ userTurnCount: 12, pressureFraction: 0.70, topicShiftConfidence: 0.90 });
  const high = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.80 });
  const critical = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.92 });

  assert(bootstrap.smartRecallMultiplier === 1.4,
    `bootstrap recall multiplier 1.4 (got ${bootstrap.smartRecallMultiplier})`);
  assert(warmup.smartRecallMultiplier === 1.4,
    `warmup recall multiplier 1.4 (got ${warmup.smartRecallMultiplier})`);
  assert(newSession.smartRecallMultiplier === 1.75,
    `/new recall multiplier 1.75 (got ${newSession.smartRecallMultiplier})`);
  assert(topicShift.smartRecallMultiplier === 1.75,
    `topic-shift recall multiplier 1.75 (got ${topicShift.smartRecallMultiplier})`);
  assert(high.smartRecallMultiplier === 0.85,
    `high recall multiplier unchanged at 0.85 (got ${high.smartRecallMultiplier})`);
  assert(critical.smartRecallMultiplier === 0.65,
    `critical recall multiplier unchanged at 0.65 (got ${critical.smartRecallMultiplier})`);
}

console.log('\n── Scenario 16: high and critical bands are not relaxed ──');
{
  const high = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.80 });
  const critical = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, pressureFraction: 0.92 });

  // Warming: high/critical must stay at their historical strict values.
  assert(high.warmHistoryBudgetFraction === 0.28,
    `high warming NOT relaxed (got ${high.warmHistoryBudgetFraction})`);
  assert(critical.warmHistoryBudgetFraction === 0.20,
    `critical warming NOT relaxed (got ${critical.warmHistoryBudgetFraction})`);

  // Trim targets: unchanged.
  assert(high.trimSoftTarget === 0.54,
    `high trim target NOT relaxed (got ${high.trimSoftTarget})`);
  assert(critical.trimSoftTarget === 0.48,
    `critical trim target NOT relaxed (got ${critical.trimSoftTarget})`);

  // Compaction targets: unchanged.
  assert(high.compactionTargetFraction === 0.50,
    `high compaction target NOT relaxed (got ${high.compactionTargetFraction})`);
  assert(critical.compactionTargetFraction === 0.42,
    `critical compaction target NOT relaxed (got ${critical.compactionTargetFraction})`);

  // Recall multipliers: unchanged (strict).
  assert(high.smartRecallMultiplier === 0.85,
    `high recall multiplier NOT relaxed (got ${high.smartRecallMultiplier})`);
  assert(critical.smartRecallMultiplier === 0.65,
    `critical recall multiplier NOT relaxed (got ${critical.smartRecallMultiplier})`);
}

console.log('\n── Scenario 17: forked-context behavior respects band ceilings ──');
{
  // Light fork → warmup (not bootstrap)
  const lightFork = resolveAdaptiveLifecyclePolicy({
    forkedContext: true,
    userTurnCount: 0,
    pressureFraction: 0.05,
    forkedParentPressureFraction: 0.10,
    forkedParentUserTurnCount: 1,
  });
  // Established parent → steady (not high/critical)
  const heavyFork = resolveAdaptiveLifecyclePolicy({
    forkedContext: true,
    userTurnCount: 0,
    pressureFraction: 0.05,
    forkedParentPressureFraction: 0.82,
    forkedParentUserTurnCount: 12,
  });
  // Explicit /new overrides fork
  const explicitNewFork = resolveAdaptiveLifecyclePolicy({
    forkedContext: true,
    explicitNewSession: true,
    userTurnCount: 0,
    forkedParentPressureFraction: 0.82,
    forkedParentUserTurnCount: 12,
  });

  assert(lightFork.band === 'warmup', `light fork → warmup (got ${lightFork.band})`);
  assert(lightFork.warmHistoryBudgetFraction === 0.55,
    `light fork gets warmup warming 0.55 (got ${lightFork.warmHistoryBudgetFraction})`);
  assert(lightFork.smartRecallMultiplier === 1.4,
    `light fork gets warmup recall 1.4 (got ${lightFork.smartRecallMultiplier})`);
  assert(heavyFork.band === 'steady', `heavy fork → steady (got ${heavyFork.band})`);
  assert(heavyFork.warmHistoryBudgetFraction === 0.45,
    `heavy fork gets steady warming 0.45 (got ${heavyFork.warmHistoryBudgetFraction})`);
  assert(heavyFork.triggerProactiveCompaction === false,
    'heavy fork does NOT trigger compaction from parent pressure');
  assert(explicitNewFork.band === 'bootstrap',
    `explicit /new overrides fork → bootstrap (got ${explicitNewFork.band})`);
  assert(explicitNewFork.warmHistoryBudgetFraction === 0.62,
    `explicit /new gets bootstrap warming 0.62 (got ${explicitNewFork.warmHistoryBudgetFraction})`);
  assert(explicitNewFork.smartRecallMultiplier === 1.75,
    `explicit /new gets recall surge 1.75 (got ${explicitNewFork.smartRecallMultiplier})`);
}

console.log('\n── Scenario 18: topic-bearing count extends warmup window to 8 turns ──');
{
  const tb3 = resolveAdaptiveLifecyclePolicy({ userTurnCount: 10, topicBearingTurnCount: 3, pressureFraction: 0.30 });
  const tb8 = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, topicBearingTurnCount: 8, pressureFraction: 0.30 });
  const tb9 = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, topicBearingTurnCount: 9, pressureFraction: 0.30 });

  assert(tb3.band === 'warmup', `topic-bearing 3 with 10 raw turns → warmup (got ${tb3.band})`);
  assert(tb8.band === 'warmup', `topic-bearing 8 → warmup (got ${tb8.band})`);
  assert(tb9.band === 'steady', `topic-bearing 9 → steady (got ${tb9.band})`);
  assert(tb3.warmHistoryBudgetFraction === 0.55, `topic-bearing warmup gets 0.55 warming`);
  assert(tb3.smartRecallMultiplier === 1.4, `topic-bearing warmup gets 1.4 recall`);
}

console.log('\n── Scenario 19: heartbeat/empty/small-talk turns do not extend warmup ──');
{
  // Simulate a session with many raw turns but few topic-bearing turns.
  // The band should stay in warmup because only topic-bearing turns count.
  const manyRawFewTopic = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 15,
    topicBearingTurnCount: 2,
    pressureFraction: 0.30,
  });
  assert(manyRawFewTopic.band === 'warmup',
    `15 raw turns, 2 topic-bearing → warmup (got ${manyRawFewTopic.band})`);

  // With no topic-bearing count provided, falls back to raw userTurnCount (legacy).
  const legacyWarmup = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 2,
    pressureFraction: 0.30,
  });
  assert(legacyWarmup.band === 'warmup',
    `2 raw turns (legacy) → warmup (got ${legacyWarmup.band})`);
}

console.log('\n── Scenario 20: topic-bearing reasons replace early-session reasons ──');
{
  const tb5 = resolveAdaptiveLifecyclePolicy({ userTurnCount: 12, topicBearingTurnCount: 5, pressureFraction: 0.30 });
  const legacy = resolveAdaptiveLifecyclePolicy({ userTurnCount: 3, pressureFraction: 0.30 });

  assert(tb5.reasons.includes('topic-bearing:5'),
    `topic-bearing reason present: ${tb5.reasons.join(', ')}`);
  assert(!tb5.reasons.some(r => r.startsWith('early-session:')),
    `no early-session reason when topic-bearing count provided`);

  assert(legacy.reasons.includes('early-session:3'),
    `legacy early-session reason present: ${legacy.reasons.join(', ')}`);
  assert(!legacy.reasons.some(r => r.startsWith('topic-bearing:')),
    `no topic-bearing reason when count not provided`);
}

console.log('\n── Scenario 21: bootstrap and cold-start with topic-bearing count ──');
{
  const cold = resolveAdaptiveLifecyclePolicy({ userTurnCount: 0, topicBearingTurnCount: 0, pressureFraction: 0.10 });
  assert(cold.band === 'bootstrap', `0 topic-bearing turns → bootstrap (got ${cold.band})`);
  assert(cold.reasons.includes('cold-start'), 'cold-start reason present');

  const explicitNew = resolveAdaptiveLifecyclePolicy({
    explicitNewSession: true,
    userTurnCount: 5,
    topicBearingTurnCount: 5,
    pressureFraction: 0.10,
  });
  assert(explicitNew.band === 'bootstrap', `/new overrides topic-bearing count → bootstrap`);
}

console.log('\n── Scenario 22: Packet 1 values preserved under topic-bearing path ──');
{
  const bootstrap = resolveAdaptiveLifecyclePolicy({ userTurnCount: 0, topicBearingTurnCount: 0, pressureFraction: 0.10 });
  const warmup = resolveAdaptiveLifecyclePolicy({ userTurnCount: 2, topicBearingTurnCount: 2, pressureFraction: 0.30 });
  const steady = resolveAdaptiveLifecyclePolicy({ userTurnCount: 20, topicBearingTurnCount: 10, pressureFraction: 0.50 });
  const newSession = resolveAdaptiveLifecyclePolicy({ explicitNewSession: true, userTurnCount: 0, topicBearingTurnCount: 0, pressureFraction: 0.10 });
  const topicShift = resolveAdaptiveLifecyclePolicy({ userTurnCount: 12, topicBearingTurnCount: 10, pressureFraction: 0.70, topicShiftConfidence: 0.90 });

  assert(bootstrap.warmHistoryBudgetFraction === 0.62, `bootstrap warming preserved`);
  assert(warmup.warmHistoryBudgetFraction === 0.55, `warmup warming preserved`);
  assert(steady.warmHistoryBudgetFraction === 0.45, `steady warming preserved`);
  assert(bootstrap.smartRecallMultiplier === 1.4, `bootstrap recall preserved`);
  assert(warmup.smartRecallMultiplier === 1.4, `warmup recall preserved`);
  assert(newSession.smartRecallMultiplier === 1.75, `/new recall surge preserved`);
  assert(topicShift.smartRecallMultiplier === 1.75, `topic-shift recall surge preserved`);
  assert(bootstrap.protectedWarmingMetadata.isProtected === true, `bootstrap protectedWarmingMetadata preserved`);
  assert(warmup.protectedWarmingMetadata.isProtected === true, `warmup protectedWarmingMetadata preserved`);
}

console.log('\n── Scenario 23: isTopicBearingTurn classifier mirrors plugin semantics ──');
{
  assert(isTopicBearingTurn({ role: 'user', textContent: 'How do I configure Redis?' }) === true,
    'substantive user turn is topic-bearing');
  assert(isTopicBearingTurn({ role: 'user', textContent: 'ok' }) === false,
    'short ack is not topic-bearing');
  assert(isTopicBearingTurn({ role: 'user', textContent: 'Sender (untrusted metadata): {\"sender\":\"gateway-client\"}\n\nok' }) === false,
    'metadata-wrapped short ack is not topic-bearing');
  assert(isTopicBearingTurn({ role: 'user', textContent: 'Sender (untrusted metadata): {\"sender\":\"heartbeat\"}\n\nHEARTBEAT_OK' }) === false,
    'metadata-wrapped heartbeat-like text is not topic-bearing');
  assert(isTopicBearingTurn({ role: 'user', textContent: 'Thanks!' }) === false,
    'short thanks is not topic-bearing');
  assert(isTopicBearingTurn({ role: 'user', textContent: '👍' }) === false,
    'emoji-only is not topic-bearing');
  assert(isTopicBearingTurn({ role: 'user', textContent: '!!!' }) === false,
    'punctuation-only is not topic-bearing');
  assert(isTopicBearingTurn({ role: 'user', textContent: '' }) === false,
    'empty turn is not topic-bearing');
  assert(isTopicBearingTurn({ role: 'assistant', textContent: 'Here is the answer.' }) === false,
    'assistant turn is not topic-bearing');
  assert(isTopicBearingTurn({ role: 'user', textContent: 'ok', isHeartbeat: true }) === false,
    'heartbeat user turn is not topic-bearing');
  assert(isTopicBearingTurn({ role: 'user', textContent: 'ok but actually explain the architecture' }) === true,
    'longer substantive turn is topic-bearing');
}

console.log('\n── Scenario 24: countTopicBearingTurns filters correctly ──');
{
  const messages = [
    { role: 'user', textContent: 'How is the architecture?' },
    { role: 'assistant', textContent: 'It uses four layers.' },
    { role: 'user', textContent: 'ok' },
    { role: 'user', textContent: '👍' },
    { role: 'user', textContent: 'What about the database schema?' },
    { role: 'user', textContent: 'thanks', isHeartbeat: true },
    { role: 'user', textContent: 'Sender (untrusted metadata): {\"sender\":\"gateway-client\"}\n\nok' },
  ];
  assert(countTopicBearingTurns(messages) === 2,
    `counts 2 topic-bearing turns (got ${countTopicBearingTurns(messages)})`);
  assert(countTopicBearingTurns([]) === 0,
    'empty array returns 0');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
