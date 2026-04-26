/**
 * hypermem — Agent-Centric Memory & Context Composition Engine
 *
 * @module @psiclawops/hypermem
 *
 * Architecture:
 *   L1: CacheLayer  — SQLite `:memory:` hot session working memory
 *   L2: messages.db — per-agent conversation log (rotatable)
 *   L3: vectors.db  — per-agent semantic search index (reconstructable)
 *   L4: library.db  — fleet-wide structured knowledge (crown jewel)
 */
export { ENGINE_VERSION, MIN_NODE_VERSION, MIN_REDIS_VERSION, SQLITE_VEC_VERSION, MAIN_SCHEMA_VERSION, LIBRARY_SCHEMA_VERSION_EXPORT, HYPERMEM_COMPAT_VERSION, SCHEMA_COMPAT } from './version.js';
export { DatabaseManager } from './db.js';
export type { DatabaseManagerConfig } from './db.js';
export { MessageStore } from './message-store.js';
export { ToolArtifactStore } from './tool-artifact-store.js';
export type { ToolArtifactRecord, PutToolArtifactInput } from './tool-artifact-store.js';
export { FactStore } from './fact-store.js';
export { KnowledgeStore } from './knowledge-store.js';
export type { LinkType } from './knowledge-store.js';
export { TopicStore } from './topic-store.js';
export { EpisodeStore } from './episode-store.js';
export { PreferenceStore } from './preference-store.js';
export type { Preference } from './preference-store.js';
export { FleetStore } from './fleet-store.js';
export type { FleetAgent, FleetOrg, AgentCapability } from './fleet-store.js';
export { SystemStore } from './system-store.js';
export type { SystemState, SystemEvent } from './system-store.js';
export { WorkStore } from './work-store.js';
export { ensureContextSchema, getActiveContext, getOrCreateActiveContext, updateContextHead, archiveContext, rotateSessionContext, getContextById, getArchivedContexts, getArchivedContext, getContextLineage, getForkChildren } from './context-store.js';
export type { Context } from './context-store.js';
export type { WorkItem, WorkEvent, WorkStatus } from './work-store.js';
export { DesiredStateStore } from './desired-state-store.js';
export { ExpertiseStore } from './expertise-store.js';
export type { ExpertiseObservation, ExpertisePattern, ExpertiseEvidence } from './expertise-store.js';
export { evictStaleContent, DEFAULT_EVICTION_CONFIG } from './image-eviction.js';
export type { ImageEvictionConfig, EvictionStats, EvictionResult } from './image-eviction.js';
export { KnowledgeGraph } from './knowledge-graph.js';
export type { EntityType, KnowledgeLink, GraphNode, TraversalResult } from './knowledge-graph.js';
export { RateLimiter, createRateLimitedEmbedder } from './rate-limiter.js';
export type { RateLimiterConfig, Priority } from './rate-limiter.js';
export type { DesiredStateEntry, ConfigEvent, DriftStatus } from './desired-state-store.js';
export type { ModelState } from './cache.js';
export { CacheLayer } from './cache.js';
export { TRIM_SOFT_TARGET, TRIM_GROWTH_THRESHOLD, TRIM_HEADROOM_FRACTION, TRIM_BUDGET_POLICY, resolveTrimBudgets, } from './budget-policy.js';
export { resolveAdaptiveLifecyclePolicy, } from './adaptive-lifecycle.js';
export type { AdaptiveLifecycleBand, AdaptiveLifecycleInput, AdaptiveLifecyclePolicy, } from './adaptive-lifecycle.js';
export { DEGRADATION_REASONS, DEGRADATION_LIMITS, isDegradationReason, isReplayState, formatToolChainStub, parseToolChainStub, isToolChainStub, formatArtifactRef, parseArtifactRef, isArtifactRef, formatReplayMarker, parseReplayMarker, isReplayMarker, isDegradedContent, } from './degradation.js';
export type { DegradationReason, ToolChainStub, ArtifactRef, ReplayMarker, ReplayState, DegradationEvent, } from './degradation.js';
export { REPLAY_RECOVERY_POLICY, decideReplayRecovery, isColdRedisReplay, isReplayRecovered, } from './replay-recovery.js';
export type { ReplayRecoveryInputs, ReplayRecoveryDecision } from './replay-recovery.js';
export { Compositor, type CompositorDeps, applyToolGradientToWindow, canPersistReshapedHistory, OPENCLAW_BOOTSTRAP_FILES, resolveToolChainEjections, type ToolChainEjectionResult } from './compositor.js';
export { classifySessionType, estimateObservedMsgDensity, computeAdaptiveHistoryDepth, computeUnifiedPressure, PRESSURE_SOURCE, type SessionType, type PressureSourceLabel } from './compositor.js';
export { type CollectionTrigger, TRIGGER_REGISTRY, TRIGGER_REGISTRY_VERSION, TRIGGER_REGISTRY_HASH, DEFAULT_TRIGGERS, matchTriggers, } from './trigger-registry.js';
export { canonicalizeSnapshotJson, hashSnapshotJson, parseSnapshotSlotsJson, isInlineSnapshotSlotPayload, computeInlineIntegrityHash, attachInlineIntegrityHash, computeSlotsIntegrityHash, verifySnapshotSlotsIntegrity, } from './composition-snapshot-integrity.js';
export type { SnapshotJsonPrimitive, SnapshotJsonValue, SnapshotJsonObject, SnapshotSlotsRecord, InlineSnapshotSlotPayload, SnapshotIntegrityFailureReason, SnapshotIntegrityFailure, SnapshotIntegrityVerification, } from './composition-snapshot-integrity.js';
export { insertCompositionSnapshot, listCompositionSnapshots, getCompositionSnapshot, verifyCompositionSnapshot, getLatestValidCompositionSnapshot, } from './composition-snapshot-store.js';
export type { CompositionSnapshotRecord, InsertCompositionSnapshotInput, LatestValidCompositionSnapshot, } from './composition-snapshot-store.js';
export { ensureCompactionFenceSchema, updateCompactionFence, getCompactionFence, getCompactionEligibility, getCompactableMessages, } from './compaction-fence.js';
export type { CompactionFence, CompactionEligibility } from './compaction-fence.js';
export { verifyPreservation, verifyPreservationFromVectors, } from './preservation-gate.js';
export type { PreservationResult, PreservationConfig } from './preservation-gate.js';
export { toProviderFormat, fromProviderFormat, userMessageToNeutral, toolResultsToNeutral, normalizeToolCallId, generateToolCallId, detectProvider, repairToolCallPairs, } from './provider-translator.js';
export { migrate, SCHEMA_VERSION } from './schema.js';
export { migrateLibrary, LIBRARY_SCHEMA_VERSION } from './library-schema.js';
export { VectorStore, generateEmbeddings } from './vector-store.js';
export type { EmbeddingConfig, VectorSearchResult, VectorIndexStats } from './vector-store.js';
export { hybridSearch, buildFtsQuery } from './hybrid-retrieval.js';
export type { HybridSearchResult, HybridSearchOptions, RerankerTelemetry, RerankerStatus } from './hybrid-retrieval.js';
export { createReranker, ZeroEntropyReranker, OpenRouterReranker, OllamaReranker, } from './reranker.js';
export type { RerankerProvider, RerankerConfig, RerankResult } from './reranker.js';
export { ContradictionDetector } from './contradiction-detector.js';
export type { ContradictionCandidate, ContradictionResult, ContradictionDetectorConfig } from './contradiction-detector.js';
export { DocChunkStore } from './doc-chunk-store.js';
export type { DocChunkRow, ChunkQuery, IndexResult as DocIndexResult } from './doc-chunk-store.js';
export { WorkspaceSeeder, seedWorkspace } from './seed.js';
export type { SeedOptions, SeedResult } from './seed.js';
export { chunkMarkdown, chunkFile, inferCollection, hashContent, ACA_COLLECTIONS } from './doc-chunker.js';
export type { DocChunk, ChunkOptions, CollectionDef } from './doc-chunker.js';
export { crossAgentQuery, canAccess, visibilityFilter, defaultOrgRegistry, buildOrgRegistryFromDb, loadOrgRegistryFromDb, } from './cross-agent.js';
export type { OrgRegistry } from './cross-agent.js';
export { BackgroundIndexer, createIndexer, type CursorFetcher } from './background-indexer.js';
export { runDreamingPromoter, runDreamingPassForFleet, resolveAgentWorkspacePath, type DreamerConfig, type DreamerResult, type PromotionEntry, DEFAULT_DREAMER_CONFIG, } from './dreaming-promoter.js';
export type { IndexerStats, WatermarkState } from './background-indexer.js';
export { TopicSynthesizer } from './topic-synthesizer.js';
export type { SynthesisResult, SynthesisConfig } from './topic-synthesizer.js';
export { WikiPageEmitter } from './wiki-page-emitter.js';
export type { WikiPage, WikiLink, WikiPageSummary } from './wiki-page-emitter.js';
export { lintKnowledge } from './knowledge-lint.js';
export type { LintResult } from './knowledge-lint.js';
export { buildSpawnContext } from './spawn-context.js';
export type { SpawnContextOptions, SpawnContext } from './spawn-context.js';
export { runNoiseSweep, runToolDecay, type NoiseSweepResult, type ToolDecayResult } from './proactive-pass.js';
export type { NeutralMessage, NeutralToolCall, NeutralToolResult, StoredMessage, MessageRole, ProviderMessage, Conversation, Fact, Topic, Knowledge, Episode, ComposeRequest, ComposeResult, ComposeDiagnostics, ForkedContextSeed, SlotTokenCounts, SessionSlots, SessionMeta, HyperMemConfig, RedisConfig, CompositorConfig, IndexerConfig, ChannelType, ConversationStatus, FactScope, TopicStatus, EpisodeType, MemoryVisibility, CrossAgentQuery, AgentIdentity, SessionCursor, RecentTurn, ExpertiseSourceType, EvidenceRelationship, ArchivedMiningQuery, ArchivedMiningResult, MultiContextMiningOptions, } from './types.js';
export type { ProviderType } from './provider-translator.js';
export { classifyContentType, signalWeight, isSignalBearing, SIGNAL_WEIGHT } from './content-type-classifier.js';
export type { ContentType, ContentTypeResult } from './content-type-classifier.js';
export { detectTopicShift, stripMessageMetadata } from './topic-detector.js';
export type { TopicSignal } from './topic-detector.js';
export { SessionTopicMap } from './session-topic-map.js';
export { getActiveFOS, matchMOD, renderFOS, renderMOD, recordOutputMetrics, } from './fos-mod.js';
export type { FOSRecord, MODRecord, FOSDirectives, FOSTaskVariant, MODCorrection, MODCalibration, OutputMetricsRow, } from './fos-mod.js';
import { DatabaseManager } from './db.js';
import { type Preference } from './preference-store.js';
import { type FleetAgent, type FleetOrg } from './fleet-store.js';
import { type SystemState } from './system-store.js';
import { type WorkItem, type WorkStatus } from './work-store.js';
import { type EntityType, type KnowledgeLink, type GraphNode, type TraversalResult } from './knowledge-graph.js';
import { type DesiredStateEntry, type DriftStatus } from './desired-state-store.js';
import { CacheLayer } from './cache.js';
import { Compositor } from './compositor.js';
import { type Context } from './context-store.js';
import { VectorStore, type VectorSearchResult, type VectorIndexStats } from './vector-store.js';
import { type DocChunkRow, type ChunkQuery, type IndexResult } from './doc-chunk-store.js';
import { type SeedOptions, type SeedResult } from './seed.js';
import { type DocChunk } from './doc-chunker.js';
import type { HyperMemConfig, ComposeRequest, ComposeResult, NeutralMessage, StoredMessage, Conversation, ChannelType, ArchivedMiningQuery, ArchivedMiningResult, MultiContextMiningOptions } from './types.js';
import { type OrgRegistry } from './cross-agent.js';
export interface StartupFleetSeedOptions {
    workspaceRoots?: string[];
    includeMessageDbAgents?: boolean;
    hydrateCache?: boolean;
}
export interface StartupFleetSeedResult {
    discovered: number;
    inserted: number;
    updated: number;
    skipped: number;
    orgsCreated: number;
    hydratedAgents: number;
    hydratedSummary: boolean;
}
/**
 * hypermem — the main API facade.
 *
 * Usage:
 *   const hm = await hypermem.create({ dataDir: '~/.openclaw/hypermem' });
 *   await hm.record('alice', 'agent:alice:webchat:main', userMsg);
 *   const result = await hm.compose({ agentId: 'alice', sessionKey: '...', ... });
 */
