/**
 * hypermem — Agent-Centric Memory & Context Composition Engine
 *
 * @module @psiclawops/hypermem
 *
 * Architecture:
 *   L1: Redis       — hot session working memory
 *   L2: messages.db — per-agent conversation log (rotatable)
 *   L3: vectors.db  — per-agent semantic search index (reconstructable)
 *   L4: library.db  — fleet-wide structured knowledge (crown jewel)
 */

export { ENGINE_VERSION, MIN_NODE_VERSION, MIN_REDIS_VERSION, SQLITE_VEC_VERSION, MAIN_SCHEMA_VERSION, LIBRARY_SCHEMA_VERSION_EXPORT, HYPERMEM_COMPAT_VERSION, SCHEMA_COMPAT } from './version.js';

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
export { FleetStore } from './fleet-store.js';
export type { FleetAgent, FleetOrg, AgentCapability } from './fleet-store.js';
export { SystemStore } from './system-store.js';
export type { SystemState, SystemEvent } from './system-store.js';
export { WorkStore } from './work-store.js';
export type { WorkItem, WorkEvent, WorkStatus } from './work-store.js';
export { DesiredStateStore } from './desired-state-store.js';
export { evictStaleContent, DEFAULT_EVICTION_CONFIG } from './image-eviction.js';
export type { ImageEvictionConfig, EvictionStats, EvictionResult } from './image-eviction.js';
export { KnowledgeGraph } from './knowledge-graph.js';
export type { EntityType, KnowledgeLink, GraphNode, TraversalResult } from './knowledge-graph.js';

export { RateLimiter, createRateLimitedEmbedder } from './rate-limiter.js';
export type { RateLimiterConfig, Priority } from './rate-limiter.js';
export type { DesiredStateEntry, ConfigEvent, DriftStatus } from './desired-state-store.js';

export { RedisLayer } from './redis.js';
export type { ModelState } from './redis.js';

export { Compositor, type CompositorDeps, applyToolGradientToWindow } from './compositor.js';

export {
  type CollectionTrigger,
  TRIGGER_REGISTRY,
  TRIGGER_REGISTRY_VERSION,
  TRIGGER_REGISTRY_HASH,
  DEFAULT_TRIGGERS,
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
  repairToolCallPairs,
} from './provider-translator.js';

export { migrate, SCHEMA_VERSION } from './schema.js';
export { migrateLibrary, LIBRARY_SCHEMA_VERSION } from './library-schema.js';

export { VectorStore, generateEmbeddings } from './vector-store.js';
export type { EmbeddingConfig, VectorSearchResult, VectorIndexStats } from './vector-store.js';
export { hybridSearch, buildFtsQuery } from './hybrid-retrieval.js';
export type { HybridSearchResult, HybridSearchOptions } from './hybrid-retrieval.js';

export { DocChunkStore } from './doc-chunk-store.js';
export type { DocChunkRow, ChunkQuery, IndexResult as DocIndexResult } from './doc-chunk-store.js';

export { WorkspaceSeeder, seedWorkspace } from './seed.js';
export type { SeedOptions, SeedResult } from './seed.js';

export { chunkMarkdown, chunkFile, inferCollection, hashContent, ACA_COLLECTIONS } from './doc-chunker.js';
export type { DocChunk, ChunkOptions, CollectionDef } from './doc-chunker.js';

export {
  crossAgentQuery,
  canAccess,
  visibilityFilter,
  defaultOrgRegistry,
  buildOrgRegistryFromDb,
  loadOrgRegistryFromDb,
} from './cross-agent.js';
export type { OrgRegistry } from './cross-agent.js';

export { BackgroundIndexer, createIndexer, type CursorFetcher } from './background-indexer.js';
export {
  runDreamingPromoter,
  runDreamingPassForFleet,
  resolveAgentWorkspacePath,
  type DreamerConfig,
  type DreamerResult,
  type PromotionEntry,
  DEFAULT_DREAMER_CONFIG,
} from './dreaming-promoter.js';
export type { IndexerStats, WatermarkState } from './background-indexer.js';

export { TopicSynthesizer } from './topic-synthesizer.js';
export type { SynthesisResult, SynthesisConfig } from './topic-synthesizer.js';

export { WikiPageEmitter } from './wiki-page-emitter.js';
export type { WikiPage, WikiLink, WikiPageSummary } from './wiki-page-emitter.js';

