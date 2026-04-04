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
  ComposeDiagnostics,
  SlotTokenCounts,
  NeutralMessage,
  ProviderMessage,
  StoredMessage,
  CompositorConfig,
  SessionMeta,
  SessionCursor,
} from './types.js';
import { filterByScope } from './retrieval-policy.js';
import { RedisLayer } from './redis.js';
import { MessageStore } from './message-store.js';
import { toProviderFormat } from './provider-translator.js';
import { VectorStore, type VectorSearchResult } from './vector-store.js';
import { DocChunkStore } from './doc-chunk-store.js';
import { hybridSearch, type HybridSearchResult } from './hybrid-retrieval.js';
import { ensureCompactionFenceSchema, updateCompactionFence } from './compaction-fence.js';
import { rankKeystones, type KeystoneCandidate } from './keystone-scorer.js';

const DEFAULT_CONFIG: CompositorConfig = {
  defaultTokenBudget: 90000,
  maxHistoryMessages: 250,
  maxFacts: 28,
  maxCrossSessionContext: 6000,
  maxRecentToolPairs: 3,
  maxProseToolPairs: 10,
  warmHistoryBudgetFraction: 0.4,
  keystoneHistoryFraction: 0.2,
  keystoneMaxMessages: 15,
  keystoneMinSignificance: 0.5,
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

/**
 * Dense token estimation for tool content (JSON, code, base64).
 * Tool payloads are typically 2x denser than English prose.
 */
function estimateToolTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function estimateMessageTokens(msg: NeutralMessage): number {
  let tokens = estimateTokens(msg.textContent);
  if (msg.toolCalls) {
    tokens += estimateToolTokens(JSON.stringify(msg.toolCalls)); // dense: /2 not /4
  }
  if (msg.toolResults) {
    tokens += estimateToolTokens(JSON.stringify(msg.toolResults)); // dense: /2 not /4
  }
  // Overhead per message (role, formatting)
  tokens += 4;
  return tokens;
}

/**
 * Extract a heuristic prose summary from a tool call/result pair.
 * Returns a natural-language sentence (~15-30 tokens) instead of raw payloads.
 * Used for Tier 2 tool treatment in applyToolGradient().
 */
function extractToolProseSummary(msg: NeutralMessage): string {
  const parts: string[] = [];

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.arguments); } catch { /* best-effort */ }

      const resultContent = msg.toolResults?.find(r => r.callId === tc.id)?.content ?? '';
      const resultKB = resultContent ? `${(resultContent.length / 1024).toFixed(1)}KB` : '';

      switch (tc.name) {
        case 'read': {
          const p = (args.path ?? args.file_path ?? args.filePath ?? '') as string;
          parts.push(p ? `Read ${p}${resultKB ? ` (${resultKB})` : ''}` : 'Read a file');
          break;
        }
        case 'write': {
          const p = (args.path ?? args.file ?? args.filePath ?? '') as string;
          parts.push(p ? `Wrote ${p}${resultKB ? ` (${resultKB})` : ''}` : 'Wrote a file');
          break;
        }
        case 'edit': {
          const p = (args.path ?? args.file ?? args.filePath ?? '') as string;
          parts.push(p ? `Edited ${p}` : 'Edited a file');
          break;
        }
        case 'exec': {
          const cmd = ((args.command ?? '') as string).slice(0, 60);
          const firstLine = resultContent.split('\n')[0]?.slice(0, 80) ?? '';
          parts.push(cmd ? `Ran ${cmd}${firstLine ? ` — ${firstLine}` : ''}` : 'Ran a command');
          break;
        }
        case 'web_search': {
          const q = (args.query ?? '') as string;
          parts.push(q ? `Searched '${q.slice(0, 60)}'` : 'Searched the web');
          break;
        }
        case 'web_fetch': {
          const u = (args.url ?? '') as string;
          parts.push(u ? `Fetched ${u.slice(0, 80)}` : 'Fetched a URL');
          break;
        }
        case 'sessions_send': {
          const target = (args.sessionKey ?? args.label ?? '') as string;
          parts.push(target ? `Sent message to ${target}` : 'Sent an inter-session message');
          break;
        }
        case 'memory_search': {
          const q = (args.query ?? '') as string;
          parts.push(q ? `Searched memory for '${q.slice(0, 60)}'` : 'Searched memory');
          break;
        }
        default:
          parts.push(`Used ${tc.name}`);
      }
    }
  } else if (msg.toolResults && msg.toolResults.length > 0) {
    // Result-only message (no matching call visible)
    const content = msg.toolResults[0].content?.slice(0, 100) ?? '';
    parts.push(content ? `Tool result: ${content}` : 'Tool result received');
  }

  return parts.join('; ');
}

