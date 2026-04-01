/**
 * HyperMem Compositor
 *
 * Assembles context for LLM calls by orchestrating all four memory layers:
 *   L1 Redis    — hot session working memory (system, identity, recent msgs)
 *   L2 Messages — conversation history from messages.db
 *   L3 Vectors  — semantic search across all indexed content
 *   L4 Library  — structured knowledge (facts, preferences, knowledge, episodes)
 *
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
import { VectorStore, type VectorSearchResult } from './vector-store.js';
import { DocChunkStore } from './doc-chunk-store.js';
import { hybridSearch, type HybridSearchResult } from './hybrid-retrieval.js';

const DEFAULT_CONFIG: CompositorConfig = {
  defaultTokenBudget: 100000,
  maxHistoryMessages: 50,
  maxFacts: 20,
  maxCrossSessionContext: 5000,
};

// ─── Trigger Registry ────────────────────────────────────────────

/**
 * A trigger definition maps a collection to the conversation signals that
 * indicate it should be queried. When any keyword matches the user's latest
 * message, the compositor fetches relevant chunks from that collection.
 *
 * Centralizing trigger logic here (not in workspace stubs) means:
 * - One update propagates to all agents
 * - Stubs become documentation, not code
 * - Trigger logic can be tested independently
 */
export interface CollectionTrigger {
  /** Collection path: governance/policy, identity/job, etc. */
  collection: string;
  /** Keywords that trigger this collection (case-insensitive) */
  keywords: string[];
  /** Max tokens to inject from this collection */
  maxTokens?: number;
  /** Max chunks to retrieve */
  maxChunks?: number;
}

/**
 * Default trigger registry for standard ACA collections.
 * Covers the core ACA offload use case from Anvil's spec.
 */
export const DEFAULT_TRIGGERS: CollectionTrigger[] = [
  {
    collection: 'governance/policy',
    keywords: [
      'escalat', 'policy', 'decision state', 'green', 'yellow', 'red',
      'council procedure', 'naming', 'mandate', 'compliance', 'governance',
      'override', 'human review', 'irreversible',
    ],
    maxTokens: 1500,
    maxChunks: 3,
  },
  {
    collection: 'governance/charter',
    keywords: [
      'charter', 'mission', 'director', 'org', 'reporting', 'boundary',
      'delegation', 'authority', 'jurisdiction',
    ],
    maxTokens: 1000,
    maxChunks: 2,
  },
  {
    collection: 'governance/comms',
    keywords: [
      'message', 'send', 'tier 1', 'tier 2', 'tier 3', 'async', 'dispatch',
      'sessions_send', 'inter-agent', 'protocol', 'comms', 'ping', 'notify',
    ],
    maxTokens: 800,
    maxChunks: 2,
  },
  {
    collection: 'operations/agents',
    keywords: [
      'boot', 'startup', 'bootstrap', 'heartbeat', 'workqueue', 'checkpoint',
      'session start', 'roll call', 'memory recall', 'dispatch inbox',
    ],
    maxTokens: 800,
    maxChunks: 2,
  },
  {
    collection: 'identity/job',
    keywords: [
      'deliberat', 'council round', 'vote', 'response contract', 'rating',
      'first response', 'second response', 'handoff', 'floor open',
      'performance', 'output discipline', 'assessment',
    ],
    maxTokens: 1200,
    maxChunks: 3,
  },
  {
    collection: 'identity/motivations',
    keywords: [
      'motivation', 'fear', 'tension', 'why do you', 'how do you feel',
      'drives', 'values',
    ],
    maxTokens: 600,
    maxChunks: 1,
  },
  {
    collection: 'memory/decisions',
    keywords: [
      'remember', 'decision', 'we decided', 'previously', 'last time',
      'history', 'past', 'earlier', 'recall', 'context',
    ],
    maxTokens: 1500,
    maxChunks: 4,
  },
];

/**
 * Match a user message against the trigger registry.
 * Returns triggered collections (deduplicated, ordered by trigger specificity).
 */
function matchTriggers(
  userMessage: string,
  triggers: CollectionTrigger[]
): CollectionTrigger[] {
  if (!userMessage) return [];
  const lower = userMessage.toLowerCase();
  return triggers.filter(t =>
    t.keywords.some(kw => lower.includes(kw.toLowerCase()))
  );
}

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