export { lintKnowledge } from './knowledge-lint.js';
export type { LintResult } from './knowledge-lint.js';

export { buildSpawnContext } from './spawn-context.js';
export type { SpawnContextOptions, SpawnContext } from './spawn-context.js';

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

export {
  getActiveFOS,
  matchMOD,
  renderFOS,
  renderMOD,
  recordOutputMetrics,
} from './fos-mod.js';
export type {
  FOSRecord,
  MODRecord,
  FOSDirectives,
  FOSTaskVariant,
  MODCorrection,
  MODCalibration,
  OutputMetricsRow,
} from './fos-mod.js';

import { DatabaseManager } from './db.js';
import { MessageStore } from './message-store.js';
import { FactStore } from './fact-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { TopicStore } from './topic-store.js';
import { EpisodeStore } from './episode-store.js';
import { PreferenceStore, type Preference } from './preference-store.js';
import { FleetStore, type FleetAgent, type FleetOrg, type AgentCapability } from './fleet-store.js';
import { SystemStore, type SystemState, type SystemEvent } from './system-store.js';
import { WorkStore, type WorkItem, type WorkStatus } from './work-store.js';
import { KnowledgeGraph, type EntityType, type KnowledgeLink, type GraphNode, type TraversalResult } from './knowledge-graph.js';
import { DesiredStateStore, type DesiredStateEntry, type DriftStatus } from './desired-state-store.js';
import { RedisLayer } from './redis.js';
import { Compositor } from './compositor.js';
import { VectorStore, type VectorSearchResult, type VectorIndexStats } from './vector-store.js';
import { userMessageToNeutral, fromProviderFormat } from './provider-translator.js';
import { DocChunkStore, type DocChunkRow, type ChunkQuery, type IndexResult } from './doc-chunk-store.js';
import { WorkspaceSeeder, type SeedOptions, type SeedResult } from './seed.js';
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
import { crossAgentQuery, defaultOrgRegistry, buildOrgRegistryFromDb, loadOrgRegistryFromDb, type OrgRegistry } from './cross-agent.js';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_CONFIG: HyperMemConfig = {
  enabled: true,
  dataDir: path.join(process.env.HOME || os.homedir(), '.openclaw', 'hypermem'),
  redis: {
    host: 'localhost',
    port: 6379,
    keyPrefix: 'hm:',
    sessionTTL: 14400,      // 4 hours — system/identity/meta slots
    historyTTL: 604800,     // 7 days — extended for ClawCanvas Redis-first display
    flushInterval: 1000,
  },
  compositor: {
    // TUNE-010 (2026-04-02): Raised from 65000 → 90000.
    // TUNE-008 dropped to 65k as a tool-loop overflow band-aid. The real fix
    // (tool-loop pass-through guard in assemble()) means tool turns don't
    // re-run composition, so 90k is safe — leaves ~30k headroom for in-flight
    // tool results on a 120k window. Budget is better spent on context quality.
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
 * hypermem — the main API facade.
 *
 * Usage:
 *   const hm = await hypermem.create({ dataDir: '~/.openclaw/hypermem' });
 *   await hm.record('forge', 'agent:forge:webchat:main', userMsg);
 *   const result = await hm.compose({ agentId: 'forge', sessionKey: '...', ... });
 */
export class HyperMem {
  readonly dbManager: DatabaseManager;
  readonly redis: RedisLayer;
  readonly compositor: Compositor;
  private readonly config: HyperMemConfig;

  private constructor(config: HyperMemConfig) {
    this.config = config;
    this.dbManager = new DatabaseManager({ dataDir: config.dataDir });
    this.redis = new RedisLayer(config.redis);
    this.compositor = new Compositor({
      redis: this.redis,
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
   * Create and initialize a hypermem instance.
   */
  static async create(config?: Partial<HyperMemConfig>): Promise<HyperMem> {
    const merged: HyperMemConfig = {
      ...DEFAULT_CONFIG,
      ...config,
      redis: { ...DEFAULT_CONFIG.redis, ...config?.redis },
      compositor: { ...DEFAULT_CONFIG.compositor, ...config?.compositor },
      indexer: { ...DEFAULT_CONFIG.indexer, ...config?.indexer },
      embedding: {
        ...DEFAULT_CONFIG.embedding,
        ...(config as Record<string, unknown>)?.embedding as Partial<HyperMemConfig['embedding']>,
      },
    };

    const hm = new HyperMem(merged);

    const redisOk = await hm.redis.connect();
    if (redisOk) {
      console.log('[hypermem] Redis connected');
    } else {
      console.warn('[hypermem] Redis unavailable — running in SQLite-only mode');
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

    await this.redis.pushHistory(agentId, sessionKey, [stored], this.config.compositor.maxHistoryMessages);
    await this.redis.touchSession(agentId, sessionKey);

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

    await this.redis.pushHistory(agentId, sessionKey, [stored], this.config.compositor.maxHistoryMessages);
    await this.redis.touchSession(agentId, sessionKey);

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
   * Warm a session from SQLite into Redis.
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
   * Recompute the Redis hot history view from SQLite and re-apply tool gradient.
   */
  async refreshRedisGradient(agentId: string, sessionKey: string, tokenBudget?: number): Promise<void> {
    const db = this.dbManager.getMessageDb(agentId);
    await this.compositor.refreshRedisGradient(agentId, sessionKey, db, tokenBudget);
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

  // ─── Fleet Registry (L4: Library) ───────────────────────────

  /**
   * Register or update a fleet agent. Invalidates cache.
   */
  upsertFleetAgent(id: string, data: {
    displayName?: string;
    tier?: string;
    orgId?: string;
    reportsTo?: string;
    domains?: string[];
    sessionKeys?: string[];
    status?: string;
    metadata?: Record<string, unknown>;
  }): FleetAgent {
    const db = this.dbManager.getLibraryDb();
    const store = new FleetStore(db);
    const result = store.upsertAgent(id, data);
    // Invalidate cache — fire and forget
    this.redis.invalidateFleetAgent(id).catch(() => {});
    return result;
  }

  /**
   * Get a fleet agent. Cache-aside: check Redis first, fall back to SQLite.
   */
  async getFleetAgentCached(id: string): Promise<FleetAgent | null> {
    // Try cache first
    const cached = await this.redis.getCachedFleetAgent(id);
    if (cached) return cached as unknown as FleetAgent;

    // Fall back to SQLite
    const agent = this.getFleetAgent(id);
    if (agent) {
      // Warm cache — fire and forget
      this.redis.cacheFleetAgent(id, agent as unknown as Record<string, unknown>).catch(() => {});
    }
    return agent;
  }

  /**
   * Get a fleet agent (synchronous, SQLite only).
   */
  getFleetAgent(id: string): FleetAgent | null {
    const db = this.dbManager.getLibraryDb();
    const store = new FleetStore(db);
    return store.getAgent(id);
  }

  /**
   * List fleet agents.
   */
  listFleetAgents(opts?: { tier?: string; orgId?: string; status?: string }): FleetAgent[] {
    const db = this.dbManager.getLibraryDb();
    const store = new FleetStore(db);
    return store.listAgents(opts);
  }

  /**
   * Register or update a fleet org.
   */
  upsertFleetOrg(id: string, data: { name: string; leadAgentId?: string; mission?: string }): FleetOrg {
    const db = this.dbManager.getLibraryDb();
    const store = new FleetStore(db);
    return store.upsertOrg(id, data);
  }

  /**
   * List fleet orgs.
   */
  listFleetOrgs(): FleetOrg[] {
    const db = this.dbManager.getLibraryDb();
    const store = new FleetStore(db);
    return store.listOrgs();
  }

  // ─── Agent Capabilities (L4: Library) ────────────────────────

  /**
   * Register or update a capability for an agent.
   */
  upsertCapability(agentId: string, cap: {
    capType: 'skill' | 'tool' | 'mcp_server';
    name: string;
    version?: string;
    source?: string;
    config?: Record<string, unknown>;
    status?: string;
  }): import('./fleet-store.js').AgentCapability {
    const db = this.dbManager.getLibraryDb();
    const store = new FleetStore(db);
    return store.upsertCapability(agentId, cap);
  }

  /**
   * Bulk-sync capabilities of a given type for an agent.
   * Marks capabilities not in the list as 'removed'.
   */
  syncCapabilities(agentId: string, capType: 'skill' | 'tool' | 'mcp_server', caps: Array<{
    name: string;
    version?: string;
    source?: string;
    config?: Record<string, unknown>;
  }>): void {
    const db = this.dbManager.getLibraryDb();
    const store = new FleetStore(db);
    store.syncCapabilities(agentId, capType, caps);
  }

  /**
   * Get capabilities for an agent, optionally filtered by type.
   */
  getAgentCapabilities(agentId: string, capType?: string): import('./fleet-store.js').AgentCapability[] {
    const db = this.dbManager.getLibraryDb();
    const store = new FleetStore(db);
    return store.getAgentCapabilities(agentId, capType);
  }

  /**
   * Find agents that have a specific capability.
   */
  findAgentsByCapability(capType: string, name: string): FleetAgent[] {
    const db = this.dbManager.getLibraryDb();
    const store = new FleetStore(db);
    return store.findByCapability(capType, name);
  }

  // ─── System Registry (L4: Library) ──────────────────────────

  /**
   * Set a system state value.
   */
  setSystemState(category: string, key: string, value: unknown, opts?: {
    updatedBy?: string;
    ttl?: string;
  }): SystemState {
    const db = this.dbManager.getLibraryDb();
    const store = new SystemStore(db);
    return store.set(category, key, value, opts);
  }

  /**
   * Get a system state value.
   */
  getSystemState(category: string, key: string): SystemState | null {
    const db = this.dbManager.getLibraryDb();
    const store = new SystemStore(db);
    return store.get(category, key);
  }

  /**
   * Get all state in a category.
   */
  getSystemCategory(category: string): SystemState[] {
    const db = this.dbManager.getLibraryDb();
    const store = new SystemStore(db);
    return store.getCategory(category);
  }

  // ─── Work Items (L4: Library) ───────────────────────────────

  /**
   * Create a work item.
   */
  createWorkItem(data: {
    title: string;
    description?: string;
    priority?: number;
    agentId?: string;
    createdBy: string;
    domain?: string;
    parentId?: string;
    dueAt?: string;
    metadata?: Record<string, unknown>;
  }): WorkItem {
    const db = this.dbManager.getLibraryDb();
    const store = new WorkStore(db);
    return store.create(data);
  }

  /**
   * Update work item status.
   */
  updateWorkStatus(id: string, status: WorkStatus, agentId?: string, comment?: string): WorkItem | null {
    const db = this.dbManager.getLibraryDb();
    const store = new WorkStore(db);
    return store.updateStatus(id, status, agentId, comment);
  }

  /**
   * Get active work for an agent.
   */
  getAgentWork(agentId: string, status?: WorkStatus): WorkItem[] {
    const db = this.dbManager.getLibraryDb();
    const store = new WorkStore(db);
    return store.getAgentWork(agentId, status);
  }

  /**
   * Get the fleet kanban board.
   */
  getFleetKanban(opts?: { domain?: string; agentId?: string }): WorkItem[] {
    const db = this.dbManager.getLibraryDb();
    const store = new WorkStore(db);
    return store.getKanban(opts);
  }

  /**
   * Get work item stats.
   */
  getWorkStats(opts?: { agentId?: string; since?: string }): unknown {
    const db = this.dbManager.getLibraryDb();
    const store = new WorkStore(db);
    return store.getStats(opts);
  }

  /**
   * Get blocked work items.
   */
  getBlockedWork(): WorkItem[] {
    const db = this.dbManager.getLibraryDb();
    const store = new WorkStore(db);
    return store.getBlocked();
  }

  // ─── Agent Desired State (L4: Library) ──────────────────────

  /**
   * Set desired configuration for an agent.
   */
  setDesiredState(agentId: string, configKey: string, desiredValue: unknown, opts?: {
    source?: string;
    setBy?: string;
    notes?: string;
  }): DesiredStateEntry {
    const db = this.dbManager.getLibraryDb();
    const store = new DesiredStateStore(db);
    const result = store.setDesired(agentId, configKey, desiredValue, opts);
    // Invalidate cache — desired state change affects fleet view
    this.redis.invalidateFleetAgent(agentId).catch(() => {});
    return result;
  }

  /**
   * Report actual runtime value for drift detection. Invalidates cache.
   */
  reportActualState(agentId: string, configKey: string, actualValue: unknown): DriftStatus {
    const db = this.dbManager.getLibraryDb();
    const store = new DesiredStateStore(db);
    const result = store.reportActual(agentId, configKey, actualValue);
    this.redis.invalidateFleetAgent(agentId).catch(() => {});
    return result;
  }

  /**
   * Bulk report actual state (e.g., on session startup / heartbeat). Invalidates cache.
   */
  reportActualStateBulk(agentId: string, actuals: Record<string, unknown>): Record<string, DriftStatus> {
    const db = this.dbManager.getLibraryDb();
    const store = new DesiredStateStore(db);
    const result = store.reportActualBulk(agentId, actuals);
    this.redis.invalidateFleetAgent(agentId).catch(() => {});
    return result;
  }

  /**
   * Get all desired state for an agent.
   */
  getDesiredState(agentId: string): DesiredStateEntry[] {
    const db = this.dbManager.getLibraryDb();
    const store = new DesiredStateStore(db);
    return store.getAgentState(agentId);
  }

  /**
   * Get desired state as a flat config map.
   */
  getDesiredConfig(agentId: string): Record<string, unknown> {
    const db = this.dbManager.getLibraryDb();
    const store = new DesiredStateStore(db);
    return store.getAgentConfig(agentId);
  }

  /**
   * Get all drifted entries across the fleet.
   */
  getDriftedState(): DesiredStateEntry[] {
    const db = this.dbManager.getLibraryDb();
    const store = new DesiredStateStore(db);
    return store.getDrifted();
  }

  /**
   * Get fleet-wide view of a specific config key.
   */
  getFleetConfigKey(configKey: string): DesiredStateEntry[] {
    const db = this.dbManager.getLibraryDb();
    const store = new DesiredStateStore(db);
    return store.getFleetConfig(configKey);
  }

  /**
   * Get config change history.
   */
  getConfigHistory(agentId: string, configKey?: string, limit?: number): import('./desired-state-store.js').ConfigEvent[] {
    const db = this.dbManager.getLibraryDb();
    const store = new DesiredStateStore(db);
    return store.getHistory(agentId, configKey, limit);
  }

  /**
   * Get fleet drift summary.
   */
  getDriftSummary(): { total: number; ok: number; drifted: number; unknown: number; error: number } {
    const db = this.dbManager.getLibraryDb();
    const store = new DesiredStateStore(db);
    return store.getDriftSummary();
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

  // ─── Session Cursor (dual-read: Redis → SQLite fallback) ──────

  /**
   * Get the session cursor for an agent+session.
   * Reads from Redis first; falls back to SQLite if Redis returns null
   * (e.g. after eviction or restart). This is the P1.3 durability guarantee.
   */
  async getSessionCursor(agentId: string, sessionKey: string): Promise<import('./types.js').SessionCursor | null> {
    // Try Redis first (hot path)
    const redisCursor = await this.redis.getCursor(agentId, sessionKey);
    if (redisCursor) return redisCursor;

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

    // Re-warm Redis so subsequent reads are fast
    try {
      await this.redis.setCursor(agentId, sessionKey, cursor);
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

  // ─── Cross-Agent Queries ─────────────────────────────────────

  /**
   * Query another agent's memory with visibility-scoped access.
   */
  queryAgent(
    requesterId: string,
    targetAgentId: string,
    opts?: {
      memoryType?: 'facts' | 'knowledge' | 'topics' | 'episodes' | 'messages';
      domain?: string;
      limit?: number;
    },
    registry?: OrgRegistry
  ): unknown[] {
    return crossAgentQuery(this.dbManager, {
      requesterId,
      targetAgentId,
      memoryType: opts?.memoryType || 'facts',
      domain: opts?.domain,
      limit: opts?.limit,
    }, registry || buildOrgRegistryFromDb(this.dbManager.getLibraryDb()));
  }

  /**
   * Query fleet-wide visible memory.
   */
  queryFleet(
    requesterId: string,
    opts?: {
      memoryType?: 'facts' | 'knowledge' | 'topics' | 'episodes';
      domain?: string;
      limit?: number;
    },
    registry?: OrgRegistry
  ): unknown[] {
    const reg = registry || buildOrgRegistryFromDb(this.dbManager.getLibraryDb());
    const results: unknown[] = [];

    // Query all agents from the fleet registry
    const libraryDb = this.dbManager.getLibraryDb();
    const agents = libraryDb
      .prepare("SELECT id FROM fleet_agents WHERE status = 'active'")
      .all() as Array<{ id: string }>;

    for (const agent of agents) {
      if (agent.id === requesterId) continue;
      try {
        const agentResults = this.queryAgent(requesterId, agent.id, opts, reg);
        results.push(...agentResults);
      } catch {
        // Skip agents we can't query (not in registry)
      }
    }

    return results;
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
   * Seed all ACA files from a workspace directory into the doc chunk index.
   * Idempotent: skips files whose source hash hasn't changed.
   * Force re-index with opts.force = true.
   */
  async seedWorkspace(workspaceDir: string, opts: SeedOptions = {}): Promise<SeedResult> {
    const db = this.dbManager.getLibraryDb();
    const seeder = new WorkspaceSeeder(db);
    return seeder.seedWorkspace(workspaceDir, opts);
  }

  /**
   * Seed a single file into the doc chunk index.
   */
  seedFile(filePath: string, collection: string, opts: SeedOptions = {}) {
    const db = this.dbManager.getLibraryDb();
    const seeder = new WorkspaceSeeder(db);
    return seeder.seedFile(filePath, collection, opts);
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

  // ─── Fleet Cache Hydration ──────────────────────────────────

  /**
   * Hydrate the Redis fleet cache from library.db.
   * Call on gateway startup to warm the cache for dashboard queries.
   * 
   * Populates:
   *  - Per-agent profiles (fleet registry + capabilities + desired state)
   *  - Fleet summary (counts, drift status)
   */
  async hydrateFleetCache(): Promise<{ agents: number; summary: boolean }> {
    if (!this.redis.isConnected) return { agents: 0, summary: false };

    const db = this.dbManager.getLibraryDb();
    const fleetStore = new FleetStore(db);
    const desiredStore = new DesiredStateStore(db);

    const agents = fleetStore.listAgents();
    let hydrated = 0;

    for (const agent of agents) {
      try {
        // Build a composite profile for each agent
        const capabilities = fleetStore.getAgentCapabilities(agent.id);
        const desiredState = desiredStore.getAgentState(agent.id);
        const desiredConfig = desiredStore.getAgentConfig(agent.id);

        const composite = {
          ...agent,
          capabilities: capabilities.map(c => ({ capType: c.capType, name: c.name, version: c.version })),
          desiredState: desiredState.map(d => ({
            configKey: d.configKey,
            desiredValue: d.desiredValue,
            actualValue: d.actualValue,
            driftStatus: d.driftStatus,
          })),
          desiredConfig,
        };

        await this.redis.cacheFleetAgent(agent.id, composite as unknown as Record<string, unknown>);
        hydrated++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[hypermem] Failed to cache agent ${agent.id}: ${message}`);
      }
    }

    // Cache fleet summary
    try {
      const driftSummary = desiredStore.getDriftSummary();
      const summary = {
        totalAgents: agents.length,
        activeAgents: agents.filter(a => a.status === 'active').length,
        tiers: {
          council: agents.filter(a => a.tier === 'council').length,
          director: agents.filter(a => a.tier === 'director').length,
          specialist: agents.filter(a => a.tier === 'specialist').length,
        },
        drift: driftSummary,
        hydratedAt: new Date().toISOString(),
      };
      await this.redis.cacheFleetSummary(summary);
    } catch {
      return { agents: hydrated, summary: false };
    }

    return { agents: hydrated, summary: true };
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  /**
   * Clean shutdown.
   */
  async close(): Promise<void> {
    await this.redis.disconnect();
    this.dbManager.close();
  }
}

export default HyperMem;

export { SessionFlusher, flushSession } from './session-flusher.js';
export type { FlushSessionOptions, FlushSessionResult } from './session-flusher.js';
export { importVault, watchVault, parseObsidianNote, parseFrontmatter, extractWikilinks, extractTags, cleanObsidianMarkdown } from './obsidian-watcher.js';
export type { ObsidianConfig, ObsidianNote, ObsidianImportResult, ObsidianWikiLink, VaultChangeCallback } from './obsidian-watcher.js';
export { exportToVault } from './obsidian-exporter.js';
export type { ObsidianExportConfig, ObsidianExportResult } from './obsidian-exporter.js';
export { collectMetrics, formatMetricsSummary } from './metrics-dashboard.js';
export type { HyperMemMetrics, FactMetrics, WikiMetrics, EpisodeMetrics, VectorMetrics, CompositionMetrics, IngestionMetrics, SystemHealth, MetricsDashboardOptions } from './metrics-dashboard.js';
export { getProfile, mergeProfile, PROFILES, lightProfile, standardProfile, fullProfile, extendedProfile, minimalProfile, richProfile } from './profiles.js';
export type { ProfileName } from './profiles.js';
export { renderStarterFOS, resolveOutputTier } from './fos-mod.js';
export type { OutputStandardTier } from './fos-mod.js';
