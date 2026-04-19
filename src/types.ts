/**
 * hypermem Core Types
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
  id: string;                    // hypermem-assigned ID (hm_xxxx), never provider-format
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
 * - org:      Agents in the same org (e.g., agent1's directors: Pylon, Vigil, Plane).
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
  org?: string;         // e.g., 'agent1-org', 'agent2-org', 'agent3-org'
  councilLead?: string; // director's council lead, e.g., 'agent1' for Pylon
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
  validFrom: string | null;    // ISO-8601 timestamp: when this fact became true
  invalidAt: string | null;    // ISO-8601 timestamp: when this fact stopped being true
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

/**
 * A single turn from a parent session, stripped of tool call content.
 * Used to build spawn context for subagents.
 */
export interface RecentTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  seq: number;
}

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
  /** When false, skip semantic recall (vector search + FTS hybrid). Default: true. */
  includeSemanticRecall?: boolean;
  /** When false, skip keystone history injection (within-session + cross-topic). Default: true. */
  includeKeystones?: boolean;
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
   * When set, session-scoped doc chunks stored under this spawn session key
   * are included in doc chunk retrieval at compose time.
   * Used for subagent context inheritance: the parent buildSpawnContext() stores
   * document chunks under a spawn sessionKey, and passes that key here so the
   * compositor can surface them during composition.
   */
  parentSessionKey?: string;
  /**
   * When true, skip provider-specific translation and return NeutralMessage[]
   * instead of ProviderMessage[]. Used by the context engine plugin, which
   * returns messages to the OpenClaw runtime for its own provider translation.
   */
  skipProviderTranslation?: boolean;
  /**
   * When set, history fetching is scoped to this topic (Option B: also includes
   * legacy messages with topic_id IS NULL for transition safety).
   * If not provided, full session history is returned (no behavior change).
   * P3.4: topic-aware compositor.
   */
  topicId?: string;
  /**
   * When true, skip the C4 window cache fast-exit even if the cursor is fresh.
   * Use this when external L4 state changed between turns, for example facts,
   * wiki pages, or other library-backed context updated out of band.
   */
  skipWindowCache?: boolean;
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
  zeroResultReason?: 'no_trigger_no_fallback' | 'empty_corpus' | 'budget_exhausted' | 'scope_filtered_all' | 'unknown';
  /** The retrieval path that was used for doc chunks */
  retrievalMode: 'triggered' | 'fallback_knn' | 'fallback_fts' | 'none';
  /** Number of cross-topic keystone messages injected (P3.5) */
  crossTopicKeystones?: number;
  /** Actual reserve fraction used this compose (base or dynamic) */
  reserveFraction?: number;
  /** Estimated average turn cost (tokens) used in dynamic reserve calc */
  avgTurnCostTokens?: number;
  /** True if dynamic reserve exceeded floor and is actively adjusting budget */
  dynamicReserveActive?: boolean;
  /** True if dynamic reserve was clamped at dynamicReserveMax and SESSION_PRESSURE_HIGH emitted */
  sessionPressureHigh?: boolean;
  /** Number of items filtered across all dedup paths (temporal, open-domain, semantic, cross-session) */
  fingerprintDedups?: number;
  /** Number of duplicate-prefix matches where the full normalized content differed */
  fingerprintCollisions?: number;
  /** True when the window cache fast-exit fired and full compose was skipped */
  windowCacheHit?: boolean;
  /** Number of system messages in the stable cacheable prefix */
  prefixSegmentCount?: number;
  /** Estimated token cost of the stable cacheable prefix */
  prefixTokens?: number;
  /** Deterministic hash of the stable cacheable prefix content */
  prefixHash?: string;
  /**
   * The prefixHash stored in the window cache from the previous compose.
   * Emitted on full-compose passes when a cached bundle was found but had a
   * different prefixHash (i.e. stable prefix changed). Useful for verifying
   * that prefix mutations correctly bypassed the C4 fast-exit.
   */
  prevPrefixHash?: string;
  /** Estimated token cost of all content below the stable prefix boundary */
  volatileHistoryTokens?: number;
  // ── Sprint 4: pre-compose history depth tightening ──────────────────────
  /**
   * Session type derived from observed message density.
   * 'plain-chat'  — text-only or low tool ratio (< 20% tool messages)
   * 'tool-heavy'  — high tool ratio (>= 20% tool messages in recent sample)
   */
  sessionType?: 'plain-chat' | 'tool-heavy';
  /** The history depth actually requested from the store this compose pass. */
  historyDepthChosen?: number;
  /** Average estimated tokens per message observed in the density sample. */
  estimatedMsgDensityTokens?: number;
  /**
   * True when budget-fit walk had to drop history clusters after gradient transform.
   * Should be false in steady state for well-classified sessions.
   */
  rescueTrimFired?: boolean;
  // ── B4: Model-aware lane budgets ─────────────────────────────────────────────────────────────────────────────
  /**
   * MECW model profile that matched (e.g. 'claude', 'gemini', 'gpt').
   * Undefined when no MECW entry matched for the current model.
   */
  mecwProfile?: string;
  /**
   * True when MECW blending adjusted the historyFraction or memoryFraction
   * from the configured defaults. Indicates model-aware lane adjustment fired.
   */
  mecwApplied?: boolean;
  /**
   * Linear blend factor used in MECW lane adjustment (0.0 = below MECW floor,
   * 1.0 = at/above MECW ceiling). At 0 the config fractions are used unchanged;
   * at 1 the preferred fractions are used in full.
   */
  mecwBlend?: number;
  /**
   * Effective historyFraction used this compose pass (post-B4 blending).
   * Compare against the configured historyFraction to see how much B4 moved it.
   */
  effectiveHistoryFraction?: number;
  /**
   * Effective memoryFraction used this compose pass (post-B4 blending).
   */
  effectiveMemoryFraction?: number;
  /** Canonical trim soft-target fraction shared by compose and afterTurn refresh. */
  trimSoftTarget?: number;
  /** Canonical growth-allowance fraction before steady-state trim fires. */
  trimGrowthThreshold?: number;
  /** Canonical headroom fraction used when steady-state trim does fire. */
  trimHeadroomFraction?: number;
  // ── C1: Tool-chain ejection telemetry ─────────────────────────────────────
  /**
   * Number of tool-result messages co-ejected alongside their parent tool-use
   * during the safety-valve or cluster-drop trim pass.
   * A co-ejected result is fully removed (zero budget cost).
   */
  toolChainCoEjections?: number;
  /**
   * Number of tool-result messages stubbed with the canonical ToolChainStub
   * format because their parent tool-use was ejected but the result message
   * could not be cleanly removed (e.g. the result message also carries text).
   */
  toolChainStubReplacements?: number;
  /**
   * C2: Number of retrieved doc chunks degraded to canonical ArtifactRef references
   * because their token cost exceeded the model-aware oversize threshold.
   */
  artifactDegradations?: number;
  /**
   * C2: The computed artifact oversize threshold (tokens) for this compose pass.
   * Scales with the effective model budget from B4.
   */
  artifactOversizeThresholdTokens?: number;
  // ── Sprint 2.1: Tool artifact hydration ─────────────────────────────────
  /** Number of artifact stubs rehydrated from tool_artifacts in the active turn. */
  artifactsHydrated?: number;
  /** Total bytes of payload injected by hydration this compose pass. */
  hydrationBytes?: number;
  /** Number of stubs whose artifact lookup returned no row (graceful miss). */
  hydrationMisses?: number;
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
 * durability across Redis eviction (agent2 Gate 2).
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
  cache: CacheConfig;
  compositor: CompositorConfig;
  indexer: IndexerConfig;
  embedding: EmbeddingProviderConfig;
  /** Optional dreaming/promotion config. Default: disabled. */
  dreaming?: import('./dreaming-promoter.js').DreamerConfig;
  /** Optional Obsidian vault integration. Default: disabled. */
  obsidian?: import('./obsidian-watcher.js').ObsidianConfig;
  /** Startup sweep that seeds fleet_agents from workspace identity files. Default: true. */
  startupFleetSeeding?: boolean;
  /**
   * Cache replay threshold (ms). When > 0, assemble() returns a cached
   * contextBlock (systemPromptAddition) for sessions active within this
   * window, producing byte-identical prompts and hitting provider prefix cache
   * (Anthropic / OpenAI). Set to 0 to disable.
   * Default: 900_000 (15 minutes).
   */
  warmCacheReplayThresholdMs?: number;
}

