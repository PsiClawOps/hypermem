/**
 * HyperMem Canonical Degradation Contracts, Phase C0.2
 *
 * Defines the typed surfaces, reason enum, and format builders for degraded
 * prompt-visible outputs. These shapes stay in volatile context and should not
 * cross the stable-prefix boundary.
 */
/**
 * Closed set of reasons for any degradation decision.
 * Use these values in telemetry and tests instead of ad-hoc strings.
 */
export type DegradationReason = 'gradient_t2_prose' | 'gradient_t3_stub' | 'eviction_oversize' | 'eviction_turn0_trim' | 'wave_guard_pressure_high' | 'wave_guard_pressure_elevated' | 'budget_cluster_drop' | 'artifact_oversize' | 'artifact_fetch_hint' | 'replay_cold_redis' | 'replay_stabilizing' | 'replay_exited' | 'pressure_mismatch' | 'unknown';
/** All valid DegradationReason values as a readonly array. */
export declare const DEGRADATION_REASONS: readonly ["gradient_t2_prose", "gradient_t3_stub", "eviction_oversize", "eviction_turn0_trim", "wave_guard_pressure_high", "wave_guard_pressure_elevated", "budget_cluster_drop", "artifact_oversize", "artifact_fetch_hint", "replay_cold_redis", "replay_stabilizing", "replay_exited", "pressure_mismatch", "unknown"];
/** Field-length caps for canonical degraded strings. */
export declare const DEGRADATION_LIMITS: {
    readonly toolName: 64;
    readonly toolId: 64;
    readonly reason: 48;
    readonly toolSummary: 120;
    readonly toolArtifactId: 64;
    readonly artifactId: 64;
    readonly artifactPath: 160;
    readonly artifactFetchHint: 80;
    readonly replayState: 32;
    readonly replaySummary: 120;
};
export declare function isDegradationReason(value: string): value is DegradationReason;
/**
 * Canonical shape for a degraded tool call/result pair.
 *
 * Prompt-visible format:
 *   [tool:<name> id=<id> status=ejected reason=<reason> summary=<stub>]
 *
 * Optional artifact pointer (Phase 1 of tool_artifacts):
 *   [tool:<name> id=<id> status=ejected reason=<reason> artifact=<artifactId> summary=<stub>]
 *
 * The `artifact=` field is backwards-compatible and optional. When present, it
 * lets the compositor rehydrate the full tool result payload from the
 * tool_artifacts table without needing to rewrite the transcript.
 */
export interface ToolChainStub {
    name: string;
    id: string;
    status: 'ejected';
    reason: DegradationReason;
    summary: string;
    /** Optional durable pointer into the tool_artifacts table. */
    artifactId?: string;
}
export declare function formatToolChainStub(stub: ToolChainStub): string;
export declare function parseToolChainStub(text: string): ToolChainStub | null;
export declare function isToolChainStub(text: string): boolean;
/**
 * Canonical shape for a degraded oversized artifact replaced by a pointer.
 *
 * Prompt-visible format:
 *   [artifact:<id> path=<path> size=<tokens> status=degraded fetch=<hint>]
 */
export interface ArtifactRef {
    id: string;
    path: string;
    sizeTokens: number;
    status: 'degraded';
    reason: DegradationReason;
    fetchHint: string;
}
export declare function formatArtifactRef(ref: ArtifactRef): string;
export declare function parseArtifactRef(text: string): ArtifactRef | null;
export declare function isArtifactRef(text: string): boolean;
/**
 * State of the replay recovery window.
 */
export type ReplayState = 'entering' | 'stabilizing' | 'exited';
export declare function isReplayState(value: string): value is ReplayState;
/**
 * Canonical shape for a replay recovery mode marker.
 *
 * Prompt-visible format:
 *   [replay state=<state> status=bounded reason=<reason> summary=<stub>]
 */
export interface ReplayMarker {
    state: ReplayState;
    status: 'bounded';
    reason: DegradationReason;
    summary: string;
}
export declare function formatReplayMarker(marker: ReplayMarker): string;
export declare function parseReplayMarker(text: string): ReplayMarker | null;
export declare function isReplayMarker(text: string): boolean;
export declare function isDegradedContent(text: string): boolean;
export interface DegradationEvent {
    event: 'degradation';
    ts: string;
    agentId: string;
    sessionKey: string;
    degradationClass: 'tool_chain' | 'artifact' | 'replay';
    reason: DegradationReason;
    tokensSaved: number;
    emittedText: string;
}
//# sourceMappingURL=degradation.d.ts.map