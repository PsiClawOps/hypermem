#!/usr/bin/env node
/**
 * MEMORY.md Daily Files → HyperMem Migration
 *
 * Scans OpenClaw workspace memory directories for daily checkpoint files
 * (memory/YYYY-MM-DD.md) and imports bullet-point facts into HyperMem's
 * library.db fact store, scoped to the agent inferred from the path.
 *
 * Dry-run by default. Pass --apply to actually write.
 *
 * Usage:
 *   node scripts/migrate-memory-md.mjs
 *   node scripts/migrate-memory-md.mjs --apply
 *   node scripts/migrate-memory-md.mjs --apply --agent my-agent
 *   node scripts/migrate-memory-md.mjs --apply --workspace-root /path/to/.openclaw
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'apply':           { type: 'boolean', default: false },
    'agent':           { type: 'string',  default: '' },
    'workspace-root':  { type: 'string',  default: path.join(os.homedir(), '.openclaw') },
    'hypermem-dir':    { type: 'string',  default: path.join(os.homedir(), '.openclaw/hypermem') },
    'limit':           { type: 'string',  default: '0' },
  }
});

const DRY_RUN        = !args['apply'];
const AGENT_FILTER   = args['agent'] || '';
const WORKSPACE_ROOT = args['workspace-root'];
const HM_DIR         = args['hypermem-dir'];
const LIMIT          = parseInt(args['limit'], 10);
const LIBRARY_DB     = path.join(HM_DIR, 'library.db');

// ── Agent inference from path ─────────────────────────────────────────────────
//
// Handles these patterns:
//   workspace/my-agent/memory/     → my-agent
//   workspace-director/eve/memory/     → eve
//   workspace-main/main/memory/         → main
//   workspace-<anything>/<agent>/memory → <agent>
//
function inferAgentFromPath(filePath) {
  const parts = filePath.split(path.sep);
  const memIdx = parts.indexOf('memory');
  if (memIdx >= 2) {
    return parts[memIdx - 1].toLowerCase();
  }
  return 'main';
}

// ── Fact quality filter ───────────────────────────────────────────────────────
//
// Returns true if the line is worth importing as a fact.
// Mirrors the isQualityFact() logic from the background indexer.
//
function isQualityLine(line) {
  if (line.length < 40) return false;
  if (line.startsWith('`')) return false;
  // Skip pure search pointer lines
  if (/^→\s*memory_search\s*\(/.test(line)) return false;
  if (/^memory_search\s*\(/.test(line)) return false;
  // Skip lines that are headers, hrules, or code fences
  if (/^#+\s/.test(line)) return false;
  if (/^---+$/.test(line)) return false;
  if (/^```/.test(line)) return false;
  // Skip lines that look like inline code or shell commands
  if (/`[^`]+`/.test(line) && line.indexOf(' ') === -1) return false;
  const words = line.trim().split(/\s+/);
  if (words.length < 5) return false;
  return true;
}

function contentHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// ── File discovery ────────────────────────────────────────────────────────────

const DAILY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

function findDailyFiles(rootDir, agentFilter) {
  const results = [];
  let workspaceDirs;
  try {
    workspaceDirs = fs.readdirSync(rootDir).filter(d => d.startsWith('workspace'));
  } catch {
    return results;
  }

  for (const wsDir of workspaceDirs) {
    const wsPath = path.join(rootDir, wsDir);
    let agentDirs;
    try {
      agentDirs = fs.readdirSync(wsPath);
    } catch { continue; }

    for (const agentDir of agentDirs) {
      const memPath = path.join(wsPath, agentDir, 'memory');
      if (!fs.existsSync(memPath)) continue;

      const agentId = agentDir.toLowerCase();
      if (agentFilter && agentId !== agentFilter) continue;

      let files;
      try {
        files = fs.readdirSync(memPath).filter(f => DAILY_FILE_RE.test(f));
      } catch { continue; }

      for (const file of files) {
        results.push({
          filePath: path.join(memPath, file),
          agentId,
          date: file.replace('.md', ''),
        });
      }
    }
  }

  return results.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Parse facts from a daily file ────────────────────────────────────────────

function parseFacts(filePath, agentId, date) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const facts = [];
  for (const rawLine of raw.split('\n')) {
    // Strip leading bullet markers and whitespace
    let line = rawLine.trim();
    if (line.startsWith('- ')) line = line.slice(2).trim();
    else if (line.startsWith('* ')) line = line.slice(2).trim();
    else continue; // only import bullet lines

    if (!isQualityLine(line)) continue;

    facts.push({
      content: line,
      agentId,
      date,
      hash: contentHash(line),
    });
  }

  return facts;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`[migrate-memory-md] MEMORY.md daily files → HyperMem`);
console.log(`[migrate-memory-md] Workspace root : ${WORKSPACE_ROOT}`);
console.log(`[migrate-memory-md] Target         : ${LIBRARY_DB}`);
console.log(`[migrate-memory-md] Agent filter   : ${AGENT_FILTER || '(all)'}`);
console.log(`[migrate-memory-md] Dry run        : ${DRY_RUN}`);
console.log('');

if (!fs.existsSync(LIBRARY_DB)) {
  console.error(`[migrate-memory-md] ERROR: HyperMem library.db not found at ${LIBRARY_DB}`);
  console.error(`[migrate-memory-md] Has HyperMem been installed and started at least once?`);
  process.exit(1);
}

const dailyFiles = findDailyFiles(WORKSPACE_ROOT, AGENT_FILTER);
console.log(`[migrate-memory-md] Found ${dailyFiles.length} daily files across workspace directories`);
console.log('');

if (dailyFiles.length === 0) {
  console.log(`[migrate-memory-md] No daily memory files found. Nothing to import.`);
  console.log(`[migrate-memory-md] Expected files at: <workspace-root>/workspace-*/*/memory/YYYY-MM-DD.md`);
  process.exit(0);
}

// Collect all facts first so we can apply the limit cleanly
let allFacts = [];
for (const { filePath, agentId, date } of dailyFiles) {
  const facts = parseFacts(filePath, agentId, date);
  allFacts.push(...facts);
}

if (LIMIT > 0) {
  allFacts = allFacts.slice(0, LIMIT);
}

console.log(`[migrate-memory-md] Extracted ${allFacts.length} candidate facts from daily files`);
console.log('');

const stats = {
  total: allFacts.length,
  imported: 0,
  skipped: 0,
  errors: 0,
  byAgent: {},
};

function recordAgent(agentId, imported) {
  if (!stats.byAgent[agentId]) stats.byAgent[agentId] = { imported: 0, skipped: 0 };
  if (imported) stats.byAgent[agentId].imported++;
  else stats.byAgent[agentId].skipped++;
}

if (!DRY_RUN) {
  const hmDb = new DatabaseSync(LIBRARY_DB);
  hmDb.exec('PRAGMA journal_mode = WAL');

  // Load existing hashes for dedup
  const existingHashes = new Set(
    hmDb.prepare(`SELECT source_ref FROM facts WHERE source_type = 'migrated' AND source_ref LIKE 'memory-md:%'`)
      .all()
      .map(r => r.source_ref)
  );

  const insert = hmDb.prepare(`
    INSERT INTO facts
      (agent_id, scope, domain, content, confidence, visibility, source_type, source_ref, created_at, updated_at)
    VALUES
      (?, 'agent', 'migrated', ?, 0.8, 'private', 'migrated', ?, ?, ?)
  `);

  for (const fact of allFacts) {
    const sourceRef = `memory-md:${fact.hash}`;
    if (existingHashes.has(sourceRef)) {
      stats.skipped++;
      recordAgent(fact.agentId, false);
      continue;
    }
    try {
      const iso = `${fact.date}T00:00:00.000Z`;
      insert.run(fact.agentId, fact.content, sourceRef, iso, iso);
      stats.imported++;
      recordAgent(fact.agentId, true);
      existingHashes.add(sourceRef); // prevent same-run duplicates
    } catch (err) {
      console.warn(`[migrate-memory-md] Error importing fact: ${err.message}`);
      stats.errors++;
    }
  }

  hmDb.close();
} else {
  // Dry-run: check live DB for duplicates, report what would happen
  const hmDb = new DatabaseSync(LIBRARY_DB, { readOnly: true });
  const existingHashes = new Set(
    hmDb.prepare(`SELECT source_ref FROM facts WHERE source_type = 'migrated' AND source_ref LIKE 'memory-md:%'`)
      .all()
      .map(r => r.source_ref)
  );
  hmDb.close();

  const seen = new Set();
  for (const fact of allFacts) {
    const sourceRef = `memory-md:${fact.hash}`;
    if (existingHashes.has(sourceRef) || seen.has(sourceRef)) {
      stats.skipped++;
      recordAgent(fact.agentId, false);
      continue;
    }
    seen.add(sourceRef);
    console.log(`[dry-run] [${fact.agentId}] ${fact.date}: ${truncate(fact.content, 80)}`);
    stats.imported++;
    recordAgent(fact.agentId, true);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`[migrate-memory-md] === Results ===`);
console.log(`[migrate-memory-md] Total candidates : ${stats.total}`);
console.log(`[migrate-memory-md] Imported          : ${stats.imported}`);
console.log(`[migrate-memory-md] Skipped (dup)     : ${stats.skipped}`);
console.log(`[migrate-memory-md] Errors            : ${stats.errors}`);
if (Object.keys(stats.byAgent).length > 0) {
  console.log('');
  console.log(`[migrate-memory-md] By agent:`);
  for (const [agent, s] of Object.entries(stats.byAgent).sort((a, b) => (b[1].imported + b[1].skipped) - (a[1].imported + a[1].skipped))) {
    console.log(`  ${agent}: ${s.imported} imported, ${s.skipped} skipped`);
  }
}

if (DRY_RUN) {
  console.log('');
  console.log(`[migrate-memory-md] *** DRY RUN — no data was written ***`);
  console.log(`[migrate-memory-md] Run with --apply to execute.`);
} else {
  console.log('');
  console.log(`[migrate-memory-md] Migration complete.`);
  console.log(`[migrate-memory-md] The background indexer will pick up new facts on its next tick.`);
  console.log(`[migrate-memory-md] To force immediate indexing: restart the gateway.`);
}