export interface EmbeddingProviderConfig {
  /**
   * Embedding provider. Default: 'ollama'.
   * - 'none': disable all embedding calls — semantic search disabled, FTS5 fallback only
   * - 'ollama': local Ollama (nomic-embed-text or any pulled model)
   * - 'openai': OpenAI Embeddings API (text-embedding-3-small / 3-large)
   */
  provider?: 'none' | 'ollama' | 'openai' | 'gemini';
  /** Ollama base URL. Default: http://localhost:11434 */
  ollamaUrl: string;
  /** OpenAI API key. Required when provider is 'openai'. */
  openaiApiKey?: string;
  /** OpenAI base URL. Default: https://api.openai.com/v1 */
  openaiBaseUrl?: string;
  /** Gemini API key. Alternative to OAuth — passed as ?key= query param. */
  geminiApiKey?: string;
  /** Gemini API base URL. Default: https://generativelanguage.googleapis.com */
  geminiBaseUrl?: string;
  /** Gemini task type for indexing. Default: RETRIEVAL_DOCUMENT */
  geminiIndexTaskType?: string;
  /** Gemini task type for queries. Default: RETRIEVAL_QUERY */
  geminiQueryTaskType?: string;
  /**
   * Embedding model name.
   * - ollama default: nomic-embed-text (768d)
   * - openai default: text-embedding-3-small (1536d)
   */
  model: string;
  /**
   * Embedding dimensions. Must match the model.
   * - nomic-embed-text: 768
   * - text-embedding-3-small: 1536
   * - text-embedding-3-large: 3072
   * WARNING: changing providers requires a full re-index (dimensions are incompatible).
   */
  dimensions: number;
  /** Request timeout ms. Default: 10000 */
  timeout: number;
  /** Max texts per batch request. Default: 32 (ollama) or 128 (openai) */
  batchSize: number;
}

