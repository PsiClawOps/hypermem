/**
 * HyperMem Memory Plugin
 *
 * Lightweight memory plugin for the OpenClaw `memory` slot.
 * Provides `memory_search` tool backed by HyperMem's hybrid retrieval
 * (FTS5 + KNN vector search via library.db).
 *
 * Runs alongside the HyperMem context engine plugin (contextEngine slot).
 * The context engine owns session lifecycle, ingest, compose. This plugin
 * owns the memory search tool surface and MemoryPluginCapability registration.
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { jsonResult, readStringParam, readNumberParam } from 'openclaw/plugin-sdk/core';
import type {
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
} from 'openclaw/plugin-sdk';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryProviderStatus,
  MemoryEmbeddingProbeResult,
} from 'openclaw/plugin-sdk/memory-core-host-engine-storage';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// ─── Types for HyperMem dynamic import ─────────────────────────

interface HybridSearchResult {
  sourceTable: string;
  sourceId: number;
  content: string;
  domain?: string;
  agentId?: string;
  metadata?: string;
  createdAt?: string;
  score: number;
  sources: ('fts' | 'knn')[];
}

interface HyperMemInstance {
  dbManager: { getLibraryDb(): unknown };
  getVectorStore(): unknown | null;
}

// ─── HyperMem lazy singleton ───────────────────────────────────

const HYPERMEM_PATH = path.join(os.homedir(), '.openclaw/workspace/repo/hypermem/dist/index.js');

let _hm: HyperMemInstance | null = null;
let _hmInitPromise: Promise<HyperMemInstance> | null = null;

async function getHyperMem(): Promise<HyperMemInstance> {
  if (_hm) return _hm;
  if (_hmInitPromise) return _hmInitPromise;

  _hmInitPromise = (async () => {
    const mod = await import(HYPERMEM_PATH);
    const HyperMem = mod.HyperMem;
    const instance: HyperMemInstance = await HyperMem.create({
      dataDir: path.join(os.homedir(), '.openclaw/hypermem'),
      cache: { keyPrefix: 'hm:', sessionTTL: 14400, historyTTL: 86400 },
    });
    _hm = instance;
    return instance;
  })();

  return _hmInitPromise;
}

let _hybridSearchFn: ((
  libraryDb: unknown,
  vectorStore: unknown | null,
  query: string,
  opts?: Record<string, unknown>,
) => Promise<HybridSearchResult[]>) | null = null;

async function getHybridSearch() {
  if (_hybridSearchFn) return _hybridSearchFn;
  const mod = await import(HYPERMEM_PATH);
  _hybridSearchFn = mod.hybridSearch;
  return _hybridSearchFn!;
}

// ─── Helpers ───────────────────────────────────────────────────

function extractAgentId(sessionKey?: string): string {
  if (!sessionKey) return 'main';
  const parts = sessionKey.split(':');
  if (parts[0] === 'agent' && parts.length >= 2) return parts[1];
  return 'main';
}

async function resolveWorkspacePath(agentId: string): Promise<string | null> {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.openclaw', 'workspace-council', agentId),
    path.join(home, '.openclaw', 'workspace', agentId),
  ];
  for (const p of candidates) {
    try {
      await fs.access(p);
      return p;
    } catch { /* next */ }
  }
  return null;
}

// ─── MemorySearchManager backed by HyperMem ───────────────────

