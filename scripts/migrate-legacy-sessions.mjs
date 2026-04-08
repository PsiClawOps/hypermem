#!/usr/bin/env node
/**
 * HyperMem legacy migration dispatcher
 *
 * Thin wrapper around the concrete migration scripts so operators have a single
 * entrypoint for pre-HyperMem data imports.
 *
 * Usage:
 *   node scripts/migrate-legacy-sessions.mjs --source clawtext --apply
 *   node scripts/migrate-legacy-sessions.mjs --source memory-db --agent main --apply
 *   node scripts/migrate-legacy-sessions.mjs --source memory-md --agent forge --apply
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCES = new Map([
  ['clawtext', 'migrate-clawtext.mjs'],
  ['claw-text', 'migrate-clawtext.mjs'],
  ['sessions', 'migrate-clawtext.mjs'],
  ['memory-db', 'migrate-memory-db.mjs'],
  ['memorydb', 'migrate-memory-db.mjs'],
  ['openclaw-memory', 'migrate-memory-db.mjs'],
  ['memory-md', 'migrate-memory-md.mjs'],
  ['memory-md-files', 'migrate-memory-md.mjs'],
  ['daily-files', 'migrate-memory-md.mjs'],
  ['daily', 'migrate-memory-md.mjs'],
]);

function printHelp() {
  console.log(`HyperMem legacy migration dispatcher

Usage:
  node scripts/migrate-legacy-sessions.mjs --source <type> [options]

Sources:
  clawtext        Import legacy ClawText session history into HyperMem messages DB
  memory-db       Import OpenClaw built-in memory.db facts into HyperMem library.db
  memory-md       Import MEMORY.md daily files into HyperMem library.db

Examples:
  node scripts/migrate-legacy-sessions.mjs --source clawtext --apply
  node scripts/migrate-legacy-sessions.mjs --source memory-db --agent main --apply
  node scripts/migrate-legacy-sessions.mjs --source memory-md --agent forge --apply

Notes:
  - Concrete guides live in docs/MIGRATION.md and docs/MIGRATION_GUIDE.md
  - This wrapper forwards all extra flags to the underlying script unchanged
  - All migration scripts default to dry-run until you pass --apply
`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const sourceIdx = args.findIndex(arg => arg === '--source');
if (sourceIdx === -1 || !args[sourceIdx + 1]) {
  console.error('ERROR: missing required --source <type>');
  console.error('Run with --help for usage.');
  process.exit(1);
}

const source = args[sourceIdx + 1].toLowerCase();
const target = SOURCES.get(source);
if (!target) {
  console.error(`ERROR: unknown source "${source}"`);
  console.error(`Known sources: ${Array.from(new Set(SOURCES.keys())).sort().join(', ')}`);
  process.exit(1);
}

const forwarded = args.filter((_, i) => i !== sourceIdx && i !== sourceIdx + 1);
const targetPath = path.join(__dirname, target);
const result = spawnSync(process.execPath, [targetPath, ...forwarded], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});

if (typeof result.status === 'number') process.exit(result.status);
if (result.error) {
  console.error(result.error.message);
}
process.exit(1);
