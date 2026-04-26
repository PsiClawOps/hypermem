/**
 * hypermem Compositor
 *
 * Assembles context for LLM calls by orchestrating all four memory layers:
 *   L1 Redis    — hot session working memory (system, identity, recent msgs)
 *   L2 Messages — conversation history from messages.db
 *   L3 Vectors  — semantic search across all indexed content
 *   L4 Library  — structured knowledge (facts, preferences, knowledge, episodes)
 *
 * Token-budgeted: never exceeds the budget, prioritizes by configured order.
 * Provider-neutral internally, translates at the output boundary.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ComposeRequest, ComposeResult, NeutralMessage, CompositorConfig } from './types.js';
import { CollectionTrigger } from './trigger-registry.js';
import { CacheLayer } from './cache.js';
type AnyCache = CacheLayer;
import { VectorStore } from './vector-store.js';
import { type OrgRegistry } from './cross-agent.js';
import { type AdaptiveLifecyclePolicy } from './adaptive-lifecycle.js';
import { type DegradationReason } from './degradation.js';
/**
 * Files that OpenClaw's contextInjection injects into the system prompt.
 * HyperMem must not re-inject these via doc chunk retrieval to avoid duplication.
 * Exported so plugin and other consumers can share the same dedup set.
 */
export declare const OPENCLAW_BOOTSTRAP_FILES: Set<string>;
/**
 * B4: Compute model-aware lane budget fractions.
 *
 * Resolves the effective historyFraction and memoryFraction for a compose pass
 * given the model and its effective budget. Uses the MECW catalog to blend
 * away from fixed fractions when the budget approaches the MECW ceiling,
 * so the compositor allocates proportionally for what the model can actually use.
 *
 * Returns:
 *   historyFraction — fraction of effective budget to give history
 *   memoryFraction  — fraction of effective budget to give memory pool
 *   mecwProfile     — which MECW entry matched (undefined = no match / full window)
 *   mecwApplied     — true when MECW adjustment changed the fractions
 *   mecwBlend       — 0..1 blend factor (0 = below floor, 1 = at/above ceiling)
 */
export declare function resolveModelLaneBudgets(model: string | undefined, effectiveBudget: number, configHistoryFraction: number, configMemoryFraction: number): {
    historyFraction: number;
    memoryFraction: number;
    mecwProfile: string | undefined;
    mecwApplied: boolean;
    mecwBlend: number;
};
/** Session classification labels — used for adaptive depth selection. */
export type SessionType = 'plain-chat' | 'tool-heavy';
/**
 * Classify a session based on the ratio of tool messages in the recent sample.
 * 'tool-heavy': >= 20% of sampled messages carry tool calls or tool results.
 * 'plain-chat': below that threshold (text-only or occasional tool use).
 *
 * The 20% threshold is intentionally conservative: most tool-heavy agents
 * have tool messages on every assistant turn, so the ratio quickly exceeds
 * the threshold without false-positive risk for light tool users.
 */
export declare function classifySessionType(messages: NeutralMessage[]): SessionType;
/**
 * Estimate the average token cost per message from a recent message sample.
 * Uses the same estimateMessageTokens heuristic as the compositor budget walk
 * so the returned depth is directly comparable to the historyFillCap check.
 *
 * Returns a conservative floor (100 tokens) when the sample is empty to avoid
 * returning Infinity when historyBudget is divided by density.
 */
