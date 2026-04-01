/**
 * HyperMem Compositor
 *
 * Assembles context for LLM calls by reading Redis slots and falling back to SQLite.
 * Token-budgeted: never exceeds the budget, prioritizes by configured order.
 * Provider-neutral internally, translates at the output boundary.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  ComposeRequest,
  ComposeResult,
  SlotTokenCounts,
  NeutralMessage,
  StoredMessage,
  CompositorConfig,
  SessionMeta,
} from './types.js';
import { RedisLayer } from './redis.js';
import { MessageStore } from './message-store.js';
import { toProviderFormat } from './provider-translator.js';

const DEFAULT_CONFIG: CompositorConfig = {
  defaultTokenBudget: 100000,
  maxHistoryMessages: 50,
  maxFacts: 20,
  maxCrossSessionContext: 5000,
  priorityOrder: ['system', 'identity', 'history', 'facts', 'context', 'library'],
};

/**
 * Rough token estimation: ~4 chars per token for English text.
 * This is a heuristic — actual tokenization varies by model.
 * Good enough for budget management; exact count comes from the provider.
 */
function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg: NeutralMessage): number {
  let tokens = estimateTokens(msg.textContent);
  if (msg.toolCalls) {
    tokens += estimateTokens(JSON.stringify(msg.toolCalls));
  }
  if (msg.toolResults) {
    tokens += estimateTokens(JSON.stringify(msg.toolResults));
  }
  // Overhead per message (role, formatting)
  tokens += 4;
  return tokens;
}

export class Compositor {
  private readonly config: CompositorConfig;
  private readonly redis: RedisLayer;

  constructor(
    redis: RedisLayer,
    config?: Partial<CompositorConfig>
  ) {
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Compose a complete message array for sending to an LLM.
   *
   * Priority order determines which slots get budget first.
   * If budget is exhausted, lower-priority slots are truncated or omitted.
   */
  async compose(request: ComposeRequest, db: DatabaseSync, libraryDb?: DatabaseSync): Promise<ComposeResult> {
    const store = new MessageStore(db);
    const budget = request.tokenBudget || this.config.defaultTokenBudget;
    let remaining = budget;
    const warnings: string[] = [];
    const slots: SlotTokenCounts = {
      system: 0,
      identity: 0,
      history: 0,
      facts: 0,
      context: 0,
      library: 0,
    };

    const messages: NeutralMessage[] = [];

    // ─── System Prompt (never truncated) ───────────────────────
    const systemContent = await this.getSlotContent(
      request.agentId,
      request.sessionKey,
      'system',
      db
    );

    if (systemContent) {
      const tokens = estimateTokens(systemContent);
      messages.push({
        role: 'system',
        textContent: systemContent,
        toolCalls: null,
        toolResults: null,
      });
      slots.system = tokens;
      remaining -= tokens;
    }

    // ─── Identity (never truncated) ────────────────────────────
    const identityContent = await this.getSlotContent(
      request.agentId,
      request.sessionKey,
      'identity',
      db
    );

    if (identityContent) {
      const tokens = estimateTokens(identityContent);
      messages.push({
        role: 'system',
        textContent: identityContent,
        toolCalls: null,
        toolResults: null,
      });
      slots.identity = tokens;
      remaining -= tokens;
    }

    // ─── Conversation History ──────────────────────────────────
    if (request.includeHistory !== false) {
      const historyMessages = await this.getHistory(
        request.agentId,
        request.sessionKey,
        request.historyDepth || this.config.maxHistoryMessages,
        store
      );

      let historyTokens = 0;
      const includedHistory: NeutralMessage[] = [];

      // Include from most recent, working backwards
      for (let i = historyMessages.length - 1; i >= 0; i--) {
        const msg = historyMessages[i];
        const msgTokens = estimateMessageTokens(msg);

        if (historyTokens + msgTokens > remaining) {
          warnings.push(`History truncated at message ${i + 1}/${historyMessages.length}`);
          break;
        }

        includedHistory.unshift(msg); // prepend to maintain order
        historyTokens += msgTokens;
      }

      messages.push(...includedHistory);
      slots.history = historyTokens;
      remaining -= historyTokens;
    }

    // ─── Facts ─────────────────────────────────────────────────
    if (request.includeFacts !== false && remaining > 500) {
      const factsContent = await this.getSlotContent(
        request.agentId,
        request.sessionKey,
        'facts',
        db,
        libraryDb
      );

      if (factsContent) {
        const tokens = estimateTokens(factsContent);
        if (tokens <= remaining) {
          // Inject facts as a system message before history
          const factsMsg: NeutralMessage = {
            role: 'system',
            textContent: `## Relevant Facts\n${factsContent}`,
            toolCalls: null,
            toolResults: null,
          };
          // Insert after identity, before history
          const insertIdx = messages.findIndex(m => m.role !== 'system') || messages.length;
          messages.splice(insertIdx, 0, factsMsg);
          slots.facts = tokens;
          remaining -= tokens;
        } else {
          warnings.push('Facts truncated due to budget');
        }
      }
    }

    // ─── Cross-Session Context ─────────────────────────────────
    if (request.includeContext !== false && remaining > 500) {
      const contextContent = await this.getSlotContent(
        request.agentId,
        request.sessionKey,
        'context',
        db,
        libraryDb
      );

      if (contextContent) {
        const tokens = estimateTokens(contextContent);
        if (tokens <= remaining) {
          const contextMsg: NeutralMessage = {
            role: 'system',
            textContent: `## Cross-Session Context\n${contextContent}`,
            toolCalls: null,
            toolResults: null,
          };
          const insertIdx = messages.findIndex(m => m.role !== 'system') || messages.length;
          messages.splice(insertIdx, 0, contextMsg);
          slots.context = tokens;
          remaining -= tokens;
        } else {
          warnings.push('Cross-session context omitted due to budget');
        }
      }
    }

    // ─── Library ───────────────────────────────────────────────
    // TODO: Phase 3 — library slot warming and inclusion

    // ─── Translate to provider format ──────────────────────────
    const providerMessages = toProviderFormat(messages, request.provider);

    const totalTokens = budget - remaining;

    return {
      messages: providerMessages,
      tokenCount: totalTokens,
      slots,
      truncated: remaining < 0 || warnings.length > 0,
      warnings,
    };
  }

  /**
   * Warm a session from SQLite into Redis.
   * Called on session start or Redis cache miss.
   */
  async warmSession(
    agentId: string,
    sessionKey: string,
    db: DatabaseSync,
    opts?: {
      systemPrompt?: string;
      identity?: string;
      libraryDb?: DatabaseSync;
    }
  ): Promise<void> {
    const store = new MessageStore(db);
    const conversation = store.getConversation(sessionKey);

    if (!conversation) return; // new session, nothing to warm

    // Get recent history
    const history = store.getRecentMessages(conversation.id, this.config.maxHistoryMessages);

    // Build facts content from SQLite (library DB if available)
    const factsContent = this.buildFactsFromDb(agentId, opts?.libraryDb || db);

    // Build cross-session context
    const contextContent = this.buildCrossSessionContext(agentId, sessionKey, db, opts?.libraryDb);

    // Warm Redis
    await this.redis.warmSession(agentId, sessionKey, {
      system: opts?.systemPrompt,
      identity: opts?.identity,
      history,
      facts: factsContent || undefined,
      context: contextContent || undefined,
      meta: {
        agentId,
        sessionKey,
        provider: conversation.provider,
        model: conversation.model,
        channelType: conversation.channelType,
        tokenCount: conversation.tokenCountIn + conversation.tokenCountOut,
        lastActive: conversation.updatedAt,
        status: conversation.status,
      },
    });
  }

  // ─── Slot Content Resolution ─────────────────────────────────

  /**
   * Get slot content: try Redis first, fall back to SQLite.
   */
  private async getSlotContent(
    agentId: string,
    sessionKey: string,
    slot: string,
    db: DatabaseSync,
    libraryDb?: DatabaseSync
  ): Promise<string | null> {
    // Try Redis
    const cached = await this.redis.getSlot(agentId, sessionKey, slot);
    if (cached) return cached;

    // Fall back to SQLite based on slot type
    switch (slot) {
      case 'facts':
        return this.buildFactsFromDb(agentId, libraryDb || db);
      case 'context':
        return this.buildCrossSessionContext(agentId, sessionKey, db, libraryDb);
      default:
        return null; // system and identity are set externally
    }
  }

  /**
   * Get conversation history: try Redis first, fall back to SQLite.
   */
  private async getHistory(
    agentId: string,
    sessionKey: string,
    limit: number,
    store: MessageStore
  ): Promise<NeutralMessage[]> {
    // Try Redis
    const cached = await this.redis.getHistory(agentId, sessionKey);
    if (cached.length > 0) return cached;

    // Fall back to SQLite
    const conversation = store.getConversation(sessionKey);
    if (!conversation) return [];

    return store.getRecentMessages(conversation.id, limit);
  }

  // ─── SQLite Fallback Builders ────────────────────────────────

  /**
   * Build facts content from SQLite.
   */
  private buildFactsFromDb(agentId: string, db: DatabaseSync): string | null {
    // Check if facts table exists in this DB (library DB in new arch, agent DB in old)
    const tableExists = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='facts'"
    ).get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) return null;

