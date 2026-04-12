/**
 * HyperMem — Agent-Centric Memory & Context Composition Engine
 *
 * @module @psiclawops/hypermem
 *
 * Architecture:
 *   L1: Cache      — hot session working memory (SQLite :memory:)
 *   L2: messages.db — per-agent conversation log (rotatable)
 *   L3: vectors.db  — per-agent semantic search index (reconstructable)
 *   L4: library.db  — structured knowledge store (crown jewel)
 */

export { DatabaseManager } from './db.js';
export type { DatabaseManagerConfig } from './db.js';

export { MessageStore } from './message-store.js';
export { FactStore } from './fact-store.js';
export { KnowledgeStore } from './knowledge-store.js';
export type { LinkType } from './knowledge-store.js';
export { TopicStore } from './topic-store.js';
export { EpisodeStore } from './episode-store.js';
export { PreferenceStore } from './preference-store.js';
export type { Preference } from './preference-store.js';
export { KnowledgeGraph } from './knowledge-graph.js';
export type { EntityType, KnowledgeLink, GraphNode, TraversalResult } from './knowledge-graph.js';

export { RateLimiter, createRateLimitedEmbedder } from './rate-limiter.js';
export type { RateLimiterConfig, Priority } from './rate-limiter.js';

export { CacheLayer } from './cache.js';
export type { ModelState } from './cache.js';

export { Compositor, type CompositorDeps, applyToolGradientToWindow } from './compositor.js';

export {
  type CollectionTrigger,
  TRIGGER_REGISTRY,
  TRIGGER_REGISTRY_VERSION,
  TRIGGER_REGISTRY_HASH,
  matchTriggers,
} from './trigger-registry.js';

export {
  ensureCompactionFenceSchema,
  updateCompactionFence,
  getCompactionFence,
  getCompactionEligibility,
  getCompactableMessages,
} from './compaction-fence.js';
export type { CompactionFence, CompactionEligibility } from './compaction-fence.js';

export {
  verifyPreservation,
  verifyPreservationFromVectors,
} from './preservation-gate.js';
export type { PreservationResult, PreservationConfig } from './preservation-gate.js';

export {
  toProviderFormat,
  fromProviderFormat,
  userMessageToNeutral,
  toolResultsToNeutral,
  normalizeToolCallId,
  generateToolCallId,
  detectProvider,
} from './provider-translator.js';

export { migrate, SCHEMA_VERSION } from './schema.js';
export { migrateLibrary, LIBRARY_SCHEMA_VERSION } from './library-schema.js';

export { VectorStore, generateEmbeddings } from './vector-store.js';
export type { EmbeddingConfig, VectorSearchResult, VectorIndexStats } from './vector-store.js';
export { hybridSearch, buildFtsQuery } from './hybrid-retrieval.js';
export type { HybridSearchResult, HybridSearchOptions } from './hybrid-retrieval.js';

export { DocChunkStore } from './doc-chunk-store.js';
export type { DocChunkRow, ChunkQuery, IndexResult as DocIndexResult } from './doc-chunk-store.js';

export { chunkMarkdown, chunkFile, inferCollection, hashContent, ACA_COLLECTIONS } from './doc-chunker.js';
export type { DocChunk, ChunkOptions, CollectionDef } from './doc-chunker.js';

export { BackgroundIndexer, createIndexer, type CursorFetcher } from './background-indexer.js';
export type { IndexerStats, WatermarkState } from './background-indexer.js';

export { TopicSynthesizer } from './topic-synthesizer.js';
export type { SynthesisResult, SynthesisConfig } from './topic-synthesizer.js';

export { lintKnowledge } from './knowledge-lint.js';
export type { LintResult } from './knowledge-lint.js';

export { runNoiseSweep, runToolDecay, type NoiseSweepResult, type ToolDecayResult } from './proactive-pass.js';

