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
import type { CacheLayer } from './cache.js';
export interface FlushSessionOptions {
    /** If true, also clears topic-level hot-cache entries for this session */
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
 * @param agentId Agent identifier (e.g. "alice")
 * @param sessionKey  Full session key (e.g. "agent:alice:webchat:scratchpad")
 * @param opts    Optional flags
 */
export declare function flushSession(cache: CacheLayer, agentId: string, sessionKey: string, opts?: FlushSessionOptions): Promise<FlushSessionResult>;
/**
 * Convenience class for operator tooling that holds a bound agentId.
 */
export declare class SessionFlusher {
    private readonly cache;
    private readonly agentId;
    constructor(cache: CacheLayer, agentId: string);
    /**
     * Flush the hot cache for a specific session.
     */
    flush(sessionKey: string, opts?: FlushSessionOptions): Promise<FlushSessionResult>;
}
//# sourceMappingURL=session-flusher.d.ts.map