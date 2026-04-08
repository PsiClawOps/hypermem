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

import type { HyperMemConfig, CompositorConfig, IndexerConfig, EmbeddingProviderConfig, RedisConfig } from './types.js';

// ---------------------------------------------------------------------------
// Shared base (fields common across all profiles)
// ---------------------------------------------------------------------------

const BASE_REDIS: RedisConfig = {
  host: 'localhost',
  port: 6379,
  keyPrefix: 'hm:',
  sessionTTL: 3600,
  historyTTL: 86400,
  flushInterval: 5000,
};

const BASE_EMBEDDING: EmbeddingProviderConfig = {
  ollamaUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
  dimensions: 768,
  timeout: 10000,
  batchSize: 32,
};

// ---------------------------------------------------------------------------
// minimal — 64k context window, single agent, constrained resources
//
// Design intent:
//   - Small local models (Mistral 7B, Phi-3, Llama 3 8B) at 64k context
//   - Single agent — no cross-session context needed
//   - Minimal ACA stack — no dreaming, no background indexing overhead
//   - Low Redis churn — longer flush intervals, shorter history window
//   - FOS/MOD off — lightweight deployments usually manage output externally
//   - No parallel operations — sequential fact extraction only
// ---------------------------------------------------------------------------

const MINIMAL_COMPOSITOR: CompositorConfig = {
  defaultTokenBudget: 40000,        // leaves ~24k for model output at 64k window
  maxHistoryMessages: 200,          // keep window tight — small models lose coherence past ~150 msgs
  maxFacts: 15,                     // surface top facts only, don't swamp the window
  maxCrossSessionContext: 0,        // single agent — no cross-session
  maxRecentToolPairs: 2,            // minimal tool history
  maxProseToolPairs: 4,
  warmHistoryBudgetFraction: 0.35,  // slightly less history, more room for context
  contextWindowReserve: 0.35,       // generous reserve — small models need output headroom
  dynamicReserveEnabled: true,
  dynamicReserveTurnHorizon: 3,     // shorter horizon — small sessions
  dynamicReserveMax: 0.50,
  keystoneHistoryFraction: 0.1,     // light keystone — history window is already small
  keystoneMaxMessages: 5,
  keystoneMinSignificance: 0.7,     // higher bar — only high-signal keystone messages
  targetBudgetFraction: 0.40,       // conservative — leave plenty of room
  maxTotalTriggerTokens: 1500,      // tight trigger ceiling
  enableFOS: false,                 // manage output standards externally
  enableMOD: false,                 // skip per-model calibration overhead
};

const MINIMAL_INDEXER: IndexerConfig = {
  enabled: true,
  factExtractionMode: 'pattern',    // pattern only — tiered extraction is heavier
  topicDormantAfter: '12h',         // faster dormancy — small systems don't need long windows
  topicClosedAfter: '48h',
  factDecayRate: 0.05,              // slightly faster decay — fewer facts, keep them fresh
  episodeSignificanceThreshold: 0.6, // higher bar — only store meaningful episodes
  periodicInterval: 120000,         // 2min — less frequent background work on small systems
};

