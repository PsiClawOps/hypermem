/**
 * Canonical budget policy for history-window trim and steady-state gradient caps.
 *
 * Phase C C0.1 centralizes these values so compose, afterTurn refresh, plugin
 * trim guards, and regression tests all consume the same source of truth.
 */
export const TRIM_SOFT_TARGET = 0.65;
export const TRIM_GROWTH_THRESHOLD = 0.05;
export const TRIM_HEADROOM_FRACTION = 0.10;
export const TRIM_BUDGET_POLICY = Object.freeze({
    trimSoftTarget: TRIM_SOFT_TARGET,
    trimGrowthThreshold: TRIM_GROWTH_THRESHOLD,
    trimHeadroomFraction: TRIM_HEADROOM_FRACTION,
});
export function resolveTrimBudgets(effectiveBudget, policy = {}) {
    const safeBudget = Math.max(0, Math.floor(effectiveBudget || 0));
    const trimSoftTarget = policy.trimSoftTarget ?? TRIM_SOFT_TARGET;
    const trimGrowthThreshold = policy.trimGrowthThreshold ?? TRIM_GROWTH_THRESHOLD;
    const trimHeadroomFraction = policy.trimHeadroomFraction ?? TRIM_HEADROOM_FRACTION;
    const softBudget = Math.floor(safeBudget * trimSoftTarget);
    const triggerBudget = Math.floor(softBudget * (1 + trimGrowthThreshold));
    const targetBudget = Math.floor(softBudget * (1 - trimHeadroomFraction));
    return {
        trimSoftTarget,
        trimGrowthThreshold,
        trimHeadroomFraction,
        softBudget,
        triggerBudget,
        targetBudget,
    };
}
//# sourceMappingURL=budget-policy.js.map