    const rows = db.prepare(`
      SELECT content, domain, confidence FROM facts
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      AND decay_score < 0.8
      ORDER BY confidence DESC, decay_score ASC
      LIMIT ?
    `).all(agentId, this.config.maxFacts) as Array<{
      content: string;
      domain: string | null;
      confidence: number;
    }>;

    if (rows.length === 0) return null;

    return rows
      .map(r => `- [${r.domain || 'general'}] ${r.content}`)
      .join('\n');
  }

  /**
   * Build cross-session context by finding recent activity
   * in other sessions on matching topics.
   */
  private buildCrossSessionContext(
    agentId: string,
    currentSessionKey: string,
    db: DatabaseSync,
    _libraryDb?: DatabaseSync
  ): string | null {
    // Get the current conversation
    const conversation = db.prepare(
      'SELECT id FROM conversations WHERE session_key = ?'
    ).get(currentSessionKey) as { id: number } | undefined;

    if (!conversation) return null;

    // Find recent messages from OTHER conversations for this agent
    // (cross-session context without topic_messages — just recent other-session activity)
    const rows = db.prepare(`
      SELECT m.text_content, m.role, c.channel_type, m.created_at
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.agent_id = ?
      AND m.conversation_id != ?
      AND m.text_content IS NOT NULL
      AND m.is_heartbeat = 0
      ORDER BY m.created_at DESC
      LIMIT 10
    `).all(
      agentId,
      conversation.id
    ) as Array<{
      text_content: string;
      role: string;
      channel_type: string;
      created_at: string;
    }>;

    if (rows.length === 0) return null;

    // Summarize cross-session context
    const lines = rows.map(r => {
      const preview = r.text_content.substring(0, 200);
      return `- [${r.channel_type}/${r.role} @ ${r.created_at}] ${preview}`;
    });

    return lines.join('\n');
  }
}