export const minimalProfile: HyperMemConfig = {
  enabled: true,
  dataDir: './hypermem-data',
  redis: BASE_REDIS,
  compositor: MINIMAL_COMPOSITOR,
  indexer: MINIMAL_INDEXER,
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
//   - FOS/MOD on — fleet output consistency
// ---------------------------------------------------------------------------

const STANDARD_COMPOSITOR: CompositorConfig = {
  defaultTokenBudget: 90000,
  maxHistoryMessages: 500,
  maxFacts: 30,
  maxCrossSessionContext: 4000,
  maxRecentToolPairs: 3,
  maxProseToolPairs: 10,
  warmHistoryBudgetFraction: 0.40,
  contextWindowReserve: 0.25,
  dynamicReserveEnabled: true,
  dynamicReserveTurnHorizon: 5,
  dynamicReserveMax: 0.50,
  keystoneHistoryFraction: 0.20,
  keystoneMaxMessages: 15,
  keystoneMinSignificance: 0.5,
  targetBudgetFraction: 0.65,
  maxTotalTriggerTokens: 4000,
  enableFOS: true,
  enableMOD: true,
};

const STANDARD_INDEXER: IndexerConfig = {
  enabled: true,
  factExtractionMode: 'tiered',
  topicDormantAfter: '24h',
  topicClosedAfter: '72h',
  factDecayRate: 0.02,
  episodeSignificanceThreshold: 0.5,
  periodicInterval: 60000,          // 1min — standard background cadence
};

export const standardProfile: HyperMemConfig = {
  enabled: true,
  dataDir: './hypermem-data',
  redis: BASE_REDIS,
  compositor: STANDARD_COMPOSITOR,
  indexer: STANDARD_INDEXER,
  embedding: BASE_EMBEDDING,
};

// ---------------------------------------------------------------------------
// rich — 200k+ context window, multi-agent, full feature set
//
// Design intent:
//   - Large context models (Opus, GPT-5.4, Gemini Pro) at 200k+
//   - Council / multi-agent fleet deployments
//   - Full ACA stack including dreaming, background indexing, cross-session
//   - FOS/MOD on — fleet output consistency critical at this scale
//   - Higher keystone threshold — more historical context worth surfacing
// ---------------------------------------------------------------------------

const RICH_COMPOSITOR: CompositorConfig = {
  defaultTokenBudget: 160000,
  maxHistoryMessages: 1000,
  maxFacts: 60,
  maxCrossSessionContext: 12000,
  maxRecentToolPairs: 5,
  maxProseToolPairs: 15,
  warmHistoryBudgetFraction: 0.45,
  contextWindowReserve: 0.20,
  dynamicReserveEnabled: true,
  dynamicReserveTurnHorizon: 7,
  dynamicReserveMax: 0.45,
  keystoneHistoryFraction: 0.25,
  keystoneMaxMessages: 30,
  keystoneMinSignificance: 0.4,
  targetBudgetFraction: 0.75,
  maxTotalTriggerTokens: 10000,
  enableFOS: true,
  enableMOD: true,
};

const RICH_INDEXER: IndexerConfig = {
  enabled: true,
  factExtractionMode: 'tiered',
  topicDormantAfter: '48h',
  topicClosedAfter: '168h',         // 7 days — long-running council topics stay warm
  factDecayRate: 0.01,              // slow decay — preserve more institutional memory
  episodeSignificanceThreshold: 0.4,
  periodicInterval: 30000,          // 30s — frequent background work for fleet throughput
};

export const richProfile: HyperMemConfig = {
  enabled: true,
  dataDir: './hypermem-data',
  redis: BASE_REDIS,
  compositor: RICH_COMPOSITOR,
  indexer: RICH_INDEXER,
  embedding: {
    ...BASE_EMBEDDING,
    batchSize: 64,                  // larger batches — more throughput for fleet ingest
    timeout: 8000,                  // tighter timeout — expect capable hardware
  },
};

// ---------------------------------------------------------------------------
// Profile registry
// ---------------------------------------------------------------------------

export type ProfileName = 'minimal' | 'standard' | 'rich';

export const PROFILES: Record<ProfileName, HyperMemConfig> = {
  minimal: minimalProfile,
  standard: standardProfile,
  rich: richProfile,
};

/**
 * Load a named profile.
 *
 * @example
 * const config = getProfile('minimal');
 * const hm = createHyperMem(config);
 */
export function getProfile(name: ProfileName): HyperMemConfig {
  return structuredClone(PROFILES[name]);
}

/**
 * Merge a partial config on top of a named profile.
 * Deep-merges compositor and indexer; top-level fields are replaced.
 *
 * @example
 * const config = mergeProfile('minimal', {
 *   redis: { host: 'redis.internal', port: 6380 },
 *   compositor: { enableFOS: true },   // re-enable FOS on minimal
 * });
 */
export function mergeProfile(
  name: ProfileName,
  overrides: DeepPartial<HyperMemConfig>,
): HyperMemConfig {
  const base = getProfile(name);
  return {
    ...base,
    ...overrides,
    compositor: { ...base.compositor, ...(overrides.compositor ?? {}) },
    indexer: { ...base.indexer, ...(overrides.indexer ?? {}) },
    embedding: { ...base.embedding, ...(overrides.embedding ?? {}) },
    redis: { ...base.redis, ...(overrides.redis ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