export interface CacheConfig {
  keyPrefix: string;
  sessionTTL: number;        // seconds — TTL for non-history slots
  historyTTL: number;        // seconds — TTL for history list
}

/** @deprecated Use CacheConfig */
export type RedisConfig = CacheConfig;

export interface CompositorConfig {
  /**
   * Fraction of the detected context window to use as the input token budget.
   * The effective budget is: detectedContextWindow × budgetFraction.
   * reserveFraction is then subtracted for output/tool-call headroom.
   *
   * Range: 0.3–0.85. Default: 0.70
   */
  budgetFraction?: number;
  /**
   * Fraction of the total token budget to reserve for model output and tool
   * call responses. Higher = more headroom for large tool results.
   *
   * Range: 0.10–0.50. Default: 0.25
   */
  reserveFraction?: number;
  /**
   * Fraction of the effective token budget (post-reserve) allocated to
   * conversation history. History fills up to this cap before context slots run.
   *
   * Range: 0.20–0.60. Default: 0.40
   */
  historyFraction?: number;
  /**
   * Fraction of the effective token budget (post-reserve) allocated to the
   * memory pool: facts, wiki, semantic recall, cross-session context, and
   * trigger-fired doc chunks all draw from this shared pool.
   *
   * Range: 0.20–0.70. Default: 0.45
   * Note: historyFraction + memoryFraction should be ≤ 0.90 to leave room
   * for fixed-cost slots (system, identity, HyperForm: typically 3–8k tokens).
   */
  memoryFraction?: number;
  /**
   * @deprecated Use budgetFraction instead. Absolute token fallback used when
   * model detection fails and budgetFraction is not set.
   */
  defaultTokenBudget: number;
  maxHistoryMessages: number;
  /** @advanced Replaced by memoryFraction for primary tuning. Hard per-fetch fact count cap. */
  maxFacts: number;
  maxCrossSessionContext: number;  // tokens
  /**
   * @advanced Aggregate token ceiling across all trigger-fired doc chunk
   * collections in a single compose pass. When unset, draws from the memoryFraction
   * pool. Rarely needs manual tuning.
   */
  maxTotalTriggerTokens?: number;
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
   * @advanced Use reserveFraction instead.
   * Fraction of the model context window to reserve for output tokens.
   * Falls back to reserveFraction when set. Default: 0.25
   */
  contextWindowReserve?: number;
  /**
   * Number of turns to project forward when computing dynamic reserve.
   * safety_tokens = avg_turn_cost × dynamicReserveTurnHorizon
   * Default: 5
   */
  dynamicReserveTurnHorizon?: number;
  /**
   * Hard ceiling on the dynamic reserve fraction. When the projected safety
   * tokens would push reserve above this, SESSION_PRESSURE_HIGH is emitted
   * in diagnostics and reserve is clamped here.
   * Default: 0.50
   */
  dynamicReserveMax?: number;
  /**
   * Kill switch for dynamic reserve. Set false to use fixed contextWindowReserve only.
   * Default: true
   */
  dynamicReserveEnabled?: boolean;
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
  /**
   * @advanced Use memoryFraction instead.
   * Fraction of the effective budget to target for context assembly.
   * Honored as a fallback when memoryFraction is not set.
   * Range: 0.3–0.85. Default: 0.65
   */
  targetBudgetFraction?: number;
  /**
   * Enable Fleet Output Standard (FOS) injection.
   * FOS injects shared output rules (no em dashes, lead with answer, etc.) into
   * every composed context. Disable if the operator manages output standards
   * externally (e.g. via system prompt) to avoid redundancy.
   * Default: true
   */
  enableFOS?: boolean;
  /**
   * Enable Model Output Directive (MOD) injection.
   * MOD injects per-model calibration corrections (verbosity, list length, etc.).
   * Disable if you want raw model behavior without hypermem calibration.
   * Default: true
   */
  enableMOD?: boolean;
  /**
   * HyperForm output shaping profile. Controls what FOS/MOD content is injected.
   *
   * 'light'    — ~100 token standalone directives. No MOD, no fleet concepts.
   * 'standard' — Full FOS: density targets, format rules, compression ratios.
   * 'full'     — FOS + MOD. Cross-agent coordination, full spec.
   *
   * Backward compat: 'starter' maps to 'light', 'fleet' maps to 'full'.
   * Default: 'full' (backward-compatible). New install default: 'light'.
   */
  hyperformProfile?: 'light' | 'standard' | 'full' | 'starter' | 'fleet';
  /** @deprecated Use hyperformProfile */
  outputProfile?: 'light' | 'standard' | 'full' | 'starter' | 'fleet';
  /** @deprecated Use hyperformProfile */
  outputStandard?: 'light' | 'standard' | 'full' | 'starter' | 'fleet';
  /**
   * Hard token ceiling for wiki page injection per compose pass.
   * Limits how much synthesized topic knowledge is inserted into context.
   * Lower values keep context lighter; higher values surface more topic depth.
   *
   * Default: 600 tokens
   * Light preset: 300 tokens
   * Extended preset: 800 tokens
   */
  wikiTokenCap?: number;
  // Note: assembly order is fixed in compose() — system, identity, history,
  // facts, knowledge, preferences, semanticRecall, cross-session, library.
  //
  // History trimming strategy: Redis stores up to maxHistoryMessages (default 1000).
  // Budget-based trimming happens at compose time, not storage time.
  // This ensures the compositor always has access to the full recent window
  // and can make intelligent decisions about what to include.
}

