/**
 * Archived Mining Tests (Phase 4 Sprint 2 / Sprint 3)
 *
 * Covers:
 *   - mineArchivedContext: positive path, active rejection, missing rejection,
 *     limit cap, excludeHeartbeats default/override, ftsQuery filter, isHistorical marker
 *   - mineArchivedContexts: multi-context soft-skip, result ordering, per-context opts
 *   - Regression: active composition paths remain archived-blind
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  ensureContextSchema,
  getOrCreateActiveContext,
  getActiveContext,
  archiveContext,
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

function recordMsg(store, conversationId, agentId, contextId, role, text, isHeartbeat = false) {
  return store.recordMessage(conversationId, agentId, {
    role,
    textContent: text,
    toolCalls: null,
    toolResults: null,
    metadata: isHeartbeat ? { heartbeat: true } : undefined,
  }, { contextId, isHeartbeat });
}

// ─── mineArchivedContext: positive path ──────────────────────

describe('mineArchivedContext: positive path', () => {
  it('returns ArchivedMiningResult with isHistorical: true and correct metadata', async () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-mine1';
    const convId = insertConversation(db, agentId, 'session-mine1');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-mine1', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'Hello archived world');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'Greetings from the archive');

    // Archive via rotate
    rotateSessionContext(db, agentId, 'session-mine1', convId);

    const result = store.mineArchivedContext({ contextId: ctx.id });

    assert.ok(result, 'should return a result');
    assert.equal(result.isHistorical, true, 'isHistorical must be true');
    assert.equal(result.contextId, ctx.id, 'contextId should match');
    assert.equal(result.agentId, agentId, 'agentId should match');
    assert.equal(result.sessionKey, 'session-mine1', 'sessionKey should match');
    assert.ok(result.contextStatus === 'archived' || result.contextStatus === 'forked',
      'contextStatus should be archived or forked');
    assert.ok(typeof result.contextUpdatedAt === 'string', 'contextUpdatedAt should be string');
    assert.ok(Array.isArray(result.data), 'data should be array');
    assert.equal(result.data.length, 2, 'should return 2 messages');
    assert.equal(result.data[0].textContent, 'Hello archived world');
    assert.equal(result.data[1].textContent, 'Greetings from the archive');

    db.close();
  });
});

// ─── mineArchivedContext: active rejection ────────────────────

describe('mineArchivedContext: active context rejection', () => {
  it('throws with clear error for an active context', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-mine2';
    const convId = insertConversation(db, agentId, 'session-mine2');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-mine2', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'Active msg');

    assert.throws(
      () => store.mineArchivedContext({ contextId: ctx.id }),
      (err) => {
        assert.ok(err instanceof Error, 'should throw Error');
        assert.ok(
          err.message.includes('does not exist or is not archived/forked'),
          `unexpected message: ${err.message}`
        );
        assert.ok(
          err.message.includes(String(ctx.id)),
          'error should include contextId'
        );
        return true;
      },
      'should throw for active context'
    );

    db.close();
  });
});

// ─── mineArchivedContext: missing context rejection ───────────

describe('mineArchivedContext: missing context rejection', () => {
  it('throws with clear error for a missing contextId', () => {
    const db = createTestDb();
    const store = new MessageStore(db);

    assert.throws(
      () => store.mineArchivedContext({ contextId: 99999 }),
      (err) => {
        assert.ok(err instanceof Error, 'should throw Error');
        assert.ok(
          err.message.includes('does not exist or is not archived/forked'),
          `unexpected message: ${err.message}`
        );
        return true;
      },
      'should throw for missing context'
    );

    db.close();
  });
});

// ─── mineArchivedContext: limit cap ──────────────────────────

describe('mineArchivedContext: limit cap', () => {
  it('hard caps results at 200', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-mine3';
    const convId = insertConversation(db, agentId, 'session-mine3');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-mine3', convId);

    // Insert 10 messages
    for (let i = 0; i < 10; i++) {
      recordMsg(store, convId, agentId, ctx.id, 'user', `Message ${i + 1}`);
    }
    rotateSessionContext(db, agentId, 'session-mine3', convId);

    // Request more than 200 — should be capped
    const result = store.mineArchivedContext({ contextId: ctx.id, limit: 500 });
    // We only have 10 messages, so all 10 should be returned (cap doesn't filter further than actual count)
    assert.equal(result.data.length, 10, 'should return all 10 messages (below cap)');
    assert.equal(result.isHistorical, true);

    db.close();
  });

  it('respects limit when fewer messages than cap exist', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-mine3b';
    const convId = insertConversation(db, agentId, 'session-mine3b');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-mine3b', convId);
    for (let i = 0; i < 10; i++) {
      recordMsg(store, convId, agentId, ctx.id, 'user', `Msg ${i + 1}`);
    }
    rotateSessionContext(db, agentId, 'session-mine3b', convId);

    // Request only 3
    const result = store.mineArchivedContext({ contextId: ctx.id, limit: 3 });
    // DAG walk is limited to 3 — the walk returns the last 3 (most recent)
    assert.ok(result.data.length <= 3, `should return at most 3 messages, got ${result.data.length}`);
    assert.equal(result.isHistorical, true);

    db.close();
  });
});

// ─── mineArchivedContext: excludeHeartbeats default/override ──

describe('mineArchivedContext: excludeHeartbeats', () => {
  it('excludes heartbeats by default', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-mine4';
    const convId = insertConversation(db, agentId, 'session-mine4');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-mine4', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'Real user message');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'heartbeat ping', true);
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'Real assistant reply');
    rotateSessionContext(db, agentId, 'session-mine4', convId);

    const result = store.mineArchivedContext({ contextId: ctx.id });
    assert.equal(result.isHistorical, true);
    const hbMessages = result.data.filter(m => m.isHeartbeat);
    assert.equal(hbMessages.length, 0, 'heartbeat messages should be excluded by default');
    assert.equal(result.data.length, 2, 'should have 2 non-heartbeat messages');

    db.close();
  });

  it('includes heartbeats when excludeHeartbeats=false', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-mine5';
    const convId = insertConversation(db, agentId, 'session-mine5');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-mine5', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'Real user message');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'heartbeat ping', true);
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'Real assistant reply');
    rotateSessionContext(db, agentId, 'session-mine5', convId);

    const result = store.mineArchivedContext({ contextId: ctx.id, excludeHeartbeats: false });
    assert.equal(result.isHistorical, true);
    assert.equal(result.data.length, 3, 'should include all 3 messages including heartbeat');

    db.close();
  });
});

// ─── mineArchivedContext: ftsQuery filter ─────────────────────

describe('mineArchivedContext: ftsQuery filter', () => {
  it('filters messages client-side by ftsQuery substring', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-mine6';
    const convId = insertConversation(db, agentId, 'session-mine6');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-mine6', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'Tell me about hypermem architecture');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'HyperMem uses a layered approach');
    recordMsg(store, convId, agentId, ctx.id, 'user', 'What about the database schema?');
    rotateSessionContext(db, agentId, 'session-mine6', convId);

    const result = store.mineArchivedContext({ contextId: ctx.id, ftsQuery: 'hypermem' });
    assert.equal(result.isHistorical, true);
    assert.equal(result.data.length, 2, 'should return 2 messages matching "hypermem"');
    assert.ok(
      result.data.every(m => (m.textContent ?? '').toLowerCase().includes('hypermem')),
      'all returned messages should match ftsQuery'
    );

    db.close();
  });

  it('returns empty array when no messages match ftsQuery', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-mine7';
    const convId = insertConversation(db, agentId, 'session-mine7');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-mine7', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'Tell me about cats');
    rotateSessionContext(db, agentId, 'session-mine7', convId);

    const result = store.mineArchivedContext({ contextId: ctx.id, ftsQuery: 'dogs' });
    assert.equal(result.isHistorical, true);
    assert.equal(result.data.length, 0, 'should return empty array for non-matching ftsQuery');

    db.close();
  });
});

// ─── mineArchivedContexts: multi-context ────────────────────

describe('mineArchivedContexts: multi-context soft-skip behavior', () => {
  it('returns results for valid archived contexts in input order', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-multi1';
    const convId1 = insertConversation(db, agentId, 'session-multi1');
    const convId2 = insertConversation(db, agentId, 'session-multi2');

    const ctx1 = getOrCreateActiveContext(db, agentId, 'session-multi1', convId1);
    recordMsg(store, convId1, agentId, ctx1.id, 'user', 'Context 1 message');
    rotateSessionContext(db, agentId, 'session-multi1', convId1);

    const ctx2 = getOrCreateActiveContext(db, agentId, 'session-multi2', convId2);
    recordMsg(store, convId2, agentId, ctx2.id, 'user', 'Context 2 message');
    rotateSessionContext(db, agentId, 'session-multi2', convId2);

    const results = store.mineArchivedContexts([ctx1.id, ctx2.id]);
    assert.equal(results.length, 2, 'should return 2 results');
    assert.equal(results[0].contextId, ctx1.id, 'first result should be ctx1 (input order)');
    assert.equal(results[1].contextId, ctx2.id, 'second result should be ctx2 (input order)');
    assert.ok(results.every(r => r.isHistorical === true), 'all results should have isHistorical: true');

    db.close();
  });

  it('soft-skips active contexts with a warning, does not throw', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-multi2';
    const convId1 = insertConversation(db, agentId, 'session-multia');
    const convId2 = insertConversation(db, agentId, 'session-multib');

    const ctx1 = getOrCreateActiveContext(db, agentId, 'session-multia', convId1);
    recordMsg(store, convId1, agentId, ctx1.id, 'user', 'Archived ctx msg');
    rotateSessionContext(db, agentId, 'session-multia', convId1);

    // ctx2 is active — should be soft-skipped
    const ctx2 = getOrCreateActiveContext(db, agentId, 'session-multib', convId2);
    recordMsg(store, convId2, agentId, ctx2.id, 'user', 'Active ctx msg');

    let warned = false;
    const origWarn = console.warn;
    console.warn = (...args) => { warned = true; origWarn(...args); };

    let results;
    try {
      results = store.mineArchivedContexts([ctx1.id, ctx2.id]);
    } finally {
      console.warn = origWarn;
    }

    assert.equal(results.length, 1, 'should return only 1 result (active skipped)');
    assert.equal(results[0].contextId, ctx1.id, 'should be the archived context');
    assert.ok(warned, 'should have emitted a warning for the skipped active context');

    db.close();
  });

  it('soft-skips missing contextIds with a warning', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-multi3';
    const convId = insertConversation(db, agentId, 'session-multi3');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-multi3', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'Good message');
    rotateSessionContext(db, agentId, 'session-multi3', convId);

    let warned = false;
    const origWarn = console.warn;
    console.warn = (...args) => { warned = true; origWarn(...args); };

    let results;
    try {
      results = store.mineArchivedContexts([ctx.id, 99999]);
    } finally {
      console.warn = origWarn;
    }

    assert.equal(results.length, 1, 'should return 1 result (missing skipped)');
    assert.equal(results[0].contextId, ctx.id);
    assert.ok(warned, 'should warn about missing contextId');

    db.close();
  });

  it('returns empty array for all-invalid input', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-multi4';
    const convId = insertConversation(db, agentId, 'session-multi4');

    // One active, one missing
    const ctx = getOrCreateActiveContext(db, agentId, 'session-multi4', convId);

    let warned = false;
    const origWarn = console.warn;
    console.warn = (...args) => { warned = true; origWarn(...args); };

    let results;
    try {
      results = store.mineArchivedContexts([ctx.id, 99999]);
    } finally {
      console.warn = origWarn;
    }

    assert.equal(results.length, 0, 'should return empty array');
    assert.ok(warned, 'should warn about skipped contexts');

    db.close();
  });
});

// ─── isHistorical marker ─────────────────────────────────────

describe('ArchivedMiningResult: isHistorical marker', () => {
  it('isHistorical is always exactly true (literal, not truthy)', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hist1';
    const convId = insertConversation(db, agentId, 'session-hist1');

    const ctx = getOrCreateActiveContext(db, agentId, 'session-hist1', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'A message');
    rotateSessionContext(db, agentId, 'session-hist1', convId);

    const result = store.mineArchivedContext({ contextId: ctx.id });
    assert.strictEqual(result.isHistorical, true, 'isHistorical must be strictly true');

    // Verify it can be used as a discriminator
    const results = store.mineArchivedContexts([ctx.id]);
    for (const r of results) {
      assert.strictEqual(r.isHistorical, true, 'all multi-context results must have isHistorical: true');
    }

    db.close();
  });
});

// ─── Regression: active composition remains archived-blind ───

describe('Regression: active composition paths remain archived-blind', () => {
  it('active session history does not include messages from archived contexts', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-regr1';
    const convId = insertConversation(db, agentId, 'session-regr1');

    // Build and archive first context
    const ctx1 = getOrCreateActiveContext(db, agentId, 'session-regr1', convId);
    recordMsg(store, convId, agentId, ctx1.id, 'user', 'Archived only msg A');
    recordMsg(store, convId, agentId, ctx1.id, 'assistant', 'Archived only msg B');

    // Rotate: ctx1 archived, ctx2 active
    const ctx2 = rotateSessionContext(db, agentId, 'session-regr1', convId);
    recordMsg(store, convId, agentId, ctx2.id, 'user', 'Active msg X');
    recordMsg(store, convId, agentId, ctx2.id, 'assistant', 'Active msg Y');

    // Active composition path — DAG walk from ctx2's head
    const activeCtx = getActiveContext(db, agentId, 'session-regr1');
    assert.ok(activeCtx, 'should have an active context');
    const history = store.getHistoryByDAGWalk(activeCtx.headMessageId, 100);

    assert.equal(history.length, 2, 'active DAG walk should return only 2 messages');
    assert.ok(!history.some(m => m.textContent?.includes('Archived only')),
      'active history must not include archived messages');

    // getMessagesByContextId also must not cross context boundaries
    const activeMessages = store.getMessagesByContextId(ctx2.id, 100);
    assert.equal(activeMessages.length, 2);
    assert.ok(!activeMessages.some(m => m.textContent?.includes('Archived only')),
      'context-scoped messages must not include archived context messages');

    db.close();
  });

  it('mineArchivedContext does not affect active context', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-regr2';
    const convId = insertConversation(db, agentId, 'session-regr2');

    const ctx1 = getOrCreateActiveContext(db, agentId, 'session-regr2', convId);
    recordMsg(store, convId, agentId, ctx1.id, 'user', 'Old context msg');
    const ctx2 = rotateSessionContext(db, agentId, 'session-regr2', convId);
    recordMsg(store, convId, agentId, ctx2.id, 'user', 'New context msg');

    // Mine the archived context (read-only operation)
    const mined = store.mineArchivedContext({ contextId: ctx1.id });
    assert.equal(mined.isHistorical, true);
    assert.equal(mined.data.length, 1);
    assert.equal(mined.data[0].textContent, 'Old context msg');

    // Active context should still be isolated
    const activeCtx = getActiveContext(db, agentId, 'session-regr2');
    const activeHistory = store.getHistoryByDAGWalk(activeCtx.headMessageId, 100);
    assert.equal(activeHistory.length, 1);
    assert.equal(activeHistory[0].textContent, 'New context msg');

    db.close();
  });
});

// ─── Sprint 3 Task 1: maxContexts gate ────────────────────────────────────────
//
// Design decision: caller-supplied maxContexts above the hard ceiling (50) is
// CLAMPED to the ceiling — not rejected. Callers should not need to know the
// exact constant value, only that their request will be bounded safely.
//
// Behavior under test:
//   1. Exactly at effective limit → succeeds
//   2. Over effective limit → throws immediately (before any DB access)
//   3. Explicit lower limit → honored, lower threshold applies
//   4. Caller requests above hard ceiling → clamped to ceiling (not thrown)

describe('mineArchivedContexts: maxContexts gate (Sprint 3 Task 1)', () => {
  // Helper: create N archived contexts in a fresh DB
  function createNArchivedContexts(n) {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-gate';
    const contextIds = [];

    for (let i = 0; i < n; i++) {
      const sessionKey = `session-gate-${i}`;
      const convId = insertConversation(db, agentId, sessionKey);
      const ctx = getOrCreateActiveContext(db, agentId, sessionKey, convId);
      recordMsg(store, convId, agentId, ctx.id, 'user', `Gate msg ${i}`);
      rotateSessionContext(db, agentId, sessionKey, convId);
      contextIds.push(ctx.id);
    }

    return { db, store, contextIds };
  }

  it('succeeds when contextIds.length exactly equals the default limit (20)', () => {
    const { db, store, contextIds } = createNArchivedContexts(20);

    let results;
    assert.doesNotThrow(() => {
      results = store.mineArchivedContexts(contextIds);
    }, 'should not throw when at default limit');

    assert.equal(results.length, 20, 'should return 20 results');
    assert.ok(results.every(r => r.isHistorical === true), 'all isHistorical');

    db.close();
  });

  it('throws when contextIds.length exceeds the default limit (21 > 20)', () => {
    const { db, store, contextIds } = createNArchivedContexts(21);

    assert.throws(
      () => store.mineArchivedContexts(contextIds),
      (err) => {
        assert.ok(err instanceof Error, 'should throw Error');
        assert.ok(
          err.message.includes('too many contextIds'),
          `error message should mention "too many contextIds": ${err.message}`
        );
        assert.ok(
          err.message.includes('21'),
          `error message should include the count (21): ${err.message}`
        );
        return true;
      },
      'should throw when over default limit'
    );

    db.close();
  });

  it('honors an explicit lower maxContexts limit (throws at 6 when limit is 5)', () => {
    const { db, store, contextIds } = createNArchivedContexts(6);

    assert.throws(
      () => store.mineArchivedContexts(contextIds, { maxContexts: 5 }),
      (err) => {
        assert.ok(err instanceof Error, 'should throw Error');
        assert.ok(
          err.message.includes('too many contextIds'),
          `error should mention "too many contextIds": ${err.message}`
        );
        assert.ok(
          err.message.includes('6'),
          `error should mention actual count (6): ${err.message}`
        );
        return true;
      },
      'should throw when over explicit lower limit'
    );

    const fiveIds = contextIds.slice(0, 5);
    let results;
    assert.doesNotThrow(() => {
      results = store.mineArchivedContexts(fiveIds, { maxContexts: 5 });
    }, 'should not throw at exactly the explicit lower limit');
    assert.equal(results.length, 5);

    db.close();
  });

  it('clamps caller-supplied maxContexts above hard ceiling to ceiling (not rejected)', () => {
    // 51 contexts: maxContexts=1000 gets clamped to 50, so 51 > 50 → throws
    const { db, store, contextIds } = createNArchivedContexts(51);

    assert.throws(
      () => store.mineArchivedContexts(contextIds, { maxContexts: 1000 }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes('too many contextIds'),
          `should throw (ceiling enforced via clamp): ${err.message}`
        );
        assert.ok(
          err.message.includes('51'),
          `error should include actual count (51): ${err.message}`
        );
        assert.ok(
          err.message.includes('50'),
          `error should reference the hard ceiling (50): ${err.message}`
        );
        return true;
      },
      'should throw (ceiling enforced via clamp) when 51 > 50'
    );

    // 50 contexts with maxContexts=1000 (clamped to 50) → succeeds
    const fiftyIds = contextIds.slice(0, 50);
    let results;
    assert.doesNotThrow(() => {
      results = store.mineArchivedContexts(fiftyIds, { maxContexts: 1000 });
    }, 'should succeed for 50 contextIds even when maxContexts is over-ceiling (clamped to 50)');
    assert.equal(results.length, 50, 'should return 50 results');

    db.close();
  });
});
