/**
 * HyperMem Core Types
 *
 * Provider-neutral message format and compositor interfaces.
 * These types are the internal representation — never sent directly to an LLM.
 * Provider translators convert to/from provider-specific formats at the boundary.
 */

// ─── Message Types ───────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

/**
 * Provider-neutral tool call representation.
 * Stored as JSON in the tool_calls column.
 */
export interface NeutralToolCall {
  id: string;                    // HyperMem-assigned ID (hm_xxxx), never provider-format
  name: string;                  // tool/function name
  arguments: string;             // JSON string of arguments
}

/**
 * Provider-neutral tool result representation.
 * Stored as JSON in the tool_results column.
 */
export interface NeutralToolResult {
  callId: string;                // matches NeutralToolCall.id
  name: string;                  // tool/function name
  content: string;               // result content (text)
  isError?: boolean;
}

/**
 * Provider-neutral message — the canonical storage format.
 */
export interface NeutralMessage {
  role: MessageRole;
  textContent: string | null;
  toolCalls: NeutralToolCall[] | null;
  toolResults: NeutralToolResult[] | null;
  metadata?: Record<string, unknown>;  // provider-specific data, never sent to LLM
}

/**
 * Stored message with database fields.
 */
export interface StoredMessage extends NeutralMessage {
  id: number;
  conversationId: number;
  agentId: string;
  messageIndex: number;
  tokenCount: number | null;
  isHeartbeat: boolean;
  createdAt: string;
}

// ─── Conversation Types ──────────────────────────────────────────

export type ChannelType = 'webchat' | 'discord' | 'telegram' | 'signal' | 'subagent' | 'heartbeat' | 'other';
export type ConversationStatus = 'active' | 'ended' | 'archived';

