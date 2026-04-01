/**
 * HyperMem — Agent-Centric Memory & Context Composition Engine
 *
 * @module @psiclawops/hypermem
 *
 * Core API:
 *   HyperMem.create(config)     — initialize the engine
 *   hm.record(agentId, ...)     — record a message
 *   hm.compose(request)         — compose context for LLM call
 *   hm.warm(agentId, session)   — warm session from SQLite into Redis
 *   hm.search(agentId, query)   — full-text search across agent's messages
 *   hm.close()                  — clean shutdown
 */

export { DatabaseManager } from './db.js';
export type { DatabaseManagerConfig } from './db.js';

export { MessageStore } from './message-store.js';
export { FactStore } from './fact-store.js';
export { KnowledgeStore } from './knowledge-store.js';
export type { LinkType } from './knowledge-store.js';
export { TopicStore } from './topic-store.js';
export { EpisodeStore } from './episode-store.js';

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

export type {
  // Message types
  NeutralMessage,
  NeutralToolCall,
  NeutralToolResult,
  StoredMessage,
  MessageRole,
  ProviderMessage,
  // Entity types
  Conversation,
  Fact,
  Topic,
  Knowledge,
  Episode,
  // Compositor types
  ComposeRequest,
  ComposeResult,
  SlotTokenCounts,
  SessionSlots,
  SessionMeta,
  // Config types
  HyperMemConfig,
  RedisConfig,
  CompositorConfig,
  IndexerConfig,
  // Enums
  ChannelType,
  ConversationStatus,
  FactScope,
  TopicStatus,
  EpisodeType,
} from './types.js';

export type { ProviderType } from './provider-translator.js';

