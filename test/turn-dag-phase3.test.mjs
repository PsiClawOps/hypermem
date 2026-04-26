/**
 * Turn DAG Phase 3 Tests
 *
 * Tests:
 *   Schema:
 *     1. Schema v8 creates idx_messages_context_id index
 *
 *   DAG-native reads (MessageStore):
 *     2. getHistoryByDAGWalk walks parent_id chain from head
 *     3. getHistoryByDAGWalk returns only active branch (no cross-branch leakage)
 *     4. getHistoryByDAGWalk respects limit parameter
 *     5. getHistoryByDAGWalk returns empty for missing head
 *
 *   Context-scoped queries:
 *     6. getMessagesByContextId returns only messages for the given context
 *     7. searchMessagesByContextId constrains FTS to context
 *
 *   Restart continuity:
 *     8. After session rotation, DAG walk from new head returns only new branch
 *     9. Old branch messages are not visible from new context head
 *
 *   Warm preload scoping:
 *    10. Warm preload with DAG walk only includes active branch messages
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

function recordWithContext(store, conversationId, agentId, contextId, role, text) {
  return store.recordMessage(conversationId, agentId, {
    role,
    textContent: text,
    toolCalls: null,
    toolResults: null,
  }, { contextId });
}

// ─── Tests ────────────────────────────────────────────────────

describe('Turn DAG Phase 3: Schema', () => {
  it('1. Schema v8 creates idx_messages_context_id index', () => {
    const db = createTestDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_context_id'"
    ).all();
    assert.equal(indexes.length, 1, 'idx_messages_context_id index should exist');
    db.close();
  });
});

describe('Turn DAG Phase 3: DAG-native reads', () => {
  it('2. getHistoryByDAGWalk walks parent_id chain from head', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-dag3';
    const sessionKey = 'session-dag3';
    const convId = insertConversation(db, agentId, sessionKey);
    const ctx = getOrCreateActiveContext(db, agentId, sessionKey, convId);

    // Insert 5 messages building a chain
    const msg1 = recordWithContext(store, convId, agentId, ctx.id, 'user', 'Hello');
    const msg2 = recordWithContext(store, convId, agentId, ctx.id, 'assistant', 'Hi there');
    const msg3 = recordWithContext(store, convId, agentId, ctx.id, 'user', 'How are you?');
    const msg4 = recordWithContext(store, convId, agentId, ctx.id, 'assistant', 'I am well');
    const msg5 = recordWithContext(store, convId, agentId, ctx.id, 'user', 'Great');

    // Get active context to find head
    const activeCtx = getActiveContext(db, agentId, sessionKey);
    assert.ok(activeCtx, 'Active context should exist');
    assert.equal(activeCtx.headMessageId, msg5.id, 'Head should be last message');

    // DAG walk from head
    const history = store.getHistoryByDAGWalk(activeCtx.headMessageId, 50);
    assert.equal(history.length, 5, 'Should get all 5 messages');

    // Verify chronological order (ascending by depth)
    assert.equal(history[0].textContent, 'Hello');
    assert.equal(history[1].textContent, 'Hi there');
    assert.equal(history[2].textContent, 'How are you?');
    assert.equal(history[3].textContent, 'I am well');
    assert.equal(history[4].textContent, 'Great');
    db.close();
  });

  it('3. getHistoryByDAGWalk returns only active branch (no cross-branch leakage)', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-branch';
    const sessionKey = 'session-branch';
    const convId = insertConversation(db, agentId, sessionKey);
    const ctx = getOrCreateActiveContext(db, agentId, sessionKey, convId);

    // Build initial chain on branch A
    const msg1 = recordWithContext(store, convId, agentId, ctx.id, 'user', 'Branch A msg 1');
    const msg2 = recordWithContext(store, convId, agentId, ctx.id, 'assistant', 'Branch A msg 2');
    const msg3 = recordWithContext(store, convId, agentId, ctx.id, 'user', 'Branch A msg 3');

    // Simulate branch: rotate session context to create branch B
    const ctxB = rotateSessionContext(db, agentId, sessionKey, convId);

    // Branch B messages — these should NOT see branch A messages via DAG walk
    const msgB1 = recordWithContext(store, convId, agentId, ctxB.id, 'user', 'Branch B msg 1');
    const msgB2 = recordWithContext(store, convId, agentId, ctxB.id, 'assistant', 'Branch B msg 2');

    // DAG walk from branch B head
    const branchBHistory = store.getHistoryByDAGWalk(
      getActiveContext(db, agentId, sessionKey).headMessageId, 50
    );

    // Branch B should only see its own messages
    assert.equal(branchBHistory.length, 2, 'Branch B should have 2 messages');
    assert.equal(branchBHistory[0].textContent, 'Branch B msg 1');
    assert.equal(branchBHistory[1].textContent, 'Branch B msg 2');

    // Verify no cross-branch leakage
    const branchBTexts = branchBHistory.map(m => m.textContent);
    assert.ok(!branchBTexts.includes('Branch A msg 1'), 'No branch A leakage');
    assert.ok(!branchBTexts.includes('Branch A msg 2'), 'No branch A leakage');
    assert.ok(!branchBTexts.includes('Branch A msg 3'), 'No branch A leakage');

    db.close();
  });

  it('4. getHistoryByDAGWalk respects limit parameter', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-limit';
    const sessionKey = 'session-limit';
    const convId = insertConversation(db, agentId, sessionKey);
    const ctx = getOrCreateActiveContext(db, agentId, sessionKey, convId);

    // Insert 10 messages
    for (let i = 0; i < 10; i++) {
      recordWithContext(store, convId, agentId, ctx.id,
        i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`);
    }

    const activeCtx = getActiveContext(db, agentId, sessionKey);
    const limited = store.getHistoryByDAGWalk(activeCtx.headMessageId, 3);
    assert.equal(limited.length, 3, 'Should respect limit of 3');
    db.close();
  });

  it('5. getHistoryByDAGWalk returns empty for missing head', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const result = store.getHistoryByDAGWalk(99999, 50);
    assert.equal(result.length, 0, 'Should return empty for non-existent head');
    db.close();
  });
});

describe('Turn DAG Phase 3: Context-scoped queries', () => {
  it('6. getMessagesByContextId returns only messages for the given context', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-scope';
    const sessionKey = 'session-scope';
    const convId = insertConversation(db, agentId, sessionKey);
    const ctxA = getOrCreateActiveContext(db, agentId, sessionKey, convId);

    // Write 3 messages on context A
    recordWithContext(store, convId, agentId, ctxA.id, 'user', 'Context A msg 1');
    recordWithContext(store, convId, agentId, ctxA.id, 'assistant', 'Context A msg 2');
    recordWithContext(store, convId, agentId, ctxA.id, 'user', 'Context A msg 3');

    // Rotate to context B
    const ctxB = rotateSessionContext(db, agentId, sessionKey, convId);

    // Write 2 messages on context B
    recordWithContext(store, convId, agentId, ctxB.id, 'user', 'Context B msg 1');
    recordWithContext(store, convId, agentId, ctxB.id, 'assistant', 'Context B msg 2');

    // Query by context A — should get exactly 3
    const ctxAMsgs = store.getMessagesByContextId(ctxA.id, 100);
    assert.equal(ctxAMsgs.length, 3, 'Context A should have 3 messages');
    assert.ok(ctxAMsgs.every(m => m.textContent?.startsWith('Context A')),
      'All messages should be from context A');

    // Query by context B — should get exactly 2
    const ctxBMsgs = store.getMessagesByContextId(ctxB.id, 100);
    assert.equal(ctxBMsgs.length, 2, 'Context B should have 2 messages');
    assert.ok(ctxBMsgs.every(m => m.textContent?.startsWith('Context B')),
      'All messages should be from context B');

    db.close();
  });

  it('7. searchMessagesByContextId constrains FTS to context', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-fts';
    const sessionKey = 'session-fts';
    const convId = insertConversation(db, agentId, sessionKey);
    const ctxA = getOrCreateActiveContext(db, agentId, sessionKey, convId);

    // Context A: messages about "quantum physics"
    recordWithContext(store, convId, agentId, ctxA.id, 'user', 'Tell me about quantum physics');
    recordWithContext(store, convId, agentId, ctxA.id, 'assistant', 'Quantum physics is fascinating');

    // Rotate to context B
    const ctxB = rotateSessionContext(db, agentId, sessionKey, convId);

    // Context B: also mentions "quantum" but different context
    recordWithContext(store, convId, agentId, ctxB.id, 'user', 'What is quantum computing?');
    recordWithContext(store, convId, agentId, ctxB.id, 'assistant', 'Quantum computing uses qubits');

    // Search "quantum" scoped to context A — should not find context B messages
    const ctxAResults = store.searchMessagesByContextId(ctxA.id, 'quantum', 10);
    assert.ok(ctxAResults.length > 0, 'Should find quantum in context A');
    assert.ok(ctxAResults.every(m => m.textContent?.includes('physics')),
      'Context A results should only be about physics');

    // Search "quantum" scoped to context B — should not find context A messages
    const ctxBResults = store.searchMessagesByContextId(ctxB.id, 'quantum', 10);
    assert.ok(ctxBResults.length > 0, 'Should find quantum in context B');
    assert.ok(ctxBResults.every(m => m.textContent?.includes('comput')),
      'Context B results should only be about computing');

    db.close();
  });
});

describe('Turn DAG Phase 3: Restart continuity', () => {
  it('8. After session rotation, DAG walk from new head returns only new branch', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-restart';
    const sessionKey = 'session-restart';
    const convId = insertConversation(db, agentId, sessionKey);

    // Session 1: original context
    const ctx1 = getOrCreateActiveContext(db, agentId, sessionKey, convId);
    recordWithContext(store, convId, agentId, ctx1.id, 'user', 'Session 1 message 1');
    recordWithContext(store, convId, agentId, ctx1.id, 'assistant', 'Session 1 response 1');
    recordWithContext(store, convId, agentId, ctx1.id, 'user', 'Session 1 message 2');

    // Simulate restart: rotate session
    const ctx2 = rotateSessionContext(db, agentId, sessionKey, convId);

    // Session 2: new messages on rotated context
    recordWithContext(store, convId, agentId, ctx2.id, 'user', 'Session 2 message 1');
    recordWithContext(store, convId, agentId, ctx2.id, 'assistant', 'Session 2 response 1');

    // Verify active context is the new one
    const activeCtx = getActiveContext(db, agentId, sessionKey);
    assert.equal(activeCtx.id, ctx2.id, 'Active context should be the new one');
    assert.ok(activeCtx.headMessageId != null, 'Head should be set');

    // DAG walk from new head — should only see session 2 messages
    const history = store.getHistoryByDAGWalk(activeCtx.headMessageId, 50);
    assert.equal(history.length, 2, 'Should only see session 2 messages');
    assert.equal(history[0].textContent, 'Session 2 message 1');
    assert.equal(history[1].textContent, 'Session 2 response 1');

    db.close();
  });

  it('9. Old branch messages are not visible from new context head', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-no-zombie';
    const sessionKey = 'session-no-zombie';
    const convId = insertConversation(db, agentId, sessionKey);

    // Build substantial history on old context
    const ctx1 = getOrCreateActiveContext(db, agentId, sessionKey, convId);
    for (let i = 0; i < 20; i++) {
      recordWithContext(store, convId, agentId, ctx1.id,
        i % 2 === 0 ? 'user' : 'assistant', `Old session msg ${i}`);
    }

    // Rotate
    const ctx2 = rotateSessionContext(db, agentId, sessionKey, convId);
    recordWithContext(store, convId, agentId, ctx2.id, 'user', 'Fresh start');
    recordWithContext(store, convId, agentId, ctx2.id, 'assistant', 'Welcome back');

    // DAG walk
    const activeCtx = getActiveContext(db, agentId, sessionKey);
    const history = store.getHistoryByDAGWalk(activeCtx.headMessageId, 100);

    // No old session messages should appear
    assert.equal(history.length, 2, 'Should only see 2 new messages');
    const texts = history.map(m => m.textContent);
    assert.ok(!texts.some(t => t?.startsWith('Old session')), 'No old session leakage');
    assert.ok(texts.includes('Fresh start'));
    assert.ok(texts.includes('Welcome back'));

    db.close();
  });
});

describe('Turn DAG Phase 3: Warm preload scoping', () => {
  it('10. Warm preload with DAG walk only includes active branch messages', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-warm';
    const sessionKey = 'session-warm';
    const convId = insertConversation(db, agentId, sessionKey);

    // Build history on context A
    const ctxA = getOrCreateActiveContext(db, agentId, sessionKey, convId);
    recordWithContext(store, convId, agentId, ctxA.id, 'user', 'Old warm msg 1');
    recordWithContext(store, convId, agentId, ctxA.id, 'assistant', 'Old warm msg 2');

    // Rotate to context B
    const ctxB = rotateSessionContext(db, agentId, sessionKey, convId);
    recordWithContext(store, convId, agentId, ctxB.id, 'user', 'New warm msg 1');
    recordWithContext(store, convId, agentId, ctxB.id, 'assistant', 'New warm msg 2');

    // Simulate warm preload: resolve active context + DAG walk
    const activeCtx = getActiveContext(db, agentId, sessionKey);
    assert.equal(activeCtx.id, ctxB.id, 'Active context should be B');

    let warmHistory;
    if (activeCtx?.headMessageId) {
      warmHistory = store.getHistoryByDAGWalk(activeCtx.headMessageId, 100);
      if (warmHistory.length === 0) {
        // Fallback
        warmHistory = store.getRecentMessages(convId, 100);
      }
    } else {
      warmHistory = store.getRecentMessages(convId, 100);
    }

    // Should only have context B messages
    assert.equal(warmHistory.length, 2, 'Warm preload should have 2 messages');
    assert.equal(warmHistory[0].textContent, 'New warm msg 1');
    assert.equal(warmHistory[1].textContent, 'New warm msg 2');

    db.close();
  });
});
