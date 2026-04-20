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

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { buildPluginConfigSchema } from 'openclaw/plugin-sdk/core';
import { z } from 'zod';
import type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineMaintenanceResult,
  IngestBatchResult,
  SubagentSpawnPreparation,
  SubagentEndReason,
} from 'openclaw/plugin-sdk';
import type {
  NeutralMessage,
  NeutralToolCall,
  NeutralToolResult,
  ComposeRequest,
  ComposeResult,
  HyperMem as HyperMemClass,
  BackgroundIndexer,
  FleetStore,
} from '@psiclawops/hypermem';
import {
  detectTopicShift,
  stripMessageMetadata,
  SessionTopicMap,
  applyToolGradientToWindow,
  OPENCLAW_BOOTSTRAP_FILES,
  rotateSessionContext,
  TRIM_SOFT_TARGET,
  TRIM_GROWTH_THRESHOLD,
  TRIM_HEADROOM_FRACTION,
  resolveTrimBudgets,
  formatToolChainStub,
  decideReplayRecovery,
  isReplayState,
} from '@psiclawops/hypermem';
import { evictStaleContent } from '@psiclawops/hypermem/image-eviction';
import { repairToolPairs } from '@psiclawops/hypermem';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import fsSync from 'fs';

// Re-export core types for consumers (eliminates local shim drift)
export type { NeutralMessage, NeutralToolCall, NeutralToolResult, ComposeRequest, ComposeResult };

// ─── Telemetry (Phase A Sprint 1) ─────────────────────────────────────
//
// Structured logging around every trimHistoryToTokenBudget() call site and
// every assemble() entry. Zero-cost when HYPERMEM_TELEMETRY !== '1'. When on,
// appends JSONL to process.env.HYPERMEM_TELEMETRY_PATH (default
// './hypermem-telemetry.jsonl'). Intentionally NOT using console.log so the
// telemetry stream does not mingle with plugin diagnostic output.
//
// Telemetry is behavior-neutral: emit sites never throw, never block the hot
// path, and the flag check is a plain env read (no allocations when off).
type TrimTelemetryPath =
  | 'assemble.normal'
  | 'assemble.toolLoop'
  | 'assemble.subagent'
  | 'reshape'
  | 'compact.nuclear'
  | 'compact.history'
  | 'compact.history2'
  | 'afterTurn.secondary'
  | 'warmstart';

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

let _telemetryStream: fsSync.WriteStream | null = null;
let _telemetryStreamFailed = false;
let _telemetryTurnCounter = 0;

function telemetryEnabled(): boolean {
  return process.env.HYPERMEM_TELEMETRY === '1';
}

function getTelemetryStream(): fsSync.WriteStream | null {
  if (_telemetryStream || _telemetryStreamFailed) return _telemetryStream;
  try {
    const p = process.env.HYPERMEM_TELEMETRY_PATH || './hypermem-telemetry.jsonl';
    _telemetryStream = fsSync.createWriteStream(p, { flags: 'a' });
    _telemetryStream.on('error', () => {
      _telemetryStreamFailed = true;
      _telemetryStream = null;
    });
  } catch {
    _telemetryStreamFailed = true;
    _telemetryStream = null;
  }
  return _telemetryStream;
}

function trimTelemetry(fields: {
  path: TrimTelemetryPath;
  agentId: string;
  sessionKey: string;
  preTokens: number;
  postTokens: number;
  removed: number;
  cacheInvalidated: boolean;
  reason: string;
}): void {
  if (!telemetryEnabled()) return;
  const stream = getTelemetryStream();
  if (!stream) return;
  try {
    const record = {
      event: 'trim',
      ts: new Date().toISOString(),
      ...fields,
    };
    stream.write(JSON.stringify(record) + '\n');
  } catch {
    // Telemetry must never throw
  }
}

function assembleTrace(fields: {
  agentId: string;
  sessionKey: string;
  turnId: string;
  path: 'cold' | 'replay' | 'subagent';
  toolLoop: boolean;
  msgCount: number;
}): void {
  if (!telemetryEnabled()) return;
  const stream = getTelemetryStream();
  if (!stream) return;
  try {
    const record = {
      event: 'assemble',
      ts: new Date().toISOString(),
      ...fields,
    };
    stream.write(JSON.stringify(record) + '\n');
  } catch {
    // Telemetry must never throw
  }
}

function degradationTelemetry(fields: DegradationTelemetryFields): void {
  if (!telemetryEnabled()) return;
  const stream = getTelemetryStream();
  if (!stream) return;
  try {
    const record = {
      event: 'degradation',
      ts: new Date().toISOString(),
      ...fields,
    };
    stream.write(JSON.stringify(record) + '\n');
  } catch {
    // Telemetry must never throw
  }
}

function nextTurnId(): string {
  _telemetryTurnCounter = (_telemetryTurnCounter + 1) >>> 0;
  return `${Date.now().toString(36)}-${_telemetryTurnCounter.toString(36)}`;
}

// ─── Trim Ownership (Phase A Sprint 2) ───────────────────────────
//
// Sprint 2 consolidates trim ownership: the assemble-owned family
// (assemble.normal, assemble.subagent, assemble.toolLoop) is the single
// steady-state trim owner. Compact paths (compact.nuclear, compact.history,
// compact.history2) are exempted — they're exception-only. warmstart,
// reshape, and afterTurn.secondary are demoted in sub-tasks 2.2 and 2.3.
//
// This block adds:
//   1. A per-session turn context (beginTrimOwnerTurn/endTrimOwnerTurn) scoped
//      by the main assemble() flow.
//   2. A single shared trimOwner claim helper that lets exactly one **real**
//      steady-state trim claim ownership per turn and throws loudly in
//      development (NODE_ENV='development') when a second real steady-state
//      trim path attempts to claim the same turn.
//   3. A non-counting guard/noop telemetry helper (same JSONL channel) that
//      demoted paths can emit to preserve visibility of warm-start/reshape
//      without consuming a steady-state owner slot.
//
// Sub-task 2.1 only adds the scaffolding + invariant; no existing trim call
// is removed here. Demotions of warm-start/reshape/afterTurn.secondary land
// in 2.2 and 2.3.

const STEADY_STATE_TRIM_PATHS = new Set<TrimTelemetryPath>([
  'assemble.normal',
  'assemble.subagent',
  'assemble.toolLoop',
]);

const COMPACT_TRIM_PATHS = new Set<TrimTelemetryPath>([
  'compact.nuclear',
  'compact.history',
  'compact.history2',
]);

// ─── Guard-telemetry reason enum (Phase A Sprint 2.2a) ──────────────────
// Plugin-local, constant-backed union of allowed `reason` values on
// `event: 'trim-guard'` records. Keeping this bounded prevents ad-hoc
// numeric/user strings from leaking into the telemetry JSONL channel and
// makes downstream reporting stable. Do NOT widen this to arbitrary
// strings — add a new member here first, then reference it at call sites.
//
// Scope note: this union is plugin-local (per planner 2.2 §C). It is not
// re-exported via `src/types.ts` because the shared public types surface
// must not gain a telemetry-reason enum as part of this sprint.
const GUARD_TELEMETRY_REASONS = [
  'warmstart-pressure-demoted',
  'reshape-downshift-demoted',
  'duplicate-claim-suppressed',
  'afterturn-secondary-demoted',
  'window-within-budget-skip',
  'pressure-accounting-anomaly',
] as const;
type GuardTelemetryReason = typeof GUARD_TELEMETRY_REASONS[number];

interface TrimOwnerTurnContext {
  turnId: string;
  claimedPath?: TrimTelemetryPath;
}

// Turn-scoped ownership map (Phase A Sprint 2.2a).
//
// Previously keyed by `sessionKey` alone, which clobbered overlapping same-
// session assemble() flows (Sprint 2.1 security eval, medium finding #1).
// Now keyed by the composite `sessionKey|turnId` so two concurrent turns on
// the same session key remain isolated: each `beginTrimOwnerTurn` gets its
// own slot, `claimTrimOwner` checks the exact turn's slot, and
// `endTrimOwnerTurn` removes only that turn's slot.
const _trimOwnerTurns = new Map<string, TrimOwnerTurnContext>();

function _trimOwnerKey(sessionKey: string, turnId: string): string {
  return `${sessionKey}|${turnId}`;
}

function beginTrimOwnerTurn(sessionKey: string, turnId: string): void {
  _trimOwnerTurns.set(_trimOwnerKey(sessionKey, turnId), { turnId });
}

function endTrimOwnerTurn(sessionKey: string, turnId: string): void {
  _trimOwnerTurns.delete(_trimOwnerKey(sessionKey, turnId));
}

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
function claimTrimOwner(sessionKey: string, turnId: string, path: TrimTelemetryPath): boolean {
  // Compact paths: exempt — they represent an exceptional pressure path and
  // never contend for the steady-state slot.
  if (COMPACT_TRIM_PATHS.has(path)) return true;
  // Non-steady paths: pass through (warmstart/reshape/afterTurn.secondary).
  // Warmstart + reshape are demoted to guardTelemetry in 2.2a.
  if (!STEADY_STATE_TRIM_PATHS.has(path)) return true;
  const ctx = _trimOwnerTurns.get(_trimOwnerKey(sessionKey, turnId));
  if (!ctx) return true; // No active assemble-turn scope — nothing to enforce here.
  if (ctx.claimedPath) {
    const msg =
      `[hypermem-plugin] trimOwner: duplicate steady-state trim claim in turn ` +
      `${ctx.turnId} (sessionKey=${sessionKey}): first=${ctx.claimedPath} second=${path}`;
    if (process.env.NODE_ENV === 'development') {
      throw new Error(msg);
    }
    // Non-development: do not throw, but leave a loud trail so telemetry
    // surfaces the violation. Callers MUST honor the false return and skip
    // the second real trim (Sprint 2.2a enforcement).
    console.warn(msg);
    return false;
  }
  ctx.claimedPath = path;
  return true;
}

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
function guardTelemetry(fields: {
  path: TrimTelemetryPath;
  agentId: string;
  sessionKey: string;
  reason: GuardTelemetryReason;
}): void {
  if (!telemetryEnabled()) return;
  const stream = getTelemetryStream();
  if (!stream) return;
  try {
    const record = {
      event: 'trim-guard',
      ts: new Date().toISOString(),
      ...fields,
    };
    stream.write(JSON.stringify(record) + '\n');
  } catch {
    // Telemetry must never throw
  }
}

// ─── B3: Batch trim with growth allowance ────────────────────────────────
// Trim fires only when window usage exceeds the soft target by this fraction.
// Small natural growth (e.g. a short assistant reply) never triggers a trim;
// only genuine spikes (model switch, cold-start, multi-tool overrun) do.
// When trim fires, the target is (softTarget * (1 - headroomFraction)) so the
// window has room to grow for several turns before the next trim fires.
//
// softTarget (0.65): matches refreshRedisGradient → steady state never trims
// growthThreshold (0.05): 5% overage buffer before trim fires
// headroomFraction (0.10): trim target = softTarget * 0.90 → ~58.5% of budget
// Canonical values live in the core package so plugin trim guards and compose
// paths cannot drift.

// Test-only: expose emitters so the unit test can exercise them directly
// without standing up a real session. Wrapped in a getter object so the flag
// guard still runs (zero-cost when off).
export const __telemetryForTests = {
  trimTelemetry,
  assembleTrace,
  degradationTelemetry,
  guardTelemetry,
  nextTurnId,
  beginTrimOwnerTurn,
  endTrimOwnerTurn,
  claimTrimOwner,
  // B3/C0.1: Expose the canonical policy surface so tests can assert against
  // the shared source of truth instead of embedding formulas locally.
  TRIM_SOFT_TARGET,
  TRIM_GROWTH_THRESHOLD,
  TRIM_HEADROOM_FRACTION,
  resolveTrimBudgets,
  reset(): void {
    if (_telemetryStream) {
      try { _telemetryStream.end(); } catch { /* ignore */ }
    }
    _telemetryStream = null;
    _telemetryStreamFailed = false;
    _telemetryTurnCounter = 0;
    _trimOwnerTurns.clear();
  },
};

// ─── hypermem singleton ────────────────────────────────────────

// Runtime load is dynamic (hypermem is a sibling package loaded from repo dist,
// not installed via npm). Types come from the core package devDependency.
// This pattern keeps the runtime path stable while TypeScript resolves types
// from the canonical source — no more local shim drift.
// Resolved at init time: pluginConfig.hyperMemPath > import.meta.resolve('@psiclawops/hypermem') > dev fallback
let HYPERMEM_PATH = '';

// hypermemInstance is the resolved return type of hypermem.create().
// hypermem has a private constructor (factory pattern), so we can't use
// InstanceType<> directly. Awaited<ReturnType<...>> extracts the same type
// without requiring constructor access. If core adds/changes a field, the
// plugin type-errors at CI time instead of silently drifting.
type HyperMemInstance = Awaited<ReturnType<typeof HyperMemClass.create>>;

let _hm: HyperMemInstance | null = null;
let _hmInitPromise: Promise<HyperMemInstance> | null = null;
let _indexer: BackgroundIndexer | null = null;
let _fleetStore: FleetStore | null = null;
let _generateEmbeddings: ((texts: string[]) => Promise<Float32Array[]>) | null = null;
let _embeddingConfig: {
  provider: 'ollama' | 'openai' | 'gemini';
  ollamaUrl: string;
  openaiBaseUrl: string;
  openaiApiKey?: string;
  geminiBaseUrl?: string;
  geminiIndexTaskType?: string;
  geminiQueryTaskType?: string;
  model: string;
  dimensions: number;
  timeout: number;
  batchSize: number;
} | null = null;
// P1.7: TaskFlow runtime reference — bound at registration time, best-effort.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _taskFlowRuntime: any | null = null;

// ─── Eviction config cache ────────────────────────────────────
// Populated from user config during hypermem init. Stored here so
// assemble() (which can't await loadUserConfig) can read it without
// re-reading disk on every turn.
let _evictionConfig: {
  enabled?: boolean;
  imageAgeTurns?: number;
  toolResultAgeTurns?: number;
  minTokensToEvict?: number;
  keepPreviewChars?: number;
} | undefined;

// ─── Context window reserve cache ────────────────────────────
// Populated from user config during hypermem init. Ensures hypermem leaves
// a guaranteed headroom fraction for system prompts, tool results, and
// incoming data — preventing the trim tiers from firing too close to the edge.
//
// contextWindowSize: full model context window in tokens (default: 128_000)
// contextWindowReserve: fraction [0.0–0.5] to keep free (default: 0.25)
//
// Effective history budget = (windowSize * (1 - reserve)) - overheadFallback
// e.g. 128k * 0.75 - 28k = 68k for council agents at 25% reserve
let _contextWindowSize: number = 128_000;
let _contextWindowReserve: number = 0.25;
let _deferToolPruning: boolean = false;
let _verboseLogging: boolean = false;
let _contextWindowOverrides: Record<string, { contextTokens?: number; contextWindow?: number }> = {};
const _budgetFallbackWarnings = new Set<string>();

export const CONTEXT_WINDOW_OVERRIDE_KEY_REGEX = /^[^/\s]+\/[^/\s]+$/;
export type ContextWindowOverride = { contextTokens?: number; contextWindow?: number };

const contextWindowOverrideSchema = z.object({
  contextTokens: z.number().int().positive().optional(),
  contextWindow: z.number().int().positive().optional(),
}).superRefine((value, ctx) => {
  if (value.contextTokens == null && value.contextWindow == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'override must declare contextTokens, contextWindow, or both',
    });
  }
  if (
    value.contextTokens != null &&
    value.contextWindow != null &&
    value.contextTokens > value.contextWindow
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'contextTokens must be less than or equal to contextWindow',
    });
  }
});

export function sanitizeContextWindowOverrides(raw: unknown): {
  value: Record<string, ContextWindowOverride>;
  warnings: string[];
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value: {}, warnings: [] };
  }

  const value: Record<string, ContextWindowOverride> = {};
  const warnings: string[] = [];

  for (const [key, candidate] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedKey = key.trim().toLowerCase();
    if (!CONTEXT_WINDOW_OVERRIDE_KEY_REGEX.test(normalizedKey)) {
      warnings.push(`ignoring contextWindowOverrides[${JSON.stringify(key)}]: key must be "provider/model"`);
      continue;
    }

    const parsed = contextWindowOverrideSchema.safeParse(candidate);
    if (!parsed.success) {
      warnings.push(
        `ignoring contextWindowOverrides[${JSON.stringify(key)}]: ` +
        parsed.error.issues.map(issue => issue.message).join('; ')
      );
      continue;
    }

    value[normalizedKey] = parsed.data;
  }

  return { value, warnings };
}

export function resolveEffectiveBudget(args: {
  tokenBudget?: number;
  model?: string;
  contextWindowSize: number;
  contextWindowReserve: number;
  contextWindowOverrides?: Record<string, ContextWindowOverride>;
}): { budget: number; source: string } {
  const { tokenBudget, model, contextWindowSize, contextWindowReserve } = args;
  if (tokenBudget) {
    return { budget: tokenBudget, source: 'runtime tokenBudget' };
  }

  const key = normalizeModelKey(model);
  const override = key ? args.contextWindowOverrides?.[key] : undefined;
  const configuredWindow = override?.contextTokens ?? override?.contextWindow;
  if (configuredWindow) {
    return {
      budget: Math.floor(configuredWindow * (1 - contextWindowReserve)),
      source: `contextWindowOverrides[${key}]`,
    };
  }

  return {
    budget: Math.floor(contextWindowSize * (1 - contextWindowReserve)),
    source: 'fallback contextWindowSize',
  };
}

function normalizeModelKey(model?: string): string | null {
  if (!model) return null;
  const key = model.trim().toLowerCase();
  return key.length > 0 ? key : null;
}

function verboseLog(message: string): void {
  if (_verboseLogging) console.log(message);
}

function resolveConfiguredWindow(model?: string): number | null {
  const key = normalizeModelKey(model);
  if (!key) return null;
  const override = _contextWindowOverrides[key];
  if (!override) return null;
  return override.contextTokens ?? override.contextWindow ?? null;
}
// Subagent warming mode: 'full' | 'light' | 'off'. Default: 'light'.
// Controls how much HyperMem context is injected into subagent sessions.
let _subagentWarming: 'full' | 'light' | 'off' = 'light';
// Cache replay threshold: 15min default. Set to 0 in user config to disable.
let _cacheReplayThresholdMs: number = 900_000;

// ─── System overhead cache ────────────────────────────────────
// Caches the non-history token cost (contextBlock + runtime system prompt)
// from the last full compose per session key. Used in tool-loop turns to
// return an honest estimatedTokens without re-running the full compose
// pipeline. Map key = resolved session key.
const _overheadCache = new Map<string, number>();

