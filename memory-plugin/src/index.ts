/**
 * HyperMem Memory Plugin
 *
 * Thin adapter that bridges HyperMem's retrieval capabilities into
 * OpenClaw's memory slot contract (`kind: "memory"`).
 *
 * The context engine plugin (hypercompositor) owns the full lifecycle:
 * ingest, assemble, compact, afterTurn, bootstrap, dispose.
 *
 * This plugin owns the memory slot contract:
 * - registerMemoryCapability() with runtime + publicArtifacts
 * - memory_search tool backing via MemorySearchManager
 * - Public artifacts for memory-wiki bridge
 *
 * Both plugins share the same HyperMem singleton (loaded from repo dist).
 */

import { definePluginEntry, emptyPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';
import type { AnyAgentTool, OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { matchTriggers, TRIGGER_REGISTRY } from '@psiclawops/hypermem';
import type {
  HyperMem as HyperMemClass,
  DocChunkRow,
} from '@psiclawops/hypermem';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

// ─── HyperMem singleton ────────────────────────────────────────
// HyperMem.create() in the core package now dedupes per absolute dataDir, so
// whichever of the two plugins (context-engine, memory) calls create() first
// owns the instance. To avoid a race where this plugin would otherwise win
// boot with no embedding config and force defaults onto the shared instance,
// we load the same user config file the context-engine plugin loads and pass
// the full embedding/reranker config through to create().

const __pluginDir = path.dirname(fileURLToPath(import.meta.url));

async function resolveHyperMemPath(): Promise<string> {
  try {
    const resolvedUrl = await import.meta.resolve('@psiclawops/hypermem');
    return resolvedUrl.startsWith('file:') ? fileURLToPath(resolvedUrl) : resolvedUrl;
  } catch {
    return path.resolve(__pluginDir, '../../dist/index.js');
  }
}

type HyperMemInstance = Awaited<ReturnType<typeof HyperMemClass.create>>;

async function loadFileConfig(dataDir: string): Promise<Record<string, unknown>> {
  const configPath = path.join(dataDir, 'config.json');
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[hypermem-memory] Failed to parse config.json (using defaults):`, (err as Error).message);
    }
    return {};
  }
}

let _hm: HyperMemInstance | null = null;
let _hmInitPromise: Promise<HyperMemInstance> | null = null;

async function getHyperMem(): Promise<HyperMemInstance> {
  if (_hm) return _hm;
  if (_hmInitPromise) return _hmInitPromise;

  _hmInitPromise = (async () => {
    const hypermemPath = await resolveHyperMemPath();
    const mod = await import(hypermemPath);
    const HyperMem = mod.HyperMem;

    const dataDir = path.join(os.homedir(), '.openclaw/hypermem');
    const fileConfig = await loadFileConfig(dataDir);

    const createConfig: Record<string, unknown> = {
      dataDir,
      cache: {
        keyPrefix: 'hm:',
        sessionTTL: 14400,
        historyTTL: 86400,
      },
    };
    // Forward embedding + reranker so this plugin's create() call produces
    // an equivalent instance to the context-engine plugin's. Other config
    // sections (compositor, indexer, dreaming, etc.) are owned by the
    // context-engine plugin and only matter when it wins the singleton race.
    if (fileConfig.embedding) createConfig.embedding = fileConfig.embedding;
    if (fileConfig.reranker) createConfig.reranker = fileConfig.reranker;

    const instance = await HyperMem.create(createConfig);

    _hm = instance;
    return instance;
  })();

  return _hmInitPromise;
}

// ─── MemorySearchManager adapter ────────────────────────────────

type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: 'memory' | 'sessions';
  citation?: string;
};

type MemoryProviderStatus = {
  backend: 'builtin' | 'qmd';
  provider: string;
  model?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
  workspaceDir?: string;
  dbPath?: string;
  sources?: Array<'memory' | 'sessions'>;
  fts?: {
    enabled: boolean;
    available: boolean;
    error?: string;
  };
  vector?: {
    enabled: boolean;
    available?: boolean;
    dims?: number;
  };
  custom?: Record<string, unknown>;
};

const DOCTRINE_COLLECTIONS = new Set([
  'governance/policy',
  'governance/charter',
  'governance/comms',
  'operations/agents',
]);

function doctrineScore(chunk: DocChunkRow, rank: number): number {
  const collectionBoost = chunk.collection.startsWith('governance/') ? 1.25 : 1.1;
  return collectionBoost - Math.min(rank, 9) * 0.03;
}

function docChunkToMemoryResult(chunk: DocChunkRow, rank: number): MemorySearchResult {
  return {
    path: chunk.sourcePath,
    startLine: 0,
    endLine: 0,
    score: doctrineScore(chunk, rank),
    snippet: chunk.content.slice(0, 500),
    source: 'memory',
    citation: `[doc:${chunk.collection}:${chunk.sectionPath}]`,
  };
}

/**
 * Create a MemorySearchManager backed by HyperMem's retrieval pipeline.
 *
 * Uses HyperMem's:
 * - library.db fact search (FTS5 + BM25)
 * - vector store semantic search (when available)
 * - message search (full-text across conversations)
 */
function createMemorySearchManager(
  hm: HyperMemInstance,
  agentId: string,
  workspaceDir: string,
): {
  search(query: string, opts?: { maxResults?: number; minScore?: number; sessionKey?: string }): Promise<MemorySearchResult[]>;
  readFile(params: { relPath: string; from?: number; lines?: number }): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }>;
  probeVectorAvailability(): Promise<boolean>;
  close?(): Promise<void>;
} {
  return {
    async search(query, opts) {
      const maxResults = opts?.maxResults ?? 10;
      const minScore = opts?.minScore ?? 0;
      const results: MemorySearchResult[] = [];
      const seenDocChunks = new Set<string>();

      // 0. Canonical doctrine search. Explicit governance queries should surface
      // policy, charter, comms, and AGENTS chunks before stale daily-memory folklore.
      try {
        const triggers = matchTriggers(query, TRIGGER_REGISTRY)
          .filter(trigger => DOCTRINE_COLLECTIONS.has(trigger.collection))
          .slice(0, 4);

        for (const trigger of triggers) {
          const chunks = hm.queryDocChunks({
            collection: trigger.collection,
            agentId,
            keyword: query,
            limit: Math.max(3, Math.ceil(maxResults / Math.max(1, triggers.length))),
          }) as DocChunkRow[];

          chunks.forEach((chunk, rank) => {
            const key = `${chunk.sourcePath}:${chunk.sectionPath}:${chunk.sourceHash}`;
            if (seenDocChunks.has(key)) return;
            seenDocChunks.add(key);

            const result = docChunkToMemoryResult(chunk, rank);
            if (result.score >= minScore) results.push(result);
          });
        }
      } catch {
        // Doctrine search is a precision boost, not a hard dependency.
      }

      // 1. Fact search (FTS5 + BM25 from library.db)
      try {
        const facts = hm.getActiveFacts(agentId, { limit: maxResults * 2 }) as Array<{
          id: number;
          content: string;
          domain?: string;
          confidence?: number;
        }>;

        // Simple keyword matching for facts (FTS5 handles this in the DB layer)
        const queryLower = query.toLowerCase();
        const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 2);

        for (const fact of facts) {
          const contentLower = fact.content.toLowerCase();
          const matchCount = queryTerms.filter(t => contentLower.includes(t)).length;
          if (matchCount === 0) continue;

          const score = matchCount / queryTerms.length;
          if (score < minScore) continue;

          results.push({
            path: `library://facts/${fact.id}`,
            startLine: 0,
            endLine: 0,
            score,
            snippet: fact.content.slice(0, 300),
            source: 'memory',
            citation: fact.domain ? `[fact:${fact.domain}]` : '[fact]',
          });
        }
      } catch {
        // Fact search non-fatal
      }

      // 2. Vector/semantic search (when available)
      try {
        const vectorStore = hm.getVectorStore();
        if (vectorStore) {
          const vectorResults = await hm.semanticSearch(agentId, query, {
            limit: maxResults,
            maxDistance: 1.5,
          });

          for (const vr of vectorResults) {
            const score = 1.0 - (vr.distance / 2.0); // normalize distance to 0-1 score
            if (score < minScore) continue;

            results.push({
              path: `vector://${vr.sourceTable}/${vr.sourceId}`,
              startLine: 0,
              endLine: 0,
              score,
              snippet: vr.content.slice(0, 300),
              source: 'memory',
              citation: `[${vr.sourceTable}:${vr.sourceId}]`,
            });
          }
        }
      } catch {
        // Vector search non-fatal
      }

      // 3. Message search (FTS5 across conversations)
      try {
        const messageResults = hm.search(agentId, query, maxResults);
        for (const msg of messageResults) {
          const content = msg.textContent ?? '';
          results.push({
            path: `messages://${msg.conversationId ?? 'unknown'}/${msg.id}`,
            startLine: 0,
            endLine: 0,
            score: 0.5, // message search doesn't return scores, use mid-range
            snippet: content.slice(0, 300),
            source: 'sessions',
            citation: `[message:${msg.id}]`,
          });
        }
      } catch {
        // Message search non-fatal
      }

      // Deduplicate by content similarity, sort by score, limit
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, maxResults);
    },

    async readFile(params) {
      const absPath = path.resolve(workspaceDir, params.relPath);
      try {
        const content = await fs.readFile(absPath, 'utf-8');
        const lines = content.split('\n');
        const from = params.from ?? 0;
        const count = params.lines ?? lines.length;
        const slice = lines.slice(from, from + count);
        return { text: slice.join('\n'), path: absPath };
      } catch (err) {
        return { text: `Error reading ${absPath}: ${(err as Error).message}`, path: absPath };
      }
    },

    status() {
      const vectorStore = hm.getVectorStore();
      const vectorStats = vectorStore ? hm.getVectorStats(agentId) : null;

      return {
        backend: 'builtin' as const,
        provider: 'hypermem',
        model: 'hypermem-fts5+vector',
        workspaceDir,
        dbPath: path.join(os.homedir(), '.openclaw/hypermem'),
        sources: ['memory', 'sessions'] as Array<'memory' | 'sessions'>,
        fts: {
          enabled: true,
          available: true,
        },
        vector: {
          enabled: !!vectorStore,
          available: !!vectorStore,
          dims: (vectorStats as { dimensions?: number; dims?: number } | null)?.dimensions
            ?? (vectorStats as { dimensions?: number; dims?: number } | null)?.dims
            ?? undefined,
        },
        custom: {
          vectorStats: vectorStats ?? undefined,
          factCount: (hm.getActiveFacts(agentId, { limit: 1 }) as unknown[]).length > 0 ? 'available' : 'empty',
        },
      };
    },

    async probeEmbeddingAvailability() {
      try {
        const vectorStore = hm.getVectorStore();
        if (!vectorStore) return { ok: false, error: 'Vector store not initialized' };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    async probeVectorAvailability() {
      return !!hm.getVectorStore();
    },
  };
}


