/**
 * Turn DAG Phase 4 Tests
 *
 * Tests for archived/mining read helpers:
 *   - getArchivedContexts
 *   - getArchivedContext
 *   - getContextLineage
 *   - getForkChildren
 *   - MessageStore.getArchivedChain
 *   - regression: active DAG walk isolation from archived messages
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
  rotateSessionContext,
  getArchivedContexts,
  getArchivedContext,
  getContextById,
  getContextLineage,
  getForkChildren,
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

// ─── getArchivedContexts Tests ────────────────────────────────

describe('Turn DAG Phase 4: getArchivedContexts', () => {
  it('returns archived and forked contexts, not active', () => {
    const db = createTestDb();
    const agentId = 'agent-arc1';
    const convId = insertConversation(db, agentId, 'session-arc1');

    // Create active context, then rotate twice to produce two archived ones
    const ctx1 = getOrCreateActiveContext(db, agentId, 'session-arc1', convId);
    const ctx2 = rotateSessionContext(db, agentId, 'session-arc1', convId);
    const ctx3 = rotateSessionContext(db, agentId, 'session-arc1', convId);
    // ctx3 is now active, ctx1 and ctx2 are archived

    const archived = getArchivedContexts(db, agentId);
    assert.equal(archived.length, 2, 'should return 2 archived contexts');
    assert.ok(archived.every(c => c.status === 'archived' || c.status === 'forked'),
      'all returned contexts should be archived or forked');
    assert.ok(!archived.some(c => c.id === ctx3.id), 'active context should not appear');

    db.close();
  });

  it('filters by sessionKey', () => {
    const db = createTestDb();
    const agentId = 'agent-arc2';
    const convId1 = insertConversation(db, agentId, 'session-A');
    const convId2 = insertConversation(db, agentId, 'session-B');

    // Archive one context in session-A
    const ctxA1 = getOrCreateActiveContext(db, agentId, 'session-A', convId1);
    rotateSessionContext(db, agentId, 'session-A', convId1);

    // Archive one context in session-B
    const ctxB1 = getOrCreateActiveContext(db, agentId, 'session-B', convId2);
    rotateSessionContext(db, agentId, 'session-B', convId2);

    // Filter to session-A only
    const archivedA = getArchivedContexts(db, agentId, { sessionKey: 'session-A' });
    assert.equal(archivedA.length, 1, 'should return 1 archived context for session-A');
    assert.equal(archivedA[0].id, ctxA1.id, 'should be the session-A context');

    // Filter to session-B only
    const archivedB = getArchivedContexts(db, agentId, { sessionKey: 'session-B' });
    assert.equal(archivedB.length, 1, 'should return 1 archived context for session-B');
    assert.equal(archivedB[0].id, ctxB1.id, 'should be the session-B context');

    db.close();
  });
});

// ─── getArchivedContext Tests ─────────────────────────────────

describe('Turn DAG Phase 4: getArchivedContext', () => {
  it('returns archived context by id (happy path)', () => {
    const db = createTestDb();
    const agentId = 'agent-gac1';
    const convId = insertConversation(db, agentId, 'session-gac1');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-gac1', convId);
    archiveContext(db, ctx.id);

    const result = getArchivedContext(db, ctx.id);
    assert.ok(result !== null, 'should return the archived context');
    assert.equal(result.id, ctx.id);
    assert.equal(result.status, 'archived');

    db.close();
  });

  it('returns null for an active context id', () => {
    const db = createTestDb();
    const agentId = 'agent-gac2';
    const convId = insertConversation(db, agentId, 'session-gac2');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-gac2', convId);

    const result = getArchivedContext(db, ctx.id);
    assert.equal(result, null, 'active context should return null');

    db.close();
  });

  it('returns null for a missing id', () => {
    const db = createTestDb();

    const result = getArchivedContext(db, 99999);
    assert.equal(result, null, 'missing id should return null');

    db.close();
  });
});

// ─── getContextLineage Tests ──────────────────────────────────

describe('Turn DAG Phase 4: getContextLineage', () => {
  it('single root — returns just the starting context', () => {
    const db = createTestDb();
    const agentId = 'agent-lin1';
    const convId = insertConversation(db, agentId, 'session-lin1');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-lin1', convId);

    const lineage = getContextLineage(db, ctx.id);
    assert.equal(lineage.length, 1, 'single context lineage');
    assert.equal(lineage[0].id, ctx.id);

    db.close();
  });

  it('walks parent chain across rotations (leaf-to-root order)', () => {
    const db = createTestDb();
    const agentId = 'agent-lin2';
    const convId = insertConversation(db, agentId, 'session-lin2');

    // Build chain: ctx1 <- ctx2 <- ctx3 (active)
    const ctx1 = getOrCreateActiveContext(db, agentId, 'session-lin2', convId);
    const ctx2 = rotateSessionContext(db, agentId, 'session-lin2', convId);
    const ctx3 = rotateSessionContext(db, agentId, 'session-lin2', convId);

    // ctx3 is active, parent is ctx2, ctx2's parent is ctx1
    const lineage = getContextLineage(db, ctx3.id);
    assert.equal(lineage.length, 3, 'should walk all 3 contexts');
    assert.equal(lineage[0].id, ctx3.id, 'first is leaf (ctx3)');
    assert.equal(lineage[1].id, ctx2.id, 'second is ctx2');
    assert.equal(lineage[2].id, ctx1.id, 'third is root (ctx1)');

    db.close();
  });
});

// ─── getForkChildren Tests ────────────────────────────────────

describe('Turn DAG Phase 4: getForkChildren', () => {
  it('returns direct children only', () => {
    const db = createTestDb();
    const agentId = 'agent-fkc1';
    const convId = insertConversation(db, agentId, 'session-fkc1');

    // ctx1 is the root (gets archived on first rotate)
    const ctx1 = getOrCreateActiveContext(db, agentId, 'session-fkc1', convId);
    // ctx2: child of ctx1 via rotate
    const ctx2 = rotateSessionContext(db, agentId, 'session-fkc1', convId);
    // ctx3: child of ctx2 (grandchild of ctx1) via second rotate
    const ctx3 = rotateSessionContext(db, agentId, 'session-fkc1', convId);

    // ctx1's direct children: only ctx2
    const childrenOfCtx1 = getForkChildren(db, ctx1.id);
    assert.equal(childrenOfCtx1.length, 1, 'ctx1 has one direct child');
    assert.equal(childrenOfCtx1[0].id, ctx2.id);

    // ctx2's direct children: only ctx3
    const childrenOfCtx2 = getForkChildren(db, ctx2.id);
    assert.equal(childrenOfCtx2.length, 1, 'ctx2 has one direct child');
    assert.equal(childrenOfCtx2[0].id, ctx3.id);

    // ctx3 has no children (it's active)
    const childrenOfCtx3 = getForkChildren(db, ctx3.id);
    assert.equal(childrenOfCtx3.length, 0, 'ctx3 has no children');

    db.close();
  });
});

// ─── getArchivedChain Tests ───────────────────────────────────

describe('Turn DAG Phase 4: getArchivedChain', () => {
  it('walks messages from archived context head', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-chain1';
    const convId = insertConversation(db, agentId, 'session-chain1');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-chain1', convId);

    // Record messages on ctx
    recordWithContext(store, convId, agentId, ctx.id, 'user', 'Archived msg 1');
    recordWithContext(store, convId, agentId, ctx.id, 'assistant', 'Archived msg 2');
    recordWithContext(store, convId, agentId, ctx.id, 'user', 'Archived msg 3');

    // Archive this context (rotate creates a new active one)
    rotateSessionContext(db, agentId, 'session-chain1', convId);

    // ctx is now archived — getArchivedChain should return its 3 messages
    const chain = store.getArchivedChain(ctx.id);
    assert.equal(chain.length, 3, 'should return 3 messages from archived context');
    assert.equal(chain[0].textContent, 'Archived msg 1');
    assert.equal(chain[1].textContent, 'Archived msg 2');
    assert.equal(chain[2].textContent, 'Archived msg 3');

    db.close();
  });

  it('throws for an active context', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-chain2';
    const convId = insertConversation(db, agentId, 'session-chain2');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-chain2', convId);
    recordWithContext(store, convId, agentId, ctx.id, 'user', 'Active msg');

    assert.throws(
      () => store.getArchivedChain(ctx.id),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('getArchivedChain: context must be archived or forked'),
          `unexpected message: ${err.message}`);
        return true;
      },
      'should throw for active context'
    );

    db.close();
  });

  it('returns [] for archived context with null head', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-chain3';
    const convId = insertConversation(db, agentId, 'session-chain3');

    // Create and immediately archive without recording any messages
    const ctx = getOrCreateActiveContext(db, agentId, 'session-chain3', convId);
    archiveContext(db, ctx.id);

    // head_message_id should be null
    const chain = store.getArchivedChain(ctx.id);
    assert.equal(chain.length, 0, 'should return empty array for null head');

    db.close();
  });
});

// ─── Regression Tests ────────────────────────────────────────

describe('Turn DAG Phase 4: Regressions', () => {
  it('active DAG walk does not see archived messages after rotation', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-reg1';
    const convId = insertConversation(db, agentId, 'session-reg1');

    // Build old branch
    const ctx1 = getOrCreateActiveContext(db, agentId, 'session-reg1', convId);
    recordWithContext(store, convId, agentId, ctx1.id, 'user', 'Old branch A');
    recordWithContext(store, convId, agentId, ctx1.id, 'assistant', 'Old branch B');

    // Rotate: ctx1 becomes archived, ctx2 is new active
    const ctx2 = rotateSessionContext(db, agentId, 'session-reg1', convId);
    recordWithContext(store, convId, agentId, ctx2.id, 'user', 'New branch X');
    recordWithContext(store, convId, agentId, ctx2.id, 'assistant', 'New branch Y');

    // DAG walk from the active context head should NOT see archived messages
    const activeCtx = getActiveContext(db, agentId, 'session-reg1');
    const history = store.getHistoryByDAGWalk(activeCtx.headMessageId, 100);

    assert.equal(history.length, 2, 'DAG walk should see only 2 new messages');
    assert.ok(!history.some(m => m.textContent?.startsWith('Old branch')),
      'should not see archived branch messages');

    db.close();
  });

  it('getMessagesByContextId on active context excludes archived messages', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-reg2';
    const convId = insertConversation(db, agentId, 'session-reg2');

    // Record on ctx1
    const ctx1 = getOrCreateActiveContext(db, agentId, 'session-reg2', convId);
    recordWithContext(store, convId, agentId, ctx1.id, 'user', 'Archived context msg');

    // Rotate — ctx1 archived, ctx2 active
    const ctx2 = rotateSessionContext(db, agentId, 'session-reg2', convId);
    recordWithContext(store, convId, agentId, ctx2.id, 'user', 'Active context msg');

    // Query active context — should not see archived context's messages
    const activeMessages = store.getMessagesByContextId(ctx2.id, 100);
    assert.equal(activeMessages.length, 1, 'active context should have 1 message');
    assert.equal(activeMessages[0].textContent, 'Active context msg');
    assert.ok(!activeMessages.some(m => m.textContent === 'Archived context msg'),
      'should not include archived context message');

    db.close();
  });

  it('searchMessagesByContextId on active context excludes archived messages', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-reg3';
    const convId = insertConversation(db, agentId, 'session-reg3');

    // Record on ctx1 — using "spaceship" as a unique search term
    const ctx1 = getOrCreateActiveContext(db, agentId, 'session-reg3', convId);
    recordWithContext(store, convId, agentId, ctx1.id, 'user', 'I love spaceship design');

    // Rotate — ctx1 archived, ctx2 active
    const ctx2 = rotateSessionContext(db, agentId, 'session-reg3', convId);
    recordWithContext(store, convId, agentId, ctx2.id, 'user', 'I love rocket design');

    // FTS search in active context for "spaceship" should return 0 results
    const results = store.searchMessagesByContextId(ctx2.id, 'spaceship', 10);
    assert.equal(results.length, 0, 'FTS should not find archived context message');

    // FTS search in active context for "rocket" should return 1 result
    const rocketResults = store.searchMessagesByContextId(ctx2.id, 'rocket', 10);
    assert.equal(rocketResults.length, 1, 'FTS should find the active context message');

    db.close();
  });
});
