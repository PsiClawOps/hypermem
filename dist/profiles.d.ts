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
import type { HyperMemConfig, EmbeddingProviderConfig } from './types.js';
/** Gemini embedding preset — use with mergeProfile() when switching fleet to Gemini. */
export declare const GEMINI_EMBEDDING: Partial<EmbeddingProviderConfig>;
export declare const lightProfile: HyperMemConfig;
export declare const standardProfile: HyperMemConfig;
export declare const fullProfile: HyperMemConfig;
export type ProfileName = 'light' | 'standard' | 'full';
export declare const minimalProfile: HyperMemConfig;
export declare const extendedProfile: HyperMemConfig;
export declare const richProfile: HyperMemConfig;
export declare const PROFILES: Record<ProfileName, HyperMemConfig>;
/**
 * Load a named profile.
 *
 * @example
 * const config = getProfile('light');
 * const hm = createHyperMem(config);
 */
export declare function getProfile(name: ProfileName | 'extended'): HyperMemConfig;
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
export declare function mergeProfile(name: ProfileName | 'extended', overrides: DeepPartial<HyperMemConfig>): HyperMemConfig;
type DeepPartial<T> = {
    [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
export {};
//# sourceMappingURL=profiles.d.ts.map