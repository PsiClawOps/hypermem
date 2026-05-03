/**
 * hypermem Context Engine Plugin
 *
 * Implements OpenClaw's ContextEngine interface backed by hypermem's
 * four-layer memory architecture:
 *
 *   L1 Cache    — SQLite `:memory:` hot session working memory
 *   L2 Messages — per-agent conversation history (SQLite)
 *   L3 Vectors  — semantic + keyword search (KNN + FTS5)
 *   L4 Library  — facts, knowledge, episodes, preferences
 *
 * Lifecycle mapping:
 *   ingest()     → record each message into messages.db
 *   assemble()   → compositor builds context from all four layers
 *   compact()    → delegate to runtime (ownsCompaction: false)
 *   afterTurn()  → trigger background indexer (fire-and-forget)
 *   bootstrap()  → warm hot-cache session, register agent in fleet
 *   dispose()    → close hypermem connections
 *
 * Session key format expected: "agent:<agentId>:<channel>:<name>"
 */
import type { NeutralMessage, NeutralToolCall, NeutralToolResult, ComposeRequest, ComposeResult } from '@psiclawops/hypermem';
import { resolveTrimBudgets } from '@psiclawops/hypermem';
export type { NeutralMessage, NeutralToolCall, NeutralToolResult, ComposeRequest, ComposeResult };
type TrimTelemetryPath = 'assemble.normal' | 'assemble.toolLoop' | 'assemble.subagent' | 'reshape' | 'compact.nuclear' | 'compact.history' | 'compact.history2' | 'afterTurn.secondary' | 'warmstart';
type DegradationTelemetryPath = 'compose' | 'toolLoop';
interface DegradationTelemetryFields {
    agentId: string;
    sessionKey: string;
    turnId: string;
    path: DegradationTelemetryPath;
    toolChainCoEjections?: number;
    toolChainStubReplacements?: number;
    artifactDegradations?: number;
    artifactOversizeThresholdTokens?: number;
    replayState?: 'entering' | 'stabilizing' | 'exited';
    replayReason?: string;
}
declare function trimTelemetry(fields: {
    path: TrimTelemetryPath;
    agentId: string;
    sessionKey: string;
    preTokens: number;
    postTokens: number;
    removed: number;
    cacheInvalidated: boolean;
    reason: string;
}): void;
declare function assembleTrace(fields: {
    agentId: string;
    sessionKey: string;
    turnId: string;
    path: 'cold' | 'replay' | 'subagent';
    toolLoop: boolean;
    msgCount: number;
    prefixChanged?: boolean;
    prefixHash?: string;
    rerankerStatus?: string;
    rerankerCandidates?: number;
    rerankerProvider?: string | null;
    slotSpans?: Record<string, {
        allocated: number;
        filled: number;
        overflow: boolean;
    }>;
    compactionEligibleCount?: number;
    compactionEligibleRatio?: number;
    compactionProcessedCount?: number;
    composeTopicSource?: 'request-topic-id' | 'session-topic-map' | 'none';
    composeTopicState?: 'no-active-topic' | 'active-topic-ready' | 'active-topic-missing-stamped-history' | 'history-disabled';
    composeTopicMessageCount?: number;
    composeTopicStampedMessageCount?: number;
    composeTopicTelemetryStatus?: 'emitted' | 'intentionally-omitted';
}): void;
declare function degradationTelemetry(fields: DegradationTelemetryFields): void;
declare function lifecyclePolicyTelemetry(fields: {
    path: 'compose.eviction' | 'compose.preRecall' | 'afterTurn.gradient';
    agentId: string;
    sessionKey: string;
    band: string;
    pressurePct?: number;
    topicShiftConfidence?: number;
    trimSoftTarget?: number;
    protectedWarmingFloorFraction?: number;
    protectedSlotsKept?: number;
    reasons?: string[];
}): void;
declare function nextTurnId(): string;
declare const GUARD_TELEMETRY_REASONS: readonly ["warmstart-pressure-demoted", "reshape-downshift-demoted", "duplicate-claim-suppressed", "afterturn-secondary-demoted", "window-within-budget-skip", "pressure-accounting-anomaly"];
type GuardTelemetryReason = typeof GUARD_TELEMETRY_REASONS[number];
declare function beginTrimOwnerTurn(sessionKey: string, turnId: string): void;
declare function endTrimOwnerTurn(sessionKey: string, turnId: string): void;
/**
 * Claim the steady-state trim owner slot for the current turn.
 *
 * Behavior:
 *   - compact.* paths are exception-only and pass through without claiming.
 *   - Non-steady paths (warmstart, reshape, afterTurn.secondary) also pass
 *     through without claiming. Demoted/no-op sites should normally emit
 *     via guardTelemetry() instead so they stay visible without contending
 *     for ownership (sub-tasks 2.2 and 2.3 wire this in).
 *   - Steady-state paths (assemble.normal, assemble.subagent,
 *     assemble.toolLoop) claim the single owner slot for the current turn.
 *     The first such claim succeeds. A second steady-state claim against the
 *     same turn is a duplicate-turn violation: it throws loudly under
 *     NODE_ENV='development' and warns in other environments (returning
 *     false so non-dev runtimes keep working).
 *
 * Callers should invoke this immediately before the real
 * trimHistoryToTokenBudget() call. Guard telemetry does NOT route through
 * this helper — it is explicitly excluded from the steady-state invariant.
 *
 * Returns true when the claim succeeds (or is exempt); false on a swallowed
 * duplicate claim in non-development. In development the duplicate throws
 * before returning.
 */
