#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');

const installSh = read('install.sh');
const installMd = read('INSTALL.md');
const tuningMd = read('docs/TUNING.md');
const readme = read('README.md');

const failures = [];

function fail(check, detail) {
  failures.push({ check, detail });
}

const CONFIG_KEYS = [
  'contextWindowSize',
  'contextWindowReserve',
  'deferToolPruning',
  'verboseLogging',
  'contextWindowOverrides',
  'warmCacheReplayThresholdMs',
  'subagentWarming',
  'compositor',
  'eviction',
  'embedding',
];

const COMPOSITOR_KEYS = [
  'budgetFraction',
  'reserveFraction',
  'historyFraction',
  'memoryFraction',
  'defaultTokenBudget',
  'maxHistoryMessages',
  'maxFacts',
  'maxExpertisePatterns',
  'maxCrossSessionContext',
  'maxTotalTriggerTokens',
  'maxRecentToolPairs',
  'maxProseToolPairs',
  'warmHistoryBudgetFraction',
  'contextWindowReserve',
  'dynamicReserveTurnHorizon',
  'dynamicReserveMax',
  'dynamicReserveEnabled',
  'keystoneHistoryFraction',
  'keystoneMaxMessages',
  'keystoneMinSignificance',
  'targetBudgetFraction',
  'enableFOS',
  'enableMOD',
  'hyperformProfile',
  'wikiTokenCap',
  'zigzagOrdering',
];

const EVICTION_KEYS = [
  'enabled',
  'imageAgeTurns',
  'toolResultAgeTurns',
  'minTokensToEvict',
  'keepPreviewChars',
];

const MAINTENANCE_KEYS = [
  'periodicInterval',
  'maxActiveConversations',
  'recentConversationCooldownMs',
  'maxCandidatesPerPass',
];

for (const key of CONFIG_KEYS) {
  if (!installSh.includes(`"${key}"`)) {
    fail('missing-install-key', `install.sh generated config is missing top-level key ${key}`);
  }
}

for (const key of COMPOSITOR_KEYS) {
  if (!installSh.includes(`"${key}"`)) {
    fail('missing-install-compositor-key', `install.sh generated config is missing compositor key ${key}`);
  }
}

for (const key of EVICTION_KEYS) {
  if (!installSh.includes(`"${key}"`)) {
    fail('missing-install-eviction-key', `install.sh generated config is missing eviction key ${key}`);
  }
}

for (const key of MAINTENANCE_KEYS) {
  if (!installSh.includes(`"${key}"`)) {
    fail('missing-install-maintenance-key', `install.sh generated config is missing maintenance key ${key}`);
  }
}

const LOOKUP_SNIPPETS = [
  'cat ~/.openclaw/hypermem/config.json',
  'openclaw config get plugins.entries.hypercompositor.config',
  'openclaw config get plugins.slots.contextEngine',
];

for (const snippet of LOOKUP_SNIPPETS) {
  if (!installMd.includes(snippet)) {
    fail('missing-install-lookup-path', `INSTALL.md is missing lookup path: ${snippet}`);
  }
  if (!tuningMd.includes(snippet)) {
    fail('missing-tuning-lookup-path', `docs/TUNING.md is missing lookup path: ${snippet}`);
  }
}

for (const key of ['verboseLogging', 'contextWindowOverrides', 'contextWindowSize', 'contextWindowReserve']) {
  if (!installMd.includes(key)) {
    fail('missing-install-doc-key', `INSTALL.md does not describe ${key}`);
  }
  if (!tuningMd.includes(key)) {
    fail('missing-tuning-doc-key', `docs/TUNING.md does not describe ${key}`);
  }
}

for (const key of ['verboseLogging', 'contextWindowOverrides']) {
  if (!readme.includes(key)) {
    fail('missing-readme-key', `README.md does not mention ${key}`);
  }
}

for (const key of ['maxActiveConversations', 'maxCandidatesPerPass']) {
  if (!tuningMd.includes(key)) {
    fail('missing-tuning-maintenance-key', `docs/TUNING.md does not describe maintenance key ${key}`);
  }
}

console.log('\n=== Config Surface Validation Report ===\n');

if (failures.length === 0) {
  console.log('✅ All checks passed\n');
  process.exit(0);
}

console.log(`❌ ${failures.length} failure(s) — validation blocked:\n`);
for (const failure of failures) {
  console.log(`  [${failure.check}] ${failure.detail}`);
}
console.log();
process.exit(1);