export type {
  NeutralMessage,
  NeutralToolCall,
  NeutralToolResult,
  StoredMessage,
  MessageRole,
  ProviderMessage,
  Conversation,
  Fact,
  Topic,
  Knowledge,
  Episode,
  ComposeRequest,
  ComposeResult,
  ComposeDiagnostics,
  SlotTokenCounts,
  SessionSlots,
  SessionMeta,
  HyperMemConfig,
  CacheConfig,
  RedisConfig,
  CompositorConfig,
  IndexerConfig,
  ChannelType,
  ConversationStatus,
  FactScope,
  TopicStatus,
  EpisodeType,
  MemoryVisibility,
  CrossAgentQuery,
  AgentIdentity,
  SessionCursor,
  RecentTurn,
} from './types.js';

export type { ProviderType } from './provider-translator.js';
export { classifyContentType, signalWeight, isSignalBearing, SIGNAL_WEIGHT } from './content-type-classifier.js';
export type { ContentType, ContentTypeResult } from './content-type-classifier.js';

export { detectTopicShift, stripMessageMetadata } from './topic-detector.js';
export type { TopicSignal } from './topic-detector.js';

export { SessionTopicMap } from './session-topic-map.js';

import { DatabaseManager } from './db.js';
import { MessageStore } from './message-store.js';
import { FactStore } from './fact-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { TopicStore } from './topic-store.js';
import { EpisodeStore } from './episode-store.js';
import { PreferenceStore, type Preference } from './preference-store.js';
import { KnowledgeGraph, type EntityType, type KnowledgeLink, type GraphNode, type TraversalResult } from './knowledge-graph.js';
import { CacheLayer } from './cache.js';
import { Compositor } from './compositor.js';
import { VectorStore, type VectorSearchResult, type VectorIndexStats } from './vector-store.js';
import { userMessageToNeutral, fromProviderFormat } from './provider-translator.js';
import { DocChunkStore, type DocChunkRow, type ChunkQuery, type IndexResult } from './doc-chunk-store.js';
import { chunkMarkdown, chunkFile, inferCollection, type DocChunk, type ChunkOptions } from './doc-chunker.js';
import type {
  HyperMemConfig,
  ComposeRequest,
  ComposeResult,
  NeutralMessage,
  StoredMessage,
  Conversation,
  ChannelType,
} from './types.js';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_CONFIG: HyperMemConfig = {
  enabled: true,
  dataDir: path.join(process.env.HOME || os.homedir(), '.openclaw', 'hypermem'),
  cache: {
    keyPrefix: 'hm:',
    sessionTTL: 14400,      // 4 hours — system/identity/meta slots
    historyTTL: 604800,     // 7 days
  },
  compositor: {
    defaultTokenBudget: 90000,
    maxHistoryMessages: 1000,
    maxFacts: 28,
    maxCrossSessionContext: 6000,
    maxRecentToolPairs: 3,
    maxProseToolPairs: 10,
    warmHistoryBudgetFraction: 0.4,
  },
  indexer: {
    enabled: true,
    factExtractionMode: 'tiered',
    topicDormantAfter: '24h',
    topicClosedAfter: '7d',
    factDecayRate: 0.01,
    episodeSignificanceThreshold: 0.5,
    periodicInterval: 300000,
  },
  embedding: {
    ollamaUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    dimensions: 768,
    timeout: 10000,
    batchSize: 32,
  },
};

/**
 * HyperMem — the main API facade.
 *
 * Usage:
 *   const hm = await HyperMem.create({ dataDir: '~/.openclaw/hypermem' });
 *   await hm.record('my-agent', 'agent:my-agent:webchat:main', userMsg);
 *   const result = await hm.compose({ agentId: 'my-agent', sessionKey: '...', ... });
 */
export class HyperMem {
  readonly dbManager: DatabaseManager;
  readonly cache: CacheLayer;
  readonly compositor: Compositor;
  private readonly config: HyperMemConfig;

  private constructor(config: HyperMemConfig) {
    this.config = config;
    this.dbManager = new DatabaseManager({ dataDir: config.dataDir });
    this.cache = new CacheLayer(config.cache);
    this.compositor = new Compositor({
      cache: this.cache,
      vectorStore: null,  // Set after create() when vector DB is available
      libraryDb: null,    // Set after create() when library DB is available
    }, config.compositor);
  }