declare function claimTrimOwner(sessionKey: string, turnId: string, path: TrimTelemetryPath): boolean;
/**
 * Non-counting guard / noop telemetry.
 *
 * Emits a `trim-guard` record on the same JSONL channel as trimTelemetry()
 * but with a distinct event name so per-turn reporting (scripts/trim-report.mjs,
 * future ownership dashboards) can keep it out of `trimCount`. Used by
 * demoted/no-op call sites in 2.2 and 2.3 so their path labels stay visible
 * in telemetry without consuming a steady-state owner slot.
 *
 * Zero-cost when telemetry is off. Never throws.
 */
declare function guardTelemetry(fields: {
    path: TrimTelemetryPath;
    agentId: string;
    sessionKey: string;
    reason: GuardTelemetryReason;
}): void;
export declare const __telemetryForTests: {
    trimTelemetry: typeof trimTelemetry;
    assembleTrace: typeof assembleTrace;
    degradationTelemetry: typeof degradationTelemetry;
    guardTelemetry: typeof guardTelemetry;
    lifecyclePolicyTelemetry: typeof lifecyclePolicyTelemetry;
    nextTurnId: typeof nextTurnId;
    beginTrimOwnerTurn: typeof beginTrimOwnerTurn;
    endTrimOwnerTurn: typeof endTrimOwnerTurn;
    claimTrimOwner: typeof claimTrimOwner;
    TRIM_SOFT_TARGET: number;
    TRIM_GROWTH_THRESHOLD: number;
    TRIM_HEADROOM_FRACTION: number;
    resolveTrimBudgets: typeof resolveTrimBudgets;
    reset(): void;
};
export declare const CONTEXT_WINDOW_OVERRIDE_KEY_REGEX: RegExp;
export type ContextWindowOverride = {
    contextTokens?: number;
    contextWindow?: number;
};
export declare function sanitizeContextWindowOverrides(raw: unknown): {
    value: Record<string, ContextWindowOverride>;
    warnings: string[];
};
export declare function resolveEffectiveBudget(args: {
    tokenBudget?: number;
    model?: string;
    contextWindowSize: number;
    contextWindowReserve: number;
    contextWindowOverrides?: Record<string, ContextWindowOverride>;
}): {
    budget: number;
    source: string;
};
export interface ModelIdentity {
    rawModel: string | null;
    modelKey: string | null;
    provider: string | null;
    modelId: string | null;
}
export declare function resolveModelIdentity(model?: string): ModelIdentity;
export declare function diffModelState(previous: {
    model?: string;
    modelKey?: string | null;
    provider?: string | null;
    modelId?: string | null;
    tokenBudget?: number;
} | null | undefined, current: {
    model?: string;
    tokenBudget?: number;
}): {
    previousIdentity: ModelIdentity;
    currentIdentity: ModelIdentity;
    modelChanged: boolean;
    providerChanged: boolean;
    modelIdChanged: boolean;
    budgetChanged: boolean;
    budgetDownshift: boolean;
    budgetUplift: boolean;
};
/**
 * Bust the assembly cache for a specific agent+session.
 * Call this after writing to identity files (SOUL.md, IDENTITY.md, TOOLS.md,
 * USER.md) to ensure the next assemble() runs full compositor, not a replay.
 */
export declare function bustAssemblyCache(agentId: string, sessionKey: string): Promise<void>;
declare const _default: {
    id: string;
    name: string;
    description: string;
    configSchema: import("openclaw/plugin-sdk/core").OpenClawPluginConfigSchema;
    register: NonNullable<import("openclaw/plugin-sdk/core").OpenClawPluginDefinition["register"]>;
} & Pick<import("openclaw/plugin-sdk/core").OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
export default _default;
//# sourceMappingURL=index.d.ts.map