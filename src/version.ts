import { readFileSync } from 'node:fs';

function readPackageVersion(): string {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const raw = readFileSync(pkgUrl, 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (!pkg.version) {
    throw new Error('hypermem package.json is missing a version field');
  }
  return pkg.version;
}

/** Release version — matches package.json and is stamped into library.db on every startup. */
export const ENGINE_VERSION = readPackageVersion();

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
export const MAIN_SCHEMA_VERSION = 11;

/**
 * Library DB (library.db) schema version.
 * Re-exported here for convenience; authoritative value lives in library-schema.ts.
 */
export const LIBRARY_SCHEMA_VERSION_EXPORT = 19;

/**
 * Compatibility version — the single number operators and consumers check.
 * Maps to: messages.db schema v11, library schema v19.
 * Matches ENGINE_VERSION for the running release.
 */
export const HYPERMEM_COMPAT_VERSION = ENGINE_VERSION;

/**
 * Schema compatibility map — machine-readable version requirements.
 * Use this to verify DB schemas match the running engine.
 */
export const SCHEMA_COMPAT = {
  compatVersion: HYPERMEM_COMPAT_VERSION,
  mainSchema: 11,
  librarySchema: 19,
} as const;