// Tier-aware conservative fallback when no cached value exists (cold session,
// first turn after restart). Over-estimates are safer than under-estimates:
// a false-positive compact is cheaper than letting context blow past budget.
const OVERHEAD_FALLBACK: Record<string, number> = {
  council:    28_000,
  director:   28_000,
  specialist: 18_000,
};
const OVERHEAD_FALLBACK_DEFAULT = 15_000;

function getOverheadFallback(tier?: string): number {
  if (!tier) return OVERHEAD_FALLBACK_DEFAULT;
  return OVERHEAD_FALLBACK[tier] ?? OVERHEAD_FALLBACK_DEFAULT;
}

/**
 * Compute the effective history budget for trim and compact operations.
 *
 * Priority:
 *   1. tokenBudget passed by the runtime (most precise)
 *   2. Derived from context window config: windowSize * (1 - reserve)
 *
 * The reserve fraction (default 0.25 = 25%) guarantees headroom for:
 *   - System prompt + identity blocks (~28k for council agents)
 *   - Incoming tool results (can be 10–30k in parallel web_search bursts)
 *   - Response generation buffer (~4k)
 *
 * Without the reserve, trim tiers fire at 75–85% of tokenBudget but
 * total context (history + system) exceeds the model window before trim
 * completes, causing result stripping.
 */
function computeEffectiveBudget(tokenBudget?: number, model?: string): number {
  const resolved = resolveEffectiveBudget({
    tokenBudget,
    model,
    contextWindowSize: _contextWindowSize,
    contextWindowReserve: _contextWindowReserve,
    contextWindowOverrides: _contextWindowOverrides,
  });

  if (resolved.source === 'runtime tokenBudget') {
    verboseLog(`[hypermem-plugin] budget source: runtime tokenBudget=${tokenBudget}${model ? ` model=${model}` : ''}`);
    return resolved.budget;
  }

  const configuredWindow = resolveConfiguredWindow(model);
  if (configuredWindow) {
    verboseLog(
      `[hypermem-plugin] budget source: contextWindowOverrides[${normalizeModelKey(model)}]=${configuredWindow}, ` +
      `reserve=${_contextWindowReserve}, effective=${resolved.budget}`
    );
    return resolved.budget;
  }

  verboseLog(
    `[hypermem-plugin] budget source: fallback contextWindowSize=${_contextWindowSize}, ` +
    `reserve=${_contextWindowReserve}, effective=${resolved.budget}${model ? ` model=${model}` : ''}`
  );
  const warningKey = normalizeModelKey(model) ?? '(unknown-model)';
  if (!_budgetFallbackWarnings.has(warningKey)) {
    _budgetFallbackWarnings.add(warningKey);
    console.warn(
      `[hypermem-plugin] No runtime tokenBudget${model ? ` for model ${model}` : ''}; ` +
      `falling back to contextWindowSize=${_contextWindowSize}. ` +
      `Add contextWindowOverrides["provider/model"] to config.json or openclaw.json if detection is wrong.`
    );
  }
  return resolved.budget;
}

// ─── Plugin config cache ───────────────────────────────────────
// Populated from openclaw.json plugins.entries.hypercompositor.config
// during register(). loadUserConfig() merges this over config.json.
let _pluginConfig: HypercompositorConfig = {};

/**
 * Load user config with priority: pluginConfig (openclaw.json) > config.json (legacy).
 * pluginConfig values win; config.json provides fallback for keys not set in openclaw.json.
 * This allows gradual migration from the shadow config.json to central config.
 */
async function loadUserConfig(): Promise<{
  compositor?: Partial<{
    budgetFraction: number;
    reserveFraction: number;
    historyFraction: number;
    memoryFraction: number;
    defaultTokenBudget: number;
    maxHistoryMessages: number;
    maxFacts: number;
    maxExpertisePatterns: number;
    maxCrossSessionContext: number;
    maxTotalTriggerTokens: number;
    maxRecentToolPairs: number;
    maxProseToolPairs: number;
    warmHistoryBudgetFraction: number;
    contextWindowReserve: number;
    dynamicReserveTurnHorizon: number;
    dynamicReserveMax: number;
    dynamicReserveEnabled: boolean;
    keystoneHistoryFraction: number;
    keystoneMaxMessages: number;
    keystoneMinSignificance: number;
    targetBudgetFraction: number;
    enableFOS: boolean;
    enableMOD: boolean;
    hyperformProfile: 'light' | 'standard' | 'full' | 'starter' | 'fleet';
    outputProfile: 'light' | 'standard' | 'full' | 'starter' | 'fleet';
    outputStandard: 'light' | 'standard' | 'full' | 'starter' | 'fleet';
    wikiTokenCap: number;
    zigzagOrdering: boolean;
  }>;
  eviction?: Partial<{
    /** Turns before images are evicted. Default: 2 */
    imageAgeTurns: number;
    /** Turns before large tool results are evicted. Default: 4 */
    toolResultAgeTurns: number;
    /** Minimum estimated tokens to evict a tool result. Default: 200 */
    minTokensToEvict: number;
    /** Preview characters to keep from evicted content. Default: 120 */
    keepPreviewChars: number;
    /** Set false to disable the eviction pre-pass entirely. Default: true */
    enabled: boolean;
  }>;
  /**
   * Embedding provider configuration.
   * If omitted, defaults to Ollama + nomic-embed-text (768d).
   *
   * Example (OpenAI):
   *   { "provider": "openai", "openaiApiKey": "sk-...", "model": "text-embedding-3-small", "dimensions": 1536, "batchSize": 128 }
   *
   * Example (Gemini):
   *   { "provider": "gemini", "model": "gemini-embedding-001", "dimensions": 3072, "batchSize": 100 }
   *
   * WARNING: switching providers requires a full re-index. Existing vectors use
   * different dimensions and are incompatible with the new provider's output.
   */
  embedding?: {
    provider?: 'ollama' | 'openai' | 'gemini';
    ollamaUrl?: string;
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    geminiBaseUrl?: string;
    geminiIndexTaskType?: string;
    geminiQueryTaskType?: string;
    model?: string;
    dimensions?: number;
    timeout?: number;
    batchSize?: number;
  };
  /**
   * Full model context window size in tokens. Default: 128_000.
   * Used with contextWindowReserve to derive effective history budget.
   */
  contextWindowSize?: number;
  /**
   * Fraction [0.0–0.5] of the context window to reserve for system prompts,
   * incoming tool results, and operational headroom. Default: 0.25 (25%).
   * Higher values = earlier trims, more headroom for large operations.
   */
  contextWindowReserve?: number;
  /**
   * When true, skip HyperMem's tool gradient — defer tool result pruning
   * to OpenClaw's built-in contextPruning system (cache-ttl mode).
   * Set this when agents.defaults.contextPruning.mode is enabled.
   */
  deferToolPruning?: boolean;
  /** Enable detailed budget / trim decision logs. Default: false. */
  verboseLogging?: boolean;
  /**
   * Manual context window overrides by fully-qualified model id.
   * Used only when OpenClaw does not pass tokenBudget.
   */
  contextWindowOverrides?: Record<string, {
    contextTokens?: number;
    contextWindow?: number;
  }>;
  /** Threshold for cache replay fallback path. Default: 120000ms. */
  warmCacheReplayThresholdMs?: number;
  /**
   * Controls how much HyperMem context is injected into subagent sessions.
   * - 'full'  — same compositor pipeline as parent sessions (all layers)
   * - 'light' — facts + history only; skips library/wiki/semantic/keystones/doc chunks (default)
   * - 'off'   — skip all HyperMem warming; pass messages through as-is
   */
  subagentWarming?: 'full' | 'light' | 'off';
}> {
  // Resolve data dir: pluginConfig > default
  const dataDir = _pluginConfig.dataDir ?? path.join(os.homedir(), '.openclaw/hypermem');
  const configPath = path.join(dataDir, 'config.json');
  let fileConfig: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    fileConfig = JSON.parse(raw) as Record<string, unknown>;
    console.log(`[hypermem-plugin] Loaded legacy config from ${configPath}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[hypermem-plugin] Failed to parse config.json (using defaults):`, (err as Error).message);
    }
  }

  // Merge: pluginConfig (openclaw.json) wins over fileConfig (legacy config.json).
  // Top-level scalar keys from pluginConfig override fileConfig.
  // Nested objects (compositor, eviction, embedding) are shallow-merged.
  const merged = { ...fileConfig } as ReturnType<typeof loadUserConfig> extends Promise<infer T> ? T : never;
  if (_pluginConfig.contextWindowSize != null) merged.contextWindowSize = _pluginConfig.contextWindowSize;
  if (_pluginConfig.contextWindowReserve != null) merged.contextWindowReserve = _pluginConfig.contextWindowReserve;
  if (_pluginConfig.deferToolPruning != null) merged.deferToolPruning = _pluginConfig.deferToolPruning;
  if (_pluginConfig.verboseLogging != null) merged.verboseLogging = _pluginConfig.verboseLogging;
  if (_pluginConfig.contextWindowOverrides != null) merged.contextWindowOverrides = { ...merged.contextWindowOverrides, ..._pluginConfig.contextWindowOverrides };
  if (_pluginConfig.warmCacheReplayThresholdMs != null) merged.warmCacheReplayThresholdMs = _pluginConfig.warmCacheReplayThresholdMs;
  if (_pluginConfig.subagentWarming != null) merged.subagentWarming = _pluginConfig.subagentWarming;
  if (_pluginConfig.compositor) merged.compositor = { ...merged.compositor, ..._pluginConfig.compositor };
  if (_pluginConfig.eviction) merged.eviction = { ...merged.eviction, ..._pluginConfig.eviction };
  if (_pluginConfig.embedding) merged.embedding = { ...merged.embedding, ..._pluginConfig.embedding };

  if (Object.keys(fileConfig).length > 0 && Object.keys(_pluginConfig).filter(k => k !== 'hyperMemPath' && k !== 'dataDir').length > 0) {
    console.log('[hypermem-plugin] Note: migrating config.json keys to plugins.entries.hypercompositor.config in openclaw.json is recommended');
  }

  return merged;
}

async function getHyperMem(): Promise<HyperMemInstance> {
  if (_hm) return _hm;
  if (_hmInitPromise) return _hmInitPromise;

  _hmInitPromise = (async () => {
    // Dynamic import — hypermem is loaded from repo dist
    const mod = await import(HYPERMEM_PATH);
    const HyperMem = mod.HyperMem;

    // Capture generateEmbeddings from the dynamic module for use in afterTurn().
    // Bind it with the user's embedding config so the pre-compute path uses the
    // same provider as the indexer (Ollama vs OpenAI).
    if (typeof mod.generateEmbeddings === 'function') {
      const rawGenerate = mod.generateEmbeddings as (texts: string[], config?: unknown) => Promise<Float32Array[]>;
      _generateEmbeddings = (texts: string[]) => rawGenerate(texts, _embeddingConfig ?? undefined);
    }

    // Load optional user config — compositor tuning overrides
    const userConfig = await loadUserConfig();

    // Build embedding config from user config. Applied to both HyperMem core
    // (VectorStore init) and the _generateEmbeddings closure above.
    if (userConfig.embedding) {
      const ue = userConfig.embedding;

      // Provider-specific model/dimension/batch defaults
      const providerDefaults = ue.provider === 'gemini'
        ? { model: 'gemini-embedding-001', dimensions: 3072, batchSize: 100, timeout: 15000 }
        : ue.provider === 'openai'
          ? { model: 'text-embedding-3-small', dimensions: 1536, batchSize: 128, timeout: 10000 }
          : { model: 'nomic-embed-text', dimensions: 768, batchSize: 32, timeout: 10000 };

      _embeddingConfig = {
        provider: ue.provider ?? 'ollama',
        ollamaUrl: ue.ollamaUrl ?? 'http://localhost:11434',
        openaiBaseUrl: ue.openaiBaseUrl ?? 'https://api.openai.com/v1',
        openaiApiKey: ue.openaiApiKey,
        geminiBaseUrl: ue.geminiBaseUrl,
        geminiIndexTaskType: ue.geminiIndexTaskType,
        geminiQueryTaskType: ue.geminiQueryTaskType,
        model: ue.model ?? providerDefaults.model,
        dimensions: ue.dimensions ?? providerDefaults.dimensions,
        timeout: ue.timeout ?? providerDefaults.timeout,
        batchSize: ue.batchSize ?? providerDefaults.batchSize,
      };
      console.log(
        `[hypermem-plugin] Embedding provider: ${_embeddingConfig.provider} ` +
        `(model: ${_embeddingConfig.model}, ${_embeddingConfig.dimensions}d, batch: ${_embeddingConfig.batchSize})`
      );
    }

    // Cache eviction config at module scope so assemble() can read it
    // synchronously without re-reading disk on every turn.
    _evictionConfig = userConfig.eviction ?? {};

    // Cache context window config so all three trim hotpaths use the same values.
    if (typeof userConfig.contextWindowSize === 'number' && userConfig.contextWindowSize > 0) {
      _contextWindowSize = userConfig.contextWindowSize;
    }
    if (typeof userConfig.contextWindowReserve === 'number' &&
        userConfig.contextWindowReserve >= 0 && userConfig.contextWindowReserve <= 0.5) {
      _contextWindowReserve = userConfig.contextWindowReserve;
    }
    _deferToolPruning = userConfig.deferToolPruning === true;
    if (_deferToolPruning) {
      console.log('[hypermem-plugin] deferToolPruning: true — tool gradient deferred to host contextPruning');
    }
    _verboseLogging = userConfig.verboseLogging === true;
    const sanitizedOverrides = sanitizeContextWindowOverrides(userConfig.contextWindowOverrides);
    _contextWindowOverrides = sanitizedOverrides.value;
    for (const warning of sanitizedOverrides.warnings) {
      console.warn(`[hypermem-plugin] ${warning}`);
    }
    const warmingVal = (userConfig as { subagentWarming?: string }).subagentWarming;
    if (warmingVal === 'full' || warmingVal === 'light' || warmingVal === 'off') {
      _subagentWarming = warmingVal;
      console.log(`[hypermem-plugin] subagentWarming: ${_subagentWarming}`);
    }
    if (typeof (userConfig as { warmCacheReplayThresholdMs?: number }).warmCacheReplayThresholdMs === 'number') {
      _cacheReplayThresholdMs = (userConfig as { warmCacheReplayThresholdMs?: number }).warmCacheReplayThresholdMs!;
    }
    const reservedTokens = Math.floor(_contextWindowSize * _contextWindowReserve);
    console.log(
      `[hypermem-plugin] context window: ${_contextWindowSize} tokens, ` +
      `${Math.round(_contextWindowReserve * 100)}% reserved (${reservedTokens} tokens), ` +
      `effective history budget: ${_contextWindowSize - reservedTokens} tokens`
    );
    verboseLog(`[hypermem-plugin] warmCacheReplayThresholdMs=${_cacheReplayThresholdMs}`);
    verboseLog(`[hypermem-plugin] contextWindowOverrides keys=${Object.keys(_contextWindowOverrides).join(', ') || '(none)'}`);

    const instance = await HyperMem.create({
      dataDir: _pluginConfig.dataDir ?? path.join(os.homedir(), '.openclaw/hypermem'),
      cache: {
        keyPrefix: 'hm:',
        sessionTTL: 14400,     // 4h for system/identity/meta slots
        historyTTL: 86400,     // 24h for history — ages out, not count-trimmed
      },
      ...(userConfig.compositor ? { compositor: userConfig.compositor } : {}),
      ...(_embeddingConfig ? { embedding: _embeddingConfig } : {}),
    });

    _hm = instance;

    // Wire up fleet store and background indexer from dynamic module
    const { FleetStore: FleetStoreClass, createIndexer } = mod as {
      FleetStore: new (db: ReturnType<typeof instance.dbManager.getLibraryDb>) => FleetStore;
      createIndexer: (
        getMessageDb: (agentId: string) => any,
        getLibraryDb: () => any,
        listAgents: () => string[],
        config?: Partial<{ enabled: boolean; periodicInterval: number; maxActiveConversations?: number; recentConversationCooldownMs?: number; maxCandidatesPerPass?: number }>,
        getCursor?: (agentId: string, sessionKey: string) => Promise<unknown>,
        vectorStore?: any,
        dreamerConfig?: Record<string, unknown>,
        globalWritePolicy?: string,
      ) => BackgroundIndexer;
    };
    const libraryDb = instance.dbManager.getLibraryDb();
    _fleetStore = new FleetStoreClass(libraryDb as Parameters<InstanceType<typeof FleetStoreClass>['listAgents']>[0] extends never ? never : never) as unknown as FleetStore;

    try {
      // T1.2: Wire indexer with proper DB accessors and cursor fetcher.
      // The cursor fetcher enables priority-based indexing: messages the model
      // hasn't seen yet (post-cursor) are processed first.
      _indexer = createIndexer(
        (agentId: string) => instance.dbManager.getMessageDb(agentId),
        () => instance.dbManager.getLibraryDb(),
        () => {
          // List agents from fleet_agents table (active only)
          try {
            const rows = instance.dbManager.getLibraryDb()
              .prepare("SELECT id FROM fleet_agents WHERE status = 'active'")
              .all() as Array<{ id: string }>;
            return rows.map(r => r.id);
          } catch {
            return [];
          }
        },
        {
          enabled: true,
          periodicInterval: (userConfig as any)?.maintenance?.periodicInterval ?? 300000,
          maxActiveConversations: (userConfig as any)?.maintenance?.maxActiveConversations ?? 5,
          recentConversationCooldownMs: (userConfig as any)?.maintenance?.recentConversationCooldownMs ?? 30000,
          maxCandidatesPerPass: (userConfig as any)?.maintenance?.maxCandidatesPerPass ?? 200,
        },
        // Cursor fetcher: reads the SQLite-backed session cursor
        async (agentId: string, sessionKey: string) => {
          return instance.getSessionCursor(agentId, sessionKey);
        },
        // Pass vector store so new facts/episodes are embedded at index time
        instance.getVectorStore() ?? undefined,
        // Dreaming config — passed from hypermem user config if set
        (userConfig as { dreaming?: Record<string, unknown> })?.dreaming ?? {},
        // KL-01: global write policy — passed from hypermem user config
        ((userConfig as { globalWritePolicy?: string })?.globalWritePolicy as any) ?? 'deny',
      );
      _indexer.start();
      if (_verboseLogging) {
        const mc = (userConfig as any)?.maintenance ?? {};
        console.log(
          `[hypermem-plugin] maintenance settings: periodicInterval=${mc.periodicInterval ?? 300000}ms ` +
          `maxActiveConversations=${mc.maxActiveConversations ?? 5} ` +
          `cooldown=${mc.recentConversationCooldownMs ?? 30000}ms ` +
          `maxCandidatesPerPass=${mc.maxCandidatesPerPass ?? 200}`
        );
      }
    } catch {
      // Non-fatal — indexer wiring can fail without breaking context assembly
    }

    return instance;
  })();

  return _hmInitPromise;
}