  /**
   * Get the active vector store, if initialized.
   * Used by the plugin to wire embeddings into the background indexer.
   */
  getVectorStore(): VectorStore | null {
    return (this.compositor as unknown as { vectorStore: VectorStore | null }).vectorStore;
  }

  /**
   * Create and initialize a HyperMem instance.
   */
  static async create(config?: Partial<HyperMemConfig>): Promise<HyperMem> {
    const merged: HyperMemConfig = {
      ...DEFAULT_CONFIG,
      ...config,
      cache: { ...DEFAULT_CONFIG.cache, ...config?.cache },
      compositor: { ...DEFAULT_CONFIG.compositor, ...config?.compositor },
      indexer: { ...DEFAULT_CONFIG.indexer, ...config?.indexer },
      embedding: {
        ...DEFAULT_CONFIG.embedding,
        ...(config as Record<string, unknown>)?.embedding as Partial<HyperMemConfig['embedding']>,
      },
    };

    const hm = new HyperMem(merged);

    const cacheOk = await hm.cache.connect();
    if (cacheOk) {
      console.log('[hypermem] Cache layer connected');
    } else {
      console.warn('[hypermem] Cache layer unavailable — running in SQLite-only mode');
    }

    // ── Vector store init ─────────────────────────────────────
    // Attempt to wire up sqlite-vec + nomic-embed-text for semantic recall.
    // Non-fatal: if sqlite-vec isn't available or Ollama is down,
    // hybridSearch() continues in FTS5-only mode.
    // The vector store is shared (not per-agent) — facts/episodes from all agents
    // are indexed together, keyed by (source_table, source_id).
    try {
      const vectorDb = hm.dbManager.getSharedVectorDb();
      if (vectorDb) {
        const vs = new VectorStore(vectorDb, merged.embedding, hm.dbManager.getLibraryDb());
        vs.ensureTables();
        hm.compositor.setVectorStore(vs);
        console.log('[hypermem] Vector store initialized (sqlite-vec + nomic-embed-text)');
      } else {
        console.warn('[hypermem] sqlite-vec unavailable — semantic recall in FTS5-only mode');
      }
    } catch (err) {
      console.warn('[hypermem] Vector store init failed (non-fatal):', (err as Error).message);
    }

    return hm;
  }

  // ─── Core API (L2: Message DB) ──────────────────────────────

  /**
   * Record a user message.
   */
  async recordUserMessage(
    agentId: string,
    sessionKey: string,
    content: string,
    opts?: {
      channelType?: ChannelType;
      channelId?: string;
      provider?: string;
      model?: string;
      tokenCount?: number;
      isHeartbeat?: boolean;
    }
  ): Promise<StoredMessage> {
    const db = this.dbManager.getMessageDb(agentId);
    this.dbManager.ensureAgent(agentId);
    const store = new MessageStore(db);

    const conversation = store.getOrCreateConversation(agentId, sessionKey, {
      channelType: opts?.channelType,
      channelId: opts?.channelId,
      provider: opts?.provider,
      model: opts?.model,
    });

    const neutral = userMessageToNeutral(content);
    const stored = store.recordMessage(conversation.id, agentId, neutral, {
      tokenCount: opts?.tokenCount,
      isHeartbeat: opts?.isHeartbeat,
    });

    await this.cache.pushHistory(agentId, sessionKey, [stored], this.config.compositor.maxHistoryMessages);
    await this.cache.touchSession(agentId, sessionKey);

    return stored;
  }

