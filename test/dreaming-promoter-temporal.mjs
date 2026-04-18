/**
 * Dreaming Promoter — Temporal-Marker Screen Tests
 *
 * Verifies that isPromotable() blocks durable promotion of time-bound facts
 * that lack structured recency metadata. A dated sentence with a temporal
 * marker ("suspended pending X as of 2026-04-18") is NOT a bypass — the
 * date confirms the state is temporary; only validFrom/invalidAt metadata
 * satisfies the recency requirement.
 *
 * Reference: specs/RELEASE_HARDENING_0.8.0.md Track 3 follow-up,
 * Anvil greenlight 2026-04-18.
 */

import {
  isPromotable,
  hasTemporalMarker,
  TEMPORAL_MARKERS,
} from '../dist/dreaming-promoter.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

// ─── Part 1: temporal-marker detection coverage ─────────────────────────────

console.log('Part 1: hasTemporalMarker() coverage');

const markerSamples = [
  'Forge model is sonnet-4.6 as of 2026-04-11',
  'model frozen until provider routing stable',
  'dreaming is currently disabled fleet-wide',
  'council mode paused for now while migration lands',
  'council mode suspended pending ragesaq review',
  'V19 schema rollout phase 2 is active',
  'Track 4 deferred to 0.8.2, temporary parking',
  'recheck this after next gateway restart',
  'exploratory period 2026-04-14 onward',
  'in effect during migration only',
  'active while rollout continues',
  'temporary override for debugging',
  'hotfix for the compositor budget bug',
  'workaround for FTS tokenization quirk',
  'migration ongoing for library.db v16',
  'model freeze in place for Copilot break',
  'pre-release pointer, 0.8.0 only',
  'feature blocked behind config gate',
  'running in trial mode on crucible',
  'experimental path for DAG walk',
];

for (const sample of markerSamples) {
  assert(hasTemporalMarker(sample), `detects marker in: "${sample}"`);
}

console.log('\nPart 2: historical facts without temporal markers pass through');

const historicalSamples = [
  'Council cutover completed 2026-03-23 verified by ragesaq',
  'V19 schema shipped 2026-04-18, adds tiered contradiction resolution',
  'PsiClawOps public repos use Apache-2.0 license',
  'Fleet has five council seats plus Forge and Vanguard',
  'HyperMem library schema reached v19 on April 18',
];

for (const sample of historicalSamples) {
  assert(
    !hasTemporalMarker(sample),
    `treats as historical/durable: "${sample}"`
  );
}

// ─── Part 3: isPromotable() gating ──────────────────────────────────────────

console.log('\nPart 3: isPromotable() blocks temporary facts without metadata');

const blockedWithoutMeta = [
  'Forge model is sonnet-4.6 as of 2026-04-11, recheck after provider stable',
  'model frozen until provider routing stable for the Copilot break window',
  'dreaming is currently disabled fleet-wide, enable in 0.8.2 milestone',
  'council mode paused for now while the Opus migration finishes',
  'Track 4 is temporary parking, deferred to the 0.8.2 release shelf',
  'exploratory period 2026-04-14 onward, no drift reporting required',
  'ClawCanvas route in effect during migration only, revert after cutover',
  'numeric parse active while rollout continues on the verification harness',
  'fact store override temporary for the FTS regression investigation',
  'hotfix for compositor pressure bug, remove after 0.8.1 ships',
];

for (const content of blockedWithoutMeta) {
  assert(
    !isPromotable(content),
    `blocks temporary fact without meta: "${content.slice(0, 60)}..."`
  );
}

console.log('\nPart 4: isPromotable() allows temporal facts WITH recency metadata');

const meta = { validFrom: '2026-04-18T00:00:00Z', invalidAt: null };
const allowedWithMeta = [
  'Forge model is sonnet-4.6 as of 2026-04-11, recheck after provider stable',
  'Dreaming is currently disabled fleet-wide, enable in 0.8.2 milestone',
  'Exploratory period starts 2026-04-14 and continues until provider stable',
];

for (const content of allowedWithMeta) {
  assert(
    isPromotable(content, meta),
    `allows temporary fact WITH validFrom: "${content.slice(0, 60)}..."`
  );
}

const metaInvalid = { validFrom: null, invalidAt: '2026-05-01T00:00:00Z' };
assert(
  isPromotable(
    'Dreaming feature temporarily disabled fleet-wide until 0.8.2 release ships',
    metaInvalid
  ),
  'allows temporary fact WITH invalidAt metadata'
);

console.log('\nPart 5: plain ISO date in content is NOT a bypass');

const datedButStillTemporary = [
  'suspended pending X as of 2026-04-18',
  'model frozen until provider routing stable (2026-04-14)',
  'Track 4 temporarily deferred on 2026-04-18',
  'paused since 2026-04-11 while Copilot break continues',
];

for (const content of datedButStillTemporary) {
  assert(
    !isPromotable(content),
    `dated temporary text still blocked: "${content}"`
  );
}

console.log('\nPart 6: historical facts promote cleanly (no metadata required)');

const promotableHistorical = [
  'Council cutover completed 2026-03-23 verified by ragesaq durable record',
  'V19 schema shipped 2026-04-18, adds tiered contradiction resolution policy',
  'PsiClawOps public repositories use the Apache-2.0 license for all source',
  'Fleet includes council seats Anvil Compass Clarity Sentinel Forge Vanguard',
  'HyperMem library schema reached version 19 on April eighteenth release',
];

for (const content of promotableHistorical) {
  assert(
    isPromotable(content),
    `historical fact promotes: "${content.slice(0, 60)}..."`
  );
}

// ─── Part 7: disguised phrasing coverage (Anvil's drift warning) ────────────

console.log('\nPart 7: disguised temporary phrasing is detected');

const disguised = [
  'this rule is in effect during migration and should be removed after',
  'guard remains active while rollout continues across the fleet',
  'temporary override for the flaky retrieval test case',
];

for (const content of disguised) {
  assert(!isPromotable(content), `disguised temp blocked: "${content}"`);
}

// ─── Part 8: TEMPORAL_MARKERS is centralized and extendable ─────────────────

console.log('\nPart 8: marker list is centralized and exported');
assert(Array.isArray(TEMPORAL_MARKERS), 'TEMPORAL_MARKERS is an array');
assert(
  TEMPORAL_MARKERS.length >= 20,
  `TEMPORAL_MARKERS has broad coverage (${TEMPORAL_MARKERS.length} entries)`
);
assert(
  TEMPORAL_MARKERS.every((r) => r instanceof RegExp),
  'all markers are RegExp'
);

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