export interface CompositorDeps {
  redis: RedisLayer;
  vectorStore?: VectorStore | null;
  libraryDb?: DatabaseSync | null;
  /** Custom trigger registry; defaults to DEFAULT_TRIGGERS if not provided */
  triggerRegistry?: CollectionTrigger[];
}

export class Compositor {
  private readonly config: CompositorConfig;
  private readonly redis: RedisLayer;
  private readonly vectorStore: VectorStore | null;
  private readonly libraryDb: DatabaseSync | null;
  private readonly triggerRegistry: CollectionTrigger[];

  constructor(
    deps: CompositorDeps | RedisLayer,
    config?: Partial<CompositorConfig>
  ) {
    // Accept either old-style (RedisLayer) or new-style (CompositorDeps)
    if (deps instanceof RedisLayer) {
      console.warn('[compositor] DEPRECATED: Compositor(RedisLayer) constructor is deprecated. Pass CompositorDeps instead. Vector search and library DB are disabled in legacy mode.');
      this.redis = deps;
      this.vectorStore = null;
      this.libraryDb = null;
      this.triggerRegistry = DEFAULT_TRIGGERS;
    } else {
      this.redis = deps.redis;
      this.vectorStore = deps.vectorStore || null;
      this.libraryDb = deps.libraryDb || null;
      this.triggerRegistry = deps.triggerRegistry || DEFAULT_TRIGGERS;
    }
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Compose a complete message array for sending to an LLM.
   *
   * Orchestrates all four memory layers:
   *   1. System prompt + identity (never truncated)
   *   2. Conversation history (L1 Redis → L2 messages.db)
   *   3. Active facts from library (L4)
   *   4. Knowledge entries relevant to conversation (L4)
   *   5. User preferences (L4)
   *   6. Semantic recall via vector search (L3)
   *   7. Cross-session context (L2)
   *
   * Each slot respects the remaining token budget.
   */
  async compose(request: ComposeRequest, db: DatabaseSync, libraryDb?: DatabaseSync): Promise<ComposeResult> {
    const store = new MessageStore(db);
    const libDb = libraryDb || this.libraryDb;
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

        includedHistory.unshift(msg);
        historyTokens += msgTokens;
      }

      messages.push(...includedHistory);
      slots.history = historyTokens;
      remaining -= historyTokens;
    }

    // ─── Injected Context Block ────────────────────────────────
    // Facts, knowledge, preferences, semantic recall, and cross-session
    // context are assembled into a single system message injected before
    // conversation history (after system/identity).
    const contextParts: string[] = [];
    let contextTokens = 0;

    // ── Facts (L4: Library) ──────────────────────────────────
    if (request.includeFacts !== false && remaining > 500) {
      const factsContent = this.buildFactsFromDb(request.agentId, libDb || db);
      if (factsContent) {
        const tokens = estimateTokens(factsContent);
        if (tokens <= remaining * 0.3) { // Cap facts at 30% of remaining
          contextParts.push(`## Active Facts\n${factsContent}`);
          contextTokens += tokens;
          remaining -= tokens;
          slots.facts = tokens;
        } else {
          // Truncate to budget
          const truncated = this.truncateToTokens(factsContent, Math.floor(remaining * 0.3));
          const truncTokens = estimateTokens(truncated);
          contextParts.push(`## Active Facts (truncated)\n${truncated}`);
          contextTokens += truncTokens;
          remaining -= truncTokens;
          slots.facts = truncTokens;
          warnings.push('Facts truncated to fit budget');
        }
      }
    }

    // ── Knowledge (L4: Library) ──────────────────────────────
    if (request.includeLibrary !== false && remaining > 500 && libDb) {
      const knowledgeContent = this.buildKnowledgeFromDb(request.agentId, libDb);
      if (knowledgeContent) {
        const tokens = estimateTokens(knowledgeContent);
        if (tokens <= remaining * 0.2) { // Cap knowledge at 20% of remaining
          contextParts.push(`## Knowledge\n${knowledgeContent}`);
          contextTokens += tokens;
          remaining -= tokens;
          slots.library += tokens;
        } else {
          const truncated = this.truncateToTokens(knowledgeContent, Math.floor(remaining * 0.2));
          const truncTokens = estimateTokens(truncated);
          contextParts.push(`## Knowledge (truncated)\n${truncated}`);
          contextTokens += truncTokens;
          remaining -= truncTokens;
          slots.library += truncTokens;
          warnings.push('Knowledge truncated to fit budget');
        }
      }
    }

