#!/usr/bin/env node
/**
 * hypermem-cleanup — operator-safe repair utilities for persisted HyperMem DBs.
 *
 * Default command repairs timestamp-stamped replay duplicates caused by Gateway
 * transcript restore re-recording the same user turn. It is read-only unless
 * --apply is passed, and apply mode writes a SQLite backup first by default.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { exit } from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const STAMPED_PREFIX_RE = /^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z]{2,4}\]/;
const DEFAULT_DATA_DIR = join(process.env.HOME || '', '.openclaw', 'hypermem');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function usage() {
  console.log(`Usage: hypermem-cleanup [options]

Repairs known persisted-data issues. Default mode is a dry-run scan for
Gateway timestamp-stamped user replay duplicates.

Options:
  --data-dir <path>        HyperMem data dir (default: ~/.openclaw/hypermem)
  --db <path>              Scan one messages.db instead of all agents
  --agent <id>             Restrict --data-dir scan to one agent
  --apply                  Delete duplicate rows and repair references
  --backup-dir <path>      Backup directory for apply mode (default: beside DB)
  --no-backup              Disable apply-mode backup (not recommended)
  --json                   Print machine-readable JSON
  --examples <n>           Include up to n hashed examples per DB (default: 5)
  --help                   Show this help

Safety:
  - dry-run is default
  - content is not printed; examples use SHA-256 prefixes and counts
  - apply mode keeps the earliest row per exact duplicate group
  - apply mode rewrites local message references, rebuilds FTS, and runs
    integrity checks before committing
`);
}

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tableExists(db, table) {
  const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
  return Boolean(row);
}

function columnExists(db, table, column) {
  if (!tableExists(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function firstTableColumns(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function sha12(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function resolveDbTargets({ dataDir, dbPath, agent }) {
  if (dbPath) {
    const resolved = resolve(dbPath);
    if (!existsSync(resolved)) throw new Error(`messages.db not found: ${resolved}`);
    return [{ agent: agent || dirname(resolved).split('/').pop() || 'unknown', dbPath: resolved }];
  }
  const agentsDir = join(resolve(dataDir || DEFAULT_DATA_DIR), 'agents');
  if (!existsSync(agentsDir)) throw new Error(`HyperMem agents dir not found: ${agentsDir}`);
  const agents = agent ? [agent] : readdirSync(agentsDir).sort();
  const targets = [];
  for (const id of agents) {
    const candidate = join(agentsDir, id, 'messages.db');
    if (existsSync(candidate)) targets.push({ agent: id, dbPath: candidate });
  }
  if (targets.length === 0) throw new Error(`No messages.db targets found under ${agentsDir}`);
  return targets;
}

function readRows(db) {
  const cols = firstTableColumns(db, 'messages');
  if (!cols.includes('text_content') || !cols.includes('conversation_id') || !cols.includes('role')) {
    throw new Error('messages table does not have the expected HyperMem columns');
  }
  const hasConversations = tableExists(db, 'conversations');
  const sql = hasConversations
    ? `SELECT m.id, m.conversation_id, c.session_key, m.agent_id, m.role, m.text_content,
              COALESCE(m.tool_calls, '') AS tool_calls,
              COALESCE(m.tool_results, '') AS tool_results,
              COALESCE(m.message_index, 0) AS message_index,
              m.created_at
         FROM messages m
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE m.role = 'user' AND m.text_content IS NOT NULL`
    : `SELECT id, conversation_id, NULL AS session_key, agent_id, role, text_content,
              COALESCE(tool_calls, '') AS tool_calls,
              COALESCE(tool_results, '') AS tool_results,
              COALESCE(message_index, 0) AS message_index,
              created_at
         FROM messages
        WHERE role = 'user' AND text_content IS NOT NULL`;
  return db.prepare(sql).all();
}

function findStampedUserDuplicateGroups(db) {
  const groups = new Map();
  for (const row of readRows(db)) {
    const text = String(row.text_content || '');
    if (!STAMPED_PREFIX_RE.test(text.trimStart())) continue;
    const key = [row.conversation_id, row.role, text, row.tool_calls || '', row.tool_results || ''].join('\u0000');
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }

  const duplicateGroups = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => {
      const ai = Number(a.message_index || 0);
      const bi = Number(b.message_index || 0);
      if (ai !== bi) return ai - bi;
      return Number(a.id) - Number(b.id);
    });
    const keep = rows[0];
    duplicateGroups.push({ keep, duplicates: rows.slice(1), all: rows });
  }
  duplicateGroups.sort((a, b) => String(a.keep.created_at || '').localeCompare(String(b.keep.created_at || '')) || Number(a.keep.id) - Number(b.keep.id));
  return duplicateGroups;
}

function summarizeTarget(target, groups, exampleLimit) {
  const duplicateRows = groups.reduce((sum, g) => sum + g.duplicates.length, 0);
  const conversations = new Set(groups.map((g) => g.keep.conversation_id));
  const first = groups[0]?.keep?.created_at || null;
  const lastGroup = groups[groups.length - 1];
  const lastRows = lastGroup ? lastGroup.all : [];
  const last = lastRows.length ? lastRows.map((r) => r.created_at).sort().at(-1) : null;
  const examples = groups.slice(0, exampleLimit).map((g) => ({
    conversationId: g.keep.conversation_id,
    sessionKey: g.keep.session_key || null,
    keepId: g.keep.id,
    duplicateIds: g.duplicates.map((r) => r.id),
    count: g.all.length,
    firstAt: g.all.map((r) => r.created_at).sort()[0] || null,
    lastAt: g.all.map((r) => r.created_at).sort().at(-1) || null,
    textSha256: sha12(String(g.keep.text_content || '')),
  }));
  return {
    agent: target.agent,
    dbPath: target.dbPath,
    duplicateGroups: groups.length,
    duplicateRows,
    affectedConversations: conversations.size,
    firstAt: first,
    lastAt: last,
    examples,
  };
}

function makeBackup(db, dbPath, backupDir) {
  const dir = backupDir ? resolve(backupDir) : dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  const backupPath = join(dir, `${dbPath.split('/').pop()}.backup-${isoStamp()}`);
  db.exec(`VACUUM INTO ${sqlLiteral(backupPath)}`);
  return backupPath;
}

function runIntegrityChecks(db) {
  const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]);
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  return { integrity, foreignKeys };
}

function assertChecksClean(checks) {
  const integrityOk = checks.integrity.length === 1 && checks.integrity[0] === 'ok';
  if (!integrityOk) throw new Error(`integrity_check failed: ${JSON.stringify(checks.integrity)}`);
  if (checks.foreignKeys.length > 0) throw new Error(`foreign_key_check failed: ${JSON.stringify(checks.foreignKeys.slice(0, 20))}`);
}

function rewriteReferences(db, fromId, toId) {
  if (tableExists(db, 'summary_messages')) {
    db.prepare('INSERT OR IGNORE INTO summary_messages (summary_id, message_id) SELECT summary_id, ? FROM summary_messages WHERE message_id = ?').run(toId, fromId);
    db.prepare('DELETE FROM summary_messages WHERE message_id = ?').run(fromId);
  }
  if (tableExists(db, 'messages') && columnExists(db, 'messages', 'parent_id')) {
    db.prepare('UPDATE messages SET parent_id = ? WHERE parent_id = ?').run(toId, fromId);
  }
  if (tableExists(db, 'contexts') && columnExists(db, 'contexts', 'head_message_id')) {
    db.prepare('UPDATE contexts SET head_message_id = ? WHERE head_message_id = ?').run(toId, fromId);
  }
  if (tableExists(db, 'composition_snapshots') && columnExists(db, 'composition_snapshots', 'head_message_id')) {
    db.prepare('UPDATE composition_snapshots SET head_message_id = ? WHERE head_message_id = ?').run(toId, fromId);
  }
  if (tableExists(db, 'tool_artifacts') && columnExists(db, 'tool_artifacts', 'message_id')) {
    db.prepare('UPDATE tool_artifacts SET message_id = ? WHERE message_id = ?').run(toId, fromId);
  }

  // Bridge rows are derived indexes. Drop duplicate-side rows; operators can run
  // the bridge backfill later if they want to rebuild derived mentions exactly.
  for (const table of ['message_entity_mentions', 'message_facet_mentions', 'entity_bridge_message_index']) {
    if (tableExists(db, table) && columnExists(db, table, 'message_id')) {
      db.prepare(`DELETE FROM ${table} WHERE message_id = ?`).run(fromId);
    }
  }
}

function applyGroups(db, groups) {
  const affectedConversations = new Set();
  let deleted = 0;
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const group of groups) {
      const keepId = Number(group.keep.id);
      affectedConversations.add(Number(group.keep.conversation_id));
      for (const dup of group.duplicates) {
        const dupId = Number(dup.id);
        rewriteReferences(db, dupId, keepId);
        const result = db.prepare('DELETE FROM messages WHERE id = ?').run(dupId);
        deleted += Number(result.changes || 0);
      }
    }
    if (tableExists(db, 'messages_fts')) {
      db.prepare("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')").run();
    }
    if (tableExists(db, 'conversations') && columnExists(db, 'conversations', 'message_count')) {
      for (const conversationId of affectedConversations) {
        db.prepare(`UPDATE conversations
                      SET message_count = (SELECT COUNT(*) FROM messages WHERE conversation_id = ?),
                          updated_at = COALESCE((SELECT MAX(created_at) FROM messages WHERE conversation_id = ?), updated_at)
                    WHERE id = ?`).run(conversationId, conversationId, conversationId);
      }
    }
    assertChecksClean(runIntegrityChecks(db));
    db.exec('COMMIT');
    return { deleted, affectedConversations: affectedConversations.size };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help) {
    usage();
    return;
  }
  const apply = Boolean(argv.apply);
  const json = Boolean(argv.json);
  const exampleLimit = argv.examples === true ? 5 : Math.max(0, Number(argv.examples ?? 5));
  const targets = resolveDbTargets({ dataDir: argv['data-dir'], dbPath: argv.db, agent: argv.agent });
  const results = [];

  for (const target of targets) {
    const db = new DatabaseSync(target.dbPath);
    try {
      const groups = findStampedUserDuplicateGroups(db);
      const summary = summarizeTarget(target, groups, exampleLimit);
      summary.mode = 'stamped-user-replay-duplicates';
      summary.dryRun = !apply;
      if (apply && groups.length > 0) {
        if (!argv['no-backup']) summary.backupPath = makeBackup(db, target.dbPath, argv['backup-dir']);
        const applied = applyGroups(db, groups);
        summary.deletedRows = applied.deleted;
        summary.postApplyDuplicateGroups = findStampedUserDuplicateGroups(db).length;
      }
      results.push(summary);
    } finally {
      db.close();
    }
  }

  const total = results.reduce((acc, r) => {
    acc.duplicateGroups += r.duplicateGroups;
    acc.duplicateRows += r.duplicateRows;
    acc.deletedRows += r.deletedRows || 0;
    return acc;
  }, { duplicateGroups: 0, duplicateRows: 0, deletedRows: 0 });

  const payload = { ok: true, dryRun: !apply, total, results };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`HyperMem cleanup ${apply ? 'apply' : 'dry-run'}: stamped user replay duplicates`);
  console.log(`Targets: ${results.length}`);
  console.log(`Duplicate groups: ${total.duplicateGroups}`);
  console.log(`Duplicate rows: ${total.duplicateRows}`);
  if (apply) console.log(`Deleted rows: ${total.deletedRows}`);
  for (const r of results.filter((item) => item.duplicateRows > 0).slice(0, 20)) {
    console.log(`- ${r.agent}: groups=${r.duplicateGroups} rows=${r.duplicateRows} first=${r.firstAt || 'n/a'} last=${r.lastAt || 'n/a'}`);
    if (r.backupPath) console.log(`  backup=${r.backupPath}`);
  }
  if (!apply && total.duplicateRows > 0) {
    console.log('\nNo changes made. Re-run with --apply to repair after stopping Gateway/OpenClaw writers.');
  }
}

main().catch((err) => {
  console.error(`hypermem-cleanup failed: ${err.message}`);
  exit(1);
});