import { DatabaseManager } from './db.js';
import { MessageStore } from './message-store.js';
import { FactStore } from './fact-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { TopicStore } from './topic-store.js';
import { EpisodeStore } from './episode-store.js';
import { RedisLayer } from './redis.js';
import { Compositor } from './compositor.js';
import { userMessageToNeutral, fromProviderFormat, toProviderFormat } from './provider-translator.js';
import {
  crossAgentQuery,
  defaultOrgRegistry,
  canAccess,
  visibilityFilter,
  type OrgRegistry,
} from './cross-agent.js';
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
   * Connects to Redis (non-blocking — degrades gracefully if unavailable).
   */
  static async create(config?: Partial<HyperMemConfig>): Promise<HyperMem> {
    const merged: HyperMemConfig = {
      ...DEFAULT_CONFIG,
      ...config,
      redis: { ...DEFAULT_CONFIG.redis, ...config?.redis },
      compositor: { ...DEFAULT_CONFIG.compositor, ...config?.compositor },
      indexer: { ...DEFAULT_CONFIG.indexer, ...config?.indexer },
    };

    const hm = new HyperMem(merged);

    // Try to connect to Redis — non-blocking
    const redisOk = await hm.redis.connect();
    if (redisOk) {
      console.log('[hypermem] Redis connected');
    } else {
      console.warn('[hypermem] Redis unavailable — running in SQLite-only mode');
    }

    return hm;
  }

  // ─── Core API ────────────────────────────────────────────────

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
    const db = this.dbManager.getAgentDb(agentId);
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

    // Push to Redis history
    await this.redis.pushHistory(agentId, sessionKey, [stored], this.config.compositor.maxHistoryMessages);
    await this.redis.touchSession(agentId, sessionKey);

    return stored;
  }

  /**
   * Record an assistant response (from LLM).
   */
  async recordAssistantMessage(
    agentId: string,
    sessionKey: string,
    message: NeutralMessage,
    opts?: {
      tokenCount?: number;
    }
  ): Promise<StoredMessage> {
    const db = this.dbManager.getAgentDb(agentId);
    const store = new MessageStore(db);

    const conversation = store.getConversation(sessionKey);
    if (!conversation) {
      throw new Error(`No conversation found for session ${sessionKey}`);
    }

    const stored = store.recordMessage(conversation.id, agentId, message, {
      tokenCount: opts?.tokenCount,
    });

    // Push to Redis history
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
    const db = this.dbManager.getAgentDb(request.agentId);
    return this.compositor.compose(request, db);
  }

  /**
   * Warm a session from SQLite into Redis.
   */
  async warm(
    agentId: string,
    sessionKey: string,
    opts?: { systemPrompt?: string; identity?: string }
  ): Promise<void> {
    const db = this.dbManager.getAgentDb(agentId);
    await this.compositor.warmSession(agentId, sessionKey, db, opts);
  }

  /**
   * Full-text search across all messages for an agent.
   */
  search(agentId: string, query: string, limit: number = 20): StoredMessage[] {
    const db = this.dbManager.getAgentDb(agentId);
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
    const db = this.dbManager.getAgentDb(agentId);
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

  // ─── Extended Memory ─────────────────────────────────────────

  /**
   * Add a fact for an agent.
   */
  addFact(agentId: string, content: string, opts?: {
    scope?: 'agent' | 'session' | 'user';
    domain?: string;
    confidence?: number;
    sourceConversationId?: number;
    sourceMessageId?: number;
  }): unknown {
    const db = this.dbManager.getAgentDb(agentId);
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
    const db = this.dbManager.getAgentDb(agentId);
    const store = new FactStore(db);
    return store.getActiveFacts(agentId, opts);
  }

  /**
   * Add/update knowledge for an agent.
   */
  upsertKnowledge(agentId: string, domain: string, key: string, content: string, opts?: {
    confidence?: number;
    sourceType?: string;
    sourceRef?: string;
    expiresAt?: string;
  }): unknown {
    const db = this.dbManager.getAgentDb(agentId);
    const store = new KnowledgeStore(db);
    return store.upsert(agentId, domain, key, content, opts);
  }

  /**
   * Get active knowledge, optionally filtered by domain.
   */
  getKnowledge(agentId: string, opts?: { domain?: string; limit?: number }): unknown[] {
    const db = this.dbManager.getAgentDb(agentId);
    const store = new KnowledgeStore(db);
    return store.getActive(agentId, opts);
  }

  /**
   * Create a topic for an agent.
   */
  createTopic(agentId: string, name: string, description?: string): unknown {
    const db = this.dbManager.getAgentDb(agentId);
    const store = new TopicStore(db);
    return store.create(agentId, name, description);
  }

  /**
   * Get active topics.
   */
  getActiveTopics(agentId: string, limit: number = 20): unknown[] {
    const db = this.dbManager.getAgentDb(agentId);
    const store = new TopicStore(db);
    return store.getActive(agentId, limit);
  }

  /**
   * Record an episode (significant event).
   */
  recordEpisode(agentId: string, eventType: string, summary: string, opts?: {
    significance?: number;
    participants?: string[];
    conversationId?: number;
    messageRangeStart?: number;
    messageRangeEnd?: number;
  }): unknown {
    const db = this.dbManager.getAgentDb(agentId);
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
    const db = this.dbManager.getAgentDb(agentId);
    const store = new EpisodeStore(db);
    return store.getRecent(agentId, opts as Parameters<typeof store.getRecent>[1]);
  }

  // ─── Cross-Agent Access ────────────────────────────────────────

  private orgRegistry: OrgRegistry = defaultOrgRegistry();

  /**
   * Override the org registry (for custom fleet configurations).
   */
  setOrgRegistry(registry: OrgRegistry): void {
    this.orgRegistry = registry;
  }

  /**
   * Query another agent's memory with visibility-scoped access control.
   *
   * What you CAN read:
   * - fleet-visible facts, knowledge, episodes from any agent
   * - council-visible data if you're a council seat
   * - org-visible data if you're in the same org
   * - Everything from yourself
   *
   * What you CANNOT read (ever, regardless of visibility):
   * - Raw conversation messages (always private)
   * - Identity-domain facts/knowledge (hardcoded exclusion)
   * - Session-scoped facts (ephemeral, meaningless cross-agent)
   */
  queryAgent(requesterId: string, targetAgentId: string, opts?: {
    query?: string;
    domain?: string;
    memoryType?: 'facts' | 'knowledge' | 'topics' | 'episodes' | 'messages';
    limit?: number;
  }): unknown[] {
    return crossAgentQuery(this.dbManager, {
      requesterId,
      targetAgentId,
      query: opts?.query,
      domain: opts?.domain,
      memoryType: opts?.memoryType,
      limit: opts?.limit,
    }, this.orgRegistry);
  }

  /**
   * Query ALL agents that the requester has access to, aggregating results.
   * Useful for "what does the fleet know about X?" queries.
   */
  queryFleet(requesterId: string, opts?: {
    query?: string;
    domain?: string;
    memoryType?: 'facts' | 'knowledge' | 'topics' | 'episodes';
    limit?: number;
  }): unknown[] {
    const allAgents = this.dbManager.listAgents();
    const results: unknown[] = [];
    const perAgentLimit = Math.max(3, Math.ceil((opts?.limit || 20) / allAgents.length));

    for (const agentId of allAgents) {
      try {
        const agentResults = this.queryAgent(requesterId, agentId, {
          ...opts,
          limit: perAgentLimit,
        });
        results.push(...agentResults);
      } catch {
        // Agent DB might not exist or be corrupted — skip
      }
    }

    // Sort by relevance (confidence for facts/knowledge, significance for episodes)
    return results.slice(0, opts?.limit || 20);
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  /**
   * Clean shutdown: close all databases and Redis connection.
   */
  async close(): Promise<void> {
    await this.redis.disconnect();
    this.dbManager.close();
  }
}

export default HyperMem;
