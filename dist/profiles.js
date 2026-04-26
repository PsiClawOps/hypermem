/**
 * hypermem configuration profiles
 *
 * Pre-built configs for common deployment patterns. Pass to createHyperMem()
 * directly or use as a base for custom configs via mergeProfile().
 *
 * Profiles:
 *   minimal  — 64k context, single agent, low resource usage
 *   standard — 128k context, fleet default, balanced
 *   rich     — 200k+ context, multi-agent, full feature set
 */
// ---------------------------------------------------------------------------
// Shared base (fields common across all profiles)
// ---------------------------------------------------------------------------
const BASE_CACHE = {
    keyPrefix: 'hm:',
    sessionTTL: 3600,
    historyTTL: 86400,
};
const BASE_EMBEDDING = {
    ollamaUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    dimensions: 768,
    timeout: 10000,
    batchSize: 32,
};
/** Gemini embedding preset — use with mergeProfile() when switching fleet to Gemini. */
export const GEMINI_EMBEDDING = {
    provider: 'gemini',
    model: 'gemini-embedding-2-preview',
    dimensions: 3072,
    timeout: 15000,
    batchSize: 100,
};
// ---------------------------------------------------------------------------
// light — 64k context window, single agent, constrained resources
//
// Design intent:
//   - Small local models (Mistral 7B, Phi-3, Llama 3 8B) at 64k context
//   - Single agent — no cross-session context needed
//   - Minimal ACA stack — no dreaming, no background indexing overhead
//   - Low Redis churn — longer flush intervals, shorter history window
//   - hyperformProfile: 'light' — ~100 token standalone directives, no fleet concepts
//   - No parallel operations — sequential fact extraction only
// ---------------------------------------------------------------------------
const LIGHT_COMPOSITOR = {
    // ── Primary budget controls ──
    budgetFraction: 0.625, // 40k effective at 64k window
    reserveFraction: 0.35, // generous — small systems do heavy tool work
    historyFraction: 0.35, // ~14k tokens of conversation history
    memoryFraction: 0.30, // ~12k tokens for facts/wiki/semantic
    // ── Absolute fallback ──
    defaultTokenBudget: 40000,
    // ── History internals ──
    maxHistoryMessages: 200,
    warmHistoryBudgetFraction: 0.35,
    keystoneHistoryFraction: 0.1,
    keystoneMaxMessages: 5,
    keystoneMinSignificance: 0.7,
    // ── Memory internals ──
    maxFacts: 15,
    maxCrossSessionContext: 0,
    maxTotalTriggerTokens: 1500,
    wikiTokenCap: 300,
    // ── Tool gradient (internal — safe floor enforced automatically) ──
    maxRecentToolPairs: 2,
    maxProseToolPairs: 4,
    // ── Dynamic reserve ──
    dynamicReserveEnabled: true,
    dynamicReserveTurnHorizon: 3,
    dynamicReserveMax: 0.50,
    // ── HyperForm ──
    hyperformProfile: 'light',
};
const LIGHT_INDEXER = {
    enabled: true,
    factExtractionMode: 'pattern', // pattern only — tiered extraction is heavier
    topicDormantAfter: '12h', // faster dormancy — small systems don't need long windows
    topicClosedAfter: '48h',
    factDecayRate: 0.05, // slightly faster decay — fewer facts, keep them fresh
    episodeSignificanceThreshold: 0.6, // higher bar — only store meaningful episodes
    periodicInterval: 120000, // 2min — less frequent background work on small systems
    batchSize: 64,
    maxMessagesPerTick: 200,
};
export const lightProfile = {
    enabled: true,
    dataDir: './hypermem-data',
    cache: BASE_CACHE,
    compositor: LIGHT_COMPOSITOR,
    indexer: LIGHT_INDEXER,
    embedding: {
        ...BASE_EMBEDDING,
        batchSize: 8, // smaller batches — don't spike memory on embed
        timeout: 15000, // more generous timeout — local hardware can be slow
    },
    // dreaming: disabled (default) — don't run background promotion on small systems
    // obsidian: disabled (default)
};
// ---------------------------------------------------------------------------
// standard — 128k context window, fleet default, balanced
//
// Design intent:
//   - Mid-range models (Sonnet, GPT-5-mini, Gemini Flash) at 128k
//   - Small multi-agent setups or single power-user agents
//   - Full ACA stack — dreaming optional, background indexing on
//   - hyperformProfile: 'standard' — full FOS, no MOD
// ---------------------------------------------------------------------------
const STANDARD_COMPOSITOR = {
    // ── Primary budget controls ──
    budgetFraction: 0.703, // 90k effective at 128k window
    reserveFraction: 0.25, // balanced — leaves room for large tool results
    historyFraction: 0.40, // ~27k tokens of conversation history
    memoryFraction: 0.40, // ~27k tokens for facts/wiki/semantic
    // ── Absolute fallback ──
    defaultTokenBudget: 90000,
    // ── History internals ──
    maxHistoryMessages: 500,
    warmHistoryBudgetFraction: 0.40,
    keystoneHistoryFraction: 0.20,
    keystoneMaxMessages: 15,
    keystoneMinSignificance: 0.5,
    // ── Memory internals ──
    maxFacts: 30,
    maxCrossSessionContext: 4000,
    maxTotalTriggerTokens: 4000,
    wikiTokenCap: 600,
    // ── Tool gradient (internal — safe floor enforced automatically) ──
    maxRecentToolPairs: 3,
    maxProseToolPairs: 10,
    // ── Dynamic reserve ──
    dynamicReserveEnabled: true,
    dynamicReserveTurnHorizon: 5,
    dynamicReserveMax: 0.50,
    // ── HyperForm ──
    hyperformProfile: 'standard',
};
const STANDARD_INDEXER = {
    enabled: true,
    factExtractionMode: 'tiered',
    topicDormantAfter: '24h',
    topicClosedAfter: '72h',
    factDecayRate: 0.02,
    episodeSignificanceThreshold: 0.5,
    periodicInterval: 60000, // 1min — standard background cadence
    batchSize: 128,
    maxMessagesPerTick: 500,
};
export const standardProfile = {
    enabled: true,
    dataDir: './hypermem-data',
    cache: BASE_CACHE,
    compositor: STANDARD_COMPOSITOR,
    indexer: STANDARD_INDEXER,
    embedding: BASE_EMBEDDING,
};
// ---------------------------------------------------------------------------
// extended — 200k+ context window, multi-agent, full feature set
//
// Design intent:
//   - Large context models (Opus, GPT-5.4, Gemini Pro) at 200k+
//   - Council / multi-agent fleet deployments
//   - Full ACA stack including dreaming, background indexing, cross-session
//   - hyperformProfile: 'full' — FOS + MOD, full spec
//   - Higher keystone threshold — more historical context worth surfacing
// ---------------------------------------------------------------------------
const EXTENDED_COMPOSITOR = {
    // ── Primary budget controls ──
    budgetFraction: 0.588, // 160k effective at 272k window
    reserveFraction: 0.20, // tighter — large windows have natural headroom
    historyFraction: 0.45, // ~72k tokens of conversation history
    memoryFraction: 0.40, // ~64k tokens for facts/wiki/semantic
    // ── Absolute fallback ──
    defaultTokenBudget: 160000,
    // ── History internals ──
    maxHistoryMessages: 1000,
    warmHistoryBudgetFraction: 0.45,
    keystoneHistoryFraction: 0.25,
    keystoneMaxMessages: 30,
    keystoneMinSignificance: 0.4,
    // ── Memory internals ──
    maxFacts: 60,
    maxCrossSessionContext: 12000,
    maxTotalTriggerTokens: 10000,
    wikiTokenCap: 800,
    // ── Tool gradient (internal — safe floor enforced automatically) ──
    maxRecentToolPairs: 5,
    maxProseToolPairs: 15,
    // ── Dynamic reserve ──
    dynamicReserveEnabled: true,
    dynamicReserveTurnHorizon: 7,
    dynamicReserveMax: 0.45,
    // ── HyperForm ──
    hyperformProfile: 'full',
};
const EXTENDED_INDEXER = {
    enabled: true,
    factExtractionMode: 'tiered',
    topicDormantAfter: '48h',
    topicClosedAfter: '168h', // 7 days — long-running council topics stay warm
    factDecayRate: 0.01, // slow decay — preserve more institutional memory
    episodeSignificanceThreshold: 0.4,
    periodicInterval: 30000, // 30s — frequent background work for fleet throughput
    batchSize: 256,
    maxMessagesPerTick: 1000,
};
export const fullProfile = {
    enabled: true,
    dataDir: './hypermem-data',
    cache: BASE_CACHE,
    compositor: EXTENDED_COMPOSITOR,
    indexer: EXTENDED_INDEXER,
    embedding: {
        ...BASE_EMBEDDING,
        batchSize: 64, // larger batches — more throughput for fleet ingest
        timeout: 8000, // tighter timeout — expect capable hardware
    },
};
// Legacy aliases — kept for backward compat, removed in 1.0
export const minimalProfile = lightProfile;
export const extendedProfile = fullProfile;
export const richProfile = fullProfile;
export const PROFILES = {
    light: lightProfile,
    standard: standardProfile,
    full: fullProfile,
};
/**
 * Load a named profile.
 *
 * @example
 * const config = getProfile('light');
 * const hm = createHyperMem(config);
 */
export function getProfile(name) {
    // backward compat
    if (name === 'extended')
        return structuredClone(fullProfile);
    return structuredClone(PROFILES[name]);
}
/**
 * Merge a partial config on top of a named profile.
 * Deep-merges compositor and indexer; top-level fields are replaced.
 *
 * @example
 * const config = mergeProfile('light', {
 *   cache: { keyPrefix: 'myapp:' },
 *   compositor: { hyperformProfile: 'standard', memoryFraction: 0.50 },  // upgrade tier + more memory
 * });
 */
export function mergeProfile(name, overrides) {
    const base = getProfile(name);
    return {
        ...base,
        ...overrides,
        compositor: { ...base.compositor, ...(overrides.compositor ?? {}) },
        indexer: { ...base.indexer, ...(overrides.indexer ?? {}) },
        embedding: { ...base.embedding, ...(overrides.embedding ?? {}) },
        cache: { ...base.cache, ...(overrides.cache ?? {}) },
    };
}
//# sourceMappingURL=profiles.js.map