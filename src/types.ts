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

export interface Fact {
  id: number;
  agentId: string;
  scope: FactScope;
  domain: string | null;
  content: string;
  confidence: number;
  sourceConversationId: number | null;
  sourceMessageId: number | null;
  contradictsFactId: number | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
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
  lastConversationId: number | null;
  lastMessageId: number | null;
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

export type EpisodeType = 'decision' | 'incident' | 'discovery' | 'interaction' | 'milestone';

export interface Episode {
  id: number;
  agentId: string;
  eventType: EpisodeType;
  summary: string;
  significance: number;
  participants: string[] | null;
  conversationId: number | null;
  messageRangeStart: number | null;
  messageRangeEnd: number | null;
  createdAt: string;
  decayScore: number;
}

// ─── Compositor Types ────────────────────────────────────────────

export interface ComposeRequest {
  agentId: string;
  sessionKey: string;
  tokenBudget: number;
  provider: string;
  model: string;
  includeHistory?: boolean;
  historyDepth?: number;
  includeFacts?: boolean;
  includeContext?: boolean;
  includeLibrary?: boolean;
}

export interface SlotTokenCounts {
  system: number;
  identity: number;
  history: number;
  facts: number;
  context: number;
  library: number;
}

export interface ComposeResult {
  messages: ProviderMessage[];
  tokenCount: number;
  slots: SlotTokenCounts;
  truncated: boolean;
  warnings: string[];
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
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  keyPrefix: string;
  sessionTTL: number;        // seconds
  flushInterval: number;     // milliseconds
}

export interface CompositorConfig {
  defaultTokenBudget: number;
  maxHistoryMessages: number;
  maxFacts: number;
  maxCrossSessionContext: number;  // tokens
  priorityOrder: string[];
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