function createHyperMemSearchManager(agentId: string): MemorySearchManager {
  return {
    async search(
      query: string,
      opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
    ): Promise<MemorySearchResult[]> {
      try {
        const hm = await getHyperMem();
        const hybridSearch = await getHybridSearch();
        const libraryDb = hm.dbManager.getLibraryDb();
        const vectorStore = hm.getVectorStore();
        const effectiveAgentId = opts?.sessionKey
          ? extractAgentId(opts.sessionKey)
          : agentId;

        const results = await hybridSearch(libraryDb, vectorStore, query, {
          limit: opts?.maxResults ?? 10,
          agentId: effectiveAgentId,
          tables: ['facts', 'knowledge', 'episodes'],
        });

        const minScore = opts?.minScore ?? 0;

        return results
          .filter((r: HybridSearchResult) => r.score >= minScore)
          .map((r: HybridSearchResult): MemorySearchResult => ({
            path: `library://${r.sourceTable}/${r.sourceId}`,
            startLine: 0,
            endLine: 0,
            score: r.score,
            snippet: r.content,
            source: 'memory',
            citation: r.domain
              ? `[${r.sourceTable}:${r.sourceId}, domain=${r.domain}]`
              : `[${r.sourceTable}:${r.sourceId}]`,
          }));
      } catch (err) {
        console.warn('[hypermem-memory] search failed:', (err as Error).message);
        return [];
      }
    },

    async readFile(params: {
      relPath: string;
      from?: number;
      lines?: number;
    }): Promise<{ text: string; path: string }> {
      const wsPath = await resolveWorkspacePath(agentId);
      if (!wsPath) return { text: '', path: params.relPath };

      const absPath = path.resolve(wsPath, params.relPath);
      if (!absPath.startsWith(wsPath)) {
        return { text: '[access denied: path outside workspace]', path: params.relPath };
      }

      try {
        const content = await fs.readFile(absPath, 'utf-8');
        const allLines = content.split('\n');
        const from = params.from ?? 0;
        const count = params.lines ?? allLines.length;
        return { text: allLines.slice(from, from + count).join('\n'), path: params.relPath };
      } catch {
        return { text: '', path: params.relPath };
      }
    },

    status(): MemoryProviderStatus {
      return {
        backend: 'builtin',
        provider: 'hypermem',
        model: 'hybrid-fts5-knn',
        workspaceDir: path.join(os.homedir(), '.openclaw/hypermem'),
        dbPath: path.join(os.homedir(), '.openclaw/hypermem/library.db'),
        sources: ['memory'],
        fts: { enabled: true, available: true },
        vector: { enabled: true, available: _hm?.getVectorStore() != null },
        custom: { engine: 'hypermem', version: '0.5.1', retrieval: 'hybrid-rrf' },
      };
    },

    async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
      try {
        const hm = await getHyperMem();
        const vs = hm.getVectorStore();
        if (!vs) return { ok: false, error: 'vector store not initialized' };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    async probeVectorAvailability(): Promise<boolean> {
      try {
        const hm = await getHyperMem();
        return hm.getVectorStore() != null;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      // lifecycle owned by context engine plugin
    },
  };
}

// ─── Memory plugin runtime (MemoryPluginRuntime shape) ─────────

const memoryRuntime = {
  async getMemorySearchManager(params: {
    cfg: OpenClawConfig;
    agentId: string;
    purpose?: 'default' | 'status';
  }): Promise<{ manager: MemorySearchManager | null; error?: string }> {
    try {
      return { manager: createHyperMemSearchManager(params.agentId) };
    } catch (err) {
      return { manager: null, error: `HyperMem init failed: ${(err as Error).message}` };
    }
  },

  resolveMemoryBackendConfig(_params: { cfg: OpenClawConfig; agentId: string }) {
    return { backend: 'builtin' as const };
  },

  async closeAllMemorySearchManagers(): Promise<void> {
    // managers are stateless wrappers
  },
};

// ─── Public artifacts provider ─────────────────────────────────

const publicArtifacts: MemoryPluginPublicArtifactsProvider = {
  async listArtifacts(params: { cfg: OpenClawConfig }): Promise<MemoryPluginPublicArtifact[]> {
    const artifacts: MemoryPluginPublicArtifact[] = [];
    const agents = (params.cfg as Record<string, unknown>).agents as { list?: Array<{ id?: string }> } | undefined;
    if (!agents?.list) return artifacts;

    for (const agent of agents.list) {
      if (!agent.id) continue;
      const wsPath = await resolveWorkspacePath(agent.id);
      if (!wsPath) continue;

      const memoryMd = path.join(wsPath, 'MEMORY.md');
      try {
        await fs.access(memoryMd);
        artifacts.push({
          kind: 'memory-root',
          workspaceDir: wsPath,
          relativePath: 'MEMORY.md',
          absolutePath: memoryMd,
          agentIds: [agent.id],
          contentType: 'markdown',
        });
      } catch { /* skip */ }

      const memoryDir = path.join(wsPath, 'memory');
      try {
        const entries = await fs.readdir(memoryDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          artifacts.push({
            kind: 'daily-note',
            workspaceDir: wsPath,
            relativePath: `memory/${entry.name}`,
            absolutePath: path.join(memoryDir, entry.name),
            agentIds: [agent.id],
            contentType: 'markdown',
          });
        }
      } catch { /* skip */ }
    }
    return artifacts;
  },
};

// ─── memory_search tool ────────────────────────────────────────

function createMemorySearchTool(opts: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}) {
  const agentId = extractAgentId(opts.agentSessionKey);

  return {
    label: 'Memory Search',
    name: 'memory_search',
    description:
      'Search agent memory (facts, knowledge, episodes) using hybrid FTS5 + vector retrieval. ' +
      'Use before answering questions about prior work, decisions, context, or history.',
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string' as const, description: 'Semantic search query.' },
        maxResults: { type: 'number' as const, description: 'Maximum results (default: 10).' },
        minScore: { type: 'number' as const, description: 'Minimum relevance score (default: 0).' },
      },
      required: ['query'],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const query = readStringParam(params, 'query', { required: true });
      const maxResults = readNumberParam(params, 'maxResults') ?? 10;
      const minScore = readNumberParam(params, 'minScore') ?? 0;

      if (!query?.trim()) {
        return jsonResult({ results: [], warning: 'Empty query provided to memory_search.' });
      }

      try {
        const manager = createHyperMemSearchManager(agentId);
        const results = await manager.search(query, {
          maxResults,
          minScore,
          sessionKey: opts.agentSessionKey,
        });

        return jsonResult({
          results: results.map((r: MemorySearchResult) => ({
            score: Math.round(r.score * 1000) / 1000,
            snippet: r.snippet,
            source: r.citation ?? r.path,
            path: r.path,
          })),
          count: results.length,
          query,
          engine: 'hypermem-hybrid',
        });
      } catch (err) {
        return jsonResult({
          results: [],
          disabled: true,
          unavailable: true,
          error: (err as Error).message,
          warning: 'Memory search is unavailable. Check HyperMem configuration.',
        });
      }
    },
  };
}

// ─── Plugin entry ──────────────────────────────────────────────

export default definePluginEntry({
  id: 'hypermem-memory',
  name: 'HyperMem Memory',
  description: 'Memory search plugin backed by HyperMem hybrid retrieval (FTS5 + KNN)',
  kind: 'memory',
  register(api) {
    api.registerMemoryCapability({
      runtime: memoryRuntime,
      publicArtifacts,
    });

    api.registerTool(
      (ctx) => createMemorySearchTool({
        config: ctx.config,
        agentSessionKey: ctx.sessionKey,
      }),
      { names: ['memory_search'] },
    );
  },
});
