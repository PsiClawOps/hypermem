/**
 * HyperMem Context Engine Plugin
 *
 * Implements OpenClaw's ContextEngine interface backed by HyperMem's
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
 *   dispose()    → close HyperMem connections
 *
 * Session key format expected: "agent:<agentId>:<channel>:<name>"
 */

import { definePluginEntry, emptyPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';
import type { ContextEngine, ContextEngineInfo } from 'openclaw/plugin-sdk';
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
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { createRequire } from 'module';

// Re-export core types for consumers (eliminates local shim drift)
export type { NeutralMessage, NeutralToolCall, NeutralToolResult, ComposeRequest, ComposeResult };

// ─── HyperMem singleton ────────────────────────────────────────

// Runtime load is dynamic (HyperMem is a sibling package loaded from repo dist,
// not installed via npm). Types come from the core package devDependency.
// This pattern keeps the runtime path stable while TypeScript resolves types
// from the canonical source — no more local shim drift.
const HYPERMEM_PATH = path.join(os.homedir(), '.openclaw/workspace/repo/hypermem/dist/index.js');
const require = createRequire(import.meta.url);

// HyperMemInstance is the resolved return type of HyperMem.create().
// HyperMem has a private constructor (factory pattern), so we can't use
// InstanceType<> directly. Awaited<ReturnType<...>> extracts the same type
// without requiring constructor access. If core adds/changes a field, the
// plugin type-errors at CI time instead of silently drifting.
type HyperMemInstance = Awaited<ReturnType<typeof HyperMemClass.create>>;

let _hm: HyperMemInstance | null = null;
let _hmInitPromise: Promise<HyperMemInstance> | null = null;
let _indexer: BackgroundIndexer | null = null;
let _fleetStore: FleetStore | null = null;
let _generateEmbeddings: ((texts: string[]) => Promise<Float32Array[]>) | null = null;
// P1.7: TaskFlow runtime reference — bound at registration time, best-effort.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _taskFlowRuntime: any | null = null;

/**
 * Load optional user config from ~/.openclaw/hypermem/config.json.
 * Supports overriding compositor tuning knobs without editing plugin source.
 * Unknown keys are ignored. Missing file is silently skipped.
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
}> {
  const configPath = path.join(os.homedir(), '.openclaw/hypermem/config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    console.log(`[hypermem-plugin] Loaded user config from ${configPath}`);
    return parsed as ReturnType<typeof loadUserConfig> extends Promise<infer T> ? T : never;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[hypermem-plugin] Failed to parse config.json (using defaults):`, (err as Error).message);
    }
    return {};
  }
}

async function getHyperMem(): Promise<HyperMemInstance> {
  if (_hm) return _hm;
  if (_hmInitPromise) return _hmInitPromise;

  _hmInitPromise = (async () => {
    // Dynamic import — HyperMem is loaded from repo dist
    const mod = await import(HYPERMEM_PATH);
    const HyperMem = mod.HyperMem;

    // Capture generateEmbeddings from the dynamic module for use in afterTurn()
    if (typeof mod.generateEmbeddings === 'function') {
      _generateEmbeddings = mod.generateEmbeddings as (texts: string[]) => Promise<Float32Array[]>;
    }

    // Load optional user config — compositor tuning overrides
    const userConfig = await loadUserConfig();

    const instance = await HyperMem.create({
      dataDir: path.join(os.homedir(), '.openclaw/hypermem'),
      redis: {
        host: 'localhost',
        port: 6379,
        keyPrefix: 'hm:',
        sessionTTL: 14400,     // 4h for system/identity/meta slots
        historyTTL: 86400,     // 24h for history — ages out, not count-trimmed
      },
      ...(userConfig.compositor ? { compositor: userConfig.compositor } : {}),
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
        vectorStore?: any
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
        instance.getVectorStore() ?? undefined
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

/**
 * Convert an OpenClaw AgentMessage to HyperMem's NeutralMessage format.
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
  const toolResults: NeutralToolResult[] | null = (msg.role === 'tool' || msg.role === 'tool_result')
    ? (msg.content as unknown as NeutralToolResult[] | null) ?? null
    : null;

  const role = msg.role === 'tool' || msg.role === 'tool_result'
    ? 'assistant'  // Tool results are part of the assistant turn in our model
    : (msg.role as 'user' | 'assistant' | 'system');

  return {
    role,
    textContent,
    toolCalls,
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
 * used by the HyperMem compositor. Fast and allocation-free — no tokenizer
 * library needed for a budget guard.
 */
function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
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
    const window = await hm.redis.getWindow(agentId, sessionKey)
      ?? await hm.redis.getHistory(agentId, sessionKey);
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

    // Only rewrite if meaningfully over target
    if (messageEntries.length <= targetDepth * 1.5) return false;

    const keptMessages = messageEntries.slice(-targetDepth);
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
    console.warn('[hypermem-plugin] truncateJsonl failed (non-fatal):', (err as Error).message);
    return false;
  }
}