export declare function estimateObservedMsgDensity(messages: NeutralMessage[]): number;
/**
 * Compute an adaptive history depth that pre-fits the session type.
 *
 * For plain-chat sessions: divides historyBudget by observed density to get a
 * depth that fills the budget without overflow, bounded by the default maximum.
 * Recall quality is preserved because the density estimate is honest for
 * text-only turns.
 *
 * For tool-heavy sessions: applies a post-gradient compression factor
 * (TOOL_GRADIENT_DENSITY_FACTOR = 0.30) to the observed pre-gradient density.
 * This accounts for the gradient transform collapsing large tool payloads to
 * prose stubs before the budget-fit walk runs. A tighter depth is chosen so
 * the gradient-compressed messages fit inside historyFillCap without triggering
 * a rescue trim.
 *
 * A 0.85 safety margin is applied to both paths so estimates that are
 * slightly off don't cause immediate overflow on the first warm compose.
 *
 * Min/max bounds ensure the compositor always sees a meaningful window:
 *   - plain-chat min: 20 messages (enough for short recent context)
 *   - tool-heavy min: 15 messages (recent tool context + a few prior turns)
 *   - shared max: config.maxHistoryMessages (never exceed the DB fetch ceiling)
 */
export declare function computeAdaptiveHistoryDepth(sessionType: SessionType, observedDensity: number, historyBudgetTokens: number, maxHistoryMessages: number): number;
/**
 * Canonical pressure labels shared across compose and compaction paths.
 * Use these constants when setting the `pressureSource` field so all consumers
 * can filter logs with a stable string without guessing spellings.
 */
export declare const PRESSURE_SOURCE: {
    /** Compose path: pressure derived from (budget - remaining) after full slot assembly. */
    readonly COMPOSE_POST_ASSEMBLY: "compose:post-assembly";
    /** Compose path: pressure measured immediately before semantic recall runs. */
    readonly COMPOSE_PRE_RECALL: "compose:pre-recall";
    /** Compaction path: pressure from Redis token estimate / effectiveBudget. */
    readonly COMPACT_REDIS_ESTIMATE: "compact:redis-estimate";
    /** Compaction path: pressure from runtime-reported currentTokenCount / effectiveBudget. */
    readonly COMPACT_RUNTIME_TOTAL: "compact:runtime-total";
    /** Tool-loop assemble path: pressure from in-memory working message array / effectiveBudget. */
    readonly TOOLLOOP_RUNTIME_ARRAY: "toolloop:runtime-array";
};
export type PressureSourceLabel = typeof PRESSURE_SOURCE[keyof typeof PRESSURE_SOURCE];
/**
 * Compute a unified pressure fraction so compose and compaction paths report
 * the same numeric concept without drift.
 *
 * Always clamps to [0, Infinity) — callers get the raw fraction so they can
 * decide their own thresholds without us hardcoding them here.
 *
 * @param usedTokens  Tokens consumed (numerator).
 * @param budgetTokens  Effective budget (denominator). Must be > 0.
 * @param source  Label from PRESSURE_SOURCE for telemetry (metadata only).
 * @returns { fraction, pct, source } where fraction = usedTokens / budgetTokens,
 *          pct = Math.round(fraction * 100), source = canonical label.
 */
export declare function computeUnifiedPressure(usedTokens: number, budgetTokens: number, source: string): {
    fraction: number;
    pct: number;
    source: string;
};
/**
 * 0.9.0: adaptive lifecycle scales semantic-recall breadth in compose.
 *
 * Base fractions match the historical compositor constants so that a steady
 * (multiplier=1.0) call reproduces prior behavior exactly. Candidate limit is
 * clamped so even a critical-pressure pass keeps a usable retrieval window
 * and a /new surge does not blow up hybrid search cost.
 */
export declare const RECALL_BREADTH_BASE: Readonly<{
    mainBudgetFraction: 0.12;
    fallbackBudgetFraction: 0.1;
    candidateLimit: 10;
    candidateLimitMin: 6;
    candidateLimitMax: 16;
}>;
export interface ScaledRecallBreadth {
    mainBudgetTokens: number;
    fallbackBudgetTokens: number;
    candidateLimit: number;
    multiplier: number;
}
/**
 * Apply the adaptive lifecycle smartRecallMultiplier to recall breadth.
 * Pure helper — does not read state or mutate anything. Steady multiplier=1
 * preserves the historical (0.12, 0.10, limit=10) recall envelope.
 */
