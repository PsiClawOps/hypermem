#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);

const MODEL_CONTEXT_WINDOWS = [
  { pattern: 'claude-opus-4', tokens: 200_000 },
  { pattern: 'claude-sonnet-4', tokens: 200_000 },
  { pattern: 'claude-3-5', tokens: 200_000 },
  { pattern: 'claude-3-7', tokens: 200_000 },
  { pattern: 'claude', tokens: 200_000 },
  { pattern: 'gpt-5', tokens: 128_000 },
  { pattern: 'gpt-4o', tokens: 128_000 },
  { pattern: 'gpt-4', tokens: 128_000 },
  { pattern: 'o3', tokens: 128_000 },
  { pattern: 'o4', tokens: 128_000 },
  { pattern: 'gemini-3.1-pro', tokens: 1_000_000 },
  { pattern: 'gemini-3.1-flash', tokens: 1_000_000 },
  { pattern: 'gemini-2.5-pro', tokens: 1_000_000 },
  { pattern: 'gemini-2', tokens: 1_000_000 },
  { pattern: 'gemini', tokens: 1_000_000 },
  { pattern: 'glm-5', tokens: 131_072 },
  { pattern: 'glm-4', tokens: 131_072 },
  { pattern: 'qwen3', tokens: 262_144 },
  { pattern: 'qwen', tokens: 131_072 },
  { pattern: 'deepseek-v3', tokens: 131_072 },
  { pattern: 'deepseek', tokens: 131_072 },
];

const HIGH_RISK_PROVIDERS = [
  'openai/',
  'openai-codex/',
  'openrouter/',
  'lmstudio/',
  'vllm/',
  'ollama/',
  'litellm/',
  'copilot-local/',
];

