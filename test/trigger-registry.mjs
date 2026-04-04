/**
 * Trigger Registry Unit Tests (W5)
 *
 * Tests for TRIGGER_REGISTRY, TRIGGER_REGISTRY_VERSION, TRIGGER_REGISTRY_HASH,
 * matchTriggers(), and DEFAULT_TRIGGERS from trigger-registry.ts.
 * Uses only Node.js built-ins; runs against compiled dist output.
 */

import {
  TRIGGER_REGISTRY,
  TRIGGER_REGISTRY_VERSION,
  TRIGGER_REGISTRY_HASH,
  matchTriggers,
  DEFAULT_TRIGGERS,
} from '../dist/trigger-registry.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

// ─── Registry shape ───────────────────────────────────────────

console.log('\n── Registry Shape ──');

assert(
  Array.isArray(TRIGGER_REGISTRY) && TRIGGER_REGISTRY.length === 7,
  `TRIGGER_REGISTRY has 7 entries (got ${TRIGGER_REGISTRY.length})`
);

assert(
  typeof TRIGGER_REGISTRY_VERSION === 'string' && TRIGGER_REGISTRY_VERSION.length > 0,
  `TRIGGER_REGISTRY_VERSION is a non-empty string ("${TRIGGER_REGISTRY_VERSION}")`
);

assert(
  typeof TRIGGER_REGISTRY_HASH === 'string' && TRIGGER_REGISTRY_HASH.length === 12,
  `TRIGGER_REGISTRY_HASH is exactly 12 chars ("${TRIGGER_REGISTRY_HASH}")`
);

// ─── Per-entry metadata ───────────────────────────────────────

console.log('\n── Per-entry Metadata ──');

let allHaveCollection = true;
let allHaveKeywords = true;
let allHaveOwner = true;
let allHaveCategory = true;
const missingFields = [];

for (const entry of TRIGGER_REGISTRY) {
  if (typeof entry.collection !== 'string' || !entry.collection) {
    allHaveCollection = false;
    missingFields.push(`${entry.collection ?? '?'}: missing collection`);
  }
  if (!Array.isArray(entry.keywords) || entry.keywords.length === 0) {
    allHaveKeywords = false;
    missingFields.push(`${entry.collection}: missing/empty keywords`);
  }
  if (typeof entry.owner !== 'string' || !entry.owner) {
    allHaveOwner = false;
    missingFields.push(`${entry.collection}: missing owner`);
  }
  if (typeof entry.category !== 'string' || !entry.category) {
    allHaveCategory = false;
    missingFields.push(`${entry.collection}: missing category`);
  }
}

assert(allHaveCollection, 'Every entry has a non-empty collection string');
assert(allHaveKeywords, 'Every entry has a non-empty keywords array');
assert(allHaveOwner, 'Every entry has an owner field');
assert(allHaveCategory, 'Every entry has a category field');

if (missingFields.length > 0) {
  console.log('    Missing fields:', missingFields.join(', '));
}

// ─── matchTriggers ────────────────────────────────────────────

console.log('\n── matchTriggers ──');

const policyMatches = matchTriggers('policy decision', TRIGGER_REGISTRY);
assert(
  policyMatches.length >= 1,
  `matchTriggers('policy decision', registry) returns ≥1 result (got ${policyMatches.length})`
);

const noMatches = matchTriggers('totally unrelated random text xyz', TRIGGER_REGISTRY);
assert(
  noMatches.length === 0,
  `matchTriggers('totally unrelated random text xyz', registry) returns 0 results (got ${noMatches.length})`
);

const emptyMatches = matchTriggers('', TRIGGER_REGISTRY);
assert(
  emptyMatches.length === 0,
  `matchTriggers('', registry) returns 0 results (got ${emptyMatches.length})`
);

// ─── Backward-compat alias ────────────────────────────────────

console.log('\n── Backward-Compat Alias ──');

assert(
  DEFAULT_TRIGGERS === TRIGGER_REGISTRY,
  'DEFAULT_TRIGGERS === TRIGGER_REGISTRY (same reference)'
);

// ─── Summary ─────────────────────────────────────────────────

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);

if (failed > 0) {
  process.exit(1);
}
