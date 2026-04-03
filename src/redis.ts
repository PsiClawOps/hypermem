/**
 * HyperMem Redis Layer
 *
 * Manages the hot-state compositor cache.
 * Per-agent, per-session keyspace with TTL management.
 * Falls back gracefully when Redis is unavailable.
 */

import { Redis as RedisClient } from 'ioredis';
type RedisInstance = RedisClient;
import type { RedisConfig, SessionMeta, SessionCursor, StoredMessage, NeutralMessage } from './types.js';

const DEFAULT_CONFIG: RedisConfig = {
  host: 'localhost',
  port: 6379,
  keyPrefix: 'hm:',
  sessionTTL: 14400,     // 4 hours — slots like system/identity/meta
  historyTTL: 86400,     // 24 hours — history list ages out after a day
  flushInterval: 1000,   // 1 second
};

export class RedisLayer {
  private client: RedisInstance | null = null;
  private readonly config: RedisConfig;
  private connected = false;

  constructor(config?: Partial<RedisConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Connect to Redis. Non-blocking — operations degrade gracefully if connection fails.
   */
  async connect(): Promise<boolean> {
    try {
      this.client = new RedisClient({
        host: this.config.host,
        port: this.config.port,
        password: this.config.password,
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        retryStrategy(times: number) {
          if (times > 3) return null; // stop retrying
          return Math.min(times * 200, 2000);
        },
        enableReadyCheck: true,
      });

      this.client.on('connect', () => { this.connected = true; });
      this.client.on('close', () => { this.connected = false; });
      this.client.on('error', (err: Error) => {
        console.warn('[hypermem-redis] Connection error:', err.message);
        this.connected = false;
      });

      // Wait briefly for connection
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 3000);
        this.client!.once('ready', () => {
          clearTimeout(timeout);
          this.connected = true;
          resolve();
        });
        this.client!.once('error', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      return this.connected;
    } catch {
      console.warn('[hypermem-redis] Failed to connect');
      return false;
    }
  }

  get isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  // ─── Key Helpers ─────────────────────────────────────────────

  private agentKey(agentId: string, suffix: string): string {
    return `${this.config.keyPrefix}${agentId}:${suffix}`;
  }

  private sessionKey(agentId: string, sessionKey: string, slot: string): string {
    return `${this.config.keyPrefix}${agentId}:s:${sessionKey}:${slot}`;
  }

  // ─── Agent-Level Operations ──────────────────────────────────

  /**
   * Set the agent's profile in Redis.
   */
  async setProfile(agentId: string, profile: Record<string, unknown>): Promise<void> {
    if (!this.isConnected) return;
    const key = this.agentKey(agentId, 'profile');
    await this.client!.set(key, JSON.stringify(profile));
  }

  /**
   * Get the agent's profile.
   */
  async getProfile(agentId: string): Promise<Record<string, unknown> | null> {
    if (!this.isConnected) return null;
    const key = this.agentKey(agentId, 'profile');
    const val = await this.client!.get(key);
    return val ? JSON.parse(val) : null;
  }

  /**
   * Track active sessions for an agent.
   */
  async addActiveSession(agentId: string, sessionKey: string): Promise<void> {
    if (!this.isConnected) return;
    const key = this.agentKey(agentId, 'active_sessions');
    await this.client!.sadd(key, sessionKey);
  }

  async removeActiveSession(agentId: string, sessionKey: string): Promise<void> {
    if (!this.isConnected) return;
    const key = this.agentKey(agentId, 'active_sessions');
    await this.client!.srem(key, sessionKey);
  }

  async getActiveSessions(agentId: string): Promise<string[]> {
    if (!this.isConnected) return [];
    const key = this.agentKey(agentId, 'active_sessions');
    return this.client!.smembers(key);
  }

  // ─── Session Slot Operations ─────────────────────────────────

  /**
   * Set a session slot value.
   */
  async setSlot(agentId: string, sessionKey: string, slot: string, value: string): Promise<void> {
    if (!this.isConnected) return;
    const key = this.sessionKey(agentId, sessionKey, slot);
    await this.client!.set(key, value, 'EX', this.config.sessionTTL);
  }

  /**
   * Get a session slot value.
   */
  async getSlot(agentId: string, sessionKey: string, slot: string): Promise<string | null> {
    if (!this.isConnected) return null;
    const key = this.sessionKey(agentId, sessionKey, slot);
    return this.client!.get(key);
  }

  /**
   * Set session metadata.
   */
  async setSessionMeta(agentId: string, sessionKey: string, meta: SessionMeta): Promise<void> {
    if (!this.isConnected) return;
    const key = this.sessionKey(agentId, sessionKey, 'meta');
    await this.client!.hmset(key, {
      agentId: meta.agentId,
      sessionKey: meta.sessionKey,
      provider: meta.provider || '',
      model: meta.model || '',
      channelType: meta.channelType,
      tokenCount: String(meta.tokenCount),
      lastActive: meta.lastActive,
      status: meta.status,
    });
    await this.client!.expire(key, this.config.sessionTTL);
  }

  /**
   * Get session metadata.
   */
  async getSessionMeta(agentId: string, sessionKey: string): Promise<SessionMeta | null> {
    if (!this.isConnected) return null;
    const key = this.sessionKey(agentId, sessionKey, 'meta');
    const data = await this.client!.hgetall(key);
    if (!data || !data.agentId) return null;

    return {
      agentId: data.agentId,
      sessionKey: data.sessionKey,
      provider: data.provider || null,
      model: data.model || null,
      channelType: data.channelType as SessionMeta['channelType'],
      tokenCount: parseInt(data.tokenCount || '0', 10),
      lastActive: data.lastActive,
      status: data.status as SessionMeta['status'],
    };
  }

  /**
   * Push messages to the session history list.
   *
   * History retention strategy:
   *   - No aggressive LTRIM. Cap at maxMessages (default 1000) to prevent
   *     unbounded growth, but the real budget enforcement happens in the
   *     compositor at compose time.
   *   - TTL is historyTTL (default 24h), not sessionTTL. History outlives
   *     other session slots because it's the primary context source.
   *   - System/identity slots are refreshed on every warmSession() call,
   *     so they effectively never expire during an active session.
   */
  async pushHistory(
    agentId: string,
    sessionKey: string,
    messages: StoredMessage[],
    maxMessages: number = 1000
  ): Promise<void> {
    if (!this.isConnected || messages.length === 0) return;
    const key = this.sessionKey(agentId, sessionKey, 'history');

    // Tail-check dedup: read the last stored message id before appending.
    // Filters out messages already present from a previous warm/push call.
    // This is the primary defense against bootstrap re-runs duplicating history.
    // Uses monotonically increasing StoredMessage.id for ordering guarantees.
    let filteredMessages = messages;
    try {
      const tail = await this.client!.lrange(key, -1, -1);
      if (tail.length > 0) {
        const lastStored = JSON.parse(tail[0]) as StoredMessage;
        if (lastStored.id != null) {
          filteredMessages = messages.filter(m => m.id > lastStored.id);
        }
      }
    } catch {
      // Tail-check failure is non-fatal — fall through to full push
    }

    if (filteredMessages.length === 0) return;

    const pipeline = this.client!.pipeline();
    for (const msg of filteredMessages) {
      pipeline.rpush(key, JSON.stringify(msg));
    }
    // Soft cap — only trim if we're way over. This is a safety net,
    // not a context management strategy. The compositor handles budget.
    pipeline.ltrim(key, -maxMessages, -1);
    // History gets its own longer TTL
    pipeline.expire(key, this.config.historyTTL);
    await pipeline.exec();
  }

  /**
   * Get session history from Redis.
   *
   * @param limit - When provided, return only the last N messages using
   *   negative indexing (LRANGE -limit -1). This is the correct enforcement
   *   point for historyDepth — previously the limit param was ignored on the
   *   Redis path and only applied to the SQLite fallback.
   */
  async getHistory(agentId: string, sessionKey: string, limit?: number): Promise<StoredMessage[]> {
    if (!this.isConnected) return [];
    const key = this.sessionKey(agentId, sessionKey, 'history');
    // When limit is provided, use LRANGE -limit -1 to fetch the last N messages.
    // LRANGE 0 -1 returns everything; -limit -1 returns the last `limit` entries.
    const start = limit ? -limit : 0;
    const items = await this.client!.lrange(key, start, -1);
    return items.map((item: string) => JSON.parse(item));
  }

  /**
   * Check whether a session already has history in Redis.
   * Used by the bootstrap idempotency guard to avoid re-warming hot sessions.
   *
   * Single EXISTS call — sub-millisecond, no data transferred.
   */
  async sessionExists(agentId: string, sessionKey: string): Promise<boolean> {
    if (!this.isConnected) return false;
    const key = this.sessionKey(agentId, sessionKey, 'history');
    const exists = await this.client!.exists(key);
    return exists === 1;
  }

  /**
   * Trim Redis history to fit within a token budget.
   *
   * Walks the history newest→oldest, accumulating estimated tokens.
   * When the budget is exceeded, trims everything older via LTRIM.
   * This is the guardrail against model switches: if an agent ran on a
   * 1M-context model and accumulated a huge history, then switched to a
   * 120K model, the first assemble() call trims the excess.
   *
   * Token estimation: text at length/4, tool JSON at length/2 (dense).
   *
   * @returns Number of messages trimmed, or 0 if already within budget.
   */
  async trimHistoryToTokenBudget(
    agentId: string,
    sessionKey: string,
    tokenBudget: number
  ): Promise<number> {
    if (!this.isConnected || tokenBudget <= 0) return 0;
    const key = this.sessionKey(agentId, sessionKey, 'history');

    // Get total length first — avoid fetching everything if small
    const totalLen = await this.client!.llen(key);
    if (totalLen <= 10) return 0; // tiny history, skip

    // Fetch all messages to estimate tokens
    const items = await this.client!.lrange(key, 0, -1);
    if (items.length === 0) return 0;

    // Walk newest→oldest, find the cut point
    let tokenSum = 0;
    let keepFrom = 0; // index (0-based) of the oldest message to keep
    for (let i = items.length - 1; i >= 0; i--) {
      try {
        const msg: StoredMessage = JSON.parse(items[i]);
        let msgTokens = Math.ceil((msg.textContent?.length ?? 0) / 4);
        if (msg.toolCalls) msgTokens += Math.ceil(JSON.stringify(msg.toolCalls).length / 2);
        if (msg.toolResults) msgTokens += Math.ceil(JSON.stringify(msg.toolResults).length / 2);
        tokenSum += msgTokens;
        if (tokenSum > tokenBudget) {
          keepFrom = i + 1;
          break;
        }
      } catch {
        // Unparseable message — count as 500 tokens
        tokenSum += 500;
        if (tokenSum > tokenBudget) {
          keepFrom = i + 1;
          break;
        }
      }
    }

    if (keepFrom <= 0) return 0; // everything fits

    // LTRIM keeps [keepFrom, -1] — drops everything before keepFrom
    await this.client!.ltrim(key, keepFrom, -1);
    console.log(`[hypermem-redis] trimHistoryToTokenBudget: trimmed ${keepFrom} messages from ${agentId}/${sessionKey} (budget=${tokenBudget}, had=${items.length}, kept=${items.length - keepFrom})`);
    return keepFrom;
  }

  // ─── Window Cache Operations ───────────────────────────────

  /**
   * Cache the compositor's assembled submission window.
   *
   * The window is the token-budgeted, deduplicated output of compose() —
   * what actually gets sent to the provider. Separate from history (the
   * append-only archive). Short TTL: 120s default, refreshed each compose.
   */
  async setWindow(
    agentId: string,
    sessionKey: string,
    messages: NeutralMessage[],
    ttlSeconds: number = 120
  ): Promise<void> {
    if (!this.isConnected) return;
    const key = this.sessionKey(agentId, sessionKey, 'window');
    await this.client!.set(key, JSON.stringify(messages), 'EX', ttlSeconds);
  }

  /**
   * Get the cached submission window.
   * Returns null on cache miss — caller should run full compose().
   */
  async getWindow(agentId: string, sessionKey: string): Promise<NeutralMessage[] | null> {
    if (!this.isConnected) return null;
    const key = this.sessionKey(agentId, sessionKey, 'window');
    const val = await this.client!.get(key);
    return val ? JSON.parse(val) : null;
  }

  /**
   * Invalidate the submission window cache.
   * Called after afterTurn ingest writes new messages — ensures the next
   * compose() runs fresh instead of serving a stale cached window.
   */
  async invalidateWindow(agentId: string, sessionKey: string): Promise<void> {
    if (!this.isConnected) return;
    const key = this.sessionKey(agentId, sessionKey, 'window');
    await this.client!.del(key);
  }

  // ─── Session Cursor Operations ─────────────────────────────

  /**
   * Write the session cursor after compose().
   * Tracks the boundary between "LLM has seen this" and "new since last compose."
   * TTL matches history (24h) so the cursor outlives the window cache.
   */
  async setCursor(
    agentId: string,
    sessionKey: string,
    cursor: SessionCursor
  ): Promise<void> {
    if (!this.isConnected) return;
    const key = this.sessionKey(agentId, sessionKey, 'cursor');
    await this.client!.set(key, JSON.stringify(cursor), 'EX', this.config.historyTTL);
  }

  /**
   * Get the session cursor.
   * Returns null if no cursor exists (first compose, or Redis eviction).
   */
  async getCursor(agentId: string, sessionKey: string): Promise<SessionCursor | null> {
    if (!this.isConnected) return null;
    const key = this.sessionKey(agentId, sessionKey, 'cursor');
    const val = await this.client!.get(key);
    return val ? JSON.parse(val) : null;
  }

  // ─── Bulk Session Operations ─────────────────────────────────

  /**
   * Warm all slots for a session at once.
   */
  async warmSession(
    agentId: string,
    sessionKey: string,
    slots: {
      system?: string;
      identity?: string;
      context?: string;
      facts?: string;
      tools?: string;
      meta?: SessionMeta;
      history?: StoredMessage[];
    }
  ): Promise<void> {
    if (!this.isConnected) return;

    const pipeline = this.client!.pipeline();

    if (slots.system) {
      const key = this.sessionKey(agentId, sessionKey, 'system');
      pipeline.set(key, slots.system, 'EX', this.config.sessionTTL);
    }
    if (slots.identity) {
      const key = this.sessionKey(agentId, sessionKey, 'identity');
      pipeline.set(key, slots.identity, 'EX', this.config.sessionTTL);
    }
    if (slots.context) {
      const key = this.sessionKey(agentId, sessionKey, 'context');
      pipeline.set(key, slots.context, 'EX', this.config.sessionTTL);
    }
    if (slots.facts) {
      const key = this.sessionKey(agentId, sessionKey, 'facts');
      pipeline.set(key, slots.facts, 'EX', this.config.sessionTTL);
    }
    if (slots.tools) {
      const key = this.sessionKey(agentId, sessionKey, 'tools');
      pipeline.set(key, slots.tools, 'EX', this.config.sessionTTL);
    }

    await pipeline.exec();

    if (slots.meta) {
      await this.setSessionMeta(agentId, sessionKey, slots.meta);
    }
    if (slots.history && slots.history.length > 0) {
      await this.pushHistory(agentId, sessionKey, slots.history);
    }

    // Mark session as active
    await this.addActiveSession(agentId, sessionKey);
  }

  /**
   * Evict all keys for a session.
   */
  async evictSession(agentId: string, sessionKey: string): Promise<void> {
    if (!this.isConnected) return;

    const slots = ['system', 'identity', 'history', 'window', 'cursor', 'context', 'facts', 'tools', 'meta'];
    const keys = slots.map(s => this.sessionKey(agentId, sessionKey, s));
    await this.client!.del(...keys);
    await this.removeActiveSession(agentId, sessionKey);
  }

  // ─── Touch / TTL ─────────────────────────────────────────────

  /**
   * Refresh TTL on all session keys.
   * Uses historyTTL for the history slot, sessionTTL for everything else.
   */
  async touchSession(agentId: string, sessionKey: string): Promise<void> {
    if (!this.isConnected) return;

    const slotTTLs: Array<[string, number]> = [
      ['system', this.config.sessionTTL],
      ['identity', this.config.sessionTTL],
      ['history', this.config.historyTTL],
      ['window', 120],                      // short-lived compose output cache
      ['cursor', this.config.historyTTL],    // lives as long as history
      ['context', this.config.sessionTTL],
      ['facts', this.config.sessionTTL],
      ['tools', this.config.sessionTTL],
      ['meta', this.config.sessionTTL],
    ];
    const pipeline = this.client!.pipeline();
    for (const [slot, ttl] of slotTTLs) {
      pipeline.expire(this.sessionKey(agentId, sessionKey, slot), ttl);
    }
    await pipeline.exec();
  }

  /**
   * Flush all keys matching this instance's prefix. For testing only.
   */
  async flushPrefix(): Promise<number> {
    if (!this.isConnected) return 0;
    const pattern = `${this.config.keyPrefix}*`;
    const keys = await this.client!.keys(pattern);
    if (keys.length === 0) return 0;
    await this.client!.del(...keys);
    return keys.length;
  }

  // ─── Fleet Cache (Library L4 Hot Layer) ───────────────────────

  /**
   * Cache a fleet-level value. Used for library data that's read frequently.
   * TTL defaults to 10 minutes — short enough to pick up changes, long enough
   * to avoid hammering SQLite on every heartbeat.
   */
  async setFleetCache(key: string, value: string, ttl: number = 600): Promise<void> {
    if (!this.isConnected) return;
    const redisKey = `${this.config.keyPrefix}fleet:${key}`;
    await this.client!.set(redisKey, value, 'EX', ttl);
  }

  /**
   * Get a fleet-level cached value.
   */
  async getFleetCache(key: string): Promise<string | null> {
    if (!this.isConnected) return null;
    const redisKey = `${this.config.keyPrefix}fleet:${key}`;
    return this.client!.get(redisKey);
  }

  /**
   * Delete a fleet-level cached value.
   */
  async delFleetCache(key: string): Promise<void> {
    if (!this.isConnected) return;
    const redisKey = `${this.config.keyPrefix}fleet:${key}`;
    await this.client!.del(redisKey);
  }

  /**
   * Cache a fleet agent's full profile (fleet registry + capabilities + desired state).
   * Structured so a single key read gives the dashboard everything it needs.
   */
  async cacheFleetAgent(agentId: string, data: Record<string, unknown>): Promise<void> {
    await this.setFleetCache(`agent:${agentId}`, JSON.stringify(data));
  }

  /**
   * Get a cached fleet agent profile.
   */
  async getCachedFleetAgent(agentId: string): Promise<Record<string, unknown> | null> {
    const val = await this.getFleetCache(`agent:${agentId}`);
    return val ? JSON.parse(val) : null;
  }

  /**
   * Cache the fleet summary (agent count, drift count, etc.).
   * Short TTL — recalculated frequently.
   */
  async cacheFleetSummary(summary: Record<string, unknown>): Promise<void> {
    await this.setFleetCache('summary', JSON.stringify(summary), 120); // 2 min
  }

  /**
   * Get the cached fleet summary.
   */
  async getCachedFleetSummary(): Promise<Record<string, unknown> | null> {
    const val = await this.getFleetCache('summary');
    return val ? JSON.parse(val) : null;
  }

  /**
   * Invalidate all fleet cache entries for a specific agent.
   * Call after mutations to fleet registry / desired state.
   */
  async invalidateFleetAgent(agentId: string): Promise<void> {
    await this.delFleetCache(`agent:${agentId}`);
    await this.delFleetCache('summary'); // Summary includes this agent
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.connected = false;
    }
  }
}
