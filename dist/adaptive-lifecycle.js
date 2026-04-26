/**
 * HyperMem 0.9.0 adaptive context lifecycle policy kernel.
 *
 * This module intentionally stays pure: it does not fetch history, mutate
 * stores, or own trimming. Runtime paths can call it to choose warming,
 * recall, trim, compaction, and eviction posture from the same pressure band
 * so 0.9.0 does not grow another independent trim brain.
 */
const BASELINE_EVICTION_STEPS = Object.freeze([
    'tool-gradient',
    'oversized-artifacts',
    'stale-tool-stubs',
    'oldest-cluster-drop',
]);
const TOPIC_AWARE_EVICTION_STEPS = Object.freeze([
    'tool-gradient',
    'oversized-artifacts',
    'stale-tool-stubs',
    'topic-aware-cluster-drop',
    'oldest-cluster-drop',
]);
/**
 * Pure helper: derive the eviction plan from band only. No new pressure
 * constants — every band-sensitive decision routes through the existing
 * AdaptiveLifecycleBand classification.
 *
 * - bootstrap/warmup/steady: preserve the historical eviction order.
 * - elevated: prefer topic-aware stale cluster drop before generic
 *   oldest-first cluster drop.
 * - high/critical: same plan shape as elevated. Ballast-first is already
 *   the default order in the compositor; topic-aware drop kicks in to
 *   avoid evicting active-topic recent clusters under saturation.
 */
export function resolveAdaptiveEvictionPlan(band) {
    switch (band) {
        case 'bootstrap':
        case 'warmup':
        case 'steady':
            return Object.freeze({
                band,
                steps: BASELINE_EVICTION_STEPS,
                preferTopicAwareDrop: false,
                preferBallastFirst: true,
            });
        case 'elevated':
        case 'high':
        case 'critical':
        default:
            return Object.freeze({
                band,
                steps: TOPIC_AWARE_EVICTION_STEPS,
                preferTopicAwareDrop: true,
                preferBallastFirst: true,
            });
    }
}
const PRESSURE_BANDS = Object.freeze({
    steadyMax: 0.65,
    elevatedMax: 0.75,
    highMax: 0.85,
});
const WARMING_BY_BAND = Object.freeze({
    bootstrap: 0.55,
    warmup: 0.48,
    steady: 0.40,
    elevated: 0.34,
    high: 0.28,
    critical: 0.20,
});
const TRIM_TARGET_BY_BAND = Object.freeze({
    bootstrap: 0.72,
    warmup: 0.68,
    steady: 0.65,
    elevated: 0.60,
    high: 0.54,
    critical: 0.48,
});
const COMPACTION_TARGET_BY_BAND = Object.freeze({
    bootstrap: 0.70,
    warmup: 0.66,
    steady: 0.62,
    elevated: 0.56,
    high: 0.50,
    critical: 0.42,
});
function clampPressure(value) {
    if (!Number.isFinite(value) || value < 0)
        return 0;
    return value;
}
function pressureFromInput(input) {
    if (input.pressureFraction != null) {
        return clampPressure(input.pressureFraction);
    }
    const used = Math.max(0, Math.floor(input.usedTokens ?? 0));
    const budget = Math.max(0, Math.floor(input.effectiveBudget ?? 0));
    if (budget <= 0)
        return 0;
    return clampPressure(used / budget);
}
function isTopicShift(input) {
    return (input.topicShiftConfidence ?? 0) >= 0.75;
}
function classifyBand(input, pressure) {
    const userTurns = Math.max(0, Math.floor(input.userTurnCount ?? 0));
    if (input.explicitNewSession)
        return 'bootstrap';
    if (input.forkedContext) {
        const parentPressure = clampPressure(input.forkedParentPressureFraction ?? pressure);
        const parentTurns = Math.max(0, Math.floor(input.forkedParentUserTurnCount ?? 0));
        // A forked child is not cold: it starts with inherited working context.
        // Keep initial posture conservative and bounded to warmup/steady so a
        // saturated parent does not immediately trigger child compaction before the
        // child has produced its own post-fork turns. Callers should only pass this
        // seed for the initial forked assemble.
        if (parentTurns >= 5 || parentPressure >= 0.35)
            return 'steady';
        return 'warmup';
    }
    if (userTurns === 0)
        return 'bootstrap';
    if (userTurns <= 4 && pressure < PRESSURE_BANDS.elevatedMax)
        return 'warmup';
    if (pressure < PRESSURE_BANDS.steadyMax)
        return 'steady';
    if (pressure < PRESSURE_BANDS.elevatedMax)
        return 'elevated';
    if (pressure < PRESSURE_BANDS.highMax)
        return 'high';
    return 'critical';
}
function smartRecallMultiplier(input, band) {
    if (input.explicitNewSession || isTopicShift(input))
        return 1.5;
    if (band === 'bootstrap' || band === 'warmup')
        return 1.25;
    if (band === 'high')
        return 0.85;
    if (band === 'critical')
        return 0.65;
    return 1.0;
}
function reasonsFor(input, band, pressure) {
    const reasons = [`band:${band}`, `pressure:${Math.round(pressure * 100)}%`];
    const turns = Math.max(0, Math.floor(input.userTurnCount ?? 0));
    if (input.explicitNewSession)
        reasons.push('explicit-new-session');
    if (input.forkedContext) {
        reasons.push('forked-context');
        if (input.forkedParentPressureFraction != null) {
            reasons.push(`forked-parent-pressure:${Math.round(clampPressure(input.forkedParentPressureFraction) * 100)}%`);
        }
        if (input.forkedParentUserTurnCount != null) {
            reasons.push(`forked-parent-turns:${Math.max(0, Math.floor(input.forkedParentUserTurnCount))}`);
        }
    }
    if (turns === 0)
        reasons.push('cold-start');
    if (turns > 0 && turns <= 4)
        reasons.push(`early-session:${turns}`);
    if (isTopicShift(input))
        reasons.push(`topic-shift:${(input.topicShiftConfidence ?? 0).toFixed(2)}`);
    if (band === 'high' || band === 'critical')
        reasons.push('pressure-gated-recall');
    return reasons;
}
/**
 * Resolve the adaptive lifecycle posture for one compose/afterTurn cycle.
 */
export function resolveAdaptiveLifecyclePolicy(input = {}) {
    const pressureFraction = pressureFromInput(input);
    const band = classifyBand(input, pressureFraction);
    const pressurePct = Math.round(pressureFraction * 100);
    const triggerProactiveCompaction = band === 'high' || band === 'critical';
    return Object.freeze({
        band,
        pressureFraction,
        pressurePct,
        warmHistoryBudgetFraction: WARMING_BY_BAND[band],
        smartRecallMultiplier: smartRecallMultiplier(input, band),
        trimSoftTarget: TRIM_TARGET_BY_BAND[band],
        compactionTargetFraction: COMPACTION_TARGET_BY_BAND[band],
        emitBreadcrumbPackage: Boolean(input.explicitNewSession || band === 'bootstrap'),
        enableTopicCentroidEviction: band === 'elevated' || triggerProactiveCompaction,
        triggerProactiveCompaction,
        evictionPlan: resolveAdaptiveEvictionPlan(band),
        reasons: reasonsFor(input, band, pressureFraction),
    });
}
//# sourceMappingURL=adaptive-lifecycle.js.map