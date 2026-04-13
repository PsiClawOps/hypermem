/**
 * hypermem Context Engine Plugin
 *
 * Implements OpenClaw's ContextEngine interface backed by hypermem's
 * four-layer memory architecture:
 *
 *   L1 Redis    — hot session working memory
 *   L2 Messages — per-agent conversation history (SQLite)
 *   L3 Vectors  — semantic + keyword search (KNN + FTS5)
 *   L4 Library  — facts, knowledge, episodes, preferences
 *
 * Lifecycle mapping:
 *   ingest()     → record each message into messages.db
 *   assemble()   → compositor builds context from all four layers
 *   compact()    → delegate to runtime (ownsCompaction: false)
 *   afterTurn()  → trigger background indexer (fire-and-forget)
 *   bootstrap()  → warm Redis session, register agent in fleet
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
import { detectTopicShift, stripMessageMetadata, SessionTopicMap, applyToolGradientToWindow, canPersistReshapedHistory, OPENCLAW_BOOTSTRAP_FILES } from '@psiclawops/hypermem';
import { evictStaleContent } from '@psiclawops/hypermem/image-eviction';
import { repairToolPairs } from '@psiclawops/hypermem';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// Re-export core types for consumers (eliminates local shim drift)
export type { NeutralMessage, NeutralToolCall, NeutralToolResult, ComposeRequest, ComposeResult };

// ─── hypermem singleton ────────────────────────────────────────

// Runtime load is dynamic (hypermem is a sibling package loaded from repo dist,
// not installed via npm). Types come from the core package devDependency.
// This pattern keeps the runtime path stable while TypeScript resolves types
// from the canonical source — no more local shim drift.
// Resolved at init time: pluginConfig.hyperMemPath > require.resolve('@psiclawops/hypermem') > dev fallback
let HYPERMEM_PATH = '';
const require = createRequire(import.meta.url);

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
function computeEffectiveBudget(tokenBudget?: number): number {
  if (tokenBudget) return tokenBudget;
  // Derived from window config: floor to avoid fractional tokens
  return Math.floor(_contextWindowSize * (1 - _contextWindowReserve));
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
    defaultTokenBudget: number;
    maxHistoryMessages: number;
    maxFacts: number;
    maxCrossSessionContext: number;
    maxRecentToolPairs: number;
    maxProseToolPairs: number;
    warmHistoryBudgetFraction: number;
    keystoneHistoryFraction: number;
    keystoneMaxMessages: number;
    keystoneMinSignificance: number;
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
    if (userConfig.deferToolPruning === true) {
      _deferToolPruning = true;
      console.log('[hypermem-plugin] deferToolPruning: true — tool gradient deferred to host contextPruning');
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
        config?: Partial<{ enabled: boolean; periodicInterval: number }>,
        getCursor?: (agentId: string, sessionKey: string) => Promise<unknown>,
        vectorStore?: any,
        dreamerConfig?: Record<string, unknown>
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
        { enabled: true, periodicInterval: 300000 },  // 5-minute interval
        // Cursor fetcher: reads from Redis → SQLite fallback
        async (agentId: string, sessionKey: string) => {
          return instance.getSessionCursor(agentId, sessionKey);
        },
        // Pass vector store so new facts/episodes are embedded at index time
        instance.getVectorStore() ?? undefined,
        // Dreaming config — passed from hypermem user config if set
        (userConfig as { dreaming?: Record<string, unknown> })?.dreaming ?? {}
      );
      _indexer.start();
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
    return window.reduce((sum: number, msg: any) => {
      let t = estimateTokens(msg.textContent);
      // Tool payloads are dense JSON — use /2 not /4 to avoid systematic undercount
      if (msg.toolCalls) t += Math.ceil(JSON.stringify(msg.toolCalls).length / 2);
      if (msg.toolResults) t += Math.ceil(JSON.stringify(msg.toolResults).length / 2);
      return sum + t;
    }, 0);
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
      id: 'hypermem',
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
            const warmTrimTarget = warmPressure > 0.90 ? 0.40 : 0.55;
            const warmTrimBudget = Math.floor(warmBudget * warmTrimTarget);
            const warmTrimmed = await hm.cache.trimHistoryToTokenBudget(agentId, sk, warmTrimBudget);
            if (warmTrimmed > 0) {
              await hm.cache.invalidateWindow(agentId, sk);
              console.log(
                `[hypermem-plugin] bootstrap: high-pressure startup ` +
                `(${(warmPressure * 100).toFixed(1)}%), pre-trimmed Redis to ` +
                `~${warmTrimTarget * 100}% (${warmTrimmed} msgs dropped)`
              );
            }
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
        // full payloads pushes Redis past the nuclear path threshold before the
        // next assemble() can trim. Use Redis current state (appropriate here —
        // we're deciding what to write TO Redis) as the pressure signal.
        // Above 70%: truncate toolResult content to a compact stub.
        // Above 85%: skip recording entirely — assemble() trim is the safety net.
        const isInboundToolResult = msg.role === 'tool' || msg.role === 'tool_result' || msg.role === 'toolResult';
        if (isInboundToolResult && neutral.toolResults && neutral.toolResults.length > 0) {
          const redisTokens = await estimateWindowTokens(hm, agentId, sk);
          const effectiveBudget = computeEffectiveBudget(undefined);
          const redisPressure = redisTokens / effectiveBudget;

          // Error tool results are always preserved intact — they're small and
          // the model needs the error signal to understand what went wrong.
          const hasErrorResult = neutral.toolResults!.some(tr => tr.isError);

          if (redisPressure > 0.85) {
            // FIX (Bug 4): Never skip a tool result entirely — that leaves an orphaned
            // tool_call in Redis history (the assistant message was already recorded).
            // Anthropic rejects assistant messages with tool_calls that have no matching result.
            // Instead, record a compact stub that preserves pair integrity in history.
            const stubbedResults = neutral.toolResults!.map(tr => {
              if (tr.isError) return tr; // preserve error results intact
              return {
                ...tr,
                content: `[tool result omitted by wave-guard at ${(redisPressure * 100).toFixed(0)}% Redis pressure]`,
              };
            });
            const stubNeutral = { ...neutral, toolResults: stubbedResults };
            console.log(`[hypermem] ingest wave-guard: stubbing toolResult (Redis pressure ${(redisPressure * 100).toFixed(0)}% > 85%)${hasErrorResult ? ' — error results preserved' : ''} — preserving pair integrity`);
            await hm.recordAssistantMessage(agentId, sk, stubNeutral);
            return { ingested: true };
          } else if (redisPressure > 0.70) {
            // Elevated: store truncated stub to preserve tool call pairing in history
            const MAX_TOOL_RESULT_CHARS = 500;
            neutral = {
              ...neutral,
              toolResults: neutral.toolResults.map(tr => {
                if (tr.isError) return tr; // preserve error results intact
                const content = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content);
                if (content.length <= MAX_TOOL_RESULT_CHARS) return tr;
                return {
                  ...tr,
                  content: `[truncated by wave-guard at ${(redisPressure * 100).toFixed(0)}% pressure: ${Math.ceil(content.length / 4)} tokens]`,
                };
              }),
            };
            console.log(
              `[hypermem] ingest wave-guard: truncated toolResult (Redis pressure ${(redisPressure * 100).toFixed(0)}% > 70%)${hasErrorResult ? ' — error results preserved' : ''}`
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
        const effectiveBudget = computeEffectiveBudget(tokenBudget);
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

          // Measure pressure BEFORE trim to pick the right tier.
          // Critical: use the runtime-provided messages array, NOT estimateWindowTokens()
          // which reads Redis. After a gateway restart Redis is empty — estimateWindowTokens
          // returns ~0, pressure reads as 0%, and the trim tiers never fire even though
          // the session is at 98% from JSONL loaded at runtime. The messages param is
          // always authoritative — it's what the runtime actually sent to the model.
          const runtimeTokens = messages.reduce((sum: number, m: unknown) => {
            const msg = m as Record<string, unknown>;
            const textCost = estimateTokens(typeof msg.textContent === 'string' ? msg.textContent : null);
            const toolCallCost = msg.toolCalls ? Math.ceil(JSON.stringify(msg.toolCalls).length / 2) : 0;
            const toolResultCost = msg.toolResults ? Math.ceil(JSON.stringify(msg.toolResults).length / 2) : 0;
            // FIX (Bug 2): count content arrays in OpenClaw native format.
            // Native tool result messages store content as c.content (not c.text).
            // Old code always read c.text, returning 0 for native format — severe undercount.
            const contentCost = Array.isArray(msg.content)
              ? (msg.content as unknown[]).reduce((s: number, c: unknown) => {
                  const part = c as Record<string, unknown>;
                  const textVal = typeof part.text === 'string' ? part.text
                    : typeof part.content === 'string' ? part.content
                    : part.content != null ? JSON.stringify(part.content) : null;
                  return s + estimateTokens(textVal);
                }, 0)
              : 0;
            // Count image parts — base64 images are large and invisible to the text estimator
            const imageCost = Array.isArray(msg.content)
              ? (msg.content as unknown[]).reduce((s: number, c: unknown) => {
                  const part = c as Record<string, unknown>;
                  if (part.type === 'image' || part.type === 'image_url') {
                    const src = (part.source as Record<string, unknown> | undefined)?.data;
                    const url = (part.image_url as Record<string, unknown> | undefined)?.url as string | undefined;
                    const dataStr = typeof src === 'string' ? src : (typeof url === 'string' ? url : '');
                    return s + Math.ceil(dataStr.length / 3); // base64 ~1.33x bytes, ~1 token/4 bytes
                  }
                  return s;
                }, 0)
              : 0;
            return sum + textCost + toolCallCost + toolResultCost + contentCost + imageCost;
          }, 0);
          // Redis window is a useful cross-check; use whichever is higher so we never
          // underestimate when Redis is ahead of the runtime snapshot.
          const redisTokens = await estimateWindowTokens(hm, agentId, sk);
          const preTrimTokens = Math.max(runtimeTokens, redisTokens);
          const pressure = preTrimTokens / effectiveBudget;

          // Pressure-tiered trim targets:
          //   JSONL-replay (EC1): runtimeTokens >> redisTokens means session
          //   loaded from a large JSONL but Redis is cold (post-restart). Trim
          //   aggressively to 30% so system prompt + this turn's tool results fit.
          //   >85% (critical) → trim to 50%: blast headroom for incoming wave
          //   >80% (high)     → trim to 60%: 40% headroom
          //   >75% (elevated) → trim to 65%: 35% headroom
          //   ≤75% (normal)   → trim to 80%: existing behaviour
          const isJsonlReplay = runtimeTokens > effectiveBudget * 0.80 && redisTokens < runtimeTokens * 0.20;
          let trimTarget: number;
          if (isJsonlReplay) {
            trimTarget = 0.20; // EC1: cold Redis + hot JSONL = post-restart replay, need max headroom
          } else if (pressure > 0.85) {
            trimTarget = 0.40; // critical: 60% headroom for incoming wave
          } else if (pressure > 0.80) {
            trimTarget = 0.50; // high: 50% headroom
          } else if (pressure > 0.75) {
            trimTarget = 0.55; // elevated: 45% headroom
          } else {
            trimTarget = 0.65; // normal: 35% headroom (was 0.80 — too tight)
          }

          const trimBudget = Math.floor(effectiveBudget * trimTarget);
          const trimmed = await hm.cache.trimHistoryToTokenBudget(agentId, sk, trimBudget);
          if (trimmed > 0) {
            await hm.cache.invalidateWindow(agentId, sk);
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
            // Reserve tokens for system messages
            for (const sm of systemMsgs) {
              const t = estimateTokens(typeof sm.textContent === 'string' ? sm.textContent : null)
                + (Array.isArray(sm.content) ? (sm.content as Array<Record<string,unknown>>).reduce(
                    (s: number, c: Record<string,unknown>) => {
                      const textVal = typeof c.text === 'string' ? c.text
                        : typeof c.content === 'string' ? c.content : null;
                      return s + estimateTokens(textVal);
                    }, 0) : 0);
              budget -= t;
            }
            const msgCost = (m: Record<string, unknown>): number =>
              estimateTokens(typeof m.textContent === 'string' ? m.textContent : null)
              + (m.toolCalls ? Math.ceil(JSON.stringify(m.toolCalls).length / 2) : 0)
              + (m.toolResults ? Math.ceil(JSON.stringify(m.toolResults).length / 2) : 0)
              + (Array.isArray(m.content) ? (m.content as Array<Record<string,unknown>>).reduce(
                  (s: number, c: Record<string,unknown>) => {
                    if (c.type === 'toolCall' || c.type === 'tool_use') {
                      return s + Math.ceil(JSON.stringify(c).length / 2);
                    }
                    const textVal = typeof c.text === 'string' ? c.text
                      : typeof c.content === 'string' ? c.content
                      : c.content != null ? JSON.stringify(c.content) : null;
                    return s + estimateTokens(textVal);
                  }, 0) : 0);

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
                `[hypermem-plugin] tool-loop trim: pressure=${(pressure * 100).toFixed(1)}%${isJsonlReplay ? ' [jsonl-replay]' : ''} → ` +
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

          const windowTokens = await estimateWindowTokens(hm, agentId, sk);
          const overhead = _overheadCache.get(sk) ?? getOverheadFallback();
          return {
            messages: trimmedMessages as unknown as import('@mariozechner/pi-agent-core').AgentMessage[],
            estimatedTokens: windowTokens + overhead,
          };
        } catch {
          // Non-fatal: return conservative estimate so guard doesn't go blind
          return {
            messages: messages as unknown as import('@mariozechner/pi-agent-core').AgentMessage[],
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
          messages: messages as unknown as import('@mariozechner/pi-agent-core').AgentMessage[],
          estimatedTokens: messages.reduce((sum: number, m: unknown) => {
            const msg = m as Record<string, unknown>;
            return sum + Math.ceil((typeof msg.textContent === 'string' ? msg.textContent.length : 0) / 4);
          }, 0),
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
      const effectiveBudget = computeEffectiveBudget(tokenBudget);
      const historyDepth = Math.min(250, Math.max(50, Math.floor((effectiveBudget * 0.65) / 500)));

      // ── Redis guardrail: trim history to token budget ────────────────────
      // Prevents model-switch bloat: if an agent previously ran on a larger
      // context window, Redis history may exceed the current model's budget.
      // Trimming here (before compose) ensures the compositor never sees a
      // history window it can't fit. Uses 80% of budget as the trim ceiling
      // to leave room for system prompt, facts, and identity slots.
      try {
        const trimBudget = Math.floor(effectiveBudget * 0.65);
        const trimmed = await hm.cache.trimHistoryToTokenBudget(agentId, sk, trimBudget);
        if (trimmed > 0) {
          // Invalidate window cache since history changed
          await hm.cache.invalidateWindow(agentId, sk);
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
      try {
        const lastState = await hm.cache.getModelState(agentId, sk);
        const DOWNSHIFT_THRESHOLD = 0.10;
        const isDownshift = lastState &&
          (lastState.tokenBudget - effectiveBudget) / lastState.tokenBudget > DOWNSHIFT_THRESHOLD;

        if (isDownshift && !_deferToolPruning) {
          // Read from history list — window cache is always null here because
          // afterTurn() calls invalidateWindow() on every turn.
          const currentHistory = await hm.cache.getHistory(agentId, sk);
          if (currentHistory && currentHistory.length > 0) {
            const reshaped = applyToolGradientToWindow(currentHistory, effectiveBudget);
            if (reshaped.length < currentHistory.length) {
              const reshapedAt = new Date().toISOString();
              if (canPersistReshapedHistory(currentHistory)) {
                // No structured tool turns in canonical history, safe to persist
                // the reshaped window back to cache/history.
                await hm.cache.replaceHistory(agentId, sk, reshaped);
                await hm.cache.invalidateWindow(agentId, sk);
                console.log(
                  `[hypermem-plugin] budget-downshift: ${agentId}/${sk} ` +
                  `${lastState.tokenBudget}→${effectiveBudget} tokens, ` +
                  `reshaped ${currentHistory.length}→${reshaped.length} messages`
                );
              } else {
                // Tool-bearing history must remain canonical. Use the reshaped
                // window only as a compose-time view and leave hot history lossless.
                console.log(
                  `[hypermem-plugin] budget-downshift: ${agentId}/${sk} ` +
                  `${lastState.tokenBudget}→${effectiveBudget} tokens, ` +
                  `view-only reshape ${currentHistory.length}→${reshaped.length} messages (structured tool history preserved)`
                );
              }
              await hm.cache.setModelState(agentId, sk, {
                model: model ?? 'unknown',
                tokenBudget: effectiveBudget,
                composedAt: new Date().toISOString(),
                historyDepth,
                reshapedAt,
              });
            }
          }
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
      if (cacheReplayThresholdMs > 0) {
        try {
          const cachedAt = await hm.cache.getSlot(agentId, sk, 'assemblyContextAt');
          if (cachedAt && Date.now() - parseInt(cachedAt) < cacheReplayThresholdMs) {
            cachedContextBlock = await hm.cache.getSlot(agentId, sk, 'assemblyContextBlock');
            if (cachedContextBlock) {
              console.log(`[hypermem-plugin] assemble: cache replay hit for ${agentId} (${Math.round((Date.now() - parseInt(cachedAt)) / 1000)}s old)`);
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
        historyDepth,
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

      // Use cached contextBlock if available (cache replay), otherwise use fresh result.
      // After a full compose, write the new contextBlock to cache for the next turn.
      if (cachedContextBlock) {
        result.contextBlock = cachedContextBlock;
      } else if (result.contextBlock && cacheReplayThresholdMs > 0) {
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
        try {
          cachedModelState = await hm.cache.getModelState(agentId, sk);
          if (cachedModelState?.reshapedAt) {
            const reshapeAge = Date.now() - new Date(cachedModelState.reshapedAt).getTime();
            // Only skip if session is NOT critically full — nuclear path must bypass this guard.
            // If currentTokenCount > 85% budget, fall through to nuclear compaction below.
            const isCriticallyFull = currentTokenCount != null &&
              currentTokenCount > (computeEffectiveBudget(tokenBudget) * 0.85);
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
        const effectiveBudget = computeEffectiveBudget(tokenBudget);
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
          await hm.cache.trimHistoryToTokenBudget(agentId, sk, nuclearBudget);
          await hm.cache.invalidateWindow(agentId, sk).catch(() => {});
          await truncateJsonlIfNeeded(sessionFile, nuclearDepth, true);
          const tokensAfter = await estimateWindowTokens(hm, agentId, sk);
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
    async afterTurn({ sessionId, sessionKey, messages, prePromptMessageCount, isHeartbeat }): Promise<void> {
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
            await hm.recordAssistantMessage(agentId, sk, neutral);
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
            await hm.refreshRedisGradient(agentId, sk, gradientBudget);
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
            // Use the same dual-source pressure estimate as the tool-loop trim:
            // max(runtime messages, Redis) so a post-restart empty-Redis session
            // still fires correctly.
            const runtimePostTokens = messages.reduce((sum: number, m: unknown) => {
              const msg = m as Record<string, unknown>;
              const textCost = estimateTokens(typeof msg.textContent === 'string' ? msg.textContent : null);
              const toolCallCost = msg.toolCalls ? Math.ceil(JSON.stringify(msg.toolCalls).length / 2) : 0;
              const toolResultCost = msg.toolResults ? Math.ceil(JSON.stringify(msg.toolResults).length / 2) : 0;
              const contentCost = Array.isArray(msg.content)
                ? (msg.content as unknown[]).reduce((s: number, c: unknown) => {
                    const part = c as Record<string, unknown>;
                    // FIX (Bug 2 — afterTurn estimator): read c.content for native format
                    const textVal = typeof part.text === 'string' ? part.text
                      : typeof part.content === 'string' ? part.content
                      : part.content != null ? JSON.stringify(part.content) : null;
                    return s + estimateTokens(textVal);
                  }, 0)
                : 0;
              return sum + textCost + toolCallCost + toolResultCost + contentCost;
            }, 0);
            const redisPostTokens = await estimateWindowTokens(hm, agentId, sk);
            const postTurnTokens = Math.max(runtimePostTokens, redisPostTokens);
            const postTurnPressure = postTurnTokens / modelState.tokenBudget;
            // Two-tier afterTurn trim (EC3 fix, 2026-04-05):
            //   >90% → trim to 45%: deep saturation recovery — 70% target leaves only ~8k
            //           after system prompt (20-30k), which is not enough for any real tool work.
            //   >80% → trim to 70%: mild pressure, preserve more history.
            const afterTurnTrimTarget = postTurnPressure > 0.90 ? 0.45 : 0.70;
            if (postTurnPressure > 0.80) {
              const headroomBudget = Math.floor(modelState.tokenBudget * afterTurnTrimTarget);
              const secondaryTrimmed = await hm.cache.trimHistoryToTokenBudget(agentId, sk, headroomBudget);
              if (secondaryTrimmed > 0) {
                console.log(
                  `[hypermem-plugin] afterTurn: pre-emptive trim — session exiting at ` +
                  `${(postTurnPressure * 100).toFixed(1)}%, trimmed ${secondaryTrimmed} msgs to create headroom`
                );
              }
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
  /** Subagent context injection: 'full' | 'light' | 'off'. Default: 'light' */
  subagentWarming: z.enum(['full', 'light', 'off']).optional(),
  /** Compositor tuning overrides */
  compositor: z.object({
    defaultTokenBudget: z.number().int().positive().optional(),
    maxHistoryMessages: z.number().int().positive().optional(),
    maxFacts: z.number().int().positive().optional(),
    maxCrossSessionContext: z.number().int().nonnegative().optional(),
    maxRecentToolPairs: z.number().int().nonnegative().optional(),
    maxProseToolPairs: z.number().int().nonnegative().optional(),
    warmHistoryBudgetFraction: z.number().min(0).max(1).optional(),
    keystoneHistoryFraction: z.number().min(0).max(1).optional(),
    keystoneMaxMessages: z.number().int().nonnegative().optional(),
    keystoneMinSignificance: z.number().min(0).max(1).optional(),
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
  description: 'Four-layer memory architecture for OpenClaw agents: Redis hot cache, message history, vector search, and structured library.',
  kind: 'context-engine',
  configSchema: buildPluginConfigSchema(hypercompositorConfigSchema),
  register(api) {
    // ── Resolve plugin config from openclaw.json ──
    const pluginCfg = (api.pluginConfig ?? {}) as HypercompositorConfig;
    _pluginConfig = pluginCfg;

    // ── Resolve HYPERMEM_PATH: pluginConfig > npm resolve > dev fallback ──
    if (pluginCfg.hyperMemPath) {
      HYPERMEM_PATH = pluginCfg.hyperMemPath;
      console.log(`[hypermem-plugin] Using configured hyperMemPath: ${HYPERMEM_PATH}`);
    } else {
      try {
        HYPERMEM_PATH = require.resolve('@psiclawops/hypermem');
        console.log(`[hypermem-plugin] Resolved @psiclawops/hypermem from node_modules: ${HYPERMEM_PATH}`);
      } catch {
        // Dev fallback: resolve relative to plugin directory
        const __pluginDir = path.dirname(fileURLToPath(import.meta.url));
        HYPERMEM_PATH = path.resolve(__pluginDir, '../../dist/index.js');
        console.log(`[hypermem-plugin] Falling back to dev path: ${HYPERMEM_PATH}`);
      }
    }

    api.registerContextEngine('hypercompositor', () => engine);

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
