#!/usr/bin/env node
/**
 * ClawText → HyperMem Migration
 * 
 * Imports historical conversation data from ClawText's session-intelligence.db
 * into HyperMem's per-agent databases. Extracts agent identity from
 * CLAWPTIMIZATION identity anchors in conversation first messages.
 * 
 * Uses node:sqlite (Node 22+) — same as HyperMem itself.
 * 
 * Dry-run by default. Pass --apply to actually write.
 *
 * Usage:
 *   node scripts/migrate-clawtext.mjs
 *   node scripts/migrate-clawtext.mjs --apply
 *   node scripts/migrate-clawtext.mjs --apply --limit 100
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    'apply':   { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false }, // legacy alias
    'limit': { type: 'string', default: '0' },
    'clawtext-db': { type: 'string', default: path.join(os.homedir(), '.openclaw/workspace/.clawtext/session-intelligence.db') },
    'hypermem-dir': { type: 'string', default: path.join(os.homedir(), '.openclaw/hypermem') },
  }
});

const DRY_RUN = !args['apply']; // --apply to write; --dry-run is accepted but is now the default
const LIMIT = parseInt(args['limit'], 10);
const CT_DB_PATH = args['clawtext-db'];
const HM_DIR = args['hypermem-dir'];

// Known agents in the fleet
const KNOWN_AGENTS = new Set([
  'anvil', 'clarity', 'compass', 'forge', 'sentinel', 'vanguard',
  'helm', 'chisel', 'facet', 'pylon', 'plane', 'vigil', 'gauge', 'bastion',
  'crucible', 'relay', 'main', 'channel-mini', 'qatux'
]);

/**
 * Extract agent ID from CLAWPTIMIZATION identity anchor in message content.
 */