// ─── history.query agent tool ───────────────────────────────────

const HISTORY_QUERY_MODES = [
  'runtime_chain',
  'transcript_tail',
  'tool_events',
  'by_topic',
  'by_context',
  'cross_session',
] as const;

type HistoryQueryMode = typeof HISTORY_QUERY_MODES[number];

const HISTORY_QUERY_TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: HISTORY_QUERY_MODES,
      description: 'History query mode. cross_session is scoped to the current agent by default.',
    },
    sessionKey: {
      type: 'string',
      description: 'Optional session key. Defaults to the active session when available.',
    },
    conversationId: {
      type: 'number',
      description: 'Optional direct conversation id. Must belong to the current agent.',
    },
    contextId: {
      type: 'number',
      description: 'Required for by_context mode. Must belong to the current agent.',
    },
    topicId: {
      type: 'string',
      description: 'Required for by_topic mode.',
    },
    limit: {
      type: 'number',
      description: 'Optional result limit. HyperMem clamps this to the hard cap for the selected mode.',
    },
    minMessageId: {
      type: 'number',
      description: 'Optional lower message id bound for supported modes.',
    },
    since: {
      type: 'string',
      description: 'Optional ISO timestamp lower bound for cross_session mode.',
    },
    includeArchived: {
      type: 'boolean',
      description: 'Allow archived/forked contexts for by_context mode.',
    },
    includeToolPayloads: {
      type: 'boolean',
      description: 'Return raw tool payloads for tool_events. Requires owner context; default is redacted.',
    },
  },
  required: ['mode'],
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  return typeof params[key] === 'boolean' ? params[key] : undefined;
}