  /**
   * Record an assistant response.
   */
  async recordAssistantMessage(
    agentId: string,
    sessionKey: string,
    message: NeutralMessage,
    opts?: { tokenCount?: number }
  ): Promise<StoredMessage> {
    const db = this.dbManager.getMessageDb(agentId);
    const store = new MessageStore(db);

    const conversation = store.getConversation(sessionKey);
    if (!conversation) {
      throw new Error(`No conversation found for session ${sessionKey}`);
    }

    const stored = store.recordMessage(conversation.id, agentId, message, {
      tokenCount: opts?.tokenCount,
    });

    await this.cache.pushHistory(agentId, sessionKey, [stored], this.config.compositor.maxHistoryMessages);
    await this.cache.touchSession(agentId, sessionKey);

    return stored;
  }

  /**
   * Record a raw provider response, converting to neutral format.
   */
  async recordProviderResponse(
    agentId: string,
    sessionKey: string,
    response: Record<string, unknown>,
    provider: string,
    opts?: { tokenCount?: number }
  ): Promise<StoredMessage> {
    const neutral = fromProviderFormat(response, provider);
    return this.recordAssistantMessage(agentId, sessionKey, neutral, opts);
  }

  /**
   * Compose context for an LLM call.
   */
  async compose(request: ComposeRequest): Promise<ComposeResult> {
    const db = this.dbManager.getMessageDb(request.agentId);
    const libraryDb = this.dbManager.getLibraryDb();
    return this.compositor.compose(request, db, libraryDb);
  }

  /**
   * Warm a session from SQLite into the hot cache.
   */
  async warm(
    agentId: string,
    sessionKey: string,
    opts?: { systemPrompt?: string; identity?: string }
  ): Promise<void> {
    const db = this.dbManager.getMessageDb(agentId);
    const libraryDb = this.dbManager.getLibraryDb();
    await this.compositor.warmSession(agentId, sessionKey, db, { ...opts, libraryDb });
  }

  /**
   * Recompute the hot cache history view from SQLite and re-apply tool gradient.
   */
  async refreshCacheGradient(agentId: string, sessionKey: string, tokenBudget?: number): Promise<void> {
    const db = this.dbManager.getMessageDb(agentId);
    await this.compositor.refreshCacheGradient(agentId, sessionKey, db, tokenBudget);
  }

  /**
   * Full-text search across all messages for an agent.
   */
  search(agentId: string, query: string, limit: number = 20): StoredMessage[] {
    const db = this.dbManager.getMessageDb(agentId);
    const store = new MessageStore(db);
    return store.searchMessages(agentId, query, limit);
  }

  /**
   * Get or create a conversation.
   */
  getOrCreateConversation(
    agentId: string,
    sessionKey: string,
    opts?: {
      channelType?: ChannelType;
      channelId?: string;
      provider?: string;
      model?: string;
    }
  ): Conversation {
    const db = this.dbManager.getMessageDb(agentId);
    this.dbManager.ensureAgent(agentId);
    const store = new MessageStore(db);
    return store.getOrCreateConversation(agentId, sessionKey, opts);
  }

  /**
   * List all agents with databases.
   */
  listAgents(): string[] {
    return this.dbManager.listAgents();
  }

  // ─── Facts (L4: Library) ────────────────────────────────────

  /**
   * Add a fact.
   */
  addFact(agentId: string, content: string, opts?: {
    scope?: 'agent' | 'session' | 'user';
    domain?: string;
    confidence?: number;
    visibility?: string;
    sourceType?: string;
    sourceSessionKey?: string;
    sourceRef?: string;
  }): unknown {
    const db = this.dbManager.getLibraryDb();
    const store = new FactStore(db);
    return store.addFact(agentId, content, opts);
  }

  /**
   * Get active facts for an agent.
   */
  getActiveFacts(agentId: string, opts?: {
    scope?: 'agent' | 'session' | 'user';
    domain?: string;
    limit?: number;
    minConfidence?: number;
  }): unknown[] {
    const db = this.dbManager.getLibraryDb();
    const store = new FactStore(db);
    return store.getActiveFacts(agentId, opts);
  }

  // ─── Knowledge (L4: Library) ────────────────────────────────

