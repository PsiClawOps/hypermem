/**
 * Turn DAG Phase 2 Tests
 *
 * Tests:
 *   Schema:
 *     1. Schema v7 adds parent_id and depth columns to messages
 *     2. Schema v7 creates idx_messages_parent_id index
 *
 *   Backfill:
 *     3. backfillParentChains reconstructs a linear chain for a flat conversation
 *     4. backfillParentChains is idempotent
 *     5. backfillParentChains handles multiple conversations independently
 *     6. backfillParentChains stamps context_id on messages that lack it
 *
 *   Write path:
 *     7. recordMessage sets parent_id and depth when contextId is provided
 *     8. recordMessage chains messages correctly (depth increments)
 *     9. recordMessage works without contextId (parent_id = null, depth = 0)
 *
 *   Session rotation:
 *    10. rotateSessionContext archives old context and creates new one
 *    11. rotateSessionContext links new context to old via parent_context_id
 *    12. rotateSessionContext works when no prior context exists
 *    13. New writes after rotation start fresh chain (parent_id from new head)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  ensureContextSchema,
  getActiveContext,
  getOrCreateActiveContext,
  updateContextHead,
  rotateSessionContext,
} from '../dist/context-store.js';
import { backfillParentChains } from '../dist/context-backfill.js';
import { MessageStore } from '../dist/message-store.js';
import { migrate } from '../dist/schema.js';

// ─── Helpers ──────────────────────────────────────────────────

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  ensureContextSchema(db);
  return db;
}

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

/** Insert N flat messages (no parent_id, no depth, no context_id) — simulates legacy data */
function insertFlatMessages(db, conversationId, agentId, count) {
  const now = new Date().toISOString();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    db.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(conversationId, agentId, role, `Message ${i}`, i, now);
    const row = db.prepare('SELECT last_insert_rowid() as id').get();
    ids.push(row.id);
  }
  return ids;
}

// ─── Schema Tests ─────────────────────────────────────────────

describe('Schema v7 — Turn DAG columns', () => {
  it('adds parent_id and depth columns to messages', () => {
    const db = createTestDb();
    const cols = db.prepare('PRAGMA table_info(messages)').all().map(r => r.name);
    assert.ok(cols.includes('parent_id'), 'messages has parent_id column');
    assert.ok(cols.includes('depth'), 'messages has depth column');
  });

  it('creates idx_messages_parent_id index', () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'")
      .all()
      .map(r => r.name);
    assert.ok(indexes.includes('idx_messages_parent_id'), 'parent_id index exists');
  });
});

// ─── Backfill Tests ───────────────────────────────────────────

