#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf-8');

const installSh = read('install.sh');
const installMd = read('INSTALL.md');
const tuningMd = read('docs/TUNING.md');
const readme = read('README.md');
const statusCli = read('bin/hypermem-status.mjs');
const doctorCli = read('bin/hypermem-doctor.mjs');
const defaultConfig = JSON.parse(read('assets/default-config.json'));

const failures = [];

function fail(check, detail) {
  failures.push({ check, detail });
}

const DEFAULT_CONFIG_KEYS = [
  'embedding',
  'compositor',
  'indexer',
];

const COMPOSITOR_KEYS = [
  'turnBudget',
  'warming',
  'adjacency',
  'contextWindowOverrides',
  'budgetFraction',
  'contextWindowReserve',
  'targetBudgetFraction',
  'warmHistoryBudgetFraction',
  'maxFacts',
  'maxHistoryMessages',
  'maxCrossSessionContext',
  'keystoneHistoryFraction',
  'keystoneMaxMessages',
  'hyperformProfile',
];

const RECALL_SURFACE_EXPECTED = [
  ['compositor.turnBudget.budgetFraction', defaultConfig.compositor?.turnBudget?.budgetFraction, 0.6],
  ['compositor.turnBudget.minContextFraction', defaultConfig.compositor?.turnBudget?.minContextFraction, 0.18],
  ['compositor.warming.protectedFloorEnabled', defaultConfig.compositor?.warming?.protectedFloorEnabled, true],
  ['compositor.warming.shapedWarmupDecay', defaultConfig.compositor?.warming?.shapedWarmupDecay, true],
  ['compositor.adjacency.enabled', defaultConfig.compositor?.adjacency?.enabled, true],
  ['compositor.adjacency.boostMultiplier', defaultConfig.compositor?.adjacency?.boostMultiplier, 1.3],
  ['compositor.adjacency.maxLookback', defaultConfig.compositor?.adjacency?.maxLookback, 5],
  ['compositor.adjacency.maxClockDeltaMin', defaultConfig.compositor?.adjacency?.maxClockDeltaMin, 10],
  ['compositor.adjacency.evictionGuardMessages', defaultConfig.compositor?.adjacency?.evictionGuardMessages, 3],
  ['compositor.adjacency.evictionGuardTokenCap', defaultConfig.compositor?.adjacency?.evictionGuardTokenCap, 4000],
];

if (!installSh.includes('assets/default-config.json') && !installSh.includes('default-config.json')) {
  fail('install-default-config-source', 'install.sh must stage the packaged assets/default-config.json rather than a stale inline config');
}

for (const key of DEFAULT_CONFIG_KEYS) {
  if (!(key in defaultConfig)) {
    fail('missing-default-config-key', `assets/default-config.json is missing top-level key ${key}`);
  }
}

for (const key of COMPOSITOR_KEYS) {
  if (!(key in (defaultConfig.compositor ?? {}))) {
    fail('missing-default-compositor-key', `assets/default-config.json is missing compositor key ${key}`);
  }
}

for (const [key, actual, expected] of RECALL_SURFACE_EXPECTED) {
  if (actual !== expected) {
    fail('recall-default-mismatch', `assets/default-config.json ${key}=${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
  }
}

for (const [key] of RECALL_SURFACE_EXPECTED) {
  if (!doctorCli.includes(key)) {
    fail('doctor-recall-surface-missing', `hypermem-doctor does not check ${key}`);
  }
}

for (const term of ['collectRecallSurfaceConfig', '0.9.4 recall-surface config incomplete', 'config.recallSurface']) {
  if (!statusCli.includes(term)) {
    fail('status-recall-surface-missing', `hypermem-status does not expose ${term}`);
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

for (const key of ['--fleet-agent-limit', '--max-candidates-per-conversation', '--repair-limit']) {
  if (!tuningMd.includes(key) && !installMd.includes(key)) {
    fail('missing-maintenance-cli-doc', `operator docs do not describe maintenance CLI flag ${key}`);
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
