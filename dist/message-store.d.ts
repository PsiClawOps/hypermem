/**
 * hypermem Message Store
 *
 * CRUD operations for conversations and messages in SQLite.
 * All messages are stored in provider-neutral format.
 * This is the write-through layer: Redis → here.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { NeutralMessage, StoredMessage, Conversation, ChannelType, ConversationStatus, RecentTurn, ArchivedMiningQuery, ArchivedMiningResult, MultiContextMiningOptions } from './types.js';
export declare class MessageStore {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Get or create a conversation for a session.
     */
    getOrCreateConversation(agentId: string, sessionKey: string, opts?: {
        channelType?: ChannelType;
        channelId?: string;
        provider?: string;
        model?: string;
    }): Conversation;
    /**
     * Get a conversation by session key.
     */
    getConversation(sessionKey: string): Conversation | null;
    /**
     * Get all conversations for an agent, optionally filtered.
     */
    getConversations(agentId: string, opts?: {
        status?: ConversationStatus;
        channelType?: ChannelType;
        limit?: number;
    }): Conversation[];
    /**
     * Update conversation metadata.
     */
    updateConversation(conversationId: number, updates: {
        provider?: string;
        model?: string;
        status?: ConversationStatus;
        endedAt?: string;
    }): void;
    /**
     * Record a message to the database.
     * Returns the stored message with its assigned ID.
     *
     * Phase 2 (Turn DAG): automatically sets parent_id and depth.
     *   - parent_id = context.head_message_id (the previous message on this branch)
     *   - depth = parent.depth + 1 (or 0 if first message)
     */
    recordMessage(conversationId: number, agentId: string, message: NeutralMessage, opts?: {
        tokenCount?: number;
        isHeartbeat?: boolean;
        contextId?: number;
    }): StoredMessage;
    /**
     * Get recent messages for a conversation.
     */
    getRecentMessages(conversationId: number, limit?: number, minMessageId?: number): StoredMessage[];
    /**
     * Get recent messages scoped to a topic (P3.4, Option B).
     * Returns messages matching the topic_id OR with topic_id IS NULL
     * (legacy messages created before topic tracking was introduced).
     * This is transition-safe: no legacy messages are silently dropped.
     */
    getRecentMessagesByTopic(conversationId: number, topicId: string, limit?: number, minMessageId?: number): StoredMessage[];
    /**
     * Get messages across all conversations for an agent (cross-session query).
     */
    getAgentMessages(agentId: string, opts?: {
        since?: string;
        limit?: number;
        excludeHeartbeats?: boolean;
    }): StoredMessage[];
    /**
     * Full-text search across all messages for an agent.
     */
    searchMessages(agentId: string, query: string, limit?: number): StoredMessage[];
    /**
     * Get recent turns for a session, in chronological order, with tool calls stripped.
     * Joins messages through conversations to find by session_key.
     * Returns up to `n` turns (capped at 50).
     */
    getRecentTurns(sessionKey: string, n: number): RecentTurn[];
    /**
     * Get messages by walking the parent_id chain from a head message backward.
     * This is the DAG-native read path introduced in Phase 3.
     *
     * Walks from headMessageId backward through parent_id links, collecting
     * up to `limit` messages in chronological order.
     *
     * Falls back to getRecentMessages if the head message has no parent chain
     * (e.g., legacy data before backfill).
     *
     * @boundary SHARED DAG PRIMITIVE — not for direct call at mining call sites.
     * @policy See specs/DAG_HELPER_POLICY.md for operator-boundary rules.
     * Use mineArchivedContext / mineArchivedContexts for archived context mining,
     * and the active-composition paths for live session history. Direct call sites
     * outside this class should be limited to exceptional diagnostic use.
     */
    getHistoryByDAGWalk(headMessageId: number, limit?: number): StoredMessage[];
    /**
     * Get messages scoped to a specific context_id.
     * Used by keystone/FTS/topic recall to constrain results to the active branch.
     */
    getMessagesByContextId(contextId: number, limit?: number, opts?: {
        excludeHeartbeats?: boolean;
        requireText?: boolean;
    }): StoredMessage[];
    /**
     * Full-text search constrained to a specific context_id.
     * Phase 3: replaces unscoped searchMessages for composition paths.
     */
    searchMessagesByContextId(contextId: number, query: string, limit?: number): StoredMessage[];
    /**
     * Get message count for a conversation.
     */
    getMessageCount(conversationId: number): number;
    /**
     * Get the full message chain for an archived or forked context.
     *
     * Throws if the context does not exist or is active (not archived/forked).
     * Returns an empty array if the context has no head message.
     * Delegates to getHistoryByDAGWalk for the actual chain retrieval.
     */
    getArchivedChain(contextId: number, limit?: number): StoredMessage[];
    /**
     * Default maximum number of contextIds accepted by mineArchivedContexts.
     * Callers may supply a lower value but not a higher one.
     */
    static readonly ARCHIVED_MULTI_CONTEXT_DEFAULT_MAX = 20;
    /**
     * Hard ceiling for mineArchivedContexts.
     * Values above this are clamped to this number regardless of caller intent.
     * This prevents unbounded DB fan-out on misconfigured or adversarial inputs.
     */
    static readonly ARCHIVED_MULTI_CONTEXT_HARD_CEILING = 50;
    /**
     * Mine messages from a single archived or forked context.
     *
     * - Rejects active or missing contexts with a clear error.
     * - Hard-caps limit at 200.
     * - Defaults excludeHeartbeats to true.
     * - Optionally filters by ftsQuery (client-side substring match for Sprint 3; SQL FTS is deferred).
     * - Routes through getHistoryByDAGWalk for DAG-native retrieval.
     * - Returns ArchivedMiningResult<StoredMessage[]> with isHistorical: true.
     *
     * This method does NOT widen active composition — it only operates on
     * explicitly non-active (archived/forked) contexts.
     */
    mineArchivedContext(query: ArchivedMiningQuery): ArchivedMiningResult<StoredMessage[]>;
    /**
     * Mine messages from multiple archived or forked contexts.
     *
     * ## maxContexts gate (Phase 4 Sprint 3, Task 1)
     * Accepts an optional `maxContexts` in opts to control how many contextIds
     * are accepted in a single call:
     * - Default: ARCHIVED_MULTI_CONTEXT_DEFAULT_MAX (20).
     * - Hard ceiling: ARCHIVED_MULTI_CONTEXT_HARD_CEILING (50).
     * - A caller-supplied value above the hard ceiling is clamped to the ceiling
     *   (not rejected), so callers need not know the exact constant.
     * - A caller-supplied value at or below the ceiling is used as-is.
     * - If contextIds.length exceeds the effective max, this method THROWS
     *   immediately — it does NOT soft-skip or truncate.
     *
     * ## Other behaviors (unchanged from Sprint 2)
     * - Soft-skips active or missing contextIds with a warning (does not throw).
     * - Preserves input order in the result array.
     * - Applies per-context limit and same filters as mineArchivedContext.
     * - Returns one ArchivedMiningResult per valid archived context.
     *
     * This method does NOT widen active composition — it only operates on
     * explicitly non-active (archived/forked) contexts.
     */
    mineArchivedContexts(contextIds: number[], opts?: MultiContextMiningOptions): ArchivedMiningResult<StoredMessage[]>[];
    /**
     * Infer channel type from session key format.
     */
    private inferChannelType;
}
//# sourceMappingURL=message-store.d.ts.map