describe('backfillParentChains', () => {
  it('reconstructs a linear chain for a flat conversation', () => {
    const db = createTestDb();
    const convId = insertConversation(db, 'agent1', 'session-1');
    const msgIds = insertFlatMessages(db, convId, 'agent1', 5);

    // Create context so backfill can stamp context_id
    getOrCreateActiveContext(db, 'agent1', 'session-1', convId);

    const result = backfillParentChains(db);
    assert.equal(result.conversationsProcessed, 1);
    assert.equal(result.messagesUpdated, 5);

    // Verify the chain
    const messages = db
      .prepare('SELECT id, parent_id, depth FROM messages WHERE conversation_id = ? ORDER BY message_index')
      .all(convId);

    // First message: parent_id = null, depth = 0
    assert.equal(messages[0].parent_id, null, 'first message has null parent');
    assert.equal(messages[0].depth, 0, 'first message has depth 0');

    // Subsequent messages chain correctly
    for (let i = 1; i < messages.length; i++) {
      assert.equal(messages[i].parent_id, messages[i - 1].id, `message ${i} parent is message ${i - 1}`);
      assert.equal(messages[i].depth, i, `message ${i} has depth ${i}`);
    }
  });

  it('is idempotent — second run updates 0 messages', () => {
    const db = createTestDb();
    const convId = insertConversation(db, 'agent1', 'session-1');
    insertFlatMessages(db, convId, 'agent1', 4);
    getOrCreateActiveContext(db, 'agent1', 'session-1', convId);

    const first = backfillParentChains(db);
    assert.equal(first.messagesUpdated, 4);

    const second = backfillParentChains(db);
    assert.equal(second.messagesUpdated, 0, 'second run updates nothing');
    assert.equal(second.conversationsProcessed, 0, 'second run processes no conversations');
  });

  it('handles multiple conversations independently', () => {
    const db = createTestDb();
    const conv1 = insertConversation(db, 'agent1', 'session-a');
    const conv2 = insertConversation(db, 'agent1', 'session-b');
    const ids1 = insertFlatMessages(db, conv1, 'agent1', 3);
    const ids2 = insertFlatMessages(db, conv2, 'agent1', 4);
    getOrCreateActiveContext(db, 'agent1', 'session-a', conv1);
    getOrCreateActiveContext(db, 'agent1', 'session-b', conv2);

    const result = backfillParentChains(db);
    assert.equal(result.conversationsProcessed, 2);
    assert.equal(result.messagesUpdated, 7);

    // Verify conv1 chain
    const chain1 = db
      .prepare('SELECT id, parent_id, depth FROM messages WHERE conversation_id = ? ORDER BY message_index')
      .all(conv1);
    assert.equal(chain1[0].parent_id, null);
    assert.equal(chain1[1].parent_id, ids1[0]);
    assert.equal(chain1[2].parent_id, ids1[1]);

    // Verify conv2 chain — independent from conv1
    const chain2 = db
      .prepare('SELECT id, parent_id, depth FROM messages WHERE conversation_id = ? ORDER BY message_index')
      .all(conv2);
    assert.equal(chain2[0].parent_id, null);
    assert.equal(chain2[0].depth, 0);
    assert.equal(chain2[3].parent_id, ids2[2]);
    assert.equal(chain2[3].depth, 3);
  });

  it('stamps context_id on messages that lack it', () => {
    const db = createTestDb();
    const convId = insertConversation(db, 'agent1', 'session-1');
    insertFlatMessages(db, convId, 'agent1', 3);
    const ctx = getOrCreateActiveContext(db, 'agent1', 'session-1', convId);

    backfillParentChains(db);

    const msgs = db
      .prepare('SELECT context_id FROM messages WHERE conversation_id = ?')
      .all(convId);
    for (const msg of msgs) {
      assert.equal(msg.context_id, ctx.id, 'context_id stamped on legacy message');
    }
  });
});

// ─── Write Path Tests ─────────────────────────────────────────

describe('recordMessage — Phase 2 DAG writes', () => {
  it('sets parent_id and depth when contextId is provided', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const convId = insertConversation(db, 'agent1', 'session-1');
    const ctx = getOrCreateActiveContext(db, 'agent1', 'session-1', convId);

    // First message
    const msg1 = store.recordMessage(convId, 'agent1', {
      role: 'user',
      textContent: 'Hello',
      toolCalls: null,
      toolResults: null,
    }, { contextId: ctx.id });

    const row1 = db.prepare('SELECT parent_id, depth, context_id FROM messages WHERE id = ?').get(msg1.id);
    assert.equal(row1.parent_id, null, 'first message has null parent_id');
    assert.equal(row1.depth, 0, 'first message has depth 0');
    assert.equal(row1.context_id, ctx.id, 'first message has context_id');

    // Second message — should chain off first
    const msg2 = store.recordMessage(convId, 'agent1', {
      role: 'assistant',
      textContent: 'Hi there',
      toolCalls: null,
      toolResults: null,
    }, { contextId: ctx.id });

    const row2 = db.prepare('SELECT parent_id, depth, context_id FROM messages WHERE id = ?').get(msg2.id);
    assert.equal(row2.parent_id, msg1.id, 'second message parent is first message');
    assert.equal(row2.depth, 1, 'second message has depth 1');
  });

  it('chains messages correctly across multiple turns', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const convId = insertConversation(db, 'agent1', 'session-1');
    const ctx = getOrCreateActiveContext(db, 'agent1', 'session-1', convId);

    const messages = [];
    for (let i = 0; i < 5; i++) {
      const msg = store.recordMessage(convId, 'agent1', {
        role: i % 2 === 0 ? 'user' : 'assistant',
        textContent: `Turn ${i}`,
        toolCalls: null,
        toolResults: null,
      }, { contextId: ctx.id });
      messages.push(msg);
    }

    // Verify chain
    for (let i = 0; i < messages.length; i++) {
      const row = db.prepare('SELECT parent_id, depth FROM messages WHERE id = ?').get(messages[i].id);
      if (i === 0) {
        assert.equal(row.parent_id, null);
        assert.equal(row.depth, 0);
      } else {
        assert.equal(row.parent_id, messages[i - 1].id, `msg ${i} parent_id`);
        assert.equal(row.depth, i, `msg ${i} depth`);
      }
    }

    // Head should be the last message
    const updated = getActiveContext(db, 'agent1', 'session-1');
    assert.equal(updated.headMessageId, messages[4].id, 'head points to last message');
  });

  it('works without contextId — parent_id null, depth 0', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const convId = insertConversation(db, 'agent1', 'session-1');

    const msg = store.recordMessage(convId, 'agent1', {
      role: 'user',
      textContent: 'No context',
      toolCalls: null,
      toolResults: null,
    });

    const row = db.prepare('SELECT parent_id, depth, context_id FROM messages WHERE id = ?').get(msg.id);
    assert.equal(row.parent_id, null, 'no parent when no context');
    assert.equal(row.depth, 0, 'depth 0 when no context');
    assert.equal(row.context_id, null, 'no context_id stamped');
  });
});