  /**
   * Add/update knowledge.
   */
  upsertKnowledge(agentId: string, domain: string, key: string, content: string, opts?: {
    confidence?: number;
    sourceType?: string;
    sourceRef?: string;
    expiresAt?: string;
  }): unknown {
    const db = this.dbManager.getLibraryDb();
    const store = new KnowledgeStore(db);
    return store.upsert(agentId, domain, key, content, opts);
  }

  /**
   * Get active knowledge, optionally filtered by domain.
   */
  getKnowledge(agentId: string, opts?: { domain?: string; limit?: number }): unknown[] {
    const db = this.dbManager.getLibraryDb();
    const store = new KnowledgeStore(db);
    return store.getActive(agentId, opts);
  }

  // ─── Topics (L4: Library) ───────────────────────────────────

  /**
   * Create a topic.
   */
  createTopic(agentId: string, name: string, description?: string): unknown {
    const db = this.dbManager.getLibraryDb();
    const store = new TopicStore(db);
    return store.create(agentId, name, description);
  }

  /**
   * Get active topics.
   */
  getActiveTopics(agentId: string, limit: number = 20): unknown[] {
    const db = this.dbManager.getLibraryDb();
    const store = new TopicStore(db);
    return store.getActive(agentId, limit);
  }

  // ─── Episodes (L4: Library) ─────────────────────────────────

  /**
   * Record an episode.
   */
  recordEpisode(agentId: string, eventType: string, summary: string, opts?: {
    significance?: number;
    visibility?: string;
    participants?: string[];
    sessionKey?: string;
  }): unknown {
    const db = this.dbManager.getLibraryDb();
    const store = new EpisodeStore(db);
    return store.record(agentId, eventType as import('./types.js').EpisodeType, summary, opts);
  }

  /**
   * Get recent episodes.
   */
  getRecentEpisodes(agentId: string, opts?: {
    eventType?: string;
    minSignificance?: number;
    limit?: number;
    since?: string;
  }): unknown[] {
    const db = this.dbManager.getLibraryDb();
    const store = new EpisodeStore(db);
    return store.getRecent(agentId, opts as Parameters<typeof store.getRecent>[1]);
  }

  // ─── Preferences (L4: Library) ──────────────────────────────

  /**
   * Set a preference.
   */
  setPreference(subject: string, key: string, value: string, opts?: {
    domain?: string;
    agentId?: string;
    confidence?: number;
    visibility?: string;
  }): Preference {
    const db = this.dbManager.getLibraryDb();
    const store = new PreferenceStore(db);
    return store.set(subject, key, value, opts);
  }

  /**
   * Get a preference.
   */
  getPreference(subject: string, key: string, domain?: string): Preference | null {
    const db = this.dbManager.getLibraryDb();
    const store = new PreferenceStore(db);
    return store.get(subject, key, domain);
  }

  /**
   * Get all preferences for a subject.
   */
  getPreferences(subject: string, domain?: string): Preference[] {
    const db = this.dbManager.getLibraryDb();
    const store = new PreferenceStore(db);
    return store.getForSubject(subject, domain);
  }

  // ─── Knowledge Graph (L4: Library) ──────────────────────────

  /**
   * Add a directed link between two entities.
   */
  addKnowledgeLink(
    fromType: EntityType, fromId: number,
    toType: EntityType, toId: number,
    linkType: string
  ): KnowledgeLink {
    const db = this.dbManager.getLibraryDb();
    const graph = new KnowledgeGraph(db);
    return graph.addLink(fromType, fromId, toType, toId, linkType);
  }

  /**
   * Remove a specific link.
   */
  removeKnowledgeLink(
    fromType: EntityType, fromId: number,
    toType: EntityType, toId: number,
    linkType: string
  ): boolean {
    const db = this.dbManager.getLibraryDb();
    const graph = new KnowledgeGraph(db);
    return graph.removeLink(fromType, fromId, toType, toId, linkType);
  }

  /**
   * Get all links for an entity (both directions).
   */
  getEntityLinks(type: EntityType, id: number): KnowledgeLink[] {
    const db = this.dbManager.getLibraryDb();
    const graph = new KnowledgeGraph(db);
    return graph.getLinks(type, id);
  }

