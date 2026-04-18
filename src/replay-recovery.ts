import {
  formatReplayMarker,
  type ReplayMarker,
  type ReplayState,
} from './degradation.js';

export interface ReplayRecoveryInputs {
  currentState?: ReplayState | '' | null;
  runtimeTokens: number;
  redisTokens: number;
  effectiveBudget: number;
}

export interface ReplayRecoveryDecision {
  active: boolean;
  shouldSkipCacheReplay: boolean;
  trimTargetOverride?: number;
  historyDepthCap?: number;
  emittedMarker?: ReplayMarker;
  emittedText?: string;
  nextState: ReplayState | null;
}

export const REPLAY_RECOVERY_POLICY = {
  enterPressure: 0.80,
  exitPressure: 0.65,
  redisColdFraction: 0.20,
  enterTrimTarget: 0.20,
  stabilizingTrimTarget: 0.35,
  historyDepthCap: 60,
  redisFloorTokens: 500,
} as const;

function coldRedisThreshold(runtimeTokens: number): number {
  return Math.max(
    REPLAY_RECOVERY_POLICY.redisFloorTokens,
    Math.floor(runtimeTokens * REPLAY_RECOVERY_POLICY.redisColdFraction),
  );
}

function recoveredRedisThreshold(effectiveBudget: number): number {
  return Math.max(
    REPLAY_RECOVERY_POLICY.redisFloorTokens,
    Math.floor(effectiveBudget * REPLAY_RECOVERY_POLICY.redisColdFraction),
  );
}

export function isColdRedisReplay(inputs: ReplayRecoveryInputs): boolean {
  return (
    inputs.runtimeTokens > inputs.effectiveBudget * REPLAY_RECOVERY_POLICY.enterPressure &&
    inputs.redisTokens < coldRedisThreshold(inputs.runtimeTokens)
  );
}

export function isReplayRecovered(inputs: ReplayRecoveryInputs): boolean {
  return (
    inputs.runtimeTokens <= inputs.effectiveBudget * REPLAY_RECOVERY_POLICY.exitPressure &&
    inputs.redisTokens >= recoveredRedisThreshold(inputs.effectiveBudget)
  );
}

export function decideReplayRecovery(inputs: ReplayRecoveryInputs): ReplayRecoveryDecision {
  const currentState = inputs.currentState ?? null;

  if (!currentState) {
    if (!isColdRedisReplay(inputs)) {
      return {
        active: false,
        shouldSkipCacheReplay: false,
        nextState: null,
      };
    }

    const emittedMarker: ReplayMarker = {
      state: 'entering',
      status: 'bounded',
      reason: 'replay_cold_redis',
      summary: 'cold restart, keep the window bounded',
    };

    return {
      active: true,
      shouldSkipCacheReplay: true,
      trimTargetOverride: REPLAY_RECOVERY_POLICY.enterTrimTarget,
      historyDepthCap: REPLAY_RECOVERY_POLICY.historyDepthCap,
      emittedMarker,
      emittedText: formatReplayMarker(emittedMarker),
      nextState: 'stabilizing',
    };
  }

  if (isReplayRecovered(inputs)) {
    const emittedMarker: ReplayMarker = {
      state: 'exited',
      status: 'bounded',
      reason: 'replay_exited',
      summary: 'stable window restored',
    };

    return {
      active: false,
      shouldSkipCacheReplay: false,
      emittedMarker,
      emittedText: formatReplayMarker(emittedMarker),
      nextState: null,
    };
  }

  const emittedMarker: ReplayMarker = {
    state: 'stabilizing',
    status: 'bounded',
    reason: 'replay_stabilizing',
    summary: 'replay window stabilizing, keep it bounded',
  };

  return {
    active: true,
    shouldSkipCacheReplay: true,
    trimTargetOverride: REPLAY_RECOVERY_POLICY.stabilizingTrimTarget,
    historyDepthCap: REPLAY_RECOVERY_POLICY.historyDepthCap,
    emittedMarker,
    emittedText: formatReplayMarker(emittedMarker),
    nextState: 'stabilizing',
  };
}