export declare class HyperMem {
    readonly dbManager: DatabaseManager;
    readonly cache: CacheLayer;
    readonly compositor: Compositor;
    private readonly config;
    private static readonly _instances;
    private constructor();
    /**
     * Get the active vector store, if initialized.
     * Used by the plugin to wire embeddings into the background indexer.
     */
    getVectorStore(): VectorStore | null;
    /**
     * Create and initialize a hypermem instance.
     *
     * Singleton-per-dataDir: callers that pass the same absolute dataDir share
     * one instance. The first caller's full config wins; later callers get the
     * existing instance regardless of what config they passed. Plugins should
     * load the user config file (~/.openclaw/hypermem/config.json) themselves
     * so whichever plugin races first still produces a fully-configured instance.
     */
    static create(config?: Partial<HyperMemConfig>): Promise<HyperMem>;
    private static _initializeInstance;
    /**
     * Record a user message.
     */
    recordUserMessage(agentId: string, sessionKey: string, content: string, opts?: {
        channelType?: ChannelType;
        channelId?: string;
        provider?: string;
        model?: string;
        tokenCount?: number;
        isHeartbeat?: boolean;
    }): Promise<StoredMessage>;
    /**
     * Record an assistant response.
     */
    recordAssistantMessage(agentId: string, sessionKey: string, message: NeutralMessage, opts?: {
        tokenCount?: number;
    }): Promise<StoredMessage>;
    /**
     * Record a raw provider response, converting to neutral format.
     */
    recordProviderResponse(agentId: string, sessionKey: string, response: Record<string, unknown>, provider: string, opts?: {
        tokenCount?: number;
    }): Promise<StoredMessage>;
    /**
     * Compose context for an LLM call.
     */
    compose(request: ComposeRequest): Promise<ComposeResult>;
    /**
     * Persist a full tool result payload and return the durable record.
     * Used by the plugin wave-guard to capture payloads before stubbing the
     * transcript. Dedupes by content hash within the (agentId, sessionKey)
     * scope — identical payloads bump ref_count on the existing row.
     */
    recordToolArtifact(agentId: string, sessionKey: string, input: Omit<import('./tool-artifact-store.js').PutToolArtifactInput, 'agentId' | 'sessionKey'>): Promise<import('./tool-artifact-store.js').ToolArtifactRecord>;
    /** Fetch a tool artifact by id. Returns null if unknown. */
    getToolArtifact(agentId: string, artifactId: string): Promise<import('./tool-artifact-store.js').ToolArtifactRecord | null>;
    /** List tool artifacts for a specific turn. */
    listToolArtifactsByTurn(agentId: string, sessionKey: string, turnId: string): Promise<import('./tool-artifact-store.js').ToolArtifactRecord[]>;
    /**
     * List archived or forked contexts for an agent.
     *
     * operator-safe enumeration path. This is the approved archived-context
     * listing surface. Active composition remains separate.
     */
    listArchivedContexts(agentId: string, opts?: {
        sessionKey?: string;
        limit?: number;
    }): Context[];
    /**
     * Mine a single archived or forked context through the archived-mining
     * surface. This does not widen active composition.
     */
    mineArchivedContext(agentId: string, query: ArchivedMiningQuery): ArchivedMiningResult<StoredMessage[]>;
    /**
     * Mine multiple archived or forked contexts through the capped archived-
     * mining surface. This does not expose raw DAG helpers and does not widen
     * active composition.
     */
    mineArchivedContexts(agentId: string, contextIds: number[], opts?: MultiContextMiningOptions): ArchivedMiningResult<StoredMessage[]>[];
    /**
     * Warm a session from SQLite into Redis.
     */
    warm(agentId: string, sessionKey: string, opts?: {
        systemPrompt?: string;
        identity?: string;
    }): Promise<void>;
    /**
     * Recompute the Redis hot history view from SQLite and re-apply tool gradient.
     */
    refreshRedisGradient(agentId: string, sessionKey: string, tokenBudget?: number, historyDepth?: number, trimSoftTarget?: number): Promise<void>;
    /**
     * Full-text search across all messages for an agent.
     */
    search(agentId: string, query: string, limit?: number): StoredMessage[];
    /**
     * Get or create a conversation.
     */
    getOrCreateConversation(agentId: string, sessionKey: string, opts?: {
        channelType?: ChannelType;
        channelId?: string;
        provider?: string;
        model?: string;
    }): Conversation;
    /**
     * List all agents with databases.
     */
    listAgents(): string[];
    /**
     * Add a fact.
     */
    addFact(agentId: string, content: string, opts?: {
        scope?: 'agent' | 'session' | 'user';
        domain?: string;
        confidence?: number;
        visibility?: string;
        sourceType?: string;
        sourceSessionKey?: string;
        sourceRef?: string;
    }): unknown;
    /**
     * Get active facts for an agent.
     */
    getActiveFacts(agentId: string, opts?: {
        scope?: 'agent' | 'session' | 'user';
        domain?: string;
        limit?: number;
        minConfidence?: number;
    }): unknown[];
    /**
     * Add/update knowledge.
     */
    upsertKnowledge(agentId: string, domain: string, key: string, content: string, opts?: {
        confidence?: number;
        sourceType?: string;
        sourceRef?: string;
        expiresAt?: string;
    }): unknown;
    /**
     * Get active knowledge, optionally filtered by domain.
     */
    getKnowledge(agentId: string, opts?: {
        domain?: string;
        limit?: number;
    }): unknown[];
    /**
     * Create a topic.
     */
    createTopic(agentId: string, name: string, description?: string): unknown;
    /**
     * Get active topics.
     */
    getActiveTopics(agentId: string, limit?: number): unknown[];
    /**
     * Record an episode.
     */
    recordEpisode(agentId: string, eventType: string, summary: string, opts?: {
        significance?: number;
        visibility?: string;
        participants?: string[];
        sessionKey?: string;
    }): unknown;
    /**
     * Get recent episodes.
     */
    getRecentEpisodes(agentId: string, opts?: {
        eventType?: string;
        minSignificance?: number;
        limit?: number;
        since?: string;
    }): unknown[];
    /**
     * Set a preference.
     */
    setPreference(subject: string, key: string, value: string, opts?: {
        domain?: string;
        agentId?: string;
        confidence?: number;
        visibility?: string;
    }): Preference;
    /**
     * Get a preference.
     */
    getPreference(subject: string, key: string, domain?: string): Preference | null;
    /**
     * Get all preferences for a subject.
     */
    getPreferences(subject: string, domain?: string): Preference[];
    /**
     * Register or update a fleet agent. Invalidates cache.
     */
    upsertFleetAgent(id: string, data: {
        displayName?: string;
        tier?: string;
        orgId?: string;
        reportsTo?: string;
        domains?: string[];
        sessionKeys?: string[];
        status?: string;
        metadata?: Record<string, unknown>;
    }): FleetAgent;
    /**
     * Get a fleet agent. Cache-aside: check Redis first, fall back to SQLite.
     */
    getFleetAgentCached(id: string): Promise<FleetAgent | null>;
    /**
     * Get a fleet agent (synchronous, SQLite only).
     */
    getFleetAgent(id: string): FleetAgent | null;
    /**
     * List fleet agents.
     */
    listFleetAgents(opts?: {
        tier?: string;
        orgId?: string;
        status?: string;
    }): FleetAgent[];
    /**
     * Register or update a fleet org.
     */
    upsertFleetOrg(id: string, data: {
        name: string;
        leadAgentId?: string;
        mission?: string;
    }): FleetOrg;
    /**
     * List fleet orgs.
     */
    listFleetOrgs(): FleetOrg[];
    /**
     * Register or update a capability for an agent.
     */
    upsertCapability(agentId: string, cap: {
        capType: 'skill' | 'tool' | 'mcp_server';
        name: string;
        version?: string;
        source?: string;
        config?: Record<string, unknown>;
        status?: string;
    }): import('./fleet-store.js').AgentCapability;
    /**
     * Bulk-sync capabilities of a given type for an agent.
     * Marks capabilities not in the list as 'removed'.
     */
    syncCapabilities(agentId: string, capType: 'skill' | 'tool' | 'mcp_server', caps: Array<{
        name: string;
        version?: string;
        source?: string;
        config?: Record<string, unknown>;
    }>): void;
    /**
     * Get capabilities for an agent, optionally filtered by type.
     */
    getAgentCapabilities(agentId: string, capType?: string): import('./fleet-store.js').AgentCapability[];
    /**
     * Find agents that have a specific capability.
     */
    findAgentsByCapability(capType: string, name: string): FleetAgent[];
    /**
     * Set a system state value.
     */
    setSystemState(category: string, key: string, value: unknown, opts?: {
        updatedBy?: string;
        ttl?: string;
    }): SystemState;
    /**
     * Get a system state value.
     */
    getSystemState(category: string, key: string): SystemState | null;
    /**
     * Get all state in a category.
     */
    getSystemCategory(category: string): SystemState[];
    /**
     * Create a work item.
     */
    createWorkItem(data: {
        title: string;
        description?: string;
        priority?: number;
        agentId?: string;
        createdBy: string;
        domain?: string;
        parentId?: string;
        dueAt?: string;
        metadata?: Record<string, unknown>;
    }): WorkItem;
    /**
     * Update work item status.
     */
    updateWorkStatus(id: string, status: WorkStatus, agentId?: string, comment?: string): WorkItem | null;
    /**
     * Get active work for an agent.
     */
    getAgentWork(agentId: string, status?: WorkStatus): WorkItem[];
    /**
     * Get the fleet kanban board.
     */
    getFleetKanban(opts?: {
        domain?: string;
        agentId?: string;
    }): WorkItem[];
    /**
     * Get work item stats.
     */
    getWorkStats(opts?: {
        agentId?: string;
        since?: string;
    }): unknown;
    /**
     * Get blocked work items.
     */
    getBlockedWork(): WorkItem[];
    /**
     * Set desired configuration for an agent.
     */
    setDesiredState(agentId: string, configKey: string, desiredValue: unknown, opts?: {
        source?: string;
        setBy?: string;
        notes?: string;
    }): DesiredStateEntry;
    /**
     * Report actual runtime value for drift detection. Invalidates cache.
     */
    reportActualState(agentId: string, configKey: string, actualValue: unknown): DriftStatus;
    /**
     * Bulk report actual state (e.g., on session startup / heartbeat). Invalidates cache.
     */
    reportActualStateBulk(agentId: string, actuals: Record<string, unknown>): Record<string, DriftStatus>;
    /**
     * Get all desired state for an agent.
     */
    getDesiredState(agentId: string): DesiredStateEntry[];
    /**
     * Get desired state as a flat config map.
     */
    getDesiredConfig(agentId: string): Record<string, unknown>;
    /**
     * Get all drifted entries across the fleet.
     */
    getDriftedState(): DesiredStateEntry[];
    /**
     * Get fleet-wide view of a specific config key.
     */
    getFleetConfigKey(configKey: string): DesiredStateEntry[];
    /**
     * Get config change history.
     */
    getConfigHistory(agentId: string, configKey?: string, limit?: number): import('./desired-state-store.js').ConfigEvent[];
    /**
     * Get fleet drift summary.
     */
    getDriftSummary(): {
        total: number;
        ok: number;
        drifted: number;
        unknown: number;
        error: number;
    };
    /**
     * Add a directed link between two entities.
     */
    addKnowledgeLink(fromType: EntityType, fromId: number, toType: EntityType, toId: number, linkType: string): KnowledgeLink;
    /**
     * Remove a specific link.
     */
    removeKnowledgeLink(fromType: EntityType, fromId: number, toType: EntityType, toId: number, linkType: string): boolean;
    /**
     * Get all links for an entity (both directions).
     */
    getEntityLinks(type: EntityType, id: number): KnowledgeLink[];
    /**
     * Traverse the knowledge graph from a starting entity.
     * BFS with bounded depth and result count.
     */
    traverseGraph(startType: EntityType, startId: number, opts?: {
        maxDepth?: number;
        maxResults?: number;
        linkTypes?: string[];
        direction?: 'outbound' | 'inbound' | 'both';
        targetTypes?: EntityType[];
    }): TraversalResult;
    /**
     * Find the shortest path between two entities.
     */
    findGraphPath(fromType: EntityType, fromId: number, toType: EntityType, toId: number, maxDepth?: number): GraphNode[] | null;
    /**
     * Get the most connected entities.
     */
    getMostConnectedEntities(opts?: {
        type?: EntityType;
        limit?: number;
    }): Array<{
        type: EntityType;
        id: number;
        degree: number;
    }>;
    /**
     * Get knowledge graph statistics.
     */
    getGraphStats(): {
        totalLinks: number;
        byType: Array<{
            linkType: string;
            count: number;
        }>;
    };
    /**
     * Semantic search across an agent's indexed memory.
     */
    semanticSearch(agentId: string, query: string, opts?: {
        tables?: string[];
        limit?: number;
        maxDistance?: number;
    }): Promise<VectorSearchResult[]>;
    /**
     * Index all un-indexed content for an agent.
     */
    indexAgent(agentId: string): Promise<{
        indexed: number;
        skipped: number;
        tombstoned: number;
    }>;
    /**
     * Get vector index statistics.
     */
    getVectorStats(agentId: string): VectorIndexStats | null;
    /**
     * Prune orphaned vector entries.
     */
    pruneVectorOrphans(agentId: string): number;
    /**
     * Get the session cursor for an agent+session.
     * Reads from Redis first; falls back to SQLite if Redis returns null
     * (e.g. after eviction or restart). This is the P1.3 durability guarantee.
     */
    getSessionCursor(agentId: string, sessionKey: string): Promise<import('./types.js').SessionCursor | null>;
    /**
     * Get the size of an agent's active messages.db in bytes.
     */
    getMessageDbSize(agentId: string): number;
    /**
     * Check if an agent's message database needs rotation.
     */
    shouldRotate(agentId: string, opts?: {
        maxSizeBytes?: number;
        maxAgeDays?: number;
    }): {
        reason: 'size' | 'age';
        current: number;
        threshold: number;
    } | null;
    /**
     * Rotate an agent's message database.
     * Returns the path to the rotated file, or null if no active DB exists.
     */
    rotateMessageDb(agentId: string): string | null;
    /**
     * List rotated message DB files for an agent.
     */
    listRotatedDbs(agentId: string): string[];
    /**
     * Check and auto-rotate all agents' message databases.
     * Call on heartbeat/startup.
     * Returns agents that were rotated.
     */
    autoRotate(opts?: {
        maxSizeBytes?: number;
        maxAgeDays?: number;
    }): Array<{
        agentId: string;
        reason: string;
        rotatedTo: string;
    }>;
    /**
     * Register a session start.
     */
    registerSession(sessionKey: string, agentId: string, opts?: {
        channel?: string;
        channelType?: string;
    }): void;
    /**
     * Record a session event.
     */
    recordSessionEvent(sessionKey: string, eventType: string, payload?: Record<string, unknown>): void;
    /**
     * Close a session.
     */
    closeSession(sessionKey: string, summary?: string): void;
    /**
     * Query sessions.
     */
    querySessions(opts?: {
        agentId?: string;
        status?: string;
        since?: string;
        limit?: number;
    }): unknown[];
    /**
     * Get session events.
     */
    getSessionEvents(sessionKey: string, limit?: number): unknown[];
    /**
     * Query another agent's memory with visibility-scoped access.
     */
    queryAgent(requesterId: string, targetAgentId: string, opts?: {
        memoryType?: 'facts' | 'knowledge' | 'topics' | 'episodes' | 'messages';
        domain?: string;
        limit?: number;
    }, registry?: OrgRegistry): unknown[];
    /**
     * Query fleet-wide visible memory.
     */
    queryFleet(requesterId: string, opts?: {
        memoryType?: 'facts' | 'knowledge' | 'topics' | 'episodes';
        domain?: string;
        limit?: number;
    }, registry?: OrgRegistry): unknown[];
    /**
     * Index chunks from a parsed set of DocChunk objects.
     * Atomic: replaces all chunks for the source in one transaction.
     */
    indexDocChunks(chunks: DocChunk[]): IndexResult;
    /**
     * Query doc chunks by collection with optional keyword/scope/agent filters.
     */
    queryDocChunks(query: ChunkQuery): DocChunkRow[];
    /**
     * Seed all ACA files from a workspace directory into the doc chunk index.
     * Idempotent: skips files whose source hash hasn't changed.
     * Force re-index with opts.force = true.
     */
    seedWorkspace(workspaceDir: string, opts?: SeedOptions): Promise<SeedResult>;
    /**
     * Seed a single file into the doc chunk index.
     */
    seedFile(filePath: string, collection: string, opts?: SeedOptions): import("./seed.js").SeedFileResult;
    /**
     * Get stats about the current doc chunk index.
     */
    getDocIndexStats(): {
        collection: string;
        count: number;
        sources: number;
        totalTokens: number;
    }[];
    /**
     * List indexed sources (what files have been seeded and their hashes).
     */
    listDocSources(opts?: {
        agentId?: string;
        collection?: string;
    }): import("./doc-chunk-store.js").DocSourceRow[];
    /**
     * Seed fleet agents from known workspace identity files and existing
     * message-db agent directories, then optionally hydrate the Redis fleet cache.
     *
     * The sweep is idempotent: existing rows are only updated when startup-discovered
     * values differ, so repeated boots do not duplicate or churn fleet rows.
     */
    seedFleetAgentsOnStartup(opts?: StartupFleetSeedOptions): Promise<StartupFleetSeedResult>;
    /**
     * Hydrate the Redis fleet cache from library.db.
     * Call on gateway startup to warm the cache for dashboard queries.
     *
     * Populates:
     *  - Per-agent profiles (fleet registry + capabilities + desired state)
     *  - Fleet summary (counts, drift status)
     */
    hydrateFleetCache(): Promise<{
        agents: number;
        summary: boolean;
    }>;
    /**
     * Clean shutdown.
     */
    close(): Promise<void>;
}
export default HyperMem;
export { SessionFlusher, flushSession } from './session-flusher.js';
export type { FlushSessionOptions, FlushSessionResult } from './session-flusher.js';
export { importVault, watchVault, parseObsidianNote, parseFrontmatter, extractWikilinks, extractTags, cleanObsidianMarkdown } from './obsidian-watcher.js';
export type { ObsidianConfig, ObsidianNote, ObsidianImportResult, ObsidianWikiLink, VaultChangeCallback } from './obsidian-watcher.js';
export { exportToVault } from './obsidian-exporter.js';
export type { ObsidianExportConfig, ObsidianExportResult } from './obsidian-exporter.js';
export { collectMetrics, formatMetricsSummary } from './metrics-dashboard.js';
export type { HyperMemMetrics, FactMetrics, WikiMetrics, EpisodeMetrics, VectorMetrics, CompositionMetrics, IngestionMetrics, SystemHealth, MetricsDashboardOptions } from './metrics-dashboard.js';
export { getProfile, mergeProfile, PROFILES, lightProfile, standardProfile, fullProfile, extendedProfile, minimalProfile, richProfile } from './profiles.js';
export type { ProfileName } from './profiles.js';
export { renderStarterFOS, resolveOutputTier } from './fos-mod.js';
export type { OutputStandardTier } from './fos-mod.js';
export { repairToolPairs } from './repair-tool-pairs.js';
//# sourceMappingURL=index.d.ts.map