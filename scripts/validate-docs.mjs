#!/usr/bin/env node

/**
 * validate-docs.mjs — Structural docs-vs-code accuracy gate
 *
 * Checks that user-facing documentation matches the actual repo state.
 * Wired into sync-public.mjs as a mandatory pre-sync gate.
 * Run standalone: node scripts/validate-docs.mjs
 *
 * Exit 0 = all checks pass
 * Exit 1 = at least one check failed (blocks release)
 *
 * Philosophy: every check here exists because a specific doc/code drift
 * shipped to users and caused real confusion. Don't add speculative checks.
 * Each check has a "why" comment linking to the incident.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel) => {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf-8') : null;
};

const failures = [];
const warnings = [];

function fail(check, detail) {
  failures.push({ check, detail });
}
function warn(check, detail) {
  warnings.push({ check, detail });
}

// ---------------------------------------------------------------------------
// 1. Dependency claims vs package.json
//    WHY: older docs shipped INSTALL.md requiring Redis. Redis was fully removed in 0.6.0.
// ---------------------------------------------------------------------------

const pkg = JSON.parse(read('package.json'));
const allDeps = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
  ...pkg.peerDependencies,
};

const install = read('INSTALL.md');
const readme = read('README.md');

// Map of: term → what to check for in deps
// If the doc mentions the term as required/needed, the dep should exist
const REMOVED_DEP_CLAIMS = [
  {
    term: 'Redis',
    patterns: [/redis\s+(?:is\s+)?required/i, /redis\s+7\+/i, /redis-cli\s+ping/i, /without\s+redis/i],
    depNames: ['redis', 'ioredis', '@redis/client'],
    message: 'INSTALL.md references Redis as required but no Redis dependency exists in package.json',
  },
];

for (const claim of REMOVED_DEP_CLAIMS) {
  const hasDep = claim.depNames.some((d) => d in allDeps);
  if (!hasDep && install) {
    for (const pat of claim.patterns) {
      if (pat.test(install)) {
        fail('dep-claim-mismatch', `${claim.message} (matched: ${pat})`);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Directory/file references in docs must exist in repo
//    WHY: 0.6.0 referenced memory-plugin/ build steps. Directory exists but
//    was no longer a separate user-facing install step.
// ---------------------------------------------------------------------------

const DOC_DIR_REFS = [
  {
    pattern: /npm\s+--prefix\s+memory-plugin/g,
    check: () => existsSync(join(ROOT, 'memory-plugin', 'openclaw.plugin.json')),
    message: 'INSTALL.md has memory-plugin build commands but memory-plugin/ has no plugin manifest (may not be user-facing)',
    level: 'fail',
  },
  {
    pattern: /npm\s+--prefix\s+plugin\s/g,
    check: () => existsSync(join(ROOT, 'plugin', 'openclaw.plugin.json')),
    message: 'INSTALL.md references plugin/ build but plugin/ has no manifest',
    level: 'fail',
  },
];

if (install) {
  for (const ref of DOC_DIR_REFS) {
    if (ref.pattern.test(install) && !ref.check()) {
      if (ref.level === 'fail') fail('dir-ref-missing', ref.message);
      else warn('dir-ref-missing', ref.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Clone URL matches public repo
//    WHY: 0.6.0 had clone URL pointing to hypermem-internal (private repo).
//    Public users can't clone it.
// ---------------------------------------------------------------------------

const INTERNAL_REPO_PATTERNS = [new RegExp('hypermem' + '-internal', 'i')];

for (const doc of [install, readme].filter(Boolean)) {
  for (const pat of INTERNAL_REPO_PATTERNS) {
    if (pat.test(doc)) {
      fail('internal-repo-url', `Doc references internal repo URL (matched: ${pat})`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Architecture layer descriptions match code reality
//    WHY: docs described L1 as "Redis hot cache" after the runtime had moved
//    to SQLite `:memory:`. User-facing docs must lead with SQLite, not Redis.
// ---------------------------------------------------------------------------

const cacheTs = read('src/cache.ts');
if (cacheTs && install) {
  const cacheUsesRedis = /import.*(?:redis|ioredis)/i.test(cacheTs);
  const cacheUsesSqlite = /node:sqlite/i.test(cacheTs);

  if (!cacheUsesRedis && cacheUsesSqlite) {
    // L1 is SQLite-based. Docs should NOT describe L1 as Redis.
    const redisL1Patterns = [
      /L1\s+Redis/i,
      /L1.*?hot.*?Redis/i,
      /Redis.*?hot\s+(?:session\s+)?(?:cache|layer)/i,
    ];
    for (const pat of redisL1Patterns) {
      if (pat.test(install)) {
        fail('stale-architecture', `INSTALL.md describes L1 as Redis but cache.ts uses node:sqlite (matched: ${pat})`);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Version consistency
//    WHY: General hygiene. If package.json says 0.6.1 but CHANGELOG has no
//    0.6.1 entry, the release notes are missing.
// ---------------------------------------------------------------------------

const changelog = read('CHANGELOG.md');
if (changelog && pkg.version) {
  const versionInChangelog = changelog.includes(pkg.version);
  if (!versionInChangelog) {
    warn('version-changelog-mismatch', `package.json version ${pkg.version} has no entry in CHANGELOG.md`);
  }
}

// ---------------------------------------------------------------------------
// 6. Referenced scripts/binaries exist
//    WHY: Docs referencing bin/hypermem-status.mjs or scripts that don't
//    exist in the public repo leave users with command-not-found errors.
// ---------------------------------------------------------------------------

if (install) {
  // Extract node/bash commands referencing local paths
  const scriptRefs = install.matchAll(/(?:node|bash)\s+((?:bin|scripts)\/[\w.-]+)/g);
  for (const match of scriptRefs) {
    const scriptPath = match[1];
    if (!existsSync(join(ROOT, scriptPath))) {
      fail('missing-script', `INSTALL.md references ${scriptPath} but file doesn't exist`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. Plugin IDs in config commands match actual plugin manifests
//    WHY: If INSTALL.md tells users to set contextEngine to "hypercompositor"
//    but the plugin manifest says "hypermem-compositor", the plugin won't load.
// ---------------------------------------------------------------------------

if (install) {
  const pluginDirs = ['plugin', 'memory-plugin'];
  const knownPluginIds = new Set();

  for (const dir of pluginDirs) {
    const manifestPath = join(ROOT, dir, 'openclaw.plugin.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (manifest.id) knownPluginIds.add(manifest.id);
      } catch { /* skip malformed */ }
    }
    // Also check package.json openclaw.plugin.id
    const pkgPath = join(ROOT, dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const dpkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (dpkg.openclaw?.plugin?.id) knownPluginIds.add(dpkg.openclaw.plugin.id);
      } catch { /* skip */ }
    }
  }

  // Check config set commands for plugin IDs
  const slotSets = install.matchAll(/plugins\.slots\.(\w+)\s+(\w+)/g);
  for (const match of slotSets) {
    const [, slot, pluginId] = match;
    if (pluginId !== 'legacy' && pluginId !== 'none' && knownPluginIds.size > 0) {
      if (!knownPluginIds.has(pluginId)) {
        warn('plugin-id-mismatch', `INSTALL.md sets plugins.slots.${slot} to "${pluginId}" but no plugin manifest declares that ID (known: ${[...knownPluginIds].join(', ')})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 8. Stale file references in files array
//    WHY: package.json files array referenced MIGRATION_GUIDE.md but the
//    file didn't exist. npm silently skips missing files in the array.
// ---------------------------------------------------------------------------

if (pkg.files) {
  const nonGlobFiles = pkg.files.filter((f) => !f.includes('*'));
  for (const f of nonGlobFiles) {
    if (!existsSync(join(ROOT, f))) {
      warn('missing-files-entry', `package.json files array includes "${f}" but it doesn't exist`);
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

console.log('\n=== Docs Validation Report ===\n');

if (failures.length === 0 && warnings.length === 0) {
  console.log('✅ All checks passed\n');
  process.exit(0);
}

if (warnings.length > 0) {
  console.log(`⚠️  ${warnings.length} warning(s):\n`);
  for (const w of warnings) {
    console.log(`  [${w.check}] ${w.detail}`);
  }
  console.log();
}

if (failures.length > 0) {
  console.log(`❌ ${failures.length} failure(s) — release blocked:\n`);
  for (const f of failures) {
    console.log(`  [${f.check}] ${f.detail}`);
  }
  console.log();
  process.exit(1);
}

// Warnings only — don't block but print loudly
console.log('⚠️  Warnings present. Review before release.\n');
process.exit(0);
