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
import { createHash } from 'node:crypto';
import type {
  ComposeRequest,
  ComposeResult,
  ComposeDiagnostics,
  CompositorBudgetLanes,
  OpenAIPrefixCacheDiag,
  SlotTokenCounts,
  NeutralMessage,
  ProviderMessage,
  StoredMessage,
  CompositorConfig,
  SessionMeta,
  SessionCursor,
} from './types.js';
import { filterByScope } from './retrieval-policy.js';
import {
  CollectionTrigger,
  DEFAULT_TRIGGERS,
  matchTriggers,
  logRegistryStartup,
  TRIGGER_REGISTRY_VERSION,
  TRIGGER_REGISTRY_HASH,
} from './trigger-registry.js';
import { CacheLayer } from './cache.js';
type AnyCache = CacheLayer;
import { MessageStore } from './message-store.js';
import { SessionTopicMap } from './session-topic-map.js';
import { toProviderFormat, detectProvider as s4DetectProvider } from './provider-translator.js';
import { VectorStore, type VectorSearchResult } from './vector-store.js';
import { DocChunkStore } from './doc-chunk-store.js';
import { hybridSearch, type HybridSearchResult, type RerankerTelemetry } from './hybrid-retrieval.js';
import { ensureCompactionFenceSchema, updateCompactionFence, getCompactionFence, getCompactionEligibility } from './compaction-fence.js';
import { getActiveContext, getOrCreateActiveContext, type Context } from './context-store.js';
import { rankKeystones, scoreKeystone, type KeystoneCandidate, type ScoredKeystone } from './keystone-scorer.js';
import { buildOrgRegistryFromDb, defaultOrgRegistry, type OrgRegistry } from './cross-agent.js';
import { getActiveFOS, matchMOD, renderFOS, renderMOD, renderLightFOS, resolveOutputTier, buildActionVerificationSummary } from './fos-mod.js';
import { KnowledgeStore } from './knowledge-store.js';
import { TemporalStore, hasTemporalSignals } from './temporal-store.js';
import { isOpenDomainQuery, searchOpenDomain } from './open-domain.js';
import { TRIM_BUDGET_POLICY, resolveTrimBudgets } from './budget-policy.js';
import { resolveAdaptiveLifecyclePolicy, type AdaptiveLifecyclePolicy } from './adaptive-lifecycle.js';
import { formatToolChainStub, parseToolChainStub, formatArtifactRef, isArtifactRef, type ArtifactRef, type DegradationReason } from './degradation.js';
import { ToolArtifactStore } from './tool-artifact-store.js';
import {
  insertCompositionSnapshot,
  getLatestValidCompositionSnapshot,
  listCompositionSnapshots,
  MAX_WARM_RESTORE_REPAIR_DEPTH,
} from './composition-snapshot-store.js';
import {
  buildCompositionSnapshotSlots,
  restoreWarmSnapshotState,
  WARM_RESTORE_MEASUREMENT_GATES,
} from './composition-snapshot-runtime.js';

/**
 * Files that OpenClaw's contextInjection injects into the system prompt.
 * HyperMem must not re-inject these via doc chunk retrieval to avoid duplication.
 * Exported so plugin and other consumers can share the same dedup set.
 */
export const OPENCLAW_BOOTSTRAP_FILES = new Set([
  'SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md',
  'AGENTS.md', 'HEARTBEAT.md', 'MEMORY.md', 'BOOTSTRAP.md',
]);

const CACHE_PREFIX_BOUNDARY_SLOT = 'cache-prefix-boundary';

/**
 * Model context window sizes by provider/model string (or partial match).
 * Used as fallback when tokenBudget is not passed by the runtime.
 * Order matters: first match wins. Partial substring match on the model string.
 */
const MODEL_CONTEXT_WINDOWS: Array<{ pattern: string; tokens: number }> = [
  // Anthropic
  { pattern: 'claude-opus-4',    tokens: 200_000 },
  { pattern: 'claude-sonnet-4',  tokens: 200_000 },
  { pattern: 'claude-3-5',       tokens: 200_000 },
  { pattern: 'claude-3-7',       tokens: 200_000 },
  { pattern: 'claude',           tokens: 200_000 },
  // OpenAI
  { pattern: 'gpt-5',            tokens: 128_000 },
  { pattern: 'gpt-4o',           tokens: 128_000 },
  { pattern: 'gpt-4',            tokens: 128_000 },
  { pattern: 'o3',               tokens: 128_000 },
  { pattern: 'o4',               tokens: 128_000 },
  // Google
  { pattern: 'gemini-3.1-pro',   tokens: 1_000_000 },
  { pattern: 'gemini-3.1-flash', tokens: 1_000_000 },
  { pattern: 'gemini-2.5-pro',   tokens: 1_000_000 },
  { pattern: 'gemini-2',        tokens: 1_000_000 },
  { pattern: 'gemini',           tokens: 1_000_000 },
  // Zhipu / GLM
  { pattern: 'glm-5',            tokens: 131_072 },
  { pattern: 'glm-4',            tokens: 131_072 },
  // Alibaba / Qwen
  { pattern: 'qwen3',            tokens: 262_144 },
  { pattern: 'qwen',             tokens: 131_072 },
  // DeepSeek
  { pattern: 'deepseek-v3',      tokens: 131_072 },
  { pattern: 'deepseek',         tokens: 131_072 },
];

// ─── B4: Model-Aware Lane Budgets ────────────────────────────────────────────

/**
 * MECW = Minimum Effective Context Window (empirically observed trustable budget).
 *
 * Even when a model advertises a large context window, the practical effective
 * context for reasoning degrades past a threshold — the model starts to drop
 * facts, lose track of earlier content, or produce lower-quality output.
 *
 * The MECW tuple:
 *   - mecwFloor:   token floor below which the model always works correctly
 *   - mecwCeiling: token ceiling above which trustability degrades; lane
 *                  budgets are scaled to stay within this ceiling
 *
 * When totalBudget <= mecwFloor: use fixed fractions (all budget is safe)
 * When totalBudget > mecwFloor and <= mecwCeiling: scale lane budgets linearly
 * When totalBudget > mecwCeiling: clamp history+memory fractions so their
 *   combined token allocation stays at or below mecwCeiling.
 *
 * Observation sources:
 *   - Anthropic Claude 200k: effective retrieval degrades above ~140k input tokens (empirical)
 *   - OpenAI 128k: reliable through 128k (no observed degradation)
 *   - Gemini 1M: MECW ceiling empirically around 180k for reliable recall
 *   - Small windows (GLM, Qwen, DeepSeek 131k): small enough to use full window
 */
interface ModelMECW {
  /** Pattern matched against lowercased model string (same format as MODEL_CONTEXT_WINDOWS) */
  pattern: string;
  /** Tokens up to which the model reliably handles all injected content */
  mecwFloor: number;
  /** Tokens above which injected content starts to drop / degrade quality */
  mecwCeiling: number;
  /**
   * Preferred historyFraction when the model is under MECW ceiling pressure.
   * When budget > mecwFloor, history fraction is blended toward this value
   * so history doesn't crowd out memory when the model can't see all of it.
   */
  preferredHistoryFraction: number;
  /**
   * Preferred memoryFraction when the model is under MECW ceiling pressure.
   * History + memory combined should leave ~5-10% for fixed overhead.
   */
  preferredMemoryFraction: number;
}

const MODEL_MECW: ModelMECW[] = [
  // Claude 200k: effective recall degrades above ~140k; clamp composite budget
  { pattern: 'claude',    mecwFloor: 80_000,   mecwCeiling: 140_000, preferredHistoryFraction: 0.35, preferredMemoryFraction: 0.45 },
  // Gemini 1M: reliable up to ~180k for grounded retrieval; less for recall
  { pattern: 'gemini',   mecwFloor: 100_000,  mecwCeiling: 180_000, preferredHistoryFraction: 0.40, preferredMemoryFraction: 0.45 },
  // OpenAI 128k: full window is trustable; use standard fractions
  { pattern: 'gpt',      mecwFloor: 128_000,  mecwCeiling: 128_000, preferredHistoryFraction: 0.40, preferredMemoryFraction: 0.40 },
  { pattern: 'o3',       mecwFloor: 128_000,  mecwCeiling: 128_000, preferredHistoryFraction: 0.40, preferredMemoryFraction: 0.40 },
  { pattern: 'o4',       mecwFloor: 128_000,  mecwCeiling: 128_000, preferredHistoryFraction: 0.40, preferredMemoryFraction: 0.40 },
  // Smaller windows: full window is trustable
  { pattern: 'qwen3',    mecwFloor: 262_144,  mecwCeiling: 262_144, preferredHistoryFraction: 0.40, preferredMemoryFraction: 0.40 },
  { pattern: 'qwen',     mecwFloor: 131_072,  mecwCeiling: 131_072, preferredHistoryFraction: 0.40, preferredMemoryFraction: 0.40 },
  { pattern: 'glm',      mecwFloor: 131_072,  mecwCeiling: 131_072, preferredHistoryFraction: 0.40, preferredMemoryFraction: 0.40 },
  { pattern: 'deepseek', mecwFloor: 131_072,  mecwCeiling: 131_072, preferredHistoryFraction: 0.40, preferredMemoryFraction: 0.40 },
];

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
export function resolveModelLaneBudgets(
  model: string | undefined,
  effectiveBudget: number,
  configHistoryFraction: number,
  configMemoryFraction: number,
): {
  historyFraction: number;
  memoryFraction: number;
  mecwProfile: string | undefined;
  mecwApplied: boolean;
  mecwBlend: number;
} {
  if (!model) {
    return { historyFraction: configHistoryFraction, memoryFraction: configMemoryFraction, mecwProfile: undefined, mecwApplied: false, mecwBlend: 0 };
  }
  const normalized = model.toLowerCase();
  for (const entry of MODEL_MECW) {
    if (!normalized.includes(entry.pattern)) continue;

    // Budget is at or below the floor — full window is safe, use config fractions
    if (effectiveBudget <= entry.mecwFloor) {
      return { historyFraction: configHistoryFraction, memoryFraction: configMemoryFraction, mecwProfile: entry.pattern, mecwApplied: false, mecwBlend: 0 };
    }

    // Budget is at or above the ceiling — use preferred fractions fully
    if (effectiveBudget >= entry.mecwCeiling) {
      return { historyFraction: entry.preferredHistoryFraction, memoryFraction: entry.preferredMemoryFraction, mecwProfile: entry.pattern, mecwApplied: true, mecwBlend: 1 };
    }

    // Budget is between floor and ceiling — linear blend
    const blend = (effectiveBudget - entry.mecwFloor) / (entry.mecwCeiling - entry.mecwFloor);
    const historyFraction = configHistoryFraction + blend * (entry.preferredHistoryFraction - configHistoryFraction);
    const memoryFraction = configMemoryFraction + blend * (entry.preferredMemoryFraction - configMemoryFraction);
    return {
      historyFraction: Math.round(historyFraction * 1000) / 1000,
      memoryFraction: Math.round(memoryFraction * 1000) / 1000,
      mecwProfile: entry.pattern,
      mecwApplied: true,
      mecwBlend: Math.round(blend * 1000) / 1000,
    };
  }

  // No MECW entry matched — use config fractions unchanged
  return { historyFraction: configHistoryFraction, memoryFraction: configMemoryFraction, mecwProfile: undefined, mecwApplied: false, mecwBlend: 0 };
}

/**
 * Resolve effective token budget from model string.
 * Returns the context window for the model, minus the configured reserve fraction
 * for output tokens and hypermem operational overhead.
 * Default reserve: 25% (leaves 75% for input context).
 * Falls back to defaultTokenBudget if no model match.
 */
/**
 * Resolve effective input token budget for a model.
 *
 * Priority:
 * 1. If budgetFraction is set AND model window is detected: window × budgetFraction × (1 - reserve)
 * 2. If model window detected but no budgetFraction: window × (1 - reserve)
 * 3. Fallback to defaultTokenBudget (absolute number)
 */
function resolveModelBudget(
  model: string | undefined,
  defaultBudget: number,
  reserve = 0.15,
  budgetFraction?: number,
): number {
  const window = resolveModelWindow(model, defaultBudget);
  // If we detected an actual model window (not the fallback derivation)
  if (model && budgetFraction != null) {
    const normalized = model.toLowerCase();
    for (const entry of MODEL_CONTEXT_WINDOWS) {
      if (normalized.includes(entry.pattern)) {
        return Math.floor(entry.tokens * budgetFraction * (1 - reserve));
      }
    }
  }
  // Original path: detected window × (1 - reserve), or absolute fallback
  if (!model) return defaultBudget;
  const normalized = model.toLowerCase();
  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (normalized.includes(entry.pattern)) {
      return Math.floor(entry.tokens * (1 - reserve));
    }
  }
  return defaultBudget;
}

/**
 * Resolve the raw context window size for a model (no reserve applied).
 * Used as totalWindow for dynamic reserve calculation.
 * Falls back to defaultBudget / 0.85 (reverse of 15% reserve default) if no match.
 */
function resolveModelWindow(model: string | undefined, defaultBudget: number): number {
  if (!model) return Math.floor(defaultBudget / 0.85);
  const normalized = model.toLowerCase();
  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (normalized.includes(entry.pattern)) {
      return entry.tokens;
    }
  }
  return Math.floor(defaultBudget / 0.85);
}

/**
 * Compute dynamic context window reserve based on recent turn cost.
 *
 * Reserve = clamp(avg_turn_cost × horizon / totalWindow, base, max)
 *
 * Returns the reserve fraction and diagnostics. When dynamic reserve
 * is clamped at max, sessionPressureHigh is set true so callers can
 * emit a warning or trigger checkpointing.
 */
function computeDynamicReserve(
  recentMessages: NeutralMessage[],
  totalWindow: number,
  config: CompositorConfig,
): { reserve: number; avgTurnCost: number; dynamic: boolean; pressureHigh: boolean } {
  const base = config.reserveFraction ?? config.contextWindowReserve ?? 0.25;
  const horizon = config.dynamicReserveTurnHorizon ?? 5;
  const max = config.dynamicReserveMax ?? 0.50;
  const enabled = config.dynamicReserveEnabled ?? true;

  // Cold sessions (no message history) use a minimal floor so the full window
  // stays available. The static reserveFraction applies only once the session
  // has messages and dynamic sampling can compute a meaningful estimate.
  const COLD_SESSION_FLOOR = 0.15;
  if (!enabled || totalWindow <= 0) {
    return { reserve: COLD_SESSION_FLOOR, avgTurnCost: 0, dynamic: false, pressureHigh: false };
  }
  if (recentMessages.length === 0) {
    return { reserve: COLD_SESSION_FLOOR, avgTurnCost: 0, dynamic: false, pressureHigh: false };
  }

  // Sample the last 20 user+assistant messages for turn cost estimation.
  // Tool messages are excluded — they're already compressed by the gradient
  // and don't represent per-turn user intent cost.
  const sample = recentMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20);

  if (sample.length === 0) {
    return { reserve: base, avgTurnCost: 0, dynamic: false, pressureHigh: false };
  }

  const totalCost = sample.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const avgTurnCost = Math.floor(totalCost / sample.length);
  const safetyTokens = avgTurnCost * horizon;
  const dynamicFrac = safetyTokens / totalWindow;

  if (dynamicFrac <= base) {
    return { reserve: base, avgTurnCost, dynamic: false, pressureHigh: false };
  }

  if (dynamicFrac >= max) {
    return { reserve: max, avgTurnCost, dynamic: true, pressureHigh: true };
  }

  return { reserve: dynamicFrac, avgTurnCost, dynamic: true, pressureHigh: false };
}

// ─── Sprint 4: Pre-Compose History Depth Tightening ───────────────────────

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
export function classifySessionType(messages: NeutralMessage[]): SessionType {
  if (messages.length === 0) return 'plain-chat';
  const toolCount = messages.filter(m => hasToolContent(m)).length;
  return toolCount / messages.length >= 0.20 ? 'tool-heavy' : 'plain-chat';
}

/**
 * Estimate the average token cost per message from a recent message sample.
 * Uses the same estimateMessageTokens heuristic as the compositor budget walk
 * so the returned depth is directly comparable to the historyFillCap check.
 *
 * Returns a conservative floor (100 tokens) when the sample is empty to avoid
 * returning Infinity when historyBudget is divided by density.
 */
export function estimateObservedMsgDensity(messages: NeutralMessage[]): number {
  if (messages.length === 0) return 100;
  const total = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return Math.max(1, Math.ceil(total / messages.length));
}

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
export function computeAdaptiveHistoryDepth(
  sessionType: SessionType,
  observedDensity: number,
  historyBudgetTokens: number,
  maxHistoryMessages: number,
): number {
  const SAFETY_MARGIN = 0.85;
  if (sessionType === 'tool-heavy') {
    // Tool-heavy: post-gradient density is much lower than pre-gradient.
    // Gradient tiers collapse T2/T3 payloads to compact stubs (15-30% of original).
    // Use a blended factor of 0.30 as the expected post-gradient density ratio.
    const TOOL_GRADIENT_DENSITY_FACTOR = 0.30;
    const postGradientDensity = Math.max(50, Math.floor(observedDensity * TOOL_GRADIENT_DENSITY_FACTOR));
    const depth = Math.floor((historyBudgetTokens * SAFETY_MARGIN) / postGradientDensity);
    return Math.min(maxHistoryMessages, Math.max(15, depth));
  }
  // Plain-chat: pre-gradient and post-gradient density are the same.
  // historyBudget / avgMsgCost gives the message count that fills the budget.
  const depth = Math.floor((historyBudgetTokens * SAFETY_MARGIN) / observedDensity);
  return Math.min(maxHistoryMessages, Math.max(20, depth));
}

// ─── Sprint 3: Unified Pressure Signal ───────────────────────────────────────────────────────

/**
 * Canonical pressure labels shared across compose and compaction paths.
 * Use these constants when setting the `pressureSource` field so all consumers
 * can filter logs with a stable string without guessing spellings.
 */
export const PRESSURE_SOURCE = {
  /** Compose path: pressure derived from (budget - remaining) after full slot assembly. */
  COMPOSE_POST_ASSEMBLY: 'compose:post-assembly',
  /** Compose path: pressure measured immediately before semantic recall runs. */
  COMPOSE_PRE_RECALL: 'compose:pre-recall',
  /** Compaction path: pressure from Redis token estimate / effectiveBudget. */
  COMPACT_REDIS_ESTIMATE: 'compact:redis-estimate',
  /** Compaction path: pressure from runtime-reported currentTokenCount / effectiveBudget. */
  COMPACT_RUNTIME_TOTAL: 'compact:runtime-total',
  /** Tool-loop assemble path: pressure from in-memory working message array / effectiveBudget. */
  TOOLLOOP_RUNTIME_ARRAY: 'toolloop:runtime-array',
} as const;

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
export function computeUnifiedPressure(
  usedTokens: number,
  budgetTokens: number,
  source: string,
): { fraction: number; pct: number; source: string } {
  const fraction = budgetTokens > 0 ? usedTokens / budgetTokens : 0;
  const pct = Math.round(fraction * 100);
  return { fraction, pct, source };
}

/**
 * 0.9.0: adaptive lifecycle scales semantic-recall breadth in compose.
 *
 * Base fractions match the historical compositor constants so that a steady
 * (multiplier=1.0) call reproduces prior behavior exactly. Candidate limit is
 * clamped so even a critical-pressure pass keeps a usable retrieval window
 * and a /new surge does not blow up hybrid search cost.
 */
export const RECALL_BREADTH_BASE = Object.freeze({
  mainBudgetFraction: 0.12,
  fallbackBudgetFraction: 0.10,
  candidateLimit: 10,
  candidateLimitMin: 6,
  candidateLimitMax: 16,
});

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
export function scaleRecallBreadth(
  remainingTokens: number,
  multiplier: number,
): ScaledRecallBreadth {
  const safeMultiplier = Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  const remaining = Math.max(0, Math.floor(remainingTokens || 0));
  const mainBudgetTokens = Math.max(
    0,
    Math.floor(remaining * RECALL_BREADTH_BASE.mainBudgetFraction * safeMultiplier),
  );
  const fallbackBudgetTokens = Math.max(
    0,
    Math.floor(remaining * RECALL_BREADTH_BASE.fallbackBudgetFraction * safeMultiplier),
  );
  const limitRaw = Math.ceil(RECALL_BREADTH_BASE.candidateLimit * safeMultiplier);
  const candidateLimit = Math.min(
    RECALL_BREADTH_BASE.candidateLimitMax,
    Math.max(RECALL_BREADTH_BASE.candidateLimitMin, limitRaw),
  );
  return { mainBudgetTokens, fallbackBudgetTokens, candidateLimit, multiplier: safeMultiplier };
}

const DEFAULT_CONFIG: CompositorConfig = {
  // Primary budget controls
  budgetFraction: 0.703,
  reserveFraction: 0.25,
  historyFraction: 0.40,
  memoryFraction: 0.40,
  // Absolute fallback
  defaultTokenBudget: 90000,
  // History internals
  maxHistoryMessages: 250,
  warmHistoryBudgetFraction: 0.4,
  keystoneHistoryFraction: 0.2,
  keystoneMaxMessages: 15,
  keystoneMinSignificance: 0.5,
  // Memory internals
  maxFacts: 28,
  maxCrossSessionContext: 6000,
  // Tool gradient (internal)
  maxRecentToolPairs: 3,
  maxProseToolPairs: 10,
  // Dynamic reserve
  dynamicReserveTurnHorizon: 5,
  dynamicReserveMax: 0.50,
  dynamicReserveEnabled: true,
};

// Tool gradient thresholds — controls how aggressively tool results are
// truncated as they age out of the recent window.
// Recent-turn policy (2026-04-07): protect turn 0 + turn 1, budget against a
// conservative 120k planning window, and only head+tail trim large (>40k)
// recent results when projected occupancy crosses the orange zone.
const TOOL_GRADIENT_T0_TURNS = 2;   // current + 2 prior completed turns: full fidelity (matches OpenClaw keepLastAssistants: 3)
const TOOL_GRADIENT_T1_TURNS = 4;   // turns 2-4: moderate truncation (was 3)
const TOOL_GRADIENT_T2_TURNS = 7;   // turns 4-7: aggressive truncation (was 12)
// T3 = turns 8+: one-liner stub
const TOOL_GRADIENT_T1_CHAR_CAP = 6_000;   // per-message cap (was 8k)
const TOOL_GRADIENT_T1_TURN_CAP = 12_000;  // per-turn-pair cap (was 16k)
const TOOL_GRADIENT_T2_CHAR_CAP = 800;     // per-message cap (was 1k)
const TOOL_GRADIENT_T2_TURN_CAP = 3_000;   // per-turn-pair cap (was 4k)
const TOOL_GRADIENT_T3_CHAR_CAP = 150;     // oldest tier: stub only (was 200)
const TOOL_GRADIENT_T3_TURN_CAP = 800;     // per-turn-pair cap (was 1k)
const TOOL_GRADIENT_MAX_TAIL_CHARS = 3_000; // tail preserve budget for T1+
const TOOL_GRADIENT_MIDDLE_MARKER = '\n[... tool output truncated ...]\n';
const TOOL_PLANNING_BASELINE_WINDOW = 120_000;
const TOOL_PLANNING_MIN_RESERVE_TOKENS = 24_000;
const TOOL_PRESSURE_YELLOW = 0.75;
const TOOL_PRESSURE_ORANGE = 0.80;
const TOOL_PRESSURE_RED = 0.85;
const TOOL_RECENT_OVERSIZE_CHAR_THRESHOLD = 40_000;
const TOOL_RECENT_OVERSIZE_TARGET_CHARS = 40_000;
const TOOL_RECENT_OVERSIZE_MAX_TAIL_CHARS = 12_000;
const TOOL_TRIM_NOTE_PREFIX = '[hypermem_tool_result_trim';

// ─── Trigger Registry ────────────────────────────────────────────
// Moved to src/trigger-registry.ts (W5).
// CollectionTrigger, DEFAULT_TRIGGERS, matchTriggers imported above.
// Re-exported below for backward compatibility with existing consumers.
export { CollectionTrigger, DEFAULT_TRIGGERS, matchTriggers } from './trigger-registry.js';

// ─── Test-only exports (not part of public API) ───────────────────────────
// These are exported solely for unit testing. Do not use in production code.
export { getTurnAge, applyToolGradient, appendToolSummary, truncateWithHeadTail, applyTierPayloadCap, evictLargeToolResults };
// resolveToolChainEjections is a first-class export (C1); defined below evictLargeToolResults.


interface NeutralMessageCluster<T extends NeutralMessage> {
  messages: T[];
  tokenCost: number;
}