function createHyperMemEngine(): ContextEngine {
  return {
    info: {
      id: 'hypermem',
      name: 'HyperMem Context Engine',
      version: '0.1.0',
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

        // Fast path: if session already has history in Redis, skip warm entirely.
        // sessionExists() is a single EXISTS call — sub-millisecond cost.
        const alreadyWarm = await hm.redis.sessionExists(agentId, sk);
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
        const warmPromise = hm.warm(agentId, sk).finally(() => {
          _warmInFlight.delete(inflightKey);
        });
        _warmInFlight.set(inflightKey, warmPromise);
        await warmPromise;

        return { bootstrapped: true };
      } catch (err) {
        // Bootstrap failure is non-fatal — log and continue
        console.warn('[hypermem-plugin] bootstrap failed:', (err as Error).message);
        return { bootstrapped: false, reason: (err as Error).message };
      }
    },

    /**
     * Ingest a single message into HyperMem's message store.
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
        const neutral = toNeutralMessage(msg);

        // Route to appropriate record method based on role
        if (neutral.role === 'user') {
          // recordUserMessage expects (agentId, sessionKey, content: string, opts?)
          await hm.recordUserMessage(agentId, sk, neutral.textContent ?? '');
        } else {
          await hm.recordAssistantMessage(agentId, sk, neutral);
        }
        return { ingested: true };
      } catch (err) {
        // Ingest failure is non-fatal — record is best-effort
        console.warn('[hypermem-plugin] ingest failed:', (err as Error).message);
        return { ingested: false };
      }
    },

    /**
     * Assemble model context from all four HyperMem layers.
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
        // Return the runtime-provided messages unchanged.
        // estimatedTokens=0 signals no HyperMem token budget was consumed;
        // the runtime uses its own estimate for the overflow check.
        return {
          messages: messages as unknown as import('@mariozechner/pi-agent-core').AgentMessage[],
          estimatedTokens: 0,
        };
      }

      try {
      const hm = await getHyperMem();
      const sk = resolveSessionKey(sessionId, sessionKey);
      const agentId = extractAgentId(sk);

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
      const effectiveBudget = tokenBudget ?? 90000;
      const historyDepth = Math.min(250, Math.max(50, Math.floor((effectiveBudget * 0.65) / 500)));

      // ── Redis guardrail: trim history to token budget ────────────────────
      // Prevents model-switch bloat: if an agent previously ran on a larger
      // context window, Redis history may exceed the current model's budget.
      // Trimming here (before compose) ensures the compositor never sees a
      // history window it can't fit. Uses 80% of budget as the trim ceiling
      // to leave room for system prompt, facts, and identity slots.
      try {
        const trimBudget = Math.floor(effectiveBudget * 0.8);
        const trimmed = await hm.redis.trimHistoryToTokenBudget(agentId, sk, trimBudget);
        if (trimmed > 0) {
          // Invalidate window cache since history changed
          await hm.redis.invalidateWindow(agentId, sk);
        }
      } catch (trimErr) {
        // Non-fatal — compositor's budget-fit walk is the second line of defense
        console.warn('[hypermem-plugin] assemble: Redis trim failed (non-fatal):', (trimErr as Error).message);
      }

      const request: ComposeRequest = {
        agentId,
        sessionKey: sk,
        tokenBudget: effectiveBudget,
        historyDepth,
        tier,
        model,          // pass model for provider detection
        includeDocChunks: true,
        prompt,
        skipProviderTranslation: true,  // runtime handles provider translation
      };

      const result: ComposeResult = await hm.compose(request);

      // Convert NeutralMessage[] → AgentMessage[] for the OpenClaw runtime.
      // neutralToAgentMessage can return a single message or an array (tool results
      // expand to individual ToolResultMessage objects), so we flatMap.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outputMessages = result.messages
        .filter(m => m.role != null)
        .flatMap(m => neutralToAgentMessage(m as unknown as NeutralMessage)) as unknown as any[];

      return {
        messages: outputMessages,
        estimatedTokens: result.tokenCount ?? 0,
        // systemPromptAddition injects HyperMem context before the runtime system prompt.
        // This is the facts/recall/episodes block assembled by the compositor.
        systemPromptAddition: result.contextBlock || undefined,
      };
      } catch (err) {
        console.error('[hypermem-plugin] assemble error (stack):', (err as Error).stack ?? err);
        throw err; // Re-throw so the runtime falls back to legacy pipeline
      }
    },

    /**
     * Compact context. HyperMem owns compaction.
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

        // Always re-estimate from the actual Redis window rather than trusting
        // the caller's currentTokenCount. The runtime's estimate is what triggered
        // compaction — if it were accurate, we wouldn't be here. Our own estimate
        // uses the corrected tool-density heuristic (length/2 for JSON payloads).
        const effectiveBudget = tokenBudget ?? 90_000;
        const tokensBefore = await estimateWindowTokens(hm, agentId, sk);
        if (currentTokenCount != null && Math.abs(currentTokenCount - tokensBefore) > effectiveBudget * 0.1) {
          console.warn(`[hypermem-plugin] compact: runtime estimate (${currentTokenCount}) diverges from window estimate (${tokensBefore}) by >10% — using window estimate`);
        }

        // Target depth for both Redis trimming and JSONL truncation.
        // Target 50% of budget capacity, assume ~500 tokens/message average.
        const targetDepth = Math.max(20, Math.floor((effectiveBudget * 0.5) / 500));

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
        const window = await hm.redis.getWindow(agentId, sk);
        if (window && window.length > targetDepth) {
          const trimmed = window.slice(-targetDepth);
          await hm.redis.setWindow(agentId, sk, trimmed);
        }

        // Always trim the underlying history list — this is the source of truth
        // when no window cache exists. trimHistoryToTokenBudget walks newest→oldest
        // and LTRIMs everything beyond the budget.
        const trimBudget = Math.floor(effectiveBudget * 0.5);
        const historyTrimmed = await hm.redis.trimHistoryToTokenBudget(agentId, sk, trimBudget);
        if (historyTrimmed > 0) {
          console.log(`[hypermem-plugin] compact: trimmed ${historyTrimmed} messages from history list`);
        }

        // Invalidate the compose cache so next assemble() re-builds from trimmed data
        await hm.redis.invalidateWindow(agentId, sk).catch(() => {});

        const tokensAfter = await estimateWindowTokens(hm, agentId, sk);
        console.log(`[hypermem-plugin] compact: trimmed ${tokensBefore} → ${tokensAfter} tokens (budget: ${effectiveBudget})`);

        // Truncate the JSONL to match the Redis window depth
        await truncateJsonlIfNeeded(sessionFile, targetDepth);

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
          const neutral = toNeutralMessage(m);
          if (neutral.role === 'user') {
            // SKIP: user messages are recorded by onMessageReceived() via message:received hook
            // (bare text, before LLM call). Recording here produces a second ENVELOPE version
            // with "Sender (untrusted metadata): {...}" prepended — halving effective history
            // depth and leaking metadata into conversation context.
            // Fix: Anvil bug report 2026-04-05 (dual recording path).
            continue;
          } else {
            await hm.recordAssistantMessage(agentId, sk, neutral);
          }
        }

        // Recompute the Redis hot history from SQLite so turn-age gradient is
        // materialized after every turn. This prevents warm-compressed history
        // from drifting back to raw payloads during live sessions.
        try {
          await hm.refreshRedisGradient(agentId, sk);
        } catch (refreshErr) {
          console.warn('[hypermem-plugin] afterTurn: refreshRedisGradient failed (non-fatal):', (refreshErr as Error).message);
        }

        // Invalidate the window cache after ingesting new messages.
        // The next assemble() call will re-compose with the new data.
        try {
          await hm.redis.invalidateWindow(agentId, sk);
        } catch {
          // Window invalidation is best-effort
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
                await hm.redis.setQueryEmbedding(agentId, sk, embedding);
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
          const _skForTick = sk;
          const runTick = async () => {
            if (_taskFlowRuntime) {
              try {
                const flow = _taskFlowRuntime.createManaged({
                  controllerId: 'hypermem/indexer',
                  goal: `Index messages for ${_agentIdForTick}`,
                });
                _taskFlowRuntime.runTask({
                  flowId: flow.flowId,
                  runtime: 'local',
                  childSessionKey: _skForTick,
                  task: `Indexer tick — ${_agentIdForTick}`,
                  status: 'running',
                  startedAt: Date.now(),
                });
                await _indexer!.tick();
                // createManaged tracks completion automatically
              } catch {
                // TaskFlow wrapping is best-effort — fall back to bare tick
                await _indexer!.tick();
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
     * Dispose: intentionally a no-op.
     *
     * The runtime calls dispose() at the end of every request cycle, but
     * HyperMem's Redis connection and SQLite handles are gateway-lifetime
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
 * Convert HyperMem's NeutralMessage back to OpenClaw's AgentMessage format.
 *
 * The runtime expects messages conforming to pi-ai's Message union:
 *   UserMessage:       { role: 'user', content: string | ContentBlock[], timestamp }
 *   AssistantMessage:  { role: 'assistant', content: ContentBlock[], api, provider, model, usage, stopReason, timestamp }
 *   ToolResultMessage: { role: 'toolResult', toolCallId, toolName, content, isError, timestamp }
 *
 * HyperMem stores tool results as NeutralMessage with role='user' and toolResults[].
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

// ─── Plugin Entry ───────────────────────────────────────────────

const engine = createHyperMemEngine();

export default definePluginEntry({
  id: 'hypermem',
  name: 'HyperMem Context Engine',
  description: 'Four-layer memory architecture for OpenClaw agents: Redis hot cache, message history, vector search, and structured library.',
  kind: 'context-engine',
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerContextEngine('hypermem', () => engine);

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