    // ── Preferences (L4: Library) ────────────────────────────
    if (request.includeLibrary !== false && remaining > 300 && libDb) {
      const prefsContent = this.buildPreferencesFromDb(request.agentId, libDb);
      if (prefsContent) {
        const tokens = estimateTokens(prefsContent);
        if (tokens <= remaining * 0.1) { // Cap preferences at 10% of remaining
          contextParts.push(`## User Preferences\n${prefsContent}`);
          contextTokens += tokens;
          remaining -= tokens;
          slots.library += tokens;
        }
      }
    }

    // ── Semantic Recall (L3: Hybrid FTS5+KNN) ───────────────
    // Fires when either vector store or library DB is available.
    // FTS5-only (no embeddings) still returns keyword matches.
    // KNN-only (no FTS terms) still returns semantic matches.
    // Both present → Reciprocal Rank Fusion.
    if (remaining > 500 && (this.vectorStore || libDb)) {
      const lastUserMsg = this.getLastUserMessage(messages);
      if (lastUserMsg) {
        try {
          const semanticContent = await this.buildSemanticRecall(
            lastUserMsg,
            request.agentId,
            Math.floor(remaining * 0.15), // Cap at 15% of remaining
            libDb || undefined
          );
          if (semanticContent) {
            const tokens = estimateTokens(semanticContent);
            contextParts.push(`## Related Memory\n${semanticContent}`);
            contextTokens += tokens;
            remaining -= tokens;
            // Semantic recall draws from multiple sources, attribute to context
            slots.context += tokens;
          }
        } catch (err) {
          // Semantic search is best-effort — don't fail composition
          warnings.push(`Semantic recall failed: ${(err as Error).message}`);
        }
      }
    }

    // ── Doc Chunks (L4: Trigger-based retrieval) ─────────────
    // Demand-load governance, identity, and memory chunks based on
    // conversation context. Replaces full ACA file injection for
    // the files that have been seeded into the doc chunk index.
    if (request.includeDocChunks !== false && remaining > 400 && libDb) {
      const lastMsg = this.getLastUserMessage(messages) || '';
      const triggered = matchTriggers(lastMsg, this.triggerRegistry);

      if (triggered.length > 0) {
        const docChunkStore = new DocChunkStore(libDb);
        const docParts: string[] = [];

        for (const trigger of triggered) {
          if (remaining < 200) break;

          const maxTokens = Math.min(
            trigger.maxTokens || 1000,
            Math.floor(remaining * 0.15) // No single collection takes > 15% of remaining
          );

          try {
            // Build a relevance-based FTS5 query from the user message.
            //
            // Problem: trigger keywords are stems ('escalat', 'irreversib') for
            // substring matching against user messages, but FTS5 tokenizes on word
            // boundaries. 'escalat' does not match 'escalation' in FTS5 without a
            // prefix operator.
            //
            // Solution: extract actual words from the user message that contain a
            // matched trigger keyword, then use FTS5 prefix queries (word*) for
            // each extracted word. This bridges stem-matching and FTS5 indexing.
            const msgLower = lastMsg.toLowerCase();
            const matchedKeywords = trigger.keywords.filter(kw =>
              msgLower.includes(kw.toLowerCase())
            );

            // Extract whole words from the message that overlap with matched keywords
            const msgWords = lastMsg.match(/\b\w{4,}\b/g) || [];
            const relevantWords = msgWords.filter(word =>
              matchedKeywords.some(kw => word.toLowerCase().includes(kw.toLowerCase()) ||
                                        kw.toLowerCase().includes(word.toLowerCase().slice(0, 5)))
            );

            // Build FTS5 OR query: "word1* OR word2* OR word3*"
            // FTS5 treats space-separated terms as AND by default — we want OR so
            // that any relevant term is sufficient to retrieve a matching chunk.
            // Prefix operator (*) ensures stems match full words in the index.
            // Sort by keyword match specificity (longer matched keyword = more specific term),
            // then cap at 6 terms to keep FTS queries reasonable.
            // No positional slice — all relevant words participate, not just the first 3.
            const sortedWords = [...new Set(relevantWords)].sort((a, b) => {
              const aLen = Math.max(...matchedKeywords.filter(kw =>
                a.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(a.toLowerCase().slice(0, 5))
              ).map(kw => kw.length), 0);
              const bLen = Math.max(...matchedKeywords.filter(kw =>
                b.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(b.toLowerCase().slice(0, 5))
              ).map(kw => kw.length), 0);
              return bLen - aLen; // Most specific match first
            });

            const ftsTerms = sortedWords.length > 0
              ? sortedWords.slice(0, 6).map(w => `${w}*`).join(' OR ')
              : matchedKeywords
                  .sort((a, b) => b.length - a.length)
                  .slice(0, 3)
                  .map(kw => `${kw}*`)
                  .join(' OR ');

            const ftsKeyword = ftsTerms || lastMsg.split(/\s+/).slice(0, 3).join(' ');

            const chunks = docChunkStore.queryChunks({
              collection: trigger.collection,
              agentId: request.agentId,
              tier: request.tier,
              limit: trigger.maxChunks || 3,
              keyword: ftsKeyword,
            });

            if (chunks.length === 0) continue;

            const chunkLines: string[] = [];
            let chunkTokens = 0;

            for (const chunk of chunks) {
              if (chunkTokens + chunk.tokenEstimate > maxTokens) break;
              chunkLines.push(`### ${chunk.sectionPath}\n${chunk.content}`);
              chunkTokens += chunk.tokenEstimate;
            }

            if (chunkLines.length > 0) {
              const collectionLabel = trigger.collection.split('/').pop() || trigger.collection;
              docParts.push(`## ${collectionLabel} (retrieved)\n${chunkLines.join('\n\n')}`);
              contextTokens += chunkTokens;
              remaining -= chunkTokens;
              slots.library += chunkTokens;
            }
          } catch {
            // Doc chunk retrieval is best-effort — don't fail composition
          }
        }

        if (docParts.length > 0) {
          contextParts.push(docParts.join('\n\n'));
        }
      }
    }