function isHistoryQueryMode(value: unknown): value is HistoryQueryMode {
  return typeof value === 'string' && (HISTORY_QUERY_MODES as readonly string[]).includes(value);
}

function historyQueryTelemetryEnabled(): boolean {
  return process.env.HYPERMEM_TELEMETRY === '1';
}

type HistoryQueryTelemetryEvent = {
  event: 'history-query';
  ts: string;
  status: 'ok' | 'error';
  mode?: HistoryQueryMode;
  agentId: string;
  hasSessionKey: boolean;
  hasConversationId: boolean;
  includeToolPayloads: boolean;
  messageCount?: number;
  truncated?: boolean;
  redacted?: boolean;
  durationMs: number;
  errorCode?: 'invalid-mode' | 'owner-required' | 'query-failed';
};

function emitHistoryQueryTelemetry(event: HistoryQueryTelemetryEvent): void {
  if (!historyQueryTelemetryEnabled()) return;
  const telemetryPath = process.env.HYPERMEM_TELEMETRY_PATH || './hypermem-telemetry.jsonl';
  try {
    fsSync.appendFileSync(telemetryPath, `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    // Telemetry must never break the tool path.
  }
}

function createHistoryQueryTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  return {
    name: 'history_query',
    label: 'history.query',
    description: [
      'Query HyperMem SQLite-backed message history for the current agent.',
      'Use this when exact conversation state is needed instead of semantic recall.',
      'Modes: runtime_chain, transcript_tail, tool_events, by_topic, by_context, cross_session.',
      'Tool payloads are redacted by default; raw payloads require owner context.',
    ].join(' '),
    parameters: HISTORY_QUERY_TOOL_PARAMETERS as unknown as AnyAgentTool['parameters'],
    displaySummary: 'Query HyperMem message history',
    async execute(_toolCallId, rawParams) {
      const started = Date.now();
      const params = asRecord(rawParams);
      const mode = params.mode;
      const agentId = ctx.agentId || 'main';
      const includeToolPayloads = optionalBoolean(params, 'includeToolPayloads') === true;
      const baseTelemetry = {
        ts: new Date().toISOString(),
        agentId,
        hasSessionKey: Boolean(optionalString(params, 'sessionKey') ?? ctx.sessionKey),
        hasConversationId: optionalNumber(params, 'conversationId') !== undefined,
        includeToolPayloads,
      };

      if (!isHistoryQueryMode(mode)) {
        emitHistoryQueryTelemetry({
          event: 'history-query',
          status: 'error',
          ...baseTelemetry,
          durationMs: Date.now() - started,
          errorCode: 'invalid-mode',
        });
        throw new Error(`history.query: mode must be one of ${HISTORY_QUERY_MODES.join(', ')}`);
      }

      if (includeToolPayloads && !ctx.senderIsOwner) {
        emitHistoryQueryTelemetry({
          event: 'history-query',
          status: 'error',
          mode,
          ...baseTelemetry,
          durationMs: Date.now() - started,
          errorCode: 'owner-required',
        });
        throw new Error('history.query: includeToolPayloads requires owner context');
      }

      const query: Record<string, unknown> = {
        agentId,
        mode,
        sessionKey: optionalString(params, 'sessionKey') ?? ctx.sessionKey,
        conversationId: optionalNumber(params, 'conversationId'),
        contextId: optionalNumber(params, 'contextId'),
        topicId: optionalString(params, 'topicId'),
        limit: optionalNumber(params, 'limit'),
        minMessageId: optionalNumber(params, 'minMessageId'),
        since: optionalString(params, 'since'),
        includeArchived: optionalBoolean(params, 'includeArchived'),
        includeToolPayloads,
      };

      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) delete query[key];
      }

      try {
        const hm = await getHyperMem();
        const result = (hm as unknown as { queryHistory(query: Record<string, unknown>): { messages: unknown[]; truncated?: boolean; redacted?: boolean } }).queryHistory(query);
        emitHistoryQueryTelemetry({
          event: 'history-query',
          status: 'ok',
          mode,
          ...baseTelemetry,
          messageCount: result.messages.length,
          truncated: Boolean(result.truncated),
          redacted: Boolean(result.redacted),
          durationMs: Date.now() - started,
        });
        const summary = `history.query ${mode}: ${result.messages.length} message(s)`
          + (result.truncated ? ' (truncated)' : '')
          + (result.redacted ? ' (redacted)' : '');

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          details: { status: 'ok', summary, result },
        };
      } catch (err) {
        emitHistoryQueryTelemetry({
          event: 'history-query',
          status: 'error',
          mode,
          ...baseTelemetry,
          durationMs: Date.now() - started,
          errorCode: 'query-failed',
        });
        throw err;
      }
    },
  };
}

// ─── Manager cache ──────────────────────────────────────────────
// One manager per agentId; closed on plugin dispose.
const _managers = new Map<string, ReturnType<typeof createMemorySearchManager>>();

// ─── Plugin Entry ───────────────────────────────────────────────

export default definePluginEntry({
  id: 'hypermem',
  name: 'HyperMem Memory',
  description: 'Bridges HyperMem retrieval (facts, vectors, messages) into the OpenClaw memory slot for memory_search and memory-wiki.',
  kind: 'memory',
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerTool((ctx) => createHistoryQueryTool(ctx), { name: 'history_query', optional: true });

    api.registerMemoryCapability({
      runtime: {
        async getMemorySearchManager(params) {
          try {
            const hm = await getHyperMem();
            const agentId = params.agentId || 'main';

            // Cache managers per agent
            if (!_managers.has(agentId)) {
              // Resolve workspace dir from agent config
              const agents = params.cfg?.agents?.list ?? [];
              const agentCfg = agents.find((a: { id?: string }) => a.id === agentId);
              const workspaceDir = (agentCfg as { workspace?: string } | undefined)?.workspace
                ?? path.join(os.homedir(), '.openclaw/workspace');

              _managers.set(agentId, createMemorySearchManager(hm, agentId, workspaceDir));
            }

            return { manager: _managers.get(agentId)! };
          } catch (err) {
            return { manager: null, error: (err as Error).message };
          }
        },

        resolveMemoryBackendConfig(_params) {
          return { backend: 'builtin' as const };
        },

        async closeAllMemorySearchManagers() {
          _managers.clear();
        },
      },

      publicArtifacts: {
        async listArtifacts(params) {
          const artifacts: Array<{
            kind: string;
            workspaceDir: string;
            relativePath: string;
            absolutePath: string;
            agentIds: string[];
            contentType: 'markdown' | 'json' | 'text';
          }> = [];

          // List memory files for each agent
          const agents = params.cfg?.agents?.list ?? [];
          for (const agent of agents) {
            const agentId = (agent as { id?: string }).id;
            if (!agentId) continue;

            const workspace = (agent as { workspace?: string }).workspace;
            if (!workspace) continue;

            const memoryDir = path.join(workspace, 'memory');
            try {
              const files = await fs.readdir(memoryDir);
              for (const file of files) {
                if (!file.endsWith('.md')) continue;
                artifacts.push({
                  kind: 'memory-daily',
                  workspaceDir: workspace,
                  relativePath: `memory/${file}`,
                  absolutePath: path.join(memoryDir, file),
                  agentIds: [agentId],
                  contentType: 'markdown',
                });
              }
            } catch {
              // No memory dir for this agent — skip
            }

            // Also expose MEMORY.md index
            const memoryIndex = path.join(workspace, 'MEMORY.md');
            try {
              await fs.access(memoryIndex);
              artifacts.push({
                kind: 'memory-index',
                workspaceDir: workspace,
                relativePath: 'MEMORY.md',
                absolutePath: memoryIndex,
                agentIds: [agentId],
                contentType: 'markdown',
              });
            } catch {
              // No MEMORY.md — skip
            }
          }

          return artifacts;
        },
      },
    });
  },
});
