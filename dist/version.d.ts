/** Release version — matches package.json and is stamped into library.db on every startup. */
export declare const ENGINE_VERSION: string;
/** Minimum Node.js version required — matches package.json engines field. */
export declare const MIN_NODE_VERSION = "22.0.0";
/** @deprecated No longer used — Redis was replaced with SQLite :memory: CacheLayer. */
export declare const MIN_REDIS_VERSION = "7.0.0";
/** sqlite-vec version bundled with this release. */
export declare const SQLITE_VEC_VERSION = "0.1.9";
/**
 * Main DB (messages.db) schema version.
 * Re-exported here for convenience; authoritative value lives in schema.ts.
 */
export declare const MAIN_SCHEMA_VERSION = 11;
/**
 * Library DB (library.db) schema version.
 * Re-exported here for convenience; authoritative value lives in library-schema.ts.
 */
export declare const LIBRARY_SCHEMA_VERSION_EXPORT = 19;
/**
 * Compatibility version — the single number operators and consumers check.
 * Maps to: messages.db schema v11, library schema v19.
 * Matches ENGINE_VERSION for the running release.
 */
export declare const HYPERMEM_COMPAT_VERSION: string;
/**
 * Schema compatibility map — machine-readable version requirements.
 * Use this to verify DB schemas match the running engine.
 */
export declare const SCHEMA_COMPAT: {
    readonly compatVersion: string;
    readonly mainSchema: 11;
    readonly librarySchema: 19;
};
//# sourceMappingURL=version.d.ts.map