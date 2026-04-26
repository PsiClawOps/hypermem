#!/usr/bin/env node
/**
 * hypermem-doctor — installed-system validator for HyperMem + OpenClaw.
 *
 * This tool is intentionally read-only. It reports required failures,
 * recommended settings, and exact config commands operators can review.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

function usage() {
  console.log(`
hypermem doctor — validate a HyperMem/OpenClaw installation

Usage:
  hypermem-doctor [options]

Options:
  --openclaw-config <path>   OpenClaw config to inspect
                             default: ~/.openclaw/openclaw.json
  --hypermem-config <path>   HyperMem config to inspect
                             default: ~/.openclaw/hypermem/config.json
  --data-dir <path>          HyperMem data dir
                             default: config value or ~/.openclaw/hypermem
  --json                     Output machine-readable JSON
  --fix-plan                 Print exact read-only remediation commands
  --strict                   Treat recommendation warnings as failures
  --skip-runtime             Do not call openclaw plugins list
  -h, --help                 Show this help

Examples:
  hypermem-doctor
  hypermem-doctor --fix-plan
  hypermem-doctor --json --strict
`);
}

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const home = os.homedir();
const flags = {
  json: args.includes('--json'),
  fixPlan: args.includes('--fix-plan'),
  strict: args.includes('--strict'),
  skipRuntime: args.includes('--skip-runtime'),
  openclawConfig: path.resolve(getArg('--openclaw-config') || process.env.OPENCLAW_CONFIG || path.join(home, '.openclaw', 'openclaw.json')),
  hypermemConfig: path.resolve(getArg('--hypermem-config') || path.join(home, '.openclaw', 'hypermem', 'config.json')),
  dataDir: getArg('--data-dir') ? path.resolve(getArg('--data-dir')) : null,
};

function readJson(filePath) {
  if (!existsSync(filePath)) return { exists: false, value: null, error: null };
  try {
    return { exists: true, value: JSON.parse(readFileSync(filePath, 'utf8')), error: null };
  } catch (err) {
    return { exists: true, value: null, error: err.message };
  }
}

const openclawRead = readJson(flags.openclawConfig);
const hypermemRead = readJson(flags.hypermemConfig);
const openclaw = openclawRead.value ?? {};
const hypermem = hypermemRead.value ?? {};

const pluginConfig = openclaw?.plugins?.entries?.hypercompositor?.config
  ?? openclaw?.plugins?.entries?.hypermem?.config
  ?? {};
const dataDir = flags.dataDir
  || process.env.HYPERMEM_DATA_DIR
  || pluginConfig.dataDir
  || hypermem.dataDir
  || path.join(home, '.openclaw', 'hypermem');

const checks = [];
const recommendations = [];
const commands = [];

function add(kind, status, id, message, details = {}) {
  const item = { kind, status, id, message, ...details };
  checks.push(item);
  if (details.command) commands.push(details.command);
}

function required(status, id, message, details = {}) {
  add('required', status, id, message, details);
}

function recommended(status, id, message, details = {}) {
  add('recommended', status, id, message, details);
  if (status !== 'ok') recommendations.push({ id, message, ...details });
}

function get(obj, dotted) {
  return dotted.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), obj);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function arrayIncludesLike(values, needle) {
  if (!Array.isArray(values)) return false;
  return values.some(value => String(value).includes(needle));
}

function setCommand(pathKey, value, strictJson = false) {
  const rendered = typeof value === 'string' && !strictJson
    ? value
    : JSON.stringify(value);
  return `openclaw config set ${pathKey} ${shellQuote(rendered)}${strictJson ? ' --strict-json' : ''}`;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function statExists(filePath) {
  try {
    return existsSync(filePath) ? statSync(filePath) : null;
  } catch {
    return null;
  }
}

function findMessageDb(dir) {
  const agentsDir = path.join(dir, 'agents');
  if (!existsSync(agentsDir)) return null;
  try {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(agentsDir, entry.name, 'messages.db');
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function checkConfigReadable() {
  if (!openclawRead.exists) {
    required('fail', 'openclaw-config-present', `OpenClaw config not found: ${flags.openclawConfig}`);
  } else if (openclawRead.error) {
    required('fail', 'openclaw-config-json', `OpenClaw config is not valid JSON: ${openclawRead.error}`);
  } else {
    required('ok', 'openclaw-config-json', `OpenClaw config readable: ${flags.openclawConfig}`);
  }

  if (hypermemRead.exists && hypermemRead.error) {
    required('fail', 'hypermem-config-json', `HyperMem config is not valid JSON: ${hypermemRead.error}`);
  } else if (hypermemRead.exists) {
    required('ok', 'hypermem-config-json', `HyperMem config readable: ${flags.hypermemConfig}`);
  } else {
    recommended('warn', 'hypermem-config-present', `No legacy HyperMem config found at ${flags.hypermemConfig}; ok if config lives in openclaw.json`);
  }
}

function checkPluginWiring() {
  const loadPaths = get(openclaw, 'plugins.load.paths') ?? get(openclaw, 'plugins.paths') ?? [];
  const contextEngine = get(openclaw, 'plugins.slots.contextEngine');
  const memorySlot = get(openclaw, 'plugins.slots.memory');
  const allow = get(openclaw, 'plugins.allow');

  required(contextEngine === 'hypercompositor' ? 'ok' : 'fail',
    'context-engine-slot',
    contextEngine === 'hypercompositor'
      ? 'Context engine slot points to hypercompositor'
      : `Context engine slot is ${JSON.stringify(contextEngine)}; expected hypercompositor`,
    { command: contextEngine === 'hypercompositor' ? undefined : setCommand('plugins.slots.contextEngine', 'hypercompositor') });

  required(memorySlot === 'hypermem' ? 'ok' : 'fail',
    'memory-slot',
    memorySlot === 'hypermem'
      ? 'Memory slot points to hypermem'
      : `Memory slot is ${JSON.stringify(memorySlot)}; expected hypermem`,
    { command: memorySlot === 'hypermem' ? undefined : setCommand('plugins.slots.memory', 'hypermem') });

  required(arrayIncludesLike(loadPaths, 'hypermem/plugin') || arrayIncludesLike(loadPaths, 'hypercompositor') ? 'ok' : 'fail',
    'hypercompositor-path',
    'Plugin load paths include the hypercompositor package path');
  required(arrayIncludesLike(loadPaths, 'hypermem/memory-plugin') || arrayIncludesLike(loadPaths, 'hypermem-memory') ? 'ok' : 'fail',
    'hypermem-memory-path',
    'Plugin load paths include the HyperMem memory package path');

  if (Array.isArray(allow) && allow.length > 0) {
    required(allow.includes('hypercompositor') && allow.includes('hypermem') ? 'ok' : 'fail',
      'plugins-allow-merged',
      allow.includes('hypercompositor') && allow.includes('hypermem')
        ? 'Plugin allowlist includes hypercompositor and hypermem'
        : 'Plugin allowlist exists but does not include both hypercompositor and hypermem; merge them without deleting existing entries');
  } else {
    required('ok', 'plugins-allow-merged', 'Plugin allowlist is unset/empty, so HyperMem is not blocked by allowlist');
  }
}

function checkRuntimePlugins() {
  if (flags.skipRuntime) {
    recommended('ok', 'runtime-plugin-list', 'Runtime plugin load check skipped');
    return;
  }
  const result = spawnSync('openclaw', ['plugins', 'list'], { encoding: 'utf8', timeout: 8000 });
  if (result.error) {
    recommended('warn', 'runtime-plugin-list', `Could not run openclaw plugins list: ${result.error.message}`);
    return;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const hasComposer = /hypercompositor/.test(output);
  const hasMemory = /\bhypermem\b/.test(output);
  recommended(hasComposer && hasMemory ? 'ok' : 'warn',
    'runtime-plugin-list',
    hasComposer && hasMemory
      ? 'Runtime plugin list mentions hypercompositor and hypermem'
      : 'Runtime plugin list did not clearly show both hypercompositor and hypermem; restart gateway after config changes');
}

function checkOpenClawRecommendations() {
  const expected = [
    ['agents.defaults.contextPruning.mode', 'off', 'required', false],
    ['agents.defaults.promptOverlays.gpt5.personality', 'off', 'recommended', false],
    ['agents.defaults.startupContext.dailyMemoryDays', 4, 'recommended', true],
    ['agents.defaults.startupContext.maxFileChars', 4000, 'recommended', true],
    ['agents.defaults.startupContext.maxTotalChars', 12000, 'recommended', true],
    ['agents.defaults.startupContext.maxFileBytes', 32768, 'recommended', true],
    ['agents.defaults.bootstrapMaxChars', 20000, 'recommended', true],
    ['agents.defaults.compaction.mode', 'safeguard', 'recommended', false],
    ['agents.defaults.compaction.reserveTokens', 16384, 'recommended', true],
    ['agents.defaults.compaction.keepRecentTokens', 6000, 'recommended', true],
    ['agents.defaults.compaction.reserveTokensFloor', 15000, 'recommended', true],
    ['agents.defaults.compaction.maxHistoryShare', 0.65, 'recommended', true],
  ];

  for (const [pathKey, value, level, strictJson] of expected) {
    const actual = get(openclaw, pathKey);
    const ok = actual === value;
    const message = ok
      ? `${pathKey} is recommended value ${JSON.stringify(value)}`
      : `${pathKey} is ${JSON.stringify(actual)}; recommended ${JSON.stringify(value)}`;
    const details = ok ? {} : { command: setCommand(pathKey, value, strictJson) };
    if (level === 'required') required(ok ? 'ok' : 'fail', pathKey, message, details);
    else recommended(ok ? 'ok' : 'warn', pathKey, message, details);
  }

  const injection = get(openclaw, 'agents.defaults.contextInjection');
  if (injection == null || injection === 'always' || injection === 'continuation-skip') {
    recommended('ok', 'agents.defaults.contextInjection', `Context injection mode is ${JSON.stringify(injection ?? 'default')}`);
  } else {
    recommended('warn', 'agents.defaults.contextInjection', `Unknown context injection mode ${JSON.stringify(injection)}; verify bootstrap file injection still matches OpenClaw defaults`);
  }
}

function checkDataDir() {
  const dirStat = statExists(dataDir);
  required(dirStat?.isDirectory() ? 'ok' : 'fail', 'data-dir', dirStat?.isDirectory() ? `HyperMem data dir exists: ${dataDir}` : `HyperMem data dir missing: ${dataDir}`);

  for (const [id, file] of [
    ['library-db', path.join(dataDir, 'library.db')],
    ['vectors-db', path.join(dataDir, 'vectors.db')],
  ]) {
    const st = statExists(file);
    required(st?.isFile() ? 'ok' : 'fail', id, st?.isFile() ? `${path.basename(file)} exists` : `${path.basename(file)} missing in ${dataDir}`);
  }

  const messageDb = findMessageDb(dataDir);
  recommended(messageDb ? 'ok' : 'warn', 'messages-db', messageDb ? `Found agent messages DB: ${messageDb}` : 'No agent messages.db found yet; ok before first real agent turn');
}

const MODEL_CONTEXT_WINDOWS = [
  ['claude-opus-4', 200000], ['claude-sonnet-4', 200000], ['claude', 200000],
  ['gpt-5', 128000], ['gpt-4o', 128000], ['gpt-4', 128000], ['o3', 128000], ['o4', 128000],
  ['gemini-3.1', 1000000], ['gemini-2.5', 1000000], ['gemini', 1000000],
  ['glm-5', 131072], ['glm-4', 131072], ['qwen3', 262144], ['qwen', 131072], ['deepseek', 131072],
];
const HIGH_RISK_PROVIDERS = ['openai/', 'openai-codex/', 'openrouter/', 'lmstudio/', 'vllm/', 'ollama/', 'litellm/', 'copilot-local/'];

function normalizeModel(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function addModel(out, value) {
  if (typeof value === 'string') {
    const normalized = normalizeModel(value);
    if (normalized.includes('/')) out.add(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addModel(out, item);
    return;
  }
  if (!isPlainObject(value)) return;
  addModel(out, value.primary);
  addModel(out, value.model);
  addModel(out, value.id);
  addModel(out, value.name);
  if (Array.isArray(value.fallbacks)) for (const fb of value.fallbacks) addModel(out, fb);
}

function collectModels() {
  const out = new Set();
  addModel(out, get(openclaw, 'agents.defaults.model'));
  addModel(out, get(openclaw, 'agents.defaults.fallbacks'));
  addModel(out, get(openclaw, 'agents.defaults.heartbeat.model'));
  addModel(out, get(openclaw, 'agents.defaults.subagents.model'));
  if (Array.isArray(openclaw?.agents?.list)) {
    for (const agent of openclaw.agents.list) {
      addModel(out, agent?.model);
      addModel(out, agent?.fallbacks);
    }
  }
  return [...out].sort();
}

function contextOverrides() {
  return pluginConfig?.compositor?.contextWindowOverrides
    ?? pluginConfig?.contextWindowOverrides
    ?? hypermem?.compositor?.contextWindowOverrides
    ?? hypermem?.contextWindowOverrides
    ?? {};
}

function checkModels() {
  const models = collectModels();
  const overrides = contextOverrides();
  if (models.length === 0) {
    recommended('warn', 'model-audit', 'No configured provider/model ids found to audit');
    return;
  }

  for (const model of models) {
    const detected = MODEL_CONTEXT_WINDOWS.find(([pattern]) => model.includes(pattern));
    const override = overrides[model];
    const hasCompleteOverride = Number.isInteger(override?.contextTokens) && Number.isInteger(override?.contextWindow);
    const highRisk = HIGH_RISK_PROVIDERS.some(prefix => model.startsWith(prefix));

    if (!detected && !hasCompleteOverride) {
      recommended('warn', `model-window:${model}`, `${model} has no known context-window pattern and no complete contextWindowOverrides entry`, {
        command: `# Add plugins.entries.hypercompositor.config.contextWindowOverrides[${JSON.stringify(model)}] with contextTokens and contextWindow after provider validation`,
      });
    } else if (highRisk && !hasCompleteOverride) {
      recommended('warn', `model-window:${model}`, `${model} is on an OpenAI-compatible or local gateway path; add explicit contextWindowOverrides unless logs prove runtime tokenBudget is correct`, {
        command: `# Verify logs show: budget source: runtime tokenBudget=... model=${model}`,
      });
    } else if (override && !hasCompleteOverride) {
      recommended('warn', `model-window:${model}`, `${model} has an incomplete contextWindowOverrides entry; set both contextTokens and contextWindow`);
    } else {
      recommended('ok', `model-window:${model}`, `${model} has ${hasCompleteOverride ? 'explicit context-window override' : `known context-window pattern (${detected?.[1]} tokens)`}`);
    }
  }
}

checkConfigReadable();
if (openclawRead.value) {
  checkPluginWiring();
  checkOpenClawRecommendations();
  checkModels();
}
checkDataDir();
checkRuntimePlugins();

const failedRequired = checks.filter(c => c.kind === 'required' && c.status === 'fail');
const warnings = checks.filter(c => c.status === 'warn');
const summary = {
  status: failedRequired.length > 0 ? 'fail' : (warnings.length > 0 ? 'warn' : 'ok'),
  strictStatus: failedRequired.length > 0 || (flags.strict && warnings.length > 0) ? 'fail' : 'ok',
  openclawConfig: flags.openclawConfig,
  hypermemConfig: flags.hypermemConfig,
  dataDir,
  counts: {
    ok: checks.filter(c => c.status === 'ok').length,
    warn: warnings.length,
    fail: failedRequired.length,
  },
  checks,
  fixPlan: [...new Set(commands.filter(Boolean))],
};

if (flags.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const icon = summary.status === 'ok' ? '✅' : summary.status === 'warn' ? '⚠️' : '❌';
  console.log(`${icon} hypermem doctor: ${summary.status.toUpperCase()} (${summary.counts.ok} ok, ${summary.counts.warn} warn, ${summary.counts.fail} fail)`);
  console.log(`OpenClaw config: ${summary.openclawConfig}`);
  console.log(`HyperMem config: ${summary.hypermemConfig}`);
  console.log(`Data dir: ${summary.dataDir}`);
  console.log('');

  for (const check of checks) {
    const mark = check.status === 'ok' ? '✅' : check.status === 'warn' ? '⚠️' : '❌';
    console.log(`${mark} [${check.kind}] ${check.id}: ${check.message}`);
  }

  if (flags.fixPlan && summary.fixPlan.length > 0) {
    console.log('\nFix plan:');
    for (const command of summary.fixPlan) console.log(`  ${command}`);
    console.log('  openclaw gateway restart');
  }
}

process.exit(summary.strictStatus === 'fail' ? 1 : 0);
