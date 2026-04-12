/**
 * session-flusher.ts
 *
 * Provides a clean, operator-safe way to flush a session's hot cache from Redis
 * without touching long-term memory (facts, vectors, episodes, knowledge graph).
 *
 * Used to implement the /fresh slash command — lets users start a new unwarmed
 * session on demand without requiring a gateway restart.
 *
 * Long-term memory (facts, vectors, episodes) is intentionally preserved.
 * It will re-warm naturally on the next session bootstrap.
 */

import type { CacheLayer } from './cache.js';

export interface FlushSessionOptions {
  /** If true, also clears topic-level Redis keys for this session */
  includeTopics?: boolean;
}

export interface FlushSessionResult {
  success: boolean;
  agentId: string;
  sessionKey: string;
  /** ISO timestamp of the flush */
  flushedAt: string;
  /** What was cleared */
  cleared: string[];
  error?: string;
}

/**
 * Flush a session's cache hot layer.
 *
 * Safe to call at any time. Long-term stores (SQLite facts, vectors, episodes,
 * knowledge graph) are not touched. The next session bootstrap will re-warm
 * from those stores naturally.
 *
 * @param cache   Connected CacheLayer instance
 * @param agentId Agent identifier (e.g. "forge")
 * @param sessionKey  Full session key (e.g. "agent:forge:webchat:scratchpad")
 * @param opts    Optional flags
 */
export async function flushSession(
  cache: CacheLayer,
  agentId: string,
  sessionKey: string,
  opts: FlushSessionOptions = {}
): Promise<FlushSessionResult> {
  const cleared: string[] = [];

  try {
    // Core eviction — clears: system, identity, history, window, cursor,
    // context, facts, tools, meta — and removes from active sessions set
    await cache.evictSession(agentId, sessionKey);
    cleared.push('system', 'identity', 'history', 'window', 'cursor', 'context', 'facts', 'tools', 'meta', 'active-sessions');

    return {
      success: true,
      agentId,
      sessionKey,
      flushedAt: new Date().toISOString(),
      cleared,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      agentId,
      sessionKey,
      flushedAt: new Date().toISOString(),
      cleared,
      error,
    };
  }
}

/**
 * Convenience class for operator tooling that holds a bound agentId.
 */
export class SessionFlusher {
  constructor(
    private readonly cache: CacheLayer,
    private readonly agentId: string
  ) {}

  /**
   * Flush the hot cache for a specific session.
   */
  async flush(sessionKey: string, opts?: FlushSessionOptions): Promise<FlushSessionResult> {
    return flushSession(this.cache, this.agentId, sessionKey, opts);
  }
}