function usage() {
  console.log(`
hypermem-model-audit, detect models that need explicit context window metadata

Usage:
  hypermem-model-audit [options]

Options:
  --openclaw-config <path>   OpenClaw config to inspect
                            default: ~/.openclaw/openclaw.json
  --hypermem-config <path>   HyperMem config to inspect
                            default: ~/.openclaw/hypermem/config.json
  --models <list>            Comma-separated provider/model keys to audit directly
  --json                     Output machine-readable JSON
  --strict                   Exit 1 when any model is not ready
  -h, --help                 Show this help

Examples:
  hypermem-model-audit
  hypermem-model-audit --models openai-codex/gpt-5.4,ollama/llama-3.3-70b
  hypermem-model-audit --strict
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

const flags = {
  json: args.includes('--json'),
  strict: args.includes('--strict'),
  openclawConfig: path.resolve(getArg('--openclaw-config') || path.join(os.homedir(), '.openclaw', 'openclaw.json')),
  hypermemConfig: path.resolve(getArg('--hypermem-config') || path.join(os.homedir(), '.openclaw', 'hypermem', 'config.json')),
  models: (getArg('--models') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
};

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function normalizeModelKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function addModelishValue(out, value) {
  if (typeof value === 'string') {
    const normalized = normalizeModelKey(value);
    if (normalized.includes('/')) out.add(normalized);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) addModelishValue(out, item);
    return;
  }

  if (!value || typeof value !== 'object') return;

  addModelishValue(out, value.primary);
  if (Array.isArray(value.fallbacks)) {
    for (const fb of value.fallbacks) addModelishValue(out, fb);
  }
}

function detectPattern(model) {
  const normalized = normalizeModelKey(model);
  return MODEL_CONTEXT_WINDOWS.find(entry => normalized.includes(entry.pattern));
}

function getOverrides(config) {
  const raw = config?.compositor?.contextWindowOverrides;
  return raw && typeof raw === 'object' ? raw : {};
}

function collectConfiguredModels(config) {
  const out = new Set();

  if (Array.isArray(config?.agents?.list)) {
    for (const agent of config.agents.list) {
      addModelishValue(out, agent?.model);
      addModelishValue(out, agent?.fallbacks);
    }
  }

  addModelishValue(out, config?.agents?.defaults?.model);
  addModelishValue(out, config?.agents?.defaults?.fallbacks);

  return [...out].sort();
}

function isHighRiskProvider(model) {
  return HIGH_RISK_PROVIDERS.some(prefix => model.startsWith(prefix));
}

function inspectModel(model, overrides) {
  const override = overrides[model];
  const detected = detectPattern(model);
  const highRisk = isHighRiskProvider(model);
  const contextTokens = override?.contextTokens ?? null;
  const contextWindow = override?.contextWindow ?? null;
  const hasOverride = !!override;
  const hasBothOverrideNumbers = Number.isInteger(contextTokens) && Number.isInteger(contextWindow);

  let status = 'ok';
  const reasons = [];
  const recommendations = [];

  if (!detected && !hasOverride) {
    status = 'fail';
    reasons.push('model does not match HyperMem autodetect patterns and has no explicit override');
    recommendations.push('add compositor.contextWindowOverrides["provider/model"] with contextTokens and contextWindow');
  } else if (highRisk && !hasOverride) {
    status = 'warn';
    reasons.push('provider family is frequently missing or misreporting runtime token budgets');
    recommendations.push('prefer an explicit override even if pattern autodetect matches');
    recommendations.push('verify runtime logs show `budget source: runtime tokenBudget=...` for this exact model');
  } else if (hasOverride && !hasBothOverrideNumbers) {
    status = 'warn';
    reasons.push('override exists but only one of contextTokens/contextWindow is set');
    recommendations.push('declare both numbers so usable budget and advertised window are explicit');
  }

  if (hasOverride && Number.isInteger(contextTokens) && Number.isInteger(contextWindow) && contextTokens > contextWindow) {
    status = 'fail';
    reasons.push('override is invalid: contextTokens exceeds contextWindow');
    recommendations.push('fix the override so contextTokens <= contextWindow');
  }

  if (status === 'ok') {
    if (hasOverride) reasons.push('explicit override present');
    else if (detected) reasons.push(`autodetect pattern match: ${detected.pattern} (${detected.tokens.toLocaleString()} tokens)`);
  }

  return {
    model,
    status,
    autodetectPattern: detected?.pattern || null,
    autodetectTokens: detected?.tokens || null,
    highRiskProvider: highRisk,
    override: hasOverride ? { contextTokens, contextWindow } : null,
    reasons,
    recommendations,
  };
}

let openclawConfig = null;
let hypermemConfig = null;

try {
  openclawConfig = readJsonIfExists(flags.openclawConfig);
  hypermemConfig = readJsonIfExists(flags.hypermemConfig);
} catch (error) {
  console.error(`Failed to read config: ${error.message}`);
  process.exit(1);
}

const overrides = getOverrides(hypermemConfig);
const modelSet = new Set(flags.models);
for (const model of collectConfiguredModels(openclawConfig)) modelSet.add(model);
for (const model of Object.keys(overrides)) modelSet.add(normalizeModelKey(model));

const models = [...modelSet].filter(Boolean).sort();
if (models.length === 0) {
  const result = {
    status: 'empty',
    message: 'No models found. Pass --models or point --openclaw-config at a config file with agent models.',
  };
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result.message);
  process.exit(1);
}

const report = models.map(model => inspectModel(model, overrides));
const counts = {
  ok: report.filter(r => r.status === 'ok').length,
  warn: report.filter(r => r.status === 'warn').length,
  fail: report.filter(r => r.status === 'fail').length,
};

const exitCode = flags.strict && (counts.warn > 0 || counts.fail > 0)
  ? 1
  : counts.fail > 0 ? 1 : 0;

if (flags.json) {
  console.log(JSON.stringify({
    openclawConfig: existsSync(flags.openclawConfig) ? flags.openclawConfig : null,
    hypermemConfig: existsSync(flags.hypermemConfig) ? flags.hypermemConfig : null,
    counts,
    models: report,
  }, null, 2));
  process.exit(exitCode);
}

console.log('HyperMem Model Audit');
console.log('');
if (existsSync(flags.openclawConfig)) console.log(`OpenClaw config: ${flags.openclawConfig}`);
if (existsSync(flags.hypermemConfig)) console.log(`HyperMem config: ${flags.hypermemConfig}`);
console.log('');

for (const item of report) {
  const icon = item.status === 'ok' ? '✅' : item.status === 'warn' ? '⚠️' : '❌';
  console.log(`${icon} ${item.model}`);
  for (const reason of item.reasons) console.log(`   - ${reason}`);
  if (item.override) {
    console.log(`   - override: contextTokens=${item.override.contextTokens ?? 'unset'}, contextWindow=${item.override.contextWindow ?? 'unset'}`);
  }
  for (const recommendation of item.recommendations) console.log(`   - action: ${recommendation}`);
  console.log('');
}

console.log(`Summary: ${counts.ok} ok, ${counts.warn} warn, ${counts.fail} fail`);
process.exit(exitCode);
