#!/usr/bin/env node
/**
 * scripts/backfill-entity-bridge.mjs \u2014 Sprint B operator-run backfill.
 *
 * The HyperMem entity/grace bridge (schema v12) is opt-in. Schema migration
 * creates empty tables only; this script performs the actual message scan
 * and produces the mention rows used by the compose lane.
 *
 * Usage:
 *   node scripts/backfill-entity-bridge.mjs --agent <id> [--batch-size 200]
 *     [--limit 5000] [--dry-run] [--resume] [--since-message-id N]
 *     [--reconcile]
 *
 * Notes:
 *   - Requires the HyperMem build (dist/) to be present. Use `npm run build`.
 *   - Counts only \u2014 the script never logs message content.
 *   - Safe to re-run; default mode resumes from the last indexed message.
 */

import { process, exit } from 'node:process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    const flag = arg.slice(2);
    if (next == null || next.startsWith('--')) {
      out[flag] = true;
    } else {
      out[flag] = next;
      i++;
    }
  }
  return out;
}

function usage() {
  console.error(`Usage: backfill-entity-bridge.mjs [options]
  --agent <id>             Restrict to a single agent (default: all)
  --batch-size <n>         Rows per scan batch (default: 200)
  --limit <n>              Hard cap on messages scanned (default: unlimited)
  --dry-run                Do not write rows; only count
  --resume                 Skip messages already indexed (default unless --reconcile)
  --since-message-id <n>     Only scan messages with id > N
  --reconcile              Reprocess already-indexed messages
  --db <path>              Path to messages.db (required)
  --help                   Show this help
`);
}

const argv = parseArgs(process.argv.slice(2));
if (argv.help) { usage(); exit(0); }

const dbPath = argv.db;
if (!dbPath) {
  console.error('error: --db <path> is required');
  usage();
  exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`error: db not found at ${dbPath}`);
  exit(2);
}

const distPath = resolve(process.cwd(), 'dist', 'entity-bridge-backfill.js');
if (!existsSync(distPath)) {
  console.error(`error: build artifact missing at ${distPath}`);
  console.error('Run \\`npm run build\\` before invoking the backfill.');
  exit(2);
}

const { DatabaseSync } = await import('node:sqlite');
const { runEntityBridgeBackfill } = await import(distPath);

const db = new DatabaseSync(dbPath);
try {
  const summary = await runEntityBridgeBackfill(db, {
    agentId: typeof argv.agent === 'string' ? argv.agent : undefined,
    batchSize: argv['batch-size'] ? Number(argv['batch-size']) : undefined,
    limit: argv.limit ? Number(argv.limit) : undefined,
    dryRun: Boolean(argv['dry-run']),
    resume: argv.resume === true || argv.resume === 'true',
    sinceMessageId: argv['since-message-id'] ? Number(argv['since-message-id']) : undefined,
    reconcile: Boolean(argv.reconcile),
    onProgress: (p) => {
      // Counts only; never any payload.
      console.error(
        `[entity-bridge-backfill] scanned=${p.scanned} written=${p.written} ` +
        `zero=${p.zeroMention} failed=${p.failed} cursor=${p.highestMessageId ?? 0}`,
      );
    },
  });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  db.close();
}