// ─── Expertise Types ─────────────────────────────────────────────

export type ExpertiseSourceType = 'conversation' | 'pipeline' | 'review' | 'manual';

export type EvidenceRelationship = 'confirms' | 'contradicts';

export interface IndexerConfig {
  enabled: boolean;
  factExtractionMode: 'off' | 'pattern' | 'tiered';
  topicDormantAfter: string;   // duration string e.g. '24h'
  topicClosedAfter: string;
  factDecayRate: number;
  episodeSignificanceThreshold: number;
  periodicInterval: number;    // milliseconds
  batchSize: number;           // messages per indexer tick
  maxMessagesPerTick: number;  // total messages processed per tick (all agents)
  maxActiveConversations?: number;    // proactive pass: max concurrent conversations to scan
  recentConversationCooldownMs?: number; // proactive pass: cooldown between scans per conversation
  maxCandidatesPerPass?: number;      // proactive pass: max mutations per maintenance tick
}

/**
 * Global write policy for fact ingestion.
 * 'allow' — facts are written to the library DB normally.
 * 'deny'  — fact writes are suppressed (read-only / replay mode).
 */
export type GlobalWritePolicy = 'allow' | 'deny';

/**
 * Diagnostics snapshot from a maintenance tick (proactive noise sweep + tool decay).
 * Stored on BackgroundIndexer.lastMaintenanceDiagnostics after each tick.
 */
