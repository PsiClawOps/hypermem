#!/usr/bin/env node
/**
 * rewrite-envelope-user-messages.mjs
 *
 * Rewrites user message rows that still begin with
 *   "Sender (untrusted metadata):"
 * by stripping the transport envelope/header and preserving the actual user text.
 *
 * This is for the residual unmatched rows left after duplicate cleanup. Those rows are
 * usually not safe to delete because they may be the only stored copy of the user message.
 *
 * Usage:
 *   node scripts/rewrite-envelope-user-messages.mjs [--agent <id>|--all] [--apply]
 *
 * Options:
 *   --agent <id>      Target single agent
 *   --all             All agents (default)
 *   --apply           Execute updates (default is dry-run)
 *   --data-dir <dir>  Override data dir (default: ~/.openclaw/hypermem)
 *   --verbose         Print sample rewritten rows
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return (idx !== -1 && idx + 1 < process.argv.length) ? process.argv[idx + 1] : fallback;
}
function hasFlag(name) { return process.argv.includes(name); }

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`Usage: node scripts/rewrite-envelope-user-messages.mjs [--agent <id>|--all] [--apply]

  --agent <id>      Target single agent
  --all             All agents (default)
  --apply           Execute updates (default is dry-run)
  --data-dir <dir>  Override data dir (default: ~/.openclaw/hypermem)
  --verbose         Print sample rewritten rows
`);
  process.exit(0);
}

const dataDir = argValue('--data-dir', path.join(os.homedir(), '.openclaw', 'hypermem'));
const agentsDir = path.join(dataDir, 'agents');
const apply = hasFlag('--apply');
const singleAgent = argValue('--agent');
const verbose = hasFlag('--verbose');

function stripEnvelopeHeader(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^Sender \(untrusted metadata\):/i.test(line)) {
      i++;
      while (i < lines.length && lines[i].trim() === '') i++;

      if (i < lines.length && /^```json\s*$/i.test(lines[i])) {
        i++;
        while (i < lines.length && lines[i].trim() !== '```') i++;
        if (i < lines.length && lines[i].trim() === '```') i++;
      } else if (i < lines.length && lines[i].trim().startsWith('{')) {
        let depth = 0;
        while (i < lines.length) {
          const cur = lines[i];
          for (const ch of cur) {
            if (ch === '{') depth++;
            if (ch === '}') depth = Math.max(0, depth - 1);
          }
          i++;
          if (depth === 0) break;
        }
      } else {
        while (i < lines.length && lines[i].trim() !== '') i++;
      }

      while (i < lines.length && lines[i].trim() === '') i++;
      continue;
    }

    out.push(line);
    i++;
  }
  return out.join('\n').trim();
}

function processAgent(agentId) {
  const dbPath = path.join(agentsDir, agentId, 'messages.db');
  if (!fs.existsSync(dbPath)) return null;

  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(`
    SELECT id, text_content, created_at
    FROM messages
    WHERE role = 'user'
      AND text_content LIKE 'Sender (untrusted metadata):%'
    ORDER BY id ASC
  `).all();

  const rewritable = [];
  for (const row of rows) {
    const stripped = stripEnvelopeHeader(row.text_content || '');
    if (!stripped) continue;
    if (stripped === row.text_content) continue;
    rewritable.push({ id: row.id, created_at: row.created_at, before: row.text_content, after: stripped });
  }

  let updated = 0;
  if (apply && rewritable.length) {
    const update = db.prepare('UPDATE messages SET text_content = ? WHERE id = ?');
    db.exec('BEGIN');
    try {
      for (const item of rewritable) {
        update.run(item.after, item.id);
        updated++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  db.close();
  return { agentId, totalEnvelope: rows.length, rewritable: rewritable.length, updated, sample: rewritable.slice(0, 10) };
}

const agentIds = singleAgent
  ? [singleAgent]
  : fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();

const results = agentIds.map(processAgent).filter(Boolean);

console.log(`\n═══ ENVELOPE USER MESSAGE REWRITE ${apply ? '— APPLY' : '— DRY-RUN'} ═══\n`);
console.log('Agent          | Envelope | Rewritable | Updated');
console.log('───────────────|──────────|────────────|────────');
for (const r of results) {
  console.log(`${r.agentId.padEnd(14)} | ${String(r.totalEnvelope).padStart(8)} | ${String(r.rewritable).padStart(10)} | ${String(r.updated).padStart(6)}`);
}

if (verbose) {
  for (const r of results) {
    if (!r.sample.length) continue;
    console.log(`\n── Sample rewrites: ${r.agentId} ──`);
    for (const item of r.sample) {
      console.log(`#${item.id} @ ${item.created_at}`);
      console.log('BEFORE:');
      console.log(item.before.slice(0, 260));
      console.log('AFTER:');
      console.log(item.after.slice(0, 260));
      console.log('');
    }
  }
}