    // ── Cross-Session Context (L2: Messages) ─────────────────
    if (request.includeContext !== false && remaining > 500) {
      const crossSessionContent = this.buildCrossSessionContext(
        request.agentId,
        request.sessionKey,
        db,
        libDb
      );

      if (crossSessionContent) {
        const tokens = estimateTokens(crossSessionContent);
        const maxContextTokens = Math.min(
          this.config.maxCrossSessionContext,
          Math.floor(remaining * 0.2)
        );

        if (tokens <= maxContextTokens) {
          contextParts.push(`## Other Active Sessions\n${crossSessionContent}`);
          contextTokens += tokens;
          remaining -= tokens;
          slots.context += tokens;
        } else {
          const truncated = this.truncateToTokens(crossSessionContent, maxContextTokens);
          const truncTokens = estimateTokens(truncated);
          contextParts.push(`## Other Active Sessions (truncated)\n${truncated}`);
          contextTokens += truncTokens;
          remaining -= truncTokens;
          slots.context += truncTokens;
          warnings.push('Cross-session context truncated');
        }
      }
    }

    // ── Inject assembled context block ──────────────────────
    const assembledContextBlock = contextParts.length > 0 ? contextParts.join('\n\n') : undefined;

    if (assembledContextBlock) {
      const contextMsg: NeutralMessage = {
        role: 'system',
        textContent: assembledContextBlock,
        toolCalls: null,
        toolResults: null,
        // DYNAMIC_BOUNDARY: this slot is session-specific (facts, recall, episodes).
        // It must NOT be included in any prompt caching boundary that spans static content.
        // The provider translator will insert a cache_control ephemeral marker BEFORE
        // this message so providers can cache everything up to identity/system as static context.
        metadata: { dynamicBoundary: true },
      };
      // Insert after system/identity, before history
      // Insert context after all system/identity messages, before conversation history.
      // findIndex returns -1 when all messages are system-role — handle explicitly.
      const firstNonSystem = messages.findIndex(m => m.role !== 'system');
      const insertIdx = firstNonSystem === -1 ? messages.length : firstNonSystem;
      messages.splice(insertIdx, 0, contextMsg);
    }

    // ─── Translate to provider format ──────────────────────────
    // Use provider if set; fall back to model string for detection
    const providerMessages = toProviderFormat(messages, request.provider ?? request.model ?? null);

    const totalTokens = budget - remaining;