function clusterNeutralMessages<T extends NeutralMessage>(messages: T[]): NeutralMessageCluster<T>[] {
  const clusters: NeutralMessageCluster<T>[] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    const cluster: T[] = [current];

    if (current.toolCalls && current.toolCalls.length > 0) {
      const callIds = new Set(current.toolCalls.map(tc => tc.id).filter(Boolean));
      let j = i + 1;
      while (j < messages.length) {
        const candidate = messages[j];
        if (!candidate.toolResults || candidate.toolResults.length === 0) break;
        const resultIds = candidate.toolResults.map(tr => tr.callId).filter(Boolean);
        if (callIds.size > 0 && resultIds.length > 0 && !resultIds.some(id => callIds.has(id))) break;
        cluster.push(candidate);
        j++;
      }
      i = j - 1;
    } else if (current.toolResults && current.toolResults.length > 0) {
      let j = i + 1;
      while (j < messages.length) {
        const candidate = messages[j];
        if (!candidate.toolResults || candidate.toolResults.length === 0 || (candidate.toolCalls && candidate.toolCalls.length > 0)) break;
        cluster.push(candidate);
        j++;
      }
      i = j - 1;
    }

    clusters.push({
      messages: cluster,
      tokenCost: cluster.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0),
    });
  }

  return clusters;
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
export type AdaptiveEvictionBypassReason =
  | 'no-active-topic'
  | 'no-stamped-clusters'
  | 'band-not-topic-aware'
  | 'within-budget'
  | 'no-eligible-inactive-topic-clusters';

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

export function orderClustersForAdaptiveEviction<T extends NeutralMessage>(
  clusters: NeutralMessageCluster<T>[],
  policy: AdaptiveLifecyclePolicy,
  opts: { activeTopicId?: string } = {},
): AdaptiveEvictionOrdering {
  const plan = policy.evictionPlan;
  const protectedIndices = new Set<number>();

  // Protect the most-recent user-role cluster (current-user-turn proxy when
  // the prompt is appended via history rather than as a separate message).
  for (let i = clusters.length - 1; i >= 0; i--) {
    if (clusters[i].messages.some(m => m.role === 'user')) {
      protectedIndices.add(i);
      break;
    }
  }

  // Protect dynamicBoundary clusters and pure-system clusters.
  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    const hasDynamicBoundary = cluster.messages.some(m => {
      const meta = (m.metadata as Record<string, unknown> | undefined);
      return meta?.dynamicBoundary === true;
    });
    if (hasDynamicBoundary) protectedIndices.add(i);
    if (cluster.messages.length > 0 && cluster.messages.every(m => m.role === 'system')) {
      protectedIndices.add(i);
    }
  }

  const totalMessages = clusters.reduce((sum, cluster) => sum + cluster.messages.length, 0);
  const stampedMessages = clusters.reduce(
    (sum, cluster) => sum + cluster.messages.filter(m => typeof (m as { topicId?: string }).topicId === 'string').length,
    0,
  );
  const topicIdCoveragePct = totalMessages > 0
    ? Math.round((stampedMessages / totalMessages) * 10000) / 100
    : 0;

  const topicAwareDropOrder: number[] = [];
  const activeId = opts.activeTopicId;
  if (plan.preferTopicAwareDrop && activeId) {
    for (let i = 0; i < clusters.length; i++) {
      if (protectedIndices.has(i)) continue;
      const cluster = clusters[i];
      // Tool clusters are handled by ballast reduction; skip from
      // topic-aware drop preference to keep tool chains atomic.
      const hasToolContent = cluster.messages.some(m =>
        (m.toolCalls && m.toolCalls.length > 0)
        || (m.toolResults && m.toolResults.length > 0));
      if (hasToolContent) continue;
      // Inactive-topic predicate: every message in the cluster carries a
      // topicId distinct from the active topic. Messages without topicId
      // (legacy/unscoped) are not promoted to drop candidates so we don't
      // regress sessions that pre-date topic stamping.
      const tids = cluster.messages.map(m => (m as { topicId?: string }).topicId);
      if (tids.length === 0) continue;
      const allInactive = tids.every(tid => typeof tid === 'string' && tid !== activeId);
      if (allInactive) topicAwareDropOrder.push(i);
    }
  }

  let bypassReason: AdaptiveEvictionBypassReason | undefined;
  if (!activeId) bypassReason = 'no-active-topic';
  else if (stampedMessages === 0) bypassReason = 'no-stamped-clusters';
  else if (!plan.preferTopicAwareDrop) bypassReason = 'band-not-topic-aware';
  else if (topicAwareDropOrder.length === 0) bypassReason = 'no-eligible-inactive-topic-clusters';

  return {
    preferTopicAwareDrop: plan.preferTopicAwareDrop,
    topicAwareDropOrder,
    protectedIndices,
    telemetry: {
      topicAwareEligibleClusters: topicAwareDropOrder.length,
      topicAwareDroppedClusters: 0,
      protectedClusters: protectedIndices.size,
      topicIdCoveragePct,
      bypassReason,
    },
  };
}

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
export function applyToolGradientToWindow(
  messages: NeutralMessage[],
  tokenBudget: number,
  totalWindowTokens?: number,
): NeutralMessage[] {
  const reshaped = applyToolGradient(messages, { totalWindowTokens });
  const { softBudget: targetTokens } = resolveTrimBudgets(tokenBudget);
  const clusters = clusterNeutralMessages(reshaped);
  let totalTokens = clusters.reduce((sum, cluster) => sum + cluster.tokenCost, 0);
  let start = 0;
  // walk oldest to newest, drop until we fit
  while (totalTokens > targetTokens && start < clusters.length - 1) {
    totalTokens -= clusters[start].tokenCost;
    start++;
  }
  return clusters.slice(start).flatMap(cluster => cluster.messages);
}

/**
 * Canonical history must remain lossless for tool turns.
 *
 * If a window contains any structured tool calls or tool results, the caller
 * should treat applyToolGradientToWindow() as a view-only transform for the
 * current compose pass and avoid writing the reshaped messages back into the
 * canonical cache/history store.
 */
export function canPersistReshapedHistory(messages: NeutralMessage[]): boolean {
  return !messages.some(msg => hasToolContent(msg));
}

/**
 * Rough token estimation: ~4 chars per token for English text.
 * This is a heuristic — actual tokenization varies by model.
 * Good enough for budget management; exact count comes from the provider.
 */
function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Dense token estimation for tool content (JSON, code, base64).
 * Tool payloads are typically 2x denser than English prose.
 */
function estimateToolTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function estimateMessageTokens(msg: NeutralMessage): number {
  let tokens = estimateTokens(msg.textContent);
  if (msg.toolCalls) {
    tokens += estimateToolTokens(JSON.stringify(msg.toolCalls)); // dense: /2 not /4
  }
  if (msg.toolResults) {
    tokens += estimateToolTokens(JSON.stringify(msg.toolResults)); // dense: /2 not /4
  }
  // Overhead per message (role, formatting)
  tokens += 4;
  return tokens;
}


function isDynamicBoundaryMessage(msg: NeutralMessage): boolean {
  return Boolean((msg.metadata as Record<string, unknown> | undefined)?.dynamicBoundary);
}

function getStablePrefixMessages(messages: NeutralMessage[]): NeutralMessage[] {
  const prefix: NeutralMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== 'system') break;
    if (isDynamicBoundaryMessage(msg)) break;
    prefix.push(msg);
  }
  return prefix;
}

function computeStablePrefixHash(messages: NeutralMessage[]): string | undefined {
  if (messages.length === 0) return undefined;
  const hash = createHash('sha256');
  for (const msg of messages) {
    hash.update(msg.textContent ?? '');
    hash.update('\n␞\n');
  }
  return hash.digest('hex');
}

function parseToolArgs(argumentsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toolLabelFromCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read':
      return `read ${(args.path ?? args.file_path ?? args.filePath ?? 'file') as string}`;
    case 'write':
      return `write ${(args.path ?? args.file ?? args.filePath ?? 'file') as string}`;
    case 'edit':
      return `edit ${(args.path ?? args.file ?? args.filePath ?? 'file') as string}`;
    case 'exec':
      return `exec ${String(args.command ?? '').slice(0, 80) || 'command'}`;
    case 'web_search':
      return `web_search ${String(args.query ?? '').slice(0, 80) || 'query'}`;
    case 'web_fetch':
      return `web_fetch ${String(args.url ?? '').slice(0, 80) || 'url'}`;
    case 'sessions_send':
      return `sessions_send ${String(args.sessionKey ?? args.label ?? '').slice(0, 80) || 'target'}`;
    case 'memory_search':
      return `memory_search ${String(args.query ?? '').slice(0, 80) || 'query'}`;
    default:
      return name;
  }
}

/**
 * Strip OpenClaw's external-content security wrapper from tool results before truncation.
 * web_fetch results are wrapped in <<<BEGIN_EXTERNAL_UNTRUSTED_CONTENT ... >>> blocks.
 * That preamble consumes the entire head budget in truncateWithHeadTail, leaving only
 * the security notice + last sentence visible — the actual body becomes the middle marker.
 * Strip the wrapper first so truncation operates on the real content.
 */
function stripSecurityPreamble(content: string): string {
  // Match: <<<BEGIN_EXTERNAL_UNTRUSTED_CONTENT id="...">\n...\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="...">>>
  // Strip opening tag line and closing tag line; keep the content between.
  const stripped = content.replace(
    /^[\s\S]*?<<<BEGIN_EXTERNAL_UNTRUSTED_CONTENT[^\n]*>>>?\n?/,
    ''
  ).replace(
    /\n?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^\n]*>>>?[\s\S]*$/,
    ''
  );
  // If stripping removed everything or nearly everything, return original.
  return stripped.trim().length > 20 ? stripped.trim() : content;
}

// Minimum floor: if trimming would leave less than 30% of original content, return a
// stripped sentinel instead of a misleading fragment. A partial result that looks
// complete is worse than a clear signal that the result was dropped.
// Applied only in applyTierPayloadCap (pressure-driven trimming), not in structural
// truncation paths where head+tail is always semantically useful.
const TOOL_GRADIENT_MIN_USEFUL_FRACTION = 0.30;

function truncateWithHeadTail(content: string, maxChars: number, maxTailChars = TOOL_GRADIENT_MAX_TAIL_CHARS): string {
  if (content.length <= maxChars) return content;
  const tailBudget = Math.min(Math.floor(maxChars * 0.30), maxTailChars);
  const headBudget = Math.max(0, maxChars - tailBudget - TOOL_GRADIENT_MIDDLE_MARKER.length);
  return content.slice(0, headBudget) + TOOL_GRADIENT_MIDDLE_MARKER + content.slice(-tailBudget);
}

function truncateHead(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = '…';
  const keep = Math.max(0, maxChars - marker.length);
  return content.slice(0, keep) + marker;
}

function firstNonEmptyLine(content: string): string {
  const line = content.split('\n').find(l => l.trim().length > 0) ?? '';
  return line.trim();
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hostFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
}

function extractTopHeading(content: string): string {
  const heading = content.split('\n').find(line => /^#{1,3}\s+/.test(line.trim()));
  return heading ? heading.replace(/^#{1,3}\s+/, '').trim() : '';
}

function extractExitCode(content: string): string | null {
  const match = content.match(/(?:exit code|exit|code)\s*[:=]?\s*(\d+)/i);
  return match ? match[1] : null;
}

function estimateSearchResultCount(content: string): number | null {
  const jsonMatch = content.match(/"results"\s*:\s*\[/);
  if (jsonMatch) {
    const titles = content.match(/"title"\s*:/g);
    if (titles?.length) return titles.length;
  }
  const resultLines = content.match(/\bSource:\b|\bsiteName\b|\btitle\b/gi);
  return resultLines?.length ? Math.min(resultLines.length, 20) : null;
}

function summarizeOutcome(label: string, content: string, maxChars: number): string {
  const firstLine = firstNonEmptyLine(content);
  const base = firstLine ? `${label} — ${firstLine}` : `${label} — ${content.length} chars`;
  return truncateHead(base, maxChars);
}

function summarizeToolInteraction(name: string, args: Record<string, unknown>, content: string, maxChars: number, compact = false): string {
  const line = normalizeInline(firstNonEmptyLine(content));
  switch (name) {
    case 'read': {
      const path = String(args.path ?? args.file_path ?? args.filePath ?? 'file');
      const heading = extractTopHeading(content);
      const detail = heading || line || `${content.length} chars`;
      return truncateHead(`Read ${path} — ${detail}`, maxChars);
    }
    case 'exec': {
      const cmd = String(args.command ?? 'command').slice(0, compact ? 40 : 80);
      const exitCode = extractExitCode(content);
      const status = exitCode ? `exit ${exitCode}` : (/(error|failed|timeout|timed out)/i.test(content) ? 'failed' : 'completed');
      const detail = line && !/^exit\s+\d+$/i.test(line) ? `, ${line}` : '';
      return truncateHead(`Ran ${cmd} — ${status}${detail}`, maxChars);
    }
    case 'web_search': {
      const query = String(args.query ?? 'query').slice(0, compact ? 40 : 80);
      const count = estimateSearchResultCount(content);
      const heading = extractTopHeading(content);
      const detail = heading || line;
      const countText = count ? ` — ${count} results` : '';
      const summary = compact
        ? `Searched '${query}'${countText}`
        : `Searched '${query}'${countText}${detail ? `, top: ${detail}` : ''}`;
      return truncateHead(summary, maxChars);
    }
    case 'web_fetch': {
      const url = String(args.url ?? 'url');
      const host = hostFromUrl(url);
      const heading = extractTopHeading(content);
      const detail = heading || line || `${content.length} chars`;
      return truncateHead(`Fetched ${host} — ${detail}`, maxChars);
    }
    case 'memory_search': {
      const query = String(args.query ?? 'query').slice(0, compact ? 40 : 80);
      const count = estimateSearchResultCount(content);
      return truncateHead(`Searched memory for '${query}'${count ? ` — ${count} hits` : ''}${line ? `, top: ${line}` : ''}`, maxChars);
    }
    default: {
      const label = toolLabelFromCall(name, args);
      return compact
        ? truncateHead(`${label} — ${line || `${content.length} chars`}`, maxChars)
        : (() => {
            const prefix = `[${label}] `;
            const available = Math.max(40, maxChars - prefix.length);
            return prefix + truncateWithHeadTail(content, available);
          })();
    }
  }
}

function buildTier2Envelope(label: string, content: string, maxChars: number, name?: string, args?: Record<string, unknown>): string {
  if (name && args) return summarizeToolInteraction(name, args, content, maxChars, false);
  const prefix = `[${label}] `;
  const available = Math.max(40, maxChars - prefix.length);
  return prefix + truncateWithHeadTail(content, available);
}

function buildTier3Envelope(label: string, content: string, maxChars: number, name?: string, args?: Record<string, unknown>): string {
  if (name && args) return `[${summarizeToolInteraction(name, args, content, maxChars - 2, true)}]`;
  return `[${summarizeOutcome(label, content, maxChars - 2)}]`;
}

/**
 * Extract a heuristic prose summary from a tool call/result pair.
 * Used when tool payloads are removed but continuity should remain.
 */
function extractToolProseSummary(msg: NeutralMessage, perResultCap: number, compact: boolean = false): string {
  const parts: string[] = [];

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      const args = parseToolArgs(tc.arguments);
      const label = toolLabelFromCall(tc.name, args);
      const resultContent = msg.toolResults?.find(r => r.callId === tc.id)?.content ?? '';
      if (resultContent) {
        parts.push(compact
          ? buildTier3Envelope(label, resultContent, perResultCap, tc.name, args)
          : buildTier2Envelope(label, resultContent, perResultCap, tc.name, args));
      } else {
        parts.push(compact ? `[${truncateHead(label, perResultCap - 2)}]` : label);
      }
    }
  } else if (msg.toolResults && msg.toolResults.length > 0) {
    for (const tr of msg.toolResults) {
      const label = tr.name || 'tool_result';
      const args: Record<string, unknown> = {};
      parts.push(compact
        ? buildTier3Envelope(label, tr.content ?? '', perResultCap, tr.name || 'tool_result', args)
        : buildTier2Envelope(label, tr.content ?? '', perResultCap, tr.name || 'tool_result', args));
    }
  }

  return truncateHead(parts.join('; '), Math.max(perResultCap, 120));
}

function appendToolSummary(textContent: string | null, summary: string): string {
  const existing = textContent ?? '';
  if (!summary) return existing;
  return existing ? `${existing}\n[Tools: ${summary}]` : summary;
}

function getTurnAge(messages: NeutralMessage[], index: number): number {
  let turnAge = 0;
  for (let i = messages.length - 1; i > index; i--) {
    const candidate = messages[i];
    if (candidate?.role === 'user' && (!candidate.toolResults || candidate.toolResults.length === 0)) {
      turnAge++;
    }
  }
  return turnAge;
}

function hasToolContent(msg: NeutralMessage): boolean {
  return Boolean((msg.toolCalls && msg.toolCalls.length > 0) || (msg.toolResults && msg.toolResults.length > 0));
}

type ToolPressureZone = 'green' | 'yellow' | 'orange' | 'red';

interface ToolPressureState {
  planningWindowTokens: number;
  reserveTokens: number;
  projectedTokens: number;
  occupancy: number;
  zone: ToolPressureZone;
}

function resolveToolPlanningWindow(totalWindowTokens?: number): number {
  const actualWindow = totalWindowTokens && totalWindowTokens > 0
    ? totalWindowTokens
    : TOOL_PLANNING_BASELINE_WINDOW;
  return Math.min(actualWindow, TOOL_PLANNING_BASELINE_WINDOW);
}

function computeToolPressureState(messages: NeutralMessage[], totalWindowTokens?: number): ToolPressureState {
  const planningWindowTokens = resolveToolPlanningWindow(totalWindowTokens);
  const reserveTokens = Math.max(
    TOOL_PLANNING_MIN_RESERVE_TOKENS,
    Math.floor(planningWindowTokens * 0.10),
  );
  const usedTokens = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  const projectedTokens = usedTokens + reserveTokens;
  const occupancy = planningWindowTokens > 0 ? projectedTokens / planningWindowTokens : 1;

  let zone: ToolPressureZone = 'green';
  if (occupancy > TOOL_PRESSURE_RED) zone = 'red';
  else if (occupancy > TOOL_PRESSURE_ORANGE) zone = 'orange';
  else if (occupancy > TOOL_PRESSURE_YELLOW) zone = 'yellow';

  return {
    planningWindowTokens,
    reserveTokens,
    projectedTokens,
    occupancy,
    zone,
  };
}

function isStructuredTrimNote(content: string): boolean {
  return content.startsWith(TOOL_TRIM_NOTE_PREFIX);
}

function buildRecentTrimNote(
  originalChars: number,
  keptHeadChars: number,
  keptTailChars: number,
  pressure: ToolPressureState,
  resultId?: string,
): string {
  const parts = [
    TOOL_TRIM_NOTE_PREFIX,
    'partial_result=true',
    'reason=oversize_turn0_trim',
    `original_chars=${originalChars}`,
    `kept_head_chars=${keptHeadChars}`,
    `kept_tail_chars=${keptTailChars}`,
    `projected_occupancy_pct=${Math.round(pressure.occupancy * 100)}`,
    `planning_window_tokens=${pressure.planningWindowTokens}`,
    `reserve_tokens=${pressure.reserveTokens}`,
    'retry_recommended=true',
  ];
  if (resultId) parts.push(`result_id=${resultId}`);
  parts.push(']');
  return parts.join(' ');
}

function countHeadTailChars(content: string): { headChars: number; tailChars: number } {
  const markerIdx = content.indexOf(TOOL_GRADIENT_MIDDLE_MARKER);
  if (markerIdx === -1) {
    return { headChars: content.length, tailChars: 0 };
  }
  return {
    headChars: markerIdx,
    tailChars: content.length - markerIdx - TOOL_GRADIENT_MIDDLE_MARKER.length,
  };
}

function trimRecentToolResult(
  content: string,
  pressure: ToolPressureState,
  resultId?: string,
): string {
  if (isStructuredTrimNote(content)) return content;

  const stripped = stripSecurityPreamble(content);
  const baseOriginal = stripped.length > 0 ? stripped : content;
  const noteSkeleton = buildRecentTrimNote(baseOriginal.length, 0, 0, pressure, resultId);
  const availableChars = Math.max(
    2_000,
    TOOL_RECENT_OVERSIZE_TARGET_CHARS - noteSkeleton.length - 1,
  );
  const truncated = truncateWithHeadTail(baseOriginal, availableChars, TOOL_RECENT_OVERSIZE_MAX_TAIL_CHARS);
  const { headChars, tailChars } = countHeadTailChars(truncated);
  const note = buildRecentTrimNote(baseOriginal.length, headChars, tailChars, pressure, resultId);
  return `${note}
${truncated}`;
}

function protectRecentToolContent<T extends NeutralMessage>(msg: T, pressure: ToolPressureState): T {
  if (!msg.toolResults || msg.toolResults.length === 0) return msg;

  const shouldEmergencyTrim = pressure.zone === 'orange' || pressure.zone === 'red';
  const toolResults = msg.toolResults.map(result => {
    const content = result.content ?? '';
    if (!content) return result;
    if (!shouldEmergencyTrim) return result;
    if (content.length <= TOOL_RECENT_OVERSIZE_CHAR_THRESHOLD) return result;
    return {
      ...result,
      content: trimRecentToolResult(content, pressure, result.callId || result.name || undefined),
    };
  });

  return { ...msg, toolResults } as T;
}

function applyTierPayloadCap(msg: NeutralMessage, perResultCap: number, perTurnCap?: number, usedSoFar: number = 0, maxTailChars = TOOL_GRADIENT_MAX_TAIL_CHARS): { msg: NeutralMessage; usedChars: number } {
  const toolResults = msg.toolResults?.map(result => {
    let content = result.content ?? '';
    if (content.length > perResultCap) {
      // Strip security preamble before truncation so it doesn't consume the head budget.
      // web_fetch results wrapped in <<<EXTERNAL_UNTRUSTED_CONTENT>>> blocks would otherwise
      // render the truncated result as: [security notice] + [middle marker] + [last line].
      const stripped = stripSecurityPreamble(content);
      // Floor check (TUNE-015): if the cap would leave less than 30% of the stripped content
      // AND less than 2000 chars absolute, return a sentinel instead of a misleading fragment.
      // Partial results that look complete are worse than a clear dropped-result signal.
      // The absolute floor prevents the sentinel from firing on large natural truncations
      // (e.g., 110k → 16k is a meaningful slice, not a misleading fragment).
      if (perResultCap < stripped.length * TOOL_GRADIENT_MIN_USEFUL_FRACTION && perResultCap < 2_000) {
        content = `[result too large for current context budget \u2014 ${stripped.length} chars stripped]`;
      } else {
        // Reserve space for the \n[trimmed] marker within the cap so the total
        // content length stays within perResultCap and doesn't overflow the
        // per-turn aggregate cap when multiple results are truncated.
        const TRIMMED_MARKER = '\n[trimmed]';
        content = truncateWithHeadTail(stripped, perResultCap - TRIMMED_MARKER.length, maxTailChars) + TRIMMED_MARKER;
      }
    }
    return { ...result, content };
  }) ?? null;

  let usedChars = usedSoFar + (toolResults?.reduce((sum, r) => sum + (r.content?.length ?? 0), 0) ?? 0);
  if (perTurnCap != null && usedChars > perTurnCap) {
    const downgradeSummary = extractToolProseSummary(msg, TOOL_GRADIENT_T2_CHAR_CAP, false);
    return {
      msg: {
        ...msg,
        textContent: appendToolSummary(msg.textContent, downgradeSummary),
        toolCalls: null,
        toolResults: null,
      },
      usedChars: usedSoFar + downgradeSummary.length,
    };
  }

  return {
    msg: { ...msg, toolResults },
    usedChars,
  };
}

/**
 * Evict tool results exceeding 800 tokens (~3200 chars) before the history
 * budget-fit loop. Large stale results waste budget; replace them with a
 * stub so consumers know the result existed and can re-run if needed.
 *
 * Applied to the already-gradient-processed history before window selection.
 * Does NOT affect turn 0 or turn 1.
 */
const TOOL_RESULT_EVICTION_CHAR_THRESHOLD = 3_200; // ~800 tokens at 4 chars/token

function evictLargeToolResults<T extends NeutralMessage>(messages: T[]): T[] {
  return messages.map((msg, idx) => {
    // Never evict from the protected recent-turn window.
    const turnAge = getTurnAge(messages, idx);
    if (turnAge <= TOOL_GRADIENT_T0_TURNS) return msg;
    if (!msg.toolResults || msg.toolResults.length === 0) return msg;

    const evicted = msg.toolResults.map(result => {
      const content = result.content ?? '';
      if (content.length <= TOOL_RESULT_EVICTION_CHAR_THRESHOLD) return result;
      const approxKTokens = Math.round(content.length / 4 / 1000);
      return {
        ...result,
        content: formatToolChainStub({
          name: result.name || 'tool_result',
          id: result.callId || 'unknown',
          status: 'ejected',
          reason: 'eviction_oversize',
          summary: `~${approxKTokens}k tokens, use memory_search or re-run if needed`,
        }),
      };
    });
    return { ...msg, toolResults: evicted };
  }) as T[];
}

// ─── C2: Oversized artifact handling ────────────────────────────────────────

/**
 * C2: Resolve the artifact oversize threshold (in tokens) for the current compose pass.
 *
 * The threshold scales with the effective model budget from B4 so:
 *   - Small-window models (16k–32k effective) get a proportionally tighter threshold
 *     (threshold = budget × ARTIFACT_OVERSIZE_FRACTION, floor 500, ceiling 8000).
 *   - Large-window models (200k+) get a higher ceiling but it still stays bounded
 *     so artifacts never fill the lane unconditionally.
 *
 * ARTIFACT_BUDGET_FRACTION: fraction of the soft budget above which a single
 * retrieved artifact/chunk is considered oversized. Default 0.10 (10%).
 *
 * Headroom preservation comes from replacing the oversized artifact with a cheap
 * reference, not from shrinking the threshold itself.
 */
const ARTIFACT_BUDGET_FRACTION = 0.10;    // 10% of soft budget is the raw threshold
const ARTIFACT_THRESHOLD_FLOOR = 500;     // never below 500 tokens (~2k chars)
const ARTIFACT_THRESHOLD_CEILING = 8_000; // never above 8k tokens (~32k chars)

export function resolveArtifactOversizeThreshold(effectiveBudget: number): number {
  const { softBudget } = resolveTrimBudgets(effectiveBudget);
  const raw = Math.floor(softBudget * ARTIFACT_BUDGET_FRACTION);
  return Math.min(ARTIFACT_THRESHOLD_CEILING, Math.max(ARTIFACT_THRESHOLD_FLOOR, raw));
}

function isExplicitNewSessionPrompt(prompt: string | null | undefined): boolean {
  return /^\/new(?:\s|$)/i.test((prompt ?? '').trim());
}

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
export function degradeOversizedDocChunk(
  chunkId: string,
  sourcePath: string,
  content: string,
  thresholdTokens: number,
): string | null {
  const contentTokens = estimateTokens(content);
  if (contentTokens <= thresholdTokens) return null;

  const ref: ArtifactRef = {
    id: chunkId,
    path: sourcePath,
    sizeTokens: contentTokens,
    status: 'degraded',
    reason: 'artifact_oversize',
    fetchHint: 'memory_search or re-read source file',
  };
  return formatArtifactRef(ref);
}

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
export function resolveOversizedArtifacts<T extends NeutralMessage>(
  messages: T[],
  effectiveBudget: number,
): { messages: T[]; refCount: number; tokensSaved: number } {
  const thresholdTokens = resolveArtifactOversizeThreshold(effectiveBudget);
  let refCount = 0;
  let tokensSaved = 0;

  const out = messages.map(msg => {
    // System messages are never degraded (they are in the stable prefix).
    if (msg.role === 'system') return msg;
    // Tool content (calls/results) is C1's domain — never touch here.
    if (msg.toolResults || msg.toolCalls) return msg;
    const text = msg.textContent ?? '';
    // Already a ref — idempotent; don't re-degrade.
    if (isArtifactRef(text)) return msg;
    const contentTokens = estimateTokens(text);
    if (contentTokens <= thresholdTokens) return msg;

    // Oversized — replace with canonical artifact reference.
    const meta = msg as unknown as Record<string, unknown>;
    const id = (typeof meta['_artifactId'] === 'string' ? meta['_artifactId'] : null)
      ?? `msg-${createHash('sha1').update(`${msg.role}:${text}`).digest('hex').slice(0, 12)}`;
    const path = (typeof meta['_artifactPath'] === 'string' ? meta['_artifactPath'] : null)
      ?? '/unknown/artifact';
    const ref: ArtifactRef = {
      id,
      path,
      sizeTokens: contentTokens,
      status: 'degraded',
      reason: 'artifact_oversize',
      fetchHint: 'memory_search',
    };
    const refText = formatArtifactRef(ref);
    const refTokens = estimateTokens(refText);
    tokensSaved += contentTokens - refTokens;
    refCount++;
    return { ...msg, textContent: refText };
  });

  return { messages: out, refCount, tokensSaved };
}

// ─── C1: Tool-chain dependency ejection ──────────────────────────────────────

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
export function resolveToolChainEjections<T extends NeutralMessage>(
  messages: T[],
  ejectIndices: Set<number>,
  reason: DegradationReason = 'eviction_oversize',
): ToolChainEjectionResult<T> {
  // Collect all tool-call IDs that are being ejected.
  const ejectedCallIds = new Set<string>();
  for (const idx of ejectIndices) {
    const msg = messages[idx];
    if (!msg) continue;
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.id) ejectedCallIds.add(tc.id);
      }
    }
  }

  let coEjections = 0;
  let stubReplacements = 0;

  // If no call IDs were ejected, nothing to do beyond dropping the ejected messages.
  if (ejectedCallIds.size === 0) {
    const result = messages.filter((_, idx) => !ejectIndices.has(idx)) as T[];
    return { messages: result, coEjections, stubReplacements };
  }

  // Walk all messages and handle dependent tool-results.
  const transformed = messages.map((msg, idx): T | null => {
    // Already being ejected — remove.
    if (ejectIndices.has(idx)) return null;

    if (!msg.toolResults || msg.toolResults.length === 0) return msg;

    // Determine which results in this message depend on ejected calls.
    const dependentResultIds = msg.toolResults
      .map(r => r.callId)
      .filter((id): id is string => Boolean(id) && ejectedCallIds.has(id as string));
    if (dependentResultIds.length === 0) return msg;

    const dependentSet = new Set(dependentResultIds);

    // Case (a): The message carries ONLY tool-results and no other text content,
    // and ALL of its results are dependent on ejected calls.
    // Co-eject the whole message — zero budget cost, no stub needed.
    const hasText = Boolean(msg.textContent && msg.textContent.trim().length > 0);
    const hasNonDependentResults = msg.toolResults.some(r => !dependentSet.has(r.callId));

    if (!hasText && !hasNonDependentResults) {
      coEjections++;
      return null;
    }

    // Case (b): Message has text or unrelated results — stub only the dependent entries.
    const stubbedResults = msg.toolResults.map(result => {
      if (!result.callId || !dependentSet.has(result.callId)) return result;
      const stubContent = formatToolChainStub({
        name: result.name || 'tool_result',
        id: result.callId || 'unknown',
        status: 'ejected',
        reason,
        summary: 'parent tool-use ejected from context window',
      });
      stubReplacements++;
      return { ...result, content: stubContent };
    });

    return { ...msg, toolResults: stubbedResults };
  });

  const result = transformed.filter((m): m is T => m !== null);
  return { messages: result, coEjections, stubReplacements };
}

