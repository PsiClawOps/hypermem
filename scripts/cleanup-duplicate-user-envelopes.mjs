#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  console.log(`Usage:
  node scripts/cleanup-duplicate-user-envelopes.mjs [--agent <id>|--all] [--data-dir <dir>] [--apply]

Defaults:
  --data-dir ~/.openclaw/hypermem
  dry-run unless --apply is provided

Matcher rules:
  - row role must be user
  - row text must begin with 'Sender (untrusted metadata):'
  - stripped envelope content must exactly equal an earlier user row in the same conversation
  - candidate bare row must be the nearest prior exact match within 10 minutes and 6 row ids
`);
}

if (hasFlag('--help') || hasFlag('-h')) {
  usage();
  process.exit(0);
}

const dataDir = argValue('--data-dir', path.join(os.homedir(), '.openclaw', 'hypermem'));
const agentsDir = path.join(dataDir, 'agents');
const apply = hasFlag('--apply');
const singleAgent = argValue('--agent');
const all = hasFlag('--all') || !singleAgent;

function stripMessageMetadata(text) {
  if (!text) return text;
  const lines = text.split('\n');
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```json\s*$/i.test(line)) {
      const blockLines = [line];
      let j = i + 1;
      while (j < lines.length) {
        blockLines.push(lines[j]);
        if (lines[j].trim() === '```') {
          j++;
          break;
        }
        j++;
      }
      const blockContent = blockLines.join('\n');
      if (blockContent.includes('"schema": "openclaw') || blockContent.includes('inbound_meta') || blockContent.includes('"label":') || blockContent.includes('"username":')) {
        i = j;
        continue;
      }
      result.push(...blockLines);
      i = j;
      continue;
    }

    if (/^Sender \(untrusted metadata\):/i.test(line)) {
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '' || l.trim() === '```') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(line.trim())) {
      i++;
      continue;
    }
    if (/^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]$/.test(line.trim())) {
      i++;
      continue;
    }
    if (/^System\s+\d{4}-\d{2}-\d{2}$/.test(line.trim())) {
      i++;
      continue;
    }

    result.push(line);
    i++;
  }
  return result.join('\n').trim();
}

function canonicalizeUserText(text) {
  if (!text) return '';
  return text
    .trim()
    .replace(/^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]\s*/i, '')
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s*/i, '')
    .replace(/^System\s+\d{4}-\d{2}-\d{2}\s*/i, '')
    .trim();
}

function isoMs(s) {
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function openDb(agentId) {
  const dbPath = path.join(agentsDir, agentId, 'messages.db');
  if (!fs.existsSync(dbPath)) return null;
  return { db: new DatabaseSync(dbPath), dbPath };
}

function findMatches(agentId) {
  const opened = openDb(agentId);
  if (!opened) return { agentId, missing: true };
  const { db, dbPath } = opened;

  const envelopeRows = db.prepare(`
    SELECT id, conversation_id, text_content, created_at
    FROM messages
    WHERE role = 'user'
      AND text_content LIKE 'Sender (untrusted metadata):%'
    ORDER BY id ASC
  `).all();

  const matches = [];
  const unmatched = [];

  const findPrev = db.prepare(`
    SELECT id, text_content, created_at
    FROM messages
    WHERE conversation_id = ?
      AND role = 'user'
      AND id < ?
      AND text_content = ?
    ORDER BY id DESC
    LIMIT 5
  `);

  for (const row of envelopeRows) {
    const stripped = stripMessageMetadata(row.text_content || '');
    if (!stripped) {
      unmatched.push({ envelopeId: row.id, reason: 'empty_after_strip', createdAt: row.created_at });
      continue;
    }

    const prevs = findPrev.all(row.conversation_id, row.id, stripped);
    let chosen = null;
    for (const prev of prevs) {
      const deltaMs = (() => {
        const a = isoMs(row.created_at);
        const b = isoMs(prev.created_at);
        if (a == null || b == null) return null;
        return a - b;
      })();
      const idGap = row.id - prev.id;
      if ((deltaMs == null || (deltaMs >= 0 && deltaMs <= 10 * 60 * 1000)) && idGap <= 6) {
        chosen = { ...prev, deltaMs, idGap };
        break;
      }
    }

    if (!chosen) {
      unmatched.push({ envelopeId: row.id, reason: 'no_nearby_exact_prior_match', createdAt: row.created_at, strippedPreview: stripped.slice(0, 120) });
      continue;
    }

    matches.push({
      conversationId: row.conversation_id,
      bareId: chosen.id,
      envelopeId: row.id,
      bareCreatedAt: chosen.created_at,
      envelopeCreatedAt: row.created_at,
      deltaMs: chosen.deltaMs,
      idGap: chosen.idGap,
      strippedPreview: stripped.slice(0, 160),
    });
  }

  const uniqueEnvelopeIds = [...new Set(matches.map(m => m.envelopeId))];

  if (apply && uniqueEnvelopeIds.length > 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const del = db.prepare(`DELETE FROM messages WHERE id = ?`);
      for (const id of uniqueEnvelopeIds) del.run(id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    agentId,
    dbPath,
    envelopeRows: envelopeRows.length,
    matchedRows: matches.length,
    unmatchedRows: unmatched.length,
    wouldDelete: uniqueEnvelopeIds.length,
    matches,
    unmatched,
  };
}

const agents = all
  ? fs.readdirSync(agentsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
  : [singleAgent];

const results = agents.map(findMatches);
const summary = results
  .filter(r => !r.missing)
  .map(r => ({
    agentId: r.agentId,
    envelopeRows: r.envelopeRows,
    matchedRows: r.matchedRows,
    unmatchedRows: r.unmatchedRows,
    wouldDelete: r.wouldDelete,
  }));

const totals = summary.reduce((acc, r) => {
  acc.envelopeRows += r.envelopeRows;
  acc.matchedRows += r.matchedRows;
  acc.unmatchedRows += r.unmatchedRows;
  acc.wouldDelete += r.wouldDelete;
  return acc;
}, { envelopeRows: 0, matchedRows: 0, unmatchedRows: 0, wouldDelete: 0 });

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  dataDir,
  agents: summary,
  totals,
  samples: results.filter(r => !r.missing).slice(0, 5).map(r => ({
    agentId: r.agentId,
    matchSamples: r.matches.slice(0, 5),
    unmatchedSamples: r.unmatched.slice(0, 5),
  })),
}, null, 2));