export declare function scaleRecallBreadth(remainingTokens: number, multiplier: number): ScaledRecallBreadth;
export { CollectionTrigger, DEFAULT_TRIGGERS, matchTriggers } from './trigger-registry.js';
export { getTurnAge, applyToolGradient, appendToolSummary, truncateWithHeadTail, applyTierPayloadCap, evictLargeToolResults };
interface NeutralMessageCluster<T extends NeutralMessage> {
    messages: T[];
    tokenCost: number;
}
/**
 * Adaptive eviction ordering for the compose-window cluster-drop pass.
 *
 * Pure helper: derives drop priority from `policy.evictionPlan` (which is
 * itself derived from `policy.band`) and an optional `activeTopicId`. Does
 * not read state, mutate clusters, or introduce a parallel pressure brain.
 *
 * Returns:
 *   - `protectedIndices`: clusters never selected for topic-aware drop
 *     (system prefix, dynamicBoundary, the latest user-role cluster). The
 *     existing oldest-first sweep can still drop them as a last resort,
 *     same as before this helper.
 *   - `topicAwareDropOrder`: cluster indices (oldest→newest) to drop
 *     before the oldest-first sweep when the band promotes topic-aware
 *     drop. Tool-call/result clusters are excluded so they remain atomic
 *     and ballast reduction (applyToolGradient/evictLargeToolResults/
 *     resolveOversizedArtifacts) handles them upstream.
 *   - `preferTopicAwareDrop`: mirrors `policy.evictionPlan.preferTopicAwareDrop`.
 */
export type AdaptiveEvictionBypassReason = 'no-active-topic' | 'no-stamped-clusters' | 'band-not-topic-aware' | 'within-budget' | 'no-eligible-inactive-topic-clusters';
export interface AdaptiveEvictionTelemetry {
    topicAwareEligibleClusters: number;
    topicAwareDroppedClusters: number;
    protectedClusters: number;
    topicIdCoveragePct: number;
    bypassReason?: AdaptiveEvictionBypassReason;
}
export interface AdaptiveEvictionOrdering {
    preferTopicAwareDrop: boolean;
    topicAwareDropOrder: number[];
    protectedIndices: ReadonlySet<number>;
    telemetry: AdaptiveEvictionTelemetry;
}
export declare function orderClustersForAdaptiveEviction<T extends NeutralMessage>(clusters: NeutralMessageCluster<T>[], policy: AdaptiveLifecyclePolicy, opts?: {
    activeTopicId?: string;
}): AdaptiveEvictionOrdering;
/**
 * Public reshape helper: apply tool gradient then trim to fit within a token budget.
 *
 * Used by the plugin's budget-downshift pass to pre-process a Redis history window
 * after a model switch to a smaller context window, before the full compose pipeline
 * runs. Trims from oldest to newest until estimated token cost fits within
 * tokenBudget * 0.65 (using the standard char/4 heuristic).
 *
 * @param messages     NeutralMessage array from the Redis hot window
 * @param tokenBudget  Effective token budget for this session
 * @returns            Trimmed message array ready for setWindow()
 */
export declare function applyToolGradientToWindow(messages: NeutralMessage[], tokenBudget: number, totalWindowTokens?: number): NeutralMessage[];
/**
 * Canonical history must remain lossless for tool turns.
 *
 * If a window contains any structured tool calls or tool results, the caller
 * should treat applyToolGradientToWindow() as a view-only transform for the
 * current compose pass and avoid writing the reshaped messages back into the
 * canonical cache/history store.
 */