// ─── Session Key Helpers ────────────────────────────────────────

/**
 * Extract agentId from a session key.
 * Session keys follow: "agent:<agentId>:<channel>:<name>"
 * Falls back to "main" if the key doesn't match expected format.
 */
function extractAgentId(sessionKey?: string): string {
  if (!sessionKey) return 'main';
  const parts = sessionKey.split(':');
  if (parts[0] === 'agent' && parts.length >= 2) {
    return parts[1];
  }
  return 'main';
}

/**
 * Normalize sessionKey — prefer the explicit sessionKey param,
 * fall back to sessionId (UUID) which we can't parse as a session key.
 * If neither is useful, use a default.
 */
function resolveSessionKey(sessionId: string, sessionKey?: string): string {
  if (sessionKey) return sessionKey;
  // sessionId is a UUID — not a parseable session key.
  // Use a synthetic key so recording works but note it won't resolve to a named session.
  return `session:${sessionId}`;
}

// ─── AgentMessage → NeutralMessage conversion ──────────────────

type InboundMessage = {
  role: string;
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

const SYNTHETIC_MISSING_TOOL_RESULT_TEXT = 'No result provided';

type ToolPairStats = {
  toolCallCount: number;
  toolResultCount: number;
  missingToolResultCount: number;
  orphanToolResultCount: number;
  syntheticNoResultCount: number;
  missingToolResultIds: string[];
  orphanToolResultIds: string[];
};

type ToolPairMetrics = {
  composeCount?: number;
  syntheticNoResultIngested?: number;
  preBridgeMissingToolResults?: number;
  preBridgeOrphanToolResults?: number;
  postBridgeMissingToolResults?: number;
  postBridgeOrphanToolResults?: number;
  lastUpdatedAt?: string;
  lastAnomaly?: Record<string, unknown>;
};

function extractTextFromInboundContent(content: InboundMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: string; text?: string } => Boolean(part && typeof part.type === 'string'))
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text ?? '')
    .join('\n');
}

function resolveAssistantTokenCount(
  msg: InboundMessage,
  runtimeContext?: Record<string, unknown>
): number | undefined {
  const usage = (msg as { usage?: Record<string, unknown> }).usage;
  if (usage && typeof usage === 'object') {
    const candidates = [
      usage.total,
      usage.totalTokens,
      usage.total_tokens,
      usage.output,
      usage.outputTokens,
      usage.output_tokens,
      usage.completionTokens,
      usage.completion_tokens,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return Math.floor(candidate);
      }
    }
  }

  const runtimeTokenCount = runtimeContext?.currentTokenCount;
  if (typeof runtimeTokenCount === 'number' && Number.isFinite(runtimeTokenCount) && runtimeTokenCount > 0) {
    return Math.floor(runtimeTokenCount);
  }

  return undefined;
}

function collectNeutralToolPairStats(messages: NeutralMessage[]): ToolPairStats {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  let toolCallCount = 0;
  let toolResultCount = 0;
  let syntheticNoResultCount = 0;

  for (const msg of messages) {
    for (const tc of msg.toolCalls ?? []) {
      toolCallCount++;
      if (tc.id) callIds.add(tc.id);
    }
    for (const tr of msg.toolResults ?? []) {
      toolResultCount++;
      if (tr.callId) resultIds.add(tr.callId);
      if ((tr.content ?? '').trim() === SYNTHETIC_MISSING_TOOL_RESULT_TEXT) syntheticNoResultCount++;
    }
  }

  const missingToolResultIds = [...callIds].filter(id => !resultIds.has(id));
  const orphanToolResultIds = [...resultIds].filter(id => !callIds.has(id));

  return {
    toolCallCount,
    toolResultCount,
    missingToolResultCount: missingToolResultIds.length,
    orphanToolResultCount: orphanToolResultIds.length,
    syntheticNoResultCount,
    missingToolResultIds,
    orphanToolResultIds,
  };
}

function collectAgentToolPairStats(messages: InboundMessage[]): ToolPairStats {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  let toolCallCount = 0;
  let toolResultCount = 0;
  let syntheticNoResultCount = 0;

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'toolCall' || block.type === 'toolUse') {
          toolCallCount++;
          if (typeof block.id === 'string' && block.id.length > 0) callIds.add(block.id);
        }
      }
    }

    if (msg.role === 'toolResult') {
      toolResultCount++;
      const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
      if (toolCallId) resultIds.add(toolCallId);
      if (extractTextFromInboundContent(msg.content).trim() === SYNTHETIC_MISSING_TOOL_RESULT_TEXT) {
        syntheticNoResultCount++;
      }
    }
  }

  const missingToolResultIds = [...callIds].filter(id => !resultIds.has(id));
  const orphanToolResultIds = [...resultIds].filter(id => !callIds.has(id));

  return {
    toolCallCount,
    toolResultCount,
    missingToolResultCount: missingToolResultIds.length,
    orphanToolResultCount: orphanToolResultIds.length,
    syntheticNoResultCount,
    missingToolResultIds,
    orphanToolResultIds,
  };
}

async function bumpToolPairMetrics(
  hm: HyperMemInstance,
  agentId: string,
  sessionKey: string,
  delta: ToolPairMetrics,
  anomaly?: Record<string, unknown>,
): Promise<void> {
  const slot = 'toolPairMetrics';

  let stored: ToolPairMetrics = {};
  try {
    const raw = await hm.cache.getSlot(agentId, sessionKey, slot);
    if (raw) stored = JSON.parse(raw) as ToolPairMetrics;
  } catch {
    stored = {};
  }

  const next: ToolPairMetrics = {
    composeCount: (stored.composeCount ?? 0) + (delta.composeCount ?? 0),
    syntheticNoResultIngested: (stored.syntheticNoResultIngested ?? 0) + (delta.syntheticNoResultIngested ?? 0),
    preBridgeMissingToolResults: (stored.preBridgeMissingToolResults ?? 0) + (delta.preBridgeMissingToolResults ?? 0),
    preBridgeOrphanToolResults: (stored.preBridgeOrphanToolResults ?? 0) + (delta.preBridgeOrphanToolResults ?? 0),
    postBridgeMissingToolResults: (stored.postBridgeMissingToolResults ?? 0) + (delta.postBridgeMissingToolResults ?? 0),
    postBridgeOrphanToolResults: (stored.postBridgeOrphanToolResults ?? 0) + (delta.postBridgeOrphanToolResults ?? 0),
    lastUpdatedAt: new Date().toISOString(),
    lastAnomaly: anomaly ?? stored.lastAnomaly,
  };

  await hm.cache.setSlot(agentId, sessionKey, slot, JSON.stringify(next));
}

/**
 * Convert an OpenClaw AgentMessage to hypermem's NeutralMessage format.
 */
function toNeutralMessage(msg: InboundMessage): NeutralMessage {
  // Extract text content from string or array format
  let textContent: string | null = null;

  if (typeof msg.content === 'string') {
    textContent = msg.content;
  } else if (Array.isArray(msg.content)) {
    const textParts = msg.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text);
    textContent = textParts.length > 0 ? textParts.join('\n') : null;
  }

  // Detect tool calls/results.
  // OpenClaw stores tool calls as content blocks: { type: 'toolCall' | 'toolUse', id, name, input }
  // Legacy wire format stores them as a separate msg.tool_calls / msg.toolCalls array
  // with OpenAI format: { id, type: 'function', function: { name, arguments } }
  // Normalize everything to NeutralToolCall format: { id, name, arguments: string }
  const contentBlockToolCalls = Array.isArray(msg.content)
    ? (msg.content as Array<{ type: string; id?: string; name?: string; input?: unknown; [key: string]: unknown }>)
        .filter(c => c.type === 'toolCall' || c.type === 'toolUse')
        .map(c => ({
          id: c.id ?? 'unknown',
          name: c.name ?? 'unknown',
          arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input ?? {}),
        }))
    : [];

  // Legacy wire format tool calls (OpenAI style)
  const rawToolCalls = (msg.tool_calls as Array<Record<string, unknown>> | null)
    ?? (msg.toolCalls as Array<Record<string, unknown>> | null)
    ?? null;

  let toolCalls: Array<{ id: string; name: string; arguments: string }> | null = null;
  if (rawToolCalls && rawToolCalls.length > 0) {
    toolCalls = rawToolCalls.map(tc => {
      // OpenAI wire format: { id, type: 'function', function: { name, arguments } }
      const fn = tc.function as Record<string, unknown> | undefined;
      if (fn) {
        return {
          id: (tc.id as string) ?? 'unknown',
          name: (fn.name as string) ?? 'unknown',
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        };
      }
      // Already NeutralToolCall-ish or content block format
      return {
        id: (tc.id as string) ?? 'unknown',
        name: (tc.name as string) ?? 'unknown',
        arguments: typeof tc.arguments === 'string' ? tc.arguments
          : typeof tc.input === 'string' ? tc.input
          : JSON.stringify(tc.arguments ?? tc.input ?? {}),
      };
    });
  } else if (contentBlockToolCalls.length > 0) {
    toolCalls = contentBlockToolCalls;
  }
  // OpenClaw uses role 'toolResult' (camelCase). Support all three spellings.
  const isToolResultMsg = msg.role === 'tool' || msg.role === 'tool_result' || msg.role === 'toolResult';

  // Tool results must stay on the result side of the transcript. If we persist them as
  // assistant rows with orphaned toolResults, later replay can retain a tool_result after
  // trimming away the matching assistant tool_use, which Anthropic rejects with a 400.
  let toolResults: NeutralToolResult[] | null = null;
  if (isToolResultMsg && textContent) {
    const toolCallId = (msg.tool_call_id as string) ?? (msg.toolCallId as string) ?? 'unknown';
    const toolName   = (msg.name as string)         ?? (msg.toolName as string)   ?? 'tool';
    toolResults = [{ callId: toolCallId, name: toolName, content: textContent }];
    textContent = null;  // owned by toolResults now, not duplicated in textContent
  }

  const role = isToolResultMsg
    ? 'user'
    : (msg.role as 'user' | 'assistant' | 'system');

  return {
    role,
    textContent,
    toolCalls: isToolResultMsg ? null : toolCalls,
    toolResults,
  };
}

// ─── Context Engine Implementation ─────────────────────────────

/**
 * In-flight warm dedup map.
 * Key: "agentId::sessionKey" — Value: the in-progress warm() Promise.
 * Prevents concurrent bootstrap() calls from firing multiple full warms
 * for the same session key before the first one sets the Redis history key.
 * Cleared on completion (success or failure) so the next cold start retries.
 */
const _warmInFlight = new Map<string, Promise<void>>();

// ─── Token estimation ──────────────────────────────────────────

/**
 * Estimate tokens for a string using the same ~4 chars/token heuristic
 * used by the hypermem compositor. Fast and allocation-free — no tokenizer
 * library needed for a budget guard.
 */
function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateMessagePartTokens(part: Record<string, unknown>): number {
  if (part.type === 'image' || part.type === 'image_url') {
    const src = (part.source as Record<string, unknown> | undefined)?.data;
    const url = (part.image_url as Record<string, unknown> | undefined)?.url as string | undefined;
    const dataStr = typeof src === 'string' ? src : (typeof url === 'string' ? url : '');
    return Math.ceil(dataStr.length / 3);
  }
  if (part.type === 'toolCall' || part.type === 'tool_use') {
    return Math.ceil(JSON.stringify(part).length / 2);
  }
  const textVal = typeof part.text === 'string' ? part.text
    : typeof part.content === 'string' ? part.content
    : part.content != null ? JSON.stringify(part.content) : null;
  return estimateTokens(textVal);
}

function estimateMessageTokens(msg: Record<string, unknown>): number {
  let total = estimateTokens(typeof msg.textContent === 'string' ? msg.textContent : null);
  if (typeof msg.content === 'string' && typeof msg.textContent !== 'string') {
    total += estimateTokens(msg.content);
  }
  if (msg.toolCalls) total += Math.ceil(JSON.stringify(msg.toolCalls).length / 2);
  if (msg.toolResults) total += Math.ceil(JSON.stringify(msg.toolResults).length / 2);
  if (Array.isArray(msg.content)) {
    total += (msg.content as Array<Record<string, unknown>>).reduce(
      (sum, part) => sum + estimateMessagePartTokens(part),
      0,
    );
  }
  return total;
}

function estimateMessageArrayTokens(messages: unknown[]): number {
  return messages.reduce(
    (sum: number, msg: unknown) => sum + estimateMessageTokens(msg as Record<string, unknown>),
    0,
  );
}

function maybeLogPressureAccountingAnomaly(fields: {
  path: TrimTelemetryPath;
  agentId: string;
  sessionKey: string;
  runtimeTokens: number;
  redisTokens: number;
  composedTokens: number;
  budget: number;
}): void {
  const threshold = Math.max(500, Math.floor(fields.budget * 0.05));
  const deltas = {
    runtimeVsComposed: Math.abs(fields.runtimeTokens - fields.composedTokens),
    redisVsComposed: Math.abs(fields.redisTokens - fields.composedTokens),
    runtimeVsRedis: Math.abs(fields.runtimeTokens - fields.redisTokens),
  };

  // Post-0.6.0: "redis" is actually the L1 SQLite cache window, which lags
  // behind the runtime message array between trim passes.  Cache-vs-runtime
  // drift is structural and harmless — the runtime array is authoritative
  // (it's what the model sees).  Only warn when runtimeVsComposed diverges,
  // which indicates an actual trim accounting bug.
  if (deltas.runtimeVsComposed < threshold) {
    // Log cache drift at debug level for observability, not as a warning.
    if (deltas.redisVsComposed >= threshold || deltas.runtimeVsRedis >= threshold) {
      console.debug(
        `[hypermem-plugin] cache-drift (non-anomalous): path=${fields.path} ` +
        `runtime=${fields.runtimeTokens} cache=${fields.redisTokens} composed=${fields.composedTokens} ` +
        `budget=${fields.budget}`
      );
    }
    return;
  }

  console.warn(
    `[hypermem-plugin] pressure-accounting anomaly: path=${fields.path} ` +
    `runtime=${fields.runtimeTokens} cache=${fields.redisTokens} composed=${fields.composedTokens} ` +
    `budget=${fields.budget} threshold=${threshold}`
  );

  guardTelemetry({
    path: fields.path,
    agentId: fields.agentId,
    sessionKey: fields.sessionKey,
    reason: 'pressure-accounting-anomaly',
  });
}

function normalizeReplayRecoveryState(value: string | null | undefined): '' | 'entering' | 'stabilizing' | 'exited' | null {
  if (value == null) return null;
  if (value === '') return '';
  return isReplayState(value) ? value : null;
}

async function persistReplayRecoveryState(
  hm: HyperMemInstance,
  agentId: string,
  sessionKey: string,
  nextState: string | null,
): Promise<void> {
  try {
    await hm.cache.setSlot(agentId, sessionKey, 'replayRecoveryState', nextState ?? '');
  } catch {
    // Non-fatal
  }
}

function hasStructuredToolCallMessage(msg: Record<string, unknown>): boolean {
  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) return true;
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as Array<Record<string, unknown>>).some(part => part.type === 'toolCall' || part.type === 'tool_use');
}

function hasStructuredToolResultMessage(msg: Record<string, unknown>): boolean {
  if (Array.isArray(msg.toolResults) && msg.toolResults.length > 0) return true;
  if (msg.role === 'toolResult' || msg.role === 'tool' || msg.role === 'tool_result') return true;
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as Array<Record<string, unknown>>).some(part => part.type === 'tool_result' || part.type === 'toolResult');
}

function getToolCallIds(msg: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (Array.isArray(msg.toolCalls)) {
    ids.push(...(msg.toolCalls as Array<Record<string, unknown>>).map(tc => tc.id).filter((id): id is string => typeof id === 'string' && id.length > 0));
  }
  if (Array.isArray(msg.content)) {
    for (const part of msg.content as Array<Record<string, unknown>>) {
      if ((part.type === 'toolCall' || part.type === 'tool_use') && typeof part.id === 'string' && part.id.length > 0) {
        ids.push(part.id);
      }
    }
  }
  return ids;
}

function getToolResultIds(msg: Record<string, unknown>): string[] {
  const ids: string[] = [];
  if (Array.isArray(msg.toolResults)) {
    ids.push(...(msg.toolResults as Array<Record<string, unknown>>).map(tr => tr.callId).filter((id): id is string => typeof id === 'string' && id.length > 0));
  }
  if (typeof msg.toolCallId === 'string' && msg.toolCallId.length > 0) {
    ids.push(msg.toolCallId);
  }
  if (typeof msg.tool_call_id === 'string' && msg.tool_call_id.length > 0) {
    ids.push(msg.tool_call_id as string);
  }
  return ids;
}

function clusterTranscriptMessages<T extends Record<string, unknown>>(messages: T[]): T[][] {
  const clusters: T[][] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    const cluster: T[] = [current];

    if (hasStructuredToolCallMessage(current)) {
      const callIds = new Set(getToolCallIds(current));
      let j = i + 1;
      while (j < messages.length) {
        const candidate = messages[j];
        if (!hasStructuredToolResultMessage(candidate)) break;
        const resultIds = getToolResultIds(candidate);
        if (callIds.size > 0 && resultIds.length > 0 && !resultIds.some(id => callIds.has(id))) break;
        cluster.push(candidate);
        j++;
      }
      i = j - 1;
    } else if (hasStructuredToolResultMessage(current)) {
      let j = i + 1;
      while (j < messages.length) {
        const candidate = messages[j];
        if (!hasStructuredToolResultMessage(candidate) || hasStructuredToolCallMessage(candidate)) break;
        cluster.push(candidate);
        j++;
      }
      i = j - 1;
    }

    clusters.push(cluster);
  }

  return clusters;
}


/**
 * Estimate total token cost of the current Redis history window for a session.
 * Counts text content + tool call/result JSON for each message.
 */
async function estimateWindowTokens(hm: HyperMemInstance, agentId: string, sessionKey: string): Promise<number> {
  try {
    // Prefer the hot window cache (set after compaction trims the history).
    // Fall back to the actual history list — the window cache is only populated
    // after compact() calls setWindow(), so a fresh or never-compacted session
    // has no window cache entry. Without this fallback, getWindow returns null
    // → estimateWindowTokens returns 0 → compact() always says within_budget
    // → overflow loop.
    const window = await hm.cache.getWindow(agentId, sessionKey)
      ?? await hm.cache.getHistory(agentId, sessionKey);
    if (!window || window.length === 0) return 0;
    return estimateMessageArrayTokens(window as unknown[]);
  } catch {
    return 0;
  }
}

