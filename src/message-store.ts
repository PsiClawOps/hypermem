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
} from './types.js';
import { getOrCreateActiveContext, updateContextHead, getArchivedContext } from './context-store.js';

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
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results, metadata, token_count, message_index, is_heartbeat, created_at, context_id, parent_id, depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      depth
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
      sql += " AND text_content IS NOT NULL AND text_content != ''";
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