export declare function canPersistReshapedHistory(messages: NeutralMessage[]): boolean;
declare function truncateWithHeadTail(content: string, maxChars: number, maxTailChars?: number): string;
declare function appendToolSummary(textContent: string | null, summary: string): string;
declare function getTurnAge(messages: NeutralMessage[], index: number): number;
declare function applyTierPayloadCap(msg: NeutralMessage, perResultCap: number, perTurnCap?: number, usedSoFar?: number, maxTailChars?: number): {
    msg: NeutralMessage;
    usedChars: number;
};
declare function evictLargeToolResults<T extends NeutralMessage>(messages: T[]): T[];
export declare function resolveArtifactOversizeThreshold(effectiveBudget: number): number;
/**
 * C2: Degrade an oversized doc chunk to a canonical ArtifactRef string.
 *
 * When a retrieved chunk's content exceeds the oversize threshold (in tokens),
 * replace it with a fetchable canonical reference instead of injecting raw content.
 * This preserves headroom in the lane instead of filling it with a large payload.
 *
 * Returns:
 *   - `null`  → content is within the threshold; caller should inject as-is.
 *   - `string` → canonical artifact reference; caller should inject this instead of raw content.
 *
 * The sizeTokens reported in the reference is the ACTUAL estimated size so downstream
 * tooling can make informed decisions about whether to fetch.
 */
export declare function degradeOversizedDocChunk(chunkId: string, sourcePath: string, content: string, thresholdTokens: number): string | null;
/**
 * C2: Resolve oversized artifacts in a history message array.
 *
 * Scans the message array and replaces user/assistant messages whose text content
 * exceeds the model-aware artifact oversize threshold with canonical ArtifactRef
 * strings. System messages, tool-call messages, and tool-result messages are always
 * passed through unchanged.
 *
 * @param messages — neutral message array (already-assembled history window)
 * @param effectiveBudget — effective model budget from B4 (drives the threshold)
 * @returns { messages, refCount, tokensSaved }
 */
export declare function resolveOversizedArtifacts<T extends NeutralMessage>(messages: T[], effectiveBudget: number): {
    messages: T[];
    refCount: number;
    tokensSaved: number;
};
/**
 * Result of a single tool-chain ejection pass.
 * Returned by resolveToolChainEjections so callers can accumulate telemetry.
 */
export interface ToolChainEjectionResult<T extends NeutralMessage> {
    /** The transformed message array (may contain stubs in place of results). */
    messages: T[];
    /** Number of tool-result messages fully co-ejected (removed from the array). */
    coEjections: number;
    /** Number of tool-result payloads replaced with a canonical stub string. */
    stubReplacements: number;
}
/**
 * C1: Centralized tool-chain dependency ejection.
 *
 * Given a set of tool-use message indices that are being ejected from the
 * context window, this function ensures that no orphaned tool-results survive:
 *
 *   - For each ejected assistant message carrying toolCalls, collect the set
 *     of call IDs being removed.
 *   - Walk the remaining messages: if a message's toolResults reference any
 *     of those ejected IDs:
 *       a) If the message carries ONLY tool-results and no other text, co-eject
 *          it (remove it entirely). This is the zero-cost path.
 *       b) If the message also carries text content, replace only the dependent
 *          toolResults entries with canonical ToolChainStub strings so the
 *          message is not silently mutilated.
 *
 * The caller is responsible for removing the ejected messages by index BEFORE
 * or AFTER calling this function; this function operates on the full array and
 * marks the ejected indices for removal, returning the cleaned result.
 *
 * @param messages       Full message array (order preserved)
 * @param ejectIndices   Set of indices into `messages` that are being ejected
 *                       (these are the tool-use / assistant messages being removed).
 * @param reason         DegradationReason to embed in any canonical stubs.
 * @returns              Cleaned message array + telemetry counters.
 */
export declare function resolveToolChainEjections<T extends NeutralMessage>(messages: T[], ejectIndices: Set<number>, reason?: DegradationReason): ToolChainEjectionResult<T>;
/**
 * Apply gradient tool treatment to a message array.
 *
 * Tiers are based on turn age, where turn age is the number of newer user
 * messages after the current message.
 */