/**
 * Apply gradient tool treatment to a message array.
 *
 * Tiers are based on turn age, where turn age is the number of newer user
 * messages after the current message.
 */
function applyToolGradient<T extends NeutralMessage>(messages: T[], opts?: { totalWindowTokens?: number }): T[] {
  const result = [...messages] as T[];
  const pressure = computeToolPressureState(messages, opts?.totalWindowTokens);
  const perTurnUsage = new Map<number, { t0: number; t1: number; t2: number; t3: number }>();

  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (!hasToolContent(msg)) continue;

    const turnAge = getTurnAge(result, i);
    const usage = perTurnUsage.get(turnAge) ?? { t0: 0, t1: 0, t2: 0, t3: 0 };

    if (turnAge <= TOOL_GRADIENT_T0_TURNS) {
      // T0/T1: preserve full recent tool results unless we hit the conservative
      // orange/red pressure zones and the payload itself is oversized (>40k).
      result[i] = protectRecentToolContent(msg, pressure) as T;
    } else if (turnAge <= TOOL_GRADIENT_T1_TURNS) {
      const capped = applyTierPayloadCap(msg, TOOL_GRADIENT_T1_CHAR_CAP, TOOL_GRADIENT_T1_TURN_CAP, usage.t1);
      usage.t1 = capped.usedChars;
      result[i] = capped.msg as T;
    } else if (turnAge <= TOOL_GRADIENT_T2_TURNS) {
      const summary = extractToolProseSummary(msg, TOOL_GRADIENT_T2_CHAR_CAP, false);
      const allowed = Math.max(0, TOOL_GRADIENT_T2_TURN_CAP - usage.t2);
      const boundedSummary = truncateHead(summary, Math.min(TOOL_GRADIENT_T2_CHAR_CAP, allowed || TOOL_GRADIENT_T3_CHAR_CAP));
      usage.t2 += boundedSummary.length;
      result[i] = {
        ...msg,
        textContent: appendToolSummary(msg.textContent, boundedSummary),
        toolCalls: null,
        toolResults: null,
      } as T;
    } else {
      const summary = extractToolProseSummary(msg, TOOL_GRADIENT_T3_CHAR_CAP, true);
      const allowed = Math.max(0, TOOL_GRADIENT_T3_TURN_CAP - usage.t3);
      const boundedSummary = truncateHead(summary, Math.min(TOOL_GRADIENT_T3_CHAR_CAP, allowed || TOOL_GRADIENT_T3_CHAR_CAP));
      usage.t3 += boundedSummary.length;
      result[i] = {
        ...msg,
        textContent: appendToolSummary(msg.textContent, boundedSummary),
        toolCalls: null,
        toolResults: null,
      } as T;
    }

    perTurnUsage.set(turnAge, usage);
  }

  return result;
}

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

/** Guard: logRegistryStartup() fires only once per process, not per instance. */
let _registryLogged = false;

export class Compositor {
  private readonly config: CompositorConfig;
  private readonly cache: AnyCache;
  private vectorStore: VectorStore | null;
  private readonly libraryDb: DatabaseSync | null;
  private readonly triggerRegistry: CollectionTrigger[];
  private reranker: import('./reranker.js').RerankerProvider | null;
  private readonly rerankerMinCandidates: number;
  private readonly rerankerMaxDocuments: number | undefined;
  private readonly rerankerTopK: number | undefined;
  /** Cached org registry loaded from fleet_agents at construction time. */
  private _orgRegistry: OrgRegistry;

