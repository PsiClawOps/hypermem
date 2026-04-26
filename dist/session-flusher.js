/**
 * session-flusher.ts
 *
 * Provides a clean, operator-safe way to flush a session's hot cache
 * without touching long-term memory (facts, vectors, episodes, knowledge graph).
 *
 * Used to implement the /fresh slash command — lets users start a new unwarmed
 * session on demand without requiring a gateway restart.
 *
 * Long-term memory (facts, vectors, episodes) is intentionally preserved.
 * It will re-warm naturally on the next session bootstrap.
 */
/**
 * Flush a session's cache hot layer.
 *
 * Safe to call at any time. Long-term stores (SQLite facts, vectors, episodes,
 * knowledge graph) are not touched. The next session bootstrap will re-warm
 * from those stores naturally.
 *
 * @param cache   Connected CacheLayer instance
 * @param agentId Agent identifier (e.g. "alice")
 * @param sessionKey  Full session key (e.g. "agent:alice:webchat:scratchpad")
 * @param opts    Optional flags
 */
export async function flushSession(cache, agentId, sessionKey, opts = {}) {
    const cleared = [];
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
    }
    catch (err) {
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
    cache;
    agentId;
    constructor(cache, agentId) {
        this.cache = cache;
        this.agentId = agentId;
    }
    /**
     * Flush the hot cache for a specific session.
     */
    async flush(sessionKey, opts) {
        return flushSession(this.cache, this.agentId, sessionKey, opts);
    }
}
//# sourceMappingURL=session-flusher.js.map