export interface Conversation {
  id: number;
  sessionKey: string;
  sessionId: string | null;
  agentId: string;
  channelType: ChannelType;
  channelId: string | null;
  provider: string | null;
  model: string | null;
  status: ConversationStatus;
  messageCount: number;
  tokenCountIn: number;
  tokenCountOut: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

// ─── Fact Types ──────────────────────────────────────────────────

export type FactScope = 'agent' | 'session' | 'user';

// ─── Visibility / Cross-Agent Access ────────────────────────────

/**
 * Memory visibility levels:
 * - private:  Only the owning agent can read. Identity, SOUL, personal reflections.
 * - org:      Agents in the same org (e.g., Forge's directors: Pylon, Vigil, Plane).
 * - council:  All council seats can read.
 * - fleet:    Any agent in the fleet can read.
 */
export type MemoryVisibility = 'private' | 'org' | 'council' | 'fleet';

/**
 * Cross-agent query request. The requesting agent declares who they are;
 * the access layer filters results by visibility.
 */
export interface CrossAgentQuery {
  /** The agent making the request */
  requesterId: string;
  /** The agent whose memory is being queried */
  targetAgentId: string;
  /** What to search for */
  query?: string;
  /** Filter by domain */
  domain?: string;
  /** Filter by memory type */
  memoryType?: 'facts' | 'knowledge' | 'topics' | 'episodes' | 'messages';
  /** Max results */
  limit?: number;
}

/**
 * Defines an agent's org and tier for visibility resolution.
 */
export interface AgentIdentity {
  agentId: string;
  tier: 'council' | 'director' | 'specialist' | 'worker';
  org?: string;         // e.g., 'forge-org', 'compass-org', 'sentinel-org'
  councilLead?: string; // director's council lead, e.g., 'forge' for Pylon
}

export interface Fact {
  id: number;
  agentId: string;
  scope: FactScope;
  domain: string | null;
  content: string;
  confidence: number;
  visibility: string;
  sourceType: string;
  sourceSessionKey: string | null;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  supersededBy: number | null;
  decayScore: number;
}

// ─── Topic Types ─────────────────────────────────────────────────

export type TopicStatus = 'active' | 'dormant' | 'closed';

export interface Topic {
  id: number;
  agentId: string;
  name: string;
  description: string | null;
  status: TopicStatus;
  visibility: string;
  lastSessionKey: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Knowledge Types ─────────────────────────────────────────────

export interface Knowledge {
  id: number;
  agentId: string;
  domain: string;
  key: string;
  content: string;
  confidence: number;
  sourceType: string;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  supersededBy: number | null;
}

// ─── Episode Types ───────────────────────────────────────────────

export type EpisodeType = 'decision' | 'incident' | 'discovery' | 'interaction' | 'milestone' | 'deployment' | 'config_change';

export interface Episode {
  id: number;
  agentId: string;
  eventType: EpisodeType;
  summary: string;
  significance: number;
  visibility: string;
  participants: string[] | null;
  sessionKey: string | null;
  createdAt: string;
  decayScore: number;
}

// ─── Compositor Types ────────────────────────────────────────────

export interface ComposeRequest {
  agentId: string;
  sessionKey: string;
  tokenBudget: number;
  provider?: string;
  model?: string;
  /** Agent tier (council/director/specialist) — used for tier-scoped doc chunk retrieval */
  tier?: string;
  includeHistory?: boolean;
  /** Whether to include demand-loaded doc chunks based on conversation triggers */
  includeDocChunks?: boolean;
  historyDepth?: number;
  includeFacts?: boolean;
  includeContext?: boolean;
  includeLibrary?: boolean;
  /**
   * The current-turn prompt text. Used as the retrieval query for semantic recall
   * and doc chunk trigger matching. When provided, this is preferred over reading
   * the last user message from the assembled history (which is one turn stale).
   *
   * Without this, retrieval fires against the previously-recorded user message,
   * meaning first-turn retrieval is blind and all retrieval lags by one turn.
   */
  prompt?: string;
  /**
   * When true, skip provider-specific translation and return NeutralMessage[]
   * instead of ProviderMessage[]. Used by the context engine plugin, which
   * returns messages to the OpenClaw runtime for its own provider translation.
   */
  skipProviderTranslation?: boolean;
}

export interface SlotTokenCounts {
  system: number;
  identity: number;
  history: number;
  facts: number;
  context: number;
  library: number;
}

/**
 * Compose-level diagnostics — emitted on every compose() call.
 * Useful for observability, tuning, and debugging retrieval quality.
 */
export interface ComposeDiagnostics {
  /** Number of doc chunk trigger collections that matched the user message */
  triggerHits: number;
  /** True when trigger-miss fallback semantic retrieval was used */
  triggerFallbackUsed: boolean;
  /** Number of facts included after scope filtering */
  factsIncluded: number;
  /** Approximate number of lines returned by semantic recall */
  semanticResultsIncluded: number;
  /** Number of doc chunk collections that returned at least one chunk */
  docChunksCollections: number;
  /** Number of items rejected by scope policy during retrieval */
  scopeFiltered: number;
  /**
   * Why contextParts was empty (only set when no context was assembled).
   * Helps distinguish between "no triggers + no fallback", "empty corpus",
   * "budget exhausted", and "all items filtered by scope".
   */
  zeroResultReason?: 'no_trigger_no_fallback' | 'empty_corpus' | 'budget_exhausted' | 'scope_filtered_all';
  /** The retrieval path that was used for doc chunks */
  retrievalMode: 'triggered' | 'fallback_knn' | 'fallback_fts' | 'none';
}

export interface ComposeResult {
  messages: ProviderMessage[];
  tokenCount: number;
  slots: SlotTokenCounts;
  /** True only when token budget was exceeded (remaining < 0). */
  truncated: boolean;
  /** True when any non-fatal warnings were emitted (soft failures, truncated slots, etc.). */
  hasWarnings: boolean;
  warnings: string[];
  /**
   * The assembled context block (facts, recall, episodes) as a plain string.
   * Used by the plugin to pass as systemPromptAddition to the OpenClaw runtime.
   * Omitted when no context was assembled.
   */
  contextBlock?: string;
  /** Compose-level diagnostics for observability and tuning. */
  diagnostics?: ComposeDiagnostics;
}

/**
 * Provider-specific message format (output of compositor).
 * This is what gets sent to the LLM API.
 * The exact shape depends on the provider translator.
 */
export interface ProviderMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

// ─── Session Cursor ──────────────────────────────────────────────

/**
 * Tracks the most recently composed submission window boundary.
 * Written by compose() after every assembly, read by the background indexer
 * to identify high-signal unprocessed messages.
 *
 * Stored in Redis (hm:{a}:s:{s}:cursor) with dual-write to SQLite for
 * durability across Redis eviction (Compass Gate 2).
 */
export interface SessionCursor {
  /** StoredMessage.id of the newest message included in the last window */
  lastSentId: number;
  /** messageIndex of the newest message — for ordering guarantees */
  lastSentIndex: number;
  /** ISO timestamp of when the window was composed */
  lastSentAt: string;
  /** Number of messages in the composed window */
  windowSize: number;
  /** Token count of the composed window */
  tokenCount: number;
}

// ─── Redis Slot Types ────────────────────────────────────────────

export interface SessionSlots {
  system: string | null;
  identity: string | null;
  history: StoredMessage[];
  context: string | null;
  facts: string | null;
  tools: string | null;
  meta: SessionMeta;
}

export interface SessionMeta {
  agentId: string;
  sessionKey: string;
  provider: string | null;
  model: string | null;
  channelType: ChannelType;
  tokenCount: number;
  lastActive: string;
  status: ConversationStatus;
}

// ─── Config Types ────────────────────────────────────────────────

export interface HyperMemConfig {
  enabled: boolean;
  dataDir: string;
  redis: RedisConfig;
  compositor: CompositorConfig;
  indexer: IndexerConfig;
  embedding: EmbeddingProviderConfig;
}

export interface EmbeddingProviderConfig {
  /** Ollama base URL. Default: http://localhost:11434 */
  ollamaUrl: string;
  /** Embedding model name. Default: nomic-embed-text */
  model: string;
  /** Embedding dimensions. Default: 768 */
  dimensions: number;
  /** Request timeout ms. Default: 10000 */
  timeout: number;
  /** Max texts per batch request. Default: 32 */
  batchSize: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  keyPrefix: string;
  sessionTTL: number;        // seconds — TTL for non-history slots (system, identity, etc.)
  historyTTL: number;        // seconds — TTL for history list (longer than session, data ages out)
  flushInterval: number;     // milliseconds
}

export interface CompositorConfig {
  defaultTokenBudget: number;
  maxHistoryMessages: number;
  maxFacts: number;
  maxCrossSessionContext: number;  // tokens
  /**
   * How many recent tool call/result pairs to keep verbatim in history.
   * Tool call/result content beyond this threshold gets prose-stub treatment.
   * Default: 3
   */
  maxRecentToolPairs: number;
  /**
   * How many tool pairs beyond the verbatim threshold to convert to heuristic
   * prose stubs (e.g. "Read /src/foo.ts (1.2KB)"). Pairs beyond this are
   * dropped entirely (text content preserved, tool payloads nulled).
   * Default: 10
   */
  maxProseToolPairs: number;
  /**
   * Fraction of defaultTokenBudget to allocate for history during warm bootstrap.
   * Replaces the old WARM_BOOTSTRAP_CAP message-count constant.
   * Default: 0.4 (40% of defaultTokenBudget)
   */
  warmHistoryBudgetFraction: number;
  /**
   * Fraction of history token budget to allocate for keystone (recalled older) messages.
   * Range: 0.0–0.5. Default: 0.2 (20% of history budget).
   * Set to 0 to disable keystone injection.
   */
  keystoneHistoryFraction?: number;
  /**
   * Maximum number of keystone messages to inject.
   * Default: 15
   */
  keystoneMaxMessages?: number;
  /**
   * Minimum episode significance for a message to be considered as a keystone.
   * Only applies when episode significance is available (not null).
   * Default: 0.5
   */
  keystoneMinSignificance?: number;
  // Note: assembly order is fixed in compose() — system, identity, history,
  // facts, knowledge, preferences, semanticRecall, cross-session, library.
  //
  // History trimming strategy: Redis stores up to maxHistoryMessages (default 1000).
  // Budget-based trimming happens at compose time, not storage time.
  // This ensures the compositor always has access to the full recent window
  // and can make intelligent decisions about what to include.
}

export interface IndexerConfig {
  enabled: boolean;
  factExtractionMode: 'off' | 'pattern' | 'tiered';
  topicDormantAfter: string;   // duration string e.g. '24h'
  topicClosedAfter: string;
  factDecayRate: number;
  episodeSignificanceThreshold: number;
  periodicInterval: number;    // milliseconds
}
