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
import { delegateCompactionToRuntime } from 'openclaw/plugin-sdk/core';
import type { ContextEngine, ContextEngineInfo } from 'openclaw/plugin-sdk';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

// ─── HyperMem singleton ────────────────────────────────────────

// Dynamic import via createRequire because HyperMem is a sibling package
// (not installed via npm, loaded from the repo dist directly)
const HYPERMEM_PATH = path.join(os.homedir(), '.openclaw/workspace/repo/hypermem/dist/index.js');
const require = createRequire(import.meta.url);

let _hm: HyperMemInstance | null = null;
let _hmInitPromise: Promise<HyperMemInstance> | null = null;

// Minimal type shim — we import dynamically so TypeScript can't infer the full type
type HyperMemInstance = {
  recordUserMessage: (agentId: string, sessionKey: string, message: NeutralMessage) => Promise<unknown>;
  recordAssistantMessage: (agentId: string, sessionKey: string, message: NeutralMessage) => Promise<unknown>;
  compose: (request: ComposeRequest) => Promise<ComposeResult>;
  dbManager: {
    getMessageDb: (agentId: string) => unknown;
    getLibraryDb: () => unknown;
  };
  fleetStore?: {
    getAgent: (agentId: string) => { tier?: string } | null;
  };
  redis: {
    warmSession: (sessionKey: string, opts?: unknown) => Promise<void>;
    close: () => Promise<void>;
  };
  indexer?: {
    processAgent: (agentId: string) => Promise<void>;
  };
  close: () => Promise<void>;
};

type NeutralMessage = {
  role: 'user' | 'assistant' | 'system';
  textContent: string | null;
  toolCalls: unknown;
  toolResults: unknown;
};

type ComposeRequest = {
  agentId: string;
  sessionKey: string;
  tokenBudget?: number;
  tier?: string;
  includeDocChunks?: boolean;
  prompt?: string;
};

type ComposeResult = {
  messages: NeutralMessage[];
  totalTokens: number;
  contextBlock?: string;
  truncated: boolean;
  hasWarnings: boolean;
  warnings: string[];
  slots: Record<string, number>;
};

async function getHyperMem(): Promise<HyperMemInstance> {
  if (_hm) return _hm;
  if (_hmInitPromise) return _hmInitPromise;

  _hmInitPromise = (async () => {
    // Dynamic import — HyperMem is loaded from repo dist
    const mod = await import(HYPERMEM_PATH);
    const HyperMem = mod.HyperMem;

    const instance = await HyperMem.create({
      dataDir: path.join(os.homedir(), '.openclaw/hypermem'),
      redis: {
        host: 'localhost',
        port: 6379,
        keyPrefix: 'hm:',
        sessionTTL: 86400,
      },
    });

    _hm = instance;
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
  content?: string | Array<{ type: string; text?: string }>;
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

  // Detect tool calls/results
  const toolCalls = (msg.tool_calls || msg.toolCalls) ?? null;
  const toolResults = (msg.role === 'tool' || msg.role === 'tool_result') ? msg.content : null;

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

function createHyperMemEngine(): ContextEngine {
  return {
    info: {
      id: 'hypermem',
      name: 'HyperMem Context Engine',
      version: '0.1.0',
      ownsCompaction: false,
    } satisfies ContextEngineInfo,

    /**
     * Bootstrap: warm Redis session for this agent, register in fleet if needed.
     */
    async bootstrap({ sessionId, sessionKey }): ReturnType<NonNullable<ContextEngine['bootstrap']>> {
      try {
        const hm = await getHyperMem();
        const sk = resolveSessionKey(sessionId, sessionKey);
        const agentId = extractAgentId(sk);

        // Warm Redis with the session — this pre-loads system/identity slots
        await hm.redis.warmSession(sk, { agentId });

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
          await hm.recordUserMessage(agentId, sk, neutral);
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
    async assemble({ sessionId, sessionKey, messages, tokenBudget, prompt }): ReturnType<ContextEngine['assemble']> {
      const hm = await getHyperMem();
      const sk = resolveSessionKey(sessionId, sessionKey);
      const agentId = extractAgentId(sk);

      // Resolve agent tier from fleet store (for doc chunk tier filtering)
      let tier: string | undefined;
      try {
        const agent = hm.fleetStore?.getAgent(agentId);
        tier = agent?.tier;
      } catch {
        // Non-fatal — tier filtering just won't apply
      }

      const request: ComposeRequest = {
        agentId,
        sessionKey: sk,
        tokenBudget,
        tier,
        includeDocChunks: true,
        prompt,
      };

      const result: ComposeResult = await hm.compose(request);

      // Convert NeutralMessage[] → AgentMessage[] for the OpenClaw runtime.
      // The compositor returns messages in HyperMem's neutral format.
      // Cast via unknown since InboundMessage doesn't satisfy AgentMessage's
      // strict discriminated union — the runtime accepts the wire shape at runtime.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const outputMessages = result.messages.map(neutralToAgentMessage) as unknown as any[];

      return {
        messages: outputMessages,
        estimatedTokens: result.totalTokens,
        // systemPromptAddition injects HyperMem context before the runtime system prompt.
        // This is the facts/recall/episodes block assembled by the compositor.
        systemPromptAddition: result.contextBlock || undefined,
      };
    },

    /**
     * Compact context. We don't own compaction — delegate to runtime.
     */
    async compact(params): ReturnType<ContextEngine['compact']> {
      return delegateCompactionToRuntime(params);
    },

    /**
     * After-turn hook: trigger background indexer fire-and-forget.
     * Indexes new messages into facts/episodes/topics without blocking.
     */
    async afterTurn({ sessionId, sessionKey, isHeartbeat }): Promise<void> {
      if (isHeartbeat) return;

      try {
        const hm = await getHyperMem();
        const sk = resolveSessionKey(sessionId, sessionKey);
        const agentId = extractAgentId(sk);

        if (hm.indexer?.processAgent) {
          // Fire-and-forget — don't await, don't block the response
          hm.indexer.processAgent(agentId).catch((err: Error) => {
            console.warn('[hypermem-plugin] background indexer failed:', err.message);
          });
        }
      } catch (err) {
        // afterTurn is never fatal
        console.warn('[hypermem-plugin] afterTurn failed:', (err as Error).message);
      }
    },

    /**
     * Dispose: close HyperMem connections cleanly.
     */
    async dispose(): Promise<void> {
      if (_hm) {
        try {
          await _hm.close();
        } catch {
          // Best effort
        }
        _hm = null;
        _hmInitPromise = null;
      }
    },
  };
}

// ─── NeutralMessage → AgentMessage ─────────────────────────────

/**
 * Convert HyperMem's NeutralMessage back to OpenClaw's AgentMessage format.
 */
function neutralToAgentMessage(msg: NeutralMessage): InboundMessage {
  const out: InboundMessage = {
    role: msg.role,
  };

  if (msg.textContent !== null) {
    out.content = msg.textContent;
  }

  if (msg.toolCalls) {
    out.tool_calls = msg.toolCalls;
  }

  if (msg.toolResults) {
    out.content = msg.toolResults as string;
  }

  return out;
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
  },
});
