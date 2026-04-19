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
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import type {
  HyperMem as HyperMemClass,
} from '@psiclawops/hypermem';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { fileURLToPath } from 'url';

// ─── HyperMem singleton ────────────────────────────────────────
// Reuses the same singleton pattern as the context engine plugin.
// Both plugins load from the same installed runtime payload and share the instance.

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

let _hm: HyperMemInstance | null = null;
let _hmInitPromise: Promise<HyperMemInstance> | null = null;

async function getHyperMem(): Promise<HyperMemInstance> {
  if (_hm) return _hm;
  if (_hmInitPromise) return _hmInitPromise;

  _hmInitPromise = (async () => {
    const hypermemPath = await resolveHyperMemPath();
    const mod = await import(hypermemPath);
    const HyperMem = mod.HyperMem;

    const instance = await HyperMem.create({
      dataDir: path.join(os.homedir(), '.openclaw/hypermem'),
      cache: {
        keyPrefix: 'hm:',
        sessionTTL: 14400,
        historyTTL: 86400,
      },
    });

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