  /**
   * Traverse the knowledge graph from a starting entity.
   * BFS with bounded depth and result count.
   */
  traverseGraph(
    startType: EntityType, startId: number,
    opts?: {
      maxDepth?: number;
      maxResults?: number;
      linkTypes?: string[];
      direction?: 'outbound' | 'inbound' | 'both';
      targetTypes?: EntityType[];
    }
  ): TraversalResult {
    const db = this.dbManager.getLibraryDb();
    const graph = new KnowledgeGraph(db);
    return graph.traverse(startType, startId, opts);
  }

  /**
   * Find the shortest path between two entities.
   */
  findGraphPath(
    fromType: EntityType, fromId: number,
    toType: EntityType, toId: number,
    maxDepth?: number
  ): GraphNode[] | null {
    const db = this.dbManager.getLibraryDb();
    const graph = new KnowledgeGraph(db);
    return graph.findPath(fromType, fromId, toType, toId, maxDepth);
  }

  /**
   * Get the most connected entities.
   */
  getMostConnectedEntities(opts?: { type?: EntityType; limit?: number }): Array<{
    type: EntityType; id: number; degree: number;
  }> {
    const db = this.dbManager.getLibraryDb();
    const graph = new KnowledgeGraph(db);
    return graph.getMostConnected(opts);
  }

  /**
   * Get knowledge graph statistics.
   */
  getGraphStats(): { totalLinks: number; byType: Array<{ linkType: string; count: number }> } {
    const db = this.dbManager.getLibraryDb();
    const graph = new KnowledgeGraph(db);
    return {
      totalLinks: graph.getTotalLinks(),
      byType: graph.getLinkStats(),
    };
  }

  // ─── Vector / Semantic Search (L3: Vectors DB) ──────────────

  /**
   * Semantic search across an agent's indexed memory.
   */
  async semanticSearch(
    agentId: string,
    query: string,
    opts?: {
      tables?: string[];
      limit?: number;
      maxDistance?: number;
    }
  ): Promise<VectorSearchResult[]> {
    const db = this.dbManager.getVectorDb(agentId);
    if (!db) {
      console.warn('[hypermem] Semantic search unavailable — sqlite-vec not loaded');
      return [];
    }
    const libraryDb = this.dbManager.getLibraryDb();
    const vs = new VectorStore(db, this.config.embedding, libraryDb);
    return vs.search(query, opts);
  }

  /**
   * Index all un-indexed content for an agent.
   */
  async indexAgent(agentId: string): Promise<{ indexed: number; skipped: number; tombstoned: number }> {
    const db = this.dbManager.getVectorDb(agentId);
    if (!db) return { indexed: 0, skipped: 0, tombstoned: 0 };
    const libraryDb = this.dbManager.getLibraryDb();
    const vs = new VectorStore(db, this.config.embedding, libraryDb);
    vs.ensureTables();
    const result = await vs.indexAll(agentId);
    // Tombstone superseded facts/knowledge so they don't surface in recall
    const tombstoned = vs.tombstoneSuperseded();
    return { ...result, tombstoned };
  }

  /**
   * Get vector index statistics.
   */
  getVectorStats(agentId: string): VectorIndexStats | null {
    const db = this.dbManager.getVectorDb(agentId);
    if (!db) return null;
    const libraryDb = this.dbManager.getLibraryDb();
    const vs = new VectorStore(db, this.config.embedding, libraryDb);
    return vs.getStats();
  }

  /**
   * Prune orphaned vector entries.
   */
  pruneVectorOrphans(agentId: string): number {
    const db = this.dbManager.getVectorDb(agentId);
    if (!db) return 0;
    const libraryDb = this.dbManager.getLibraryDb();
    const vs = new VectorStore(db, this.config.embedding, libraryDb);
    return vs.pruneOrphans();
  }

  // ─── Session Cursor (dual-read: cache → SQLite fallback) ──────

