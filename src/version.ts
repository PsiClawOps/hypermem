/** Release version — matches package.json and is stamped into library.db on every startup. */
export const ENGINE_VERSION = '0.8.2';

/** Minimum Node.js version required — matches package.json engines field. */
export const MIN_NODE_VERSION = '22.0.0';

/** @deprecated No longer used — Redis was replaced with SQLite :memory: CacheLayer. */
export const MIN_REDIS_VERSION = '7.0.0';

/** sqlite-vec version bundled with this release. */
export const SQLITE_VEC_VERSION = '0.1.9';

/**
 * Main DB (messages.db) schema version.
 * Re-exported here for convenience; authoritative value lives in schema.ts.
 */
export const MAIN_SCHEMA_VERSION = 10;

/**
 * Library DB (library.db) schema version.
 * Re-exported here for convenience; authoritative value lives in library-schema.ts.
 */
export const LIBRARY_SCHEMA_VERSION_EXPORT = 19;

/**
 * Compatibility version — the single number operators and consumers check.
 * Maps to: messages.db schema v10, library schema v19.
 * Matches ENGINE_VERSION for the 0.8.2 release.
 */
export const HYPERMEM_COMPAT_VERSION = '0.8.2';

/**
 * Schema compatibility map — machine-readable version requirements.
 * Use this to verify DB schemas match the running engine.
 */
export const SCHEMA_COMPAT = {
  compatVersion: '0.8.2',
  mainSchema: 10,
  librarySchema: 19,
} as const;
