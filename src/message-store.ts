/**
 * hypermem Message Store
 *
 * CRUD operations for conversations and messages in SQLite.
 * All messages are stored in provider-neutral format.
 * This is the write-through layer: Redis → here.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  NeutralMessage,
  StoredMessage,
  Conversation,
  ChannelType,
  ConversationStatus,
  RecentTurn,
  ArchivedMiningQuery,
  ArchivedMiningResult,
  MultiContextMiningOptions,
  HistoryQuery,
  HistoryQueryResult,
  HistoryQueryMessage,
  HistoryQueryMode,
} from './types.js';
import { getOrCreateActiveContext, updateContextHead, getArchivedContext, getActiveContext, getContextById } from './context-store.js';

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parse a stored message row from SQLite into a StoredMessage object.
 */
function parseMessageRow(row: Record<string, unknown>): StoredMessage {
  return {
    id: row.id as number,
    conversationId: row.conversation_id as number,
    agentId: row.agent_id as string,
    role: row.role as StoredMessage['role'],
    textContent: (row.text_content as string) || null,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : null,
    toolResults: row.tool_results ? JSON.parse(row.tool_results as string) : null,
    topicId: typeof row.topic_id === 'string' && row.topic_id.length > 0
      ? row.topic_id
      : undefined,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
    messageIndex: row.message_index as number,
    tokenCount: (row.token_count as number) || null,
    isHeartbeat: (row.is_heartbeat as number) === 1,
    createdAt: row.created_at as string,
  };
}

function parseConversationRow(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as number,
    sessionKey: row.session_key as string,
    sessionId: (row.session_id as string) || null,
    agentId: row.agent_id as string,
    channelType: row.channel_type as ChannelType,
    channelId: (row.channel_id as string) || null,
    provider: (row.provider as string) || null,
    model: (row.model as string) || null,
    status: row.status as ConversationStatus,
    messageCount: row.message_count as number,
    tokenCountIn: row.token_count_in as number,
    tokenCountOut: row.token_count_out as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    endedAt: (row.ended_at as string) || null,
  };
}

export class MessageStore {
  constructor(private readonly db: DatabaseSync) {}

  // ─── Conversation Operations ─────────────────────────────────

  /**
   * Get or create a conversation for a session.
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
    const existing = this.db
      .prepare('SELECT * FROM conversations WHERE session_key = ?')
      .get(sessionKey) as Record<string, unknown> | undefined;

    if (existing) {
      return parseConversationRow(existing);
    }

    const now = nowIso();
    const channelType = opts?.channelType || this.inferChannelType(sessionKey);

    const result = this.db.prepare(`
      INSERT INTO conversations (session_key, agent_id, channel_type, channel_id, provider, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionKey,
      agentId,
      channelType,
      opts?.channelId || null,
      opts?.provider || null,
      opts?.model || null,
      now,
      now
    );

    // node:sqlite returns { changes, lastInsertRowid }
    const id = (result as unknown as { lastInsertRowid: number }).lastInsertRowid;

    // Ensure an active context exists for the new conversation (fire-and-forget side effect)
    getOrCreateActiveContext(this.db, agentId, sessionKey, id);

    return {
      id,
      sessionKey,
      sessionId: null,
      agentId,
      channelType,
      channelId: opts?.channelId || null,
      provider: opts?.provider || null,
      model: opts?.model || null,
      status: 'active',
      messageCount: 0,
      tokenCountIn: 0,
      tokenCountOut: 0,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
  }

  /**
   * Get a conversation by session key.
   */
  getConversation(sessionKey: string): Conversation | null {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE session_key = ?')
      .get(sessionKey) as Record<string, unknown> | undefined;

    return row ? parseConversationRow(row) : null;
  }

  /**
   * Get all conversations for an agent, optionally filtered.
   */
  getConversations(
    agentId: string,
    opts?: {
      status?: ConversationStatus;
      channelType?: ChannelType;
      limit?: number;
    }
  ): Conversation[] {
    let sql = 'SELECT * FROM conversations WHERE agent_id = ?';
    const params: (string | number | null)[] = [agentId];

    if (opts?.status) {
      sql += ' AND status = ?';
      params.push(opts.status);
    }
    if (opts?.channelType) {
      sql += ' AND channel_type = ?';
      params.push(opts.channelType);
    }

    sql += ' ORDER BY updated_at DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseConversationRow);
  }