  /**
   * Get the session cursor for an agent+session.
   * Reads from cache first; falls back to SQLite if cache returns null
   * (e.g. after eviction or restart). This is the P1.3 durability guarantee.
   */
  async getSessionCursor(agentId: string, sessionKey: string): Promise<import('./types.js').SessionCursor | null> {
    // Try cache first (hot path)
    const cachedCursor = await this.cache.getCursor(agentId, sessionKey);
    if (cachedCursor) return cachedCursor;

    // Fallback to SQLite
    const db = this.dbManager.getMessageDb(agentId);
    if (!db) return null;
    const row = db.prepare(`
      SELECT cursor_last_sent_id, cursor_last_sent_index, cursor_last_sent_at,
             cursor_window_size, cursor_token_count
      FROM conversations
      WHERE session_key = ? AND cursor_last_sent_id IS NOT NULL
    `).get(sessionKey) as Record<string, unknown> | undefined;

    if (!row || row.cursor_last_sent_id == null) return null;

    const cursor: import('./types.js').SessionCursor = {
      lastSentId: row.cursor_last_sent_id as number,
      lastSentIndex: row.cursor_last_sent_index as number,
      lastSentAt: row.cursor_last_sent_at as string,
      windowSize: row.cursor_window_size as number,
      tokenCount: row.cursor_token_count as number,
    };

    // Re-warm cache so subsequent reads are fast
    try {
      await this.cache.setCursor(agentId, sessionKey, cursor);
    } catch {
      // Best-effort re-warm
    }

    return cursor;
  }

  // ─── Message Rotation (L2: Messages) ────────────────────────

  /**
   * Get the size of an agent's active messages.db in bytes.
   */
  getMessageDbSize(agentId: string): number {
    return this.dbManager.getMessageDbSize(agentId);
  }

  /**
   * Check if an agent's message database needs rotation.
   */
  shouldRotate(agentId: string, opts?: {
    maxSizeBytes?: number;
    maxAgeDays?: number;
  }): { reason: 'size' | 'age'; current: number; threshold: number } | null {
    return this.dbManager.shouldRotate(agentId, opts);
  }

  /**
   * Rotate an agent's message database.
   * Returns the path to the rotated file, or null if no active DB exists.
   */
  rotateMessageDb(agentId: string): string | null {
    return this.dbManager.rotateMessageDb(agentId);
  }

  /**
   * List rotated message DB files for an agent.
   */
  listRotatedDbs(agentId: string): string[] {
    return this.dbManager.listRotatedDbs(agentId);
  }

  /**
   * Check and auto-rotate all agents' message databases.
   * Call on heartbeat/startup.
   * Returns agents that were rotated.
   */
  autoRotate(opts?: {
    maxSizeBytes?: number;
    maxAgeDays?: number;
  }): Array<{ agentId: string; reason: string; rotatedTo: string }> {
    const agents = this.dbManager.listAgents();
    const rotated: Array<{ agentId: string; reason: string; rotatedTo: string }> = [];

    for (const agentId of agents) {
      const check = this.shouldRotate(agentId, opts);
      if (check) {
        const rotatedPath = this.rotateMessageDb(agentId);
        if (rotatedPath) {
          rotated.push({
            agentId,
            reason: `${check.reason}: ${check.current} > ${check.threshold}`,
            rotatedTo: rotatedPath,
          });
        }
      }
    }

    return rotated;
  }

  // ─── Session Registry (L4: Library) ─────────────────────────

