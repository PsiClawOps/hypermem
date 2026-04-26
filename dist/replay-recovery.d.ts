import { type ReplayMarker, type ReplayState } from './degradation.js';
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
export declare const REPLAY_RECOVERY_POLICY: {
    readonly enterPressure: 0.8;
    readonly exitPressure: 0.65;
    readonly redisColdFraction: 0.2;
    readonly enterTrimTarget: 0.2;
    readonly stabilizingTrimTarget: 0.35;
    readonly historyDepthCap: 60;
    readonly redisFloorTokens: 500;
};
export declare function isColdRedisReplay(inputs: ReplayRecoveryInputs): boolean;
export declare function isReplayRecovered(inputs: ReplayRecoveryInputs): boolean;
export declare function decideReplayRecovery(inputs: ReplayRecoveryInputs): ReplayRecoveryDecision;
//# sourceMappingURL=replay-recovery.d.ts.map