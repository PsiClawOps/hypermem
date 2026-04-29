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
export { MessageStore } from './message-store.js';
export { ToolArtifactStore } from './tool-artifact-store.js';
export { FactStore } from './fact-store.js';
export { KnowledgeStore } from './knowledge-store.js';
export { TopicStore } from './topic-store.js';
export { EpisodeStore } from './episode-store.js';
export { PreferenceStore } from './preference-store.js';
export { FleetStore } from './fleet-store.js';
export { SystemStore } from './system-store.js';
export { WorkStore } from './work-store.js';
export { ensureContextSchema, getActiveContext, getOrCreateActiveContext, updateContextHead, archiveContext, rotateSessionContext, getContextById, getArchivedContexts, getArchivedContext, getContextLineage, getForkChildren } from './context-store.js';
export { DesiredStateStore } from './desired-state-store.js';
export { ExpertiseStore } from './expertise-store.js';
export { evictStaleContent, DEFAULT_EVICTION_CONFIG } from './image-eviction.js';
export { KnowledgeGraph } from './knowledge-graph.js';
export { RateLimiter, createRateLimitedEmbedder } from './rate-limiter.js';
export { CacheLayer } from './cache.js';
export { TRIM_SOFT_TARGET, TRIM_GROWTH_THRESHOLD, TRIM_HEADROOM_FRACTION, TRIM_BUDGET_POLICY, resolveTrimBudgets, } from './budget-policy.js';
export { resolveAdaptiveLifecyclePolicy, } from './adaptive-lifecycle.js';
// ── Phase C0.2: Canonical degradation contracts ───────────────────────────────
export { 
// Reason enum + all values
DEGRADATION_REASONS, DEGRADATION_LIMITS, isDegradationReason, isReplayState, 
// Tool-chain stub
formatToolChainStub, parseToolChainStub, isToolChainStub, 
// Artifact reference
formatArtifactRef, parseArtifactRef, isArtifactRef, 
// Replay marker
formatReplayMarker, parseReplayMarker, isReplayMarker, 
// Generic detector
isDegradedContent, } from './degradation.js';
export { REPLAY_RECOVERY_POLICY, decideReplayRecovery, isColdRedisReplay, isReplayRecovered, } from './replay-recovery.js';
export { Compositor, applyToolGradientToWindow, canPersistReshapedHistory, OPENCLAW_BOOTSTRAP_FILES, resolveToolChainEjections } from './compositor.js';
// Sprint 3 + Sprint 4: depth estimator, session classifier, unified pressure signal
export { classifySessionType, estimateObservedMsgDensity, computeAdaptiveHistoryDepth, computeUnifiedPressure, PRESSURE_SOURCE } from './compositor.js';
export { TRIGGER_REGISTRY, TRIGGER_REGISTRY_VERSION, TRIGGER_REGISTRY_HASH, DEFAULT_TRIGGERS, matchTriggers, } from './trigger-registry.js';
export { canonicalizeSnapshotJson, hashSnapshotJson, parseSnapshotSlotsJson, isInlineSnapshotSlotPayload, computeInlineIntegrityHash, attachInlineIntegrityHash, computeSlotsIntegrityHash, verifySnapshotSlotsIntegrity, } from './composition-snapshot-integrity.js';
export { insertCompositionSnapshot, listCompositionSnapshots, getCompositionSnapshot, verifyCompositionSnapshot, getLatestValidCompositionSnapshot, } from './composition-snapshot-store.js';
export { ensureCompactionFenceSchema, updateCompactionFence, getCompactionFence, getCompactionEligibility, getCompactableMessages, } from './compaction-fence.js';
export { verifyPreservation, verifyPreservationFromVectors, } from './preservation-gate.js';
export { toProviderFormat, fromProviderFormat, userMessageToNeutral, toolResultsToNeutral, normalizeToolCallId, generateToolCallId, detectProvider, repairToolCallPairs, } from './provider-translator.js';
export { migrate, SCHEMA_VERSION } from './schema.js';
export { migrateLibrary, LIBRARY_SCHEMA_VERSION } from './library-schema.js';
export { VectorStore, generateEmbeddings } from './vector-store.js';
export { hybridSearch, buildFtsQuery } from './hybrid-retrieval.js';
export { createReranker, ZeroEntropyReranker, OpenRouterReranker, OllamaReranker, } from './reranker.js';
export { ContradictionDetector } from './contradiction-detector.js';
export { DocChunkStore } from './doc-chunk-store.js';
export { WorkspaceSeeder, seedWorkspace } from './seed.js';
export { chunkMarkdown, chunkFile, inferCollection, hashContent, ACA_COLLECTIONS } from './doc-chunker.js';
export { crossAgentQuery, canAccess, visibilityFilter, defaultOrgRegistry, buildOrgRegistryFromDb, loadOrgRegistryFromDb, } from './cross-agent.js';
export { BackgroundIndexer, createIndexer } from './background-indexer.js';
export { runDreamingPromoter, runDreamingPassForFleet, resolveAgentWorkspacePath, DEFAULT_DREAMER_CONFIG, } from './dreaming-promoter.js';
export { TopicSynthesizer } from './topic-synthesizer.js';
export { WikiPageEmitter } from './wiki-page-emitter.js';
export { lintKnowledge } from './knowledge-lint.js';
export { buildSpawnContext } from './spawn-context.js';
export { runNoiseSweep, runToolDecay } from './proactive-pass.js';
export { classifyContentType, signalWeight, isSignalBearing, SIGNAL_WEIGHT } from './content-type-classifier.js';
export { detectTopicShift, stripMessageMetadata } from './topic-detector.js';
export { SessionTopicMap } from './session-topic-map.js';
export { getActiveFOS, matchMOD, renderFOS, renderMOD, recordOutputMetrics, } from './fos-mod.js';
import { DatabaseManager } from './db.js';
import { MessageStore } from './message-store.js';
import { FactStore } from './fact-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { TopicStore } from './topic-store.js';
import { EpisodeStore } from './episode-store.js';
import { PreferenceStore } from './preference-store.js';
import { FleetStore } from './fleet-store.js';
import { SystemStore } from './system-store.js';
import { WorkStore } from './work-store.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import { DesiredStateStore } from './desired-state-store.js';
import { CacheLayer } from './cache.js';
import { Compositor } from './compositor.js';
import { getArchivedContexts } from './context-store.js';
import { VectorStore } from './vector-store.js';
import { userMessageToNeutral, fromProviderFormat } from './provider-translator.js';
import { stripMessageMetadata } from './topic-detector.js';
import { DocChunkStore } from './doc-chunk-store.js';
import { WorkspaceSeeder } from './seed.js';
import { crossAgentQuery, buildOrgRegistryFromDb } from './cross-agent.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const DEFAULT_CONFIG = {
    enabled: true,
    dataDir: path.join(process.env.HOME || os.homedir(), '.openclaw', 'hypermem'),
    cache: {
        keyPrefix: 'hm:',
        sessionTTL: 14400, // 4 hours — system/identity/meta slots
        historyTTL: 604800, // 7 days — extended for canvas display
    },
    compositor: {
        // TUNE-010 (2026-04-02): Raised from 65000 → 90000.
        // TUNE-008 dropped to 65k as a tool-loop overflow band-aid. The real fix
        // (tool-loop pass-through guard in assemble()) means tool turns don't
        // re-run composition, so 90k is safe — leaves ~30k headroom for in-flight
        // tool results on a 120k window. Budget is better spent on context quality.
        defaultTokenBudget: 90000,
        maxHistoryMessages: 1000,
        maxFacts: 28,
        maxCrossSessionContext: 6000,
        maxRecentToolPairs: 3,
        maxProseToolPairs: 10,
        warmHistoryBudgetFraction: 0.4,
    },
    indexer: {
        enabled: true,
        factExtractionMode: 'tiered',
        topicDormantAfter: '24h',
        topicClosedAfter: '7d',
        factDecayRate: 0.01,
        episodeSignificanceThreshold: 0.5,
        periodicInterval: 300000,
        batchSize: 128,
        maxMessagesPerTick: 500,
    },
    embedding: {
        provider: 'ollama',
        ollamaUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 768,
        timeout: 10000,
        batchSize: 32,
    },
};
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function normalizeAgentId(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
function parseIdentityField(markdown, label) {
    const pattern = new RegExp(`^\\s*-\\s+\\*\\*${escapeRegExp(label)}:\\*\\*\\s*(.+?)\\s*$`, 'mi');
    const match = markdown.match(pattern);
    return match?.[1]?.trim() || null;
}
function parseSoulName(markdown) {
    const anchor = markdown.match(/You are \*\*([^*]+)\*\*/);
    if (anchor?.[1])
        return anchor[1].trim();
    const heading = markdown.match(/^#\s+SOUL\.md\s+[—-]\s+([^,\n]+)/m);
    return heading?.[1]?.trim() || null;
}
function parseSoulRole(markdown) {
    const anchor = markdown.match(/You are \*\*[^*]+\*\*\s+[—-]\s+([^\.\n]+)/);
    return anchor?.[1]?.trim() || null;
}
function inferTierFromRole(role) {
    const lower = (role || '').toLowerCase();
    if (!lower)
        return 'unknown';
    if (lower.includes('council') || lower.includes(' seat'))
        return 'council';
    if (lower.includes('director'))
        return 'director';
    if (lower.includes('specialist') || lower.includes('aide-de-camp'))
        return 'specialist';
    return 'unknown';
}
function parseReportTargets(raw) {
    if (!raw)
        return [];
    const stripped = raw.replace(/\([^)]*\)/g, ' ');
    const parts = stripped
        .split(/\s*(?:\+|,|\/|&|\band\b)\s*/i)
        .map(part => normalizeAgentId(part))
        .filter(Boolean);
    return [...new Set(parts)];
}
function mergeStartupCandidate(target, partial) {
    const existing = target.get(partial.agentId);
    if (!existing) {
        target.set(partial.agentId, {
            agentId: partial.agentId,
            displayName: partial.displayName || partial.agentId,
            tier: partial.tier || 'unknown',
            orgId: partial.orgId ?? null,
            reportsTo: partial.reportsTo ?? null,
            reportTargets: partial.reportTargets ? [...partial.reportTargets] : [],
            metadata: partial.metadata ?? null,
        });
        return;
    }
    if (partial.displayName && existing.displayName === existing.agentId) {
        existing.displayName = partial.displayName;
    }
    if (partial.tier && existing.tier === 'unknown') {
        existing.tier = partial.tier;
    }
    if (partial.orgId && !existing.orgId) {
        existing.orgId = partial.orgId;
    }
    if (partial.reportsTo && !existing.reportsTo) {
        existing.reportsTo = partial.reportsTo;
    }
    if (partial.reportTargets?.length) {
        existing.reportTargets = [...new Set([...existing.reportTargets, ...partial.reportTargets])];
    }
    if (partial.metadata) {
        existing.metadata = { ...(existing.metadata ?? {}), ...partial.metadata };
    }
}
function discoverStartupFleetCandidates(dbManager, opts = {}) {
    const homeDir = process.env.HOME || os.homedir();
    const workspaceRoots = opts.workspaceRoots ?? [
        path.join(homeDir, '.openclaw', 'workspace-' + 'council'),
        path.join(homeDir, '.openclaw', 'workspace'),
    ];
    const candidates = new Map();
    for (const root of workspaceRoots) {
        if (!fs.existsSync(root))
            continue;
        let entries = [];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const workspacePath = path.join(root, entry.name);
            const identityPath = path.join(workspacePath, 'IDENTITY.md');
            const soulPath = path.join(workspacePath, 'SOUL.md');
            if (!fs.existsSync(identityPath) && !fs.existsSync(soulPath))
                continue;
            let identityText = '';
            let soulText = '';
            try {
                if (fs.existsSync(identityPath))
                    identityText = fs.readFileSync(identityPath, 'utf8');
            }
            catch { }
            try {
                if (fs.existsSync(soulPath))
                    soulText = fs.readFileSync(soulPath, 'utf8');
            }
            catch { }
            const displayName = parseIdentityField(identityText, 'Name') ||
                parseSoulName(soulText) ||
                entry.name;
            const role = parseIdentityField(identityText, 'Role') ||
                parseSoulRole(soulText) ||
                null;
            const reportTargets = parseReportTargets(parseIdentityField(identityText, 'Reports to'));
            const agentId = normalizeAgentId(entry.name || displayName);
            if (!agentId)
                continue;
            mergeStartupCandidate(candidates, {
                agentId,
                displayName,
                tier: inferTierFromRole(role),
                reportTargets,
                metadata: {
                    startupSeed: {
                        source: 'workspace-identity',
                        workspacePath,
                        reportsToRaw: reportTargets,
                    },
                },
            });
        }
    }
    if (opts.includeMessageDbAgents !== false) {
        for (const agentId of dbManager.listAgents()) {
            mergeStartupCandidate(candidates, {
                agentId,
                displayName: agentId,
                tier: 'unknown',
                metadata: {
                    startupSeed: {
                        source: 'message-db',
                    },
                },
            });
        }
    }
    const resolved = [...candidates.values()];
    const knownIds = new Set(resolved.map(candidate => candidate.agentId));
    const councilIds = new Set(resolved
        .filter(candidate => candidate.tier === 'council')
        .map(candidate => candidate.agentId));
    for (const candidate of resolved) {
        const preferredLead = candidate.reportTargets.find(target => councilIds.has(target)) ||
            candidate.reportTargets.find(target => knownIds.has(target)) ||
            null;
        if (candidate.tier === 'council' && !candidate.orgId) {
            candidate.orgId = `${candidate.agentId}-org`;
        }
        if (candidate.tier === 'director' && preferredLead) {
            candidate.reportsTo = preferredLead;
            if (!candidate.orgId) {
                candidate.orgId = `${preferredLead}-org`;
            }
        }
        if (!candidate.reportsTo && preferredLead && candidate.tier !== 'director') {
            candidate.reportsTo = preferredLead;
        }
        // Null out reportsTo if it points outside the known fleet (e.g. a human operator ID)
        if (candidate.reportsTo && !knownIds.has(candidate.reportsTo)) {
            candidate.reportsTo = null;
        }
        candidate.metadata = {
            ...(candidate.metadata ?? {}),
            startupSeed: {
                ...(candidate.metadata ?? {}).startupSeed,
                derivedOrgId: candidate.orgId,
                derivedReportsTo: candidate.reportsTo,
            },
        };
    }
    return resolved.sort((a, b) => a.agentId.localeCompare(b.agentId));
}
/**
 * hypermem — the main API facade.
 *
 * Usage:
 *   const hm = await hypermem.create({ dataDir: '~/.openclaw/hypermem' });
 *   await hm.record('alice', 'agent:alice:webchat:main', userMsg);
 *   const result = await hm.compose({ agentId: 'alice', sessionKey: '...', ... });
 */