/**
 * Truncate a JSONL session file to keep only the last `targetDepth` message
 * entries plus all non-message entries (header, compaction, model_change, etc).
 *
 * This is needed because the runtime loads messages from the JSONL file
 * (not from Redis) to build its overflow estimate. When ownsCompaction=true,
 * OpenClaw's truncateSessionAfterCompaction() is never called, so we do it
 * ourselves.
 *
 * Returns true if the file was actually truncated, false if no action was
 * needed or the file didn't exist.
 */
async function truncateJsonlIfNeeded(
  sessionFile: string | undefined,
  targetDepth: number,
  force = false,
  tokenBudgetOverride?: number,
): Promise<boolean> {
  if (!sessionFile || typeof sessionFile !== 'string') return false;
  try {
    const raw = await fs.readFile(sessionFile, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length === 0) return false;

    const header = lines[0];
    const entries: Array<{ line: string; parsed: any }> = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        entries.push({ line: lines[i], parsed: JSON.parse(lines[i]) });
      } catch {
        entries.push({ line: lines[i], parsed: null });
      }
      // Yield every 100 entries to avoid blocking the event loop
      if (i % 100 === 0) await new Promise(r => setImmediate(r));
    }

    const messageEntries: typeof entries = [];
    const metadataEntries: typeof entries = [];
    for (const e of entries) {
      if (e.parsed?.type === 'message') {
        messageEntries.push(e);
      } else {
        metadataEntries.push(e);
      }
    }

    // Only rewrite if meaningfully over target — unless force=true (over-budget path)
    if (!force && messageEntries.length <= targetDepth * 1.5) return false;

    // If a token budget is specified, keep newest messages within that budget
    let keptMessages: typeof messageEntries;
    if (tokenBudgetOverride) {
      let tokenCount = 0;
      const kept: typeof messageEntries = [];
      for (let i = messageEntries.length - 1; i >= 0 && kept.length < targetDepth; i--) {
        const m = messageEntries[i].parsed?.message ?? messageEntries[i].parsed;
        let t = 0;
        if (m?.content) t += Math.ceil(JSON.stringify(m.content).length / 4);
        if (m?.textContent) t += Math.ceil(String(m.textContent).length / 4);
        if (m?.toolResults) t += Math.ceil(JSON.stringify(m.toolResults).length / 4);
        if (m?.toolCalls) t += Math.ceil(JSON.stringify(m.toolCalls).length / 4);
        if (tokenCount + t > tokenBudgetOverride && kept.length > 0) break;
        kept.unshift(messageEntries[i]);
        tokenCount += t;
      }
      keptMessages = kept;
    } else {
      keptMessages = messageEntries.slice(-targetDepth);
    }
    const keptSet = new Set(keptMessages.map(e => e.line));
    const metaSet = new Set(metadataEntries.map(e => e.line));
    const rebuilt = [header];
    for (const e of entries) {
      if (metaSet.has(e.line) || keptSet.has(e.line)) {
        rebuilt.push(e.line);
      }
    }

    const tmpPath = `${sessionFile}.hm-compact-${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, rebuilt.join('\n') + '\n', 'utf-8');
    await fs.rename(tmpPath, sessionFile);
    console.log(
      `[hypermem-plugin] truncateJsonl: ${entries.length} → ${rebuilt.length - 1} entries ` +
      `(kept ${keptMessages.length} messages + ${metadataEntries.length} metadata, file=${sessionFile.split('/').pop()})`,
    );
    return true;
  } catch (err) {
    // ENOENT is expected when session file doesn't exist yet — not worth logging
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[hypermem-plugin] truncateJsonl failed (non-fatal):', (err as Error).message);
    }
    return false;
  }
}

function createHyperMemEngine(): ContextEngine {
  return {
    info: {
      id: 'hypercompositor',
      name: 'hypermem context engine',
      version: '0.6.3',
      // We own compaction — assemble() trims to budget via the compositor safety
      // valve, so runtime compaction is never needed. compact() handles any
      // explicit calls by trimming the Redis history window directly.
      ownsCompaction: true,
    } satisfies ContextEngineInfo,

    /**
     * Bootstrap: warm Redis session for this agent, register in fleet if needed.
     *
     * Idempotent — skips warming if the session is already hot in Redis.
     * Without this guard, the OpenClaw runtime calls bootstrap() on every turn
     * (not just session start), causing:
     *   1. A SQLite read + Redis pipeline push on every message (lane lock)
     *   2. 250 messages re-pushed to Redis per turn (dedup in pushHistory helps,
     *      but the read cost still runs)
     *   3. Followup queue drain blocked until warm completes
     *
     * With this guard: cold start = full warm; hot session = single EXISTS check.
     */
    async bootstrap({ sessionId, sessionKey }): ReturnType<NonNullable<ContextEngine['bootstrap']>> {
      try {
        const hm = await getHyperMem();
        const sk = resolveSessionKey(sessionId, sessionKey);
        const agentId = extractAgentId(sk);

        // EC1 JSONL truncation moved to maintain() — bootstrap stays fast.

        // B2: Session-restart detection — rotateSessionContext hook.
        // When the runtime starts a new session (new sessionId) for an existing
        // sessionKey, archive the old context head and create a fresh active
        // context so the new conversation starts clean. This prevents the new
        // session from inheriting a stale context head pointer from the prior run.
        //
        // Detection: if a conversation row exists for this sessionKey AND the
        // stored session_id differs from the incoming sessionId (runtime-assigned),
        // treat this as a session restart.
        //
        // Non-fatal: context rotation is best-effort and never blocks bootstrap.
        if (sessionId) {
          try {
            const _msgDb = hm.dbManager.getMessageDb(agentId);
            if (_msgDb) {
              const _existingConv = _msgDb.prepare(
                'SELECT id, session_id FROM conversations WHERE session_key = ? LIMIT 1'
              ).get(sk) as { id: number; session_id: string | null } | undefined;
              if (
                _existingConv &&
                _existingConv.session_id !== null &&
                _existingConv.session_id !== sessionId
              ) {
                // Distinct sessionId — this is a session restart for an existing sessionKey.
                rotateSessionContext(_msgDb, agentId, sk, _existingConv.id);
                // Update the stored session_id to the new one.
                try {
                  _msgDb.prepare('UPDATE conversations SET session_id = ? WHERE id = ?')
                    .run(sessionId, _existingConv.id);
                } catch {
                  // Best-effort — column may not exist in older schemas
                }
                console.log(
                  `[hypermem-plugin] bootstrap: session restart detected for ${agentId}/${sk} ` +
                  `(prev session_id=${_existingConv.session_id}, new=${sessionId}) — context rotated`
                );
              } else if (_existingConv && _existingConv.session_id === null && sessionId) {
                // Conversation exists but session_id was never recorded — stamp it now.
                try {
                  _msgDb.prepare('UPDATE conversations SET session_id = ? WHERE id = ?')
                    .run(sessionId, _existingConv.id);
                } catch {
                  // Best-effort
                }
              }
            }
          } catch (rotateErr) {
            // Non-fatal — never block bootstrap on context rotation
            console.warn('[hypermem-plugin] bootstrap: rotateSessionContext failed (non-fatal):', (rotateErr as Error).message);
          }
        }

        // Fast path: if session already has history in Redis, skip warm entirely.
        // sessionExists() is a single EXISTS call — sub-millisecond cost.
        const alreadyWarm = await hm.cache.sessionExists(agentId, sk);
        if (alreadyWarm) {
          return { bootstrapped: true };
        }

        // In-flight dedup: if a warm is already running for this session key,
        // reuse that promise instead of launching a second concurrent warm.
        const inflightKey = `${agentId}::${sk}`;
        const existing = _warmInFlight.get(inflightKey);
        if (existing) {
          await existing;
          return { bootstrapped: true };
        }

        // Cold start: warm Redis with the session — pre-loads history + slots
        // CRIT-002: Load supplemental identity files (MOTIVATIONS.md, STYLE.md) that are
        // NOT already injected by OpenClaw's contextInjection into the system prompt.
        // SOUL.md and IDENTITY.md are filtered out here because OpenClaw injects them
        // via workspace bootstrap — re-injecting them via the identity slot would cause
        // duplication. Only agent-specific extras (MOTIVATIONS.md, STYLE.md) are included.
        // Non-fatal: missing files are silently skipped.
        let identityBlock: string | undefined;
        try {
          // Council agents live at workspace-council/<agentId>/
          // Other agents at workspace/<agentId>/ — try council path first
          const homedir = os.homedir();
          const councilPath = path.join(homedir, '.openclaw', 'workspace-council', agentId);
          const workspacePath = path.join(homedir, '.openclaw', 'workspace', agentId);
          let wsPath = councilPath;
          try {
            await fs.access(councilPath);
          } catch {
            wsPath = workspacePath;
          }
          const identityFiles = ['SOUL.md', 'IDENTITY.md', 'MOTIVATIONS.md', 'STYLE.md']
            .filter(f => !OPENCLAW_BOOTSTRAP_FILES.has(f));
          const parts: string[] = [];
          for (const fname of identityFiles) {
            try {
              const content = await fs.readFile(path.join(wsPath, fname), 'utf-8');
              if (content.trim()) parts.push(content.trim());
            } catch {
              // File absent — skip silently
            }
          }
          if (parts.length > 0) identityBlock = parts.join('\n\n');
        } catch {
          // Identity load is best-effort — never block bootstrap on this
        }

        // Capture wsPath for post-warm seeding (declared in the identity block above)
        let _wsPathForSeed: string | undefined;
        try {
          const homedir2 = os.homedir();
          const councilPath2 = path.join(homedir2, '.openclaw', 'workspace-council', agentId);
          const workspacePath2 = path.join(homedir2, '.openclaw', 'workspace', agentId);
          try { await fs.access(councilPath2); _wsPathForSeed = councilPath2; }
          catch { _wsPathForSeed = workspacePath2; }
        } catch { /* non-fatal */ }

        const warmPromise = hm.warm(agentId, sk, identityBlock ? { identity: identityBlock } : undefined).finally(() => {
          _warmInFlight.delete(inflightKey);
        });
        _warmInFlight.set(inflightKey, warmPromise);
        await warmPromise;

        // ACA doc seeding — fire-and-forget after warm.
        // Idempotent: WorkspaceSeeder skips files whose hash hasn't changed.
        // Seeds SOUL.md, TOOLS.md, AGENTS.md, POLICY.md etc. into library.db
        // doc_chunks so trigger-based retrieval can serve them at compose time.
        if (_wsPathForSeed) {
          const wsPathForSeed = _wsPathForSeed;
          hm.seedWorkspace(wsPathForSeed, { agentId }).then(seedResult => {
            if (seedResult.totalInserted > 0 || seedResult.reindexed > 0) {
              console.log(
                `[hypermem-plugin] bootstrap: seeded workspace docs for ${agentId} ` +
                `(+${seedResult.totalInserted} chunks, ${seedResult.reindexed} reindexed, ` +
                `${seedResult.skipped} unchanged, ${seedResult.errors.length} errors)`
              );
            }
          }).catch(err => {
            console.warn('[hypermem-plugin] bootstrap: workspace seeding failed (non-fatal):', (err as Error).message);
          });
        }

        // Post-warm pressure check: if messages.db had accumulated history,
        // warm() may have loaded the session straight to 80%+. Pre-trim now
        // so the first turn has headroom instead of starting saturated.
        // This is the "restart at 98%" failure mode reported by Helm 2026-04-05:
        // JSONL truncation + Redis flush isn't enough if messages.db is still full
        // and warm() reloads it. Trim here closes the loop.
        try {
          const postWarmTokens = await estimateWindowTokens(hm, agentId, sk);
          // Use a conservative 90k default; if the session is genuinely large,
          // we'll underestimate budget and trim more aggressively — that's fine.
          const warmBudget = 90_000;
          const warmPressure = postWarmTokens / warmBudget;
          if (warmPressure > 0.80) {
            // Sprint 2.2a: demote warmstart to guard telemetry.
            //
            // Previously this path performed a real trim + invalidateWindow
            // and emitted `event:'trim'` with path='warmstart'. Assemble
            // (tool-loop + normal/subagent) is the steady-state owner now,
            // so the first turn's assemble.* trim absorbs any remaining
            // post-warm pressure. Keeping the pressure check + threshold
            // branch here preserves observability via `event:'trim-guard'`
            // without mutating Redis history or the window cache.
            guardTelemetry({
              path: 'warmstart',
              agentId, sessionKey: sk,
              reason: 'warmstart-pressure-demoted',
            });
          }
        } catch {
          // Non-fatal — first turn's tool-loop trim is the fallback
        }

        return { bootstrapped: true };
      } catch (err) {
        // Bootstrap failure is non-fatal — log and continue
        console.warn('[hypermem-plugin] bootstrap failed:', (err as Error).message);
        return { bootstrapped: false, reason: (err as Error).message };
      }
    },

    /**
     * Transcript maintenance — runs after bootstrap, successful turns, or compaction.
     *
     * Moved from bootstrap: proactive JSONL truncation is forward-looking (helps
     * next restart, not current session), so it belongs in maintenance, not init.
     * Also runs tool pair repair on Redis history to fix orphaned pairs from
     * trim/compaction passes.
     */
    async maintain({ sessionId, sessionKey, sessionFile }): Promise<ContextEngineMaintenanceResult> {
      let changed = false;
      let bytesFreed = 0;
      let rewrittenEntries = 0;

      try {
        const hm = await getHyperMem();
        const sk = resolveSessionKey(sessionId, sessionKey);
        const agentId = extractAgentId(sk);

        // 1. Proactive JSONL truncation (EC1 guard — next restart loads clean)
        try {
          const EC1_MAX_MESSAGES = 60;
          const EC1_TOKEN_BUDGET = Math.floor(128_000 * 0.40);
          const truncated = await truncateJsonlIfNeeded(sessionFile, EC1_MAX_MESSAGES, false, EC1_TOKEN_BUDGET);
          if (truncated) {
            console.log(
              `[hypermem-plugin] maintain: proactive JSONL trim for ${agentId} ` +
              `(EC1 guard — next restart will load clean)`
            );
            changed = true;
          }
        } catch {
          // Non-fatal — JSONL truncation is best-effort
        }

        // 2. Redis history tool pair repair
        // Compaction and trim passes can orphan tool_call/tool_result pairs.
        // Anthropic and Gemini reject orphaned pairs with 400 errors.
        try {
          const history = await hm.cache.getHistory(agentId, sk);
          if (history && history.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const repairedHistory = repairToolPairs(history as any[]) as unknown as typeof history;
            const removedCount = history.length - repairedHistory.length;
            if (removedCount > 0) {
              await hm.cache.replaceHistory(agentId, sk, repairedHistory);
              await hm.cache.invalidateWindow(agentId, sk);
              console.log(
                `[hypermem-plugin] maintain: repaired tool pairs in Redis history ` +
                `for ${agentId} (removed ${removedCount} orphaned messages)`
              );
              changed = true;
              rewrittenEntries += removedCount;
              // Rough estimate: ~500 bytes per removed message
              bytesFreed += removedCount * 500;
            }
          }
        } catch {
          // Non-fatal
        }

        return { changed, bytesFreed, rewrittenEntries };
      } catch (err) {
        console.warn('[hypermem-plugin] maintain failed:', (err as Error).message);
        return { changed, bytesFreed, rewrittenEntries, reason: (err as Error).message };
      }
    },

    /**
     * Ingest a single message into hypermem's message store.
     * Skip heartbeats — they're noise in the memory store.
     */
    async ingest({ sessionId, sessionKey, message, isHeartbeat }): ReturnType<ContextEngine['ingest']> {
      if (isHeartbeat) {
        return { ingested: false };
      }

      // Skip system messages — they come from the runtime, not the conversation
      const msg = message as unknown as InboundMessage;
      if (msg.role === 'system') {
        return { ingested: false };
      }

      try {
        const hm = await getHyperMem();
        const sk = resolveSessionKey(sessionId, sessionKey);
        const agentId = extractAgentId(sk);
        let neutral = toNeutralMessage(msg);

        // Route to appropriate record method based on role.
        // User messages are intentionally NOT recorded here — afterTurn() handles
        // user recording with proper metadata stripping (stripMessageMetadata).
        // Recording here too causes dual-write: once raw (here), once clean (afterTurn).
        if (neutral.role === 'user') {
          return { ingested: false };
        }

        // ── Pre-ingestion wave guard ──────────────────────────────────────────
        // Tool result payloads can be 10k-50k tokens each. When a parallel tool
        // batch (4-6 results) lands while the session is already at 70%+, storing
        // full payloads pushes the hot window past the nuclear path threshold
        // before the next assemble() can trim. Use current hot-window state as
        // the pressure signal (appropriate here, we're deciding what to write TO
        // the window).
        //
        // Above 70%: truncate toolResult content in transcript, but keep the
        // full payload durable in tool_artifacts (schema v9). Stub carries
        // artifactId so the compositor can hydrate on demand.
        // Above 85%: full stub replacement in transcript, still with artifactId.
        // At all levels: the full payload is persisted durably. No data loss.
        const isInboundToolResult = msg.role === 'tool' || msg.role === 'tool_result' || msg.role === 'toolResult';
        if (isInboundToolResult && neutral.toolResults && neutral.toolResults.length > 0) {
          const windowTokens = await estimateWindowTokens(hm, agentId, sk);
          const effectiveBudget = computeEffectiveBudget(undefined);
          const windowPressure = windowTokens / effectiveBudget;

          // Error tool results are always preserved intact: they're small and
          // the model needs the error signal to understand what went wrong.
          const hasErrorResult = neutral.toolResults!.some(tr => tr.isError);

          // Only apply degradation / artifact capture above elevated pressure.
          if (windowPressure > 0.70) {
            const MAX_TOOL_RESULT_CHARS = 500;
            const highPressure = windowPressure > 0.85;
            const reason: 'wave_guard_pressure_high' | 'wave_guard_pressure_elevated' =
              highPressure ? 'wave_guard_pressure_high' : 'wave_guard_pressure_elevated';

            // For each non-error tool result, persist the full payload as a
            // durable artifact first, then rewrite the transcript entry to
            // either a full stub (high pressure) or a truncated stub with an
            // artifact pointer (elevated pressure).
            const rewrittenResults = await Promise.all(
              neutral.toolResults!.map(async tr => {
                if (tr.isError) return tr;
                const content =
                  typeof tr.content === 'string'
                    ? tr.content
                    : JSON.stringify(tr.content);

                // At elevated pressure, small payloads pass through unchanged.
                if (!highPressure && content.length <= MAX_TOOL_RESULT_CHARS) {
                  return tr;
                }

                let artifactId: string | undefined;
                try {
                  const record = await hm.recordToolArtifact(agentId, sk, {
                    toolName: tr.name || 'tool_result',
                    toolCallId: tr.callId || undefined,
                    isError: false,
                    payload: content,
                    summary: content.slice(0, 160),
                  });
                  artifactId = record.id;
                } catch (artErr) {
                  console.warn(
                    '[hypermem-plugin] tool artifact capture failed (non-fatal):',
                    (artErr as Error).message,
                  );
                }

                const summary = highPressure
                  ? `omitted at ${(windowPressure * 100).toFixed(0)}% window pressure`
                  : `truncated at ${(windowPressure * 100).toFixed(0)}% pressure: ${Math.ceil(content.length / 4)} tokens`;

                return {
                  ...tr,
                  content: formatToolChainStub({
                    name: tr.name || 'tool_result',
                    id: tr.callId || 'unknown',
                    status: 'ejected',
                    reason,
                    summary,
                    artifactId,
                  }),
                };
              }),
            );

            neutral = { ...neutral, toolResults: rewrittenResults };
            console.log(
              `[hypermem] ingest wave-guard: ${highPressure ? 'stubbed' : 'truncated'} toolResult (window pressure ${(windowPressure * 100).toFixed(0)}% > ${highPressure ? 85 : 70}%)${hasErrorResult ? ' + error results preserved' : ''} - full payload persisted to tool_artifacts`,
            );
          }
        }

        await hm.recordAssistantMessage(agentId, sk, neutral);
        return { ingested: true };
      } catch (err) {
        // Ingest failure is non-fatal — record is best-effort
        console.warn('[hypermem-plugin] ingest failed:', (err as Error).message);
        return { ingested: false };
      }
    },

    /**
     * Batch ingest: process multiple messages in a single call.
     *
     * Note: when afterTurn() is defined (which it is), the runtime calls
     * afterTurn instead of ingest/ingestBatch. This is here for interface
     * completeness and forward compatibility.
     */
    async ingestBatch({ sessionId, sessionKey, messages, isHeartbeat }): Promise<IngestBatchResult> {
      if (isHeartbeat) {
        return { ingestedCount: 0 };
      }

      let ingestedCount = 0;
      try {
        const hm = await getHyperMem();
        const sk = resolveSessionKey(sessionId, sessionKey);
        const agentId = extractAgentId(sk);

        for (const message of messages) {
          const msg = message as unknown as InboundMessage;
          if (msg.role === 'system') continue;

          const neutral = toNeutralMessage(msg);
          if (neutral.role === 'user' && !neutral.toolResults?.length) {
            await hm.recordUserMessage(agentId, sk, stripMessageMetadata(neutral.textContent ?? ''));
          } else {
            await hm.recordAssistantMessage(agentId, sk, neutral);
          }
          ingestedCount++;
        }
      } catch (err) {
        console.warn('[hypermem-plugin] ingestBatch failed:', (err as Error).message);
      }

      return { ingestedCount };
    },

    /**
     * Assemble model context from all four hypermem layers.
     *
     * The `messages` param contains the current conversation history from the
     * runtime. We pass the prompt (latest user message) as the retrieval query,
     * and let the compositor build the full context.
     *
     * Returns:
     *   messages       — full assembled message array for the model
     *   estimatedTokens — token count of assembled context
     *   systemPromptAddition — facts/recall/episodes injected before runtime system prompt
     */
    async assemble({ sessionId, sessionKey, messages, tokenBudget, prompt, model }): ReturnType<ContextEngine['assemble']> {
      // ── Tool-loop guard ──────────────────────────────────────────────────────
      // When the last message is a toolResult, the runtime is mid tool-loop:
      // the model already has full context from the initial turn assembly.
      // Re-running the full compose pipeline here is wasteful and, in long
      // tool loops, causes cumulative context growth that triggers preemptive
      // context overflow. Pass the messages through as-is.
      //
      // Matches OpenClaw's legacy behavior: the legacy engine's assemble() is a
      // pass-through that never re-injects context on tool-loop calls.
      const lastMsg = messages[messages.length - 1] as unknown as InboundMessage | undefined;
      const isToolLoop = lastMsg?.role === 'toolResult' || lastMsg?.role === 'tool';

      // Telemetry: emit one assembleTrace at entry. Path taxonomy:
      //   'subagent' - session key matches the subagent pattern
      //   'cold'     - normal full-assembly or tool-loop entry (a separate
      //                'replay' trace is emitted if the cache replay fast
      //                path is taken below)
      // Zero-cost when HYPERMEM_TELEMETRY !== '1'.
      //
      // Trim-ownership turn context (Sprint 2): the turnId is also used to
      // scope the shared trim-owner claim helper so duplicate steady-state
      // trims in a single assemble() turn can be detected and (under
      // NODE_ENV='development') throw loudly. We always allocate the turnId
      // and open the scope — the map write is cheap and keeps enforcement
      // active even when telemetry is off. The scope is closed in the
      // finally block wrapping the full assemble body below.
      const _asmSk = resolveSessionKey(sessionId, sessionKey);
      const _asmTurnId = nextTurnId();
      beginTrimOwnerTurn(_asmSk, _asmTurnId);
      if (telemetryEnabled()) {
        const _agentId = extractAgentId(_asmSk);
        const _entryPath: 'cold' | 'replay' | 'subagent' = _asmSk.includes('subagent:')
          ? 'subagent'
          : 'cold';
        assembleTrace({
          agentId: _agentId,
          sessionKey: _asmSk,
          turnId: _asmTurnId,
          path: _entryPath,
          toolLoop: isToolLoop,
          msgCount: messages.length,
        });
      }

      try {
      if (isToolLoop) {
        // Tool-loop turns: pass messages through unchanged but still:
        //   1. Run the trim guardrail — tool loops accumulate history as fast
        //      as regular turns, and the old path skipped trim entirely, leaving
        //      the compaction guard blind (received estimatedTokens=0).
        //   2. Return a real estimatedTokens = windowTokens + cached overhead,
        //      so the guard has accurate signal and can fire when needed.
        //
        // Fix (ingestion-wave): use pressure-tiered trim instead of fixed 80%.
        // At 91% with 5 parallel web_search calls incoming (~20-30% of budget),
        // a fixed 80% trim only frees 11% headroom — the wave overflows anyway
        // and results strip silently. Tier the trim target based on pre-trim
        // pressure so high-pressure sessions get real headroom before results land.
        const effectiveBudget = computeEffectiveBudget(tokenBudget, model);
        try {
          const hm = await getHyperMem();
          const sk = resolveSessionKey(sessionId, sessionKey);
          const agentId = extractAgentId(sk);

          // ── Image / heavy-content eviction pre-pass ──────────────────────
          // Evict stale image payloads and large tool results before measuring
          // pressure. This frees tokens without compaction — images alone can
          // account for 30%+ of context from a single screenshot 2 turns ago.
          const evictionCfg = _evictionConfig;
          const evictionEnabled = evictionCfg?.enabled !== false;
          let workingMessages: unknown[] = messages;
          if (evictionEnabled) {
            const { messages: evicted, stats: evStats } = evictStaleContent(messages, {
              imageAgeTurns: evictionCfg?.imageAgeTurns,
              toolResultAgeTurns: evictionCfg?.toolResultAgeTurns,
              minTokensToEvict: evictionCfg?.minTokensToEvict,
              keepPreviewChars: evictionCfg?.keepPreviewChars,
            });
            workingMessages = evicted;
            if (evStats.tokensFreed > 0) {
              console.log(
                `[hypermem] eviction: ${evStats.imagesEvicted} images, ` +
                `${evStats.toolResultsEvicted} tool results, ` +
                `~${evStats.tokensFreed.toLocaleString()} tokens freed`
              );
            }
          }

          // Measure pressure from the in-memory message array we are actually about
          // to shape and return. Redis remains a cross-check only.
          const runtimeTokens = estimateMessageArrayTokens(workingMessages as unknown[]);
          const redisTokens = await estimateWindowTokens(hm, agentId, sk);
          const replayRecovery = decideReplayRecovery({
            currentState: normalizeReplayRecoveryState(await hm.cache.getSlot(agentId, sk, 'replayRecoveryState').catch(() => '')),
            runtimeTokens,
            redisTokens,
            effectiveBudget,
          });
          const replayMarkerText = replayRecovery.emittedText;
          const preTrimTokens = runtimeTokens;
          const pressure = preTrimTokens / effectiveBudget;

          // Pressure-tiered trim targets use a single authority: the working
          // message array. Redis drift is logged as an anomaly, never used as
          // a trim trigger. Replay recovery gets its own explicit bounded mode
          // instead of sharing the steady-state pressure heuristics.
          let trimTarget: number;
          if (typeof replayRecovery.trimTargetOverride === 'number') {
            trimTarget = replayRecovery.trimTargetOverride;
          } else if (pressure > 0.85) {
            trimTarget = 0.40; // critical: 60% headroom for incoming wave
          } else if (pressure > 0.80) {
            trimTarget = 0.50; // high: 50% headroom
          } else if (pressure > 0.75) {
            trimTarget = 0.55; // elevated: 45% headroom
          } else {
            trimTarget = 0.65; // normal: 35% headroom
          }

          const trimBudget = Math.floor(effectiveBudget * trimTarget);
          // Steady-state trim owner claim (Sprint 2.2a): route through the
          // shared helper keyed by (sessionKey, turnId). In development a
          // duplicate steady-state trim in the same assemble() turn throws.
          // In non-development a duplicate returns false; the real trim +
          // its `event:'trim'` emission are gated on the successful claim so
          // a duplicate claim is actually suppressed, not just warned.
          // Compact.* paths are exempt; this path is assemble-owned.
          const toolLoopClaimed = claimTrimOwner(sk, _asmTurnId, 'assemble.toolLoop');
          let trimmed = 0;
          let toolLoopCacheInvalidated = false;
          if (toolLoopClaimed) {
            trimmed = await hm.cache.trimHistoryToTokenBudget(agentId, sk, trimBudget);
            if (trimmed > 0) {
              await hm.cache.invalidateWindow(agentId, sk);
              toolLoopCacheInvalidated = true;
            }
            if (telemetryEnabled()) {
              const postTrimTokens = await estimateWindowTokens(hm, agentId, sk).catch(() => 0);
              trimTelemetry({
                path: 'assemble.toolLoop',
                agentId, sessionKey: sk,
                preTokens: preTrimTokens,
                postTokens: postTrimTokens,
                removed: trimmed,
                cacheInvalidated: toolLoopCacheInvalidated,
                reason: `pressure=${(pressure * 100).toFixed(1)}%`,
              });
            }
          } else if (telemetryEnabled()) {
            // Surface the suppressed-duplicate as a bounded guard record so
            // downstream reporting can see how often the gate fires. No
            // history or window mutation here.
            guardTelemetry({
              path: 'assemble.toolLoop',
              agentId, sessionKey: sk,
              reason: 'duplicate-claim-suppressed',
            });
          }

          // Also trim the messages array itself to match the budget.
          // Redis trim clears the *next* turn's window. This turn's messages are
          // still the full runtime array — if we return them unchanged at 94%,
          // OpenClaw strips tool results before sending to the model regardless
          // of what estimatedTokens says. We need to return a slimmer array now.
          //
          // Strategy: keep system/identity messages at the front, then fill from
          // the back (most recent) until we hit trimBudget. Drop the middle.
          let trimmedMessages = workingMessages;
          if (pressure > trimTarget) {
            const msgArray = workingMessages as unknown as Array<Record<string, unknown>>;
            // Separate system messages (always keep) from conversation turns
            const systemMsgs = msgArray.filter(m => m.role === 'system');
            const convMsgs = msgArray.filter(m => m.role !== 'system');
            // Pre-process: inline-truncate large tool results before budget-fill drop.
            // A message with a 40k-token tool result that barely misses budget gets dropped
            // entirely. Replacing with a placeholder keeps the turn's metadata in context
            // while freeing the bulk of the tokens.
            const MAX_INLINE_TOOL_CHARS = 2000; // ~500 tokens
            // FIX (Bug 3): handle both NeutralMessage format (m.toolResults) and
            // OpenClaw native format (m.content array with type='tool_result' blocks).
            // Old guard `if (!m.toolResults)` skipped every native-format message.
            // Also fixed: replacement must be valid NeutralToolResult { callId, name, content },
            // not { type, text } which breaks pair-integrity downstream.
            const processedConvMsgs = convMsgs.map(m => {
              // NeutralMessage format
              if (m.toolResults) {
                const resultStr = JSON.stringify(m.toolResults);
                if (resultStr.length <= MAX_INLINE_TOOL_CHARS) return m;
                const firstResult = (m.toolResults as Array<Record<string,unknown>>)[0];
                return {
                  ...m,
                  toolResults: [{
                    callId: firstResult?.callId ?? 'unknown',
                    name:   firstResult?.name   ?? 'tool',
                    content: `[tool result truncated: ${Math.ceil(resultStr.length / 4)} tokens]`,
                  }],
                };
              }
              // OpenClaw native format
              if (Array.isArray(m.content)) {
                const content = m.content as Array<Record<string,unknown>>;
                const hasLarge = content.some(c => {
                  if (c.type !== 'tool_result') return false;
                  const val = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
                  return val.length > MAX_INLINE_TOOL_CHARS;
                });
                if (!hasLarge) return m;
                return {
                  ...m,
                  content: content.map(c => {
                    if (c.type !== 'tool_result') return c;
                    const val = typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? '');
                    if (val.length <= MAX_INLINE_TOOL_CHARS) return c;
                    return { ...c, content: `[tool result truncated: ${Math.ceil(val.length / 4)} tokens]` };
                  }),
                };
              }
              return m;
            });
            // Fill from the back within budget
            let budget = trimBudget;
            // Reserve tokens for system messages using the same accounting
            // function as the final composed-array estimate.
            for (const sm of systemMsgs) {
              budget -= estimateMessageTokens(sm);
            }
            const msgCost = (m: Record<string, unknown>): number => estimateMessageTokens(m);

            const clusters = clusterTranscriptMessages(processedConvMsgs as Array<Record<string, unknown>>);
            const keptClusters: Array<Array<Record<string, unknown>>> = [];
            const tailCluster = clusters.length > 0 ? clusters[clusters.length - 1] : [];
            if (tailCluster.length > 0) {
              budget -= tailCluster.reduce((sum, msg) => sum + msgCost(msg), 0);
              keptClusters.unshift(tailCluster);
            }

            for (let i = clusters.length - 2; i >= 0 && budget > 0; i--) {
              const cluster = clusters[i];
              const clusterCost = cluster.reduce((sum, msg) => sum + msgCost(msg), 0);
              if (budget - clusterCost >= 0) {
                keptClusters.unshift(cluster);
                budget -= clusterCost;
              }
            }

            const kept = keptClusters.flat();
            const keptCount = processedConvMsgs.length - kept.length;
            if (keptCount > 0) {
              console.log(
                `[hypermem-plugin] tool-loop trim: pressure=${(pressure * 100).toFixed(1)}% → ` +
                `target=${(trimTarget * 100).toFixed(0)}% (redis=${trimmed} msgs, messages=${keptCount} dropped)`
              );
              trimmedMessages = [...systemMsgs, ...kept] as unknown as typeof messages;
            } else if (trimmed > 0) {
              console.log(
                `[hypermem-plugin] tool-loop trim: pressure=${(pressure * 100).toFixed(1)}% → ` +
                `target=${(trimTarget * 100).toFixed(0)}% (redis=${trimmed} msgs)`
              );
            }
          } else if (trimmed > 0) {
            console.log(
              `[hypermem-plugin] tool-loop trim: pressure=${(pressure * 100).toFixed(1)}% → ` +
              `target=${(trimTarget * 100).toFixed(0)}% (redis=${trimmed} msgs)`
            );
          }

          // Apply tool gradient to compress large tool results before returning.
          // Skip if deferToolPruning is enabled — OpenClaw's contextPruning handles it.
          if (!_deferToolPruning) {
          // The full compose path runs applyToolGradientToWindow during reshaping;
          // the tool-loop path was previously skipping this, leaving a 40k-token
          // web_search result uncompressed every turn.
          try {
            const gradientApplied = applyToolGradientToWindow(
              trimmedMessages as unknown as NeutralMessage[],
              trimBudget
            );
            trimmedMessages = gradientApplied as unknown as typeof trimmedMessages;
          } catch {
            // Non-fatal: if gradient fails, continue with untouched trimmedMessages
          }
          } // end deferToolPruning gate

          // Repair orphaned tool pairs in the trimmed message list.
          // In-memory trim (cluster drop) can strand tool_result messages whose
          // paired tool_use was in a dropped cluster.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          trimmedMessages = repairToolPairs(trimmedMessages as unknown as any[]) as unknown as typeof trimmedMessages;

          const composedTokens = estimateMessageArrayTokens(trimmedMessages as unknown[]);
          maybeLogPressureAccountingAnomaly({
            path: 'assemble.toolLoop',
            agentId,
            sessionKey: sk,
            runtimeTokens: preTrimTokens,
            redisTokens,
            composedTokens,
            budget: effectiveBudget,
          });
          await persistReplayRecoveryState(hm, agentId, sk, replayRecovery.nextState);
          degradationTelemetry({
            agentId,
            sessionKey: sk,
            turnId: _asmTurnId,
            path: 'toolLoop',
            toolChainCoEjections: 0,
            toolChainStubReplacements: 0,
            artifactDegradations: 0,
            replayState: replayRecovery.emittedMarker?.state,
            replayReason: replayRecovery.emittedMarker?.reason,
          });
          const overhead = _overheadCache.get(sk) ?? getOverheadFallback();
          return {
            messages: trimmedMessages as any,
            estimatedTokens: composedTokens + overhead,
            systemPromptAddition: replayMarkerText || undefined,
          };
        } catch {
          // Non-fatal: return conservative estimate so guard doesn't go blind
          return {
            messages: messages as any,
            estimatedTokens: Math.floor(effectiveBudget * 0.8),
          };
        }
      }

      try {
      const hm = await getHyperMem();
      const sk = resolveSessionKey(sessionId, sessionKey);
      const agentId = extractAgentId(sk);

      // ── Subagent warming control ─────────────────────────────────────────
      // Detect subagent sessions by key pattern and apply warming mode.
      // 'off' = passthrough (no HyperMem context at all)
      // 'light' = facts + history only (skip library/wiki/semantic/keystones/doc chunks)
      // 'full' = standard compositor pipeline
      const isSubagent = sk.includes('subagent:');
      if (isSubagent && _subagentWarming === 'off') {
        console.log(`[hypermem-plugin] assemble: subagent warming=off, passthrough (sk: ${sk})`);
        return {
          messages: messages as any,
          estimatedTokens: estimateMessageArrayTokens(messages as unknown[]),
        };
      }
      if (isSubagent) {
        console.log(`[hypermem-plugin] assemble: subagent warming=${_subagentWarming} (sk: ${sk})`);
      }

      // Resolve agent tier from fleet store (for doc chunk tier filtering)
      let tier: string | undefined;
      try {
        const agent = _fleetStore?.getAgent(agentId);
        tier = agent?.tier;
      } catch {
        // Non-fatal — tier filtering just won't apply
      }

      // historyDepth: derive a safe message count from the token budget.
      // Uses 50% of the budget for history (down from 60% — more budget goes to
      // L3/L4 context slots now). Floor at 50, ceiling at 200.
      // This is a preventive guard — the compositor's safety valve still trims
      // by token count post-assembly, but limiting depth up front avoids
      // feeding the compactor a window it can't reduce.
      const effectiveBudget = computeEffectiveBudget(tokenBudget, model);
      const historyDepth = Math.min(250, Math.max(50, Math.floor((effectiveBudget * 0.65) / 500)));
      const runtimeEntryTokens = estimateMessageArrayTokens(messages as unknown[]);
      const redisEntryTokens = await estimateWindowTokens(hm, agentId, sk);
      const replayRecovery = decideReplayRecovery({
        currentState: normalizeReplayRecoveryState(await hm.cache.getSlot(agentId, sk, 'replayRecoveryState').catch(() => '')),
        runtimeTokens: runtimeEntryTokens,
        redisTokens: redisEntryTokens,
        effectiveBudget,
      });
      const replayHistoryDepth = replayRecovery.active && replayRecovery.historyDepthCap
        ? Math.min(historyDepth, replayRecovery.historyDepthCap)
        : historyDepth;

      // ── Redis guardrail: trim history to token budget ────────────────────
      // Prevents model-switch bloat: if an agent previously ran on a larger
      // context window, Redis history may exceed the current model's budget.
      // Trimming here (before compose) ensures the compositor never sees a
      // history window it can't fit.
      //
      // Sprint 3 (AfterTurn Rebuild/Trim Loop Fix): the assemble.normal trim now
      // first checks whether the window is already within trimBudget. When
      // afterTurn's refreshRedisGradient caps the rebuilt window at the same
      // 0.65 fraction (Sprint 3 compositor fix), the steady-state path will
      // find preTokens <= trimBudget and skip the trim entirely. The trim only
      // fires when real excess exists (pressure spikes, model switch, cold start),
      // breaking the unconditional afterTurn→assemble trim churn loop.
      //
      // B3: Batch trim with growth allowance.
      // Trim only fires when the window has grown past the soft target by more
      // than TRIM_GROWTH_THRESHOLD (5%). When it does fire, trim to
      // softTarget * (1 - TRIM_HEADROOM_FRACTION) so the window has room to
      // grow for several turns before the next trim fires. This eliminates
      // per-turn trim churn from minor natural growth (short assistant replies,
      // small tool outputs) while still catching genuine pressure spikes.
      try {
        const {
          softBudget: trimSoftBudget,
          triggerBudget: trimTriggerBudget,
          targetBudget: trimTargetBudget,
        } = resolveTrimBudgets(effectiveBudget);
        // Always read preTokens so we can make the skip decision and emit telemetry.
        const preTokensNormal = await estimateWindowTokens(hm, agentId, sk).catch(() => 0);
        const normalPath: TrimTelemetryPath = isSubagent ? 'assemble.subagent' : 'assemble.normal';

        // B3: Skip trim when window is within the growth-allowance envelope.
        // This replaces the Sprint 3 `windowAlreadyFits` check (which only
        // skipped at exactly ≤ softTarget). The growth allowance lets the
        // window float up to +5% before triggering, avoiding trim on every
        // turn that ends a few tokens above 65%.
        const withinGrowthEnvelope = preTokensNormal > 0 && preTokensNormal <= trimTriggerBudget;
        if (withinGrowthEnvelope) {
          if (telemetryEnabled()) {
            guardTelemetry({
              path: normalPath,
              agentId, sessionKey: sk,
              reason: 'window-within-budget-skip',
            });
          }
        } else {
          // Steady-state trim owner claim (Sprint 2.2a): route assemble.normal
          // and assemble.subagent through the shared helper keyed by
          // (sessionKey, _asmTurnId). The real trim + its `event:'trim'`
          // emission are gated on the claim so a duplicate steady-state claim
          // in the same turn is actually suppressed in production, not just
          // warned. In development the duplicate throws.
          const normalClaimed = claimTrimOwner(sk, _asmTurnId, normalPath);
          if (normalClaimed) {
            // B3: trim to the headroom target (below soft target) so the
            // window has room to grow before the next trim fires.
            const trimmed = await hm.cache.trimHistoryToTokenBudget(agentId, sk, trimTargetBudget);
            let normalCacheInvalidated = false;
            if (trimmed > 0) {
              // Invalidate window cache since history changed
              await hm.cache.invalidateWindow(agentId, sk);
              normalCacheInvalidated = true;
            }
            if (telemetryEnabled()) {
              const postTokensNormal = await estimateWindowTokens(hm, agentId, sk).catch(() => 0);
              trimTelemetry({
                path: normalPath,
                agentId, sessionKey: sk,
                preTokens: preTokensNormal,
                postTokens: postTokensNormal,
                removed: trimmed,
                cacheInvalidated: normalCacheInvalidated,
                reason: `b3:trigger=${trimTriggerBudget},target=${trimTargetBudget}`,
              });
            }
          } else if (telemetryEnabled()) {
            guardTelemetry({
              path: normalPath,
              agentId, sessionKey: sk,
              reason: 'duplicate-claim-suppressed',
            });
          }
        }
      } catch (trimErr) {
        // Non-fatal — compositor's budget-fit walk is the second line of defense
        console.warn('[hypermem-plugin] assemble: Redis trim failed (non-fatal):', (trimErr as Error).message);
      }

      // ── Budget downshift: proactive reshape pass ───────────────────────────────────────
      // If this session previously composed at a higher token budget (e.g. gpt-5.4
      // → claude-sonnet model switch), the Redis window is still sized for the old
      // budget. trimHistoryToTokenBudget above trims by count but skips tool
      // gradient logic. A downshift >10% triggers a full reshape: apply tool
      // gradient at the new budget + trim, then write back before compose runs.
      // This prevents several turns of compaction churn after a model switch.
      //
      // Bug fix: previously read from getWindow() which is always null here
      // (afterTurn invalidates it every turn). Also fixed: was doing setWindow()
      // then invalidateWindow() which is a write-then-delete no-op. Now reads
      // from history list and writes back via replaceHistory().
      let lastState: Awaited<ReturnType<typeof hm.cache.getModelState>> | null = null;
      try {
        lastState = await hm.cache.getModelState(agentId, sk);
        const DOWNSHIFT_THRESHOLD = 0.10;
        const isDownshift = lastState &&
          (lastState.tokenBudget - effectiveBudget) / lastState.tokenBudget > DOWNSHIFT_THRESHOLD;

        if (isDownshift && !_deferToolPruning) {
          // Sprint 2.2a: demote reshape to guard telemetry.
          //
          // Previously this branch re-ran applyToolGradientToWindow, wrote
          // back via replaceHistory, invalidated the window cache, and
          // stamped `reshapedAt` on model state. Assemble.* is the
          // steady-state owner, so the subsequent assemble.normal /
          // assemble.subagent trim (gated by claimTrimOwner) handles any
          // real downshift pressure. Keeping the detection branch preserves
          // observability; guardTelemetry records the would-be-reshape
          // without mutating history, the window, or model state.
          //
          // CRITICAL: do NOT call setModelState({ reshapedAt, … }) here.
          // compact() skips when reshapedAt is recent, which would cause it
          // to skip on the strength of a reshape that never ran.
          guardTelemetry({
            path: 'reshape',
            agentId, sessionKey: sk,
            reason: 'reshape-downshift-demoted',
          });
        }
      } catch (reshapeErr) {
        // Non-fatal — compositor safety valve is still the last defense
        console.warn('[hypermem-plugin] assemble: reshape pass failed (non-fatal):', (reshapeErr as Error).message);
      }

      // ── Cache replay fast path ─────────────────────────────────────────────
      // If the session was active recently, return the cached contextBlock
      // (systemPromptAddition) to produce a byte-identical system prompt and
      // hit the provider prefix cache (Anthropic / OpenAI).
      // The message window is always rebuilt fresh — only the compositor output
      // (contextBlock) is cached, since that's what determines prefix identity.
      const cacheReplayThresholdMs = _cacheReplayThresholdMs;
      let cachedContextBlock: string | null = null;
      if (cacheReplayThresholdMs > 0 && !replayRecovery.shouldSkipCacheReplay) {
        try {
          const cachedAt = await hm.cache.getSlot(agentId, sk, 'assemblyContextAt');
          if (cachedAt && Date.now() - parseInt(cachedAt) < cacheReplayThresholdMs) {
            cachedContextBlock = await hm.cache.getSlot(agentId, sk, 'assemblyContextBlock');
            if (cachedContextBlock) {
              console.log(`[hypermem-plugin] assemble: cache replay hit for ${agentId} (${Math.round((Date.now() - parseInt(cachedAt)) / 1000)}s old)`);
              if (telemetryEnabled()) {
                assembleTrace({
                  agentId,
                  sessionKey: sk,
                  turnId: _asmTurnId,
                  path: 'replay',
                  toolLoop: isToolLoop,
                  msgCount: messages.length,
                });
              }
            }
          }
        } catch {
          // Non-fatal — fall through to full assembly
        }
      }

            // Subagent light mode: skip library/wiki/semantic/keystones/doc chunks.
      // Keeps: system, identity, history, active facts, output profile, tool gradient.
      const subagentLight = isSubagent && _subagentWarming === 'light';

      const request: ComposeRequest = {
        agentId,
        sessionKey: sk,
        tokenBudget: effectiveBudget,
        historyDepth: lastState?.historyDepth && lastState.historyDepth < replayHistoryDepth
          ? lastState.historyDepth
          : replayHistoryDepth,
        tier,
        model,          // pass model for provider detection
        includeDocChunks: subagentLight ? false : !cachedContextBlock,  // skip doc retrieval on cache hit or subagent light
        includeLibrary: subagentLight ? false : undefined,  // skip wiki/knowledge/preferences
        includeSemanticRecall: subagentLight ? false : undefined,  // skip vector/FTS recall
        includeKeystones: subagentLight ? false : undefined,  // skip keystone history injection
        prompt,
        skipProviderTranslation: true,  // runtime handles provider translation
      };

      const result: ComposeResult = await hm.compose(request);

      degradationTelemetry({
        agentId,
        sessionKey: sk,
        turnId: _asmTurnId,
        path: 'compose',
        toolChainCoEjections: result.diagnostics?.toolChainCoEjections ?? 0,
        toolChainStubReplacements: result.diagnostics?.toolChainStubReplacements ?? 0,
        artifactDegradations: result.diagnostics?.artifactDegradations ?? 0,
        artifactOversizeThresholdTokens: result.diagnostics?.artifactOversizeThresholdTokens,
        replayState: replayRecovery.emittedMarker?.state,
        replayReason: replayRecovery.emittedMarker?.reason,
      });

      // Use cached contextBlock if available (cache replay), otherwise use fresh result.
      // After a full compose, write the new contextBlock to cache for the next turn.
      if (cachedContextBlock) {
        result.contextBlock = cachedContextBlock;
      } else if (result.contextBlock && cacheReplayThresholdMs > 0 && !replayRecovery.shouldSkipCacheReplay && !replayRecovery.emittedText) {
        // Write cache async — never block the assemble() return on this
        const blockToCache = result.contextBlock;
        const nowStr = Date.now().toString();
        const ttlSec = Math.ceil((cacheReplayThresholdMs * 2) / 1000);
        Promise.all([
          hm.cache.setSlot(agentId, sk, 'assemblyContextBlock', blockToCache),
          hm.cache.setSlot(agentId, sk, 'assemblyContextAt', nowStr),
        ]).then(() => {
          // Extend TTL on the cached keys to 2× the threshold
          // setSlot uses the sessionTTL from RedisLayer config — acceptable fallback
        }).catch(() => { /* Non-fatal */ });
      }

      if (replayRecovery.emittedText) {
        result.contextBlock = result.contextBlock
          ? `${result.contextBlock}
