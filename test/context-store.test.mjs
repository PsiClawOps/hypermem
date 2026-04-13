/**
 * Context Store + Context Backfill Tests
 *
 * Tests:
 *   1. ensureContextSchema creates the contexts table and context_id column
 *   2. ensureContextSchema is idempotent
 *   3. getOrCreateActiveContext creates a new context
 *   4. getOrCreateActiveContext returns same context on second call
 *   5. updateContextHead advances the head pointer
 *   6. updateContextHead respects monotone-forward
 *   7. archiveContext sets status to archived
 *   8. archiveContext is idempotent
 *   9. backfillContexts creates contexts for conversations without them
 *  10. backfillContexts is idempotent
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  ensureContextSchema,
  getActiveContext,
  getOrCreateActiveContext,
  updateContextHead,
  archiveContext,
} from '../dist/context-store.js';
import { backfillContexts } from '../dist/context-backfill.js';
import { migrate } from '../dist/schema.js';

/**
 * Create an in-memory messages.db with the base schema applied,
 * ready for context-store operations.
 */
function createTestDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

/**
 * Insert a minimal conversation row and return its id.
 */
function insertConversation(db, agentId, sessionKey) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO conversations
      (session_key, agent_id, channel_type, status, message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, 'webchat', 'active', 0, 0, 0, ?, ?)
  `).run(sessionKey, agentId, now, now);
  const row = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  return row.id;
}

/**
 * Insert N messages for a conversation and return their ids.
 */
function insertMessages(db, conversationId, agentId, count) {
  const now = new Date().toISOString();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    db.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(conversationId, agentId, role, `Message ${i + 1}`, i, now);
    const row = db.prepare('SELECT last_insert_rowid() as id').get();
    ids.push(row.id);
  }
  return ids;
}

// ─── Schema Tests ─────────────────────────────────────────────

describe('ensureContextSchema', () => {
  it('creates the contexts table and context_id column on messages', () => {
    const db = createTestDb();
    ensureContextSchema(db);

    // contexts table should exist
    const tables = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='contexts'"
    ).get();
    assert.equal(tables.cnt, 1, 'contexts table exists');

    // context_id column should be on messages
    const cols = db.prepare('PRAGMA table_info(messages)').all().map(r => r.name);
    assert.ok(cols.includes('context_id'), 'messages has context_id column');
  });

  it('is idempotent — calling twice does not error', () => {
    const db = createTestDb();
    ensureContextSchema(db);
    ensureContextSchema(db); // second call
    ensureContextSchema(db); // third call

    const tables = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='contexts'"
    ).get();
    assert.equal(tables.cnt, 1, 'still exactly one contexts table');
  });
});

// ─── Context CRUD Tests ───────────────────────────────────────

describe('getOrCreateActiveContext', () => {
  it('creates a new context', () => {
    const db = createTestDb();
    ensureContextSchema(db);
    const convId = insertConversation(db, 'forge', 'agent:forge:webchat:main');

    const ctx = getOrCreateActiveContext(db, 'forge', 'agent:forge:webchat:main', convId);
    assert.ok(ctx.id > 0, 'context has a valid id');
    assert.equal(ctx.agentId, 'forge');
    assert.equal(ctx.sessionKey, 'agent:forge:webchat:main');
    assert.equal(ctx.conversationId, convId);
    assert.equal(ctx.headMessageId, null);
    assert.equal(ctx.status, 'active');
  });

  it('returns the same context on second call (idempotent)', () => {
    const db = createTestDb();
    ensureContextSchema(db);
    const convId = insertConversation(db, 'forge', 'agent:forge:webchat:main');

    const ctx1 = getOrCreateActiveContext(db, 'forge', 'agent:forge:webchat:main', convId);
    const ctx2 = getOrCreateActiveContext(db, 'forge', 'agent:forge:webchat:main', convId);

    assert.equal(ctx1.id, ctx2.id, 'same context id on second call');

    // Only one active context should exist
    const rows = db.prepare(
      "SELECT count(*) as cnt FROM contexts WHERE agent_id = 'forge' AND status = 'active'"
    ).get();
    assert.equal(rows.cnt, 1, 'exactly one active context');
  });
});

// ─── Head Pointer Tests ───────────────────────────────────────

describe('updateContextHead', () => {
  it('advances the head pointer', () => {
    const db = createTestDb();
    ensureContextSchema(db);
    const convId = insertConversation(db, 'forge', 'agent:forge:webchat:main');
    const msgIds = insertMessages(db, convId, 'forge', 5);

    const ctx = getOrCreateActiveContext(db, 'forge', 'agent:forge:webchat:main', convId);
    assert.equal(ctx.headMessageId, null, 'head starts at null');

    updateContextHead(db, ctx.id, msgIds[2]);
    const updated = getActiveContext(db, 'forge', 'agent:forge:webchat:main');
    assert.equal(updated.headMessageId, msgIds[2], 'head advanced to message 3');
  });

  it('respects monotone-forward — does not go backward', () => {
    const db = createTestDb();
    ensureContextSchema(db);
    const convId = insertConversation(db, 'forge', 'agent:forge:webchat:main');
    const msgIds = insertMessages(db, convId, 'forge', 10);

    const ctx = getOrCreateActiveContext(db, 'forge', 'agent:forge:webchat:main', convId);

    // Advance to message 7
    updateContextHead(db, ctx.id, msgIds[6]);
    let current = getActiveContext(db, 'forge', 'agent:forge:webchat:main');
    assert.equal(current.headMessageId, msgIds[6], 'head at message 7');

    // Try to go backward to message 3 — should be ignored
    updateContextHead(db, ctx.id, msgIds[2]);
    current = getActiveContext(db, 'forge', 'agent:forge:webchat:main');
    assert.equal(current.headMessageId, msgIds[6], 'head still at message 7 (monotone)');

    // Move forward to message 9 — should succeed
    updateContextHead(db, ctx.id, msgIds[8]);
    current = getActiveContext(db, 'forge', 'agent:forge:webchat:main');
    assert.equal(current.headMessageId, msgIds[8], 'head advanced to message 9');
  });
});

// ─── Archive Tests ────────────────────────────────────────────

describe('archiveContext', () => {
  it('sets status to archived', () => {
    const db = createTestDb();
    ensureContextSchema(db);
    const convId = insertConversation(db, 'forge', 'agent:forge:webchat:main');

    const ctx = getOrCreateActiveContext(db, 'forge', 'agent:forge:webchat:main', convId);
    assert.equal(ctx.status, 'active');

    archiveContext(db, ctx.id);

    // getActiveContext should now return null (it's archived, not active)
    const active = getActiveContext(db, 'forge', 'agent:forge:webchat:main');
    assert.equal(active, null, 'no active context after archiving');

    // Verify directly that the status is archived
    const row = db.prepare('SELECT status FROM contexts WHERE id = ?').get(ctx.id);
    assert.equal(row.status, 'archived');
  });

  it('is idempotent — archiving twice does not error', () => {
    const db = createTestDb();
    ensureContextSchema(db);
    const convId = insertConversation(db, 'forge', 'agent:forge:webchat:main');

    const ctx = getOrCreateActiveContext(db, 'forge', 'agent:forge:webchat:main', convId);
    archiveContext(db, ctx.id);
    archiveContext(db, ctx.id); // second call — should not throw

    const row = db.prepare('SELECT status FROM contexts WHERE id = ?').get(ctx.id);
    assert.equal(row.status, 'archived');
  });
});

// ─── Backfill Tests ───────────────────────────────────────────

describe('backfillContexts', () => {
  it('creates contexts for conversations without them', () => {
    const db = createTestDb();
    ensureContextSchema(db);

    // Create 3 conversations with messages
    const conv1 = insertConversation(db, 'forge', 'session-1');
    const conv2 = insertConversation(db, 'forge', 'session-2');
    const conv3 = insertConversation(db, 'hal', 'session-3');
    insertMessages(db, conv1, 'forge', 5);
    insertMessages(db, conv2, 'forge', 3);
    insertMessages(db, conv3, 'hal', 8);

    const result = backfillContexts(db);
    assert.equal(result.created, 3, 'created 3 contexts');
    assert.equal(result.skipped, 0, 'skipped 0');

    // Each conversation should have an active context
    const ctx1 = getActiveContext(db, 'forge', 'session-1');
    assert.ok(ctx1, 'session-1 has an active context');
    assert.ok(ctx1.headMessageId !== null, 'session-1 head is set');

    const ctx2 = getActiveContext(db, 'forge', 'session-2');
    assert.ok(ctx2, 'session-2 has an active context');

    const ctx3 = getActiveContext(db, 'hal', 'session-3');
    assert.ok(ctx3, 'session-3 has an active context');
  });

  it('is idempotent — second run creates 0 new contexts', () => {
    const db = createTestDb();
    ensureContextSchema(db);

    insertConversation(db, 'forge', 'session-a');
    insertConversation(db, 'forge', 'session-b');
    insertMessages(db, 1, 'forge', 4);
    insertMessages(db, 2, 'forge', 6);

    const first = backfillContexts(db);
    assert.equal(first.created, 2, 'first run creates 2');

    const second = backfillContexts(db);
    assert.equal(second.created, 0, 'second run creates 0');
    assert.equal(second.skipped, 2, 'second run skips 2');
  });
});
