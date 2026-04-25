/**
 * HyperMem 0.9.0 adaptive context lifecycle policy kernel.
 *
 * This module intentionally stays pure: it does not fetch history, mutate
 * stores, or own trimming. Runtime paths can call it to choose warming,
 * recall, trim, compaction, and eviction posture from the same pressure band
 * so 0.9.0 does not grow another independent trim brain.
 */

export type AdaptiveLifecycleBand =
  | 'bootstrap'
  | 'warmup'
  | 'steady'
  | 'elevated'
  | 'high'
  | 'critical';

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
export type AdaptiveEvictionStep =
  | 'tool-gradient'
  | 'oversized-artifacts'
  | 'stale-tool-stubs'
  | 'topic-aware-cluster-drop'
  | 'oldest-cluster-drop';

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

const BASELINE_EVICTION_STEPS: readonly AdaptiveEvictionStep[] = Object.freeze([
  'tool-gradient',
  'oversized-artifacts',
  'stale-tool-stubs',
  'oldest-cluster-drop',
]);

const TOPIC_AWARE_EVICTION_STEPS: readonly AdaptiveEvictionStep[] = Object.freeze([
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
export function resolveAdaptiveEvictionPlan(band: AdaptiveLifecycleBand): AdaptiveEvictionPlan {
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

const WARMING_BY_BAND: Record<AdaptiveLifecycleBand, number> = Object.freeze({
  bootstrap: 0.55,
  warmup: 0.48,
  steady: 0.40,
  elevated: 0.34,
  high: 0.28,
  critical: 0.20,
});

const TRIM_TARGET_BY_BAND: Record<AdaptiveLifecycleBand, number> = Object.freeze({
  bootstrap: 0.72,
  warmup: 0.68,
  steady: 0.65,
  elevated: 0.60,
  high: 0.54,
  critical: 0.48,
});

const COMPACTION_TARGET_BY_BAND: Record<AdaptiveLifecycleBand, number> = Object.freeze({
  bootstrap: 0.70,
  warmup: 0.66,
  steady: 0.62,
  elevated: 0.56,
  high: 0.50,
  critical: 0.42,
});

function clampPressure(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

function pressureFromInput(input: AdaptiveLifecycleInput): number {
  if (input.pressureFraction != null) {
    return clampPressure(input.pressureFraction);
  }
  const used = Math.max(0, Math.floor(input.usedTokens ?? 0));
  const budget = Math.max(0, Math.floor(input.effectiveBudget ?? 0));
  if (budget <= 0) return 0;
  return clampPressure(used / budget);
}

function isTopicShift(input: AdaptiveLifecycleInput): boolean {
  return (input.topicShiftConfidence ?? 0) >= 0.75;
}

function classifyBand(input: AdaptiveLifecycleInput, pressure: number): AdaptiveLifecycleBand {
  const userTurns = Math.max(0, Math.floor(input.userTurnCount ?? 0));

  if (input.explicitNewSession || userTurns === 0) return 'bootstrap';
  if (userTurns <= 4 && pressure < PRESSURE_BANDS.elevatedMax) return 'warmup';
  if (pressure < PRESSURE_BANDS.steadyMax) return 'steady';
  if (pressure < PRESSURE_BANDS.elevatedMax) return 'elevated';
  if (pressure < PRESSURE_BANDS.highMax) return 'high';
  return 'critical';
}

function smartRecallMultiplier(input: AdaptiveLifecycleInput, band: AdaptiveLifecycleBand): number {
  if (input.explicitNewSession || isTopicShift(input)) return 1.5;
  if (band === 'bootstrap' || band === 'warmup') return 1.25;
  if (band === 'high') return 0.85;
  if (band === 'critical') return 0.65;
  return 1.0;
}

function reasonsFor(input: AdaptiveLifecycleInput, band: AdaptiveLifecycleBand, pressure: number): string[] {
  const reasons: string[] = [`band:${band}`, `pressure:${Math.round(pressure * 100)}%`];
  const turns = Math.max(0, Math.floor(input.userTurnCount ?? 0));
  if (input.explicitNewSession) reasons.push('explicit-new-session');
  if (turns === 0) reasons.push('cold-start');
  if (turns > 0 && turns <= 4) reasons.push(`early-session:${turns}`);
  if (isTopicShift(input)) reasons.push(`topic-shift:${(input.topicShiftConfidence ?? 0).toFixed(2)}`);
  if (band === 'high' || band === 'critical') reasons.push('pressure-gated-recall');
  return reasons;
}

/**
 * Resolve the adaptive lifecycle posture for one compose/afterTurn cycle.
 */
export function resolveAdaptiveLifecyclePolicy(
  input: AdaptiveLifecycleInput = {},
): AdaptiveLifecyclePolicy {
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