function extractAgentFromContent(content) {
  if (!content) return null;
  
  // Pattern: **Agent:** forge (forge)
  const agentMatch = content.match(/\*\*Agent:\*\*\s*(\w[\w-]*)/);
  if (agentMatch) {
    const agent = agentMatch[1].toLowerCase();
    if (KNOWN_AGENTS.has(agent)) return agent;
  }
  
  // Pattern: # SOUL.md — Forge
  const soulMatch = content.match(/# SOUL\.md\s*[—–-]\s*(\w+)/);
  if (soulMatch) {
    const agent = soulMatch[1].toLowerCase();
    if (KNOWN_AGENTS.has(agent)) return agent;
  }
  
  // Pattern: You are **Forge** or You are Forge —
  const youAreMatch = content.match(/You are \*?\*?(\w+)\*?\*?\s*[—–-]/);
  if (youAreMatch) {
    const agent = youAreMatch[1].toLowerCase();
    if (KNOWN_AGENTS.has(agent)) return agent;
  }

  return null;
}

/**
 * Ensure HyperMem agent database exists with correct schema.
 */
function ensureAgentDb(agentId) {
  const agentDir = path.join(HM_DIR, 'agents', agentId);
  const dbPath = path.join(agentDir, 'messages.db');
  
  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }
  
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  
  // Ensure tables exist — match the LIVE HyperMem schema exactly
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL UNIQUE,
      session_id TEXT,
      agent_id TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      channel_id TEXT,
      provider TEXT,
      model TEXT,
      status TEXT DEFAULT 'active',
      message_count INTEGER DEFAULT 0,
      token_count_in INTEGER DEFAULT 0,
      token_count_out INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text_content TEXT,
      tool_calls TEXT,
      tool_results TEXT,
      metadata TEXT,
      token_count INTEGER,
      message_index INTEGER NOT NULL,
      is_heartbeat INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
  `);
  
  return db;
}

function main() {
  console.log(`[migrate] ClawText → HyperMem migration`);
  console.log(`[migrate] Source: ${CT_DB_PATH}`);
  console.log(`[migrate] Target: ${HM_DIR}`);
  console.log(`[migrate] Dry run: ${DRY_RUN}`);
  console.log('');

  if (!fs.existsSync(CT_DB_PATH)) {
    console.error(`[migrate] ERROR: ClawText DB not found at ${CT_DB_PATH}`);
    process.exit(1);
  }

  const ctDb = new DatabaseSync(CT_DB_PATH, { readOnly: true });

  // Get all conversations with their first message for agent identification
  const getConversations = ctDb.prepare(`
    SELECT c.id, c.session_key, c.created_at, c.updated_at,
           (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY message_index ASC LIMIT 1) as first_content,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as msg_count
    FROM conversations c
    ORDER BY c.id ASC
    ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ''}
  `);
  
  const conversations = getConversations.all();
  console.log(`[migrate] Found ${conversations.length} conversations to process`);

  // Stats
  const stats = {
    total: conversations.length,
    identified: 0,
    unidentified: 0,
    messagesImported: 0,
    skippedDuplicate: 0,
    byAgent: {},
    errors: 0
  };

  // Cache of open agent DBs
  const agentDbs = new Map();
  
  function getDb(agentId) {
    if (agentDbs.has(agentId)) return agentDbs.get(agentId);
    if (DRY_RUN) return null;
    const db = ensureAgentDb(agentId);
    agentDbs.set(agentId, db);
    return db;
  }

  // Prepare ClawText message reader
  const getMessages = ctDb.prepare(`
    SELECT role, content, token_count, message_index, is_heartbeat, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY message_index ASC
  `);

  for (const convo of conversations) {
    const agentId = extractAgentFromContent(convo.first_content) || 'main';
    
    if (agentId === 'main' && !extractAgentFromContent(convo.first_content)) {
      stats.unidentified++;
    } else {
      stats.identified++;
    }

    if (!stats.byAgent[agentId]) stats.byAgent[agentId] = { convos: 0, messages: 0 };
    stats.byAgent[agentId].convos++;

    if (DRY_RUN) {
      stats.byAgent[agentId].messages += convo.msg_count;
      stats.messagesImported += convo.msg_count;
      continue;
    }

    const hmDb = getDb(agentId);
    if (!hmDb) continue;

    // Use migration-prefixed session key to avoid collisions
    const sessionKey = `migrated:clawtext:${convo.session_key}`;
    
    // Check for duplicates
    const existing = hmDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
    if (existing) {
      stats.skippedDuplicate++;
      continue;
    }

    try {
      // Insert conversation — match live HyperMem schema
      const insertConvo = hmDb.prepare(`
        INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status, message_count, created_at, updated_at)
        VALUES (?, ?, ?, 'migrated', 'archived', ?, ?, ?)
      `);
      const convoResult = insertConvo.run(
        sessionKey,
        convo.session_key,  // original key as session_id
        agentId,
        convo.msg_count,
        convo.created_at,
        convo.updated_at || convo.created_at
      );
      const convoId = convoResult.lastInsertRowid;

      // Import messages
      const messages = getMessages.all(convo.id);
      const insertMsg = hmDb.prepare(`
        INSERT INTO messages (conversation_id, agent_id, role, text_content, metadata, token_count, message_index, is_heartbeat, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      let imported = 0;
      for (const msg of messages) {
        insertMsg.run(
          convoId,
          agentId,
          msg.role,
          msg.content,
          JSON.stringify({ source: 'clawtext-migration' }),
          msg.token_count,
          msg.message_index,
          msg.is_heartbeat || 0,
          msg.created_at
        );
        imported++;
      }

      stats.messagesImported += imported;
      stats.byAgent[agentId].messages += imported;
    } catch (err) {
      console.warn(`[migrate] Error importing ${convo.session_key} → ${agentId}: ${err.message}`);
      stats.errors++;
    }
  }

  // Close all DBs
  for (const db of agentDbs.values()) {
    if (db) db.close();
  }
  ctDb.close();

  // Report
  console.log('');
  console.log(`[migrate] === Results ===`);
  console.log(`[migrate] Total conversations: ${stats.total}`);
  console.log(`[migrate] Identified agent: ${stats.identified}`);
  console.log(`[migrate] Unidentified (→ main): ${stats.unidentified}`);
  console.log(`[migrate] Messages imported: ${stats.messagesImported}`);
  console.log(`[migrate] Skipped (duplicate): ${stats.skippedDuplicate}`);
  console.log(`[migrate] Errors: ${stats.errors}`);
  console.log('');
  console.log(`[migrate] By agent:`);
  for (const [agent, s] of Object.entries(stats.byAgent).sort((a, b) => b[1].messages - a[1].messages)) {
    console.log(`  ${agent}: ${s.convos} conversations, ${s.messages} messages`);
  }

  if (DRY_RUN) {
    console.log('');
    console.log(`[migrate] *** DRY RUN — no data was written ***`);
    console.log(`[migrate] Run with --apply to execute.`);
  } else {
    console.log('');
    console.log(`[migrate] Migration complete.`);
    console.log(`[migrate] The background indexer will process imported data on its next tick.`);
    console.log(`[migrate] To force immediate indexing: restart the gateway.`);
  }
}

main();