${replayRecovery.emittedText}`
          : replayRecovery.emittedText;
      }

      // Convert NeutralMessage[] → AgentMessage[] for the OpenClaw runtime.
      // neutralToAgentMessage can return a single message or an array (tool results
      // expand to individual ToolResultMessage objects), so we flatMap.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let outputMessages = result.messages
        .filter(m => m.role != null)
        .flatMap(m => neutralToAgentMessage(m as unknown as NeutralMessage)) as unknown as any[];

      const neutralPairStats = collectNeutralToolPairStats(result.messages as unknown as NeutralMessage[]);
      const agentPairStats = collectAgentToolPairStats(outputMessages as InboundMessage[]);
      const toolPairAnomaly =
        neutralPairStats.missingToolResultCount > 0 ||
        neutralPairStats.orphanToolResultCount > 0 ||
        agentPairStats.missingToolResultCount > 0 ||
        agentPairStats.orphanToolResultCount > 0 ||
        agentPairStats.syntheticNoResultCount > 0
          ? {
              stage: 'assemble',
              neutralMissingToolResultIds: neutralPairStats.missingToolResultIds.slice(0, 10),
              neutralOrphanToolResultIds: neutralPairStats.orphanToolResultIds.slice(0, 10),
              agentMissingToolResultIds: agentPairStats.missingToolResultIds.slice(0, 10),
              agentOrphanToolResultIds: agentPairStats.orphanToolResultIds.slice(0, 10),
              syntheticNoResultCount: agentPairStats.syntheticNoResultCount,
            }
          : undefined;

      await bumpToolPairMetrics(hm, agentId, sk, {
        composeCount: 1,
        preBridgeMissingToolResults: neutralPairStats.missingToolResultCount,
        preBridgeOrphanToolResults: neutralPairStats.orphanToolResultCount,
        postBridgeMissingToolResults: agentPairStats.missingToolResultCount,
        postBridgeOrphanToolResults: agentPairStats.orphanToolResultCount,
      }, toolPairAnomaly);

      if (toolPairAnomaly) {
        console.warn(
          `[hypermem-plugin] tool-pair-integrity: ${agentId}/${sk} ` +
          `neutralMissing=${neutralPairStats.missingToolResultCount} neutralOrphan=${neutralPairStats.orphanToolResultCount} ` +
          `agentMissing=${agentPairStats.missingToolResultCount} agentOrphan=${agentPairStats.orphanToolResultCount} ` +
          `synthetic=${agentPairStats.syntheticNoResultCount}`
        );
      }

      // Repair orphaned tool pairs before returning to provider.
      // compaction/trim passes can remove tool_use blocks without removing their
      // paired tool_result messages — Anthropic and Gemini reject these with 400.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      outputMessages = repairToolPairs(outputMessages as any) as typeof outputMessages;

      // Cache overhead for tool-loop turns: contextBlock tokens (chars/4) +
      // tier-aware estimate for runtime system prompt (SOUL.md, identity,
      // workspace files — not visible from inside the plugin).
      const contextBlockTokens = Math.ceil((result.contextBlock?.length ?? 0) / 4);
      const runtimeSystemTokens = getOverheadFallback(tier);
      _overheadCache.set(sk, contextBlockTokens + runtimeSystemTokens);

      await persistReplayRecoveryState(hm, agentId, sk, replayRecovery.nextState);

      // Update model state for downshift detection on next turn
      try {
        await hm.cache.setModelState(agentId, sk, {
          model: model ?? 'unknown',
          tokenBudget: effectiveBudget,
          composedAt: new Date().toISOString(),
          historyDepth,
        });
      } catch {
        // Non-fatal
      }

      return {
        messages: outputMessages,
        estimatedTokens: result.tokenCount ?? 0,
        // systemPromptAddition injects hypermem context before the runtime system prompt.
        // This is the facts/recall/episodes block assembled by the compositor.
        systemPromptAddition: result.contextBlock || undefined,
      };
      } catch (err) {
        console.error('[hypermem-plugin] assemble error (stack):', (err as Error).stack ?? err);
        throw err; // Re-throw so the runtime falls back to legacy pipeline
      }
      } finally {
        // End the trim-owner turn scope opened at assemble entry. Paired
        // with beginTrimOwnerTurn(_asmSk, _asmTurnId) above; runs on every
        // exit path (normal return, tool-loop return, replay return, error
        // re-throw). Turn-scoped keying (Sprint 2.2a) means this only
        // removes THIS turn's slot, so concurrent same-session turns remain
        // isolated instead of clobbering each other.
        endTrimOwnerTurn(_asmSk, _asmTurnId);
      }
    },

    /**
     * Compact context. hypermem owns compaction.
     *
     * Strategy: assemble() already trims the composed message list to the token
     * budget via the compositor safety valve, so the model never receives an
     * oversized context. compact() is called by the runtime when it detects
     * overflow — at that point we:
     *   1. Estimate tokens in the current Redis history window
     *   2. If already under budget (compositor already handled it), report clean
     *   3. If over budget (e.g. window was built before budget cap was applied),
     *      trim the Redis window to a safe depth and invalidate the compose cache
     *
     * This prevents the runtime from running its own LLM-summarization compaction
     * pass, which would destroy message history we're explicitly managing.
     */
    async compact({ sessionId, sessionKey, sessionFile, tokenBudget, currentTokenCount }): ReturnType<ContextEngine['compact']> {
      try {
        const hm = await getHyperMem();
        const sk = resolveSessionKey(sessionId, sessionKey);
        const agentId = extractAgentId(sk);

        // Skip if a reshape pass just ran (within last 30s) — avoid double-processing
        // Cache modelState here for reuse in density-aware JSONL truncation below.
        let cachedModelState: Awaited<ReturnType<typeof hm.cache.getModelState>> | null = null;
        let model: string | undefined;
        try {
          cachedModelState = await hm.cache.getModelState(agentId, sk);
          model = cachedModelState?.model;
          if (cachedModelState?.reshapedAt) {
            const reshapeAge = Date.now() - new Date(cachedModelState.reshapedAt).getTime();
            // Only skip if session is NOT critically full — nuclear path must bypass this guard.
            // If currentTokenCount > 85% budget, fall through to nuclear compaction below.
            const isCriticallyFull = currentTokenCount != null &&
              currentTokenCount > (computeEffectiveBudget(tokenBudget, model) * 0.85);
            if (reshapeAge < 30_000 && !isCriticallyFull) {
              console.log(`[hypermem-plugin] compact: skipping — reshape pass ran ${reshapeAge}ms ago`);
              return { ok: true, compacted: false, reason: 'reshape-recently-ran' };
            }
          }
        } catch {
          // Non-fatal — proceed with compaction
        }

        // Re-estimate from the actual Redis window.
        // The runtime's estimate (currentTokenCount) includes the full inbound message
        // and system prompt — our estimate only covers the history window. When they
        // diverge significantly upward, the difference is "inbound overhead" consuming
        // budget the history is competing for. We trim history to make room.
        const effectiveBudget = computeEffectiveBudget(tokenBudget, model);
        const tokensBefore = await estimateWindowTokens(hm, agentId, sk);

        // Target depth for both Redis trimming and JSONL truncation.
        // Target 50% of budget capacity, assume ~500 tokens/message average.
        const targetDepth = Math.max(20, Math.floor((effectiveBudget * 0.5) / 500));

        // ── NUCLEAR COMPACTION ────────────────────────────────────────────────
        // When the runtime reports the session is ≥85% full, trust that signal
        // over our Redis estimate. The JSONL accumulates full tool results that
        // the gradient never sees, so Redis can look fine while the transcript
        // is genuinely saturated. Normal compact() returns compacted=false in
        // this scenario ("within_budget"), which gives the runtime zero relief.
        //
        // Also triggered when reshape ran recently but the session is still
        // critically full — bypass the reshape guard in that case.
        const NUCLEAR_THRESHOLD = 0.85;
        const isNuclear = currentTokenCount != null && currentTokenCount > effectiveBudget * NUCLEAR_THRESHOLD;
        if (isNuclear) {
          // Cut deep: target 20% of normal depth = ~25 messages for a 128k session.
          // Keeps very recent context, clears the long tool-heavy tail.
          const nuclearDepth = Math.max(10, Math.floor(targetDepth * 0.20));
          const nuclearBudget = Math.floor(effectiveBudget * 0.25);
          const nuclearRemoved = await hm.cache.trimHistoryToTokenBudget(agentId, sk, nuclearBudget);
          await hm.cache.invalidateWindow(agentId, sk).catch(() => {});
          await truncateJsonlIfNeeded(sessionFile, nuclearDepth, true);
          const tokensAfter = await estimateWindowTokens(hm, agentId, sk);
          if (telemetryEnabled()) {
            trimTelemetry({
              path: 'compact.nuclear',
              agentId, sessionKey: sk,
              preTokens: tokensBefore,
              postTokens: tokensAfter,
              removed: nuclearRemoved,
              cacheInvalidated: true,
              reason: `currentTokenCount=${currentTokenCount}/${effectiveBudget}`,
            });
          }
          console.log(
            `[hypermem-plugin] compact: NUCLEAR — session at ${currentTokenCount}/${effectiveBudget} tokens ` +
            `(${Math.round((currentTokenCount / effectiveBudget) * 100)}% full), ` +
            `deep-trimmed JSONL to ${nuclearDepth} messages, Redis ${tokensBefore}→${tokensAfter} tokens`
          );
          return { ok: true, compacted: true, result: { tokensBefore, tokensAfter } };
        }
        // ── END NUCLEAR ───────────────────────────────────────────────────────

        // Detect large-inbound-content scenario: runtime total significantly exceeds
        // our history estimate. The gap is the inbound message + system prompt overhead.
        // Trim history to leave room for it even if history alone is within budget.
        if (currentTokenCount != null && currentTokenCount > tokensBefore) {
          const inboundOverhead = currentTokenCount - tokensBefore;
          if (inboundOverhead > effectiveBudget * 0.15) {
            // Large inbound content (document review, big tool result, etc.)
            // Trim history so history + inbound fits within 85% of budget.
            const budgetForHistory = Math.floor(effectiveBudget * 0.85) - inboundOverhead;
            if (budgetForHistory < tokensBefore && budgetForHistory > 0) {
              const historyTrimmed = await hm.cache.trimHistoryToTokenBudget(agentId, sk, budgetForHistory);
              await hm.cache.invalidateWindow(agentId, sk).catch(() => {});
              const tokensAfter = await estimateWindowTokens(hm, agentId, sk);
              await truncateJsonlIfNeeded(sessionFile, targetDepth);
              if (telemetryEnabled()) {
                trimTelemetry({
                  path: 'compact.history',
                  agentId, sessionKey: sk,
                  preTokens: tokensBefore,
                  postTokens: tokensAfter,
                  removed: historyTrimmed,
                  cacheInvalidated: true,
                  reason: `inbound-overhead=${inboundOverhead}`,
                });
              }
              console.log(
                `[hypermem-plugin] compact: large-inbound-content (gap=${inboundOverhead} tokens), ` +
                `trimmed history ${tokensBefore}→${tokensAfter} (budget-for-history=${budgetForHistory}, trimmed=${historyTrimmed} messages)`
              );
              return { ok: true, compacted: true, result: { tokensBefore, tokensAfter } };
            }
          }
        }

        // Under 70% of budget by our own Redis estimate.
        // We still need to check the JSONL — the runtime's overflow is based on JSONL
        // message count, not Redis. If the JSONL is bloated (> targetDepth * 1.5 messages)
        // we truncate it even if Redis looks fine, then return compacted=true so the
        // runtime retries with the trimmed file instead of killing the session.
        if (tokensBefore <= effectiveBudget * 0.7) {
          const jsonlTruncated = await truncateJsonlIfNeeded(sessionFile, targetDepth);
          if (jsonlTruncated) {
            console.log(`[hypermem-plugin] compact: Redis within_budget but JSONL was bloated — truncated to ${targetDepth} messages`);
            return {
              ok: true,
              compacted: true,
              result: { tokensBefore, tokensAfter: tokensBefore },
            };
          }
          return {
            ok: true,
            compacted: false,
            reason: 'within_budget',
            result: { tokensBefore, tokensAfter: tokensBefore },
          };
        }

        // Over budget: trim both the window cache AND the history list.
        // Bug fix: if no window cache exists (fresh/never-compacted session),
        // compact() was only trying to trim the window (which was null) and
        // the history list was left untouched → 0 actual trimming → timeout
        // compaction death spiral.
        const window = await hm.cache.getWindow(agentId, sk);
        if (window && window.length > targetDepth) {
          const trimmed = window.slice(-targetDepth);
          await hm.cache.setWindow(agentId, sk, trimmed);
        }

        // Always trim the underlying history list — this is the source of truth
        // when no window cache exists. trimHistoryToTokenBudget walks newest→oldest
        // and LTRIMs everything beyond the budget.
        const trimBudget = Math.floor(effectiveBudget * 0.5);
        const historyTrimmed = await hm.cache.trimHistoryToTokenBudget(agentId, sk, trimBudget);
        if (historyTrimmed > 0) {
          console.log(`[hypermem-plugin] compact: trimmed ${historyTrimmed} messages from history list`);
        }

        // Invalidate the compose cache so next assemble() re-builds from trimmed data
        await hm.cache.invalidateWindow(agentId, sk).catch(() => {});

        const tokensAfter = await estimateWindowTokens(hm, agentId, sk);
        if (telemetryEnabled()) {
          trimTelemetry({
            path: 'compact.history2',
            agentId, sessionKey: sk,
            preTokens: tokensBefore,
            postTokens: tokensAfter,
            removed: historyTrimmed,
            cacheInvalidated: true,
            reason: `over-budget tokensBefore=${tokensBefore}/${effectiveBudget}`,
          });
        }
        console.log(`[hypermem-plugin] compact: trimmed ${tokensBefore} → ${tokensAfter} tokens (budget: ${effectiveBudget})`);

        // Density-aware JSONL truncation: derive target depth from actual avg tokens/message
        // rather than assuming a fixed 500 tokens/message. This prevents a large-message
        // session (e.g. 145 msgs × 882 tok = 128k) from bypassing the 1.5x guard and
        // leaving the JSONL untouched while Redis is correctly trimmed.
        // force=true bypasses the 1.5x early-exit — over-budget always rewrites.
        const histDepth = cachedModelState?.historyDepth ?? targetDepth;
        const avgTokPerMsg = histDepth > 0 && tokensBefore > 0 ? tokensBefore / histDepth : 500;
        const densityTargetDepth = Math.max(10, Math.floor(trimBudget / avgTokPerMsg));
        await truncateJsonlIfNeeded(sessionFile, densityTargetDepth, true);
        console.log(`[hypermem-plugin] compact: JSONL density-trim targetDepth=${densityTargetDepth} (histDepth=${histDepth}, avg=${Math.round(avgTokPerMsg)} tok/msg)`);

        return {
          ok: true,
          compacted: true,
          result: { tokensBefore, tokensAfter },
        };
      } catch (err) {
        console.warn('[hypermem-plugin] compact failed:', (err as Error).message);
        // Non-fatal: return ok so the runtime doesn't retry with its own compaction
        return { ok: true, compacted: false, reason: (err as Error).message };
      }
    },

    /**
     * After-turn hook: ingest new messages then trigger background indexer.
     *
     * IMPORTANT: When afterTurn is defined, the runtime calls ONLY afterTurn —
     * it never calls ingest() or ingestBatch(). So we must ingest the new
     * messages here, using messages.slice(prePromptMessageCount).
     */
    async afterTurn({ sessionId, sessionKey, messages, prePromptMessageCount, isHeartbeat, runtimeContext }): Promise<void> {
      if (isHeartbeat) return;

      try {
        const hm = await getHyperMem();
        const sk = resolveSessionKey(sessionId, sessionKey);
        const agentId = extractAgentId(sk);

        // Ingest only the new messages produced this turn
        const newMessages = messages.slice(prePromptMessageCount);
        for (const msg of newMessages) {
          const m = msg as unknown as InboundMessage;
          // Skip system messages — they come from the runtime, not the conversation
          if (m.role === 'system') continue;

          if (m.role === 'toolResult' && extractTextFromInboundContent(m.content).trim() === SYNTHETIC_MISSING_TOOL_RESULT_TEXT) {
            const toolCallId = typeof m.toolCallId === 'string' ? m.toolCallId : 'unknown';
            const toolName = typeof m.toolName === 'string' ? m.toolName : 'unknown';
            await bumpToolPairMetrics(hm, agentId, sk, { syntheticNoResultIngested: 1 }, {
              stage: 'afterTurn',
              toolCallId,
              toolName,
            });
            console.warn(
              `[hypermem-plugin] tool-pair-integrity: observed synthetic missing tool result for ${agentId}/${sk} ` +
              `tool=${toolName} callId=${toolCallId}`
            );
          }

          const neutral = toNeutralMessage(m);
          if (neutral.role === 'user' && !neutral.toolResults?.length) {
            // Record plain user messages here and strip transport envelope metadata
            // before storage so prompt wrappers like:
            //   Sender (untrusted metadata): { ... }
            // never enter messages.db / Redis history / downstream facts.
            //
            // recordUserMessage() also strips defensively at core level, but we do
            // it here too so the intended behavior is explicit at the plugin boundary.
            //
            // IMPORTANT: tool results arrive as role='user' carriers (toNeutralMessage
            // sets role='user' + toolResults=[...] + textContent=null). These MUST go
            // through recordAssistantMessage to persist the toolResults array.
            // recordUserMessage takes a plain string and would silently discard them.
            await hm.recordUserMessage(agentId, sk, stripMessageMetadata(neutral.textContent ?? ''));
          } else {
            await hm.recordAssistantMessage(agentId, sk, neutral, {
              tokenCount: neutral.role === 'assistant' ? resolveAssistantTokenCount(m, runtimeContext) : undefined,
            });
          }
        }

        // P3.1: Topic detection on the inbound user message
        // Non-fatal: topic detection never blocks afterTurn
        try {
          const inboundUserMsg = newMessages
            .map(m => m as unknown as InboundMessage)
            .find(m => m.role === 'user');
          if (inboundUserMsg) {
            const neutralUser = toNeutralMessage(inboundUserMsg);
            // Gather recent messages for context (all messages before the new ones)
            const contextMessages = (messages.slice(0, prePromptMessageCount) as unknown as InboundMessage[])
              .filter(m => m.role !== 'system')
              .slice(-10)
              .map(m => toNeutralMessage(m));

            const db = hm.dbManager.getMessageDb(agentId);
            if (db) {
              const topicMap = new SessionTopicMap(db);
              const activeTopic = topicMap.getActiveTopic(sk);
              const signal = detectTopicShift(neutralUser, contextMessages, activeTopic?.id ?? null);

              if (signal.isNewTopic && signal.topicName) {
                const newTopicId = topicMap.createTopic(sk, signal.topicName);
                // New topic starts with count 1 (the message that triggered the shift)
                topicMap.incrementMessageCount(newTopicId);
                // Write topic_id onto the stored user message (best-effort)
                try {
                  const stored = db.prepare(`
                    SELECT m.id FROM messages m
                    JOIN conversations c ON c.id = m.conversation_id
                    WHERE c.session_key = ? AND m.role = 'user'
                    ORDER BY m.message_index DESC LIMIT 1
                  `).get(sk) as { id: number } | undefined;
                  if (stored) {
                    db.prepare('UPDATE messages SET topic_id = ? WHERE id = ?')
                      .run(newTopicId, stored.id);
                  }
                } catch {
                  // Best-effort
                }
              } else if (activeTopic) {
                topicMap.activateTopic(sk, activeTopic.id);
                topicMap.incrementMessageCount(activeTopic.id);
              }
            }
          }
        } catch {
          // Topic detection is entirely non-fatal
        }

        // Recompute the Redis hot history from SQLite so turn-age gradient is
        // materialized after every turn. This prevents warm-compressed history
        // from drifting back to raw payloads during live sessions.
        //
        // Pass the cached model tokenBudget so refreshRedisGradient can cap the
        // gradient-compressed window to budget before writing to Redis. Without
        // this, afterTurn writes up to 250 messages regardless of budget, causing
        // trimHistoryToTokenBudget to fire and trim ~200 messages on every
        // subsequent assemble() — the churn loop seen in Helm's logs.
        if (hm.cache.isConnected) {
          try {
            const modelState = await hm.cache.getModelState(agentId, sk);
            const gradientBudget = modelState?.tokenBudget;
            const gradientDepth = modelState?.historyDepth;
            await hm.refreshRedisGradient(agentId, sk, gradientBudget, gradientDepth);
          } catch (refreshErr) {
            console.warn('[hypermem-plugin] afterTurn: refreshRedisGradient failed (non-fatal):', (refreshErr as Error).message);
          }
        }

        // Invalidate the window cache after ingesting new messages.
        // The next assemble() call will re-compose with the new data.
        try {
          await hm.cache.invalidateWindow(agentId, sk);
        } catch {
          // Window invalidation is best-effort
        }

        // Pre-emptive secondary trim when session exits a turn hot.
        // If a session just finished a turn at >80% pressure, the NEXT turn's
        // incoming tool results (parallel web searches, large exec output, etc.)
        // will hit a window with no headroom — the ingestion wave failure mode
        // (reported by Helm, 2026-04-05). Pre-trim here so the tool-loop
        // assemble() path starts the next turn with meaningful space.
        //
        // Uses modelState.tokenBudget if cached; skips if unavailable (non-fatal).
        try {
          const modelState = await hm.cache.getModelState(agentId, sk);
          if (modelState?.tokenBudget) {
            // Use the runtime message array as the only trim-pressure source.
            // Redis remains a drift signal for anomaly logging.
            const runtimePostTokens = estimateMessageArrayTokens(messages as unknown[]);
            const redisPostTokens = await estimateWindowTokens(hm, agentId, sk);
            const postTurnTokens = runtimePostTokens;
            maybeLogPressureAccountingAnomaly({
              path: 'afterTurn.secondary',
              agentId,
              sessionKey: sk,
              runtimeTokens: runtimePostTokens,
              redisTokens: redisPostTokens,
              composedTokens: postTurnTokens,
              budget: modelState.tokenBudget,
            });
            const postTurnPressure = postTurnTokens / modelState.tokenBudget;
            // Sprint 2.2b: demote afterTurn.secondary to guard-only no-op.
            //
            // Previously this path was a two-tier real trim that fired after
            // every turn ending at >80% pressure, calling
            // trimHistoryToTokenBudget() and emitting `event:'trim'` with
            // path='afterTurn.secondary'. Sprint 2 consolidates steady-state
            // trim ownership in assemble.* (tool-loop + normal/subagent),
            // with compact.* as the only exception family. The afterTurn
            // post-turn pressure path is now redundant: the next turn's
            // assemble.* trim absorbs any residual pressure.
            //
            // Pattern matches the warmstart/reshape demotion from 2.2a:
            // keep the pressure predicate + threshold branch so observability
            // via `event:'trim-guard'` is preserved, but emit NO real trim,
            // NO invalidateWindow, NO mutation. The compact skip-gate stays
            // correct because this path never stamped any model state.
            if (postTurnPressure > 0.80) {
              guardTelemetry({
                path: 'afterTurn.secondary',
                agentId, sessionKey: sk,
                reason: 'afterturn-secondary-demoted',
              });
            }
          }
        } catch {
          // Non-fatal — next turn's tool-loop trim is the fallback
        }

        // Pre-compute embedding for the assistant's reply so the next compose()
        // can skip the Ollama round-trip entirely (fire-and-forget).
        //
        // Why the assistant reply, not the current user message:
        // The assistant's reply is the strongest semantic predictor of what the
        // user will ask next — it's the context they're responding to. By the time
        // the next user message arrives and compose() fires, this embedding is
        // already warm in Redis. Cache hit rate: near 100% on normal conversation
        // flow (one reply per turn).
        //
        // The previous approach (embedding the current user message) still missed
        // on every turn because compose() queries against the INCOMING user message,
        // not the one that was just processed.
        //
        // newMessages = messages.slice(prePromptMessageCount) — the assistant reply
        // is always in here. Walk backwards to find the last assistant text turn.
        try {
          let assistantReplyText: string | null = null;
          for (let i = newMessages.length - 1; i >= 0; i--) {
            const m = newMessages[i] as unknown as InboundMessage;
            if (m.role === 'assistant') {
              const neutral = toNeutralMessage(m);
              if (neutral.textContent) {
                assistantReplyText = neutral.textContent;
                break;
              }
            }
          }

          if (assistantReplyText && _generateEmbeddings) {
            // Fire-and-forget: don't await, don't block afterTurn
            _generateEmbeddings([assistantReplyText]).then(async ([embedding]) => {
              if (embedding) {
                await hm.cache.setQueryEmbedding(agentId, sk, embedding);
              }
            }).catch(() => {
              // Non-fatal: embedding pre-compute failed, compose() will call Ollama
            });
          }
        } catch {
          // Pre-embed is entirely non-fatal
        }

        // P1.7: Direct per-agent tick after each turn — no need to wait for 5-min interval.
        if (_indexer) {
          const _agentIdForTick = agentId;
          const runTick = async () => {
            if (_taskFlowRuntime) {
              // Preflight: only create a managed flow if we can actually tick.
              // Creating a flow we never finish/fail leaves orphaned queued rows.
              let flow: { flowId: string; revision: number } | null = null;
              try {
                // Use createManaged + finish/fail only — do NOT call runTask().
                // runTask() writes a task_run row to runs.sqlite with status='running'
                // and the TaskFlow runtime has no completeTask() method, so those rows
                // would accumulate forever and block clean restarts.
                flow = _taskFlowRuntime.createManaged({
                  controllerId: 'hypermem/indexer',
                  goal: `Index messages for ${_agentIdForTick}`,
                }) as { flowId: string; revision: number };
                await _indexer!.tick();
                // expectedRevision is required: finishFlow uses optimistic locking.
                // A freshly created managed flow always starts at revision 0.
                // MUST be awaited — finish/fail return Promises. Calling without
                // await lets the Promise get GC'd before the DB write completes,
                // leaving the flow permanently in queued state.
                const finishResult = await Promise.resolve(_taskFlowRuntime.finish({ flowId: flow!.flowId, expectedRevision: flow!.revision }));
                if (finishResult && !finishResult.applied) {
                  console.warn('[hypermem-plugin] TaskFlow finish failed:', finishResult.code ?? finishResult.reason, 'flowId:', flow!.flowId, 'revision:', flow!.revision);
                }
              } catch (tickErr) {
                // Best-effort fail — non-fatal, but always mark the flow so it doesn't leak
                if (flow) {
                  try { await Promise.resolve(_taskFlowRuntime.fail({ flowId: flow.flowId, expectedRevision: flow.revision })); } catch { /* ignore */ }
                }
                throw tickErr;
              }
            } else {
              await _indexer!.tick();
            }
          };
          runTick().catch(() => {
            // Non-fatal: indexer tick failure never blocks afterTurn
          });
        }
      } catch (err) {
        // afterTurn is never fatal
        console.warn('[hypermem-plugin] afterTurn failed:', (err as Error).message);
      }
    },

    /**
     * Prepare context for a subagent session before it starts.
     *
     * Seeds the child session's Redis with parent context based on the
     * subagentWarming config ('full' | 'light' | 'off').
     * Returns a rollback handle to clean up if spawn fails.
     */
    async prepareSubagentSpawn({ parentSessionKey, childSessionKey }): Promise<SubagentSpawnPreparation | undefined> {
      if (_subagentWarming === 'off') {
        return undefined;
      }

      try {
        const hm = await getHyperMem();
        const parentAgentId = extractAgentId(parentSessionKey);
        const childAgentId = extractAgentId(childSessionKey);

        // Seed child with parent's active facts
        const facts = hm.getActiveFacts(parentAgentId, { limit: 50 });
        if (facts && (facts as unknown[]).length > 0) {
          const factBlock = (facts as Array<{ content: string }>)
            .map(f => f.content)
            .join('\n');
          await hm.cache.setSlot(childAgentId, childSessionKey, 'parentFacts', factBlock);
        }

        // For 'full' warming, also seed recent history context
        if (_subagentWarming === 'full') {
          const history = await hm.cache.getHistory(parentAgentId, parentSessionKey);
          if (history && history.length > 0) {
            const recentHistory = history.slice(-10);
            await hm.cache.setSlot(
              childAgentId,
              childSessionKey,
              'parentHistory',
              JSON.stringify(recentHistory)
            );
          }
        }

        console.log(
          `[hypermem-plugin] prepareSubagentSpawn: seeded ${childSessionKey} ` +
          `from ${parentSessionKey} (warming=${_subagentWarming})`
        );

        return {
          async rollback() {
            try {
              const hm = await getHyperMem();
              await hm.cache.setSlot(childAgentId, childSessionKey, 'parentFacts', '');
              await hm.cache.setSlot(childAgentId, childSessionKey, 'parentHistory', '');
            } catch {
              // Rollback is best-effort
            }
          },
        };
      } catch (err) {
        console.warn('[hypermem-plugin] prepareSubagentSpawn failed (non-fatal):', (err as Error).message);
        return undefined;
      }
    },

    /**
     * Clean up after a subagent session ends.
     *
     * Removes Redis slots and invalidates caches for the dead session
     * to prevent stale data accumulation.
     */
    async onSubagentEnded({ childSessionKey, reason }: { childSessionKey: string; reason: SubagentEndReason }): Promise<void> {
      try {
        const hm = await getHyperMem();
        const childAgentId = extractAgentId(childSessionKey);

        await Promise.all([
          hm.cache.setSlot(childAgentId, childSessionKey, 'parentFacts', ''),
          hm.cache.setSlot(childAgentId, childSessionKey, 'parentHistory', ''),
          hm.cache.setSlot(childAgentId, childSessionKey, 'assemblyContextBlock', ''),
          hm.cache.setSlot(childAgentId, childSessionKey, 'assemblyContextAt', '0'),
          hm.cache.invalidateWindow(childAgentId, childSessionKey).catch(() => {}),
        ]);

        _overheadCache.delete(childSessionKey);

        console.log(
          `[hypermem-plugin] onSubagentEnded: cleaned up ${childSessionKey} (reason=${reason})`
        );
      } catch (err) {
        console.warn('[hypermem-plugin] onSubagentEnded failed (non-fatal):', (err as Error).message);
      }
    },

    /**
     * Dispose: intentionally a no-op.
     *
     * The runtime calls dispose() at the end of every request cycle, but
     * hypermem's Redis connection and SQLite handles are gateway-lifetime
     * singletons — not request-scoped. Closing and nulling _hm here causes
     * a full reconnect + re-init on every turn (~400-800ms latency per turn).
     *
     * ioredis manages its own reconnection on connection loss. If the gateway
     * process exits, Node.js cleans up file handles automatically.
     *
     * If a true shutdown is needed (e.g. gateway restart signal), call
     * _hm.close() directly from a gateway:shutdown hook instead.
     */
    async dispose(): Promise<void> {
      // Intentional no-op — see comment above.
    },
  };
}

// ─── NeutralMessage → AgentMessage ─────────────────────────────

/**
 * Convert hypermem's NeutralMessage back to OpenClaw's AgentMessage format.
 *
 * The runtime expects messages conforming to pi-ai's Message union:
 *   UserMessage:       { role: 'user', content: string | ContentBlock[], timestamp }
 *   AssistantMessage:  { role: 'assistant', content: ContentBlock[], api, provider, model, usage, stopReason, timestamp }
 *   ToolResultMessage: { role: 'toolResult', toolCallId, toolName, content, isError, timestamp }
 *
 * hypermem stores tool results as NeutralMessage with role='user' and toolResults[].
 * These must be expanded into individual ToolResultMessage objects.
 *
 * For assistant messages with tool calls, NeutralToolCall.arguments is a JSON string
 * but the runtime's ToolCall.arguments is Record<string, any>. We parse it here.
 *
 * Missing metadata fields (api, provider, model, usage, stopReason) are filled with
 * sentinel values. The runtime's convertToLlm strips them before the API call, and
 * the session transcript already has the real values. These are just structural stubs
 * so the AgentMessage type is satisfied at runtime.
 */
function neutralToAgentMessage(msg: NeutralMessage): InboundMessage | InboundMessage[] {
  const now = Date.now();

  // Tool results: expand to individual ToolResultMessage objects
  if (msg.toolResults && msg.toolResults.length > 0) {
    return (msg.toolResults as Array<{ callId: string; name: string; content: string; isError?: boolean }>).map(tr => ({
      role: 'toolResult' as const,
      toolCallId: tr.callId,
      toolName: tr.name,
      content: [{ type: 'text' as const, text: tr.content ?? '' }],
      isError: tr.isError ?? false,
      timestamp: now,
    }));
  }

  if (msg.role === 'user') {
    return {
      role: 'user' as const,
      content: msg.textContent ?? '',
      timestamp: now,
    };
  }

  if (msg.role === 'system') {
    // System messages are passed through as-is; the runtime handles them separately
    return {
      role: 'system' as const,
      content: msg.textContent ?? '',
      timestamp: now,
      // Preserve dynamicBoundary metadata for prompt caching
      ...(msg.metadata as Record<string, unknown> | undefined)?.dynamicBoundary
        ? { metadata: { dynamicBoundary: true } }
        : {},
    };
  }

  // Assistant message
  const content: Array<{ type: string; [key: string]: unknown }> = [];

  if (msg.textContent) {
    content.push({ type: 'text', text: msg.textContent });
  }

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      // Parse arguments from JSON string → object (runtime expects Record<string, any>)
      let args: Record<string, unknown>;
      try {
        args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments ?? {});
      } catch {
        args = {};
      }
      content.push({
        type: 'toolCall',
        id: tc.id,
        name: tc.name,
        arguments: args,
      });
    }
  }

  // Stub metadata fields — the runtime needs these structurally but convertToLlm
  // strips them before the API call. Real values live in the session transcript.
  return {
    role: 'assistant' as const,
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    api: 'unknown',
    provider: 'unknown',
    model: 'unknown',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: 'stop',
    timestamp: now,
  };
}

// ─── Cache Bust Utility ────────────────────────────────────────────────────

/**
 * Bust the assembly cache for a specific agent+session.
 * Call this after writing to identity files (SOUL.md, IDENTITY.md, TOOLS.md,
 * USER.md) to ensure the next assemble() runs full compositor, not a replay.
 */
export async function bustAssemblyCache(agentId: string, sessionKey: string): Promise<void> {
  try {
    const hm = await getHyperMem();
    await Promise.all([
      hm.cache.setSlot(agentId, sessionKey, 'assemblyContextBlock', ''),
      hm.cache.setSlot(agentId, sessionKey, 'assemblyContextAt', '0'),
    ]);
  } catch {
    // Non-fatal
  }
}

// ─── Plugin Config Schema ────────────────────────────────────────
// Exposed via openclaw.json → plugins.entries.hypercompositor.config
// Validated by OpenClaw on gateway start. Visible via `openclaw config get`.

const hypercompositorConfigSchema = z.object({
  /** Path to HyperMem core dist/index.js. Auto-resolved if omitted. */
  hyperMemPath: z.string().optional(),
  /** HyperMem data directory. Default: ~/.openclaw/hypermem */
  dataDir: z.string().optional(),
  /** Full model context window size in tokens. Default: 128000 */
  contextWindowSize: z.number().int().positive().optional(),
  /** Fraction [0.0–0.5] reserved for system prompts + headroom. Default: 0.25 */
  contextWindowReserve: z.number().min(0).max(0.5).optional(),
  /** Defer tool pruning to OpenClaw's contextPruning. Default: false */
  deferToolPruning: z.boolean().optional(),
  /** Emit detailed budget-source and trim-decision logs. Default: false */
  verboseLogging: z.boolean().optional(),
  /** Manual per-model context window fallback table used when runtime tokenBudget is missing. */
  contextWindowOverrides: z.record(z.string().regex(CONTEXT_WINDOW_OVERRIDE_KEY_REGEX, 'key must be "provider/model"'), contextWindowOverrideSchema).optional(),
  /** Treat cache replay snapshots older than this as stale. Default: 120000ms */
  warmCacheReplayThresholdMs: z.number().int().positive().optional(),
  /** Subagent context injection: 'full' | 'light' | 'off'. Default: 'light' */
  subagentWarming: z.enum(['full', 'light', 'off']).optional(),
  /** Compositor tuning overrides */
  compositor: z.object({
    budgetFraction: z.number().min(0).max(1).optional(),
    reserveFraction: z.number().min(0).max(1).optional(),
    historyFraction: z.number().min(0).max(1).optional(),
    memoryFraction: z.number().min(0).max(1).optional(),
    defaultTokenBudget: z.number().int().positive().optional(),
    maxHistoryMessages: z.number().int().positive().optional(),
    maxFacts: z.number().int().positive().optional(),
    maxExpertisePatterns: z.number().int().positive().optional(),
    maxCrossSessionContext: z.number().int().nonnegative().optional(),
    maxTotalTriggerTokens: z.number().int().nonnegative().optional(),
    maxRecentToolPairs: z.number().int().nonnegative().optional(),
    maxProseToolPairs: z.number().int().nonnegative().optional(),
    warmHistoryBudgetFraction: z.number().min(0).max(1).optional(),
    contextWindowReserve: z.number().min(0).max(1).optional(),
    dynamicReserveTurnHorizon: z.number().int().positive().optional(),
    dynamicReserveMax: z.number().min(0).max(1).optional(),
    dynamicReserveEnabled: z.boolean().optional(),
    keystoneHistoryFraction: z.number().min(0).max(1).optional(),
    keystoneMaxMessages: z.number().int().nonnegative().optional(),
    keystoneMinSignificance: z.number().min(0).max(1).optional(),
    targetBudgetFraction: z.number().min(0).max(1).optional(),
    enableFOS: z.boolean().optional(),
    enableMOD: z.boolean().optional(),
    hyperformProfile: z.enum(['light', 'standard', 'full', 'starter', 'fleet']).optional(),
    outputProfile: z.enum(['light', 'standard', 'full', 'starter', 'fleet']).optional(),
    outputStandard: z.enum(['light', 'standard', 'full', 'starter', 'fleet']).optional(),
    wikiTokenCap: z.number().int().positive().optional(),
    zigzagOrdering: z.boolean().optional(),
  }).optional(),
  /** Image/tool eviction settings */
  eviction: z.object({
    enabled: z.boolean().optional(),
    imageAgeTurns: z.number().int().nonnegative().optional(),
    toolResultAgeTurns: z.number().int().nonnegative().optional(),
    minTokensToEvict: z.number().int().nonnegative().optional(),
    keepPreviewChars: z.number().int().nonnegative().optional(),
  }).optional(),
  /** Embedding provider config */
  embedding: z.object({
    provider: z.enum(['ollama', 'openai', 'gemini']).optional(),
    ollamaUrl: z.string().optional(),
    openaiApiKey: z.string().optional(),
    openaiBaseUrl: z.string().optional(),
    geminiBaseUrl: z.string().optional(),
    geminiIndexTaskType: z.string().optional(),
    geminiQueryTaskType: z.string().optional(),
    model: z.string().optional(),
    dimensions: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    batchSize: z.number().int().positive().optional(),
  }).optional(),
});

type HypercompositorConfig = z.infer<typeof hypercompositorConfigSchema>;

// ─── Plugin Entry ───────────────────────────────────────────────

const engine = createHyperMemEngine();

export default definePluginEntry({
  id: 'hypercompositor',
  name: 'HyperCompositor — context engine',
  description: 'Four-layer memory architecture for OpenClaw agents: SQLite hot cache, message history, vector search, and structured library.',
  kind: 'context-engine',
  configSchema: buildPluginConfigSchema(hypercompositorConfigSchema),
  register(api) {
    // ── Resolve plugin config from openclaw.json ──
    const pluginCfg = (api.pluginConfig ?? {}) as HypercompositorConfig;
    _pluginConfig = pluginCfg;

    // ── Resolve HYPERMEM_PATH: pluginConfig > ESM package resolve > dev fallback ──
    if (pluginCfg.hyperMemPath) {
      HYPERMEM_PATH = pluginCfg.hyperMemPath;
      console.log(`[hypermem-plugin] Using configured hyperMemPath: ${HYPERMEM_PATH}`);
    } else {
      try {
        const resolvedUrl = import.meta.resolve('@psiclawops/hypermem');
        HYPERMEM_PATH = resolvedUrl.startsWith('file:') ? fileURLToPath(resolvedUrl) : resolvedUrl;
      } catch {
        // Dev fallback: resolve relative to plugin directory
        const __pluginDir = path.dirname(fileURLToPath(import.meta.url));
        HYPERMEM_PATH = path.resolve(__pluginDir, '../../dist/index.js');
        console.log(`[hypermem-plugin] Falling back to dev path: ${HYPERMEM_PATH}`);
      }
    }

    api.registerContextEngine('hypercompositor', () => engine);

    // ── HyperForm config dir init ──
    // Copy defaults and guide to ~/.openclaw/hypermem/config/ on every load.
    // Defaults are overwritten on plugin update. Active config files are never touched.
    void (async () => {
      try {
        const dataDir = _pluginConfig.dataDir ?? path.join(os.homedir(), '.openclaw/hypermem');
        const configDir = path.join(dataDir, 'config');
        await fs.mkdir(configDir, { recursive: true });

        const __pluginDir = path.dirname(fileURLToPath(import.meta.url));
        const defaultsSrc = path.resolve(__pluginDir, '../../../config-defaults');

        const defaultFiles = [
          'hyperform-fos-defaults.json',
          'hyperform-mod-defaults.json',
          'HYPERFORM-GUIDE.md',
        ];

        for (const fname of defaultFiles) {
          const src = path.join(defaultsSrc, fname);
          const dest = path.join(configDir, fname);
          try {
            await fs.copyFile(src, dest);
          } catch {
            // defaults may not exist in dev builds — non-fatal
          }
        }

        // On first install, copy defaults as active config if active files don't exist
        for (const [src, dest] of [
          ['hyperform-fos-defaults.json', 'hyperform-fos.json'],
          ['hyperform-mod-defaults.json', 'hyperform-mod.json'],
        ]) {
          const destPath = path.join(configDir, dest);
          try {
            await fs.access(destPath);
          } catch {
            // Active config doesn't exist — copy defaults as starting point
            try {
              await fs.copyFile(path.join(configDir, src), destPath);
            } catch {
              // non-fatal
            }
          }
        }
      } catch {
        // non-fatal — HyperForm config init is best-effort
      }
    })();

    // P1.7: Bind TaskFlow runtime for task visibility — best-effort.
    // Guard: api.runtime.taskFlow may not exist on older OpenClaw versions.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tf = (api as any).runtime?.taskFlow;
      if (tf && typeof tf.bindSession === 'function') {
        _taskFlowRuntime = tf.bindSession({
          sessionKey: 'hypermem-plugin',
          requesterOrigin: 'hypermem-plugin',
        });
      }
    } catch {
      // TaskFlow binding is best-effort — plugin remains fully functional without it
    }
  },
});
