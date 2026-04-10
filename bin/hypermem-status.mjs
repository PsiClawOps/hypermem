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

import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, '..');

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
  console.error('Error: no agent messages.db found. Has HyperMem ingested any sessions?');
  process.exit(1);
}

const libraryDbPath = join(dataDir, 'library.db');

const mainDb = openDb(mainDbPath, 'messages.db');
const libraryDb = openDb(libraryDbPath, 'library.db');

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
  const metrics = await collectMetrics(mainDb, libraryDb, opts);

  if (flags.health) {
    // Health-only mode: check and exit
    const h = metrics.health;
    const ok = h.mainDbOk && h.libraryDbOk && (h.cacheOk === null || h.cacheOk);

    if (flags.json) {
      console.log(JSON.stringify(h, null, 2));
    } else {
      console.log(`hypermem ${h.packageVersion} health check`);
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
}
