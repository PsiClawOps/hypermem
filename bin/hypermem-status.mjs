#!/usr/bin/env node
/**
 * hypermem status — health check and metrics dashboard CLI
 *
 * Usage:
 *   node bin/hypermem-status.mjs              # full dashboard
 *   node bin/hypermem-status.mjs --agent forge # scoped to one agent
 *   node bin/hypermem-status.mjs --json        # machine-readable output
 *   node bin/hypermem-status.mjs --health      # health checks only (exit 1 on failure)
 *
 * Requires: compiled dist/ (run `npm run build` first)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');
const homeDir = process.env.HOME || os.homedir();
const configPath = join(homeDir, '.openclaw', 'hypermem', 'config.json');

function readStatusEmbeddingConfig() {
  const fallback = { provider: 'ollama', model: 'nomic-embed-text' };
  if (!existsSync(configPath)) return fallback;

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    const embedding = parsed?.embedding ?? {};
    return {
      provider: typeof embedding.provider === 'string' ? embedding.provider : fallback.provider,
      model: typeof embedding.model === 'string' ? embedding.model : fallback.model,
    };
  } catch {
    return fallback;
  }
}

// ── Arg parsing ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  json: args.includes('--json'),
  health: args.includes('--health'),
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
  hypermem-status.mjs [options]

Options:
  --agent <id>   Scope metrics to a specific agent
  --json         Output raw JSON instead of formatted summary
  --health       Health checks only (exits 1 if any check fails)
  -h, --help     Show this help
`);
  process.exit(0);
}

// ── Resolve data directory ───────────────────────────────────────
const dataDir = process.env.HYPERMEM_DATA_DIR
  || join(process.env.HOME || os.homedir(), '.openclaw', 'hypermem');

if (!existsSync(dataDir)) {
  console.error(`Error: data directory not found: ${dataDir}`);
  console.error('Is HyperMem installed? Set HYPERMEM_DATA_DIR if using a custom path.');
  process.exit(1);
}

// ── Open DBs ─────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';

function openDb(filePath, label) {
  if (!existsSync(filePath)) {
    console.error(`Error: ${label} not found: ${filePath}`);
    process.exit(1);
  }
  try {
    const db = new DatabaseSync(filePath, { open: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    return db;
  } catch (err) {
    console.error(`Error opening ${label}: ${err.message}`);
    process.exit(1);
  }
}

// Main DB: pick any agent's messages.db for composition stats, or fall back
// For fleet-wide, we need at least one agent's message db.
// The metrics dashboard expects a "main" db — find one.
let mainDbPath;

if (flags.agent) {
  mainDbPath = join(dataDir, 'agents', flags.agent, 'messages.db');
} else {
  // Find first available agent messages.db
  const agentsDir = join(dataDir, 'agents');
  if (existsSync(agentsDir)) {
    const { readdirSync } = await import('node:fs');
    const agents = readdirSync(agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const a of agents) {
      const candidate = join(agentsDir, a, 'messages.db');
      if (existsSync(candidate)) {
        mainDbPath = candidate;
        break;
      }
    }
  }
}

if (!mainDbPath || !existsSync(mainDbPath)) {
  if (args.includes('--health') || args.includes('--json')) {
    const result = { status: 'no_sessions', message: 'Installed but no agent sessions ingested yet. Send a message to any agent, then re-run.' };
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log('Status: installed, no sessions ingested yet.');
      console.log('Send a message to any agent, then re-run this health check.');
    }
    process.exit(0);
  }
  console.error('Error: no agent messages.db found. Has HyperMem ingested any sessions?');
  process.exit(1);
}

const libraryDbPath = join(dataDir, 'library.db');
const vectorDbPath = join(dataDir, 'vectors.db');
const embeddingConfig = readStatusEmbeddingConfig();

const mainDb = openDb(mainDbPath, 'messages.db');
const libraryDb = openDb(libraryDbPath, 'library.db');
const vectorDb = existsSync(vectorDbPath) ? openDb(vectorDbPath, 'vectors.db') : null;

// ── Import metrics functions ─────────────────────────────────────
const distPath = join(root, 'dist', 'metrics-dashboard.js');
if (!existsSync(distPath)) {
  console.error('Error: dist/metrics-dashboard.js not found. Run `npm run build` first.');
  process.exit(1);
}

const { collectMetrics, formatMetricsSummary } = await import(distPath);

// ── Collect and output ───────────────────────────────────────────
const opts = {};
if (flags.agent) {
  opts.agentIds = [flags.agent];
}

try {
  const metrics = await collectMetrics(mainDb, libraryDb, { ...opts, embeddingProvider: embeddingConfig.provider, embeddingModel: embeddingConfig.model }, vectorDb);

  if (flags.health) {
    // Health-only mode: check and exit
    const h = metrics.health;
    const ok = h.mainDbOk && h.libraryDbOk && (h.cacheOk === null || h.cacheOk);

    if (flags.json) {
      console.log(JSON.stringify(h, null, 2));
    } else {
      console.log(`hypermem ${h.packageVersion} health check`);
      console.log(`  embedding: provider=${h.embeddingProvider ?? 'unknown'}${h.embeddingModel ? ` model=${h.embeddingModel}` : ''}`);
      console.log(`  main db:    ${h.mainDbOk ? '✅' : '❌'}${h.mainSchemaVersion !== null ? ` (schema v${h.mainSchemaVersion})` : ''}`);
      console.log(`  library db: ${h.libraryDbOk ? '✅' : '❌'}${h.librarySchemaVersion !== null ? ` (schema v${h.librarySchemaVersion})` : ''}`);
      if (h.cacheOk !== null) {
        console.log(`  cache:      ${h.cacheOk ? '✅' : '❌'}`);
      }
      console.log(`  status:     ${ok ? '✅ healthy' : '❌ degraded'}`);
    }

    process.exit(ok ? 0 : 1);
  }

  if (flags.json) {
    console.log(JSON.stringify(metrics, null, 2));
  } else {
    console.log(formatMetricsSummary(metrics));
  }
} catch (err) {
  console.error(`Error collecting metrics: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
} finally {
  try { mainDb.close(); } catch {}
  try { libraryDb.close(); } catch {}
  try { vectorDb?.close(); } catch {}
}