  constructor(
    deps: CompositorDeps,
    config?: Partial<CompositorConfig>
  ) {
    this.cache = deps.cache;
    this.vectorStore = deps.vectorStore || null;
    this.libraryDb = deps.libraryDb || null;
    this.triggerRegistry = deps.triggerRegistry || DEFAULT_TRIGGERS;
    this.reranker = deps.reranker ?? null;
    this.rerankerMinCandidates = deps.rerankerMinCandidates ?? 2;
    this.rerankerMaxDocuments = deps.rerankerMaxDocuments;
    this.rerankerTopK = deps.rerankerTopK;
    // Load org registry from DB on init; fall back to hardcoded if DB empty.
    this._orgRegistry = this.libraryDb
      ? buildOrgRegistryFromDb(this.libraryDb)
      : defaultOrgRegistry();
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!_registryLogged) {
      logRegistryStartup();
      _registryLogged = true;
    }
  }

  /**
   * Set or replace the vector store after construction.
   * Called by hypermem.create() once sqlite-vec is confirmed available.
   */
  setVectorStore(vs: VectorStore): void {
    this.vectorStore = vs;
  }

  /**
   * Set or replace the reranker after construction.
   * Called by hypermem.create() once the reranker config has been resolved.
   */
  setReranker(rr: import('./reranker.js').RerankerProvider | null): void {
    this.reranker = rr;
  }

  /**
   * Hot-reload the org registry from the fleet_agents table.
   * Call after fleet membership changes (new agent, org restructure)
   * to pick up the latest without a full restart.
   * Falls back to the current cached registry if the DB is unavailable.
   */
  refreshOrgRegistry(): OrgRegistry {
    if (this.libraryDb) {
      this._orgRegistry = buildOrgRegistryFromDb(this.libraryDb);
    }
    return this._orgRegistry;
  }

  /**
   * Return the currently cached org registry.
   */
  get orgRegistry(): OrgRegistry {
    return this._orgRegistry;
  }

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
  private hydrateActiveTurnArtifacts(
    messages: NeutralMessage[],
    db: DatabaseSync,
  ): { artifactsHydrated: number; hydrationBytes: number; hydrationMisses: number } {
    if (messages.length === 0) {
      return { artifactsHydrated: 0, hydrationBytes: 0, hydrationMisses: 0 };
    }

    const store = new ToolArtifactStore(db);

    // ── 1. Detect active turn (positional, backward walk) ─────────────────────
    // Collect indices belonging to the active turn.
    const activeTurnIndices: number[] = [];
    let foundToolBearing = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const isToolBearing = msg.toolCalls != null || msg.toolResults != null;
      if (isToolBearing) {
        foundToolBearing = true;
        activeTurnIndices.push(i);
      } else if (foundToolBearing) {
        // First plain message after at least one tool-bearing message — this
        // is the bounding user message that opened the turn. Include it and stop.
        activeTurnIndices.push(i);
        break;
      } else {
        // Haven't found any tool-bearing messages yet — still in non-tool tail
        // (e.g., the last message is a plain user message). No active turn.
        break;
      }
    }

    if (activeTurnIndices.length === 0 || !foundToolBearing) {
      return { artifactsHydrated: 0, hydrationBytes: 0, hydrationMisses: 0 };
    }

    // ── 2. Collect all artifactIds from stub toolResults in the active turn ───
    // Map: artifactId -> array of [msgIndex, resultIndex] for in-place replacement
    const artifactTargets = new Map<string, Array<{ msgIdx: number; resultIdx: number }>>(); 
    for (const msgIdx of activeTurnIndices) {
      const msg = messages[msgIdx];
      if (!msg.toolResults) continue;
      for (let resultIdx = 0; resultIdx < msg.toolResults.length; resultIdx++) {
        const result = msg.toolResults[resultIdx];
        const stub = parseToolChainStub(result.content);
        if (stub && stub.artifactId) {
          const existing = artifactTargets.get(stub.artifactId) ?? [];
          existing.push({ msgIdx, resultIdx });
          artifactTargets.set(stub.artifactId, existing);
        }
      }
    }

    if (artifactTargets.size === 0) {
      return { artifactsHydrated: 0, hydrationBytes: 0, hydrationMisses: 0 };
    }

    // ── 3. Batch lookup ────────────────────────────────────────────────────────
    const ids = Array.from(artifactTargets.keys());
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db
      .prepare(`SELECT * FROM tool_artifacts WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>;

    // Build id -> payload map
    const payloadMap = new Map<string, string>();
    for (const row of rows) {
      payloadMap.set(row.id as string, row.payload as string);
    }

    // ── 4. Hydrate in-place ────────────────────────────────────────────────────
    let artifactsHydrated = 0;
    let hydrationBytes = 0;
    let hydrationMisses = 0;
    const touchIds: string[] = [];

    for (const [artifactId, targets] of artifactTargets) {
      const payload = payloadMap.get(artifactId);
      if (payload == null) {
        // Graceful miss — stub stays as-is
        hydrationMisses += targets.length;
        continue;
      }
      for (const { msgIdx, resultIdx } of targets) {
        const msg = messages[msgIdx];
        // Safety: if content doesn't look like a stub anymore (defensive idempotency check)
        const existingContent = msg.toolResults![resultIdx].content;
        if (!parseToolChainStub(existingContent)) {
          // Already full content — pass through unchanged
          continue;
        }
        // Replace stub with full payload
        msg.toolResults![resultIdx] = {
          ...msg.toolResults![resultIdx],
          content: payload,
        };
        artifactsHydrated++;
        hydrationBytes += Buffer.byteLength(payload, 'utf8');
      }
      touchIds.push(artifactId);
    }

    // ── 5. Batch touch last_used_at ───────────────────────────────────────────
    if (touchIds.length > 0) {
      const ts = new Date().toISOString();
      const touchPlaceholders = touchIds.map(() => '?').join(', ');
      try {
        db.prepare(
          `UPDATE tool_artifacts SET last_used_at = ? WHERE id IN (${touchPlaceholders})`
        ).run(ts, ...touchIds);
      } catch {
        // Touch is best-effort — hydration still succeeded
      }
    }

    return { artifactsHydrated, hydrationBytes, hydrationMisses };
  }

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
  async compose(request: ComposeRequest, db: DatabaseSync, libraryDb?: DatabaseSync): Promise<ComposeResult> {
    const store = new MessageStore(db);
    const libDb = libraryDb || this.libraryDb;
    const toComposeOutputMessages = (inputMessages: NeutralMessage[]): ProviderMessage[] => {
      // When skipProviderTranslation is set, compose returns the neutral window
      // typed as ProviderMessage[] by contract. The runtime translates later.
      return request.skipProviderTranslation
        ? inputMessages as unknown as ProviderMessage[]
        : toProviderFormat(inputMessages, request.provider ?? request.model ?? null);
    };

    // ── C4: Window cache fast-exit ────────────────────────────
    // If nothing has changed since the last compose (cursor.lastSentId >= newest
    // message id in the DB), skip the full pipeline and return the cached window.
    // Particularly effective for low-frequency sessions (heartbeat agents, council
    // seats between rounds). TTL on the cache write remains 120s — this is a
    // conservative early-exit before the TTL expires, not a TTL extension.
    //
    // B2: prevPrefixHash is set when a cached bundle is found but bypassed due to
    // prefix-input mutation. It is surfaced in the full-compose diagnostics so
    // callers can confirm the bypass fired correctly.
    let _prevPrefixHashFromBypass: string | undefined;
    if (request.includeHistory !== false && request.skipWindowCache !== true) {
      try {
        const newestRow = db.prepare(
          'SELECT MAX(id) AS maxId FROM messages WHERE agent_id = ?'
        ).get(request.agentId) as { maxId: number | null } | undefined;
        const newestMsgId = newestRow?.maxId;
        if (newestMsgId != null) {
          const cachedBundle = await this.cache.getFreshWindowBundle(
            request.agentId, request.sessionKey, newestMsgId
          );
          if (cachedBundle) {
            // Validate the cached bundle is compatible with this request.
            // A mismatch on any of these means we must do a full compose:
            //   - tokenBudget: cached total exceeds the requested cap
            //   - slot flags: caller disabled slots that the cache populated
            //   - historyDepth: caller wants fewer messages than the cache holds
            const cachedTotal = cachedBundle.meta.totalTokens;
            const budgetOk = !request.tokenBudget ||
              cachedTotal <= request.tokenBudget * 1.05;
            const factsOk = request.includeFacts !== false ||
              (cachedBundle.meta.slots['facts'] ?? 0) === 0;
            const libraryOk = request.includeLibrary !== false ||
              (cachedBundle.meta.slots['library'] ?? 0) === 0;
            const contextOk = request.includeContext !== false ||
              (cachedBundle.meta.slots['context'] ?? 0) === 0;
            // historyDepth constrains how many messages the caller wants;
            // we can't slice a cached bundle safely, so skip cache.
            const depthOk = !request.historyDepth;

            // B2: Stable-prefix hash check.
            // If the system/identity slots changed since this cache entry was
            // written, the stable prefix is stale even if cursor freshness
            // passes. Compute a cheap input hash from slot contents and compare
            // against the one stored in the cache meta. If no stored hash exists
            // (pre-B2 cache entries), fall through to prefix check on the
            // cached message content itself.
            let prefixInputOk = true;
            const _cachedPrefixInputHash = cachedBundle.meta.prefixInputHash;
            if (_cachedPrefixInputHash) {
              const _sysSlot = await this.cache.getSlot(request.agentId, request.sessionKey, 'system');
              const _idSlot = await this.cache.getSlot(request.agentId, request.sessionKey, 'identity');
              const _incomingInputHash = createHash('sha256')
                .update(_sysSlot ?? '')
                .update('\n␞\n')
                .update(_idSlot ?? '')
                .digest('hex');
              if (_incomingInputHash !== _cachedPrefixInputHash) {
                prefixInputOk = false;
              }
            }

            if (budgetOk && factsOk && libraryOk && contextOk && depthOk && prefixInputOk) {
              const cachedSlots: SlotTokenCounts = {
                system: cachedBundle.meta.slots['system'] ?? 0,
                identity: cachedBundle.meta.slots['identity'] ?? 0,
                history: cachedBundle.meta.slots['history'] ?? 0,
                facts: cachedBundle.meta.slots['facts'] ?? 0,
                context: cachedBundle.meta.slots['context'] ?? 0,
                library: cachedBundle.meta.slots['library'] ?? 0,
              };
              // Sprint 2.1: hydrate active-turn artifact stubs before converting.
              const cachedHydration = this.hydrateActiveTurnArtifacts(cachedBundle.messages, db);
              return {
                messages: toComposeOutputMessages(cachedBundle.messages),
                tokenCount: cachedBundle.meta.totalTokens,
                slots: cachedSlots,
                truncated: false,
                hasWarnings: cachedBundle.meta.warnings.length > 0,
                warnings: cachedBundle.meta.warnings,
                diagnostics: {
                  ...cachedBundle.meta.diagnostics,
                  windowCacheHit: true,
                  // Carry forward the stored prefixHash so callers can observe it.
                  prefixHash: cachedBundle.meta.prefixHash ?? cachedBundle.meta.diagnostics.prefixHash,
                  artifactsHydrated: cachedHydration.artifactsHydrated > 0 ? cachedHydration.artifactsHydrated : undefined,
                  hydrationBytes: cachedHydration.hydrationBytes > 0 ? cachedHydration.hydrationBytes : undefined,
                  hydrationMisses: cachedHydration.hydrationMisses > 0 ? cachedHydration.hydrationMisses : undefined,
                },
              };
            }
            // Incompatible request — fall through to full compose.
            // Surface prevPrefixHash so the full compose diagnostics can report it.
            _prevPrefixHashFromBypass = cachedBundle.meta.prefixHash ?? cachedBundle.meta.diagnostics.prefixHash;
          }
        }
      } catch {
        // Cache fast-exit is best-effort, fall through to full compose
      }
    }

    // Dynamic reserve: use a lightweight SQLite sample to estimate avg turn cost
    // BEFORE assembling the full context. This gives us the reserve fraction we
    // need to compute the effective token budget at the start of compose.
    // Full history assembly happens later in the pipeline.
    const totalWindow = resolveModelWindow(request.model, this.config.defaultTokenBudget);
    const sampleConv = store.getConversation(request.sessionKey);
    const sampleMessages: NeutralMessage[] = sampleConv
      ? (store.getRecentMessages(sampleConv.id, 40) as NeutralMessage[])
      : [];
    const { reserve: dynamicReserve, avgTurnCost, dynamic: isDynamic, pressureHigh } =
      computeDynamicReserve(sampleMessages, totalWindow, this.config);
    const budget = request.tokenBudget || resolveModelBudget(request.model, this.config.defaultTokenBudget, dynamicReserve, this.config.budgetFraction);

    // B4: Model-aware lane budgets.
    // Resolve historyFraction and memoryFraction by blending config values toward
    // model-preferred fractions when the effective budget approaches the MECW ceiling.
    // This ensures the compositor doesn't allocate more history than the model can
    // reliably reason over, and adjusts the memory pool proportionally.
    const _b4ConfigHistoryFraction = this.config.historyFraction ?? 0.40;
    const _b4ConfigMemoryFraction = this.config.memoryFraction ?? 0.40;
    const {
      historyFraction: b4HistoryFraction,
      memoryFraction: b4MemoryFraction,
      mecwProfile: b4MecwProfile,
      mecwApplied: b4MecwApplied,
      mecwBlend: b4MecwBlend,
    } = resolveModelLaneBudgets(request.model, budget, _b4ConfigHistoryFraction, _b4ConfigMemoryFraction);

    // C2: Compute the artifact oversize threshold once per compose pass from the
    // effective model budget (from B4). Chunk injection paths consult this threshold
    // to degrade retrieved payloads that would fill the lane instead of injecting them.
    const c2ArtifactThresholdTokens = resolveArtifactOversizeThreshold(budget);
    let c2ArtifactDegradations = 0;
    // Sprint 4: Pre-compose history depth tightening.
    // Classify the session and compute an adaptive depth from observed message
    // density. This replaces the old fixed maxHistoryMessages ceiling that over-
    // fed the compositor for tool-heavy sessions.
    //
    // If the caller already passed historyDepth (plugin assemble path), honour it
    // as an explicit cap — the adaptive depth still applies as a lower bound so
    // we never request more than the budget can absorb.
    const s4SessionType: SessionType = classifySessionType(sampleMessages);
    const s4ObservedDensity: number = estimateObservedMsgDensity(sampleMessages);
    const s4HistoryBudget: number = Math.floor(budget * b4HistoryFraction);
    const s4AdaptiveDepth: number = computeAdaptiveHistoryDepth(
      s4SessionType,
      s4ObservedDensity,
      s4HistoryBudget,
      this.config.maxHistoryMessages,
    );
    // Effective depth: caller-provided historyDepth overrides adaptive when it is
    // the tighter constraint; otherwise use the adaptive depth.
    const s4EffectiveDepth: number = request.historyDepth
      ? Math.min(request.historyDepth, s4AdaptiveDepth)
      : s4AdaptiveDepth;
    let remaining = budget;

    // 0.9.0: resolve an early adaptive lifecycle posture for the
    // compose-window cluster-drop pass. Pressure is estimated from the
    // SQLite sample over the effective budget so the eviction-order
    // decision routes through the same band classifier the rest of the
    // 0.9.0 paths already use — no parallel pressure constants here.
    const s09SampleTokens = sampleMessages.reduce(
      (sum, m) => sum + estimateMessageTokens(m),
      0,
    );
    const s09EvictionPressure = computeUnifiedPressure(
      s09SampleTokens,
      budget,
      PRESSURE_SOURCE.COMPOSE_PRE_RECALL,
    );
    let s09ObservedUserTurnCount = sampleMessages.filter(m => m.role === 'user').length;
    const s09ForkedContextSeed = request.forkedContext?.enabled ? request.forkedContext : undefined;
    const s09ForkedParentPressure = typeof s09ForkedContextSeed?.parentPressureFraction === 'number'
      && Number.isFinite(s09ForkedContextSeed.parentPressureFraction)
      ? s09ForkedContextSeed.parentPressureFraction
      : undefined;
    const s09EvictionPolicyPressure = s09ForkedContextSeed
      && s09ObservedUserTurnCount === 0
      && s09ForkedParentPressure != null
        ? s09ForkedParentPressure
        : s09EvictionPressure.fraction;
    const evictionLifecyclePolicy = resolveAdaptiveLifecyclePolicy({
      pressureFraction: s09EvictionPolicyPressure,
      userTurnCount: s09ObservedUserTurnCount,
      explicitNewSession: isExplicitNewSessionPrompt(
        request.prompt ?? null,
      ),
      forkedContext: Boolean(s09ForkedContextSeed),
      forkedParentPressureFraction: s09ForkedParentPressure,
      forkedParentUserTurnCount: s09ForkedContextSeed?.parentUserTurnCount,
    });
    let adaptiveEvictionTopicAwareEligibleClusters = 0;
    let adaptiveEvictionTopicAwareDroppedClusters = 0;
    let adaptiveEvictionProtectedClusters = 0;
    let adaptiveEvictionTopicIdCoveragePct = 0;
    let adaptiveEvictionBypassReason: AdaptiveEvictionBypassReason | undefined;

    // Phase 0 fence enforcement: resolve the compaction fence for this conversation.
    // All downstream message queries use this as a lower bound to exclude zombie
    // messages below the fence that should have been compacted.
    let fenceMessageId: number | undefined;
    if (sampleConv) {
      try {
        ensureCompactionFenceSchema(db);
        const fence = getCompactionFence(db, sampleConv.id);
        if (fence) fenceMessageId = fence.fenceMessageId;
      } catch {
        // Fence lookup is best-effort — never fail composition
      }
    }

    const warnings: string[] = [];
    const slots: SlotTokenCounts = {
      system: 0,
      identity: 0,
      history: 0,
      facts: 0,
      context: 0,
      library: 0,
    };

    const messages: NeutralMessage[] = [];

    // ─── System Prompt (never truncated) ───────────────────────
    const systemContent = await this.getSlotContent(
      request.agentId,
      request.sessionKey,
      'system',
      db
    );

    if (systemContent) {
      const tokens = estimateTokens(systemContent);
      messages.push({
        role: 'system',
        textContent: systemContent,
        toolCalls: null,
        toolResults: null,
      });
      slots.system = tokens;
      remaining -= tokens;
    }

    // ─── Identity (never truncated) ────────────────────────────
    const identityContent = await this.getSlotContent(
      request.agentId,
      request.sessionKey,
      'identity',
      db
    );

    if (identityContent) {
      const tokens = estimateTokens(identityContent);
      messages.push({
        role: 'system',
        textContent: identityContent,
        toolCalls: null,
        toolResults: null,
      });
      slots.identity = tokens;
      remaining -= tokens;
    }

    const repairNoticeContent = await this.getSlotContent(
      request.agentId,
      request.sessionKey,
      'repair_notice',
      db
    );

    // ─── Warm-Restore Repair Notice (never suppressed) ─────────
    // If a session was reconstructed from a snapshot, the repair notice must
    // stay above restored conversation content even under budget pressure.
    // This mirrors the system/identity invariant: history and memory slots may
    // be trimmed, but the provenance notice is not optional operational state.
    if (repairNoticeContent) {
      const tokens = estimateTokens(repairNoticeContent);
      messages.push({
        role: 'system',
        textContent: repairNoticeContent,
        toolCalls: null,
        toolResults: null,
        metadata: { warmRestoreRepairNotice: true },
      });
      slots.system += tokens;
      remaining -= tokens;
      if (remaining < 0) {
        warnings.push('Warm-restore repair notice exceeded budget but was retained as non-suppressible system context');
      }
    }

    // ─── Stable Output Profile Prefix ──────────────────────────
    // Keep deterministic output instructions on the static side of the cache
    // boundary so Anthropic and OpenAI warm-prefix caching can reuse them.
    if (remaining > 100 && request.includeLibrary !== false) {
      const fosEnabled = this.config?.enableFOS !== false;
      const modEnabled = this.config?.enableMOD !== false;
      const outputTier = resolveOutputTier(
        (this.config?.hyperformProfile ?? this.config?.outputProfile ?? this.config?.outputStandard) as any,
        fosEnabled,
        modEnabled
      );

      const stableOutputParts: string[] = [];

      if (outputTier.tier === 'light') {
        stableOutputParts.push(renderLightFOS().join('\n'));
      } else if (libDb) {
        if (outputTier.fos) {
          const fos = getActiveFOS(libDb);
          if (fos) {
            const fosContent = renderFOS(fos).join('\n');
            if (fosContent.trim()) stableOutputParts.push(fosContent);
          }
        }

        if (outputTier.mod) {
          const mod = matchMOD(request.model, libDb);
          if (mod) {
            const modContent = renderMOD(mod, null, request.model || '').join('\n');
            if (modContent.trim()) stableOutputParts.push(modContent);
          }
        }
      }

      if (stableOutputParts.length > 0) {
        const stableOutputContent = stableOutputParts.join('\n\n');
        const stableOutputTokens = estimateTokens(stableOutputContent);
        if (stableOutputTokens <= remaining) {
          messages.push({
            role: 'system',
            textContent: stableOutputContent,
            toolCalls: null,
            toolResults: null,
          });
          slots.system += stableOutputTokens;
          remaining -= stableOutputTokens;
        }
      }
    }

    // ─── Conversation History ──────────────────────────────────
    let diagCrossTopicKeystones = 0;
    // Sprint 4: hoisted so diagnostics block can read it regardless of includeHistory branch.
    let s4RescueTrimFired = false;
    // C1: total tool-chain degradation counters across history budget-fit and safety-valve passes.
    let c1CoEjections = 0;
    let c1StubReplacements = 0;
    // Hoisted: activeTopicId/name resolved inside history block, used for window dual-write (VS-1) and wiki page injection
    let composedActiveTopicId: string | undefined;
    let composedActiveTopicName: string | undefined;
    if (request.includeHistory !== false) {
      // Phase 3 (Turn DAG): resolve active context for DAG-native reads.
      // This is the primary branch-scoping mechanism; fence remains as transitional safety.
      let activeContext: Context | null = null;
      try {
        activeContext = getActiveContext(db, request.agentId, request.sessionKey);
      } catch {
        // Context resolution is best-effort — fall back to fence-based reads
      }

      // P3.4: Look up the active topic for this session (non-fatal)
      let activeTopicId: string | undefined;
      let activeTopic: { id: string; name: string } | undefined;
      if (!request.topicId) {
        try {
          const topicMap = new SessionTopicMap(db);
          activeTopic = topicMap.getActiveTopic(request.sessionKey) || undefined;
          if (activeTopic) activeTopicId = activeTopic.id;
        } catch {
          // Topic lookup is best-effort — fall back to full history
        }
      } else {
        activeTopicId = request.topicId;
        try {
          activeTopic = db.prepare(`
            SELECT id, name
            FROM topics
            WHERE session_key = ? AND id = ?
            LIMIT 1
          `).get(request.sessionKey, request.topicId) as { id: string; name: string } | undefined;
        } catch {
          // Topic lookup is best-effort — fall back to ID-only history fetch
        }
      }
      // Hoist resolved topic id+name so the window dual-write and wiki injection sections can access them
      composedActiveTopicId = activeTopicId;
      composedActiveTopicName = activeTopic?.name;

      const rawHistoryMessages = await this.getHistory(
        request.agentId,
        request.sessionKey,
        s4EffectiveDepth,   // Sprint 4: adaptive depth (replaces fixed maxHistoryMessages)
        store,
        activeTopicId,
        fenceMessageId,
        activeContext
      );

      // Deduplicate history by StoredMessage.id (second line of defense after
      // pushHistory() tail-check dedup). Guards against any duplicates that
      // slipped through the warm path — e.g. bootstrap re-runs on existing sessions.
      const seenIds = new Set<number>();
      const historyMessages = rawHistoryMessages.filter(m => {
        const sm = m as import('./types.js').StoredMessage;
        if (sm.id != null) {
          if (seenIds.has(sm.id)) return false;
          seenIds.add(sm.id);
        }
        return true;
      });
      s09ObservedUserTurnCount = Math.max(
        s09ObservedUserTurnCount,
        historyMessages.filter(m => m.role === 'user').length,
      );

      // ── Transform-first: apply gradient tool treatment BEFORE budget math ──
      // All tool payloads are in their final form before any token estimation.
      // This ensures estimateMessageTokens() measures actual submission cost,
      // not pre-transform cost (which caused overflow: dense tool JSON was
      // undercounted at length/4 when it should be measured post-stub).
      const transformedHistory = applyToolGradient(historyMessages, { totalWindowTokens: totalWindow });

      // ── Evict large tool results (>800 tokens) before window selection ─────
      // Replace oversized stale results with stubs so they don't burn budget.
      // Current-turn results (turn age 0) are never evicted.
      const evictedHistory = evictLargeToolResults(transformedHistory);
      const c2ResolvedHistory = resolveOversizedArtifacts(evictedHistory, budget);
      c2ArtifactDegradations += c2ResolvedHistory.refCount;

      // ── Budget-fit: walk newest→oldest, drop whole clusters ─────────────
      // Group tool_use + tool_result messages into clusters so they are kept
      // or dropped as a unit. Breaking mid-cluster creates orphaned tool
      // pairs that repairToolPairs has to strip downstream — wasting budget
      // and leaving gaps in conversation continuity.
      const budgetClusters = clusterNeutralMessages(c2ResolvedHistory.messages);
      let historyTokens = 0;
      const includedClusters: NeutralMessageCluster<NeutralMessage>[] = [];

      // Pre-allocate history budget. historyFraction is a fraction of the
      // effective token budget (post-reserve). Falls back to unbounded fill
      // (remaining) when historyFraction is not set.
      // B4: uses b4HistoryFraction (model-aware, blended from MECW catalog) instead
      // of raw config.historyFraction so history doesn't overflow MECW ceiling.
      const historyBudget = Math.floor(budget * b4HistoryFraction);
      const historyFillCap = Math.min(historyBudget, remaining);

      // 0.9.0: adaptive eviction ordering. For elevated/high/critical bands,
      // drop inactive-topic non-tool clusters first when an active topic is
      // known. Bootstrap/warmup/steady reproduce the historical newest-first
      // sweep exactly (preferTopicAwareDrop=false → evictedByPlan stays empty).
      const adaptiveOrdering = orderClustersForAdaptiveEviction(
        budgetClusters,
        evictionLifecyclePolicy,
        { activeTopicId },
      );
      adaptiveEvictionTopicAwareEligibleClusters = adaptiveOrdering.telemetry.topicAwareEligibleClusters;
      adaptiveEvictionProtectedClusters = adaptiveOrdering.telemetry.protectedClusters;
      adaptiveEvictionTopicIdCoveragePct = adaptiveOrdering.telemetry.topicIdCoveragePct;
      adaptiveEvictionBypassReason = adaptiveOrdering.telemetry.bypassReason;
      const evictedByPlan = new Set<number>();
      let projectedTokens = budgetClusters.reduce((s, c) => s + c.tokenCost, 0);
      if (adaptiveOrdering.preferTopicAwareDrop
        && adaptiveOrdering.topicAwareDropOrder.length > 0
        && projectedTokens <= historyFillCap) {
        adaptiveEvictionBypassReason = 'within-budget';
      }
      if (adaptiveOrdering.preferTopicAwareDrop
        && adaptiveOrdering.topicAwareDropOrder.length > 0
        && projectedTokens > historyFillCap) {
        for (const idx of adaptiveOrdering.topicAwareDropOrder) {
          if (projectedTokens <= historyFillCap) break;
          if (adaptiveOrdering.protectedIndices.has(idx)) continue;
          evictedByPlan.add(idx);
          projectedTokens -= budgetClusters[idx].tokenCost;
        }
        adaptiveEvictionTopicAwareDroppedClusters = evictedByPlan.size;
      }

      let truncationCutIndex = -1;
      for (let i = budgetClusters.length - 1; i >= 0; i--) {
        if (evictedByPlan.has(i)) continue;
        const cluster = budgetClusters[i];
        if (historyTokens + cluster.tokenCost > historyFillCap && includedClusters.length > 0) {
          truncationCutIndex = i;
          break;
        }
        includedClusters.unshift(cluster);
        historyTokens += cluster.tokenCost;
      }

      if (truncationCutIndex >= 0 || evictedByPlan.size > 0) {
        const droppedIndices: number[] = [];
        if (truncationCutIndex >= 0) {
          for (let i = 0; i <= truncationCutIndex; i++) {
            if (!evictedByPlan.has(i)) droppedIndices.push(i);
          }
        }
        for (const idx of evictedByPlan) droppedIndices.push(idx);
        const droppedClusters = droppedIndices.map(i => budgetClusters[i]);
        const droppedMsgCount = droppedClusters.reduce((s, c) => s + c.messages.length, 0);
        const droppedToolResultCount = droppedClusters.reduce(
          (sum, c) => sum + c.messages.filter(m => (m.toolResults?.length ?? 0) > 0).length,
          0,
        );
        if (droppedToolResultCount > 0) {
          c1CoEjections += droppedToolResultCount;
          console.info(
            `[hypermem:compositor] tool-chain co-eject reason=budget_cluster_drop count=${droppedToolResultCount} messages dropped`,
          );
        }
        if (droppedMsgCount > 0) {
          const c1Note = droppedToolResultCount > 0
            ? ` [C1: ${droppedToolResultCount} co-ejected reason=budget_cluster_drop]`
            : '';
          const planNote = evictedByPlan.size > 0
            ? ` [adaptive: band=${evictionLifecyclePolicy.band} topic-aware-dropped=${evictedByPlan.size}]`
            : '';
          const cutLabel = truncationCutIndex >= 0
            ? `${truncationCutIndex + 1}/${budgetClusters.length}`
            : `0/${budgetClusters.length}`;
          warnings.push(`History truncated at cluster ${cutLabel} (${droppedMsgCount} messages dropped)${c1Note}${planNote}`);
          if (truncationCutIndex >= 0) s4RescueTrimFired = true;
        }
      }

      const includedHistory: NeutralMessage[] = includedClusters.flatMap(c => c.messages);

      // ── Keystone History Slot (P2.1) ──────────────────────────────────
      // For long conversations (≥30 messages), inject high-signal older messages
      // from before the recent window as recalled context. This lets the model
      // see key decisions and specs that happened earlier in the conversation
      // without them consuming the full recent history budget.
      const keystoneFraction = this.config.keystoneHistoryFraction ?? 0.2;
      const keystoneMaxMsgs = this.config.keystoneMaxMessages ?? 15;

      let keystoneMessages: NeutralMessage[] = [];
      let keystoneTokens = 0;

      if (request.includeKeystones !== false && includedHistory.length >= 30 && keystoneFraction > 0) {
        const keystoneResult = await this.buildKeystones(
          db,
          request.agentId,
          includedHistory,
          historyTokens,
          keystoneFraction,
          keystoneMaxMsgs,
          request.prompt,
          libDb || undefined,
          fenceMessageId,
          activeContext
        );
        if (keystoneResult) {
          keystoneMessages = keystoneResult.keystoneMessages;
          keystoneTokens = keystoneResult.keystoneTokens;
          // Replace includedHistory and historyTokens with the trimmed versions
          // (keystoneResult reflects the trimming done inside buildKeystones)
          includedHistory.splice(0, includedHistory.length, ...keystoneResult.trimmedHistory);
          historyTokens = keystoneResult.trimmedHistoryTokens;
          warnings.push(`Keystone: injected ${keystoneMessages.length} recalled messages`);
        }
      }

      // ── Cross-Topic Keystones (P3.5) ──────────────────────────────────
      // Pull high-signal messages from OTHER topics in this session when their
      // content is semantically relevant to the current topic. Non-fatal.
      let crossTopicMessages: NeutralMessage[] = [];
      let crossTopicTokens = 0;

      if (request.includeKeystones !== false && activeTopic && this.vectorStore) {
        try {
          const rawCrossTopicKeystones = await this.getKeystonesByTopic(
            request.agentId,
            request.sessionKey,
            activeTopic,
            includedHistory,
            db,
            3,
            fenceMessageId,
            activeContext
          );
          if (rawCrossTopicKeystones.length > 0) {
            // Token budget: cap the full cross-topic block at 15% of remaining,
            // including the header line.
            const crossTopicHeaderTokens = estimateTokens('## Cross-Topic Context');
            const crossTopicBudget = Math.max(0, Math.floor(remaining * 0.15) - crossTopicHeaderTokens);
            let used = 0;
            for (const candidate of rawCrossTopicKeystones) {
              const msg: NeutralMessage = {
                role: candidate.role as NeutralMessage['role'],
                textContent: candidate.content,
                toolCalls: null,
                toolResults: null,
              };
              const msgTokens = estimateMessageTokens(msg);
              if (used + msgTokens > crossTopicBudget) continue;
              crossTopicMessages.push(msg);
              used += msgTokens;
            }
            crossTopicTokens = used;
            diagCrossTopicKeystones = crossTopicMessages.length;
          }
        } catch {
          // Cross-topic retrieval is non-fatal — never block compose
        }
      }

      // Push history with keystone separators if we have keystones.
      if (keystoneMessages.length > 0 || crossTopicMessages.length > 0) {
        // Cross-topic context (from other topics) — prepended before within-session keystones
        if (crossTopicMessages.length > 0) {
          messages.push({
            role: 'system',
            textContent: '## Cross-Topic Context',
            toolCalls: null,
            toolResults: null,
          });
          messages.push(...crossTopicMessages);
        }
        // Separator before recalled context (within-session keystones)
        if (keystoneMessages.length > 0) {
          messages.push({
            role: 'system',
            textContent: '## Recalled Context (high-signal older messages)',
            toolCalls: null,
            toolResults: null,
          });
          messages.push(...keystoneMessages);
        }
        // Separator before recent conversation
        messages.push({
          role: 'system',
          textContent: '## Recent Conversation',
          toolCalls: null,
          toolResults: null,
        });
        messages.push(...includedHistory);
        // Account for separator tokens in history slot
        const crossTopicSepTokens = crossTopicMessages.length > 0
          ? estimateTokens('## Cross-Topic Context')
          : 0;
        const keystoneSepTokens = keystoneMessages.length > 0
          ? estimateTokens('## Recalled Context (high-signal older messages)')
          : 0;
        const recentSepTokens = estimateTokens('## Recent Conversation');
        const sepTokens = crossTopicSepTokens + keystoneSepTokens + recentSepTokens;
        slots.history = historyTokens + keystoneTokens + crossTopicTokens + sepTokens;
        remaining -= (historyTokens + keystoneTokens + crossTopicTokens + sepTokens);
      } else {
        messages.push(...includedHistory);
        slots.history = historyTokens;
        remaining -= historyTokens;
      }

      // Memory budget pool: facts, wiki, semantic recall, cross-session, and
      // trigger-fired doc chunks all draw from this shared pool via `remaining`.
      // B4: uses b4MemoryFraction (model-aware, blended from MECW catalog) instead
      // of raw config.memoryFraction so the memory pool scales with what the model
      // can effectively attend to within its MECW ceiling.
      let memoryBudget: number;
      {
        memoryBudget = Math.floor(budget * b4MemoryFraction);
        if (remaining > memoryBudget) {
          remaining = memoryBudget;
        }
      }

      // T1.3: Ghost message suppression.
      // If the last message in the included history is a warm-seeded user message
      // AND there's a subsequent message in SQLite that wasn't included (meaning
      // the assistant already responded), drop it. This prevents the model from
      // re-answering a question that was already handled in a prior session.
      // Only triggers when: (1) message has _warmed flag, (2) it's role=user,
      // (3) SQLite has messages after it (the response exists but wasn't included).
      const lastIncluded = messages[messages.length - 1];
      if (lastIncluded?.role === 'user') {
        const sm = lastIncluded as import('./types.js').StoredMessage;
        const meta = sm.metadata as Record<string, unknown> | undefined;
        if (meta?._warmed && sm.id != null) {
          // Check if there are any messages after this one in SQLite
          try {
            const hasMore = db.prepare(
              'SELECT 1 FROM messages WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?) AND id > ? LIMIT 1'
            ).get(sm.id, sm.id);
            if (hasMore) {
              messages.pop();
              warnings.push('Dropped trailing warm-seeded user message with existing response (ghost suppression)');
            }
          } catch {
            // Ghost check is best-effort — don't block compose
          }
        }
      }
    }

    // ─── Cache-ordered context assembly ─────────────────────────
    // Stable, reusable material is lifted above the cache boundary as its
    // own system messages. Session-volatile material stays in the dynamic
    // context block below that boundary.
    const stablePrefixMessages: NeutralMessage[] = [];
    const volatileContextParts: string[] = [];
    let contextTokens = 0;

    // ── C1: Content fingerprint dedup set ────────────────────
    // Replaces fragile substring-match dedup across temporal, open-domain,
    // semantic recall, and cross-session paths. O(1) lookup on a normalized
    // 120-char prefix catches rephrased duplicates the old 60-char includes()
    // match missed without needing a hash.
    const contextFingerprints = new Set<string>();
    const fingerprintEntries = new Map<string, Set<string>>();

    // ── Compose-level diagnostics tracking vars ──────────────
    let diagTriggerHits = 0;
    let diagTriggerFallbackUsed = false;
    let diagFactsIncluded = 0;
    let diagSemanticResults = 0;
    let diagDocChunkCollections = 0;
    let diagScopeFiltered = 0;
    let diagFingerprintDedups = 0;
    let diagFingerprintCollisions = 0;
    let diagRetrievalMode: ComposeDiagnostics['retrievalMode'] = 'none';
    // Sprint 1: reranker telemetry captured from hybridSearch via onRerankerTelemetry
    let diagRerankerStatus: string | undefined;
    let diagRerankerCandidates: number | undefined;
    let diagRerankerProvider: string | null | undefined;

    function normalizeFingerprintText(text: string): string {
      return text.toLowerCase().replace(/\s+/g, ' ').trim();
    }
    function contentFingerprint(text: string): string {
      return normalizeFingerprintText(text).slice(0, 120);
    }
    function addFingerprint(text: string): void {
      const normalized = normalizeFingerprintText(text);
      const fingerprint = normalized.slice(0, 120);
      contextFingerprints.add(fingerprint);
      const entries = fingerprintEntries.get(fingerprint) ?? new Set<string>();
      entries.add(normalized);
      fingerprintEntries.set(fingerprint, entries);
    }
    function isDuplicate(text: string): boolean {
      const normalized = normalizeFingerprintText(text);
      const fingerprint = normalized.slice(0, 120);
      if (!contextFingerprints.has(fingerprint)) return false;
      const entries = fingerprintEntries.get(fingerprint);
      if (entries && !entries.has(normalized)) diagFingerprintCollisions += 1;
      return true;
    }

    // ── Wiki Page (L4: Library — active topic synthesis) ──────
    // Inject synthesized wiki page for the active topic before general knowledge.
    // Draws from the shared memory budget pool (remaining is pre-capped by memoryBudget).
    if (request.includeLibrary !== false && remaining > 300 && libDb && composedActiveTopicName) {
      const wikiContent = this.buildWikiPageContext(request.agentId, composedActiveTopicName, libDb);
      if (wikiContent) {
        const tokens = estimateTokens(wikiContent);
        if (tokens <= remaining) {
          volatileContextParts.push(wikiContent);
          contextTokens += tokens;
          remaining -= tokens;
          slots.library += tokens;
        } else if (remaining > 200) {
          const truncated = this.truncateToTokens(wikiContent, remaining);
          const truncTokens = estimateTokens(truncated);
          volatileContextParts.push(truncated);
          contextTokens += truncTokens;
          remaining -= truncTokens;
          slots.library += truncTokens;
        }
      }
    }

    // ── Facts (L4: Library) ──────────────────────────────────
    // scope: agent — filtered by agentId via filterByScope after fetch
    // Draws from the shared memory budget pool (remaining is pre-capped by memoryBudget).
    if (request.includeFacts !== false && remaining > 500) {
      const factSections = this.buildFactSectionsFromDb(request.agentId, request.sessionKey, libDb || db);
      if (factSections !== null) {
        const { stableContent, stableCount, volatileContent, volatileCount, filteredCount } = factSections;
        diagFactsIncluded += stableCount + volatileCount;
        diagScopeFiltered += filteredCount;

        if (stableContent) {
          const stableFactsBlock = `## Stable Facts\n${stableContent}`;
          const tokens = estimateTokens(stableFactsBlock);
          if (tokens <= remaining) {
            stablePrefixMessages.push({
              role: 'system',
              textContent: stableFactsBlock,
              toolCalls: null,
              toolResults: null,
            });
            contextTokens += tokens;
            remaining -= tokens;
            slots.facts += tokens;
          } else if (remaining > 200) {
            const truncated = this.truncateToTokens(stableFactsBlock, remaining);
            const truncTokens = estimateTokens(truncated);
            stablePrefixMessages.push({
              role: 'system',
              textContent: truncated,
              toolCalls: null,
              toolResults: null,
            });
            contextTokens += truncTokens;
            remaining -= truncTokens;
            slots.facts += truncTokens;
            warnings.push('Stable facts truncated to fit memory budget');
          }

          for (const line of stableContent.split('\n')) {
            if (line.startsWith('- [')) addFingerprint(line);
          }
        }

        if (volatileContent) {
          const volatileFactsBlock = `## Active Facts\n${volatileContent}`;
          const tokens = estimateTokens(volatileFactsBlock);
          if (tokens <= remaining) {
            volatileContextParts.push(volatileFactsBlock);
            contextTokens += tokens;
            remaining -= tokens;
            slots.facts += tokens;
          } else if (remaining > 200) {
            const truncated = this.truncateToTokens(volatileFactsBlock, remaining);
            const truncTokens = estimateTokens(truncated);
            volatileContextParts.push(truncated);
            contextTokens += truncTokens;
            remaining -= truncTokens;
            slots.facts += truncTokens;
            warnings.push('Active facts truncated to fit memory budget');
          }

          for (const line of volatileContent.split('\n')) {
            if (line.startsWith('- [')) addFingerprint(line);
          }
        }
      }

      // ── Temporal retrieval (L4: Library) ─────────────────────
      // Fires when the query has temporal signals (before/after/when/last etc).
      // Returns facts in time order from temporal_index. Deduplicates against
      // facts already included above. Uses ingest_at as occurred_at proxy (v1).
      const queryText = request.prompt ?? '';

      if (request.includeSemanticRecall !== false && queryText && hasTemporalSignals(queryText) && libDb && remaining > 300) {
        try {
          const temporalStore = new TemporalStore(libDb);
          const temporalFacts = temporalStore.timeRangeQuery({
            agentId: request.agentId,
            limit: 15,
            order: 'DESC',
          });

          if (temporalFacts.length > 0) {
            const beforeCount = temporalFacts.length;
            const novel = temporalFacts.filter(f => !isDuplicate(f.content));
            diagFingerprintDedups += beforeCount - novel.length;

            if (novel.length > 0) {
              const temporalBlock = novel
                .map(f => {
                  const ts = new Date(f.occurredAt).toISOString().slice(0, 10);
                  const line = `[${ts}] ${f.content}`;
                  addFingerprint(f.content);
                  return line;
                })
                .join('\n');

              const temporalSection = `## Temporal Context\n${temporalBlock}`;
              const tempTokens = estimateTokens(temporalSection);
              const tempBudget = Math.floor(remaining * 0.20);

              if (tempTokens <= tempBudget) {
                volatileContextParts.push(temporalSection);
                contextTokens += tempTokens;
                remaining -= tempTokens;
                slots.facts = (slots.facts ?? 0) + tempTokens;
              } else {
                const truncated = this.truncateToTokens(temporalSection, tempBudget);
                const truncTokens = estimateTokens(truncated);
                volatileContextParts.push(truncated);
                contextTokens += truncTokens;
                remaining -= truncTokens;
                slots.facts = (slots.facts ?? 0) + truncTokens;
              }
            }
          }
        } catch {
          // Temporal index not yet available (migration pending) — skip silently
        }
      }

      // ── Open-domain FTS retrieval (L4: Library) ──────────────────
      // Fires when the query looks broad/exploratory with no topical anchor.
      // Searches raw messages_fts — bypasses isQualityFact() quality gate so
      // content filtered from library.db is still reachable for open-domain
      // questions. Primary fix for LoCoMo open-domain F1 gap (0.133 baseline).
      if (request.includeSemanticRecall !== false && queryText && isOpenDomainQuery(queryText) && db && remaining > 300) {
        try {
          const rawOdResults = searchOpenDomain(db, queryText, '', 10);
          const beforeOd = rawOdResults.length;
          const odResults = rawOdResults.filter(r => !isDuplicate(r.content));
          diagFingerprintDedups += beforeOd - odResults.length;

          if (odResults.length > 0) {
            const odBlock = odResults
              .map(r => {
                addFingerprint(r.content);
                const ts = r.createdAt
                  ? new Date(r.createdAt).toISOString().slice(0, 10)
                  : '';
                const prefix = ts ? `[${ts}] ` : '';
                const snippet = r.content.length > 300
                  ? r.content.slice(0, 300) + '…'
                  : r.content;
                return `${prefix}${snippet}`;
              })
              .join('\n');

            const odSection = `## Open Domain Context\n${odBlock}`;
            const odTokens = estimateTokens(odSection);
            const odBudget = Math.floor(remaining * 0.20);

            if (odTokens <= odBudget) {
              volatileContextParts.push(odSection);
              contextTokens += odTokens;
              remaining -= odTokens;
              slots.facts = (slots.facts ?? 0) + odTokens;
            } else {
              const truncated = this.truncateToTokens(odSection, odBudget);
              const truncTokens = estimateTokens(truncated);
              volatileContextParts.push(truncated);
              contextTokens += truncTokens;
              remaining -= truncTokens;
              slots.facts = (slots.facts ?? 0) + truncTokens;
            }
          }
        } catch {
          // Open-domain FTS unavailable — skip silently
        }
      }
    }

    // ── Knowledge (L4: Library) ──────────────────────────────
    // scope: agent — filtered by agent_id in the SQL query (existing behavior)
    if (request.includeLibrary !== false && remaining > 500 && libDb) {
      const knowledgeContent = this.buildKnowledgeFromDb(request.agentId, libDb);
      if (knowledgeContent) {
        const stableKnowledgeBlock = `## Knowledge\n${knowledgeContent}`;
        const tokens = estimateTokens(stableKnowledgeBlock);
        if (tokens <= remaining * 0.2) {
          stablePrefixMessages.push({
            role: 'system',
            textContent: stableKnowledgeBlock,
            toolCalls: null,
            toolResults: null,
          });
          contextTokens += tokens;
          remaining -= tokens;
          slots.library += tokens;
        } else {
          const truncated = this.truncateToTokens(stableKnowledgeBlock, Math.floor(remaining * 0.2));
          const truncTokens = estimateTokens(truncated);
          stablePrefixMessages.push({
            role: 'system',
            textContent: truncated,
            toolCalls: null,
            toolResults: null,
          });
          contextTokens += truncTokens;
          remaining -= truncTokens;
          slots.library += truncTokens;
          warnings.push('Knowledge truncated to fit budget');
        }
      }
    }

    // ── Preferences (L4: Library) ────────────────────────────
    // scope: agent — filtered by agent_id OR NULL in the SQL query (existing behavior)
    if (request.includeLibrary !== false && remaining > 300 && libDb) {
      const prefsContent = this.buildPreferencesFromDb(request.agentId, libDb);
      if (prefsContent) {
        const stablePrefsBlock = `## User Preferences\n${prefsContent}`;
        const tokens = estimateTokens(stablePrefsBlock);
        if (tokens <= remaining * 0.1) {
          stablePrefixMessages.push({
            role: 'system',
            textContent: stablePrefsBlock,
            toolCalls: null,
            toolResults: null,
          });
          contextTokens += tokens;
          remaining -= tokens;
          slots.library += tokens;
        }
      }
    }

    // ── Semantic Recall (L3: Hybrid FTS5+KNN) ───────────────
    // scope: agent — buildSemanticRecall filters by agentId internally
    // Fires when either vector store or library DB is available.
    // FTS5-only (no embeddings) still returns keyword matches.
    // KNN-only (no FTS terms) still returns semantic matches.
    // Both present → Reciprocal Rank Fusion.
    // Use request.prompt as the retrieval query when available — it is the
    // live current-turn text. Falling back to getLastUserMessage(messages)
    // reads from the already-assembled history, which is one turn stale.
    // 0.9.0: resolve adaptive lifecycle policy immediately before semantic recall
    // so smartRecallMultiplier scales the recall token budget and candidate limit
    // from the same policy object that compose diagnostics later report.
    const composePreRecallPressure = computeUnifiedPressure(
      contextTokens,
      budget,
      PRESSURE_SOURCE.COMPOSE_PRE_RECALL,
    );
    const s09ComposePolicyPressure = s09ForkedContextSeed
      && s09ObservedUserTurnCount === 0
      && s09ForkedParentPressure != null
        ? s09ForkedParentPressure
        : composePreRecallPressure.fraction;
    const composeLifecyclePolicy = resolveAdaptiveLifecyclePolicy({
      pressureFraction: s09ComposePolicyPressure,
      userTurnCount: s09ObservedUserTurnCount,
      explicitNewSession: isExplicitNewSessionPrompt(
        request.prompt ?? this.getLastUserMessage(messages),
      ),
      forkedContext: Boolean(s09ForkedContextSeed),
      forkedParentPressureFraction: s09ForkedParentPressure,
      forkedParentUserTurnCount: s09ForkedContextSeed?.parentUserTurnCount,
    });
    const recallBreadth = scaleRecallBreadth(
      remaining,
      composeLifecyclePolicy.smartRecallMultiplier,
    );
    let diagAdaptiveRecallBudgetTokens: number | undefined;
    let diagAdaptiveRecallCandidateLimit: number | undefined;

    if (request.includeSemanticRecall !== false && remaining > 500 && (this.vectorStore || libDb)) {
      const lastUserMsg = request.prompt?.trim() || this.getLastUserMessage(messages);
      if (lastUserMsg) {
        try {
          // Check Redis for a pre-computed embedding from afterTurn()
          let precomputedEmbedding: Float32Array | undefined;
          try {
            const cached = await this.cache.getQueryEmbedding(request.agentId, request.sessionKey);
            if (cached) precomputedEmbedding = cached;
          } catch {
            // Redis lookup is best-effort — fall through to Ollama
          }

          diagAdaptiveRecallBudgetTokens = recallBreadth.mainBudgetTokens;
          diagAdaptiveRecallCandidateLimit = recallBreadth.candidateLimit;

          const semanticContent = await this.buildSemanticRecall(
            lastUserMsg,
            request.agentId,
            // 0.9.0: recall token budget = base 0.12 of remaining * lifecycle multiplier.
            recallBreadth.mainBudgetTokens,
            libDb || undefined,
            precomputedEmbedding,
            contextFingerprints,  // C2: skip results already in Active Facts
            // Sprint 1: capture reranker telemetry at assemble level
            (ev: RerankerTelemetry) => {
              diagRerankerStatus = ev.status;
              diagRerankerCandidates = ev.candidates;
              diagRerankerProvider = ev.provider;
            },
            recallBreadth.candidateLimit,
          );
          if (semanticContent) {
            const tokens = estimateTokens(semanticContent);
            volatileContextParts.push(`## Related Memory\n${semanticContent}`);
            contextTokens += tokens;
            remaining -= tokens;
            // Semantic recall draws from multiple sources, attribute to context
            slots.context += tokens;
            // W3 diagnostics: count non-empty lines as rough results count
            diagSemanticResults = semanticContent.split('\n').filter(l => l.trim().length > 0).length;
          }
        } catch (err) {
          // Semantic search is best-effort — don't fail composition
          warnings.push(`Semantic recall failed: ${(err as Error).message}`);
        }
      }
    }

    // ── Doc Chunks (L4: Trigger-based retrieval) ─────────────
    // scope: per-tier/per-agent — queryChunks filters by agentId and tier
    // Demand-load governance, identity, and memory chunks based on
    // conversation context. Replaces full ACA file injection for
    // the files that have been seeded into the doc chunk index.
    let triggerFallbackUsed = false;
    if (request.includeDocChunks !== false && remaining > 400 && libDb) {
      // Use request.prompt when available (current-turn text, not stale history)
      const lastMsg = request.prompt?.trim() || this.getLastUserMessage(messages) || '';
      const triggered = matchTriggers(lastMsg, this.triggerRegistry);

      if (triggered.length > 0) {
        diagTriggerHits = triggered.length;
        diagRetrievalMode = 'triggered';
        const docChunkStore = new DocChunkStore(libDb);
        const docParts: string[] = [];
        const maxTotalTriggerTokens = Math.min(
          remaining,
          this.config.maxTotalTriggerTokens && this.config.maxTotalTriggerTokens > 0
            ? this.config.maxTotalTriggerTokens
            : Math.floor(remaining * 0.40)
        );
        let totalTriggerTokens = 0;

        for (const trigger of triggered) {
          if (remaining < 200) break;

          const triggerBudgetRemaining = maxTotalTriggerTokens - totalTriggerTokens;
          if (triggerBudgetRemaining < 200) break;

          const maxTokens = Math.min(
            trigger.maxTokens || 1000,
            Math.floor(remaining * 0.12), // No single collection takes > 12% of remaining (W4: was 0.15)
            triggerBudgetRemaining
          );

          try {
            // Build a relevance-based FTS5 query from the user message.
            //
            // Problem: trigger keywords are stems ('escalat', 'irreversib') for
            // substring matching against user messages, but FTS5 tokenizes on word
            // boundaries. 'escalat' does not match 'escalation' in FTS5 without a
            // prefix operator.
            //
            // Solution: extract actual words from the user message that contain a
            // matched trigger keyword, then use FTS5 prefix queries (word*) for
            // each extracted word. This bridges stem-matching and FTS5 indexing.
            const msgLower = lastMsg.toLowerCase();
            const matchedKeywords = trigger.keywords.filter(kw =>
              msgLower.includes(kw.toLowerCase())
            );

            // Extract whole words from the message that overlap with matched keywords
            const msgWords = lastMsg.match(/\b\w{4,}\b/g) || [];
            const relevantWords = msgWords.filter(word =>
              matchedKeywords.some(kw => word.toLowerCase().includes(kw.toLowerCase()) ||
                                        kw.toLowerCase().includes(word.toLowerCase().slice(0, 5)))
            );

            // Build FTS5 OR query: "word1* OR word2* OR word3*"
            // FTS5 treats space-separated terms as AND by default — we want OR so
            // that any relevant term is sufficient to retrieve a matching chunk.
            // Prefix operator (*) ensures stems match full words in the index.
            // Sort by keyword match specificity (longer matched keyword = more specific term),
            // then cap at 6 terms to keep FTS queries reasonable.
            // No positional slice — all relevant words participate, not just the first 3.
            const sortedWords = [...new Set(relevantWords)].sort((a, b) => {
              const aLen = Math.max(...matchedKeywords.filter(kw =>
                a.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(a.toLowerCase().slice(0, 5))
              ).map(kw => kw.length), 0);
              const bLen = Math.max(...matchedKeywords.filter(kw =>
                b.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(b.toLowerCase().slice(0, 5))
              ).map(kw => kw.length), 0);
              return bLen - aLen; // Most specific match first
            });

            // Sanitize FTS5 terms: quote each word, strip internal quotes, add prefix wildcard.
            // Matches the pattern used in the keystone history FTS path.
            const sanitizeFtsTerm = (w: string) => `"${w.replace(/"/g, '')}"*`;
            const ftsTerms = sortedWords.length > 0
              ? sortedWords.slice(0, 6).map(sanitizeFtsTerm).join(' OR ')
              : matchedKeywords
                  .sort((a, b) => b.length - a.length)
                  .slice(0, 3)
                  .map(sanitizeFtsTerm)
                  .join(' OR ');

            // Fallback uses raw message words — also sanitize to prevent FTS5 syntax errors.
            const ftsKeyword = ftsTerms || lastMsg.split(/\s+/).slice(0, 3)
              .map(sanitizeFtsTerm).join(' OR ');

            const chunks = docChunkStore.queryChunks({
              collection: trigger.collection,
              agentId: request.agentId,
              tier: request.tier,
              limit: trigger.maxChunks || 3,
              keyword: ftsKeyword,
            });

            if (chunks.length === 0) continue;

            const chunkLines: string[] = [];
            let chunkTokens = 0;

            for (const chunk of chunks) {
              // Skip chunks from files OpenClaw already injects into the system prompt
              const chunkBasename = chunk.sourcePath.split('/').pop() || '';
              if (OPENCLAW_BOOTSTRAP_FILES.has(chunkBasename)) continue;

              // C2: degrade oversized chunks to canonical artifact references before
              // enforcing the per-collection budget gate. Otherwise an oversized raw
              // chunk gets dropped before the tiny degraded ref ever has a chance to fit.
              const c2ChunkRef = degradeOversizedDocChunk(chunk.id, chunk.sourcePath, chunk.content, c2ArtifactThresholdTokens);
              const renderedChunk = c2ChunkRef !== null
                ? `### ${chunk.sectionPath}\n${c2ChunkRef}`
                : `### ${chunk.sectionPath}\n${chunk.content}`;
              const renderedTokens = estimateTokens(renderedChunk);

              if (chunkTokens + renderedTokens > maxTokens) break;

              chunkLines.push(renderedChunk);
              chunkTokens += renderedTokens;
              if (c2ChunkRef !== null) c2ArtifactDegradations++;
            }

            if (chunkLines.length > 0) {
              const collectionLabel = trigger.collection.split('/').pop() || trigger.collection;
              docParts.push(`## ${collectionLabel} (retrieved)\n${chunkLines.join('\n\n')}`);
              totalTriggerTokens += chunkTokens;
              contextTokens += chunkTokens;
              remaining -= chunkTokens;
              slots.library += chunkTokens;
              diagDocChunkCollections++;
            }
          } catch {
            // Doc chunk retrieval is best-effort — don't fail composition
          }
        }

        if (docParts.length > 0) {
          volatileContextParts.push(docParts.join('\n\n'));
        }
      } else if (request.includeSemanticRecall !== false && remaining > 400 && (this.vectorStore || libDb)) {
        // Trigger-miss fallback: no trigger fired — attempt bounded semantic retrieval
        // so there is never a silent zero-memory path on doc chunks.
        // INVARIANT: this block is mutually exclusive with triggered-retrieval above.
        // If refactored to run both paths, cap combined semantic budget to avoid double-recall.
        try {
          // 0.9.0: trigger-miss fallback uses the same lifecycle-scaled breadth so
          // a /new surge widens fallback recall and high/critical pressure narrows it.
          if (diagAdaptiveRecallBudgetTokens === undefined) {
            diagAdaptiveRecallBudgetTokens = recallBreadth.fallbackBudgetTokens;
            diagAdaptiveRecallCandidateLimit = recallBreadth.candidateLimit;
          }
          const fallbackContent = await Promise.race([
            this.buildSemanticRecall(
              lastMsg,
              request.agentId,
              recallBreadth.fallbackBudgetTokens,
              libDb || undefined,
              undefined,
              contextFingerprints,  // C2: skip results already in Active Facts
              undefined,
              recallBreadth.candidateLimit,
            ),
            new Promise<null>((_, reject) =>
              setTimeout(() => reject(new Error('fallback_knn_timeout')), 3000)
            ),
          ]);
          if (fallbackContent) {
            volatileContextParts.push(`## Related Memory\n${fallbackContent}`);
            const fallbackTokens = estimateTokens(fallbackContent);
            contextTokens += fallbackTokens;
            remaining -= fallbackTokens;
            slots.context += fallbackTokens;
            triggerFallbackUsed = true;
            diagTriggerFallbackUsed = true;
            diagRetrievalMode = 'fallback_knn';
          }
        } catch {
          // Fallback is best-effort — never fail composition (includes timeout)
        }
      }
    }

    // ── Session-Scoped Doc Chunks (spawn context inheritance) ────
    // When parentSessionKey is set, retrieve ephemeral doc chunks indexed
    // by buildSpawnContext() for this spawn session.
    if (request.parentSessionKey && remaining > 200 && libDb) {
      try {
        const spawnChunkStore = new DocChunkStore(libDb);
        const spawnQueryMsg = request.prompt?.trim() || this.getLastUserMessage(messages) || '';
        const spawnChunks = spawnChunkStore.queryDocChunks(
          request.agentId,
          spawnQueryMsg,
          { sessionKey: request.parentSessionKey, limit: 8 }
        );
        if (spawnChunks.length > 0) {
          const spawnLines: string[] = [];
          let spawnTokens = 0;
          const maxSpawnTokens = Math.floor(remaining * 0.15);
          for (const chunk of spawnChunks) {
            // C2: degrade oversized spawn chunks before enforcing the lane budget,
            // so a bounded reference can fit even when the raw chunk cannot.
            const c2SpawnRef = degradeOversizedDocChunk(chunk.id, chunk.sourcePath, chunk.content, c2ArtifactThresholdTokens);
            const renderedChunk = c2SpawnRef ?? chunk.content;
            const renderedTokens = estimateTokens(renderedChunk);

            if (spawnTokens + renderedTokens > maxSpawnTokens) break;

            spawnLines.push(renderedChunk);
            spawnTokens += renderedTokens;
            if (c2SpawnRef !== null) c2ArtifactDegradations++;
          }
          if (spawnLines.length > 0) {
            volatileContextParts.push(`## Spawn Context Documents\n${spawnLines.join('\n\n')}`);
            contextTokens += spawnTokens;
            remaining -= spawnTokens;
            slots.library += spawnTokens;
          }
        }
      } catch {
        // Session-scoped chunk retrieval is best-effort
      }
    }

    // ── Cross-Session Context (L2: Messages) ─────────────────
    if (request.includeContext !== false && remaining > 500) {
      const crossSessionContent = this.buildCrossSessionContext(
        request.agentId,
        request.sessionKey,
        db,
        libDb,
        contextFingerprints  // C3: skip entries already in facts/semantic recall
      );

      if (crossSessionContent) {
        const tokens = estimateTokens(crossSessionContent);
        const maxContextTokens = Math.min(
          this.config.maxCrossSessionContext,
          Math.floor(remaining * 0.2)
        );

        if (tokens <= maxContextTokens) {
          volatileContextParts.push(`## Other Active Sessions\n${crossSessionContent}`);
          contextTokens += tokens;
          remaining -= tokens;
          slots.context += tokens;
        } else {
          const truncated = this.truncateToTokens(crossSessionContent, maxContextTokens);
          const truncTokens = estimateTokens(truncated);
          volatileContextParts.push(`## Other Active Sessions (truncated)\n${truncated}`);
          contextTokens += truncTokens;
          remaining -= truncTokens;
          slots.context += truncTokens;
          warnings.push('Cross-session context truncated');
        }
      }
    }

    // ── Action Verification Summary ─────────────────────────
    // Keep recent action history on the dynamic side of the cache boundary.
    if (remaining > 50 && request.includeLibrary !== false) {
      const pressurePct = budget > 0 ? Math.round(((budget - remaining) / budget) * 100) : 0;
      const actionSummary = buildActionVerificationSummary(messages, pressurePct);
      if (actionSummary) {
        const actionTokens = Math.ceil(actionSummary.length / 4);
        if (actionTokens <= remaining) {
          volatileContextParts.push(actionSummary);
          contextTokens += actionTokens;
          remaining -= actionTokens;
          slots.context += actionTokens;
        }
      }
    }

    const firstNonSystem = messages.findIndex(m => m.role !== 'system');
    const stableInsertIdx = firstNonSystem === -1 ? messages.length : firstNonSystem;

    if (stablePrefixMessages.length > 0) {
      messages.splice(stableInsertIdx, 0, ...stablePrefixMessages);
    }

    // ── Inject assembled context block ──────────────────────
    // Sprint 4: Prompt-tail placement.
    // Volatile context (active facts, temporal, open-domain, semantic recall,
    // doc chunks, cross-session) moves AFTER all history messages so that
    // query-shaped material lands near the user turn rather than buried mid-prompt.
    //
    // Layout after Sprint 4:
    //   [stable prefix: system, identity, FOS/MOD, stable facts, knowledge, prefs]
    //   [history: keystones, cross-topic, recent conversation messages]
    //   [volatile context block ← here, at the tail]   ← Sprint 4 reorder
    //   [last user message]
    //
    // The cache boundary (dynamicBoundary: true) stays on this block so the
    // Anthropic/OpenAI cache-prefix logic still fires correctly — everything
    // ABOVE this message is the stable prefix eligible for caching.
    const assembledContextBlock = volatileContextParts.length > 0 ? volatileContextParts.join('\n\n') : undefined;

    let s4VolatileContextPosition: number | undefined;
    let s4MessagesBeforeVolatile: number | undefined;

    if (assembledContextBlock) {
      const contextMsg: NeutralMessage = {
        role: 'system',
        textContent: assembledContextBlock,
        toolCalls: null,
        toolResults: null,
        // CACHE_PREFIX_BOUNDARY_SLOT: this message starts the volatile side of the
        // prompt. Everything above it is stable-prefix material eligible for reuse;
        // everything at or below it is per-session / per-turn context.
        metadata: { dynamicBoundary: true, cacheBoundarySlot: CACHE_PREFIX_BOUNDARY_SLOT },
      };
      // Sprint 4: Insert at tail (end of messages array), AFTER history.
      // The last user message (if any) should remain the final message, so we
      // insert the volatile block just before the last user message.
      const lastMsgIdx = messages.length - 1;
      const lastMsg = lastMsgIdx >= 0 ? messages[lastMsgIdx] : undefined;
      if (lastMsg && lastMsg.role === 'user') {
        // Insert volatile block before the last user message so user turn stays last
        messages.splice(lastMsgIdx, 0, contextMsg);
        s4VolatileContextPosition = lastMsgIdx;
        s4MessagesBeforeVolatile = lastMsgIdx;
      } else {
        // No trailing user message — append at end
        messages.push(contextMsg);
        s4VolatileContextPosition = messages.length - 1;
        s4MessagesBeforeVolatile = messages.length - 1;
      }
    }

    const stablePrefix = getStablePrefixMessages(messages);
    const prefixSegmentCount = stablePrefix.length;
    const prefixTokens = stablePrefix.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    const volatileHistoryTokens = messages.slice(prefixSegmentCount)
      .reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    const prefixHash = computeStablePrefixHash(stablePrefix);

    // ─── Safety Valve: Post-Assembly Budget Check (C1-aware) ──────────────
    // Re-estimate total tokens after all slots are assembled. If the
    // composition exceeds tokenBudget * 1.05 (5% tolerance for estimation
    // drift), trim history messages from the oldest until we're under budget.
    // History is the most compressible slot — system/identity are never
    // truncated, and context (facts/recall/episodes) is more valuable per-token.
    //
    // C1: When an assistant message with toolCalls is ejected, its dependent
    // tool-result messages are co-ejected or stubbed via resolveToolChainEjections.
    // This ensures no orphaned tool-results survive above the stable-prefix
    // boundary and eliminates the downstream repairToolPairs cleanup cost.
    const estimatedTotal = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const hardCeiling = Math.floor(budget * 1.05);

    if (estimatedTotal > hardCeiling) {
      const overage = estimatedTotal - budget;
      let trimmed = 0;
      let trimCount = 0;

      // Collect indices of messages to eject before mutating the array.
      // Walk forward from the first non-system message, trimming oldest first.
      // Sprint 4: Skip the volatile context block (dynamicBoundary: true) — it
      // is query-shaped content that should not be evicted during the safety
      // valve pass. The stable prefix system messages are also protected (role=system).
      const firstNonSystemIdx = messages.findIndex(m => m.role !== 'system');
      const ejectIndices = new Set<number>();

      if (firstNonSystemIdx >= 0) {
        let i = firstNonSystemIdx;
        while (i < messages.length && trimmed < overage) {
          // Don't trim the last user message (current prompt).
          if (i === messages.length - 1 && messages[i].role === 'user') break;
          // Sprint 4: Don't trim the volatile context block (dynamicBoundary marker).
          const meta = messages[i].metadata as Record<string, unknown> | undefined;
          if (meta?.dynamicBoundary) { i++; continue; }
          const msgTokens = estimateMessageTokens(messages[i]);
          ejectIndices.add(i);
          trimmed += msgTokens;
          trimCount++;
          i++;
        }
      }

      if (ejectIndices.size > 0) {
        // C1: centralized ejection — resolves dependent tool-results atomically.
        const ejectionResult = resolveToolChainEjections(
          messages,
          ejectIndices,
          'eviction_oversize',
        );
        // Replace in-place so the rest of the compose path sees the clean array.
        messages.length = 0;
        messages.push(...ejectionResult.messages);
        c1CoEjections += ejectionResult.coEjections;
        c1StubReplacements += ejectionResult.stubReplacements;

        slots.history = Math.max(0, slots.history - trimmed);
        remaining += trimmed;
        const c1Note = (ejectionResult.coEjections + ejectionResult.stubReplacements > 0)
          ? ` [C1: ${ejectionResult.coEjections} co-ejected, ${ejectionResult.stubReplacements} stubbed]`
          : '';
        warnings.push(`Safety valve: trimmed ${trimCount} oldest history messages (${trimmed} tokens) to fit budget${c1Note}`);
      }
    }

    // ─── Sprint 2.1: Hydrate active-turn artifact stubs ────────────────────
    // Must run on NeutralMessages[] BEFORE provider translation.
    const hydrationResult = this.hydrateActiveTurnArtifacts(messages, db);

    // ─── Translate to provider format (unless caller wants neutral) ───
    // When skipProviderTranslation is set, return NeutralMessages directly.
    // The context engine plugin uses this: the OpenClaw runtime handles its
    // own provider translation, so double-translating corrupts tool calls.
    const outputMessages = toComposeOutputMessages(messages);

    // T1.3: Strip warm-replay provenance flags before output.
    // _warmed is an internal tag added by warmSession() to mark messages
    // seeded from SQLite into Redis. It must not leak into provider submissions
    // or be visible to the runtime (which might misinterpret it).
    for (const msg of outputMessages) {
      const m = msg as unknown as NeutralMessage;
      if (m.metadata && (m.metadata as Record<string, unknown>)._warmed) {
        const { _warmed, ...cleanMeta } = m.metadata as Record<string, unknown>;
        (m as { metadata?: Record<string, unknown> }).metadata = Object.keys(cleanMeta).length > 0 ? cleanMeta : undefined;
      }
    }

    const totalTokens = budget - remaining;

    // Sprint 3: Unified pressure signal — compose path
    const s3Pressure = computeUnifiedPressure(totalTokens, budget, PRESSURE_SOURCE.COMPOSE_POST_ASSEMBLY);

    // ─── Slot reconciliation ─────────────────────────────────────────────────
    // totalTokens = budget - remaining is the authoritative spend figure.
    // The slot accounting can drift from this due to history trim (which
    // reduces slots.history but adds back to remaining after the budget
    // was already committed) and FOS/MOD token rounding.
    // Reconcile: assign any unaccounted tokens to slots.history so that
    // sum(slots) === totalTokens always holds.
    {
      const slotSum = (slots.system ?? 0) + (slots.identity ?? 0) +
        (slots.history ?? 0) + (slots.facts ?? 0) +
        (slots.context ?? 0) + (slots.library ?? 0);
      const delta = totalTokens - slotSum;
      if (delta !== 0) {
        slots.history = (slots.history ?? 0) + delta;
      }
    }

    // ─── Compaction Fence Update ──────────────────────────────
    // Record the oldest message ID that the LLM can see in this compose
    // cycle. Everything below this ID becomes eligible for compaction.
    // If history was included, query the DB for the oldest included message.
    //
    // Sprint 1: Capture compaction eligibility counts BEFORE updating the fence
    // so we can report how many messages were eligible at the start of this pass.
    let diagCompactionEligibleCount: number | undefined;
    let diagCompactionEligibleRatio: number | undefined;
    let diagCompactionProcessedCount: number | undefined;
    if (request.includeHistory !== false && slots.history > 0) {
      try {
        const conversation = store.getConversation(request.sessionKey);
        if (conversation) {
          // Sprint 1: read eligibility BEFORE advancing the fence
          try {
            ensureCompactionFenceSchema(db);
            const eligibilityBefore = getCompactionEligibility(db, conversation.id);
            if (eligibilityBefore.fence !== null) {
              // Total messages below fence (denominator for ratio)
              const totalRow = db.prepare(
                'SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = ?'
              ).get(conversation.id) as { cnt: number } | undefined;
              const totalMessages = totalRow?.cnt ?? 0;
              diagCompactionEligibleCount = eligibilityBefore.eligibleCount;
              diagCompactionEligibleRatio = totalMessages > 0
                ? Math.round((eligibilityBefore.eligibleCount / totalMessages) * 1000) / 1000
                : 0;
            }
          } catch {
            // Eligibility query is best-effort
          }

          // The compositor included N history messages (after truncation).
          // Count how many non-system messages are in the output to determine
          // how far back we reached.
          const historyMsgCount = messages.filter(m => m.role !== 'system').length;
          if (historyMsgCount > 0) {
            // Get the oldest message we would have included.
            // getRecentMessages returns the last N in chronological order,
            // so the first element is the oldest included.
            const oldestIncluded = db.prepare(`
              SELECT id FROM messages
              WHERE conversation_id = ?
              ORDER BY message_index DESC
              LIMIT 1 OFFSET ?
            `).get(conversation.id, historyMsgCount - 1) as { id: number } | undefined;

            if (oldestIncluded) {
              updateCompactionFence(db, conversation.id, oldestIncluded.id, { minTailMessages: 8 });
              // Sprint 1: count how many messages moved from eligible -> fence-protected
              // (i.e. they are now above the updated fence)
              try {
                const eligibilityAfter = getCompactionEligibility(db, conversation.id);
                if (diagCompactionEligibleCount !== undefined) {
                  diagCompactionProcessedCount = Math.max(
                    0,
                    diagCompactionEligibleCount - eligibilityAfter.eligibleCount,
                  );
                }
              } catch {
                // After-eligibility query is best-effort
              }
            }
          }
        }
      } catch {
        // Fence update is best-effort — never fail composition
        warnings.push('Compaction fence update failed (non-fatal)');
      }
    }

    // W3: Build compose diagnostics
    let zeroResultReason: import('./types.js').ComposeDiagnostics['zeroResultReason'];
    if (volatileContextParts.length === 0 && stablePrefixMessages.length === 0) {
      if (diagScopeFiltered > 0 && diagFactsIncluded === 0 && diagSemanticResults === 0) {
        zeroResultReason = 'scope_filtered_all';
      } else if (remaining <= 0) {
        zeroResultReason = 'budget_exhausted';
      } else if (diagTriggerHits === 0 && !diagTriggerFallbackUsed) {
        zeroResultReason = 'no_trigger_no_fallback';
      } else if ((diagTriggerHits > 0 || diagTriggerFallbackUsed) && diagFactsIncluded === 0 && diagSemanticResults === 0 && diagDocChunkCollections === 0) {
        // Retrieval was attempted (trigger fired or fallback ran) but returned nothing — likely a retrieval bug
        // rather than a genuinely empty corpus. Distinguish from 'empty_corpus' for observability.
        zeroResultReason = 'unknown';
      } else {
        zeroResultReason = 'empty_corpus';
      }
    }

    // ── Sprint 4: Explicit budget lanes ───────────────────────────────────────────────
    // Compute allocated token lanes for this compose pass.
    // Budget = effective input budget (post-reserve).
    // Filled values reflect actual spend after slot fill and safety-valve trim.
    const s4HistoryLane = Math.floor(budget * b4HistoryFraction);
    const s4MemoryLane = Math.floor(budget * b4MemoryFraction);
    const s4StableFilledTokens = (slots.system ?? 0) + (slots.identity ?? 0);
    const s4HistoryFilledTokens = slots.history ?? 0;
    const s4MemoryFilledTokens = (slots.facts ?? 0) + (slots.context ?? 0) + (slots.library ?? 0);
    const s4TotalFilled = s4StableFilledTokens + s4HistoryFilledTokens + s4MemoryFilledTokens;
    const budgetLanes: CompositorBudgetLanes = {
      effectiveBudget: budget,
      stablePrefix: slots.system + slots.identity,
      history: s4HistoryLane,
      memory: s4MemoryLane,
      historyFraction: b4HistoryFraction,
      memoryFraction: b4MemoryFraction,
      overhead: Math.max(0, budget - s4TotalFilled),
      filled: {
        stablePrefix: s4StableFilledTokens,
        history: s4HistoryFilledTokens,
        memory: s4MemoryFilledTokens,
      },
    };

    // ── Sprint 4: OpenAI prefix-cache diagnostics ────────────────────────────────────
    // Expose prefix-boundary information for OpenAI providers so operators
    // can tune prompt layout for cache hit rate without guesswork.
    // Non-fatal — never block compose.
    let openaiPrefixCacheDiag: OpenAIPrefixCacheDiag | undefined;
    try {
      const s4Provider = s4DetectProvider(request.provider ?? request.model);
      if (s4Provider === 'openai' || s4Provider === 'openai-responses') {
        const totalWindowTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
        const cacheableFraction = totalWindowTokens > 0
          ? Math.round((prefixTokens / totalWindowTokens) * 1000) / 1000
          : 0;
        // Sprint 4: volatileAtTail is true when the volatile context block is
        // positioned AFTER any history (or, vacuously, when no history exists and
        // the block sits just before the final user turn). In both cases nothing
        // but the current user message follows the boundary, which is the
        // cacheable layout. When assembledContextBlock is missing we report
        // false since there is nothing to place at tail.
        let s4VolatileAtTail = false;
        if (s4VolatileContextPosition !== undefined) {
          // Any messages after the boundary must be user turns only (no history).
          const tail = messages.slice(s4VolatileContextPosition + 1);
          s4VolatileAtTail = tail.every(m => m.role === 'user')
            && s4VolatileContextPosition >= prefixSegmentCount;
        }
        openaiPrefixCacheDiag = {
          stablePrefixMessageCount: prefixSegmentCount,
          stablePrefixTokens: prefixTokens,
          volatileAtTail: s4VolatileAtTail,
          cacheableFraction,
          prefixHash,
        };
      }
    } catch {
      // Provider detection is best-effort — never block compose
    }

    // 0.9.0: lifecycle policy was resolved pre-recall and used to scale recall
    // breadth. Diagnostics surface the same object so reported band/multiplier
    // matches what actually controlled retrieval this compose pass.

    const diagnostics: import('./types.js').ComposeDiagnostics = {
      triggerHits: diagTriggerHits,
      triggerFallbackUsed: diagTriggerFallbackUsed,
      factsIncluded: diagFactsIncluded,
      semanticResultsIncluded: diagSemanticResults,
      docChunksCollections: diagDocChunkCollections,
      scopeFiltered: diagScopeFiltered,
      zeroResultReason,
      retrievalMode: diagRetrievalMode,
      crossTopicKeystones: diagCrossTopicKeystones,
      reserveFraction: dynamicReserve,
      avgTurnCostTokens: avgTurnCost,
      dynamicReserveActive: isDynamic,
      sessionPressureHigh: pressureHigh,
      fingerprintDedups: diagFingerprintDedups,
      fingerprintCollisions: diagFingerprintCollisions,
      windowCacheHit: false,
      prefixSegmentCount,
      prefixTokens,
      prefixHash,
      // B2: Surface the previous cached prefixHash when this full compose was
      // triggered by a cache bypass (stable-prefix mutation detected).
      prevPrefixHash: _prevPrefixHashFromBypass,
      volatileHistoryTokens,
      // Sprint 4 fields
      sessionType: s4SessionType,
      historyDepthChosen: s4EffectiveDepth,
      estimatedMsgDensityTokens: s4ObservedDensity,
      rescueTrimFired: s4RescueTrimFired,
      // Sprint 4: prompt-tail placement diagnostics
      budgetLanes,
      volatileContextPosition: s4VolatileContextPosition,
      messagesBeforeVolatile: s4MessagesBeforeVolatile,
      openaiPrefixCacheDiag,
      // Sprint 3: unified pressure signal
      sessionPressureFraction: s3Pressure.fraction,
      pressureSource: s3Pressure.source,
      // B4: model-aware lane budget diagnostics
      mecwProfile: b4MecwProfile,
      mecwApplied: b4MecwApplied,
      mecwBlend: b4MecwBlend,
      effectiveHistoryFraction: b4HistoryFraction,
      effectiveMemoryFraction: b4MemoryFraction,
      trimSoftTarget: TRIM_BUDGET_POLICY.trimSoftTarget,
      trimGrowthThreshold: TRIM_BUDGET_POLICY.trimGrowthThreshold,
      trimHeadroomFraction: TRIM_BUDGET_POLICY.trimHeadroomFraction,
      // 0.9.0: adaptive lifecycle diagnostics for compose.preRecall
      adaptiveLifecycleBand: composeLifecyclePolicy.band,
      adaptiveLifecyclePressurePct: composeLifecyclePolicy.pressurePct,
      adaptiveWarmHistoryBudgetFraction: composeLifecyclePolicy.warmHistoryBudgetFraction,
      adaptiveSmartRecallMultiplier: composeLifecyclePolicy.smartRecallMultiplier,
      adaptiveTrimSoftTarget: composeLifecyclePolicy.trimSoftTarget,
      adaptiveCompactionTargetFraction: composeLifecyclePolicy.compactionTargetFraction,
      adaptiveBreadcrumbPackage: composeLifecyclePolicy.emitBreadcrumbPackage,
      adaptiveTopicCentroidEviction: composeLifecyclePolicy.enableTopicCentroidEviction,
      adaptiveProactiveCompaction: composeLifecyclePolicy.triggerProactiveCompaction,
      adaptiveLifecycleReasons: composeLifecyclePolicy.reasons,
      adaptiveRecallBudgetTokens: diagAdaptiveRecallBudgetTokens,
      adaptiveRecallCandidateLimit: diagAdaptiveRecallCandidateLimit,
      adaptiveEvictionLifecycleBand: evictionLifecyclePolicy.band,
      adaptiveEvictionPressurePct: evictionLifecyclePolicy.pressurePct,
      adaptiveEvictionTopicAwareEligibleClusters,
      adaptiveEvictionTopicAwareDroppedClusters,
      adaptiveEvictionProtectedClusters,
      adaptiveEvictionTopicIdCoveragePct,
      adaptiveEvictionBypassReason,
      adaptiveLifecycleBandDiverged: evictionLifecyclePolicy.band !== composeLifecyclePolicy.band,
      adaptiveForkedContext: s09ForkedContextSeed ? true : undefined,
      adaptiveForkedParentPressurePct: s09ForkedParentPressure != null
        ? Math.round(s09ForkedParentPressure * 100)
        : undefined,
      adaptiveForkedParentUserTurns: s09ForkedContextSeed?.parentUserTurnCount,
      // C1: tool-chain ejection telemetry
      toolChainCoEjections: c1CoEjections > 0 ? c1CoEjections : undefined,
      toolChainStubReplacements: c1StubReplacements > 0 ? c1StubReplacements : undefined,
      // C2: artifact oversize degradation telemetry
      artifactDegradations: c2ArtifactDegradations > 0 ? c2ArtifactDegradations : undefined,
      artifactOversizeThresholdTokens: c2ArtifactThresholdTokens,
      // Sprint 2.1: tool artifact hydration telemetry
      artifactsHydrated: hydrationResult.artifactsHydrated > 0 ? hydrationResult.artifactsHydrated : undefined,
      hydrationBytes: hydrationResult.hydrationBytes > 0 ? hydrationResult.hydrationBytes : undefined,
      hydrationMisses: hydrationResult.hydrationMisses > 0 ? hydrationResult.hydrationMisses : undefined,
      // Sprint 1: observability layer
      rerankerStatus: diagRerankerStatus,
      rerankerCandidates: diagRerankerCandidates,
      rerankerProvider: diagRerankerProvider,
      // Sprint 1: named slot spans (allocated vs filled, overflow flag)
      slotSpans: {
        system:   { allocated: slots.system,   filled: slots.system,   overflow: false },
        identity: { allocated: slots.identity, filled: slots.identity, overflow: false },
        history:  { allocated: Math.floor(budget * b4HistoryFraction), filled: slots.history,  overflow: slots.history > Math.floor(budget * b4HistoryFraction) },
        facts:    { allocated: Math.floor(budget * b4MemoryFraction),  filled: slots.facts,    overflow: false },
        context:  { allocated: Math.floor(budget * b4MemoryFraction),  filled: slots.context,  overflow: false },
        library:  { allocated: Math.floor(budget * b4MemoryFraction),  filled: slots.library,  overflow: false },
      },
      // Sprint 1: compaction eligibility
      compactionEligibleCount: diagCompactionEligibleCount,
      compactionEligibleRatio: diagCompactionEligibleRatio,
      compactionProcessedCount: diagCompactionProcessedCount,
    };

    if (pressureHigh) {
      warnings.push(`SESSION_PRESSURE_HIGH: avg_turn_cost=${avgTurnCost} tokens, dynamic reserve capped at ${Math.round(dynamicReserve * 100)}%`);
    } else if (dynamicReserve > 0.40) {
      console.info(`[hypermem:compositor] dynamic_reserve=${Math.round(dynamicReserve * 100)}% avg_turn_cost=${Math.round(avgTurnCost / 1000)}k horizon=${this.config.dynamicReserveTurnHorizon ?? 5}`);
    }

    const composedAt = new Date().toISOString();

    // ─── Write Window Cache ─────────────────────────────
    // Cache the composed message array so the plugin can serve it directly
    // on the next assemble() call without re-running the full compose pipeline.
    // Short TTL (120s). External L4 mutations should set skipWindowCache=true.
    //
    // VS-1: Dual-write, session-scoped key for backwards compat;
    // topic-scoped key for per-topic window retrieval when activeTopicId is set.
    try {
      // B2: Compute a cheap prefix input hash from the system + identity slot
      // contents that fed the stable prefix. Stored in WindowCacheMeta so the
      // C4 fast-exit can detect prefix mutations without re-running full compose.
      const _prefixInputHash = createHash('sha256')
        .update(systemContent ?? '')
        .update('\n␞\n')
        .update(identityContent ?? '')
        .digest('hex');
      await this.cache.setWindow(request.agentId, request.sessionKey, messages, 120);
      await this.cache.setWindowMeta(request.agentId, request.sessionKey, {
        slots: slots as unknown as Record<string, number>,
        totalTokens,
        warnings,
        diagnostics,
        composedAt,
        prefixHash,
        prefixInputHash: _prefixInputHash,
      }, 120);
    } catch {
      // Window cache write is best-effort
    }
    if (composedActiveTopicId) {
      try {
        await this.cache.setTopicWindow(request.agentId, request.sessionKey, composedActiveTopicId, messages, 120);
      } catch {
        // Topic window write is best-effort
      }
    }

    // ─── Write Session Cursor ─────────────────────────────────
    // Record the newest message included in the submission window.
    // Background indexer uses this to find unprocessed high-signal content.
    if (request.includeHistory !== false && slots.history > 0) {
      try {
        const historyMsgs = messages.filter(m => m.role !== 'system');
        const lastHistoryMsg = historyMsgs.length > 0 ? historyMsgs[historyMsgs.length - 1] : null;
        if (lastHistoryMsg) {
          const sm = lastHistoryMsg as import('./types.js').StoredMessage;
          if (sm.id != null && sm.messageIndex != null) {
            const cursor: SessionCursor = {
              lastSentId: sm.id,
              lastSentIndex: sm.messageIndex,
              lastSentAt: composedAt,
              windowSize: historyMsgs.length,
              tokenCount: totalTokens,
            };
            await this.cache.setCursor(request.agentId, request.sessionKey, cursor);

            try {
              db.prepare(`
                UPDATE conversations
                SET cursor_last_sent_id = ?,
                    cursor_last_sent_index = ?,
                    cursor_last_sent_at = ?,
                    cursor_window_size = ?,
                    cursor_token_count = ?
                WHERE session_key = ?
              `).run(
                cursor.lastSentId,
                cursor.lastSentIndex,
                cursor.lastSentAt,
                cursor.windowSize,
                cursor.tokenCount,
                request.sessionKey
              );
            } catch {
              // SQLite cursor write is best-effort, don't block compose
            }
          }
        }
      } catch {
        // Cursor write is best-effort
      }
    }

    try {
      const conversation = sampleConv ?? store.getConversation(request.sessionKey);
      if (conversation) {
        const snapshotContext = getOrCreateActiveContext(db, request.agentId, request.sessionKey, conversation.id);
        const repairNoticeContent = await this.cache.getSlot(request.agentId, request.sessionKey, 'repair_notice');

        insertCompositionSnapshot(db, {
          contextId: snapshotContext.id,
          headMessageId: snapshotContext.headMessageId ?? null,
          model: request.model ?? request.provider ?? 'unknown',
          contextWindow: totalWindow,
          totalTokens,
          fillPct: totalWindow > 0 ? Math.round((totalTokens / totalWindow) * 10000) / 10000 : 0,
          snapshotKind: 'composed_window',
          repairDepth: repairNoticeContent ? MAX_WARM_RESTORE_REPAIR_DEPTH : 0,
          slots: buildCompositionSnapshotSlots({
            system: systemContent,
            identity: identityContent,
            repairNotice: repairNoticeContent,
            messages,
            contextBlock: assembledContextBlock,
          }),
        });
      }
    } catch (error) {
      console.warn(`[hypermem:compositor] composition snapshot write skipped: ${(error as Error).message}`);
    }

    console.log(`[hypermem:compose] agent=${request.agentId} triggers=${diagTriggerHits} fallback=${diagTriggerFallbackUsed} facts=${diagFactsIncluded} semantic=${diagSemanticResults} chunks=${diagDocChunkCollections} scopeFiltered=${diagScopeFiltered} mode=${diagRetrievalMode} crossTopicKeystones=${diagCrossTopicKeystones} c2_degradations=${c2ArtifactDegradations} c2_threshold=${c2ArtifactThresholdTokens}`);
    return {
      messages: outputMessages,
      tokenCount: totalTokens,
      slots,
      truncated: remaining < 0 || estimatedTotal > hardCeiling,
      hasWarnings: warnings.length > 0,
      warnings,
      contextBlock: assembledContextBlock,
      diagnostics,
    };
  }

  /**
   * Warm a session from SQLite into Redis.
   * Called on session start or Redis cache miss.
   */
  async warmSession(
    agentId: string,
    sessionKey: string,
    db: DatabaseSync,
    opts?: {
      systemPrompt?: string;
      identity?: string;
      libraryDb?: DatabaseSync;
      /** Model string for budget resolution. If omitted, falls back to defaultTokenBudget. */
      model?: string;
    }
  ): Promise<void> {
    const store = new MessageStore(db);
    const conversation = store.getConversation(sessionKey);

    if (!conversation) return;

    // Phase 3 (Turn DAG): resolve active context for DAG-native warm preload.
    // Uses context.head_message_id to walk only the active branch.
    let activeContext: Context | null = null;
    try {
      activeContext = getOrCreateActiveContext(db, agentId, sessionKey, conversation.id);
    } catch {
      try {
        activeContext = getActiveContext(db, agentId, sessionKey);
      } catch {
        // Context resolution is best-effort
      }
    }

    // Phase 0 fence enforcement: resolve compaction fence for warm bootstrap.
    // Fence remains as transitional safety — primary scoping is via DAG walk.
    let warmFenceMessageId: number | undefined;
    try {
      ensureCompactionFenceSchema(db);
      const fence = getCompactionFence(db, conversation.id);
      if (fence) warmFenceMessageId = fence.fenceMessageId;
    } catch {
      // Fence lookup is best-effort
    }

    const warmMeta = {
      agentId,
      sessionKey,
      provider: conversation.provider,
      model: conversation.model,
      channelType: conversation.channelType,
      tokenCount: conversation.tokenCountIn + conversation.tokenCountOut,
      lastActive: conversation.updatedAt,
      status: conversation.status,
    };

    if (activeContext) {
      const warnSnapshotVerifyFallback = (reason: string, detail?: string) => {
        const detailSuffix = detail ? ` ${detail}` : '';
        console.warn(
          `[hypermem:compositor] warm snapshot verify fallback session=${sessionKey} reason=${reason} verify_fallback_count=1 cold_rewarm_count=1${detailSuffix}`,
        );
      };

      try {
        const snapshotCandidates = listCompositionSnapshots(db, activeContext.id, 2);
        const latestSnapshot = getLatestValidCompositionSnapshot(db, activeContext.id);
        if (latestSnapshot?.verification.slots) {
          const targetModel = opts?.model ?? conversation.model ?? 'unknown';
          const sourceModel = latestSnapshot.snapshot.model;
          const sourceProvider = s4DetectProvider(sourceModel);
          const targetProvider = s4DetectProvider(conversation.provider ?? targetModel);
          const restored = restoreWarmSnapshotState(latestSnapshot.verification.slots, {
            sourceProvider,
            targetProvider,
          });
          if (restored) {
            if (!restored.diagnostics.rolloutGatePassed) {
              const gateSummary = restored.diagnostics.rolloutGateViolations
                .map(violation => `${violation.gate}=${violation.actual}/${violation.max}`)
                .join(', ');
              console.warn(
                `[hypermem:compositor] warm snapshot rollout gate blocked session=${sessionKey} snapshot=${latestSnapshot.snapshot.id} violations=${JSON.stringify(gateSummary)} verify_fallback_count=${latestSnapshot.fallbackUsed ? 1 : 0} cold_rewarm_count=1`,
              );
              warnSnapshotVerifyFallback('rollout_gate_blocked', `snapshot=${latestSnapshot.snapshot.id} violations=${JSON.stringify(gateSummary)}`);
            } else {
              if (latestSnapshot.fallbackUsed) {
                console.warn(
                  `[hypermem:compositor] warm snapshot verify fallback session=${sessionKey} restored_snapshot=${latestSnapshot.snapshot.id} verify_fallback_count=1 cold_rewarm_count=0 reason=latest_snapshot_invalid_or_unverifiable`,
                );
              }

              const repairNoticeLines = [
              `Repair notice: this session is a repaired continuation from snapshot ${latestSnapshot.snapshot.id}.`,
              `Source model: ${sourceModel}. Target model: ${targetModel}.`,
              `Source provider: ${sourceProvider}. Target provider: ${targetProvider}.`,
              `Cross-model boundary: ${sourceModel !== targetModel ? 'yes' : 'no'}.`,
              `Cross-provider boundary: ${restored.diagnostics.crossProviderBoundary ? 'yes' : 'no'}.`,
              `Repair depth: ${MAX_WARM_RESTORE_REPAIR_DEPTH}.`
            ];

            if (latestSnapshot.fallbackUsed) {
              repairNoticeLines.push('Snapshot verify fallback count: 1.');
            }
            if (restored.diagnostics.quotedAssistantTurns > 0) {
              repairNoticeLines.push(
                `Quoted foreign-provider assistant turns: ${restored.diagnostics.quotedAssistantTurns}.`,
              );
            }
            if (restored.diagnostics.toolPairParityViolations > 0) {
              repairNoticeLines.push(
                `Tool-pair parity gaps flagged: ${restored.diagnostics.toolPairParityViolations}.`,
              );
            }
            if (restored.diagnostics.requiredSlotDrops.length > 0) {
              repairNoticeLines.push(
                `Required-slot gaps flagged: ${restored.diagnostics.requiredSlotDrops.join(', ')}.`,
              );
            }

            const tokenParityDriftExceeded =
              restored.diagnostics.tokenParityDriftP95 > WARM_RESTORE_MEASUREMENT_GATES.tokenParityDriftP95Max
              || restored.diagnostics.tokenParityDriftP99 > WARM_RESTORE_MEASUREMENT_GATES.tokenParityDriftP99Max;
            if (
              tokenParityDriftExceeded
              || restored.diagnostics.requiredSlotDropRate > WARM_RESTORE_MEASUREMENT_GATES.requiredSlotDropRateMax
              || restored.diagnostics.stablePrefixBoundaryViolations > WARM_RESTORE_MEASUREMENT_GATES.stablePrefixBoundaryViolationsMax
              || restored.diagnostics.toolPairParityViolations > WARM_RESTORE_MEASUREMENT_GATES.toolPairParityViolationsMax
              || restored.diagnostics.continuityCriticalBoundaryTransformRate > WARM_RESTORE_MEASUREMENT_GATES.continuityCriticalBoundaryTransformRateMax
            ) {
              repairNoticeLines.push(
                `Warm-restore instrumentation gap: token parity drift p95=${restored.diagnostics.tokenParityDriftP95.toFixed(4)}, p99=${restored.diagnostics.tokenParityDriftP99.toFixed(4)}, stable_prefix violations=${restored.diagnostics.stablePrefixBoundaryViolations}, continuity-critical transform rate=${restored.diagnostics.continuityCriticalBoundaryTransformRate.toFixed(4)}.`,
              );
            }
            const repairNoticeContent = repairNoticeLines.join(' ');

              await this.cache.invalidateWindow(agentId, sessionKey);
              await this.cache.warmSession(agentId, sessionKey, {
                system: restored.system ?? opts?.systemPrompt,
                identity: restored.identity ?? opts?.identity,
                repairNotice: repairNoticeContent,
                history: restored.history,
                meta: warmMeta,
              });
              console.info(
                `[hypermem:compositor] warm snapshot restore session=${sessionKey} snapshot=${latestSnapshot.snapshot.id} fallback=${latestSnapshot.fallbackUsed} cross_provider=${restored.diagnostics.crossProviderBoundary} quoted_assistant_turns=${restored.diagnostics.quotedAssistantTurns} tool_pair_gaps=${restored.diagnostics.toolPairParityViolations} rollout_gate_passed=${restored.diagnostics.rolloutGatePassed} token_parity_drift_p95=${restored.diagnostics.tokenParityDriftP95.toFixed(4)} token_parity_drift_p99=${restored.diagnostics.tokenParityDriftP99.toFixed(4)}`,
              );
              return;
            }
          }

          warnSnapshotVerifyFallback('restore_unusable', `snapshot_count=${snapshotCandidates.length}`);
        } else if (snapshotCandidates.length > 0) {
          warnSnapshotVerifyFallback('no_valid_snapshot', `snapshot_count=${snapshotCandidates.length}`);
        }
      } catch (error) {
        warnSnapshotVerifyFallback('restore_exception', `error=${JSON.stringify((error as Error).message)}`);
      }
    }

    // Fetch a generous pool from SQLite, apply gradient transform, then
    // token-budget-cap the warm set. This replaces the old WARM_BOOTSTRAP_CAP
    // message-count constant which was a blunt instrument — 100 messages of
    // large tool results can massively exceed the history budget allocation.
    // Warm budget uses the same reserve fraction as compose() so warm history
    // never pre-fills more than compose() would actually allow.
    const reserve = this.config.contextWindowReserve ?? 0.15;
    const effectiveBudget = resolveModelBudget(opts?.model, this.config.defaultTokenBudget, reserve, this.config.budgetFraction);
    const warmBudget = Math.floor(
      effectiveBudget * (this.config.warmHistoryBudgetFraction ?? 0.4)
    );

    // Phase 3 (Turn DAG): prefer DAG walk from context head for warm preload.
    // This ensures only active-branch messages enter the warm cache.
    let rawHistory: StoredMessage[];
    if (activeContext?.headMessageId) {
      rawHistory = store.getHistoryByDAGWalk(activeContext.headMessageId, this.config.maxHistoryMessages);
      // DAG walk may return empty for legacy data — fall back to fence-scoped query
      if (rawHistory.length === 0) {
        rawHistory = store.getRecentMessages(conversation.id, this.config.maxHistoryMessages, warmFenceMessageId);
      }
    } else {
      rawHistory = store.getRecentMessages(conversation.id, this.config.maxHistoryMessages, warmFenceMessageId);
    }
    const transformedForWarm = applyToolGradient(rawHistory, {
      totalWindowTokens: resolveModelWindow(opts?.model, this.config.defaultTokenBudget),
    });

    // Walk newest→oldest, accumulate transformed token cost, stop when budget exhausted
    let warmTokens = 0;
    const history: typeof rawHistory = [];
    for (let i = transformedForWarm.length - 1; i >= 0; i--) {
      const cost = estimateMessageTokens(transformedForWarm[i]);
      if (warmTokens + cost > warmBudget) break;
      // T1.3 Provenance flag: tag warm-seeded messages so they can be identified
      // downstream. The flag is stripped before provider submission in compose().
      // This prevents the runtime from treating warm-replayed user messages as
      // new inbound queries (ghost message bug).
      const tagged = { ...transformedForWarm[i] } as typeof rawHistory[0];
      tagged.metadata = { ...(tagged.metadata || {}), _warmed: true };
      history.unshift(tagged);
      warmTokens += cost;
    }

    // Note: facts and context are intentionally NOT cached here.
    // compose() calls buildFactsFromDb() and buildCrossSessionContext() directly
    // from SQLite on every turn (~0.3ms each) — faster than a Redis GET round-trip.
    // Caching them here would create stale entries that compose() ignores anyway.

    // Invalidate the window cache so the next compose rebuilds with the fresh
    // system/identity slots. Without this, the fast-exit returns a stale bundle
    // that predates the warm and reports identity=0.
    await this.cache.invalidateWindow(agentId, sessionKey);

    await this.cache.warmSession(agentId, sessionKey, {
      system: opts?.systemPrompt,
      identity: opts?.identity,
      history,
      meta: warmMeta,
    });
  }

  async refreshRedisGradient(
    agentId: string,
    sessionKey: string,
    db: DatabaseSync,
    tokenBudget?: number,
    historyDepth?: number,
    trimSoftTarget?: number,
  ): Promise<void> {
    const store = new MessageStore(db);
    const conversation = store.getConversation(sessionKey);
    if (!conversation) return;

    // Phase 3 (Turn DAG): resolve active context for DAG-native gradient refresh
    let activeContext: Context | null = null;
    try {
      activeContext = getActiveContext(db, agentId, sessionKey);
    } catch {
      // Context resolution is best-effort
    }

    // Phase 0 fence enforcement for gradient refresh (transitional safety)
    let gradientFenceMessageId: number | undefined;
    try {
      ensureCompactionFenceSchema(db);
      const fence = getCompactionFence(db, conversation.id);
      if (fence) gradientFenceMessageId = fence.fenceMessageId;
    } catch {
      // Fence lookup is best-effort
    }

    // Phase 3: prefer DAG walk from context head
    const refreshHistoryLimit = Math.min(
      this.config.maxHistoryMessages,
      Math.max(1, historyDepth ?? this.config.maxHistoryMessages),
    );

    let rawHistory: StoredMessage[];
    if (activeContext?.headMessageId) {
      rawHistory = store.getHistoryByDAGWalk(activeContext.headMessageId, refreshHistoryLimit);
      if (rawHistory.length === 0) {
        rawHistory = store.getRecentMessages(conversation.id, refreshHistoryLimit, gradientFenceMessageId);
      }
    } else {
      rawHistory = store.getRecentMessages(conversation.id, refreshHistoryLimit, gradientFenceMessageId);
    }
    // Sprint 3 (AfterTurn Rebuild/Trim Loop Fix): cap gradient total-window tokens
    // at the same 65% target that assemble.normal trims to. Previously this was
    // tokenBudget/0.80 (≈1.25×budget), which made applyToolGradient preserve more
    // content than the trim target allowed — causing assemble.normal to always trim
    // on the next turn even in the steady-state path. Aligning the gradient cap to
    // the trim target means the rebuilt window already fits within the assemble
    // envelope by construction.
    const { softBudget: gradientAssembleBudget } = resolveTrimBudgets(tokenBudget ?? 0, { trimSoftTarget });
    const transformedHistory = applyToolGradient(rawHistory, {
      totalWindowTokens: tokenBudget && tokenBudget > 0
        ? gradientAssembleBudget
        : TOOL_PLANNING_BASELINE_WINDOW,
    });

    // If a token budget is provided, trim the gradient-compressed window to fit
    // before writing to Redis. The cap uses the same GRADIENT_ASSEMBLE_TARGET
    // (0.65) so the window written to Redis sits inside the assemble.normal trim
    // envelope. The next assemble() will find the window already within budget
    // and skip the trim entirely in the steady-state path.
    let historyToWrite: NeutralMessage[] = transformedHistory;
    if (tokenBudget && tokenBudget > 0) {
      const budgetCap = gradientAssembleBudget;
      let runningTokens = 0;
      const clusters = clusterNeutralMessages(transformedHistory);
      const cappedClusters: NeutralMessageCluster<NeutralMessage>[] = [];
      // Walk newest-first, keep whole clusters so tool-call/result pairs survive together.
      for (let i = clusters.length - 1; i >= 0; i--) {
        const cluster = clusters[i];
        if (runningTokens + cluster.tokenCost > budgetCap && cappedClusters.length > 0) break;
        cappedClusters.unshift(cluster);
        runningTokens += cluster.tokenCost;
        if (runningTokens >= budgetCap) break;
      }
      historyToWrite = cappedClusters.flatMap(cluster => cluster.messages);
      if (historyToWrite.length < transformedHistory.length) {
        console.log(
          `[hypermem] refreshRedisGradient: cluster-capped ${transformedHistory.length}→${historyToWrite.length} messages ` +
          `for ${agentId}/${sessionKey} (budgetCap=${budgetCap}, tokenCost=${runningTokens})`
        );
      }
    }

    await this.cache.replaceHistory(agentId, sessionKey, historyToWrite, refreshHistoryLimit);
  }

  // ─── Slot Content Resolution ─────────────────────────────────

  /**
   * Get slot content: try Redis first, fall back to SQLite.
   */
  private async getSlotContent(
    agentId: string,
    sessionKey: string,
    slot: string,
    db: DatabaseSync,
    libraryDb?: DatabaseSync
  ): Promise<string | null> {
    const cached = await this.cache.getSlot(agentId, sessionKey, slot);
    if (cached) return cached;

    switch (slot) {
      case 'facts': {
        const result = this.buildFactsFromDb(agentId, sessionKey, libraryDb || this.libraryDb || db);
        return result ? result[0] : null;
      }
      case 'context':
        return this.buildCrossSessionContext(agentId, sessionKey, db, libraryDb || this.libraryDb);
      default:
        return null;
    }
  }

  /**
   * Get conversation history: try Redis first, fall back to SQLite.
   *
   * When topicId is provided (P3.4), the SQLite path filters to messages
   * matching that topic OR with topic_id IS NULL (Option B transition safety).
   * The Redis path is unaffected — Redis doesn't index by topic, so topic
   * filtering only applies to the SQLite fallback.
   */
  private async getHistory(
    agentId: string,
    sessionKey: string,
    limit: number,
    store: MessageStore,
    topicId?: string,
    fenceMessageId?: number,
    activeContext?: Context | null
  ): Promise<NeutralMessage[]> {
    // Pass limit through to Redis — this is the correct enforcement point.
    // Previously getHistory() ignored the limit on the Redis path (LRANGE 0 -1),
    // meaning historyDepth in the compose request had no effect on hot sessions.
    const cached = await this.cache.getHistory(agentId, sessionKey, limit);
    if (cached.length > 0) return cached;

    // Phase 3 (Turn DAG): walk from context.head_message_id backward through
    // parent_id links. This is the primary correctness mechanism — the fence
    // remains as transitional safety only.
    if (activeContext?.headMessageId) {
      const dagMessages = store.getHistoryByDAGWalk(activeContext.headMessageId, limit);
      if (dagMessages.length > 0) return dagMessages;
      // DAG walk returned empty (e.g., legacy data without parent chains) — fall through
    }

    const conversation = store.getConversation(sessionKey);
    if (!conversation) return [];

    if (topicId) {
      // P3.4: Option B — active topic messages + legacy NULL messages
      return store.getRecentMessagesByTopic(conversation.id, topicId, limit, fenceMessageId);
    }
    return store.getRecentMessages(conversation.id, limit, fenceMessageId);
  }

  // ─── L4 Library Builders ─────────────────────────────────────

  /**
   * Build facts content from library DB.
   */
  /**
   * Build facts content from library DB.
   * Applies filterByScope (W1) to enforce retrieval access control.
   * Returns [content, factCount, scopeFilteredCount] or null if DB unavailable.
   */
  private buildFactsFromDb(
    agentId: string,
    sessionKey: string,
    db: DatabaseSync | null,
  ): [string | null, number, number] | null {
    const sections = this.buildFactSectionsFromDb(agentId, sessionKey, db);
    if (!sections) return null;

    const combined = [sections.stableContent, sections.volatileContent]
      .filter((value): value is string => Boolean(value))
      .join('\n');

    return [
      combined || null,
      sections.stableCount + sections.volatileCount,
      sections.filteredCount,
    ];
  }

  private buildFactSectionsFromDb(
    agentId: string,
    sessionKey: string,
    db: DatabaseSync | null,
  ): {
    stableContent: string | null;
    stableCount: number;
    volatileContent: string | null;
    volatileCount: number;
    filteredCount: number;
  } | null {
    if (!db) return null;

    const tableExists = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='facts'"
    ).get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) return null;

    const rawRows = db.prepare(`
      SELECT content, domain, confidence, agent_id, source_session_key AS session_key, scope FROM facts
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      AND decay_score < 0.8
      AND confidence >= 0.5
      ORDER BY confidence DESC, decay_score ASC
      LIMIT ?
    `).all(agentId, this.config.maxFacts) as Array<{
      content: string;
      domain: string | null;
      confidence: number;
      agent_id: string | null;
      session_key: string | null;
      scope: string | null;
    }>;

    if (rawRows.length === 0) {
      return {
        stableContent: null,
        stableCount: 0,
        volatileContent: null,
        volatileCount: 0,
        filteredCount: 0,
      };
    }

    const ctx = { agentId, sessionKey };
    const { allowed, filteredCount } = filterByScope(
      rawRows.map(r => ({
        ...r,
        agentId: r.agent_id,
        sessionKey: r.session_key,
      })),
      ctx,
    );

    if (allowed.length === 0) {
      return {
        stableContent: null,
        stableCount: 0,
        volatileContent: null,
        volatileCount: 0,
        filteredCount,
      };
    }

    const formatRows = (rows: typeof allowed): string | null => {
      if (rows.length === 0) return null;
      return rows
        .map(r => {
          const fromOtherSession = r.sessionKey && r.sessionKey !== sessionKey;
          const sessionSuffix = fromOtherSession
            ? `, session:${r.sessionKey!.slice(-8)}`
            : '';
          return `- [${r.domain || 'general'}${sessionSuffix}] ${r.content}`;
        })
        .join('\n');
    };

    const stableRows = allowed.filter(r =>
      r.scope !== 'session' && (!r.sessionKey || r.sessionKey !== sessionKey)
    );
    const volatileRows = allowed.filter(r => !stableRows.includes(r));

    return {
      stableContent: formatRows(stableRows),
      stableCount: stableRows.length,
      volatileContent: formatRows(volatileRows),
      volatileCount: volatileRows.length,
      filteredCount,
    };
  }

  /**
   * Build knowledge content from library DB.
   * Prioritizes high-confidence, non-superseded entries.
   */
  private buildKnowledgeFromDb(agentId: string, db: DatabaseSync): string | null {
    const tableExists = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='knowledge'"
    ).get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) return null;

    const rows = db.prepare(`
      SELECT domain, key, content, confidence FROM knowledge
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 15
    `).all(agentId) as Array<{
      domain: string;
      key: string;
      content: string;
      confidence: number;
    }>;

    if (rows.length === 0) return null;

    // Group by domain for cleaner presentation
    const byDomain: Record<string, Array<{ key: string; content: string }>> = {};
    for (const row of rows) {
      if (!byDomain[row.domain]) byDomain[row.domain] = [];
      byDomain[row.domain].push({ key: row.key, content: row.content });
    }

    const lines: string[] = [];
    for (const [domain, entries] of Object.entries(byDomain)) {
      lines.push(`### ${domain}`);
      for (const entry of entries) {
        lines.push(`- **${entry.key}:** ${entry.content}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build wiki page context for the active topic.
   * Queries the knowledge table for a synthesized topic page and returns it
   * wrapped with a header. Capped at 600 tokens.
   */
  private buildWikiPageContext(agentId: string, topicName: string, db: DatabaseSync): string | null {
    const knowledgeStore = new KnowledgeStore(db);
    const knowledge = knowledgeStore.get(agentId, 'topic-synthesis', topicName);
    if (!knowledge) return null;

    const wrapped = `## Active Topic: ${topicName}\n${knowledge.content}`;
    return this.truncateToTokens(wrapped, 600);
  }

  /**
   * Build preferences content from library DB.
   * Shows user/operator preferences relevant to this agent.
   */
  private buildPreferencesFromDb(agentId: string, db: DatabaseSync): string | null {
    const tableExists = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='preferences'"
    ).get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) return null;

    // Get preferences set by this agent or marked fleet-visible
    const rows = db.prepare(`
      SELECT subject, key, value, domain, confidence FROM preferences
      WHERE (agent_id = ? OR agent_id IS NULL)
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 10
    `).all(agentId) as Array<{
      subject: string;
      key: string;
      value: string;
      domain: string | null;
      confidence: number;
    }>;

    if (rows.length === 0) return null;

    // Group by subject
    const bySubject: Record<string, Array<{ key: string; value: string; domain: string | null }>> = {};
    for (const row of rows) {
      if (!bySubject[row.subject]) bySubject[row.subject] = [];
      bySubject[row.subject].push({ key: row.key, value: row.value, domain: row.domain });
    }

    const lines: string[] = [];
    for (const [subject, prefs] of Object.entries(bySubject)) {
      lines.push(`### ${subject}`);
      for (const pref of prefs) {
        const domainTag = pref.domain ? ` [${pref.domain}]` : '';
        lines.push(`- **${pref.key}:**${domainTag} ${pref.value}`);
      }
    }

    return lines.join('\n');
  }

  // ─── L3 Hybrid Retrieval (FTS5 + KNN) ───────────────────────

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
  private async buildSemanticRecall(
    userMessage: string,
    agentId: string,
    maxTokens: number,
    libraryDb?: DatabaseSync,
    precomputedEmbedding?: Float32Array,
    existingFingerprints?: Set<string>,  // C2: skip results already in Active Facts
    onRerankerTelemetry?: (ev: RerankerTelemetry) => void,  // Sprint 1: surface reranker status at assemble level
    resultLimit?: number,  // 0.9.0: lifecycle-scaled candidate limit for hybrid + KNN-only fallback
  ): Promise<string | null> {
    const libDb = libraryDb || this.libraryDb;
    if (!libDb && !this.vectorStore) return null;

    // 0.9.0: clamp the lifecycle-scaled candidate limit. Caller already clamps
    // via scaleRecallBreadth; this is a defensive floor so direct callers (none
    // outside compose today) cannot accidentally request 0 results.
    const hybridLimit = Math.max(
      RECALL_BREADTH_BASE.candidateLimitMin,
      Math.min(
        RECALL_BREADTH_BASE.candidateLimitMax,
        Math.floor(resultLimit && resultLimit > 0 ? resultLimit : RECALL_BREADTH_BASE.candidateLimit),
      ),
    );
    // KNN-only legacy fallback historically used 8 — keep it slightly below the
    // hybrid limit to preserve prior behavior at multiplier=1, while still
    // scaling with the same adaptive limit.
    const knnFallbackLimit = Math.max(
      RECALL_BREADTH_BASE.candidateLimitMin,
      Math.min(RECALL_BREADTH_BASE.candidateLimitMax, hybridLimit - 2),
    );

    // Inline fingerprint helper (mirrors compose-scope version; C2 dedup only used here)
    const fpCheck = existingFingerprints
      ? (text: string) => existingFingerprints.has(text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120))
      : () => false;

    // Use hybrid search when library DB is available
    if (libDb) {
      const results = await hybridSearch(libDb, this.vectorStore, userMessage, {
        tables: ['facts', 'knowledge', 'episodes'],
        limit: hybridLimit,
        agentId,
        maxKnnDistance: 1.2,
        precomputedEmbedding,
        reranker: this.reranker,
        rerankerMinCandidates: this.rerankerMinCandidates,
        rerankerMaxDocuments: this.rerankerMaxDocuments,
        rerankerTopK: this.rerankerTopK,
        // Sprint 1: thread reranker telemetry into compose diagnostics
        onRerankerTelemetry,
      });

      if (results.length === 0) return null;

      const lines: string[] = [];
      let tokens = 0;

      // TUNE-015: apply recency decay to recall scores.
      // Messages and episodes from distant past score down even if semantically relevant.
      // A 5-day-old task-request should not compete equally with today's messages.
      //   - Episodes: exponential decay, half-life 7 days
      //   - Facts/knowledge: step-function penalty for items older than 48h
      //     (prevents completed/stale tasks from outranking recent ones)
      //       48-72h: multiply by 0.7
      //       >72h:   multiply by 0.5
      const now = Date.now();
      const decayedResults = results.map(result => {
        if (!result.createdAt) return result;
        const ageMs = now - new Date(result.createdAt).getTime();
        const ageDays = ageMs / 86_400_000;
        if (result.sourceTable === 'episodes') {
          // Exponential half-life decay for episodes
          const decayFactor = Math.pow(0.5, ageDays / 7);
          return { ...result, score: result.score * decayFactor };
        }
        // Step-function recency penalty for facts and knowledge
        const ageHours = ageMs / 3_600_000;
        if (ageHours > 72) {
          return { ...result, score: result.score * 0.5 };
        }
        if (ageHours > 48) {
          return { ...result, score: result.score * 0.7 };
        }
        return result;
      });
      // Re-sort after decay adjustment
      decayedResults.sort((a, b) => b.score - a.score);

      for (const result of decayedResults) {
        // TUNE-001: drop very-low-relevance results (RRF scores below 0.008 are noise)
        if (result.score < 0.008) continue;
        // TUNE-016: FTS-only results require higher floor — low-score FTS hits are noise
        if (result.sources.length === 1 && result.sources[0] === 'fts' && result.score < 0.05) continue;
        // TUNE-014: episodes require higher confidence — score:2 episodes bleed adjacent
        // session context and contaminate current session. Require fts+knn agreement
        // (score >= 0.04) for episodes to make it into assembled context.
        if (result.sourceTable === 'episodes' && result.score < 0.04) continue;
        // C2: Skip results whose content is already fingerprinted (e.g. in Active Facts)
        // Dedup count is not tracked separately here — compose-level counter covers the other paths.
        if (fpCheck(result.content)) continue;
        const label = this.formatHybridResult(result);
        const lineTokens = estimateTokens(label);
        if (tokens + lineTokens > maxTokens) break;
        lines.push(label);
        tokens += lineTokens;
      }

      return lines.length > 0 ? lines.join('\n') : null;
    }

    // Fallback: KNN-only when no library DB (legacy path)
    if (!this.vectorStore) return null;

    const results = await this.vectorStore.search(userMessage, {
      tables: ['facts', 'knowledge', 'episodes'],
      limit: knnFallbackLimit,
      maxDistance: 1.2,
      precomputedEmbedding,
    });

    if (results.length === 0) return null;

    const lines: string[] = [];
    let tokens = 0;

    for (const result of results) {
      const label = this.formatVectorResult(result);
      const lineTokens = estimateTokens(label);
      if (tokens + lineTokens > maxTokens) break;
      lines.push(label);
      tokens += lineTokens;
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * Format a hybrid search result for injection into context.
   * Shows retrieval source(s) and relevance score.
   */
  private formatHybridResult(result: HybridSearchResult): string {
    const type = result.sourceTable;
    const sourceTag = result.sources.length === 2 ? 'fts+knn' : result.sources[0];
    const scoreStr = (result.score * 100).toFixed(0);

    switch (type) {
      case 'facts':
        return `- [fact, ${sourceTag}, score:${scoreStr}] ${result.content}`;
      case 'knowledge':
        return `- [knowledge/${result.metadata || 'general'}, ${sourceTag}, score:${scoreStr}] ${result.content}`;
      case 'episodes':
        return `- [episode/${result.domain || 'event'}, ${sourceTag}, score:${scoreStr}] ${result.content}`;
      default:
        return `- [${type}, ${sourceTag}, score:${scoreStr}] ${result.content}`;
    }
  }

  /**
   * Format a vector-only search result (legacy fallback).
   */
  private formatVectorResult(result: VectorSearchResult): string {
    const relevance = Math.max(0, Math.round((1 - result.distance) * 100));
    const type = result.sourceTable;

    switch (type) {
      case 'facts':
        return `- [fact, ${relevance}% relevant] ${result.content}`;
      case 'knowledge':
        return `- [knowledge/${result.metadata || 'general'}, ${relevance}% relevant] ${result.content}`;
      case 'episodes':
        return `- [episode/${result.domain || 'event'}, ${relevance}% relevant] ${result.content}`;
      default:
        return `- [${type}, ${relevance}% relevant] ${result.content}`;
    }
  }

  // ─── L2 Cross-Session Context ────────────────────────────────

  /**
   * Build cross-session context by finding recent activity
   * in other sessions for this agent.
   */
  // TODO Phase 1: buildCrossSessionContext queries OTHER conversations. Each has its
  // own compaction fence. Per-conversation fence filtering should be added here so
  // zombie messages from other sessions don't leak into cross-session context.
  private buildCrossSessionContext(
    agentId: string,
    currentSessionKey: string,
    db: DatabaseSync,
    _libraryDb?: DatabaseSync | null,
    existingFingerprints?: Set<string>  // C3: skip entries already in facts/semantic recall
  ): string | null {
    const conversation = db.prepare(
      'SELECT id FROM conversations WHERE session_key = ?'
    ).get(currentSessionKey) as { id: number } | undefined;

    if (!conversation) return null;

    const rows = db.prepare(`
      SELECT m.text_content, m.role, c.channel_type, m.created_at
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.agent_id = ?
      AND m.conversation_id != ?
      AND c.status = 'active'
      AND m.text_content IS NOT NULL
      AND m.is_heartbeat = 0
      ORDER BY m.created_at DESC
      LIMIT 10
    `).all(
      agentId,
      conversation.id
    ) as Array<{
      text_content: string;
      role: string;
      channel_type: string;
      created_at: string;
    }>;

    if (rows.length === 0) return null;

    const fpCheck = existingFingerprints
      ? (text: string) => existingFingerprints.has(text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120))
      : () => false;

    const lines: string[] = [];
    for (const r of rows) {
      // C3: Skip cross-session entries whose content fingerprint already appears in context
      if (fpCheck(r.text_content)) continue;
      const preview = r.text_content.substring(0, 200);
      lines.push(`- [${r.channel_type}/${r.role} @ ${r.created_at}] ${preview}`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  // ─── Utilities ───────────────────────────────────────────────

  /**
   * Extract the last user message text from the composed messages.
   */
  private getLastUserMessage(messages: NeutralMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].textContent) {
        return messages[i].textContent;
      }
    }
    return null;
  }

  /**
   * Truncate text to approximately fit within a token budget.
   * Truncates at line boundaries when possible.
   */
  private truncateToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4; // inverse of our estimation

    if (text.length <= maxChars) return text;

    // Try to truncate at a line boundary
    const truncated = text.substring(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');

    if (lastNewline > maxChars * 0.7) {
      return truncated.substring(0, lastNewline) + '\n…';
    }

    return truncated + '…';
  }

  // ─── Keystone History Builder ─────────────────────────────────────

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
  private async buildKeystones(
    db: DatabaseSync,
    agentId: string,
    includedHistory: NeutralMessage[],
    historyTokens: number,
    keystoneFraction: number,
    keystoneMaxMsgs: number,
    prompt?: string,
    libraryDb?: DatabaseSync,
    fenceMessageId?: number,
    activeContext?: Context | null
  ): Promise<{
    keystoneMessages: NeutralMessage[];
    keystoneTokens: number;
    trimmedHistory: NeutralMessage[];
    trimmedHistoryTokens: number;
  } | null> {
    const keystoneBudget = Math.floor(historyTokens * keystoneFraction);
    if (keystoneBudget <= 0) return null;

    // Trim oldest messages from includedHistory to free keystone budget.
    const trimmedHistory = [...includedHistory];
    let trimmedHistoryTokens = historyTokens;
    let freed = 0;
    while (trimmedHistory.length > 1 && freed < keystoneBudget) {
      const oldest = trimmedHistory.shift()!;
      const oldestTokens = estimateMessageTokens(oldest);
      freed += oldestTokens;
      trimmedHistoryTokens -= oldestTokens;
    }

    // Find the oldest message ID in the trimmed recent window (cutoff point).
    const oldestRecentMsg = trimmedHistory[0] as StoredMessage;
    const cutoffId = (oldestRecentMsg as StoredMessage)?.id ?? null;
    if (cutoffId == null) return null;

    // Find the current user prompt for FTS matching.
    const promptForFts = prompt?.trim() ||
      (() => {
        for (let i = trimmedHistory.length - 1; i >= 0; i--) {
          if (trimmedHistory[i].role === 'user' && trimmedHistory[i].textContent) {
            return trimmedHistory[i].textContent!;
          }
        }
        return null;
      })();

    try {
      // Get the conversation ID from the oldest recent message.
      const convRow = db.prepare(
        'SELECT conversation_id FROM messages WHERE id = ?'
      ).get(cutoffId) as { conversation_id: number } | undefined;

      if (!convRow) return null;

      const conversationId = convRow.conversation_id;
      const maxAgeHours = 168; // 7 days — tighter window gives recency real scoring weight
      const nowMs = Date.now();

      // Build episode significance map from libraryDb (episodes live there, not in messages.db).
      // Key: source_message_id, Value: max significance for that message.
      const sigMap = new Map<number, number>();
      if (libraryDb) {
        try {
          const episodeRows = libraryDb.prepare(`
            SELECT source_message_id, MAX(significance) AS significance
            FROM episodes
            WHERE agent_id = ? AND source_message_id IS NOT NULL
            GROUP BY source_message_id
          `).all(agentId) as Array<{ source_message_id: number; significance: number }>;
          for (const row of episodeRows) {
            sigMap.set(row.source_message_id, row.significance);
          }
        } catch {
          // Episodes query is best-effort
        }
      }

      type CandidateRow = {
        id: number;
        message_index: number;
        role: string;
        text_content: string | null;
        created_at: string;
      };

      const fenceClause = fenceMessageId != null ? 'AND m.id >= ?' : '';
      // Phase 3 (Turn DAG): prefer context_id scoping, but keep legacy NULL
      // rows eligible. Warmed or migrated sessions can have an active context
      // while older messages predate context_id backfill; excluding NULL rows
      // disables within-session keystone recall for those conversations.
      const contextClause = activeContext ? 'AND (m.context_id = ? OR m.context_id IS NULL)' : '';
      const baseParams: (string | number | null)[] = [conversationId, cutoffId];
      if (fenceMessageId != null) baseParams.push(fenceMessageId);
      if (activeContext) baseParams.push(activeContext.id);

      const baseQuery = `
        SELECT
          m.id,
          m.message_index,
          m.role,
          m.text_content,
          m.created_at
        FROM messages m
        WHERE m.conversation_id = ?
          AND m.id < ?
          ${fenceClause}
          ${contextClause}
          AND m.text_content IS NOT NULL
          AND m.is_heartbeat = 0
          AND m.text_content != ''
        LIMIT 200
      `;

      let candidateRows: CandidateRow[];

      if (promptForFts && promptForFts.length >= 3) {
        // Build a safe FTS5 query: extract words ≥3 chars, up to 8, OR with prefix.
        const ftsTerms = (promptForFts.match(/\b\w{3,}\b/g) || [])
          .slice(0, 8)
          .map(w => `"${w.replace(/"/g, '')}"*`)
          .join(' OR ');

        if (ftsTerms) {
          try {
            const ftsParams: (string | number | null)[] = [conversationId, cutoffId];
            if (fenceMessageId != null) ftsParams.push(fenceMessageId);
            if (activeContext) ftsParams.push(activeContext.id);
            ftsParams.push(ftsTerms);
            candidateRows = db.prepare(`
              SELECT
                m.id,
                m.message_index,
                m.role,
                m.text_content,
                m.created_at
              FROM messages m
              WHERE m.conversation_id = ?
                AND m.id < ?
                ${fenceClause}
                ${contextClause}
                AND m.text_content IS NOT NULL
                AND m.is_heartbeat = 0
                AND m.text_content != ''
                AND m.id IN (
                  SELECT rowid FROM messages_fts
                  WHERE messages_fts MATCH ?
                  LIMIT 100
                )
              LIMIT 200
            `).all(...ftsParams) as CandidateRow[];
          } catch {
            // FTS query may fail on special characters — fall back to base query
            candidateRows = db.prepare(baseQuery).all(...baseParams) as CandidateRow[];
          }
        } else {
          candidateRows = db.prepare(baseQuery).all(...baseParams) as CandidateRow[];
        }
      } else {
        candidateRows = db.prepare(baseQuery).all(...baseParams) as CandidateRow[];
      }

      if (candidateRows.length === 0) return null;

      // Build KeystoneCandidate objects with computed ftsRank and ageHours.
      const totalCandidates = candidateRows.length;
      const candidates: KeystoneCandidate[] = candidateRows.map((row, idx) => {
        const createdMs = new Date(row.created_at).getTime();
        const ageHours = (nowMs - createdMs) / (1000 * 60 * 60);
        // Normalize FTS rank by position (best match = 1.0, worst = 0.1)
        const ftsRank = totalCandidates > 1
          ? 1.0 - (idx / totalCandidates) * 0.9
          : 1.0;

        return {
          messageId: row.id,
          messageIndex: row.message_index,
          role: row.role,
          content: row.text_content || '',
          timestamp: row.created_at,
          episodeSignificance: sigMap.get(row.id) ?? null,
          ftsRank,
          ageHours,
        };
      });

      // Score and rank candidates.
      const ranked = rankKeystones(candidates, maxAgeHours);

      // Budget-fit: take top-scored candidates until keystoneBudget exhausted.
      let kTokens = 0;
      const selectedKeystones: KeystoneCandidate[] = [];

      for (const candidate of ranked) {
        if (selectedKeystones.length >= keystoneMaxMsgs) break;
        const msg: NeutralMessage = {
          role: candidate.role as NeutralMessage['role'],
          textContent: candidate.content,
          toolCalls: null,
          toolResults: null,
        };
        const msgTokens = estimateMessageTokens(msg);
        if (kTokens + msgTokens > keystoneBudget) continue; // skip oversized; keep trying
        selectedKeystones.push(candidate);
        kTokens += msgTokens;
      }

      if (selectedKeystones.length === 0) return null;

      // Sort selected keystones chronologically for injection.
      selectedKeystones.sort((a, b) => a.messageIndex - b.messageIndex);

      const keystoneMessages: NeutralMessage[] = selectedKeystones.map(c => ({
        role: c.role as NeutralMessage['role'],
        textContent: c.content,
        toolCalls: null,
        toolResults: null,
      }));

      return {
        keystoneMessages,
        keystoneTokens: kTokens,
        trimmedHistory,
        trimmedHistoryTokens,
      };
    } catch {
      // Keystone injection is best-effort — never fail compose
      return null;
    }
  }

  // ─── Cross-Topic Keystone Retrieval (P3.5) ───────────────────────

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
  private async getKeystonesByTopic(
    agentId: string,
    sessionKey: string,
    activeTopic: { id: string; name: string },
    currentMessages: NeutralMessage[],
    db: DatabaseSync,
    maxKeystones: number = 3,
    fenceMessageId?: number,
    activeContext?: Context | null
  ): Promise<ScoredKeystone[]> {
    // Fetch all topics for this session except the active one (max 5, most recent first)
    type TopicRow = { id: string; name: string };
    const otherTopics = db.prepare(`
      SELECT id, name
      FROM topics
      WHERE session_key = ? AND id != ?
      ORDER BY last_active_at DESC
      LIMIT 5
    `).all(sessionKey, activeTopic.id) as TopicRow[];

    if (otherTopics.length === 0) return [];

    // Extract key terms from active topic name + last 3 user messages
    const queryTerms = this.extractQueryTerms(activeTopic.name, currentMessages);
    if (queryTerms.size === 0) return [];

    const nowMs = Date.now();
    const maxAgeHours = 168; // 7 days, same as within-session keystones
    const seenIds = new Set<number>();
    const allCandidates: ScoredKeystone[] = [];

    for (const topic of otherTopics) {
      // Fetch a bounded pool, then select the topic's top keystones before
      // semantic filtering so cross-topic retrieval competes on the same scale.
      type MsgRow = {
        id: number;
        message_index: number;
        role: string;
        text_content: string;
        created_at: string;
      };

      let topicMessages: MsgRow[];
      try {
        const topicFenceClause = fenceMessageId != null ? 'AND m.id >= ?' : '';
        // Phase 3 (Turn DAG): constrain cross-topic queries to active context_id
        const topicContextClause = activeContext ? 'AND m.context_id = ?' : '';
        const topicParams: (string | number | null)[] = [sessionKey, agentId, topic.id];
        if (fenceMessageId != null) topicParams.push(fenceMessageId);
        if (activeContext) topicParams.push(activeContext.id);
        topicMessages = db.prepare(`
          SELECT m.id, m.message_index, m.role, m.text_content, m.created_at
          FROM messages m
          JOIN conversations c ON m.conversation_id = c.id
          WHERE c.session_key = ?
            AND c.agent_id = ?
            AND m.topic_id = ?
            ${topicFenceClause}
            ${topicContextClause}
            AND m.text_content IS NOT NULL
            AND m.text_content != ''
            AND m.is_heartbeat = 0
          ORDER BY m.message_index DESC
          LIMIT 50
        `).all(...topicParams) as MsgRow[];
      } catch {
        // Corrupt topic data — skip this topic, never throw
        continue;
      }

      if (topicMessages.length === 0) continue;

      const topicCandidates: KeystoneCandidate[] = topicMessages.map((msg, idx) => {
        const createdMs = new Date(msg.created_at).getTime();
        const ageHours = (nowMs - createdMs) / (1000 * 60 * 60);
        const ftsRank = topicMessages.length > 1
          ? 1.0 - (idx / topicMessages.length) * 0.9
          : 1.0;

        return {
          messageId: msg.id,
          messageIndex: msg.message_index,
          role: msg.role,
          content: msg.text_content,
          timestamp: msg.created_at,
          episodeSignificance: null,
          ftsRank,
          ageHours,
        };
      });

      const topTopicKeystones = rankKeystones(topicCandidates, maxAgeHours).slice(0, 10);

      // Filter to messages with semantic overlap (≥2 matching terms)
      const relevant = topTopicKeystones.filter(candidate => {
        const contentLower = candidate.content.toLowerCase();
        let matches = 0;
        for (const term of queryTerms) {
          if (contentLower.includes(term)) {
            matches++;
            if (matches >= 2) return true;
          }
        }
        return false;
      });

      if (relevant.length === 0) continue;

      // Re-score filtered candidates so they compete on the same final scale
      for (const candidate of relevant) {
        if (seenIds.has(candidate.messageId)) continue;
        seenIds.add(candidate.messageId);

        const score = scoreKeystone(candidate, maxAgeHours);
        allCandidates.push({ ...candidate, score });
      }
    }

    if (allCandidates.length === 0) return [];

    // Sort by score DESC and return top maxKeystones
    return allCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, maxKeystones);
  }

  /**
   * Extract lowercase key terms from a topic name and the last 3 user messages.
   * Terms are: tokens with ≥4 characters (skip short stop words).
   * Returns a Set for O(1) lookup.
   */
  private extractQueryTerms(
    topicName: string,
    messages: NeutralMessage[]
  ): Set<string> {
    const terms = new Set<string>();
    const MIN_TERM_LEN = 4;

    // From topic name
    const topicTokens = topicName.toLowerCase().match(/\b[a-z0-9]{4,}\b/g) ?? [];
    for (const t of topicTokens) terms.add(t);

    // From last 3 user messages
    let userCount = 0;
    for (let i = messages.length - 1; i >= 0 && userCount < 3; i--) {
      const msg = messages[i];
      if (msg.role === 'user' && msg.textContent) {
        const tokens = msg.textContent.toLowerCase().match(/\b[a-z0-9]{4,}\b/g) ?? [];
        for (const t of tokens) {
          if (t.length >= MIN_TERM_LEN) terms.add(t);
        }
        userCount++;
      }
    }

    return terms;
  }
}