export interface MaintenanceTickDiagnostics {
  considered: number;   // conversations evaluated
  skipped: number;      // conversations skipped due to cooldown
  scanned: number;      // conversations actually scanned
  mutated: number;      // total messages mutated (deleted or updated)
  durationMs: number;   // wall time for the maintenance phase
  exitReason: 'complete' | 'cap-reached' | 'no-conversations';
}

// ─── Telemetry Types (Phase A Sprint 1) ──────────────────────────
//
// Structured logging around every trimHistoryToTokenBudget() call site and
// every assemble() entry in the HyperMem plugin path. Emitters are zero-cost
// when process.env.HYPERMEM_TELEMETRY !== '1' (the default).
//
// Event stream is JSONL, one record per line, at
// process.env.HYPERMEM_TELEMETRY_PATH (default './hypermem-telemetry.jsonl').

/**
 * Labels for each trim call site. The set is closed — any new trim site must
 * be added here before being instrumented.
 */
export type TrimTelemetryPath =
  | 'assemble.normal'
  | 'assemble.toolLoop'
  | 'assemble.subagent'
  | 'reshape'
  | 'compact.nuclear'
  | 'compact.history'
  | 'compact.history2'
  | 'afterTurn.secondary'
  | 'warmstart';

/**
 * Emitted once per invocation of trimHistoryToTokenBudget() (or a caller that
 * wraps it). Every trim site MUST emit exactly one of these, even if the
 * underlying trim returned 0.
 */
export interface TrimTelemetryEvent {
  event: 'trim';
  ts: string;                 // ISO-8601 timestamp
  path: TrimTelemetryPath;    // call-site label
  agentId: string;
  sessionKey: string;
  preTokens: number;          // estimated window tokens before trim (best-effort, may be 0)
  postTokens: number;         // estimated window tokens after trim (best-effort, may be 0)
  removed: number;            // messages removed (return value of trimHistoryToTokenBudget)
  cacheInvalidated: boolean;  // whether invalidateWindow() was called afterwards
  reason: string;             // short textual reason ("pressure>85", "downshift", "afterTurn>80", etc.)
}

/**
 * Emitted to trace assemble() entry + regime resolution. path captures the
 * high-level compose regime:
 *   - 'cold'     : first call of a session (no prior compose cache)
 *   - 'subagent' : subagent session (sessionKey matches subagent pattern)
 *   - 'replay'   : cache replay fast path taken
 *
 * Emission convention:
 *   At assemble() entry we emit ONE trace with path='cold' or 'subagent'
 *   because replay is not known until the cache-replay hit block executes.
 *   When the cache-replay fast path fires, a SECOND trace is emitted with
 *   path='replay' sharing the same turnId as the entry trace. Per-turn
 *   analysis tools should group by (agentId, sessionKey, turnId) and
 *   prefer the terminal path as the authoritative regime for that turn.
 */
