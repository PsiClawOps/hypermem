#!/usr/bin/env node
/**
 * hypermem status — health check and metrics dashboard CLI
 *
 * Usage:
 *   hypermem-status                         # metrics dashboard
 *   hypermem-status --master                # concise operator health surface
 *   hypermem-status --agent forge --master  # scoped operator health surface
 *   hypermem-status --json                  # machine-readable output
 *   hypermem-status --health                # health checks only (exit 1 on failure)
 *
 * Requires: compiled dist/ (run `npm run build` first)
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const homeDir = process.env.HOME || os.homedir();

const DEFAULT_EMBEDDING = {
  provider: 'ollama',
  model: 'nomic-embed-text',
  dimensions: 768,
  batchSize: null,
  openaiBaseUrl: null,
  ollamaUrl: null,
  geminiBaseUrl: null,
};

// ── Arg parsing ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  json: args.includes('--json'),
  health: args.includes('--health'),
  master: args.includes('--master') || args.includes('--planks'),
  help: args.includes('--help') || args.includes('-h'),
  agent: null,
};

const agentIdx = args.indexOf('--agent');
if (agentIdx !== -1 && args[agentIdx + 1]) {
  flags.agent = args[agentIdx + 1];
}

if (flags.help) {
  console.log(`
hypermem status — health check and metrics dashboard

Usage:
  hypermem-status [options]

Options:
  --master      Concise master health status for main HyperMem planks
  --agent <id>  Scope metrics to a specific agent
  --json        Output raw JSON instead of formatted summary
  --health      Health checks only (exits 1 if any check fails)
  -h, --help    Show this help
`);
  process.exit(0);
}

// ── Resolve config and data directory ────────────────────────────
function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function stripSecretFields(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (/apiKey|token|secret|password|authorization/i.test(key)) {
      out[key] = value ? '[redacted]' : value;
    } else if (value && typeof value === 'object') {
      out[key] = stripSecretFields(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readOpenClawPluginConfig(defaultDataDir) {
  const openclawConfigPath = process.env.OPENCLAW_CONFIG
    || join(homeDir, '.openclaw', 'openclaw.json');
  const parsed = readJsonIfExists(openclawConfigPath);
  const config = parsed?.plugins?.entries?.hypercompositor?.config
    ?? parsed?.plugins?.entries?.hypermem?.config
    ?? null;
  if (!config || typeof config !== 'object') return { config: {}, source: null, dataDir: defaultDataDir };
  return {
    config,
    source: openclawConfigPath,
    dataDir: config.dataDir || defaultDataDir,
  };
}

function resolveRuntimeConfig() {
  const defaultDataDir = process.env.HYPERMEM_DATA_DIR || join(homeDir, '.openclaw', 'hypermem');
  const central = readOpenClawPluginConfig(defaultDataDir);
  const dataDir = process.env.HYPERMEM_DATA_DIR || central.dataDir || defaultDataDir;
  const legacyConfigPath = join(dataDir, 'config.json');
  const fileConfig = readJsonIfExists(legacyConfigPath) ?? {};
  const pluginConfig = central.config ?? {};

  // Mirrors plugin loadUserConfig(): config.json fallback, plugin config wins.
  const merged = { ...fileConfig };
  for (const key of [
    'contextWindowSize', 'contextWindowReserve', 'deferToolPruning',
    'verboseLogging', 'warmCacheReplayThresholdMs', 'subagentWarming',
  ]) {
    if (pluginConfig[key] != null) merged[key] = pluginConfig[key];
  }
  for (const key of ['contextWindowOverrides', 'compositor', 'eviction', 'embedding', 'reranker']) {
    if (pluginConfig[key]) merged[key] = { ...(merged[key] ?? {}), ...pluginConfig[key] };
  }

  const embedding = { ...DEFAULT_EMBEDDING, ...(merged.embedding ?? {}) };
  const sources = [];
  if (existsSync(legacyConfigPath)) sources.push(legacyConfigPath);
  if (central.source && Object.keys(pluginConfig).length > 0) sources.push(`${central.source}:plugins.entries.hypercompositor.config`);

  return {
    dataDir,
    config: merged,
    embedding,
    configSources: sources.length > 0 ? sources : ['defaults'],
    redactedConfig: stripSecretFields(merged),
  };
}

const runtime = resolveRuntimeConfig();
const dataDir = runtime.dataDir;

if (!existsSync(dataDir)) {
  console.error(`Error: data directory not found: ${dataDir}`);
  console.error('Is HyperMem installed? Set HYPERMEM_DATA_DIR if using a custom path.');
  process.exit(1);
}

// ── DB helpers ───────────────────────────────────────────────────
function openDb(filePath, label, required = true) {
  if (!existsSync(filePath)) {
    if (required) {
      console.error(`Error: ${label} not found: ${filePath}`);
      process.exit(1);
    }
    return null;
  }
  try {
    const db = new DatabaseSync(filePath, { open: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    return db;
  } catch (err) {
    if (required) {
      console.error(`Error opening ${label}: ${err.message}`);
      process.exit(1);
    }
    return null;
  }
}

function safeGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function safeAll(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function fileInfo(filePath) {
  if (!existsSync(filePath)) return { exists: false, bytes: 0, mb: 0 };
  const bytes = statSync(filePath).size;
  return { exists: true, bytes, mb: Math.round((bytes / 1024 / 1024) * 10) / 10 };
}

function pct(indexed, total) {
  if (!total) return null;
  return Math.round((indexed / total) * 1000) / 10;
}

function statusForCoverage(percent, minimum) {
  if (percent === null) return 'n/a';
  return percent >= minimum ? 'ok' : 'warn';
}

function icon(status) {
  if (status === 'ok') return '✅';
  if (status === 'warn') return '⚠️';
  if (status === 'fail') return '❌';
  return '•';
}

function findMessageDb(agentId) {
  if (agentId) return join(dataDir, 'agents', agentId, 'messages.db');
  const agentsDir = join(dataDir, 'agents');
  if (!existsSync(agentsDir)) return null;
  const agents = readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
  for (const agent of agents) {
    const candidate = join(agentsDir, agent, 'messages.db');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function collectMessageStats(agentId) {
  const agentsDir = join(dataDir, 'agents');
  if (!existsSync(agentsDir)) return { agentsWithMessages: 0, totalMessages: 0, newestMessageAt: null };
  const agents = agentId ? [agentId] : readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  let agentsWithMessages = 0;
  let totalMessages = 0;
  let newestMessageAt = null;
  for (const agent of agents) {
    const dbPath = join(agentsDir, agent, 'messages.db');
    if (!existsSync(dbPath)) continue;
    const db = openDb(dbPath, `${agent} messages.db`, false);
    if (!db) continue;
    agentsWithMessages += 1;
    const count = safeGet(db, 'SELECT COUNT(*) AS count FROM messages')?.count ?? 0;
    const newest = safeGet(db, 'SELECT MAX(created_at) AS newest FROM messages')?.newest ?? null;
    totalMessages += count;
    if (newest && (!newestMessageAt || newest > newestMessageAt)) newestMessageAt = newest;
    try { db.close(); } catch {}
  }
  return { agentsWithMessages, totalMessages, newestMessageAt };
}

function getVectorDimensions(vectorDb, tableName) {
  if (!vectorDb) return null;
  const row = safeGet(vectorDb, 'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', ['table', tableName]);
  const match = row?.sql?.match(/float\[(\d+)\]/i);
  return match ? Number(match[1]) : null;
}

function getQuickCheck(db) {
  const row = safeGet(db, 'PRAGMA quick_check');
  return row ? Object.values(row)[0] : 'unknown';
}

function collectMasterHealth(libraryDb, vectorDb, mainDb) {
  const agentClause = flags.agent ? 'AND agent_id = ?' : '';
  const params = flags.agent ? [flags.agent] : [];

  const factsTotal = safeGet(libraryDb, `SELECT COUNT(*) AS count FROM facts WHERE 1=1 ${agentClause}`, params)?.count ?? 0;
  const factsActive = safeGet(libraryDb, `SELECT COUNT(*) AS count FROM facts WHERE superseded_by IS NULL AND decay_score < 0.8 ${agentClause}`, params)?.count ?? 0;
  const episodesTotal = safeGet(libraryDb, `SELECT COUNT(*) AS count FROM episodes WHERE 1=1 ${agentClause}`, params)?.count ?? 0;
  const knowledgeActive = safeGet(libraryDb, `SELECT COUNT(*) AS count FROM knowledge WHERE superseded_by IS NULL ${agentClause}`, params)?.count ?? 0;
  const docChunks = safeGet(libraryDb, `SELECT COUNT(*) AS count FROM doc_chunks WHERE 1=1 ${agentClause}`, params)?.count ?? 0;

  let factsIndexed = 0;
  let episodesIndexed = 0;
  let knowledgeIndexed = 0;
  let totalVectors = 0;
  let vectorByTable = {};
  let oldestIndexedAt = null;
  let newestIndexedAt = null;
  let vectorDimensions = { facts: null, episodes: null, knowledge: null };

  if (vectorDb) {
    totalVectors = safeGet(vectorDb, 'SELECT COUNT(*) AS count FROM vec_index_map')?.count ?? 0;
    vectorByTable = Object.fromEntries(safeAll(vectorDb, 'SELECT source_table, COUNT(*) AS count FROM vec_index_map GROUP BY source_table').map(r => [r.source_table, r.count]));
    oldestIndexedAt = safeGet(vectorDb, 'SELECT MIN(indexed_at) AS value FROM vec_index_map')?.value ?? null;
    newestIndexedAt = safeGet(vectorDb, 'SELECT MAX(indexed_at) AS value FROM vec_index_map')?.value ?? null;
    vectorDimensions = {
      facts: getVectorDimensions(vectorDb, 'vec_facts'),
      episodes: getVectorDimensions(vectorDb, 'vec_episodes'),
      knowledge: getVectorDimensions(vectorDb, 'vec_knowledge'),
    };

    if (flags.agent) {
      factsIndexed = safeGet(vectorDb, `
        SELECT COUNT(*) AS count
        FROM vec_index_map m
        JOIN library.facts f ON f.id = m.source_id
        WHERE m.source_table = 'facts'
          AND f.superseded_by IS NULL
          AND f.decay_score < 0.8
          AND f.agent_id = ?`, params)?.count ?? 0;
      episodesIndexed = safeGet(vectorDb, `
        SELECT COUNT(*) AS count
        FROM vec_index_map m
        JOIN library.episodes e ON e.id = m.source_id
        WHERE m.source_table = 'episodes'
          AND e.agent_id = ?`, params)?.count ?? 0;
      knowledgeIndexed = safeGet(vectorDb, `
        SELECT COUNT(*) AS count
        FROM vec_index_map m
        JOIN library.knowledge k ON k.id = m.source_id
        WHERE m.source_table = 'knowledge'
          AND k.superseded_by IS NULL
          AND k.agent_id = ?`, params)?.count ?? 0;
      const rawFactsIndexed = safeGet(vectorDb, `
        SELECT COUNT(*) AS count
        FROM vec_index_map m
        JOIN library.facts f ON f.id = m.source_id
        WHERE m.source_table = 'facts'
          AND f.agent_id = ?`, params)?.count ?? 0;
      const rawEpisodesIndexed = safeGet(vectorDb, `
        SELECT COUNT(*) AS count
        FROM vec_index_map m
        JOIN library.episodes e ON e.id = m.source_id
        WHERE m.source_table = 'episodes'
          AND e.agent_id = ?`, params)?.count ?? 0;
      const rawKnowledgeIndexed = safeGet(vectorDb, `
        SELECT COUNT(*) AS count
        FROM vec_index_map m
        JOIN library.knowledge k ON k.id = m.source_id
        WHERE m.source_table = 'knowledge'
          AND k.agent_id = ?`, params)?.count ?? 0;
      vectorByTable = {
        ...(rawEpisodesIndexed ? { episodes: rawEpisodesIndexed } : {}),
        ...(rawFactsIndexed ? { facts: rawFactsIndexed } : {}),
        ...(rawKnowledgeIndexed ? { knowledge: rawKnowledgeIndexed } : {}),
      };
      totalVectors = rawFactsIndexed + rawEpisodesIndexed + rawKnowledgeIndexed;
    } else {
      factsIndexed = safeGet(vectorDb, `
        SELECT COUNT(*) AS count
        FROM vec_index_map m
        JOIN library.facts f ON f.id = m.source_id
        WHERE m.source_table = 'facts'
          AND f.superseded_by IS NULL
          AND f.decay_score < 0.8`)?.count ?? 0;
      episodesIndexed = safeGet(vectorDb, `
        SELECT COUNT(*) AS count
        FROM vec_index_map m
        JOIN library.episodes e ON e.id = m.source_id
        WHERE m.source_table = 'episodes'`)?.count ?? 0;
      knowledgeIndexed = safeGet(vectorDb, `
        SELECT COUNT(*) AS count
        FROM vec_index_map m
        JOIN library.knowledge k ON k.id = m.source_id
        WHERE m.source_table = 'knowledge'
          AND k.superseded_by IS NULL`)?.count ?? 0;
    }
  }

  const factCoverage = pct(factsIndexed, factsActive);
  const episodeCoverage = pct(episodesIndexed, episodesTotal);
  const knowledgeCoverage = pct(knowledgeIndexed, knowledgeActive);
  const factStatus = statusForCoverage(factCoverage, 80);
  const episodeStatus = statusForCoverage(episodeCoverage, 80);
  const knowledgeStatus = knowledgeActive === 0 ? 'n/a' : statusForCoverage(knowledgeCoverage, 80);
  const configuredDimensions = Number(runtime.embedding.dimensions) || null;
  const dimensionMatches = !configuredDimensions
    ? 'n/a'
    : [vectorDimensions.facts, vectorDimensions.episodes, vectorDimensions.knowledge]
        .filter(v => v != null)
        .every(v => v === configuredDimensions)
      ? 'ok'
      : 'fail';

  const libraryQuickCheck = getQuickCheck(libraryDb);
  const vectorQuickCheck = vectorDb ? getQuickCheck(vectorDb) : 'missing';
  const mainQuickCheck = mainDb ? getQuickCheck(mainDb) : 'missing';
  const dbStatus = libraryQuickCheck === 'ok' && (vectorQuickCheck === 'ok' || vectorQuickCheck === 'missing') && (mainQuickCheck === 'ok' || mainQuickCheck === 'missing') ? 'ok' : 'fail';

  const messageStats = collectMessageStats(flags.agent);
  const totalTurns = safeGet(libraryDb, `SELECT COUNT(*) AS count FROM output_metrics WHERE 1=1 ${agentClause}`, params)?.count ?? 0;
  const avgLatency = safeGet(libraryDb, `SELECT AVG(latency_ms) AS value FROM output_metrics WHERE latency_ms IS NOT NULL ${agentClause}`, params)?.value ?? null;
  const avgInput = safeGet(libraryDb, `SELECT AVG(input_tokens) AS value FROM output_metrics WHERE input_tokens IS NOT NULL ${agentClause}`, params)?.value ?? null;
  const avgOutput = safeGet(libraryDb, `SELECT AVG(output_tokens) AS value FROM output_metrics WHERE output_tokens IS NOT NULL ${agentClause}`, params)?.value ?? null;

  const issues = [];
  if (dbStatus === 'fail') issues.push('database quick_check failed');
  if (dimensionMatches === 'fail') issues.push('vector table dimensions do not match configured embedding dimensions');
  if (factStatus === 'warn') issues.push(`fact vector coverage low (${factCoverage}%)`);
  if (episodeStatus === 'warn') issues.push(`episode vector coverage low (${episodeCoverage}%)`);
  if (knowledgeStatus === 'warn') issues.push(`knowledge vector coverage low (${knowledgeCoverage}%)`);
  if (!vectorDb) issues.push('shared vectors.db missing');

  const overall = issues.length === 0 ? 'healthy' : (dbStatus === 'fail' || dimensionMatches === 'fail' ? 'degraded' : 'attention');

  return {
    snapshotAt: new Date().toISOString(),
    scope: flags.agent ? { agent: flags.agent } : { fleet: true },
    overall,
    issues,
    config: {
      dataDir,
      sources: runtime.configSources,
      embedding: {
        provider: runtime.embedding.provider ?? null,
        model: runtime.embedding.model ?? null,
        dimensions: configuredDimensions,
        batchSize: runtime.embedding.batchSize ?? null,
        baseUrl: runtime.embedding.openaiBaseUrl ?? runtime.embedding.ollamaUrl ?? runtime.embedding.geminiBaseUrl ?? null,
      },
      reranker: runtime.config.reranker ? stripSecretFields(runtime.config.reranker) : null,
    },
    databases: {
      library: { path: libraryDbPath, ...fileInfo(libraryDbPath), quickCheck: libraryQuickCheck },
      vectors: { path: vectorDbPath, ...fileInfo(vectorDbPath), quickCheck: vectorQuickCheck, dimensions: vectorDimensions },
      messages: { sampledPath: mainDbPath, ...(mainDbPath ? fileInfo(mainDbPath) : { exists: false, bytes: 0, mb: 0 }), quickCheck: mainQuickCheck },
    },
    memory: {
      facts: { total: factsTotal, active: factsActive },
      episodes: { total: episodesTotal },
      knowledge: { active: knowledgeActive },
      docChunks: { total: docChunks },
      messages: messageStats,
    },
    vectors: {
      total: totalVectors,
      byTable: vectorByTable,
      coverage: {
        facts: { indexed: factsIndexed, total: factsActive, percent: factCoverage, status: factStatus },
        episodes: { indexed: episodesIndexed, total: episodesTotal, percent: episodeCoverage, status: episodeStatus },
        knowledge: { indexed: knowledgeIndexed, total: knowledgeActive, percent: knowledgeCoverage, status: knowledgeStatus },
      },
      oldestIndexedAt,
      newestIndexedAt,
      dimensionStatus: dimensionMatches,
    },
    composition: {
      turns: totalTurns,
      avgLatencyMs: avgLatency == null ? null : Math.round(avgLatency),
      avgInputTokens: avgInput == null ? null : Math.round(avgInput),
      avgOutputTokens: avgOutput == null ? null : Math.round(avgOutput),
      semanticDiagnosticsPersisted: false,
    },
  };
}

function formatCoverage(label, item) {
  const percent = item.percent == null ? 'n/a' : `${item.percent}%`;
  return `  ${icon(item.status)} ${label.padEnd(9)} ${item.indexed.toLocaleString()} / ${item.total.toLocaleString()} (${percent})`;
}

function formatMasterHealth(h) {
  const lines = [];
  lines.push(`hypermem master health — ${h.snapshotAt}`);
  lines.push(`scope: ${h.scope.agent ? `agent=${h.scope.agent}` : 'fleet'}`);
  lines.push(`overall: ${h.overall === 'healthy' ? '✅ healthy' : h.overall === 'degraded' ? '❌ degraded' : '⚠️ attention'}`);
  if (h.issues.length > 0) {
    lines.push(`issues: ${h.issues.join('; ')}`);
  }

  lines.push('');
  lines.push('## Configuration');
  lines.push(`  dataDir: ${h.config.dataDir}`);
  lines.push(`  source:  ${h.config.sources.join(' + ')}`);
  lines.push(`  embed:   ${h.config.embedding.provider ?? 'unknown'} / ${h.config.embedding.model ?? 'unknown'}${h.config.embedding.dimensions ? ` (${h.config.embedding.dimensions}d)` : ''}${h.config.embedding.batchSize ? ` batch=${h.config.embedding.batchSize}` : ''}`);
  if (h.config.embedding.baseUrl) lines.push(`  base:    ${h.config.embedding.baseUrl}`);
  lines.push(`  rerank:  ${h.config.reranker?.provider ?? 'none'}`);

  lines.push('');
  lines.push('## Databases');
  lines.push(`  ${icon(h.databases.library.quickCheck === 'ok' ? 'ok' : 'fail')} library.db ${h.databases.library.mb} MB quick_check=${h.databases.library.quickCheck}`);
  lines.push(`  ${icon(h.databases.vectors.quickCheck === 'ok' ? 'ok' : h.databases.vectors.exists ? 'fail' : 'warn')} vectors.db ${h.databases.vectors.exists ? `${h.databases.vectors.mb} MB` : 'missing'} quick_check=${h.databases.vectors.quickCheck}`);
  lines.push(`  ${icon(h.databases.messages.quickCheck === 'ok' ? 'ok' : h.databases.messages.exists ? 'fail' : 'warn')} messages sample ${h.databases.messages.exists ? `${h.databases.messages.mb} MB` : 'missing'} quick_check=${h.databases.messages.quickCheck}`);
  lines.push(`  ${icon(h.vectors.dimensionStatus)} vector dims facts=${h.databases.vectors.dimensions.facts ?? 'n/a'} episodes=${h.databases.vectors.dimensions.episodes ?? 'n/a'} knowledge=${h.databases.vectors.dimensions.knowledge ?? 'n/a'}`);

  lines.push('');
  lines.push('## Memory data');
  lines.push(`  facts:    ${h.memory.facts.active.toLocaleString()} retrieval-eligible / ${h.memory.facts.total.toLocaleString()} total`);
  lines.push(`  episodes: ${h.memory.episodes.total.toLocaleString()}`);
  lines.push(`  knowledge:${String(h.memory.knowledge.active.toLocaleString()).padStart(7)} active`);
  lines.push(`  chunks:   ${h.memory.docChunks.total.toLocaleString()}`);
  lines.push(`  messages: ${h.memory.messages.totalMessages.toLocaleString()} across ${h.memory.messages.agentsWithMessages} agent DBs${h.memory.messages.newestMessageAt ? `, newest ${h.memory.messages.newestMessageAt}` : ''}`);

  lines.push('');
  lines.push('## Vector coverage');
  lines.push(`  total vectors: ${h.vectors.total.toLocaleString()}`);
  if (Object.keys(h.vectors.byTable).length > 0) {
    const byTable = Object.entries(h.vectors.byTable)
      .map(([table, count]) => `${table}=${Number(count).toLocaleString()}`)
      .join(' ');
    lines.push(`  by table: ${byTable}`);
  }
  lines.push(formatCoverage('facts', h.vectors.coverage.facts));
  lines.push(formatCoverage('episodes', h.vectors.coverage.episodes));
  lines.push(formatCoverage('knowledge', h.vectors.coverage.knowledge));
  lines.push(`  indexed window: ${h.vectors.oldestIndexedAt ?? 'n/a'} → ${h.vectors.newestIndexedAt ?? 'n/a'}`);

  lines.push('');
  lines.push('## Composition');
  if (h.composition.turns > 0) {
    lines.push(`  turns: ${h.composition.turns.toLocaleString()}`);
    if (h.composition.avgLatencyMs != null) lines.push(`  avg latency: ${h.composition.avgLatencyMs}ms`);
    if (h.composition.avgInputTokens != null) lines.push(`  avg input:   ${h.composition.avgInputTokens.toLocaleString()} tokens`);
    if (h.composition.avgOutputTokens != null) lines.push(`  avg output:  ${h.composition.avgOutputTokens.toLocaleString()} tokens`);
  } else {
    lines.push('  no persisted output_metrics rows');
  }
  lines.push('  semantic recall counts: runtime log only, not persisted yet');

  return lines.join('\n');
}

// ── Resolve DB paths ─────────────────────────────────────────────
const mainDbPath = findMessageDb(flags.agent);
const libraryDbPath = join(dataDir, 'library.db');
const vectorDbPath = join(dataDir, 'vectors.db');

if (!mainDbPath || !existsSync(mainDbPath)) {
  if (flags.health || flags.json || flags.master) {
    const result = { status: 'no_sessions', message: 'Installed but no agent sessions ingested yet. Send a message to any agent, then re-run.', dataDir };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('Status: installed, no sessions ingested yet.');
      console.log('Send a message to any agent, then re-run this health check.');
    }
    process.exit(0);
  }
  console.error('Error: no agent messages.db found. Has HyperMem ingested any sessions?');
  process.exit(1);
}

const mainDb = openDb(mainDbPath, 'messages.db');
const libraryDb = openDb(libraryDbPath, 'library.db');
const vectorDb = openDb(vectorDbPath, 'vectors.db', false);
if (vectorDb) {
  try {
    vectorDb.exec(`ATTACH DATABASE '${libraryDbPath.replaceAll("'", "''")}' AS library`);
  } catch {
    // Coverage joins degrade to zero via safeGet if the live library cannot be attached.
  }
}

try {
  if (flags.master) {
    const master = collectMasterHealth(libraryDb, vectorDb, mainDb);
    if (flags.json) console.log(JSON.stringify(master, null, 2));
    else console.log(formatMasterHealth(master));
    process.exit(master.overall === 'degraded' ? 1 : 0);
  }

  // ── Import metrics functions ───────────────────────────────────
  const distPath = join(root, 'dist', 'metrics-dashboard.js');
  if (!existsSync(distPath)) {
    console.error('Error: dist/metrics-dashboard.js not found. Run `npm run build` first.');
    process.exit(1);
  }

  const { collectMetrics, formatMetricsSummary } = await import(distPath);
  const opts = {};
  if (flags.agent) opts.agentIds = [flags.agent];

  const metrics = await collectMetrics(
    mainDb,
    libraryDb,
    {
      ...opts,
      embeddingProvider: runtime.embedding.provider,
      embeddingModel: runtime.embedding.model,
    },
    vectorDb,
  );

  if (flags.health) {
    const h = metrics.health;
    const ok = h.mainDbOk && h.libraryDbOk && (h.cacheOk === null || h.cacheOk);

    if (flags.json) {
      console.log(JSON.stringify(h, null, 2));
    } else {
      console.log(`hypermem ${h.packageVersion} health check`);
      console.log(`  embedding: provider=${h.embeddingProvider ?? 'unknown'}${h.embeddingModel ? ` model=${h.embeddingModel}` : ''}`);
      console.log(`  main db:    ${h.mainDbOk ? '✅' : '❌'}${h.mainSchemaVersion !== null ? ` (schema v${h.mainSchemaVersion})` : ''}`);
      console.log(`  library db: ${h.libraryDbOk ? '✅' : '❌'}${h.librarySchemaVersion !== null ? ` (schema v${h.librarySchemaVersion})` : ''}`);
      if (h.cacheOk !== null) console.log(`  cache:      ${h.cacheOk ? '✅' : '❌'}`);
      console.log(`  status:     ${ok ? '✅ healthy' : '❌ degraded'}`);
    }

    process.exit(ok ? 0 : 1);
  }

  if (flags.json) console.log(JSON.stringify(metrics, null, 2));
  else console.log(formatMetricsSummary(metrics));
} catch (err) {
  console.error(`Error collecting metrics: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
} finally {
  try { mainDb.close(); } catch {}
  try { libraryDb.close(); } catch {}
  try { vectorDb?.close(); } catch {}
}
