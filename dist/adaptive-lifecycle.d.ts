/**
 * HyperMem 0.9.0 adaptive context lifecycle policy kernel.
 *
 * This module intentionally stays pure: it does not fetch history, mutate
 * stores, or own trimming. Runtime paths can call it to choose warming,
 * recall, trim, compaction, and eviction posture from the same pressure band
 * so 0.9.0 does not grow another independent trim brain.
 */
export type AdaptiveLifecycleBand = 'bootstrap' | 'warmup' | 'steady' | 'elevated' | 'high' | 'critical';
export interface AdaptiveLifecycleInput {
    /** Tokens already resident or projected in the active context. */
    usedTokens?: number;
    /** Effective context budget after model-aware reserve handling. */
    effectiveBudget?: number;
    /** Optional precomputed pressure fraction. Overrides usedTokens/effectiveBudget. */
    pressureFraction?: number;
    /** Number of user turns observed in the session. */
    userTurnCount?: number;
    /** True when the incoming user turn explicitly starts with /new. */
    explicitNewSession?: boolean;
    /** Topic-shift confidence from the detector, 0..1. */
    topicShiftConfidence?: number;
    /** True when this context was forked from a parent OpenClaw session. */
    forkedContext?: boolean;
    /** Parent-session pressure observed when the fork was prepared, 0..1+. */
    forkedParentPressureFraction?: number;
    /** Parent-session user turns observed when the fork was prepared. */
    forkedParentUserTurnCount?: number;
}
/**
 * Eviction-pipeline step labels. The order in `AdaptiveEvictionPlan.steps`
 * is the order the compose-window cluster-drop path should attempt them.
 *
 * `tool-gradient`, `oversized-artifacts`, and `stale-tool-stubs` are
 * ballast-reduction steps already implemented in the compositor; the plan
 * just records that they precede cluster drop. `topic-aware-cluster-drop`
 * and `oldest-cluster-drop` describe how the compositor's existing
 * cluster-drop pass should be ordered: topic-aware-first when the band
 * elevates, otherwise the historical newest-first/oldest-drop sweep.
 */
export type AdaptiveEvictionStep = 'tool-gradient' | 'oversized-artifacts' | 'stale-tool-stubs' | 'topic-aware-cluster-drop' | 'oldest-cluster-drop';
export interface AdaptiveEvictionPlan {
    band: AdaptiveLifecycleBand;
    steps: readonly AdaptiveEvictionStep[];
    /** Drop inactive-topic clusters before falling back to oldest-first. */
    preferTopicAwareDrop: boolean;
    /** Ballast-reduction steps run before any cluster drop. Always true today. */
    preferBallastFirst: boolean;
}
export interface AdaptiveLifecyclePolicy {
    band: AdaptiveLifecycleBand;
    pressureFraction: number;
    pressurePct: number;
    warmHistoryBudgetFraction: number;
    smartRecallMultiplier: number;
    trimSoftTarget: number;
    compactionTargetFraction: number;
    emitBreadcrumbPackage: boolean;
    enableTopicCentroidEviction: boolean;
    triggerProactiveCompaction: boolean;
    evictionPlan: AdaptiveEvictionPlan;
    reasons: string[];
}
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
export declare function resolveAdaptiveEvictionPlan(band: AdaptiveLifecycleBand): AdaptiveEvictionPlan;
/**
 * Resolve the adaptive lifecycle posture for one compose/afterTurn cycle.
 */
export declare function resolveAdaptiveLifecyclePolicy(input?: AdaptiveLifecycleInput): AdaptiveLifecyclePolicy;
//# sourceMappingURL=adaptive-lifecycle.d.ts.map