/**
 * Apply gradient tool treatment to a message array.
 *
 * Tiers (newest-to-oldest):
 *   Tier 1 — last maxRecentToolPairs: verbatim (untouched)
 *   Tier 2 — next maxProseToolPairs:  heuristic prose stub replaces tool payloads
 *   Tier 3 — beyond:                 tool payloads nulled, text content preserved
 *
 * Message text (assistant reasoning, user text) is NEVER modified.
 * This pass runs before the budget loop so estimateMessageTokens() measures
 * the actual cost that will be submitted, not the pre-transform cost.
 */
function applyToolGradient(
  messages: NeutralMessage[],
  maxRecentToolPairs: number,
  maxProseToolPairs: number,
): NeutralMessage[] {
  let toolPairsSeen = 0;

  // Walk newest→oldest to assign tiers, transform in place (new objects)
  const result = [...messages];
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    const hasToolContent = (msg.toolCalls && msg.toolCalls.length > 0) ||
                           (msg.toolResults && msg.toolResults.length > 0);
    if (!hasToolContent) continue;

    toolPairsSeen++;

    if (toolPairsSeen <= maxRecentToolPairs) {
      // Tier 1: verbatim — no change
      continue;
    } else if (toolPairsSeen <= maxRecentToolPairs + maxProseToolPairs) {
      // Tier 2: prose stub
      const prose = extractToolProseSummary(msg);
      result[i] = {
        ...msg,
        textContent: prose || msg.textContent,  // prose replaces payload; fallback to existing text
        toolCalls: null,
        toolResults: null,
      };
    } else {
      // Tier 3: drop tool payload entirely, preserve text
      result[i] = {
        ...msg,
        toolCalls: null,
        toolResults: null,
      };
    }
  }

  return result;
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
  private vectorStore: VectorStore | null;
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
   * Set or replace the vector store after construction.
   * Called by HyperMem.create() once sqlite-vec is confirmed available.
   */
  setVectorStore(vs: VectorStore): void {
    this.vectorStore = vs;
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
      const rawHistoryMessages = await this.getHistory(
        request.agentId,
        request.sessionKey,
        request.historyDepth || this.config.maxHistoryMessages,
        store
      );

      // Deduplicate history by StoredMessage.id (second line of defense after
      // pushHistory() tail-check dedup). Guards against any duplicates that
      // slipped through the warm path — e.g. bootstrap re-runs on existing sessions.
      const seenIds = new Set<number>();
      const historyMessages = rawHistoryMessages.filter(m => {
        const sm = m as import('./types.js').StoredMessage;
        if (sm.id != null) {
          if (seenIds.has(sm.id)) return false;
          seenIds.add(sm.id);
        }
        return true;
      });

      // ── Transform-first: apply gradient tool treatment BEFORE budget math ──
      // All tool payloads are in their final form before any token estimation.
      // This ensures estimateMessageTokens() measures actual submission cost,
      // not pre-transform cost (which caused overflow: dense tool JSON was
      // undercounted at length/4 when it should be measured post-stub).
      const transformedHistory = applyToolGradient(
        historyMessages,
        this.config.maxRecentToolPairs ?? 3,
        this.config.maxProseToolPairs ?? 10,
      );

      // ── Budget-fit: walk newest→oldest, drop until it fits ──────────────
      // No transformation happens here — only include/exclude decisions.
      let historyTokens = 0;
      const includedHistory: NeutralMessage[] = [];

      for (let i = transformedHistory.length - 1; i >= 0; i--) {
        const msg = transformedHistory[i];
        const msgTokens = estimateMessageTokens(msg);

        if (historyTokens + msgTokens > remaining) {
          warnings.push(`History truncated at message ${i + 1}/${historyMessages.length}`);
          break;
        }

        includedHistory.unshift(msg);
        historyTokens += msgTokens;
      }

      // ── Keystone History Slot (P2.1) ──────────────────────────────────
      // For long conversations (≥30 messages), inject high-signal older messages
      // from before the recent window as recalled context. This lets the model
      // see key decisions and specs that happened earlier in the conversation
      // without them consuming the full recent history budget.
      const keystoneFraction = this.config.keystoneHistoryFraction ?? 0.2;
      const keystoneMaxMsgs = this.config.keystoneMaxMessages ?? 15;

      let keystoneMessages: NeutralMessage[] = [];
      let keystoneTokens = 0;

      if (includedHistory.length >= 30 && keystoneFraction > 0) {
        const keystoneResult = await this.buildKeystones(
          db,
          request.agentId,
          includedHistory,
          historyTokens,
          keystoneFraction,
          keystoneMaxMsgs,
          request.prompt,
          libDb || undefined
        );
        if (keystoneResult) {
          keystoneMessages = keystoneResult.keystoneMessages;
          keystoneTokens = keystoneResult.keystoneTokens;
          // Replace includedHistory and historyTokens with the trimmed versions
          // (keystoneResult reflects the trimming done inside buildKeystones)
          includedHistory.splice(0, includedHistory.length, ...keystoneResult.trimmedHistory);
          historyTokens = keystoneResult.trimmedHistoryTokens;
          warnings.push(`Keystone: injected ${keystoneMessages.length} recalled messages`);
        }
      }

      // Push history with keystone separators if we have keystones.
      if (keystoneMessages.length > 0) {
        // Separator before recalled context
        messages.push({
          role: 'system',
          textContent: '## Recalled Context (high-signal older messages)',
          toolCalls: null,
          toolResults: null,
        });
        messages.push(...keystoneMessages);
        // Separator before recent conversation
        messages.push({
          role: 'system',
          textContent: '## Recent Conversation',
          toolCalls: null,
          toolResults: null,
        });
        messages.push(...includedHistory);
        // Account for separator tokens in history slot
        const sepTokens = estimateTokens('## Recalled Context (high-signal older messages)') +
          estimateTokens('## Recent Conversation');
        slots.history = historyTokens + keystoneTokens + sepTokens;
        remaining -= (historyTokens + keystoneTokens + sepTokens);
      } else {
        messages.push(...includedHistory);
        slots.history = historyTokens;
        remaining -= historyTokens;
      }

      // T1.3: Ghost message suppression.
      // If the last message in the included history is a warm-seeded user message
      // AND there's a subsequent message in SQLite that wasn't included (meaning
      // the assistant already responded), drop it. This prevents the model from
      // re-answering a question that was already handled in a prior session.
      // Only triggers when: (1) message has _warmed flag, (2) it's role=user,
      // (3) SQLite has messages after it (the response exists but wasn't included).
      const lastIncluded = messages[messages.length - 1];
      if (lastIncluded?.role === 'user') {
        const sm = lastIncluded as import('./types.js').StoredMessage;
        const meta = sm.metadata as Record<string, unknown> | undefined;
        if (meta?._warmed && sm.id != null) {
          // Check if there are any messages after this one in SQLite
          try {
            const hasMore = db.prepare(
              'SELECT 1 FROM messages WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?) AND id > ? LIMIT 1'
            ).get(sm.id, sm.id);
            if (hasMore) {
              messages.pop();
              warnings.push('Dropped trailing warm-seeded user message with existing response (ghost suppression)');
            }
          } catch {
            // Ghost check is best-effort — don't block compose
          }
        }
      }
    }

    // ─── Injected Context Block ────────────────────────────────
    // Facts, knowledge, preferences, semantic recall, and cross-session
    // context are assembled into a single system message injected before
    // conversation history (after system/identity).
    const contextParts: string[] = [];
    let contextTokens = 0;

    // ── Compose-level diagnostics tracking vars ──────────────
    let diagTriggerHits = 0;
    let diagTriggerFallbackUsed = false;
    let diagFactsIncluded = 0;
    let diagSemanticResults = 0;
    let diagDocChunkCollections = 0;
    let diagScopeFiltered = 0;
    let diagRetrievalMode: ComposeDiagnostics['retrievalMode'] = 'none';

    // ── Facts (L4: Library) ──────────────────────────────────
    // scope: agent — filtered by agentId via filterByScope after fetch
    if (request.includeFacts !== false && remaining > 500) {
      const factsContent = this.buildFactsFromDb(request.agentId, request.sessionKey, libDb || db);
      if (factsContent !== null) {
        const [content, factCount, scopeFiltered] = factsContent;
        diagFactsIncluded += factCount;
        diagScopeFiltered += scopeFiltered;
        if (content) {
          const tokens = estimateTokens(content);
          if (tokens <= remaining * 0.25) { // Cap facts at 25% of remaining (W4: was 0.3)
            contextParts.push(`## Active Facts\n${content}`);
            contextTokens += tokens;
            remaining -= tokens;
            slots.facts = tokens;
          } else {
            // Truncate to budget
            const truncated = this.truncateToTokens(content, Math.floor(remaining * 0.25));
            const truncTokens = estimateTokens(truncated);
            contextParts.push(`## Active Facts (truncated)\n${truncated}`);
            contextTokens += truncTokens;
            remaining -= truncTokens;
            slots.facts = truncTokens;
            warnings.push('Facts truncated to fit budget');
          }
        }
      }
    }

    // ── Knowledge (L4: Library) ──────────────────────────────
    // scope: agent — filtered by agent_id in the SQL query (existing behavior)
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
    // scope: agent — filtered by agent_id OR NULL in the SQL query (existing behavior)
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
    // scope: agent — buildSemanticRecall filters by agentId internally
    // Fires when either vector store or library DB is available.
    // FTS5-only (no embeddings) still returns keyword matches.
    // KNN-only (no FTS terms) still returns semantic matches.
    // Both present → Reciprocal Rank Fusion.
    // Use request.prompt as the retrieval query when available — it is the
    // live current-turn text. Falling back to getLastUserMessage(messages)
    // reads from the already-assembled history, which is one turn stale.
    if (remaining > 500 && (this.vectorStore || libDb)) {
      const lastUserMsg = request.prompt?.trim() || this.getLastUserMessage(messages);
      if (lastUserMsg) {
        try {
          // Check Redis for a pre-computed embedding from afterTurn()
          let precomputedEmbedding: Float32Array | undefined;
          try {
            const cached = await this.redis.getQueryEmbedding(request.agentId, request.sessionKey);
            if (cached) precomputedEmbedding = cached;
          } catch {
            // Redis lookup is best-effort — fall through to Ollama
          }

          const semanticContent = await this.buildSemanticRecall(
            lastUserMsg,
            request.agentId,
            Math.floor(remaining * 0.12), // Cap at 12% of remaining (W4: was 0.15)
            libDb || undefined,
            precomputedEmbedding
          );
          if (semanticContent) {
            const tokens = estimateTokens(semanticContent);
            contextParts.push(`## Related Memory\n${semanticContent}`);
            contextTokens += tokens;
            remaining -= tokens;
            // Semantic recall draws from multiple sources, attribute to context
            slots.context += tokens;
            // W3 diagnostics: count non-empty lines as rough results count
            diagSemanticResults = semanticContent.split('\n').filter(l => l.trim().length > 0).length;
          }
        } catch (err) {
          // Semantic search is best-effort — don't fail composition
          warnings.push(`Semantic recall failed: ${(err as Error).message}`);
        }
      }
    }

    // ── Doc Chunks (L4: Trigger-based retrieval) ─────────────
    // scope: per-tier/per-agent — queryChunks filters by agentId and tier
    // Demand-load governance, identity, and memory chunks based on
    // conversation context. Replaces full ACA file injection for
    // the files that have been seeded into the doc chunk index.
    let triggerFallbackUsed = false;
    if (request.includeDocChunks !== false && remaining > 400 && libDb) {
      // Use request.prompt when available (current-turn text, not stale history)
      const lastMsg = request.prompt?.trim() || this.getLastUserMessage(messages) || '';
      const triggered = matchTriggers(lastMsg, this.triggerRegistry);

      if (triggered.length > 0) {
        diagTriggerHits = triggered.length;
        diagRetrievalMode = 'triggered';
        const docChunkStore = new DocChunkStore(libDb);
        const docParts: string[] = [];

        for (const trigger of triggered) {
          if (remaining < 200) break;

          const maxTokens = Math.min(
            trigger.maxTokens || 1000,
            Math.floor(remaining * 0.12) // No single collection takes > 12% of remaining (W4: was 0.15)
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
              diagDocChunkCollections++;
            }
          } catch {
            // Doc chunk retrieval is best-effort — don't fail composition
          }
        }

        if (docParts.length > 0) {
          contextParts.push(docParts.join('\n\n'));
        }
      } else if (remaining > 400 && (this.vectorStore || libDb)) {
        // Trigger-miss fallback: no trigger fired — attempt bounded semantic retrieval
        // so there is never a silent zero-memory path on doc chunks.
        try {
          const fallbackContent = await this.buildSemanticRecall(
            lastMsg,
            request.agentId,
            Math.floor(remaining * 0.10),
            libDb || undefined,
          );
          if (fallbackContent) {
            contextParts.push(`## Related Memory\n${fallbackContent}`);
            const fallbackTokens = estimateTokens(fallbackContent);
            contextTokens += fallbackTokens;
            remaining -= fallbackTokens;
            slots.context += fallbackTokens;
            triggerFallbackUsed = true;
            diagTriggerFallbackUsed = true;
            diagRetrievalMode = 'fallback_knn';
          }
        } catch {
          // Fallback is best-effort — never fail composition
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

    // ─── Safety Valve: Post-Assembly Budget Check ───────────────────
    // Re-estimate total tokens after all slots are assembled. If the
    // composition exceeds tokenBudget * 1.05 (5% tolerance for estimation
    // drift), trim history messages from the oldest until we're under budget.
    // History is the most compressible slot — system/identity are never
    // truncated, and context (facts/recall/episodes) is more valuable per-token.
    const estimatedTotal = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const hardCeiling = Math.floor(budget * 1.05);

    if (estimatedTotal > hardCeiling) {
      const overage = estimatedTotal - budget;
      let trimmed = 0;
      let trimCount = 0;

      // Find history messages (non-system, after system/identity block)
      // Walk forward from the first non-system message, trimming oldest history first
      const firstNonSystemIdx = messages.findIndex(m => m.role !== 'system');
      if (firstNonSystemIdx >= 0) {
        let i = firstNonSystemIdx;
        while (i < messages.length && trimmed < overage) {
          // Don't trim the last user message (current prompt)
          if (i === messages.length - 1 && messages[i].role === 'user') break;
          const msgTokens = estimateMessageTokens(messages[i]);
          messages.splice(i, 1);
          trimmed += msgTokens;
          trimCount++;
          // Don't increment i — splice shifts everything down
        }
      }

      if (trimCount > 0) {
        slots.history = Math.max(0, slots.history - trimmed);
        remaining += trimmed;
        warnings.push(`Safety valve: trimmed ${trimCount} oldest history messages (${trimmed} tokens) to fit budget`);
      }
    }

    // ─── Translate to provider format (unless caller wants neutral) ───
    // When skipProviderTranslation is set, return NeutralMessages directly.
    // The context engine plugin uses this: the OpenClaw runtime handles its
    // own provider translation, so double-translating corrupts tool calls.
    const outputMessages = request.skipProviderTranslation
      ? messages as unknown as ProviderMessage[]
      : toProviderFormat(messages, request.provider ?? request.model ?? null);

    // T1.3: Strip warm-replay provenance flags before output.
    // _warmed is an internal tag added by warmSession() to mark messages
    // seeded from SQLite into Redis. It must not leak into provider submissions
    // or be visible to the runtime (which might misinterpret it).
    for (const msg of outputMessages) {
      const m = msg as unknown as NeutralMessage;
      if (m.metadata && (m.metadata as Record<string, unknown>)._warmed) {
        const { _warmed, ...cleanMeta } = m.metadata as Record<string, unknown>;
        (m as { metadata?: Record<string, unknown> }).metadata = Object.keys(cleanMeta).length > 0 ? cleanMeta : undefined;
      }
    }

    const totalTokens = budget - remaining;

    // ─── Write Window Cache ───────────────────────────────────
    // Cache the composed message array so the plugin can serve it directly
    // on the next assemble() call without re-running the full compose pipeline.
    // Short TTL (120s) — invalidated by afterTurn when new messages arrive.
    try {
      await this.redis.setWindow(request.agentId, request.sessionKey, messages, 120);
    } catch {
      // Window cache write is best-effort
    }

    // ─── Write Session Cursor ─────────────────────────────────
    // Record the newest message included in the submission window.
    // Background indexer uses this to find unprocessed high-signal content.
    if (request.includeHistory !== false && slots.history > 0) {
      try {
        const historyMsgs = messages.filter(m => m.role !== 'system');
        const lastHistoryMsg = historyMsgs.length > 0 ? historyMsgs[historyMsgs.length - 1] : null;
        if (lastHistoryMsg) {
          const sm = lastHistoryMsg as import('./types.js').StoredMessage;
          if (sm.id != null && sm.messageIndex != null) {
            const cursor: SessionCursor = {
              lastSentId: sm.id,
              lastSentIndex: sm.messageIndex,
              lastSentAt: new Date().toISOString(),
              windowSize: historyMsgs.length,
              tokenCount: totalTokens,
            };
            await this.redis.setCursor(request.agentId, request.sessionKey, cursor);

            // Dual-write cursor to SQLite for durability across Redis eviction (P1.3)
            try {
              db.prepare(`
                UPDATE conversations
                SET cursor_last_sent_id = ?,
                    cursor_last_sent_index = ?,
                    cursor_last_sent_at = ?,
                    cursor_window_size = ?,
                    cursor_token_count = ?
                WHERE session_key = ?
              `).run(
                cursor.lastSentId,
                cursor.lastSentIndex,
                cursor.lastSentAt,
                cursor.windowSize,
                cursor.tokenCount,
                request.sessionKey
              );
            } catch {
              // SQLite cursor write is best-effort — don't block compose
            }
          }
        }
      } catch {
        // Cursor write is best-effort
      }
    }

    // ─── Compaction Fence Update ──────────────────────────────
    // Record the oldest message ID that the LLM can see in this compose
    // cycle. Everything below this ID becomes eligible for compaction.
    // If history was included, query the DB for the oldest included message.
    if (request.includeHistory !== false && slots.history > 0) {
      try {
        const conversation = store.getConversation(request.sessionKey);
        if (conversation) {
          // The compositor included N history messages (after truncation).
          // Count how many non-system messages are in the output to determine
          // how far back we reached.
          const historyMsgCount = messages.filter(m => m.role !== 'system').length;
          if (historyMsgCount > 0) {
            // Get the oldest message we would have included.
            // getRecentMessages returns the last N in chronological order,
            // so the first element is the oldest included.
            const oldestIncluded = db.prepare(`
              SELECT id FROM messages
              WHERE conversation_id = ?
              ORDER BY message_index DESC
              LIMIT 1 OFFSET ?
            `).get(conversation.id, historyMsgCount - 1) as { id: number } | undefined;

            if (oldestIncluded) {
              ensureCompactionFenceSchema(db);
              updateCompactionFence(db, conversation.id, oldestIncluded.id);
            }
          }
        }
      } catch {
        // Fence update is best-effort — never fail composition
        warnings.push('Compaction fence update failed (non-fatal)');
      }
    }

    // W3: Build compose diagnostics
    let zeroResultReason: import('./types.js').ComposeDiagnostics['zeroResultReason'];
    if (contextParts.length === 0) {
      if (diagScopeFiltered > 0 && diagFactsIncluded === 0 && diagSemanticResults === 0) {
        zeroResultReason = 'scope_filtered_all';
      } else if (remaining <= 0) {
        zeroResultReason = 'budget_exhausted';
      } else if (diagTriggerHits === 0 && !diagTriggerFallbackUsed) {
        zeroResultReason = 'no_trigger_no_fallback';
      } else {
        zeroResultReason = 'empty_corpus';
      }
    }

    const diagnostics: import('./types.js').ComposeDiagnostics = {
      triggerHits: diagTriggerHits,
      triggerFallbackUsed: diagTriggerFallbackUsed,
      factsIncluded: diagFactsIncluded,
      semanticResultsIncluded: diagSemanticResults,
      docChunksCollections: diagDocChunkCollections,
      scopeFiltered: diagScopeFiltered,
      zeroResultReason,
      retrievalMode: diagRetrievalMode,
    };

    console.log(`[hypermem:compose] agent=${request.agentId} triggers=${diagTriggerHits} fallback=${diagTriggerFallbackUsed} facts=${diagFactsIncluded} semantic=${diagSemanticResults} chunks=${diagDocChunkCollections} scopeFiltered=${diagScopeFiltered} mode=${diagRetrievalMode}`);

    return {
      messages: outputMessages,
      tokenCount: totalTokens,
      slots,
      truncated: remaining < 0 || estimatedTotal > hardCeiling,
      hasWarnings: warnings.length > 0,
      warnings,
      contextBlock: assembledContextBlock,
      diagnostics,
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

    // Fetch a generous pool from SQLite, apply gradient transform, then
    // token-budget-cap the warm set. This replaces the old WARM_BOOTSTRAP_CAP
    // message-count constant which was a blunt instrument — 100 messages of
    // large tool results can massively exceed the history budget allocation.
    const warmBudget = Math.floor(
      (this.config.defaultTokenBudget) * (this.config.warmHistoryBudgetFraction ?? 0.4)
    );
    const rawHistory = store.getRecentMessages(conversation.id, this.config.maxHistoryMessages);
    const transformedForWarm = applyToolGradient(
      rawHistory,
      this.config.maxRecentToolPairs ?? 3,
      this.config.maxProseToolPairs ?? 10,
    );

    // Walk newest→oldest, accumulate transformed token cost, stop when budget exhausted
    let warmTokens = 0;
    const history: typeof rawHistory = [];
    for (let i = transformedForWarm.length - 1; i >= 0; i--) {
      const cost = estimateMessageTokens(transformedForWarm[i]);
      if (warmTokens + cost > warmBudget) break;
      // T1.3 Provenance flag: tag warm-seeded messages so they can be identified
      // downstream. The flag is stripped before provider submission in compose().
      // This prevents the runtime from treating warm-replayed user messages as
      // new inbound queries (ghost message bug).
      const tagged = { ...transformedForWarm[i] } as typeof rawHistory[0];
      tagged.metadata = { ...(tagged.metadata || {}), _warmed: true };
      history.unshift(tagged);
      warmTokens += cost;
    }

    const libDb = opts?.libraryDb || this.libraryDb;

    // Note: facts and context are intentionally NOT cached here.
    // compose() calls buildFactsFromDb() and buildCrossSessionContext() directly
    // from SQLite on every turn (~0.3ms each) — faster than a Redis GET round-trip.
    // Caching them here would create stale entries that compose() ignores anyway.

    await this.redis.warmSession(agentId, sessionKey, {
      system: opts?.systemPrompt,
      identity: opts?.identity,
      history,
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
      case 'facts': {
        const result = this.buildFactsFromDb(agentId, sessionKey, libraryDb || this.libraryDb || db);
        return result ? result[0] : null;
      }
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
    // Pass limit through to Redis — this is the correct enforcement point.
    // Previously getHistory() ignored the limit on the Redis path (LRANGE 0 -1),
    // meaning historyDepth in the compose request had no effect on hot sessions.
    const cached = await this.redis.getHistory(agentId, sessionKey, limit);
    if (cached.length > 0) return cached;

    const conversation = store.getConversation(sessionKey);
    if (!conversation) return [];

    return store.getRecentMessages(conversation.id, limit);
  }

  // ─── L4 Library Builders ─────────────────────────────────────

  /**
   * Build facts content from library DB.
   */
  /**
   * Build facts content from library DB.
   * Applies filterByScope (W1) to enforce retrieval access control.
   * Returns [content, factCount, scopeFilteredCount] or null if DB unavailable.
   */
  private buildFactsFromDb(
    agentId: string,
    sessionKey: string,
    db: DatabaseSync | null,
  ): [string | null, number, number] | null {
    if (!db) return null;

    const tableExists = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='facts'"
    ).get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) return null;

    const rawRows = db.prepare(`
      SELECT content, domain, confidence, agent_id, source_session_key AS session_key, scope FROM facts
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
      agent_id: string | null;
      session_key: string | null;
      scope: string | null;
    }>;

    if (rawRows.length === 0) return [null, 0, 0];

    // W1: Apply scope filter — enforce retrieval access control
    const ctx = { agentId, sessionKey };
    const { allowed, filteredCount } = filterByScope(
      rawRows.map(r => ({
        ...r,
        agentId: r.agent_id,
        sessionKey: r.session_key,
      })),
      ctx,
    );

    if (allowed.length === 0) return [null, 0, filteredCount];

    const content = allowed
      .map(r => `- [${r.domain || 'general'}] ${r.content}`)
      .join('\n');

    return [content, allowed.length, filteredCount];
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
   *
   * @param precomputedEmbedding — optional pre-computed embedding for the query.
   *   When provided, the Ollama call inside VectorStore.search() is skipped.
   */
  private async buildSemanticRecall(
    userMessage: string,
    agentId: string,
    maxTokens: number,
    libraryDb?: DatabaseSync,
    precomputedEmbedding?: Float32Array
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
        precomputedEmbedding,
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
      precomputedEmbedding,
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

  // ─── Keystone History Builder ─────────────────────────────────────

  /**
   * Query and score keystone candidates from before the current history window.
   *
   * Trims the oldest messages from includedHistory to free a keystone budget,
   * then queries the DB for older messages scored by episode significance,
   * FTS5 relevance, and recency.
   *
   * Returns null if keystones cannot be injected (no cutoff ID found,
   * no candidates, or all errors).
   */
  private async buildKeystones(
    db: DatabaseSync,
    agentId: string,
    includedHistory: NeutralMessage[],
    historyTokens: number,
    keystoneFraction: number,
    keystoneMaxMsgs: number,
    prompt?: string,
    libraryDb?: DatabaseSync
  ): Promise<{
    keystoneMessages: NeutralMessage[];
    keystoneTokens: number;
    trimmedHistory: NeutralMessage[];
    trimmedHistoryTokens: number;
  } | null> {
    const keystoneBudget = Math.floor(historyTokens * keystoneFraction);
    if (keystoneBudget <= 0) return null;

    // Trim oldest messages from includedHistory to free keystone budget.
    const trimmedHistory = [...includedHistory];
    let trimmedHistoryTokens = historyTokens;
    let freed = 0;
    while (trimmedHistory.length > 1 && freed < keystoneBudget) {
      const oldest = trimmedHistory.shift()!;
      const oldestTokens = estimateMessageTokens(oldest);
      freed += oldestTokens;
      trimmedHistoryTokens -= oldestTokens;
    }

    // Find the oldest message ID in the trimmed recent window (cutoff point).
    const oldestRecentMsg = trimmedHistory[0] as StoredMessage;
    const cutoffId = (oldestRecentMsg as StoredMessage)?.id ?? null;
    if (cutoffId == null) return null;

    // Find the current user prompt for FTS matching.
    const promptForFts = prompt?.trim() ||
      (() => {
        for (let i = trimmedHistory.length - 1; i >= 0; i--) {
          if (trimmedHistory[i].role === 'user' && trimmedHistory[i].textContent) {
            return trimmedHistory[i].textContent!;
          }
        }
        return null;
      })();

    try {
      // Get the conversation ID from the oldest recent message.
      const convRow = db.prepare(
        'SELECT conversation_id FROM messages WHERE id = ?'
      ).get(cutoffId) as { conversation_id: number } | undefined;

      if (!convRow) return null;

      const conversationId = convRow.conversation_id;
      const maxAgeHours = 720; // 30 days for recency scoring
      const nowMs = Date.now();

      // Build episode significance map from libraryDb (episodes live there, not in messages.db).
      // Key: source_message_id, Value: max significance for that message.
      const sigMap = new Map<number, number>();
      if (libraryDb) {
        try {
          const episodeRows = libraryDb.prepare(`
            SELECT source_message_id, MAX(significance) AS significance
            FROM episodes
            WHERE agent_id = ? AND source_message_id IS NOT NULL
            GROUP BY source_message_id
          `).all(agentId) as Array<{ source_message_id: number; significance: number }>;
          for (const row of episodeRows) {
            sigMap.set(row.source_message_id, row.significance);
          }
        } catch {
          // Episodes query is best-effort
        }
      }

      type CandidateRow = {
        id: number;
        message_index: number;
        role: string;
        text_content: string | null;
        created_at: string;
      };

      const baseQuery = `
        SELECT
          m.id,
          m.message_index,
          m.role,
          m.text_content,
          m.created_at
        FROM messages m
        WHERE m.conversation_id = ?
          AND m.id < ?
          AND m.text_content IS NOT NULL
          AND m.is_heartbeat = 0
          AND m.text_content != ''
        LIMIT 200
      `;

      let candidateRows: CandidateRow[];

      if (promptForFts && promptForFts.length >= 3) {
        // Build a safe FTS5 query: extract words ≥3 chars, up to 8, OR with prefix.
        const ftsTerms = (promptForFts.match(/\b\w{3,}\b/g) || [])
          .slice(0, 8)
          .map(w => `"${w.replace(/"/g, '')}"*`)
          .join(' OR ');

        if (ftsTerms) {
          try {
            candidateRows = db.prepare(`
              SELECT
                m.id,
                m.message_index,
                m.role,
                m.text_content,
                m.created_at
              FROM messages m
              WHERE m.conversation_id = ?
                AND m.id < ?
                AND m.text_content IS NOT NULL
                AND m.is_heartbeat = 0
                AND m.text_content != ''
                AND m.id IN (
                  SELECT rowid FROM messages_fts
                  WHERE messages_fts MATCH ?
                  LIMIT 100
                )
              LIMIT 200
            `).all(conversationId, cutoffId, ftsTerms) as CandidateRow[];
          } catch {
            // FTS query may fail on special characters — fall back to base query
            candidateRows = db.prepare(baseQuery).all(conversationId, cutoffId) as CandidateRow[];
          }
        } else {
          candidateRows = db.prepare(baseQuery).all(conversationId, cutoffId) as CandidateRow[];
        }
      } else {
        candidateRows = db.prepare(baseQuery).all(conversationId, cutoffId) as CandidateRow[];
      }

      if (candidateRows.length === 0) return null;

      // Build KeystoneCandidate objects with computed ftsRank and ageHours.
      const totalCandidates = candidateRows.length;
      const candidates: KeystoneCandidate[] = candidateRows.map((row, idx) => {
        const createdMs = new Date(row.created_at).getTime();
        const ageHours = (nowMs - createdMs) / (1000 * 60 * 60);
        // Normalize FTS rank by position (best match = 1.0, worst = 0.1)
        const ftsRank = totalCandidates > 1
          ? 1.0 - (idx / totalCandidates) * 0.9
          : 1.0;

        return {
          messageId: row.id,
          messageIndex: row.message_index,
          role: row.role,
          content: row.text_content || '',
          timestamp: row.created_at,
          episodeSignificance: sigMap.get(row.id) ?? null,
          ftsRank,
          ageHours,
        };
      });

      // Score and rank candidates.
      const ranked = rankKeystones(candidates, maxAgeHours);

      // Budget-fit: take top-scored candidates until keystoneBudget exhausted.
      let kTokens = 0;
      const selectedKeystones: KeystoneCandidate[] = [];

      for (const candidate of ranked) {
        if (selectedKeystones.length >= keystoneMaxMsgs) break;
        const msg: NeutralMessage = {
          role: candidate.role as NeutralMessage['role'],
          textContent: candidate.content,
          toolCalls: null,
          toolResults: null,
        };
        const msgTokens = estimateMessageTokens(msg);
        if (kTokens + msgTokens > keystoneBudget) continue; // skip oversized; keep trying
        selectedKeystones.push(candidate);
        kTokens += msgTokens;
      }

      if (selectedKeystones.length === 0) return null;

      // Sort selected keystones chronologically for injection.
      selectedKeystones.sort((a, b) => a.messageIndex - b.messageIndex);

      const keystoneMessages: NeutralMessage[] = selectedKeystones.map(c => ({
        role: c.role as NeutralMessage['role'],
        textContent: c.content,
        toolCalls: null,
        toolResults: null,
      }));

      return {
        keystoneMessages,
        keystoneTokens: kTokens,
        trimmedHistory,
        trimmedHistoryTokens,
      };
    } catch {
      // Keystone injection is best-effort — never fail compose
      return null;
    }
  }
}
