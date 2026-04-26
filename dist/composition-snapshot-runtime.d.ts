import type { NeutralMessage, StoredMessage } from './types.js';
import { type SnapshotSlotsRecord } from './composition-snapshot-integrity.js';
interface BuildCompositionSnapshotSlotsInput {
    system: string | null | undefined;
    identity: string | null | undefined;
    repairNotice?: string | null | undefined;
    messages: NeutralMessage[];
    contextBlock?: string;
}
export interface RestoredWarmSnapshotState {
    system?: string;
    identity?: string;
    history: StoredMessage[];
    diagnostics: WarmSnapshotRestoreDiagnostics;
}
export interface WarmSnapshotRestoreDiagnostics {
    sourceProvider: string | null;
    targetProvider: string | null;
    crossProviderBoundary: boolean;
    requiredSlotDrops: string[];
    requiredSlotDropRate: number;
    stablePrefixBoundaryViolations: number;
    toolPairParityViolations: number;
    crossProviderAssistantTurns: number;
    quotedAssistantTurns: number;
    continuityCriticalBoundaryTransformCount: number;
    continuityCriticalBoundaryTransformRate: number;
    tokenParityDriftSampleCount: number;
    tokenParityDriftP95: number;
    tokenParityDriftP99: number;
    rolloutGatePassed: boolean;
    rolloutGateViolations: WarmRestoreRolloutGateViolation[];
}
export interface WarmRestoreRolloutGateViolation {
    gate: keyof typeof WARM_RESTORE_MEASUREMENT_GATES;
    actual: number;
    max: number;
}
export interface RestoreWarmSnapshotOptions {
    sourceProvider?: string | null;
    targetProvider?: string | null;
}
export declare const WARM_RESTORE_MEASUREMENT_GATES: Readonly<{
    tokenParityDriftP95Max: 0.03;
    tokenParityDriftP99Max: 0.05;
    requiredSlotDropRateMax: 0;
    stablePrefixBoundaryViolationsMax: 0;
    toolPairParityViolationsMax: 0;
    crossProviderAssistantTurnsMax: 0;
    continuityCriticalBoundaryTransformRateMax: 0.005;
}>;
export declare function evaluateWarmRestoreRolloutGate(diagnostics: Pick<WarmSnapshotRestoreDiagnostics, 'tokenParityDriftP95' | 'tokenParityDriftP99' | 'requiredSlotDropRate' | 'stablePrefixBoundaryViolations' | 'toolPairParityViolations' | 'crossProviderAssistantTurns' | 'continuityCriticalBoundaryTransformRate'>): {
    passed: boolean;
    violations: WarmRestoreRolloutGateViolation[];
};
export declare function buildCompositionSnapshotSlots(input: BuildCompositionSnapshotSlotsInput): SnapshotSlotsRecord;
export declare function restoreWarmSnapshotState(slots: SnapshotSlotsRecord, options?: RestoreWarmSnapshotOptions): RestoredWarmSnapshotState | null;
export {};
//# sourceMappingURL=composition-snapshot-runtime.d.ts.map