  /**
   * Register a session start.
   */
  registerSession(sessionKey: string, agentId: string, opts?: {
    channel?: string;
    channelType?: string;
  }): void {
    const db = this.dbManager.getLibraryDb();
    const now = new Date().toISOString();

    const existing = db
      .prepare('SELECT id FROM session_registry WHERE id = ?')
      .get(sessionKey) as { id: string } | undefined;

    if (existing) {
      db.prepare('UPDATE session_registry SET status = ?, started_at = ? WHERE id = ?')
        .run('active', now, sessionKey);
    } else {
      db.prepare(
        `INSERT INTO session_registry (id, agent_id, channel, channel_type, started_at, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      ).run(sessionKey, agentId, opts?.channel || null, opts?.channelType || null, now);
    }

    db.prepare(
      'INSERT INTO session_events (session_id, event_type, timestamp, payload) VALUES (?, ?, ?, ?)'
    ).run(sessionKey, 'start', now, JSON.stringify({ channel: opts?.channel, channelType: opts?.channelType }));
  }

  /**
   * Record a session event.
   */
  recordSessionEvent(sessionKey: string, eventType: string, payload?: Record<string, unknown>): void {
    const db = this.dbManager.getLibraryDb();
    db.prepare(
      'INSERT INTO session_events (session_id, event_type, timestamp, payload) VALUES (?, ?, ?, ?)'
    ).run(sessionKey, eventType, new Date().toISOString(), payload ? JSON.stringify(payload) : null);

    if (eventType === 'decision') {
      db.prepare('UPDATE session_registry SET decisions_made = decisions_made + 1 WHERE id = ?').run(sessionKey);
    } else if (eventType === 'fact_extracted') {
      db.prepare('UPDATE session_registry SET facts_extracted = facts_extracted + 1 WHERE id = ?').run(sessionKey);
    }
  }

  /**
   * Close a session.
   */
  closeSession(sessionKey: string, summary?: string): void {
    const db = this.dbManager.getLibraryDb();
    const now = new Date().toISOString();

    db.prepare(
      'UPDATE session_registry SET status = ?, ended_at = ?, summary = ? WHERE id = ?'
    ).run('completed', now, summary || null, sessionKey);

    db.prepare(
      'INSERT INTO session_events (session_id, event_type, timestamp) VALUES (?, ?, ?)'
    ).run(sessionKey, 'completion', now);
  }

  /**
   * Query sessions.
   */
  querySessions(opts?: {
    agentId?: string;
    status?: string;
    since?: string;
    limit?: number;
  }): unknown[] {
    const db = this.dbManager.getLibraryDb();
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.agentId) { conditions.push('agent_id = ?'); params.push(opts.agentId); }
    if (opts?.status) { conditions.push('status = ?'); params.push(opts.status); }
    if (opts?.since) { conditions.push('started_at >= ?'); params.push(opts.since); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return db
      .prepare(`SELECT * FROM session_registry ${where} ORDER BY started_at DESC LIMIT ?`)
      .all(...params, opts?.limit || 50);
  }

  /**
   * Get session events.
   */
  getSessionEvents(sessionKey: string, limit: number = 50): unknown[] {
    const db = this.dbManager.getLibraryDb();
    return db
      .prepare('SELECT * FROM session_events WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(sessionKey, limit);
  }

  // ─── Document Chunks (L4: Library) ──────────────────────────

  /**
   * Index chunks from a parsed set of DocChunk objects.
   * Atomic: replaces all chunks for the source in one transaction.
   */
  indexDocChunks(chunks: DocChunk[]): IndexResult {
    const db = this.dbManager.getLibraryDb();
    const store = new DocChunkStore(db);
    return store.indexChunks(chunks);
  }

  /**
   * Query doc chunks by collection with optional keyword/scope/agent filters.
   */
  queryDocChunks(query: ChunkQuery): DocChunkRow[] {
    const db = this.dbManager.getLibraryDb();
    const store = new DocChunkStore(db);
    return store.queryChunks(query);
  }


  /**
   * Get stats about the current doc chunk index.
   */
  getDocIndexStats() {
    const db = this.dbManager.getLibraryDb();
    const store = new DocChunkStore(db);
    return store.getStats();
  }

  /**
   * List indexed sources (what files have been seeded and their hashes).
   */
  listDocSources(opts?: { agentId?: string; collection?: string }) {
    const db = this.dbManager.getLibraryDb();
    const store = new DocChunkStore(db);
    return store.listSources(opts);
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  /**
   * Clean shutdown.
   */
  async close(): Promise<void> {
    await this.cache.disconnect();
    this.dbManager.close();
  }
}

export default HyperMem;