// ─── Session Rotation Tests ──────────────────────────────────

describe('rotateSessionContext', () => {
  it('archives old context and creates a new one', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const convId = insertConversation(db, 'agent1', 'session-1');
    const original = getOrCreateActiveContext(db, 'agent1', 'session-1', convId);
    // Write a message to advance the head pointer
    store.recordMessage(convId, 'agent1', {
      role: 'user', textContent: 'Some progress', toolCalls: null, toolResults: null,
    }, { contextId: original.id });

    const rotated = rotateSessionContext(db, 'agent1', 'session-1', convId);

    // Old context should be archived
    const oldRow = db.prepare('SELECT status FROM contexts WHERE id = ?').get(original.id);
    assert.equal(oldRow.status, 'archived', 'old context archived');

    // New context should be active with null head
    assert.notEqual(rotated.id, original.id, 'new context has different id');
    assert.equal(rotated.status, 'active');
    assert.equal(rotated.headMessageId, null, 'new context starts with null head');
  });

  it('links new context to old via parent_context_id', () => {
    const db = createTestDb();
    const convId = insertConversation(db, 'agent1', 'session-1');
    const original = getOrCreateActiveContext(db, 'agent1', 'session-1', convId);

    const rotated = rotateSessionContext(db, 'agent1', 'session-1', convId);
    assert.equal(rotated.parentContextId, original.id, 'parent_context_id links to old');
  });

  it('works when no prior context exists', () => {
    const db = createTestDb();
    const convId = insertConversation(db, 'agent1', 'session-1');

    const ctx = rotateSessionContext(db, 'agent1', 'session-1', convId);
    assert.ok(ctx.id > 0, 'context created');
    assert.equal(ctx.parentContextId, null, 'no parent when no prior context');
    assert.equal(ctx.status, 'active');
  });

  it('new writes after rotation start fresh chain', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const convId = insertConversation(db, 'agent1', 'session-1');
    const ctx1 = getOrCreateActiveContext(db, 'agent1', 'session-1', convId);

    // Write some messages in original context
    const msg1 = store.recordMessage(convId, 'agent1', {
      role: 'user', textContent: 'Before rotation', toolCalls: null, toolResults: null,
    }, { contextId: ctx1.id });

    const msg2 = store.recordMessage(convId, 'agent1', {
      role: 'assistant', textContent: 'Reply before rotation', toolCalls: null, toolResults: null,
    }, { contextId: ctx1.id });

    // Rotate
    const ctx2 = rotateSessionContext(db, 'agent1', 'session-1', convId);

    // Write in new context
    const msg3 = store.recordMessage(convId, 'agent1', {
      role: 'user', textContent: 'After rotation', toolCalls: null, toolResults: null,
    }, { contextId: ctx2.id });

    // msg3 should have null parent (fresh head) and depth 0
    const row3 = db.prepare('SELECT parent_id, depth, context_id FROM messages WHERE id = ?').get(msg3.id);
    assert.equal(row3.parent_id, null, 'first message after rotation has null parent');
    assert.equal(row3.depth, 0, 'first message after rotation has depth 0');
    assert.equal(row3.context_id, ctx2.id, 'context_id is the new context');

    // Continue writing — should chain within new context
    const msg4 = store.recordMessage(convId, 'agent1', {
      role: 'assistant', textContent: 'Reply after rotation', toolCalls: null, toolResults: null,
    }, { contextId: ctx2.id });

    const row4 = db.prepare('SELECT parent_id, depth FROM messages WHERE id = ?').get(msg4.id);
    assert.equal(row4.parent_id, msg3.id, 'second message after rotation chains from first');
    assert.equal(row4.depth, 1, 'depth increments from new chain start');
  });
});