declare function applyToolGradient<T extends NeutralMessage>(messages: T[], opts?: {
    totalWindowTokens?: number;
}): T[];
export interface CompositorDeps {
    cache: AnyCache;
    vectorStore?: VectorStore | null;
    libraryDb?: DatabaseSync | null;
    /** Custom trigger registry; defaults to DEFAULT_TRIGGERS if not provided */
    triggerRegistry?: CollectionTrigger[];
    /**
     * Optional reranker applied to fused hybridSearch results. Null disables
     * reranking; hybridSearch still runs and returns the RRF-ordered list.
     */
    reranker?: import('./reranker.js').RerankerProvider | null;
    /** Min fused-candidate count before the reranker is invoked. Default: 2. */
    rerankerMinCandidates?: number;
    /** Max docs sent to reranker (bounds provider cost). Default: all fused. */
    rerankerMaxDocuments?: number;
    /** Top-K passed to reranker. Default: slice length. */
    rerankerTopK?: number;
}
export declare class Compositor {
    private readonly config;
    private readonly cache;
    private vectorStore;
    private readonly libraryDb;
    private readonly triggerRegistry;
    private reranker;
    private readonly rerankerMinCandidates;
    private readonly rerankerMaxDocuments;
    private readonly rerankerTopK;
    /** Cached org registry loaded from fleet_agents at construction time. */
    private _orgRegistry;
    constructor(deps: CompositorDeps, config?: Partial<CompositorConfig>);
    /**
     * Set or replace the vector store after construction.
     * Called by hypermem.create() once sqlite-vec is confirmed available.
     */
    setVectorStore(vs: VectorStore): void;
    /**
     * Set or replace the reranker after construction.
     * Called by hypermem.create() once the reranker config has been resolved.
     */
    setReranker(rr: import('./reranker.js').RerankerProvider | null): void;
    /**
     * Hot-reload the org registry from the fleet_agents table.
     * Call after fleet membership changes (new agent, org restructure)
     * to pick up the latest without a full restart.
     * Falls back to the current cached registry if the DB is unavailable.
     */
    refreshOrgRegistry(): OrgRegistry;
    /**
     * Return the currently cached org registry.
     */
    get orgRegistry(): OrgRegistry;
    /**
     * Sprint 2.1: Hydrate tool-artifact stubs in the active turn.
     *
     * The active turn is the contiguous trailing block of tool-bearing messages
     * at the tail of the assembled window (positional, NOT turn_id-based):
     *   - Walk backward from the last message
     *   - Collect tool-bearing messages (toolCalls != null OR toolResults != null)
     *   - Plus the bounding user message that opened the turn
     *   - Stop at the first plain message once at least one tool message was found
     *
     * For every toolResult stub with an `artifact=<id>` pointer, look up the
     * full payload in ToolArtifactStore and replace the stub content in-place.
     * Uses a single batched `WHERE id IN (...)` lookup (no N+1 queries).
     * Touches `last_used_at` on every hydrated artifact in a single batch.
     *
     * Failure mode: if a lookup returns null (artifact missing), leave the stub
     * unchanged and increment hydrationMisses.
     *
     * Returns diagnostics counters.
     */
    private hydrateActiveTurnArtifacts;
    /**
     * Compose a complete message array for sending to an LLM.
     *
     * Orchestrates all four memory layers:
     *   1. System prompt + identity (never truncated)
     *   2. Conversation history (L1 Redis → L2 messages.db)
     *   3. Active facts from library (L4)
     *   4. Knowledge entries relevant to conversation (L4)
     *   5. User preferences (L4)
     *   6. Semantic recall via vector search (L3)
     *   7. Cross-session context (L2)
     *
     * Each slot respects the remaining token budget.
     */
    compose(request: ComposeRequest, db: DatabaseSync, libraryDb?: DatabaseSync): Promise<ComposeResult>;
    /**
     * Warm a session from SQLite into Redis.
     * Called on session start or Redis cache miss.
     */
    warmSession(agentId: string, sessionKey: string, db: DatabaseSync, opts?: {
        systemPrompt?: string;
        identity?: string;
        libraryDb?: DatabaseSync;
        /** Model string for budget resolution. If omitted, falls back to defaultTokenBudget. */
        model?: string;
    }): Promise<void>;
    refreshRedisGradient(agentId: string, sessionKey: string, db: DatabaseSync, tokenBudget?: number, historyDepth?: number, trimSoftTarget?: number): Promise<void>;
    /**
     * Get slot content: try Redis first, fall back to SQLite.
     */
    private getSlotContent;
    /**
     * Get conversation history: try Redis first, fall back to SQLite.
     *
     * When topicId is provided (P3.4), the SQLite path filters to messages
     * matching that topic OR with topic_id IS NULL (Option B transition safety).
     * The Redis path is unaffected — Redis doesn't index by topic, so topic
     * filtering only applies to the SQLite fallback.
     */
    private getHistory;
    /**
     * Build facts content from library DB.
     */
    /**
     * Build facts content from library DB.
     * Applies filterByScope (W1) to enforce retrieval access control.
     * Returns [content, factCount, scopeFilteredCount] or null if DB unavailable.
     */
    private buildFactsFromDb;
    private buildFactSectionsFromDb;
    /**
     * Build knowledge content from library DB.
     * Prioritizes high-confidence, non-superseded entries.
     */
    private buildKnowledgeFromDb;
    /**
     * Build wiki page context for the active topic.
     * Queries the knowledge table for a synthesized topic page and returns it
     * wrapped with a header. Capped at 600 tokens.
     */
    private buildWikiPageContext;
    /**
     * Build preferences content from library DB.
     * Shows user/operator preferences relevant to this agent.
     */
    private buildPreferencesFromDb;
    /**
     * Build semantic recall content using hybrid FTS5+KNN retrieval.
     *
     * Uses Reciprocal Rank Fusion to merge keyword and vector results.
     * Gracefully degrades: FTS5-only when no vector store, KNN-only
     * when FTS query is empty (all stop words), both when available.
     *
     * @param precomputedEmbedding — optional pre-computed embedding for the query.
     *   When provided, the Ollama call inside VectorStore.search() is skipped.
     */
    private buildSemanticRecall;
    /**
     * Format a hybrid search result for injection into context.
     * Shows retrieval source(s) and relevance score.
     */
    private formatHybridResult;
    /**
     * Format a vector-only search result (legacy fallback).
     */
    private formatVectorResult;
    /**
     * Build cross-session context by finding recent activity
     * in other sessions for this agent.
     */
    private buildCrossSessionContext;
    /**
     * Extract the last user message text from the composed messages.
     */
    private getLastUserMessage;
    /**
     * Truncate text to approximately fit within a token budget.
     * Truncates at line boundaries when possible.
     */
    private truncateToTokens;
    /**
     * Query and score keystone candidates from before the current history window.
     *
     * Trims the oldest messages from includedHistory to free a keystone budget,
     * then queries the DB for older messages scored by episode significance,
     * FTS5 relevance, and recency.
     *
     * Returns null if keystones cannot be injected (no cutoff ID found,
     * no candidates, or all errors).
     */
    private buildKeystones;
    /**
     * Pull high-signal messages from OTHER topics in this session when their
     * content is semantically relevant to the current active topic.
     *
     * Heuristic-only: no model calls. Token overlap between the current topic
     * name + last 3 user messages and candidate message content.
     *
     * @param agentId      - The agent's ID
     * @param sessionKey   - Current session key
     * @param activeTopic  - The current active topic (id + name)
     * @param currentMessages - Recently included history messages for query extraction
     * @param db           - The messages database
     * @param maxKeystones - Max cross-topic keystones to return (default 3)
     * @returns Scored keystones sorted by score DESC, deduplicated by message id
     */
    private getKeystonesByTopic;
    /**
     * Extract lowercase key terms from a topic name and the last 3 user messages.
     * Terms are: tokens with ≥4 characters (skip short stop words).
     * Returns a Set for O(1) lookup.
     */
    private extractQueryTerms;
}
//# sourceMappingURL=compositor.d.ts.map