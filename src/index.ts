/**
 * HyperMem — Agent-Centric Memory & Context Composition Engine
 *
 * @module @psiclawops/hypermem
 *
 * Architecture:
 *   L1: Redis       — hot session working memory
 *   L2: messages.db — per-agent conversation log (rotatable)
 *   L3: vectors.db  — per-agent semantic search index (reconstructable)
 *   L4: library.db  — fleet-wide structured knowledge (crown jewel)
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
export { FleetStore } from './fleet-store.js';
export type { FleetAgent, FleetOrg } from './fleet-store.js';
export { SystemStore } from './system-store.js';
export type { SystemState, SystemEvent } from './system-store.js';
export { WorkStore } from './work-store.js';
export type { WorkItem, WorkEvent, WorkStatus } from './work-store.js';

export { RedisLayer } from './redis.js';

export { Compositor } from './compositor.js';

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

export {
  crossAgentQuery,
  canAccess,
  visibilityFilter,
  defaultOrgRegistry,
} from './cross-agent.js';
export type { OrgRegistry } from './cross-agent.js';

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
} from './types.js';

export type { ProviderType } from './provider-translator.js';

import { DatabaseManager } from './db.js';
import { MessageStore } from './message-store.js';
import { FactStore } from './fact-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { TopicStore } from './topic-store.js';
import { EpisodeStore } from './episode-store.js';
import { PreferenceStore, type Preference } from './preference-store.js';
import { FleetStore, type FleetAgent, type FleetOrg } from './fleet-store.js';
import { SystemStore, type SystemState, type SystemEvent } from './system-store.js';
import { WorkStore, type WorkItem, type WorkStatus } from './work-store.js';
import { RedisLayer } from './redis.js';
import { Compositor } from './compositor.js';
import { VectorStore, type VectorSearchResult, type VectorIndexStats } from './vector-store.js';
import { userMessageToNeutral, fromProviderFormat } from './provider-translator.js';
import type {
  HyperMemConfig,
  ComposeRequest,
  ComposeResult,
  NeutralMessage,
  StoredMessage,
  Conversation,
  ChannelType,
} from './types.js';
import { crossAgentQuery, defaultOrgRegistry, type OrgRegistry } from './cross-agent.js';
import path from 'node:path';

const DEFAULT_CONFIG: HyperMemConfig = {
  enabled: true,
  dataDir: path.join(process.env.HOME || '/home/lumadmin', '.openclaw', 'hypermem'),
  redis: {
    host: 'localhost',
    port: 6379,
    keyPrefix: 'hm:',
    sessionTTL: 14400,
    flushInterval: 1000,
  },
  compositor: {
    defaultTokenBudget: 100000,
    maxHistoryMessages: 50,
    maxFacts: 20,
    maxCrossSessionContext: 5000,
    priorityOrder: ['system', 'identity', 'history', 'facts', 'context', 'library'],
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
    this.compositor = new Compositor(this.redis, config.compositor);
  }

  /**
   * Create and initialize a HyperMem instance.
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
   * Register or update a fleet agent.
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
    return store.upsertAgent(id, data);
  }

  /**
   * Get a fleet agent.
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
  async indexAgent(agentId: string): Promise<{ indexed: number; skipped: number }> {
    const db = this.dbManager.getVectorDb(agentId);
    if (!db) return { indexed: 0, skipped: 0 };
    const libraryDb = this.dbManager.getLibraryDb();
    const vs = new VectorStore(db, this.config.embedding, libraryDb);
    vs.ensureTables();
    return vs.indexAll(agentId);
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
    }, registry || defaultOrgRegistry());
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
    const reg = registry || defaultOrgRegistry();
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