    return {
      messages: providerMessages,
      tokenCount: totalTokens,
      slots,
      truncated: remaining < 0,
      hasWarnings: warnings.length > 0,
      warnings,
      contextBlock: assembledContextBlock,
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

    if (!conversation) return;

    const history = store.getRecentMessages(conversation.id, this.config.maxHistoryMessages);

    const libDb = opts?.libraryDb || this.libraryDb;
    const factsContent = this.buildFactsFromDb(agentId, libDb || db);
    const contextContent = this.buildCrossSessionContext(agentId, sessionKey, db, libDb);

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
    const cached = await this.redis.getSlot(agentId, sessionKey, slot);
    if (cached) return cached;

    switch (slot) {
      case 'facts':
        return this.buildFactsFromDb(agentId, libraryDb || this.libraryDb || db);
      case 'context':
        return this.buildCrossSessionContext(agentId, sessionKey, db, libraryDb || this.libraryDb);
      default:
        return null;
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
    const cached = await this.redis.getHistory(agentId, sessionKey);
    if (cached.length > 0) return cached;

    const conversation = store.getConversation(sessionKey);
    if (!conversation) return [];

    return store.getRecentMessages(conversation.id, limit);
  }

  // ─── L4 Library Builders ─────────────────────────────────────

  /**
   * Build facts content from library DB.
   */
  private buildFactsFromDb(agentId: string, db: DatabaseSync | null): string | null {
    if (!db) return null;

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
      AND confidence >= 0.5
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
   * Build knowledge content from library DB.
   * Prioritizes high-confidence, non-superseded entries.
   */
  private buildKnowledgeFromDb(agentId: string, db: DatabaseSync): string | null {
    const tableExists = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='knowledge'"
    ).get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) return null;

    const rows = db.prepare(`
      SELECT domain, key, content, confidence FROM knowledge
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 15
    `).all(agentId) as Array<{
      domain: string;
      key: string;
      content: string;
      confidence: number;
    }>;

    if (rows.length === 0) return null;

    // Group by domain for cleaner presentation
    const byDomain: Record<string, Array<{ key: string; content: string }>> = {};
    for (const row of rows) {
      if (!byDomain[row.domain]) byDomain[row.domain] = [];
      byDomain[row.domain].push({ key: row.key, content: row.content });
    }

    const lines: string[] = [];
    for (const [domain, entries] of Object.entries(byDomain)) {
      lines.push(`### ${domain}`);
      for (const entry of entries) {
        lines.push(`- **${entry.key}:** ${entry.content}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build preferences content from library DB.
   * Shows user/operator preferences relevant to this agent.
   */
  private buildPreferencesFromDb(agentId: string, db: DatabaseSync): string | null {
    const tableExists = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='preferences'"
    ).get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) return null;

    // Get preferences set by this agent or marked fleet-visible
    const rows = db.prepare(`
      SELECT subject, key, value, domain, confidence FROM preferences
      WHERE (agent_id = ? OR agent_id IS NULL)
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 10
    `).all(agentId) as Array<{
      subject: string;
      key: string;
      value: string;
      domain: string | null;
      confidence: number;
    }>;

    if (rows.length === 0) return null;

    // Group by subject
    const bySubject: Record<string, Array<{ key: string; value: string; domain: string | null }>> = {};
    for (const row of rows) {
      if (!bySubject[row.subject]) bySubject[row.subject] = [];
      bySubject[row.subject].push({ key: row.key, value: row.value, domain: row.domain });
    }

    const lines: string[] = [];
    for (const [subject, prefs] of Object.entries(bySubject)) {
      lines.push(`### ${subject}`);
      for (const pref of prefs) {
        const domainTag = pref.domain ? ` [${pref.domain}]` : '';
        lines.push(`- **${pref.key}:**${domainTag} ${pref.value}`);
      }
    }

    return lines.join('\n');
  }

  // ─── L3 Hybrid Retrieval (FTS5 + KNN) ───────────────────────

  /**
   * Build semantic recall content using hybrid FTS5+KNN retrieval.
   *
   * Uses Reciprocal Rank Fusion to merge keyword and vector results.
   * Gracefully degrades: FTS5-only when no vector store, KNN-only
   * when FTS query is empty (all stop words), both when available.
   */
  private async buildSemanticRecall(
    userMessage: string,
    agentId: string,
    maxTokens: number,
    libraryDb?: DatabaseSync
  ): Promise<string | null> {
    const libDb = libraryDb || this.libraryDb;
    if (!libDb && !this.vectorStore) return null;

    // Use hybrid search when library DB is available
    if (libDb) {
      const results = await hybridSearch(libDb, this.vectorStore, userMessage, {
        tables: ['facts', 'knowledge', 'episodes'],
        limit: 10,
        agentId,
        maxKnnDistance: 1.2,
      });

      if (results.length === 0) return null;

      const lines: string[] = [];
      let tokens = 0;

      for (const result of results) {
        // TUNE-001: drop very-low-relevance results (RRF scores below 0.008 are noise)
        if (result.score < 0.008) continue;
        const label = this.formatHybridResult(result);
        const lineTokens = estimateTokens(label);
        if (tokens + lineTokens > maxTokens) break;
        lines.push(label);
        tokens += lineTokens;
      }

      return lines.length > 0 ? lines.join('\n') : null;
    }

    // Fallback: KNN-only when no library DB (legacy path)
    if (!this.vectorStore) return null;

    const results = await this.vectorStore.search(userMessage, {
      tables: ['facts', 'knowledge', 'episodes'],
      limit: 8,
      maxDistance: 1.2,
    });

    if (results.length === 0) return null;

    const lines: string[] = [];
    let tokens = 0;

    for (const result of results) {
      const label = this.formatVectorResult(result);
      const lineTokens = estimateTokens(label);
      if (tokens + lineTokens > maxTokens) break;
      lines.push(label);
      tokens += lineTokens;
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * Format a hybrid search result for injection into context.
   * Shows retrieval source(s) and relevance score.
   */
  private formatHybridResult(result: HybridSearchResult): string {
    const type = result.sourceTable;
    const sourceTag = result.sources.length === 2 ? 'fts+knn' : result.sources[0];
    const scoreStr = (result.score * 100).toFixed(0);

    switch (type) {
      case 'facts':
        return `- [fact, ${sourceTag}, score:${scoreStr}] ${result.content}`;
      case 'knowledge':
        return `- [knowledge/${result.metadata || 'general'}, ${sourceTag}, score:${scoreStr}] ${result.content}`;
      case 'episodes':
        return `- [episode/${result.domain || 'event'}, ${sourceTag}, score:${scoreStr}] ${result.content}`;
      default:
        return `- [${type}, ${sourceTag}, score:${scoreStr}] ${result.content}`;
    }
  }

  /**
   * Format a vector-only search result (legacy fallback).
   */
  private formatVectorResult(result: VectorSearchResult): string {
    const relevance = Math.max(0, Math.round((1 - result.distance) * 100));
    const type = result.sourceTable;

    switch (type) {
      case 'facts':
        return `- [fact, ${relevance}% relevant] ${result.content}`;
      case 'knowledge':
        return `- [knowledge/${result.metadata || 'general'}, ${relevance}% relevant] ${result.content}`;
      case 'episodes':
        return `- [episode/${result.domain || 'event'}, ${relevance}% relevant] ${result.content}`;
      default:
        return `- [${type}, ${relevance}% relevant] ${result.content}`;
    }
  }

  // ─── L2 Cross-Session Context ────────────────────────────────

  /**
   * Build cross-session context by finding recent activity
   * in other sessions for this agent.
   */
  private buildCrossSessionContext(
    agentId: string,
    currentSessionKey: string,
    db: DatabaseSync,
    _libraryDb?: DatabaseSync | null
  ): string | null {
    const conversation = db.prepare(
      'SELECT id FROM conversations WHERE session_key = ?'
    ).get(currentSessionKey) as { id: number } | undefined;

    if (!conversation) return null;

    const rows = db.prepare(`
      SELECT m.text_content, m.role, c.channel_type, m.created_at
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.agent_id = ?
      AND m.conversation_id != ?
      AND c.status = 'active'
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

    const lines = rows.map(r => {
      const preview = r.text_content.substring(0, 200);
      return `- [${r.channel_type}/${r.role} @ ${r.created_at}] ${preview}`;
    });

    return lines.join('\n');
  }

  // ─── Utilities ───────────────────────────────────────────────

  /**
   * Extract the last user message text from the composed messages.
   */
  private getLastUserMessage(messages: NeutralMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].textContent) {
        return messages[i].textContent;
      }
    }
    return null;
  }

  /**
   * Truncate text to approximately fit within a token budget.
   * Truncates at line boundaries when possible.
   */
  private truncateToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4; // inverse of our estimation

    if (text.length <= maxChars) return text;

    // Try to truncate at a line boundary
    const truncated = text.substring(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');

    if (lastNewline > maxChars * 0.7) {
      return truncated.substring(0, lastNewline) + '\n…';
    }

    return truncated + '…';
  }
}