export class HyperMem {
    dbManager;
    cache;
    compositor;
    config;
    // Per-dataDir singleton registry. Multiple plugins (context-engine + memory)
    // load this package independently, but they must share a single HyperMem
    // instance per dataDir to avoid dual sqlite-vec init, dual fleet seeding,
    // and conflicting embedding configs against the same SQLite database.
    //
    // Backed by globalThis so the registry survives even if Node ends up loading
    // this module twice (e.g. via differing symlink/realpath resolution from two
    // sibling plugin packages). Module-scope state alone would not deduplicate
    // across two module instances.
    static _instances = (() => {
        const key = '__psiclawops_hypermem_instances__';
        const g = globalThis;
        const existing = g[key];
        if (existing instanceof Map)
            return existing;
        const fresh = new Map();
        g[key] = fresh;
        return fresh;
    })();
    constructor(config) {
        this.config = config;
        this.dbManager = new DatabaseManager({ dataDir: config.dataDir });
        this.cache = new CacheLayer(config.cache);
        this.compositor = new Compositor({
            cache: this.cache,
            vectorStore: null, // Set after create() when vector DB is available
            libraryDb: null, // Set after create() when library DB is available
        }, config.compositor);
    }
    /**
     * Get the active vector store, if initialized.
     * Used by the plugin to wire embeddings into the background indexer.
     */
    getVectorStore() {
        return this.compositor.vectorStore;
    }
    /**
     * Create and initialize a hypermem instance.
     *
     * Singleton-per-dataDir: callers that pass the same absolute dataDir share
     * one instance. The first caller's full config wins; later callers get the
     * existing instance regardless of what config they passed. Plugins should
     * load the user config file (~/.openclaw/hypermem/config.json) themselves
     * so whichever plugin races first still produces a fully-configured instance.
     */
    static async create(config) {
        const merged = {
            ...DEFAULT_CONFIG,
            ...config,
            cache: { ...DEFAULT_CONFIG.cache, ...config?.cache },
            compositor: { ...DEFAULT_CONFIG.compositor, ...config?.compositor },
            indexer: { ...DEFAULT_CONFIG.indexer, ...config?.indexer },
            embedding: {
                ...DEFAULT_CONFIG.embedding,
                ...config?.embedding,
            },
        };
        const dataDirKey = path.resolve(merged.dataDir);
        const existing = HyperMem._instances.get(dataDirKey);
        if (existing) {
            return existing;
        }
        const initPromise = HyperMem._initializeInstance(merged);
        HyperMem._instances.set(dataDirKey, initPromise);
        try {
            return await initPromise;
        }
        catch (err) {
            // Don't cache failed inits; let the next caller retry.
            HyperMem._instances.delete(dataDirKey);
            throw err;
        }
    }
    static async _initializeInstance(merged) {
        const hm = new HyperMem(merged);
        const cacheOk = await hm.cache.connect();
        if (cacheOk) {
            console.log('[hypermem] Cache connected');
        }
        else {
            console.warn('[hypermem] Cache unavailable — running in SQLite-only mode');
        }
        // ── Vector store init ─────────────────────────────────────
        // Attempt to wire up sqlite-vec + nomic-embed-text for semantic recall.
        // Non-fatal: if sqlite-vec isn't available or Ollama is down,
        // hybridSearch() continues in FTS5-only mode.
        // The vector store is shared (not per-agent) — facts/episodes from all agents
        // are indexed together, keyed by (source_table, source_id).
        if (merged.embedding.provider === 'none') {
            console.log('[hypermem] Embedding provider: none — semantic search disabled, using FTS5 fallback');
        }
        else {
            try {
                const vectorDb = hm.dbManager.getSharedVectorDb();
                if (vectorDb) {
                    const vs = new VectorStore(vectorDb, merged.embedding, hm.dbManager.getLibraryDb());
                    vs.ensureTables();
                    hm.compositor.setVectorStore(vs);
                    // Provider label: detect openrouter via base URL when provider is the
                    // OpenAI-compatible adapter; otherwise echo the configured provider so
                    // logs never imply ollama/nomic when something else is actually wired.
                    const providerLabel = merged.embedding.provider === 'openai'
                        ? (merged.embedding.openaiBaseUrl?.includes('openrouter') ? 'openrouter' : 'openai')
                        : merged.embedding.provider;
                    const modelLabel = merged.embedding.model ?? '(default)';
                    const dimsLabel = merged.embedding.dimensions ? `${merged.embedding.dimensions}d` : 'unknown-dims';
                    console.log(`[hypermem] Vector store initialized (sqlite-vec + ${providerLabel}/${modelLabel} ${dimsLabel})`);
                }
                else {
                    console.warn('[hypermem] sqlite-vec unavailable — semantic recall in FTS5-only mode');
                }
            }
            catch (err) {
                console.warn('[hypermem] Vector store init failed (non-fatal):', err.message);
            }
        }
        // ── Reranker init ─────────────────────────────────────────
        // Reranker is optional; when config.reranker is omitted or provider is
        // 'none', the compositor receives null and hybridSearch skips the rerank
        // hook. On provider errors, hybridSearch falls back to RRF ordering.
        if (merged.reranker && merged.reranker.provider !== 'none') {
            try {
                const { createReranker } = await import('./reranker.js');
                const rr = createReranker(merged.reranker);
                if (rr) {
                    hm.compositor.setReranker(rr);
                    console.log(`[hypermem] Reranker enabled: provider=${rr.name}`);
                }
                else {
                    console.log(`[hypermem] Reranker configured (${merged.reranker.provider}) but no API key resolved — RRF-only`);
                }
            }
            catch (err) {
                console.warn('[hypermem] Reranker init failed (non-fatal):', err.message);
            }
        }
        const autoStartupFleetSeeding = merged.startupFleetSeeding !== false &&
            !path.resolve(merged.dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep);
        if (autoStartupFleetSeeding) {
            try {
                const startupSeed = await hm.seedFleetAgentsOnStartup();
                if (startupSeed.discovered > 0) {
                    console.log(`[hypermem] Startup fleet seed: ${startupSeed.inserted} inserted, ` +
                        `${startupSeed.updated} updated, ${startupSeed.skipped} unchanged, ` +
                        `${startupSeed.orgsCreated} orgs, ${startupSeed.hydratedAgents} cached`);
                }
            }
            catch (err) {
                console.warn('[hypermem] Startup fleet seed failed (non-fatal):', err.message);
            }
        }
        return hm;
    }
    // ─── Core API (L2: Message DB) ──────────────────────────────
    /**
     * Record a user message.
     */
    async recordUserMessage(agentId, sessionKey, content, opts) {
        const db = this.dbManager.getMessageDb(agentId);
        this.dbManager.ensureAgent(agentId);
        const store = new MessageStore(db);
        const conversation = store.getOrCreateConversation(agentId, sessionKey, {
            channelType: opts?.channelType,
            channelId: opts?.channelId,
            provider: opts?.provider,
            model: opts?.model,
        });
        let contextId;
        try {
            const { getOrCreateActiveContext } = await import('./context-store.js');
            const ctx = getOrCreateActiveContext(db, agentId, sessionKey, conversation.id);
            contextId = ctx.id;
        }
        catch (_) { /* context wiring is best-effort in Phase 1 */ }
        const neutral = userMessageToNeutral(stripMessageMetadata(content));
        const stored = store.recordMessage(conversation.id, agentId, neutral, {
            tokenCount: opts?.tokenCount,
            isHeartbeat: opts?.isHeartbeat,
            contextId,
        });
        await this.cache.pushHistory(agentId, sessionKey, [stored], this.config.compositor.maxHistoryMessages);
        await this.cache.touchSession(agentId, sessionKey);
        return stored;
    }
    /**
     * Record an assistant response.
     */
    async recordAssistantMessage(agentId, sessionKey, message, opts) {
        const db = this.dbManager.getMessageDb(agentId);
        const store = new MessageStore(db);
        const conversation = store.getConversation(sessionKey);
        if (!conversation) {
            throw new Error(`No conversation found for session ${sessionKey}`);
        }
        let contextId;
        try {
            const { getOrCreateActiveContext } = await import('./context-store.js');
            const ctx = getOrCreateActiveContext(db, agentId, sessionKey, conversation.id);
            contextId = ctx.id;
        }
        catch (_) { /* context wiring is best-effort in Phase 1 */ }
        const stored = store.recordMessage(conversation.id, agentId, message, {
            tokenCount: opts?.tokenCount,
            contextId,
        });
        await this.cache.pushHistory(agentId, sessionKey, [stored], this.config.compositor.maxHistoryMessages);
        await this.cache.touchSession(agentId, sessionKey);
        return stored;
    }
    /**
     * Record a raw provider response, converting to neutral format.
     */
    async recordProviderResponse(agentId, sessionKey, response, provider, opts) {
        const neutral = fromProviderFormat(response, provider);
        return this.recordAssistantMessage(agentId, sessionKey, neutral, opts);
    }
    /**
     * Compose context for an LLM call.
     */
    async compose(request) {
        const db = this.dbManager.getMessageDb(request.agentId);
        const libraryDb = this.dbManager.getLibraryDb();
        return this.compositor.compose(request, db, libraryDb);
    }
    // ─── Tool Artifacts (L2: per-agent, schema v9) ───────────────────
    /**
     * Persist a full tool result payload and return the durable record.
     * Used by the plugin wave-guard to capture payloads before stubbing the
     * transcript. Dedupes by content hash within the (agentId, sessionKey)
     * scope — identical payloads bump ref_count on the existing row.
     */
    async recordToolArtifact(agentId, sessionKey, input) {
        const db = this.dbManager.getMessageDb(agentId);
        this.dbManager.ensureAgent(agentId);
        const { ToolArtifactStore } = await import('./tool-artifact-store.js');
        const store = new ToolArtifactStore(db);
        return store.put({ ...input, agentId, sessionKey });
    }
    /** Fetch a tool artifact by id. Returns null if unknown. */
    async getToolArtifact(agentId, artifactId) {
        const db = this.dbManager.getMessageDb(agentId);
        const { ToolArtifactStore } = await import('./tool-artifact-store.js');
        const store = new ToolArtifactStore(db);
        const record = store.get(artifactId);
        if (record)
            store.touch(artifactId);
        return record;
    }
    /** List tool artifacts for a specific turn. */
    async listToolArtifactsByTurn(agentId, sessionKey, turnId) {
        const db = this.dbManager.getMessageDb(agentId);
        const { ToolArtifactStore } = await import('./tool-artifact-store.js');
        const store = new ToolArtifactStore(db);
        return store.listByTurn(sessionKey, turnId);
    }
    // ─── Archived Mining (L2: Messages) ─────────────────────────
    /**
     * List archived or forked contexts for an agent.
     *
     * operator-safe enumeration path. This is the approved archived-context
     * listing surface. Active composition remains separate.
     */
    listArchivedContexts(agentId, opts) {
        const db = this.dbManager.getMessageDb(agentId);
        return getArchivedContexts(db, agentId, opts);
    }
    /**
     * Mine a single archived or forked context through the archived-mining
     * surface. This does not widen active composition.
     */
    mineArchivedContext(agentId, query) {
        const db = this.dbManager.getMessageDb(agentId);
        const store = new MessageStore(db);
        return store.mineArchivedContext(query);
    }
    /**
     * Mine multiple archived or forked contexts through the capped archived-
     * mining surface. This does not expose raw DAG helpers and does not widen
     * active composition.
     */
    mineArchivedContexts(agentId, contextIds, opts) {
        const db = this.dbManager.getMessageDb(agentId);
        const store = new MessageStore(db);
        return store.mineArchivedContexts(contextIds, opts);
    }
    /**
     * Read-only, capped, mode-dispatched message history query (HyperMem 0.9.4).
     *
     * Routes to MessageStore.queryHistory which owns all history SQL.
     * No general SQL execution, no bypass of compaction fences.
     *
     * Plugin surface: preferred shape is history.query action in the OpenClaw plugin tool
     * surface. The SDK currently only exposes registerContextEngine and registerMemoryCapability,
     * so no plugin tool action is registered in this release. Blocker: no api.registerTool
     * or equivalent action-routing surface in definePluginEntry. This method is the
     * public API; agents can call it directly via HyperMem.queryHistory().
     */
    queryHistory(query) {
        const db = this.dbManager.getMessageDb(query.agentId);
        const store = new MessageStore(db);
        return store.queryHistory(query);
    }
    /**
     * Warm a session from SQLite into Redis.
     */
    async warm(agentId, sessionKey, opts) {
        const db = this.dbManager.getMessageDb(agentId);
        const libraryDb = this.dbManager.getLibraryDb();
        await this.compositor.warmSession(agentId, sessionKey, db, { ...opts, libraryDb });
    }
    /**
     * Recompute the Redis hot history view from SQLite and re-apply tool gradient.
     */
    async refreshRedisGradient(agentId, sessionKey, tokenBudget, historyDepth, trimSoftTarget) {
        const db = this.dbManager.getMessageDb(agentId);
        await this.compositor.refreshRedisGradient(agentId, sessionKey, db, tokenBudget, historyDepth, trimSoftTarget);
    }
    /**
     * Full-text search across all messages for an agent.
     */
    search(agentId, query, limit = 20) {
        const db = this.dbManager.getMessageDb(agentId);
        const store = new MessageStore(db);
        return store.searchMessages(agentId, query, limit);
    }
    /**
     * Get or create a conversation.
     */
    getOrCreateConversation(agentId, sessionKey, opts) {
        const db = this.dbManager.getMessageDb(agentId);
        this.dbManager.ensureAgent(agentId);
        const store = new MessageStore(db);
        return store.getOrCreateConversation(agentId, sessionKey, opts);
    }
    /**
     * List all agents with databases.
     */
    listAgents() {
        return this.dbManager.listAgents();
    }
    // ─── Facts (L4: Library) ────────────────────────────────────
    /**
     * Add a fact.
     */
    addFact(agentId, content, opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new FactStore(db);
        return store.addFact(agentId, content, opts);
    }
    /**
     * Get active facts for an agent.
     */
    getActiveFacts(agentId, opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new FactStore(db);
        return store.getActiveFacts(agentId, opts);
    }
    // ─── Knowledge (L4: Library) ────────────────────────────────
    /**
     * Add/update knowledge.
     */
    upsertKnowledge(agentId, domain, key, content, opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new KnowledgeStore(db);
        return store.upsert(agentId, domain, key, content, opts);
    }
    /**
     * Get active knowledge, optionally filtered by domain.
     */
    getKnowledge(agentId, opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new KnowledgeStore(db);
        return store.getActive(agentId, opts);
    }
    // ─── Topics (L4: Library) ───────────────────────────────────
    /**
     * Create a topic.
     */
    createTopic(agentId, name, description) {
        const db = this.dbManager.getLibraryDb();
        const store = new TopicStore(db);
        return store.create(agentId, name, description);
    }
    /**
     * Get active topics.
     */
    getActiveTopics(agentId, limit = 20) {
        const db = this.dbManager.getLibraryDb();
        const store = new TopicStore(db);
        return store.getActive(agentId, limit);
    }
    // ─── Episodes (L4: Library) ─────────────────────────────────
    /**
     * Record an episode.
     */
    recordEpisode(agentId, eventType, summary, opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new EpisodeStore(db);
        return store.record(agentId, eventType, summary, opts);
    }
    /**
     * Get recent episodes.
     */
    getRecentEpisodes(agentId, opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new EpisodeStore(db);
        return store.getRecent(agentId, opts);
    }
    // ─── Preferences (L4: Library) ──────────────────────────────
    /**
     * Set a preference.
     */
    setPreference(subject, key, value, opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new PreferenceStore(db);
        return store.set(subject, key, value, opts);
    }
    /**
     * Get a preference.
     */
    getPreference(subject, key, domain) {
        const db = this.dbManager.getLibraryDb();
        const store = new PreferenceStore(db);
        return store.get(subject, key, domain);
    }
    /**
     * Get all preferences for a subject.
     */
    getPreferences(subject, domain) {
        const db = this.dbManager.getLibraryDb();
        const store = new PreferenceStore(db);
        return store.getForSubject(subject, domain);
    }
    // ─── Fleet Registry (L4: Library) ───────────────────────────
    /**
     * Register or update a fleet agent. Invalidates cache.
     */
    upsertFleetAgent(id, data) {
        const db = this.dbManager.getLibraryDb();
        const store = new FleetStore(db);
        const result = store.upsertAgent(id, data);
        // Invalidate cache — fire and forget
        this.cache.invalidateFleetAgent(id).catch(() => { });
        return result;
    }
    /**
     * Get a fleet agent. Cache-aside: check Redis first, fall back to SQLite.
     */
    async getFleetAgentCached(id) {
        // Try cache first
        const cached = await this.cache.getCachedFleetAgent(id);
        if (cached)
            return cached;
        // Fall back to SQLite
        const agent = this.getFleetAgent(id);
        if (agent) {
            // Warm cache — fire and forget
            this.cache.cacheFleetAgent(id, agent).catch(() => { });
        }
        return agent;
    }
    /**
     * Get a fleet agent (synchronous, SQLite only).
     */
    getFleetAgent(id) {
        const db = this.dbManager.getLibraryDb();
        const store = new FleetStore(db);
        return store.getAgent(id);
    }
    /**
     * List fleet agents.
     */
    listFleetAgents(opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new FleetStore(db);
        return store.listAgents(opts);
    }
    /**
     * Register or update a fleet org.
     */
    upsertFleetOrg(id, data) {
        const db = this.dbManager.getLibraryDb();
        const store = new FleetStore(db);
        return store.upsertOrg(id, data);
    }
    /**
     * List fleet orgs.
     */
    listFleetOrgs() {
        const db = this.dbManager.getLibraryDb();
        const store = new FleetStore(db);
        return store.listOrgs();
    }
    // ─── Agent Capabilities (L4: Library) ────────────────────────
    /**
     * Register or update a capability for an agent.
     */
    upsertCapability(agentId, cap) {
        const db = this.dbManager.getLibraryDb();
        const store = new FleetStore(db);
        return store.upsertCapability(agentId, cap);
    }
    /**
     * Bulk-sync capabilities of a given type for an agent.
     * Marks capabilities not in the list as 'removed'.
     */
    syncCapabilities(agentId, capType, caps) {
        const db = this.dbManager.getLibraryDb();
        const store = new FleetStore(db);
        store.syncCapabilities(agentId, capType, caps);
    }
    /**
     * Get capabilities for an agent, optionally filtered by type.
     */
    getAgentCapabilities(agentId, capType) {
        const db = this.dbManager.getLibraryDb();
        const store = new FleetStore(db);
        return store.getAgentCapabilities(agentId, capType);
    }
    /**
     * Find agents that have a specific capability.
     */
    findAgentsByCapability(capType, name) {
        const db = this.dbManager.getLibraryDb();
        const store = new FleetStore(db);
        return store.findByCapability(capType, name);
    }
    // ─── System Registry (L4: Library) ──────────────────────────
    /**
     * Set a system state value.
     */
    setSystemState(category, key, value, opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new SystemStore(db);
        return store.set(category, key, value, opts);
    }
    /**
     * Get a system state value.
     */
    getSystemState(category, key) {
        const db = this.dbManager.getLibraryDb();
        const store = new SystemStore(db);
        return store.get(category, key);
    }
    /**
     * Get all state in a category.
     */
    getSystemCategory(category) {
        const db = this.dbManager.getLibraryDb();
        const store = new SystemStore(db);
        return store.getCategory(category);
    }
    // ─── Work Items (L4: Library) ───────────────────────────────
    /**
     * Create a work item.
     */
    createWorkItem(data) {
        const db = this.dbManager.getLibraryDb();
        const store = new WorkStore(db);
        return store.create(data);
    }
    /**
     * Update work item status.
     */
    updateWorkStatus(id, status, agentId, comment) {
        const db = this.dbManager.getLibraryDb();
        const store = new WorkStore(db);
        return store.updateStatus(id, status, agentId, comment);
    }
    /**
     * Get active work for an agent.
     */
    getAgentWork(agentId, status) {
        const db = this.dbManager.getLibraryDb();
        const store = new WorkStore(db);
        return store.getAgentWork(agentId, status);
    }
    /**
     * Get the fleet kanban board.
     */
    getFleetKanban(opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new WorkStore(db);
        return store.getKanban(opts);
    }
    /**
     * Get work item stats.
     */
    getWorkStats(opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new WorkStore(db);
        return store.getStats(opts);
    }
    /**
     * Get blocked work items.
     */
    getBlockedWork() {
        const db = this.dbManager.getLibraryDb();
        const store = new WorkStore(db);
        return store.getBlocked();
    }
    // ─── Agent Desired State (L4: Library) ──────────────────────
    /**
     * Set desired configuration for an agent.
     */
    setDesiredState(agentId, configKey, desiredValue, opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new DesiredStateStore(db);
        const result = store.setDesired(agentId, configKey, desiredValue, opts);
        // Invalidate cache — desired state change affects fleet view
        this.cache.invalidateFleetAgent(agentId).catch(() => { });
        return result;
    }
    /**
     * Report actual runtime value for drift detection. Invalidates cache.
     */
    reportActualState(agentId, configKey, actualValue) {
        const db = this.dbManager.getLibraryDb();
        const store = new DesiredStateStore(db);
        const result = store.reportActual(agentId, configKey, actualValue);
        this.cache.invalidateFleetAgent(agentId).catch(() => { });
        return result;
    }
    /**
     * Bulk report actual state (e.g., on session startup / heartbeat). Invalidates cache.
     */
    reportActualStateBulk(agentId, actuals) {
        const db = this.dbManager.getLibraryDb();
        const store = new DesiredStateStore(db);
        const result = store.reportActualBulk(agentId, actuals);
        this.cache.invalidateFleetAgent(agentId).catch(() => { });
        return result;
    }
    /**
     * Get all desired state for an agent.
     */
    getDesiredState(agentId) {
        const db = this.dbManager.getLibraryDb();
        const store = new DesiredStateStore(db);
        return store.getAgentState(agentId);
    }
    /**
     * Get desired state as a flat config map.
     */
    getDesiredConfig(agentId) {
        const db = this.dbManager.getLibraryDb();
        const store = new DesiredStateStore(db);
        return store.getAgentConfig(agentId);
    }
    /**
     * Get all drifted entries across the fleet.
     */
    getDriftedState() {
        const db = this.dbManager.getLibraryDb();
        const store = new DesiredStateStore(db);
        return store.getDrifted();
    }
    /**
     * Get fleet-wide view of a specific config key.
     */
    getFleetConfigKey(configKey) {
        const db = this.dbManager.getLibraryDb();
        const store = new DesiredStateStore(db);
        return store.getFleetConfig(configKey);
    }
    /**
     * Get config change history.
     */
    getConfigHistory(agentId, configKey, limit) {
        const db = this.dbManager.getLibraryDb();
        const store = new DesiredStateStore(db);
        return store.getHistory(agentId, configKey, limit);
    }
    /**
     * Get fleet drift summary.
     */
    getDriftSummary() {
        const db = this.dbManager.getLibraryDb();
        const store = new DesiredStateStore(db);
        return store.getDriftSummary();
    }
    // ─── Knowledge Graph (L4: Library) ──────────────────────────
    /**
     * Add a directed link between two entities.
     */
    addKnowledgeLink(fromType, fromId, toType, toId, linkType) {
        const db = this.dbManager.getLibraryDb();
        const graph = new KnowledgeGraph(db);
        return graph.addLink(fromType, fromId, toType, toId, linkType);
    }
    /**
     * Remove a specific link.
     */
    removeKnowledgeLink(fromType, fromId, toType, toId, linkType) {
        const db = this.dbManager.getLibraryDb();
        const graph = new KnowledgeGraph(db);
        return graph.removeLink(fromType, fromId, toType, toId, linkType);
    }
    /**
     * Get all links for an entity (both directions).
     */
    getEntityLinks(type, id) {
        const db = this.dbManager.getLibraryDb();
        const graph = new KnowledgeGraph(db);
        return graph.getLinks(type, id);
    }
    /**
     * Traverse the knowledge graph from a starting entity.
     * BFS with bounded depth and result count.
     */
    traverseGraph(startType, startId, opts) {
        const db = this.dbManager.getLibraryDb();
        const graph = new KnowledgeGraph(db);
        return graph.traverse(startType, startId, opts);
    }
    /**
     * Find the shortest path between two entities.
     */
    findGraphPath(fromType, fromId, toType, toId, maxDepth) {
        const db = this.dbManager.getLibraryDb();
        const graph = new KnowledgeGraph(db);
        return graph.findPath(fromType, fromId, toType, toId, maxDepth);
    }
    /**
     * Get the most connected entities.
     */
    getMostConnectedEntities(opts) {
        const db = this.dbManager.getLibraryDb();
        const graph = new KnowledgeGraph(db);
        return graph.getMostConnected(opts);
    }
    /**
     * Get knowledge graph statistics.
     */
    getGraphStats() {
        const db = this.dbManager.getLibraryDb();
        const graph = new KnowledgeGraph(db);
        return {
            totalLinks: graph.getTotalLinks(),
            byType: graph.getLinkStats(),
        };
    }
    // ─── Vector / Semantic Search (L3: Vectors DB) ──────────────
    /**
     * Semantic search across an agent's indexed memory.
     */
    async semanticSearch(agentId, query, opts) {
        const db = this.dbManager.getVectorDb(agentId);
        if (!db) {
            console.warn('[hypermem] Semantic search unavailable — sqlite-vec not loaded');
            return [];
        }
        const libraryDb = this.dbManager.getLibraryDb();
        const vs = new VectorStore(db, this.config.embedding, libraryDb);
        return vs.search(query, opts);
    }
    /**
     * Index all un-indexed content for an agent.
     */
    async indexAgent(agentId) {
        const db = this.dbManager.getVectorDb(agentId);
        if (!db)
            return { indexed: 0, skipped: 0, tombstoned: 0 };
        const libraryDb = this.dbManager.getLibraryDb();
        const vs = new VectorStore(db, this.config.embedding, libraryDb);
        vs.ensureTables();
        const result = await vs.indexAll(agentId);
        // Tombstone superseded facts/knowledge so they don't surface in recall
        const tombstoned = vs.tombstoneSuperseded();
        return { ...result, tombstoned };
    }
    /**
     * Get vector index statistics.
     */
    getVectorStats(agentId) {
        const db = this.dbManager.getVectorDb(agentId);
        if (!db)
            return null;
        const libraryDb = this.dbManager.getLibraryDb();
        const vs = new VectorStore(db, this.config.embedding, libraryDb);
        return vs.getStats();
    }
    /**
     * Prune orphaned vector entries.
     */
    pruneVectorOrphans(agentId) {
        const db = this.dbManager.getVectorDb(agentId);
        if (!db)
            return 0;
        const libraryDb = this.dbManager.getLibraryDb();
        const vs = new VectorStore(db, this.config.embedding, libraryDb);
        return vs.pruneOrphans();
    }
    // ─── Session Cursor (dual-read: Redis → SQLite fallback) ──────
    /**
     * Get the session cursor for an agent+session.
     * Reads from Redis first; falls back to SQLite if Redis returns null
     * (e.g. after eviction or restart). This is the P1.3 durability guarantee.
     */
    async getSessionCursor(agentId, sessionKey) {
        // Try Redis first (hot path)
        const redisCursor = await this.cache.getCursor(agentId, sessionKey);
        if (redisCursor)
            return redisCursor;
        // Fallback to SQLite
        const db = this.dbManager.getMessageDb(agentId);
        if (!db)
            return null;
        const row = db.prepare(`
      SELECT cursor_last_sent_id, cursor_last_sent_index, cursor_last_sent_at,
             cursor_window_size, cursor_token_count
      FROM conversations
      WHERE session_key = ? AND cursor_last_sent_id IS NOT NULL
    `).get(sessionKey);
        if (!row || row.cursor_last_sent_id == null)
            return null;
        const cursor = {
            lastSentId: row.cursor_last_sent_id,
            lastSentIndex: row.cursor_last_sent_index,
            lastSentAt: row.cursor_last_sent_at,
            windowSize: row.cursor_window_size,
            tokenCount: row.cursor_token_count,
        };
        // Re-warm Redis so subsequent reads are fast
        try {
            await this.cache.setCursor(agentId, sessionKey, cursor);
        }
        catch {
            // Best-effort re-warm
        }
        return cursor;
    }
    // ─── Message Rotation (L2: Messages) ────────────────────────
    /**
     * Get the size of an agent's active messages.db in bytes.
     */
    getMessageDbSize(agentId) {
        return this.dbManager.getMessageDbSize(agentId);
    }
    /**
     * Check if an agent's message database needs rotation.
     */
    shouldRotate(agentId, opts) {
        return this.dbManager.shouldRotate(agentId, opts);
    }
    /**
     * Rotate an agent's message database.
     * Returns the path to the rotated file, or null if no active DB exists.
     */
    rotateMessageDb(agentId) {
        return this.dbManager.rotateMessageDb(agentId);
    }
    /**
     * List rotated message DB files for an agent.
     */
    listRotatedDbs(agentId) {
        return this.dbManager.listRotatedDbs(agentId);
    }
    /**
     * Check and auto-rotate all agents' message databases.
     * Call on heartbeat/startup.
     * Returns agents that were rotated.
     */
    autoRotate(opts) {
        const agents = this.dbManager.listAgents();
        const rotated = [];
        for (const agentId of agents) {
            const check = this.shouldRotate(agentId, opts);
            if (check) {
                const rotatedPath = this.rotateMessageDb(agentId);
                if (rotatedPath) {
                    rotated.push({
                        agentId,
                        reason: `${check.reason}: ${check.current} > ${check.threshold}`,
                        rotatedTo: rotatedPath,
                    });
                }
            }
        }
        return rotated;
    }
    // ─── Session Registry (L4: Library) ─────────────────────────
    /**
     * Register a session start.
     */
    registerSession(sessionKey, agentId, opts) {
        const db = this.dbManager.getLibraryDb();
        const now = new Date().toISOString();
        const existing = db
            .prepare('SELECT id FROM session_registry WHERE id = ?')
            .get(sessionKey);
        if (existing) {
            db.prepare('UPDATE session_registry SET status = ?, started_at = ? WHERE id = ?')
                .run('active', now, sessionKey);
        }
        else {
            db.prepare(`INSERT INTO session_registry (id, agent_id, channel, channel_type, started_at, status)
         VALUES (?, ?, ?, ?, ?, 'active')`).run(sessionKey, agentId, opts?.channel || null, opts?.channelType || null, now);
        }
        db.prepare('INSERT INTO session_events (session_id, event_type, timestamp, payload) VALUES (?, ?, ?, ?)').run(sessionKey, 'start', now, JSON.stringify({ channel: opts?.channel, channelType: opts?.channelType }));
    }
    /**
     * Record a session event.
     */
    recordSessionEvent(sessionKey, eventType, payload) {
        const db = this.dbManager.getLibraryDb();
        db.prepare('INSERT INTO session_events (session_id, event_type, timestamp, payload) VALUES (?, ?, ?, ?)').run(sessionKey, eventType, new Date().toISOString(), payload ? JSON.stringify(payload) : null);
        if (eventType === 'decision') {
            db.prepare('UPDATE session_registry SET decisions_made = decisions_made + 1 WHERE id = ?').run(sessionKey);
        }
        else if (eventType === 'fact_extracted') {
            db.prepare('UPDATE session_registry SET facts_extracted = facts_extracted + 1 WHERE id = ?').run(sessionKey);
        }
    }
    /**
     * Close a session.
     */
    closeSession(sessionKey, summary) {
        const db = this.dbManager.getLibraryDb();
        const now = new Date().toISOString();
        db.prepare('UPDATE session_registry SET status = ?, ended_at = ?, summary = ? WHERE id = ?').run('completed', now, summary || null, sessionKey);
        db.prepare('INSERT INTO session_events (session_id, event_type, timestamp) VALUES (?, ?, ?)').run(sessionKey, 'completion', now);
    }
    /**
     * Query sessions.
     */
    querySessions(opts) {
        const db = this.dbManager.getLibraryDb();
        const conditions = [];
        const params = [];
        if (opts?.agentId) {
            conditions.push('agent_id = ?');
            params.push(opts.agentId);
        }
        if (opts?.status) {
            conditions.push('status = ?');
            params.push(opts.status);
        }
        if (opts?.since) {
            conditions.push('started_at >= ?');
            params.push(opts.since);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        return db
            .prepare(`SELECT * FROM session_registry ${where} ORDER BY started_at DESC LIMIT ?`)
            .all(...params, opts?.limit || 50);
    }
    /**
     * Get session events.
     */
    getSessionEvents(sessionKey, limit = 50) {
        const db = this.dbManager.getLibraryDb();
        return db
            .prepare('SELECT * FROM session_events WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?')
            .all(sessionKey, limit);
    }
    // ─── Cross-Agent Queries ─────────────────────────────────────
    /**
     * Query another agent's memory with visibility-scoped access.
     */
    queryAgent(requesterId, targetAgentId, opts, registry) {
        return crossAgentQuery(this.dbManager, {
            requesterId,
            targetAgentId,
            memoryType: opts?.memoryType || 'facts',
            domain: opts?.domain,
            limit: opts?.limit,
        }, registry || buildOrgRegistryFromDb(this.dbManager.getLibraryDb()));
    }
    /**
     * Query fleet-wide visible memory.
     */
    queryFleet(requesterId, opts, registry) {
        const reg = registry || buildOrgRegistryFromDb(this.dbManager.getLibraryDb());
        const results = [];
        // Query all agents from the fleet registry
        const libraryDb = this.dbManager.getLibraryDb();
        const agents = libraryDb
            .prepare("SELECT id FROM fleet_agents WHERE status = 'active'")
            .all();
        for (const agent of agents) {
            if (agent.id === requesterId)
                continue;
            try {
                const agentResults = this.queryAgent(requesterId, agent.id, opts, reg);
                results.push(...agentResults);
            }
            catch {
                // Skip agents we can't query (not in registry)
            }
        }
        return results;
    }
    // ─── Document Chunks (L4: Library) ──────────────────────────
    /**
     * Index chunks from a parsed set of DocChunk objects.
     * Atomic: replaces all chunks for the source in one transaction.
     */
    indexDocChunks(chunks) {
        const db = this.dbManager.getLibraryDb();
        const store = new DocChunkStore(db);
        return store.indexChunks(chunks);
    }
    /**
     * Query doc chunks by collection with optional keyword/scope/agent filters.
     */
    queryDocChunks(query) {
        const db = this.dbManager.getLibraryDb();
        const store = new DocChunkStore(db);
        return store.queryChunks(query);
    }
    /**
     * Seed all ACA files from a workspace directory into the doc chunk index.
     * Idempotent: skips files whose source hash hasn't changed.
     * Force re-index with opts.force = true.
     */
    async seedWorkspace(workspaceDir, opts = {}) {
        const db = this.dbManager.getLibraryDb();
        const seeder = new WorkspaceSeeder(db);
        return seeder.seedWorkspace(workspaceDir, opts);
    }
    /**
     * Seed a single file into the doc chunk index.
     */
    seedFile(filePath, collection, opts = {}) {
        const db = this.dbManager.getLibraryDb();
        const seeder = new WorkspaceSeeder(db);
        return seeder.seedFile(filePath, collection, opts);
    }
    /**
     * Get stats about the current doc chunk index.
     */
    getDocIndexStats() {
        const db = this.dbManager.getLibraryDb();
        const store = new DocChunkStore(db);
        return store.getStats();
    }
    /**
     * List indexed sources (what files have been seeded and their hashes).
     */
    listDocSources(opts) {
        const db = this.dbManager.getLibraryDb();
        const store = new DocChunkStore(db);
        return store.listSources(opts);
    }
    // ─── Fleet Startup Seeding + Cache Hydration ────────────────
    /**
     * Seed fleet agents from known workspace identity files and existing
     * message-db agent directories, then optionally hydrate the Redis fleet cache.
     *
     * The sweep is idempotent: existing rows are only updated when startup-discovered
     * values differ, so repeated boots do not duplicate or churn fleet rows.
     */
    async seedFleetAgentsOnStartup(opts = {}) {
        const db = this.dbManager.getLibraryDb();
        const store = new FleetStore(db);
        const discovered = discoverStartupFleetCandidates(this.dbManager, opts);
        let inserted = 0;
        let updated = 0;
        let skipped = 0;
        let orgsCreated = 0;
        for (const candidate of discovered) {
            const existing = store.getAgent(candidate.agentId);
            const mergedMetadata = {
                ...(existing?.metadata ?? {}),
                ...(candidate.metadata ?? {}),
            };
            if (!existing) {
                store.upsertAgent(candidate.agentId, {
                    displayName: candidate.displayName,
                    tier: candidate.tier,
                    orgId: candidate.orgId ?? undefined,
                    reportsTo: candidate.reportsTo ?? undefined,
                    status: 'active',
                    metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
                });
                inserted++;
                continue;
            }
            const patch = {};
            if (candidate.displayName && candidate.displayName !== existing.displayName) {
                patch.displayName = candidate.displayName;
            }
            if (candidate.tier && candidate.tier !== 'unknown' && candidate.tier !== existing.tier) {
                patch.tier = candidate.tier;
            }
            if (candidate.orgId && candidate.orgId !== existing.orgId) {
                patch.orgId = candidate.orgId;
            }
            if (candidate.reportsTo && candidate.reportsTo !== existing.reportsTo) {
                patch.reportsTo = candidate.reportsTo;
            }
            if (JSON.stringify(mergedMetadata) !== JSON.stringify(existing.metadata ?? {})) {
                patch.metadata = mergedMetadata;
            }
            if (Object.keys(patch).length === 0) {
                skipped++;
                continue;
            }
            store.upsertAgent(candidate.agentId, patch);
            updated++;
        }
        for (const candidate of discovered) {
            if (!candidate.orgId)
                continue;
            if (store.getOrg(candidate.orgId))
                continue;
            if (candidate.tier !== 'council')
                continue;
            store.upsertOrg(candidate.orgId, {
                name: `${candidate.displayName} Org`,
                leadAgentId: candidate.agentId,
            });
            orgsCreated++;
        }
        let hydratedAgents = 0;
        let hydratedSummary = false;
        if (opts.hydrateCache !== false) {
            const hydrated = await this.hydrateFleetCache();
            hydratedAgents = hydrated.agents;
            hydratedSummary = hydrated.summary;
        }
        return {
            discovered: discovered.length,
            inserted,
            updated,
            skipped,
            orgsCreated,
            hydratedAgents,
            hydratedSummary,
        };
    }
    /**
     * Hydrate the Redis fleet cache from library.db.
     * Call on gateway startup to warm the cache for dashboard queries.
     *
     * Populates:
     *  - Per-agent profiles (fleet registry + capabilities + desired state)
     *  - Fleet summary (counts, drift status)
     */
    async hydrateFleetCache() {
        if (!this.cache.isConnected)
            return { agents: 0, summary: false };
        const db = this.dbManager.getLibraryDb();
        const fleetStore = new FleetStore(db);
        const desiredStore = new DesiredStateStore(db);
        const agents = fleetStore.listAgents();
        let hydrated = 0;
        for (const agent of agents) {
            try {
                // Build a composite profile for each agent
                const capabilities = fleetStore.getAgentCapabilities(agent.id);
                const desiredState = desiredStore.getAgentState(agent.id);
                const desiredConfig = desiredStore.getAgentConfig(agent.id);
                const composite = {
                    ...agent,
                    capabilities: capabilities.map(c => ({ capType: c.capType, name: c.name, version: c.version })),
                    desiredState: desiredState.map(d => ({
                        configKey: d.configKey,
                        desiredValue: d.desiredValue,
                        actualValue: d.actualValue,
                        driftStatus: d.driftStatus,
                    })),
                    desiredConfig,
                };
                await this.cache.cacheFleetAgent(agent.id, composite);
                hydrated++;
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                console.warn(`[hypermem] Failed to cache agent ${agent.id}: ${message}`);
            }
        }
        // Cache fleet summary
        try {
            const driftSummary = desiredStore.getDriftSummary();
            const summary = {
                totalAgents: agents.length,
                activeAgents: agents.filter(a => a.status === 'active').length,
                tiers: {
                    council: agents.filter(a => a.tier === 'council').length,
                    director: agents.filter(a => a.tier === 'director').length,
                    specialist: agents.filter(a => a.tier === 'specialist').length,
                },
                drift: driftSummary,
                hydratedAt: new Date().toISOString(),
            };
            await this.cache.cacheFleetSummary(summary);
        }
        catch {
            return { agents: hydrated, summary: false };
        }
        return { agents: hydrated, summary: true };
    }
    // ─── Lifecycle ───────────────────────────────────────────────
    /**
     * Clean shutdown.
     */
    async close() {
        await this.cache.disconnect();
        this.dbManager.close();
    }
}
export default HyperMem;
export { SessionFlusher, flushSession } from './session-flusher.js';
export { importVault, watchVault, parseObsidianNote, parseFrontmatter, extractWikilinks, extractTags, cleanObsidianMarkdown } from './obsidian-watcher.js';
export { exportToVault } from './obsidian-exporter.js';
export { collectMetrics, formatMetricsSummary } from './metrics-dashboard.js';
export { getProfile, mergeProfile, PROFILES, lightProfile, standardProfile, fullProfile, extendedProfile, minimalProfile, richProfile } from './profiles.js';
export { renderStarterFOS, resolveOutputTier } from './fos-mod.js';
export { repairToolPairs } from './repair-tool-pairs.js';
//# sourceMappingURL=index.js.map