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

import type { HyperMemConfig, CompositorConfig, IndexerConfig, EmbeddingProviderConfig, CacheConfig } from './types.js';

// ---------------------------------------------------------------------------
// Shared base (fields common across all profiles)
// ---------------------------------------------------------------------------

const BASE_CACHE: CacheConfig = {
  keyPrefix: 'hm:',
  sessionTTL: 3600,
  historyTTL: 86400,
};

const BASE_EMBEDDING: EmbeddingProviderConfig = {
  ollamaUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
  timeout: 10000,
  batchSize: 32,
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

const LIGHT_COMPOSITOR: CompositorConfig = {
  budgetFraction: 0.625,               // 40k effective at 64k window
  defaultTokenBudget: 40000,           // absolute fallback when model detection fails
  maxHistoryMessages: 200,
  maxFacts: 15,
  maxCrossSessionContext: 0,
  maxRecentToolPairs: 2,
  maxProseToolPairs: 4,
  warmHistoryBudgetFraction: 0.35,
  contextWindowReserve: 0.35,          // generous reserve for tool call responses
  dynamicReserveEnabled: true,
  dynamicReserveTurnHorizon: 3,
  dynamicReserveMax: 0.50,
  keystoneHistoryFraction: 0.1,
  keystoneMaxMessages: 5,
  keystoneMinSignificance: 0.7,
  targetBudgetFraction: 0.50,          // Anvil spec: 0.50 for light
  maxTotalTriggerTokens: 1500,
  hyperformProfile: 'light',           // standalone density directives only, no fleet concepts
  wikiTokenCap: 300,                   // Anvil spec: 300 for light
};

const LIGHT_INDEXER: IndexerConfig = {
  enabled: true,
  factExtractionMode: 'pattern',    // pattern only — tiered extraction is heavier
  topicDormantAfter: '12h',         // faster dormancy — small systems don't need long windows
  topicClosedAfter: '48h',
  factDecayRate: 0.05,              // slightly faster decay — fewer facts, keep them fresh
  episodeSignificanceThreshold: 0.6, // higher bar — only store meaningful episodes
  periodicInterval: 120000,         // 2min — less frequent background work on small systems
        batchSize: 64,
        maxMessagesPerTick: 200,
};

export const lightProfile: HyperMemConfig = {
  enabled: true,
  dataDir: './hypermem-data',
  cache: BASE_CACHE,
  compositor: LIGHT_COMPOSITOR,
  indexer: LIGHT_INDEXER,
  embedding: {
    ...BASE_EMBEDDING,
    batchSize: 8,                   // smaller batches — don't spike memory on embed
    timeout: 15000,                 // more generous timeout — local hardware can be slow
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

const STANDARD_COMPOSITOR: CompositorConfig = {
  budgetFraction: 0.703,               // 90k effective at 128k window
  defaultTokenBudget: 90000,
  maxHistoryMessages: 500,
  maxFacts: 30,
  maxCrossSessionContext: 4000,
  maxRecentToolPairs: 3,
  maxProseToolPairs: 10,
  warmHistoryBudgetFraction: 0.40,
  contextWindowReserve: 0.25,          // balanced reserve for tool call responses
  dynamicReserveEnabled: true,
  dynamicReserveTurnHorizon: 5,
  dynamicReserveMax: 0.50,
  keystoneHistoryFraction: 0.20,
  keystoneMaxMessages: 15,
  keystoneMinSignificance: 0.5,
  targetBudgetFraction: 0.65,          // Anvil spec: 0.65 for standard
  maxTotalTriggerTokens: 4000,
  hyperformProfile: 'standard',        // full FOS, MOD suppressed
  wikiTokenCap: 600,                   // Anvil spec: 600 for standard
};

const STANDARD_INDEXER: IndexerConfig = {
  enabled: true,
  factExtractionMode: 'tiered',
  topicDormantAfter: '24h',
  topicClosedAfter: '72h',
  factDecayRate: 0.02,
  episodeSignificanceThreshold: 0.5,
  periodicInterval: 60000,          // 1min — standard background cadence
        batchSize: 128,
        maxMessagesPerTick: 500,
};

export const standardProfile: HyperMemConfig = {
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

const EXTENDED_COMPOSITOR: CompositorConfig = {
  budgetFraction: 0.588,               // 160k effective at 272k window
  defaultTokenBudget: 160000,
  maxHistoryMessages: 1000,
  maxFacts: 60,
  maxCrossSessionContext: 12000,
  maxRecentToolPairs: 5,
  maxProseToolPairs: 15,
  warmHistoryBudgetFraction: 0.45,
  contextWindowReserve: 0.20,          // tight reserve; large windows have natural headroom
  dynamicReserveEnabled: true,
  dynamicReserveTurnHorizon: 7,
  dynamicReserveMax: 0.45,
  keystoneHistoryFraction: 0.25,
  keystoneMaxMessages: 30,
  keystoneMinSignificance: 0.4,
  targetBudgetFraction: 0.55,          // Anvil spec: 0.55 for extended (history is huge, budget carefully)
  maxTotalTriggerTokens: 10000,
  hyperformProfile: 'full',            // FOS + MOD — full fleet spec
  wikiTokenCap: 800,                   // Anvil spec: 800 for extended
};

const EXTENDED_INDEXER: IndexerConfig = {
  enabled: true,
  factExtractionMode: 'tiered',
  topicDormantAfter: '48h',
  topicClosedAfter: '168h',         // 7 days — long-running council topics stay warm
  factDecayRate: 0.01,              // slow decay — preserve more institutional memory
  episodeSignificanceThreshold: 0.4,
  periodicInterval: 30000,          // 30s — frequent background work for fleet throughput
        batchSize: 256,
        maxMessagesPerTick: 1000,
};

export const fullProfile: HyperMemConfig = {
  enabled: true,
  dataDir: './hypermem-data',
  cache: BASE_CACHE,
  compositor: EXTENDED_COMPOSITOR,
  indexer: EXTENDED_INDEXER,
  embedding: {
    ...BASE_EMBEDDING,
    batchSize: 64,                  // larger batches — more throughput for fleet ingest
    timeout: 8000,                  // tighter timeout — expect capable hardware
  },
};

// ---------------------------------------------------------------------------
// Profile registry
// ---------------------------------------------------------------------------

export type ProfileName = 'light' | 'standard' | 'full';

// Legacy aliases — kept for backward compat, removed in 1.0
export const minimalProfile = lightProfile;
export const extendedProfile = fullProfile;
export const richProfile = fullProfile;

export const PROFILES: Record<ProfileName, HyperMemConfig> = {
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
export function getProfile(name: ProfileName | 'extended'): HyperMemConfig {
  // backward compat
  if ((name as string) === 'extended') return structuredClone(fullProfile);
  return structuredClone(PROFILES[name as ProfileName]);
}

/**
 * Merge a partial config on top of a named profile.
 * Deep-merges compositor and indexer; top-level fields are replaced.
 *
 * @example
 * const config = mergeProfile('light', {
 *   cache: { keyPrefix: 'myapp:' },
 *   compositor: { hyperformProfile: 'standard' },  // upgrade tier
 * });
 */
export function mergeProfile(
  name: ProfileName | 'extended',
  overrides: DeepPartial<HyperMemConfig>,
): HyperMemConfig {
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

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