export interface AssembleTraceEvent {
  event: 'assemble';
  ts: string;
  agentId: string;
  sessionKey: string;
  turnId: string;             // stable per-turn id (timestamp + counter)
  path: 'cold' | 'replay' | 'subagent';
  toolLoop: boolean;          // true when last inbound message is a toolResult
  msgCount: number;           // messages array length at entry
}

export type HyperMemTelemetryEvent = TrimTelemetryEvent | AssembleTraceEvent;

// ─── Archived Mining Types (Phase 4 Sprint 2) ────────────────────

/**
 * Query parameters for mining a single archived/forked context.
 *
 * - contextId: must reference an archived or forked context (not active).
 * - limit: per-context message cap; hard-capped at 200 in the implementation.
 * - excludeHeartbeats: when true (default), heartbeat messages are omitted.
 * - ftsQuery: optional keyword filter applied client-side for Sprint 2.
 */
export interface ArchivedMiningQuery {
  /** Explicit archived or forked contextId — active contexts are rejected. */
  contextId: number;
  /** Maximum number of messages to return. Hard-capped at 200. Default: 200. */
  limit?: number;
  /** When true (default), exclude heartbeat messages from results. */
  excludeHeartbeats?: boolean;
  /** Optional FTS/keyword filter applied client-side this sprint. */
  ftsQuery?: string;
}

/**
 * Options for mineArchivedContexts (multi-context mining).
 *
 * Extends the per-context ArchivedMiningQuery options with a `maxContexts` gate
 * that controls how many contextIds are accepted in a single call.
 *
 * ## maxContexts gate
 * - Default effective cap: 20 (ARCHIVED_MULTI_CONTEXT_DEFAULT_MAX).
 * - Hard ceiling: 50 (ARCHIVED_MULTI_CONTEXT_HARD_CEILING). Callers may not
 *   exceed this regardless of what they pass.
 * - A caller may supply a lower explicit limit (e.g. 10) to restrict the call
 *   further; that lower limit is honored.
 * - If a caller supplies a value above the hard ceiling, it is silently clamped
 *   to the hard ceiling — callers need not know the exact constant.
 * - If contextIds.length exceeds the effective max, mineArchivedContexts throws
 *   immediately (before any DB access). Do not truncate silently.
 */
export interface MultiContextMiningOptions extends Omit<ArchivedMiningQuery, 'contextId'> {
  /**
   * Maximum number of contextIds accepted in this call.
   *
   * - Default: ARCHIVED_MULTI_CONTEXT_DEFAULT_MAX (20).
   * - Hard ceiling: ARCHIVED_MULTI_CONTEXT_HARD_CEILING (50).
   * - Values above the hard ceiling are clamped to the ceiling.
   * - Values at or below the ceiling are used as-is.
   */
  maxContexts?: number;
}

/**
 * Result wrapper returned by mineArchivedContext / mineArchivedContexts.
 *
 * The stable marker `isHistorical: true` distinguishes mining results from
 * active-composition results. Consumers MUST check this before using results
 * in active-composition paths.
 *
 * @template T - The payload type (typically StoredMessage[]).
 */
export interface ArchivedMiningResult<T> {
  /** Always `true` — stable discriminator for archived/historical data. */
  isHistorical: true;
  /** The archived or forked context id that was mined. */
  contextId: number;
  /** The agentId owning this context. */
  agentId: string;
  /** The sessionKey the context belongs to. */
  sessionKey: string;
  /** The status of the context ('archived' | 'forked'). */
  contextStatus: 'archived' | 'forked';
  /** ISO timestamp of the context's last update. */
  contextUpdatedAt: string;
  /** The mined payload. */
  data: T;
}
