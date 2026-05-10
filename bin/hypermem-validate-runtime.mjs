#!/usr/bin/env node
/**
 * hypermem-validate-runtime — deterministic installed-runtime validator.
 *
 * Seeds a tiny fixture into an isolated agent and validates the full runtime
 * path without using an answer LLM: message write/read, FTS, library facts,
 * vector indexing/search, warm, and compose.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function usage() {
  console.log(`
hypermem validate-runtime — deterministic HyperMem runtime validation

Usage:
  hypermem-validate-runtime [options]

Options:
  --config <path>        HyperMem config JSON
                         default: ~/.openclaw/hypermem/config.json when present
  --data-dir <path>      Override runtime data dir
  --fixture <path>       Validation fixture JSON
                         default: bundled assets/runtime-validation-fixture.json
  --run-id <id>          Stable run id. Default: timestamped isolated id
  --out <path>           Write JSON report to path
  --json                 Print machine-readable JSON only
  --allow-no-embedding   Do not fail semantic probes when embedding provider is none
  -h, --help             Show this help

Examples:
  hypermem-validate-runtime
  hypermem-validate-runtime --json --out /tmp/hypermem-runtime-validation.json
`);
}

if (args.includes('-h') || args.includes('--help')) {
  usage();
  process.exit(0);
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

const flags = {
  json: args.includes('--json'),
  allowNoEmbedding: args.includes('--allow-no-embedding'),
  config: getArg('--config'),
  dataDir: getArg('--data-dir'),
  fixture: getArg('--fixture') || path.join(root, 'assets', 'runtime-validation-fixture.json'),
  runId: getArg('--run-id') || `runtime-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`,
  out: getArg('--out'),
};

if (flags.json) {
  console.log = (...parts) => process.stderr.write(`${parts.join(' ')}\n`);
  console.warn = (...parts) => process.stderr.write(`${parts.join(' ')}\n`);
  console.error = (...parts) => process.stderr.write(`${parts.join(' ')}\n`);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function loadConfig() {
  const configPath = flags.config || path.join(os.homedir(), '.openclaw', 'hypermem', 'config.json');
  const bundledDefaultPath = path.join(root, 'assets', 'default-config.json');
  const sourcePath = existsSync(configPath) ? configPath : bundledDefaultPath;
  const fromFile = existsSync(sourcePath) ? readJson(sourcePath) : {};
  return {
    configPath: existsSync(configPath) ? configPath : null,
    configSource: sourcePath,
    config: {
      ...fromFile,
      dataDir: path.resolve(flags.dataDir || process.env.HYPERMEM_DATA_DIR || fromFile.dataDir || path.join(os.homedir(), '.openclaw', 'hypermem')),
      startupFleetSeeding: false,
    },
  };
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase();
}

function containsAll(text, needles) {
  const lower = normalizeText(text);
  return needles.filter((needle) => !lower.includes(String(needle).toLowerCase()));
}

function flattenMessages(messages) {
  return messages.map((m) => `[${m.date || m.sessionId || ''}] ${m.content}`.trim()).join('\n');
}

function renderComposeText(result) {
  if (typeof result?.contextBlock === 'string') return result.contextBlock;
  if (Array.isArray(result?.messages)) {
    return result.messages.map((m) => {
      if (typeof m?.content === 'string') return m.content;
      if (Array.isArray(m?.content)) return m.content.map((p) => p?.text || '').join('\n');
      return m?.textContent || '';
    }).join('\n');
  }
  return JSON.stringify(result ?? {});
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function pass(report, id, message, details = {}) {
  report.checks.push({ id, status: 'ok', message, ...details });
}

function fail(report, id, message, details = {}) {
  report.checks.push({ id, status: 'fail', message, ...details });
  report.failures.push({ id, message, ...details });
}

async function main() {
  const { HyperMem } = await import(path.join(root, 'dist', 'index.js'));
  const fixture = readJson(flags.fixture);
  const { configPath, configSource, config } = loadConfig();
  const agentId = `${fixture.agentPrefix || 'hypermem-runtime-validation'}-${flags.runId}`;
  const report = {
    ok: false,
    schemaVersion: 1,
    runId: flags.runId,
    agentId,
    configPath,
    configSource,
    dataDir: config.dataDir,
    fixture: flags.fixture,
    embedding: config.embedding || null,
    checks: [],
    failures: [],
    probes: [],
    summary: {},
    writtenAt: new Date().toISOString(),
  };

  const hm = await HyperMem.create(config);
  pass(report, 'hypermem-create', 'HyperMem.create completed', { dataDir: config.dataDir });

  for (const msg of fixture.messages || []) {
    const sessionKey = `agent:${agentId}:runtime-validation:${msg.sessionId}`;
    const content = `[${msg.date || msg.sessionId}] ${msg.content}`;
    if (msg.role === 'assistant') {
      await hm.recordAssistantMessage(agentId, sessionKey, { role: 'assistant', textContent: content, toolCalls: null, toolResults: null });
    } else {
      await hm.recordUserMessage(agentId, sessionKey, content, { channelType: 'webchat', provider: 'runtime-validation', model: 'fixture', isHeartbeat: false });
    }
  }
  pass(report, 'message-write', `Recorded ${(fixture.messages || []).length} fixture messages`);

  for (const fact of fixture.facts || []) {
    hm.addFact(agentId, fact.content, { scope: 'agent', domain: fact.domain || 'runtime-validation', confidence: 1.0, visibility: 'agent' });
  }
  pass(report, 'fact-write', `Recorded ${(fixture.facts || []).length} structured facts`);

  const firstSession = `agent:${agentId}:runtime-validation:${fixture.messages?.[0]?.sessionId || 'session-1'}`;
  const sessionIds = [...new Set((fixture.messages || []).map((m) => m.sessionId).filter(Boolean))];
  for (const sessionId of sessionIds) {
    await hm.warm(agentId, `agent:${agentId}:runtime-validation:${sessionId}`);
  }
  pass(report, 'warm-session', `Warm completed for ${sessionIds.length} validation sessions`);

  const indexResult = await hm.indexAgent(agentId);
  const stats = hm.getVectorStats(agentId);
  report.indexResult = indexResult;
  report.vectorStats = stats;
  if (config.embedding?.provider === 'none') {
    const msg = 'Embedding provider is none; semantic validation skipped by configuration';
    flags.allowNoEmbedding ? pass(report, 'embedding-provider', msg) : fail(report, 'embedding-provider', msg);
  } else if (stats && stats.totalVectors >= (fixture.facts || []).length) {
    pass(report, 'vector-index', `Vector index contains ${stats.totalVectors} vectors`, { indexResult, stats });
  } else {
    fail(report, 'vector-index', 'Vector index did not contain expected structured fact vectors', { indexResult, stats });
  }

  const probes = fixture.probes || [];
  for (const probe of probes) {
    const row = { id: probe.id, component: probe.component, query: probe.query, required: probe.required || [] };
    try {
      let text = '';
      let meta = {};
      if (probe.component === 'message-fts') {
        const results = hm.search(agentId, probe.query, 8);
        text = results.map((r) => r.textContent || '').join('\n');
        meta = { count: results.length };
      } else if (probe.component === 'semantic') {
        if (config.embedding?.provider === 'none' && flags.allowNoEmbedding) {
          row.skipped = true;
          row.ok = true;
          row.meta = { reason: 'embedding provider none' };
          report.probes.push(row);
          continue;
        }
        const results = await hm.semanticSearch(agentId, probe.query, { limit: 8 });
        text = results.map((r) => r.content || '').join('\n');
        meta = { count: results.length, top: results.slice(0, 3).map((r) => ({ table: r.sourceTable, distance: r.distance, preview: String(r.content || '').slice(0, 160) })) };
      } else if (probe.component === 'compose') {
        const result = await hm.compose({
          agentId,
          sessionKey: `agent:${agentId}:runtime-validation:${probe.sessionId || fixture.messages?.[0]?.sessionId || 'session-1'}`,
          prompt: probe.query,
          tokenBudget: 12000,
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          includeHistory: true,
          includeFacts: true,
          includeContext: true,
          includeLibrary: true,
        });
        text = renderComposeText(result);
        meta = { tokenCount: result.tokenCount, slots: result.slots, diagnostics: result.diagnostics };
      } else {
        throw new Error(`Unknown probe component: ${probe.component}`);
      }
      const missing = containsAll(text, probe.required || []);
      row.ok = missing.length === 0;
      row.missing = missing;
      row.meta = meta;
      row.preview = text.slice(0, 1000);
      if (!row.ok) fail(report, probe.id, `${probe.component} probe missing anchors: ${missing.join(', ')}`, { query: probe.query, meta });
    } catch (err) {
      row.ok = false;
      row.error = err.message;
      fail(report, probe.id, `${probe.component} probe errored: ${err.message}`, { query: probe.query });
    }
    report.probes.push(row);
  }

  const scoredProbes = report.probes.filter((p) => !p.skipped);
  const passedProbes = scoredProbes.filter((p) => p.ok).length;
  const checkPassed = report.checks.filter((c) => c.status === 'ok').length;
  report.summary = {
    checksPassed: checkPassed,
    checksTotal: report.checks.length,
    probesPassed: passedProbes,
    probesTotal: scoredProbes.length,
    consistencyScore: scoredProbes.length ? round(passedProbes / scoredProbes.length) : 0,
  };
  report.ok = report.failures.length === 0;

  if (flags.out) {
    mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    writeFileSync(flags.out, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`\nhypermem runtime validation: ${report.ok ? 'PASS' : 'FAIL'}`);
    console.log(`  runId: ${report.runId}`);
    console.log(`  agentId: ${report.agentId}`);
    console.log(`  dataDir: ${report.dataDir}`);
    console.log(`  probes: ${report.summary.probesPassed}/${report.summary.probesTotal}`);
    console.log(`  consistencyScore: ${report.summary.consistencyScore}`);
    if (report.failures.length) {
      console.log('\nFailures:');
      for (const f of report.failures) console.log(`  - ${f.id}: ${f.message}`);
    }
    if (flags.out) console.log(`\nReport: ${path.resolve(flags.out)}`);
  }

  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  if (flags.json) process.stdout.write(`${JSON.stringify({ ok: false, error: err.message }, null, 2)}\n`);
  else console.error(`hypermem-validate-runtime: ${err.message}`);
  process.exit(1);
});