  /**
   * Update conversation metadata.
   */
  updateConversation(conversationId: number, updates: {
    provider?: string;
    model?: string;
    status?: ConversationStatus;
    endedAt?: string;
  }): void {
    const sets: string[] = ['updated_at = ?'];
    const params: (string | number | null)[] = [nowIso()];

    if (updates.provider !== undefined) {
      sets.push('provider = ?');
      params.push(updates.provider);
    }
    if (updates.model !== undefined) {
      sets.push('model = ?');
      params.push(updates.model);
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
    }
    if (updates.endedAt !== undefined) {
      sets.push('ended_at = ?');
      params.push(updates.endedAt);
    }

    params.push(conversationId);
    this.db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  // ─── Message Operations ──────────────────────────────────────

  /**
   * Record a message to the database.
   * Returns the stored message with its assigned ID.
   *
   * Phase 2 (Turn DAG): automatically sets parent_id and depth.
   *   - parent_id = context.head_message_id (the previous message on this branch)
   *   - depth = parent.depth + 1 (or 0 if first message)
   */
  recordMessage(
    conversationId: number,
    agentId: string,
    message: NeutralMessage,
    opts?: {
      tokenCount?: number;
      isHeartbeat?: boolean;
      contextId?: number;
    }
  ): StoredMessage {
    const now = nowIso();

    // Get next message index
    const lastRow = this.db
      .prepare('SELECT MAX(message_index) AS max_idx FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { max_idx: number | null } | undefined;

    const messageIndex = (lastRow?.max_idx ?? -1) + 1;

    // Phase 2 (Turn DAG): resolve parent_id and depth from context head
    let parentId: number | null = null;
    let depth = 0;
    if (opts?.contextId) {
      const headRow = this.db
        .prepare('SELECT head_message_id FROM contexts WHERE id = ?')
        .get(opts.contextId) as { head_message_id: number | null } | undefined;

      if (headRow?.head_message_id != null) {
        parentId = headRow.head_message_id;
        const parentDepthRow = this.db
          .prepare('SELECT depth FROM messages WHERE id = ?')
          .get(parentId) as { depth: number } | undefined;
        depth = (parentDepthRow?.depth ?? -1) + 1;
      }
    }

    const result = this.db.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results, metadata, token_count, message_index, is_heartbeat, created_at, context_id, parent_id, depth, topic_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      conversationId,
      agentId,
      message.role,
      message.textContent,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolResults ? JSON.stringify(message.toolResults) : null,
      message.metadata ? JSON.stringify(message.metadata) : null,
      opts?.tokenCount || null,
      messageIndex,
      opts?.isHeartbeat ? 1 : 0,
      now,
      opts?.contextId ?? null,
      parentId,
      depth,
      message.topicId ?? null
    );

    const id = (result as unknown as { lastInsertRowid: number }).lastInsertRowid;

    // Update context head pointer if contextId was provided
    if (opts?.contextId) {
      updateContextHead(this.db, opts.contextId, Number(id));
    }

    // Update conversation counters
    const tokenDelta = opts?.tokenCount || 0;
    const isOutput = message.role === 'assistant';

    this.db.prepare(`
      UPDATE conversations
      SET message_count = message_count + 1,
          token_count_in = token_count_in + ?,
          token_count_out = token_count_out + ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      isOutput ? 0 : tokenDelta,
      isOutput ? tokenDelta : 0,
      now,
      conversationId
    );

    return {
      id,
      conversationId,
      agentId,
      role: message.role,
      textContent: message.textContent,
      toolCalls: message.toolCalls,
      toolResults: message.toolResults,
      topicId: message.topicId,
      metadata: message.metadata,
      messageIndex,
      tokenCount: opts?.tokenCount || null,
      isHeartbeat: opts?.isHeartbeat || false,
      createdAt: now,
    };
  }

  /**
   * Get recent messages for a conversation.
   */
  getRecentMessages(conversationId: number, limit: number = 50, minMessageId?: number): StoredMessage[] {
    const params: (string | number | null)[] = [conversationId];
    let sql = 'SELECT * FROM messages WHERE conversation_id = ?';
    if (minMessageId != null) {
      sql += ' AND id >= ?';
      params.push(minMessageId);
    }
    sql += ' ORDER BY message_index DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];

    // Reverse to get chronological order
    return rows.reverse().map(parseMessageRow);
  }

  /**
   * Get recent human-readable transcript messages for continuity guards.
   *
   * Tool-call/tool-result carrier rows are valid runtime messages, but they often
   * have empty text_content. They must not consume the small "recent turns" depth
   * used by transcript recovery and fork warming, or a dense tool loop can push
   * the immediate conversational antecedent out of the selected window.
   */
  getRecentMeaningfulMessages(conversationId: number, limit: number = 12, minMessageId?: number): StoredMessage[] {
    const params: (string | number | null)[] = [conversationId];
    let sql = `
      SELECT
        id,
        conversation_id,
        agent_id,
        role,
        text_content,
        NULL AS tool_calls,
        NULL AS tool_results,
        metadata,
        token_count,
        message_index,
        is_heartbeat,
        created_at,
        topic_id
      FROM messages
      WHERE conversation_id = ?
        AND role IN ('user', 'assistant')
        AND text_content IS NOT NULL
        AND trim(text_content) != ''
        AND is_heartbeat = 0
    `;
    if (minMessageId != null) {
      sql += ' AND id >= ?';
      params.push(minMessageId);
    }
    sql += ' ORDER BY message_index DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.reverse().map(parseMessageRow);
  }

  /**
   * Get recent messages scoped to a topic (P3.4, Option B).
   * Returns messages matching the topic_id OR with topic_id IS NULL
   * (legacy messages created before topic tracking was introduced).
   * This is transition-safe: no legacy messages are silently dropped.
   */
  getRecentMessagesByTopic(conversationId: number, topicId: string, limit: number = 50, minMessageId?: number): StoredMessage[] {
    const params: (string | number | null)[] = [conversationId, topicId];
    let sql = 'SELECT * FROM messages WHERE conversation_id = ? AND (topic_id = ? OR topic_id IS NULL)';
    if (minMessageId != null) {
      sql += ' AND id >= ?';
      params.push(minMessageId);
    }
    sql += ' ORDER BY message_index DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];

    // Reverse to get chronological order
    return rows.reverse().map(parseMessageRow);
  }

  /**
   * Get messages across all conversations for an agent (cross-session query).
   */
  getAgentMessages(
    agentId: string,
    opts?: {
      since?: string;        // ISO timestamp
      limit?: number;
      excludeHeartbeats?: boolean;
    }
  ): StoredMessage[] {
    let sql = 'SELECT * FROM messages WHERE agent_id = ?';
    const params: (string | number | null)[] = [agentId];

    if (opts?.since) {
      sql += ' AND created_at > ?';
      params.push(opts.since);
    }
    if (opts?.excludeHeartbeats) {
      sql += ' AND is_heartbeat = 0';
    }

    sql += ' ORDER BY created_at DESC';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseMessageRow);
  }

  /**
   * Full-text search across all messages for an agent.
   */
  searchMessages(agentId: string, query: string, limit: number = 20): StoredMessage[] {
    // Per-agent DB contains only one agent's data, so agent_id filter is
    // redundant and catastrophically slows FTS (forces full result scan +
    // join before LIMIT). Omitted by design — see bench/data-access-bench.mjs.
    // Two-phase query: FTS subquery runs first (fast LIMIT inside FTS),
    // then join the small result set for metadata retrieval.
    // Direct JOIN + WHERE MATCH + ORDER BY rank + LIMIT forces SQLite to
    // materialize the full FTS join before applying LIMIT — catastrophic
    // on large message DBs. See: specs/HYPERMEM_INCIDENT_HISTORY.md Incident 3.
    const rows = this.db.prepare(`
      WITH fts_matches AS (
        SELECT rowid, rank FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?
      )
      SELECT m.* FROM messages m JOIN fts_matches ON m.id = fts_matches.rowid ORDER BY fts_matches.rank
    `).all(query, limit) as Record<string, unknown>[];

    return rows.map(parseMessageRow);
  }

  /**
   * Get recent turns for a session, in chronological order, with tool calls stripped.
   * Joins messages through conversations to find by session_key.
   * Returns up to `n` turns (capped at 50).
   */
  getRecentTurns(sessionKey: string, n: number): RecentTurn[] {
    const limit = Math.min(n, 50);
    try {
      const rows = this.db.prepare(`
        SELECT m.role, m.text_content, m.created_at, m.message_index
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        WHERE c.session_key = ?
          AND m.role IN ('user', 'assistant')
          AND m.text_content IS NOT NULL
          AND trim(m.text_content) != ''
          AND m.is_heartbeat = 0
        ORDER BY m.message_index DESC
        LIMIT ?
      `).all(sessionKey, limit) as Array<Record<string, unknown>>;

      // Reverse to chronological order
      rows.reverse();

      return rows.map(row => ({
        role: row.role as 'user' | 'assistant',
        // text_content only — tool calls are stored separately and excluded here
        content: (row.text_content as string | null) ?? '',
        timestamp: row.created_at
          ? new Date(row.created_at as string).getTime()
          : Date.now(),
        seq: row.message_index as number,
      }));
    } catch (err) {
      console.warn('[hypermem:message-store] getRecentTurns failed:', (err as Error).message);
      return [];
    }
  }

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
  getHistoryByDAGWalk(headMessageId: number, limit: number = 50): StoredMessage[] {
    try {
      // Use recursive CTE to walk backward from head
      const rows = this.db.prepare(`
        WITH RECURSIVE chain AS (
          SELECT id, parent_id, depth, conversation_id, agent_id, role,
                 text_content, tool_calls, tool_results, metadata,
                 message_index, token_count, is_heartbeat, created_at,
                 1 AS chain_pos
          FROM messages
          WHERE id = ?

          UNION ALL

          SELECT m.id, m.parent_id, m.depth, m.conversation_id, m.agent_id, m.role,
                 m.text_content, m.tool_calls, m.tool_results, m.metadata,
                 m.message_index, m.token_count, m.is_heartbeat, m.created_at,
                 c.chain_pos + 1
          FROM messages m
          JOIN chain c ON m.id = c.parent_id
          WHERE c.chain_pos < ?
        )
        SELECT * FROM chain ORDER BY depth ASC, message_index ASC
      `).all(headMessageId, limit) as Record<string, unknown>[];

      if (rows.length === 0) return [];
      return rows.map(parseMessageRow);
    } catch {
      // DAG walk failed (e.g., no parent chain) — return empty, caller should fall back
      return [];
    }
  }

  /**
   * Get messages scoped to a specific context_id.
   * Used by keystone/FTS/topic recall to constrain results to the active branch.
   */
  getMessagesByContextId(
    contextId: number,
    limit: number = 200,
    opts?: { excludeHeartbeats?: boolean; requireText?: boolean }
  ): StoredMessage[] {
    let sql = 'SELECT * FROM messages WHERE context_id = ?';
    const params: (string | number | null)[] = [contextId];

    if (opts?.excludeHeartbeats) {
      sql += ' AND is_heartbeat = 0';
    }
    if (opts?.requireText) {
      sql += " AND role IN ('user', 'assistant') AND text_content IS NOT NULL AND trim(text_content) != ''";
    }

    sql += ' ORDER BY message_index DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.reverse().map(parseMessageRow);
  }

  /**
   * Full-text search constrained to a specific context_id.
   * Phase 3: replaces unscoped searchMessages for composition paths.
   */
  searchMessagesByContextId(
    contextId: number,
    query: string,
    limit: number = 20
  ): StoredMessage[] {
    try {
      const rows = this.db.prepare(`
        WITH fts_matches AS (
          SELECT rowid, rank FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?
        )
        SELECT m.* FROM messages m
        JOIN fts_matches ON m.id = fts_matches.rowid
        WHERE m.context_id = ?
          AND m.role IN ('user', 'assistant')
          AND m.text_content IS NOT NULL
          AND trim(m.text_content) != ''
          AND m.is_heartbeat = 0
        ORDER BY fts_matches.rank
      `).all(query, limit * 3, contextId) as Record<string, unknown>[];

      return rows.slice(0, limit).map(parseMessageRow);
    } catch {
      return [];
    }
  }

  /**
   * Get message count for a conversation.
   */
  getMessageCount(conversationId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?')
      .get(conversationId) as { count: number };
    return row.count;
  }

  /**
   * Get the full message chain for an archived or forked context.
   *
   * Throws if the context does not exist or is active (not archived/forked).
   * Returns an empty array if the context has no head message.
   * Delegates to getHistoryByDAGWalk for the actual chain retrieval.
   */
  getArchivedChain(contextId: number, limit?: number): StoredMessage[] {
    const context = getArchivedContext(this.db, contextId);

    if (!context) {
      throw new Error('getArchivedChain: context must be archived or forked');
    }

    if (context.headMessageId === null) {
      return [];
    }

    return this.getHistoryByDAGWalk(context.headMessageId, limit ?? 200);
  }

  // ─── Archived Mining (Phase 4 Sprint 2 / Sprint 3) ─────────────

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

  // ─── Archived Mining (Phase 4 Sprint 2) ───────────────────────

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
  mineArchivedContext(query: ArchivedMiningQuery): ArchivedMiningResult<StoredMessage[]> {
    const { contextId, limit, excludeHeartbeats = true, ftsQuery } = query;

    const context = getArchivedContext(this.db, contextId);
    if (!context) {
      throw new Error(
        `mineArchivedContext: context ${contextId} does not exist or is not archived/forked. ` +
        `Only archived or forked contexts may be mined.`
      );
    }

    // Hard cap at 200
    const effectiveLimit = Math.min(limit ?? 200, 200);

    let messages: StoredMessage[] = [];

    if (context.headMessageId !== null) {
      messages = this.getHistoryByDAGWalk(context.headMessageId, effectiveLimit);
    }

    // Apply heartbeat filter (default: exclude)
    if (excludeHeartbeats) {
      messages = messages.filter(m => !m.isHeartbeat);
    }

    // Client-side ftsQuery filter (substring match for Sprint 2)
    if (ftsQuery && ftsQuery.trim().length > 0) {
      const q = ftsQuery.trim().toLowerCase();
      messages = messages.filter(m =>
        (m.textContent ?? '').toLowerCase().includes(q)
      );
    }

    return {
      isHistorical: true,
      contextId: context.id,
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      contextStatus: context.status as 'archived' | 'forked',
      contextUpdatedAt: context.updatedAt,
      data: messages,
    };
  }

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
  mineArchivedContexts(
    contextIds: number[],
    opts?: MultiContextMiningOptions
  ): ArchivedMiningResult<StoredMessage[]>[] {
    // ── maxContexts gate ──────────────────────────────────────────────────
    const { maxContexts: callerMax, ...perContextOpts } = opts ?? {};
    const effectiveMax = callerMax !== undefined
      ? Math.min(callerMax, MessageStore.ARCHIVED_MULTI_CONTEXT_HARD_CEILING)
      : MessageStore.ARCHIVED_MULTI_CONTEXT_DEFAULT_MAX;

    if (contextIds.length > effectiveMax) {
      throw new Error(
        `mineArchivedContexts: too many contextIds (${contextIds.length}). ` +
        `Effective limit is ${effectiveMax} ` +
        `(hard ceiling: ${MessageStore.ARCHIVED_MULTI_CONTEXT_HARD_CEILING}, ` +
        `default: ${MessageStore.ARCHIVED_MULTI_CONTEXT_DEFAULT_MAX}). ` +
        `Pass fewer contextIds or supply a higher maxContexts (max: ${MessageStore.ARCHIVED_MULTI_CONTEXT_HARD_CEILING}).`
      );
    }
    // ── end gate ─────────────────────────────────────────────────────────

    const results: ArchivedMiningResult<StoredMessage[]>[] = [];

    for (const contextId of contextIds) {
      const context = getArchivedContext(this.db, contextId);
      if (!context) {
        console.warn(
          `[hypermem:message-store] mineArchivedContexts: skipping contextId ${contextId} ` +
          `— does not exist or is not archived/forked (may be active or missing).`
        );
        continue;
      }

      try {
        results.push(this.mineArchivedContext({ contextId, ...perContextOpts }));
      } catch (err) {
        console.warn(
          `[hypermem:message-store] mineArchivedContexts: skipping contextId ${contextId} ` +
          `— ${(err as Error).message}`
        );
      }
    }

    return results;
  }


  // ─── History Query Surface (0.9.4) ─────────────────────────────────────────

  /**
   * Per-mode hard caps and default limits for queryHistory.
   * No mode may return more than its hard cap regardless of what the caller requests.
   */
  static readonly HISTORY_QUERY_CAPS: Record<HistoryQueryMode, { defaultLimit: number; hardCap: number }> = {
    runtime_chain:   { defaultLimit: 80,  hardCap: 200 },
    transcript_tail: { defaultLimit: 40,  hardCap: 120 },
    tool_events:     { defaultLimit: 40,  hardCap: 120 },
    by_topic:        { defaultLimit: 60,  hardCap: 160 },
    by_context:      { defaultLimit: 80,  hardCap: 200 },
    cross_session:   { defaultLimit: 20,  hardCap: 80  },
  };

  /**
   * Apply per-mode hard caps to a caller-supplied limit.
   * Returns [effectiveLimit, wasClamped].
   *
   * SQLite treats LIMIT -1 as unlimited, so never pass caller input through
   * directly. Non-finite, zero, and negative limits fall back to the default.
   */
  private capHistoryLimit(mode: HistoryQueryMode, requestedLimit?: number): [number, boolean] {
    const caps = MessageStore.HISTORY_QUERY_CAPS[mode];
    if (requestedLimit == null) {
      return [caps.defaultLimit, false];
    }

    if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
      return [caps.defaultLimit, true];
    }

    const requested = Math.floor(requestedLimit);
    const effective = Math.min(requested, caps.hardCap);
    return [effective, effective < requested];
  }

  /**
   * Resolve conversation id from either a provided conversationId or a sessionKey lookup.
   * Returns null when neither is available or the conversation cannot be found.
   */
  private resolveConversationScope(query: HistoryQuery): number | null {
    const conv = query.conversationId != null
      ? this.getConversationById(query.conversationId)
      : query.sessionKey
        ? this.getConversation(query.sessionKey)
        : null;

    if (!conv) return null;
    if (conv.agentId !== query.agentId) {
      throw new Error(`queryHistory: conversation ${conv.id} is not owned by agent '${query.agentId}'`);
    }
    return conv.id;
  }

  /**
   * Format a StoredMessage into the HistoryQueryMessage wire shape.
   * contextId is passed explicitly when available from the query context.
   */
  private formatHistoryMessage(
    msg: StoredMessage,
    contextId?: number | null,
  ): HistoryQueryMessage {
    return {
      id: msg.id,
      role: msg.role,
      textContent: msg.textContent,
      toolCalls: msg.toolCalls,
      toolResults: msg.toolResults,
      messageIndex: msg.messageIndex,
      createdAt: msg.createdAt,
      topicId: msg.topicId ?? null,
      contextId: contextId ?? null,
    };
  }

  /**
   * Redact tool payloads for tool_events mode when includeToolPayloads is false (default).
   *
   * Redaction replaces raw arguments/content with metadata-only stubs.
   * This prevents accidental leakage of secrets or large payloads.
   */
  private redactToolEvents(messages: HistoryQueryMessage[]): HistoryQueryMessage[] {
    return messages.map(msg => {
      const redactedCalls = Array.isArray(msg.toolCalls)
        ? (msg.toolCalls as Array<{ id?: unknown; name?: unknown; arguments?: unknown }>).map(tc => ({
            id: tc.id,
            name: tc.name,
            arguments: '[redacted]',
          }))
        : msg.toolCalls;

      const redactedResults = Array.isArray(msg.toolResults)
        ? (msg.toolResults as Array<{ callId?: unknown; name?: unknown; content?: unknown; isError?: unknown }>).map(tr => ({
            callId: tr.callId,
            name: tr.name,
            content: '[redacted]',
            isError: tr.isError,
          }))
        : msg.toolResults;

      return { ...msg, toolCalls: redactedCalls, toolResults: redactedResults };
    });
  }

  /**
   * Unified read-only message history query surface (HyperMem 0.9.4).
   *
   * Routes to a mode-specific safe SQL path. No general SQL execution.
   * All modes are capped, parameterized, and compaction-fence-aware where applicable.
   *
   * Modes:
   *   runtime_chain   — full runtime rows (tool-bearing) via DAG chain or recency.
   *   transcript_tail — nonblank user/assistant text rows only (tool fields null).
   *   tool_events     — rows with tool calls or results; payloads redacted by default.
   *   by_topic        — runtime rows scoped to one topic.
   *   by_context      — runtime rows scoped to one context; active default, archived/forked with includeArchived.
   *   cross_session   — transcript rows across all conversations for one agent; per-conversation fence enforced.
   */
  queryHistory(query: HistoryQuery): HistoryQueryResult {
    const { agentId, mode } = query;

    // Validate allowed modes first — prevent action-passthrough / unknown mode injection
    const ALLOWED_MODES: ReadonlySet<string> = new Set([
      'runtime_chain', 'transcript_tail', 'tool_events',
      'by_topic', 'by_context', 'cross_session',
    ]);
    if (!ALLOWED_MODES.has(mode)) {
      throw new Error(`queryHistory: unknown mode '${mode}'. Allowed: ${[...ALLOWED_MODES].join(', ')}`);
    }

    const [limit, wasClamped] = this.capHistoryLimit(mode, query.limit);

    // ─ runtime_chain ───────────────────────────────────────────────────────────────
    if (mode === 'runtime_chain') {
      const conversationId = this.resolveConversationScope(query);
      if (conversationId == null) {
        throw new Error('queryHistory(runtime_chain): requires sessionKey or conversationId');
      }

      // Prefer active context DAG chain
      let messages: StoredMessage[] = [];
      const resolvedSessionKey = query.sessionKey ?? this.getConversationById(conversationId)?.sessionKey;
      if (resolvedSessionKey) {
        const ctx = getActiveContext(this.db, agentId, resolvedSessionKey);
        if (ctx?.headMessageId != null) {
          messages = this.getHistoryByDAGWalk(ctx.headMessageId, limit);
        }
      }

      // Fallback to recency when DAG walk returns nothing
      if (messages.length === 0) {
        messages = this.getRecentMessages(conversationId, limit, query.minMessageId);
      }

      const truncated = wasClamped || messages.length === limit;
      return {
        mode,
        scopedBy: { agentId, sessionKey: query.sessionKey, conversationId },
        messages: messages.map(m => this.formatHistoryMessage(m)),
        truncated,
        redacted: false,
      };
    }

    // ─ transcript_tail ────────────────────────────────────────────────────────────
    if (mode === 'transcript_tail') {
      const conversationId = this.resolveConversationScope(query);
      if (conversationId == null) {
        throw new Error('queryHistory(transcript_tail): requires sessionKey or conversationId');
      }

      // getRecentMeaningfulMessages already nulls tool_calls / tool_results in its SQL projection
      const messages = this.getRecentMeaningfulMessages(conversationId, limit, query.minMessageId);
      const truncated = wasClamped || messages.length === limit;
      return {
        mode,
        scopedBy: { agentId, sessionKey: query.sessionKey, conversationId },
        messages: messages.map(m => this.formatHistoryMessage(m)),
        truncated,
        redacted: false,
      };
    }

    // ─ tool_events ───────────────────────────────────────────────────────────────
    if (mode === 'tool_events') {
      const conversationId = this.resolveConversationScope(query);
      if (conversationId == null) {
        throw new Error('queryHistory(tool_events): requires sessionKey or conversationId');
      }

      // Parameterized query — only tool-bearing rows
      const rows = this.db.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ?
          AND (tool_calls IS NOT NULL OR tool_results IS NOT NULL)
          AND is_heartbeat = 0
        ORDER BY message_index DESC
        LIMIT ?
      `).all(conversationId, limit) as Record<string, unknown>[];

      let formatted: HistoryQueryMessage[] = rows.reverse().map(row => {
        const msg = parseMessageRow(row);
        return this.formatHistoryMessage(msg);
      });

      const didRedact = !query.includeToolPayloads;
      if (didRedact) {
        formatted = this.redactToolEvents(formatted);
      }

      const truncated = wasClamped || rows.length === limit;
      return {
        mode,
        scopedBy: { agentId, sessionKey: query.sessionKey, conversationId },
        messages: formatted,
        truncated,
        redacted: didRedact,
      };
    }

    // ─ by_topic ───────────────────────────────────────────────────────────────────
    if (mode === 'by_topic') {
      if (!query.topicId) {
        throw new Error('queryHistory(by_topic): requires topicId');
      }
      const conversationId = this.resolveConversationScope(query);
      if (conversationId == null) {
        throw new Error('queryHistory(by_topic): requires sessionKey or conversationId');
      }

      const messages = this.getRecentMessagesByTopic(conversationId, query.topicId, limit, query.minMessageId);
      const truncated = wasClamped || messages.length === limit;
      return {
        mode,
        scopedBy: { agentId, sessionKey: query.sessionKey, conversationId, topicId: query.topicId },
        messages: messages.map(m => this.formatHistoryMessage(m)),
        truncated,
        redacted: false,
      };
    }

    // ─ by_context ──────────────────────────────────────────────────────────────────
    if (mode === 'by_context') {
      if (query.contextId == null) {
        throw new Error('queryHistory(by_context): requires contextId');
      }

      const ctx = getContextById(this.db, query.contextId);
      if (!ctx) {
        throw new Error(`queryHistory(by_context): context ${query.contextId} not found`);
      }
      if (ctx.agentId !== agentId) {
        throw new Error(`queryHistory(by_context): context ${query.contextId} is not owned by agent '${agentId}'`);
      }

      // Active context is always allowed.
      // Archived or forked contexts require explicit opt-in via includeArchived.
      if (ctx.status !== 'active' && !query.includeArchived) {
        throw new Error(
          `queryHistory(by_context): context ${query.contextId} has status '${ctx.status}'. ` +
          `Set includeArchived: true to query non-active contexts.`
        );
      }

      const messages = this.getMessagesByContextId(query.contextId, limit, { excludeHeartbeats: true });
      const truncated = wasClamped || messages.length === limit;
      return {
        mode,
        scopedBy: { agentId, contextId: query.contextId, sessionKey: ctx.sessionKey },
        messages: messages.map(m => this.formatHistoryMessage(m, query.contextId)),
        truncated,
        redacted: false,
      };
    }

    // ─ cross_session ──────────────────────────────────────────────────────────────
    if (mode === 'cross_session') {
      // Do NOT reuse getAgentMessages: it does not enforce per-conversation compaction fences.
      // Each conversation's fence is respected via the LEFT JOIN on compaction_fences.
      // Transcript-only rows: user/assistant with non-empty text. Tool fields projected as NULL.
      const params: (string | number)[] = [agentId];
      let sql = `
        SELECT
          m.id,
          m.conversation_id,
          m.agent_id,
          m.role,
          m.text_content,
          NULL AS tool_calls,
          NULL AS tool_results,
          m.metadata,
          m.token_count,
          m.message_index,
          m.is_heartbeat,
          m.created_at,
          m.topic_id
        FROM messages m
        LEFT JOIN compaction_fences cf ON cf.conversation_id = m.conversation_id
        WHERE m.agent_id = ?
          AND m.role IN ('user', 'assistant')
          AND m.text_content IS NOT NULL
          AND trim(m.text_content) != ''
          AND m.is_heartbeat = 0
          AND (cf.fence_message_id IS NULL OR m.id >= cf.fence_message_id)
      `;

      if (query.since) {
        sql += ' AND m.created_at > ?';
        params.push(query.since);
      }

      sql += ' ORDER BY m.created_at DESC LIMIT ?';
      params.push(limit);

      const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
      // Reverse to chronological order
      rows.reverse();
      const formatted: HistoryQueryMessage[] = rows.map(row => {
        const msg = parseMessageRow(row);
        return this.formatHistoryMessage(msg);
      });

      const truncated = wasClamped || rows.length === limit;
      return {
        mode,
        scopedBy: { agentId },
        messages: formatted,
        truncated,
        redacted: false,
      };
    }

    // Should never reach here — all modes are covered above and the mode is validated at entry
    throw new Error(`queryHistory: unhandled mode '${mode}'`);
  }

  /**
   * Get a conversation by id (internal use by queryHistory).
   */
  private getConversationById(conversationId: number): Conversation | null {
    const row = this.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(conversationId) as Record<string, unknown> | undefined;
    return row ? parseConversationRow(row) : null;
  }

// ─── Helpers ─────────────────────────────────────────────────

  /**
   * Infer channel type from session key format.
   */
  private inferChannelType(sessionKey: string): ChannelType {
    if (sessionKey.includes(':webchat:')) return 'webchat';
    if (sessionKey.includes(':discord:')) return 'discord';
    if (sessionKey.includes(':telegram:')) return 'telegram';
    if (sessionKey.includes(':signal:')) return 'signal';
    if (sessionKey.includes(':subagent:') || sessionKey.includes(':spawn:')) return 'subagent';
    if (sessionKey.includes(':heartbeat')) return 'heartbeat';
    return 'other';
  }
}
