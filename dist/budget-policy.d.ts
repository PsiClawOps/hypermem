/**
 * Canonical budget policy for history-window trim and steady-state gradient caps.
 *
 * Phase C C0.1 centralizes these values so compose, afterTurn refresh, plugin
 * trim guards, and regression tests all consume the same source of truth.
 */
export declare const TRIM_SOFT_TARGET = 0.65;
export declare const TRIM_GROWTH_THRESHOLD = 0.05;
export declare const TRIM_HEADROOM_FRACTION = 0.1;
export interface TrimBudgetPolicy {
    trimSoftTarget: number;
    trimGrowthThreshold: number;
    trimHeadroomFraction: number;
}
export interface ResolvedTrimBudgets extends TrimBudgetPolicy {
    softBudget: number;
    triggerBudget: number;
    targetBudget: number;
}
export declare const TRIM_BUDGET_POLICY: TrimBudgetPolicy;
export declare function resolveTrimBudgets(effectiveBudget: number, policy?: Partial<TrimBudgetPolicy>): ResolvedTrimBudgets;
//# sourceMappingURL=budget-policy.d.ts.map