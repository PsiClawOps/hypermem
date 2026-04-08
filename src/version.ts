/** Release version — matches package.json and is stamped into library.db on every startup. */
export const ENGINE_VERSION = '0.5.0';

/** Minimum Node.js version required — matches package.json engines field. */
export const MIN_NODE_VERSION = '22.0.0';

/** Minimum Redis server version required (ioredis 5.x supports Redis 6+). */
export const MIN_REDIS_VERSION = '6.0.0';

/** sqlite-vec version bundled with this release. */
export const SQLITE_VEC_VERSION = '0.1.9';

/**
 * Main DB (hypermem.db) schema version.
 * Re-exported here for convenience; authoritative value lives in schema.ts.
 */
export const MAIN_SCHEMA_VERSION = 6;

/**
 * Library DB (library.db) schema version.
 * Re-exported here for convenience; authoritative value lives in library-schema.ts.
 */
export const LIBRARY_SCHEMA_VERSION_EXPORT = 12;
