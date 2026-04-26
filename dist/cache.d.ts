/**
 * hypermem Cache Layer
 *
 * Drop-in replacement for RedisLayer using SQLite :memory: ATTACH.
 * Same public interface, zero external dependencies, zero TCP overhead.
 */
import { DatabaseSync } from 'node:sqlite';
import type { CacheConfig, ComposeDiagnostics, SessionMeta, SessionCursor, StoredMessage, NeutralMessage } from './types.js';
export interface ModelState {
    model: string;
    modelKey?: string;
    provider?: string;
    modelId?: string;
    tokenBudget: number;
    composedAt: string;
    historyDepth: number;
    reshapedAt?: string;
}
export interface WindowCacheMeta {
    slots: Record<string, number>;
    totalTokens: number;
    warnings: string[];
    diagnostics: ComposeDiagnostics;
    composedAt: string;
    /**
     * Deterministic SHA-256 hash of the stable cacheable prefix at compose time.
     * Stored so the C4 fast-exit can detect stable-prefix mutations even when
     * the cursor (message id) has not advanced (e.g. system prompt / identity changed).
     */
    prefixHash?: string;
    /**
     * SHA-256 hash of the system + identity slot contents that fed the stable prefix.
     * Used by C4 to cheaply detect slot mutations without re-running full compose.
     */
    prefixInputHash?: string;
}
export declare class CacheLayer {
    private db;
    private readonly config;
    private _connected;
    private stmtSetSlot;
    private stmtGetSlot;
    private stmtSetTopicSlot;
    private stmtGetTopicSlot;
    private stmtTouchSlots;
    private stmtEvictSlots;
    private stmtActivateSession;
    private stmtDeactivateSession;
    private stmtGetActiveSessions;
    private stmtSetMeta;
    private stmtGetMeta;
    private stmtTouchSession;
    private stmtGetMaxSeq;
    private stmtInsertHistory;
    private stmtGetHistory;
    private stmtGetHistoryLimit;
    private stmtHistoryExists;
    private stmtDeleteHistory;
    private stmtDeleteOldHistory;
    private stmtGetAllHistoryDesc;
    private stmtDeleteHistoryBeforeSeq;
    private stmtEvictHistory;
    private stmtSetWindow;
    private stmtGetWindow;
    private stmtGetFreshWindowBundle;
    private stmtDeleteWindow;
    private stmtEvictWindows;
    private stmtSetKv;
    private stmtGetKv;
    private stmtDeleteKv;
    constructor(config?: Partial<CacheConfig>);
    connect(db?: DatabaseSync): Promise<boolean>;
    private _prepareStatements;
    get isConnected(): boolean;
    setProfile(agentId: string, profile: Record<string, unknown>): Promise<void>;
    getProfile(agentId: string): Promise<Record<string, unknown> | null>;
    addActiveSession(agentId: string, sessionKey: string): Promise<void>;
    removeActiveSession(agentId: string, sessionKey: string): Promise<void>;
    getActiveSessions(agentId: string): Promise<string[]>;
    setSlot(agentId: string, sessionKey: string, slot: string, value: string): Promise<void>;
    getSlot(agentId: string, sessionKey: string, slot: string): Promise<string | null>;
    setSessionMeta(agentId: string, sessionKey: string, meta: SessionMeta): Promise<void>;
    getSessionMeta(agentId: string, sessionKey: string): Promise<SessionMeta | null>;
    pushHistory(agentId: string, sessionKey: string, messages: StoredMessage[], maxMessages?: number): Promise<void>;
    replaceHistory(agentId: string, sessionKey: string, messages: NeutralMessage[], maxMessages?: number): Promise<void>;
    getHistory(agentId: string, sessionKey: string, limit?: number): Promise<StoredMessage[]>;
    sessionExists(agentId: string, sessionKey: string): Promise<boolean>;
    trimHistoryToTokenBudget(agentId: string, sessionKey: string, tokenBudget: number): Promise<number>;
    setWindow(agentId: string, sessionKey: string, messages: NeutralMessage[], ttlSeconds?: number): Promise<void>;
    getWindow(agentId: string, sessionKey: string): Promise<NeutralMessage[] | null>;
    invalidateWindow(agentId: string, sessionKey: string): Promise<void>;
    /**
     * Returns the cached window + metadata only if a single read shows the cache
     * and cursor still refer to the same composed window.
     * Used for C4 window cache fast-exit in compositor.ts.
     */
    getFreshWindowBundle(agentId: string, sessionKey: string, lastMessageId: number): Promise<{
        messages: NeutralMessage[];
        meta: WindowCacheMeta;
    } | null>;
    /**
     * Store compose result metadata alongside the window cache.
     * Enables the C4 fast-exit to return a complete ComposeResult without re-running.
     */
    setWindowMeta(agentId: string, sessionKey: string, meta: WindowCacheMeta, ttl: number): Promise<void>;
    getWindowMeta(agentId: string, sessionKey: string): Promise<WindowCacheMeta | null>;
    setCursor(agentId: string, sessionKey: string, cursor: SessionCursor): Promise<void>;
    getCursor(agentId: string, sessionKey: string): Promise<SessionCursor | null>;
    warmSession(agentId: string, sessionKey: string, slots: {
        system?: string;
        identity?: string;
        repairNotice?: string;
        context?: string;
        facts?: string;
        tools?: string;
        meta?: SessionMeta;
        history?: StoredMessage[];
    }): Promise<void>;
    evictSession(agentId: string, sessionKey: string): Promise<void>;
    touchSession(agentId: string, sessionKey: string): Promise<void>;
    flushPrefix(): Promise<number>;
    setFleetCache(key: string, value: string, ttl?: number): Promise<void>;
    getFleetCache(key: string): Promise<string | null>;
    delFleetCache(key: string): Promise<void>;
    cacheFleetAgent(agentId: string, data: Record<string, unknown>): Promise<void>;
    getCachedFleetAgent(agentId: string): Promise<Record<string, unknown> | null>;
    cacheFleetSummary(summary: Record<string, unknown>): Promise<void>;
    getCachedFleetSummary(): Promise<Record<string, unknown> | null>;
    invalidateFleetAgent(agentId: string): Promise<void>;
    setQueryEmbedding(agentId: string, sessionKey: string, embedding: Float32Array): Promise<void>;
    getQueryEmbedding(agentId: string, sessionKey: string): Promise<Float32Array | null>;
    setTopicSlot(agentId: string, sessionKey: string, topicId: string, slot: string, value: string): Promise<void>;
    getTopicSlot(agentId: string, sessionKey: string, topicId: string, slot: string): Promise<string | null>;
    setTopicWindow(agentId: string, sessionKey: string, topicId: string, messages: NeutralMessage[], ttl?: number): Promise<void>;
    getTopicWindow(agentId: string, sessionKey: string, topicId: string): Promise<NeutralMessage[] | null>;
    invalidateTopicWindow(agentId: string, sessionKey: string, topicId: string): Promise<void>;
    warmTopicSession(agentId: string, sessionKey: string, topicId: string, slots: {
        history?: StoredMessage[];
        window?: NeutralMessage[];
        context?: string;
        facts?: string;
        cursor?: string;
    }): Promise<void>;
    setModelState(agentId: string, sessionKey: string, state: ModelState): Promise<void>;
    getModelState(agentId: string, sessionKey: string): Promise<ModelState | null>;
    disconnect(): Promise<void>;
}
//# sourceMappingURL=cache.d.ts.map