/**
 * History Query Surface Tests (HyperMem 0.9.4)
 *
 * Covers:
 *   - runtime_chain: preserves tool-bearing rows
 *   - transcript_tail: excludes null/blank carrier rows
 *   - tool_events: returns tool rows, does not pollute transcript
 *   - tool_events: redacts payloads by default, exposes when explicit
 *   - cross_session: excludes below-fence messages from source conversations
 *   - by_context: does not leak sibling branch/context rows
 *   - by_context: rejects archived/forked without includeArchived
 *   - by_topic: returns topic-scoped rows
 *   - excessive limits clamp to hard cap
 *   - unknown mode throws
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  ensureContextSchema,
  getOrCreateActiveContext,
  archiveContext,
  rotateSessionContext,
} from '../dist/context-store.js';
import { MessageStore } from '../dist/message-store.js';
import { migrate } from '../dist/schema.js';
import { ensureCompactionFenceSchema, updateCompactionFence } from '../dist/compaction-fence.js';

// ─── Test helpers ─────────────────────────────────────────────────

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  ensureContextSchema(db);
  ensureCompactionFenceSchema(db);
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

function recordMsg(store, convId, agentId, ctxId, role, text, opts = {}) {
  return store.recordMessage(convId, agentId, {
    role,
    textContent: text,
    toolCalls: opts.toolCalls ?? null,
    toolResults: opts.toolResults ?? null,
    topicId: opts.topicId ?? undefined,
    metadata: null,
  }, { contextId: ctxId, isHeartbeat: opts.isHeartbeat ?? false });
}

// ─── runtime_chain: preserves tool-bearing rows ───────────────────

describe('queryHistory: runtime_chain', () => {
  it('returns messages including tool-bearing rows', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-1';
    const convId = insertConversation(db, agentId, 'sk-hq-1');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-hq-1', convId);

    recordMsg(store, convId, agentId, ctx.id, 'user', 'Hello');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', null, {
      toolCalls: [{ id: 'hm_001', name: 'read_file', arguments: '{"path":"/foo"}' }],
    });
    recordMsg(store, convId, agentId, ctx.id, 'user', null, {
      toolResults: [{ callId: 'hm_001', name: 'read_file', content: 'file content' }],
    });
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'Done reading');

    const result = store.queryHistory({
      agentId,
      sessionKey: 'sk-hq-1',
      mode: 'runtime_chain',
    });

    assert.equal(result.mode, 'runtime_chain');
    assert.ok(result.messages.length >= 4, `expected >= 4 messages, got ${result.messages.length}`);

    // Verify tool-bearing rows are preserved
    const toolCallRow = result.messages.find(m => m.toolCalls != null);
    assert.ok(toolCallRow, 'runtime_chain should include tool_calls rows');

    const toolResultRow = result.messages.find(m => m.toolResults != null);
    assert.ok(toolResultRow, 'runtime_chain should include tool_results rows');

    assert.equal(result.redacted, false, 'runtime_chain does not redact');
  });

  it('throws when neither sessionKey nor conversationId provided', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    assert.throws(
      () => store.queryHistory({ agentId: 'x', mode: 'runtime_chain' }),
      /requires sessionKey or conversationId/
    );
  });

  it('falls back to recency when no active context exists', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-fallback';
    const convId = insertConversation(db, agentId, 'sk-hq-fallback');
    // No context — insert messages directly without context
    store.recordMessage(convId, agentId, { role: 'user', textContent: 'fallback msg', toolCalls: null, toolResults: null });
    store.recordMessage(convId, agentId, { role: 'assistant', textContent: 'ok', toolCalls: null, toolResults: null });

    const result = store.queryHistory({ agentId, conversationId: convId, mode: 'runtime_chain' });
    assert.ok(result.messages.length >= 2);
  });

  it('rejects direct conversationId queries for another agent', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const convId = insertConversation(db, 'agent-hq-owner', 'sk-hq-owner');

    assert.throws(
      () => store.queryHistory({ agentId: 'agent-hq-intruder', conversationId: convId, mode: 'runtime_chain' }),
      /not owned by agent/
    );
  });
});

// ─── transcript_tail: excludes null/blank carrier rows ───────────────

describe('queryHistory: transcript_tail', () => {
  it('excludes tool-carrier rows with null/blank text', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-2';
    const convId = insertConversation(db, agentId, 'sk-hq-2');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-hq-2', convId);

    recordMsg(store, convId, agentId, ctx.id, 'user', 'Hello transcript');
    // Tool-call row with null text — should be excluded
    recordMsg(store, convId, agentId, ctx.id, 'assistant', null, {
      toolCalls: [{ id: 'hm_002', name: 'list_files', arguments: '{}' }],
    });
    // Tool-result row with null text — should be excluded
    recordMsg(store, convId, agentId, ctx.id, 'user', null, {
      toolResults: [{ callId: 'hm_002', name: 'list_files', content: '[a, b]' }],
    });
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'Here is the summary');

    const result = store.queryHistory({
      agentId,
      sessionKey: 'sk-hq-2',
      mode: 'transcript_tail',
    });

    assert.equal(result.mode, 'transcript_tail');
    // Only text-bearing user/assistant rows should appear
    for (const msg of result.messages) {
      assert.ok(
        msg.textContent != null && msg.textContent.trim() !== '',
        `transcript_tail should only return rows with non-empty text: got role=${msg.role} text=${JSON.stringify(msg.textContent)}`
      );
      // Tool fields must be null in this mode (projection nulls them)
      assert.equal(msg.toolCalls, null, 'transcript_tail must not include toolCalls');
      assert.equal(msg.toolResults, null, 'transcript_tail must not include toolResults');
    }

    const roles = result.messages.map(m => m.role);
    assert.ok(roles.includes('user'), 'should include user turns');
    assert.ok(roles.includes('assistant'), 'should include assistant turns');
    assert.equal(result.redacted, false);
  });

  it('throws when neither sessionKey nor conversationId provided', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    assert.throws(
      () => store.queryHistory({ agentId: 'x', mode: 'transcript_tail' }),
      /requires sessionKey or conversationId/
    );
  });
});

// ─── tool_events: returns tool rows, does not pollute transcript ──────

describe('queryHistory: tool_events', () => {
  it('returns only tool-bearing rows', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-3';
    const convId = insertConversation(db, agentId, 'sk-hq-3');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-hq-3', convId);

    recordMsg(store, convId, agentId, ctx.id, 'user', 'Pure text user');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'Pure text assistant');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'With tool call', {
      toolCalls: [{ id: 'hm_003', name: 'bash', arguments: '{"cmd":"ls"}' }],
    });
    recordMsg(store, convId, agentId, ctx.id, 'user', null, {
      toolResults: [{ callId: 'hm_003', name: 'bash', content: 'file1.ts\nfile2.ts' }],
    });

    const result = store.queryHistory({
      agentId,
      sessionKey: 'sk-hq-3',
      mode: 'tool_events',
    });

    assert.equal(result.mode, 'tool_events');
    // Every returned row must have toolCalls or toolResults
    for (const msg of result.messages) {
      const hasTool = (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) ||
                      (Array.isArray(msg.toolResults) && msg.toolResults.length > 0);
      assert.ok(hasTool, `tool_events row must have tool_calls or tool_results: role=${msg.role}`);
    }

    // Pure text rows must not appear in tool_events
    const textOnlyRows = result.messages.filter(m =>
      m.textContent != null && m.toolCalls == null && m.toolResults == null
    );
    assert.equal(textOnlyRows.length, 0, 'tool_events must not include pure-text rows');
  });

  it('redacts tool payloads by default', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-4';
    const convId = insertConversation(db, agentId, 'sk-hq-4');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-hq-4', convId);

    recordMsg(store, convId, agentId, ctx.id, 'assistant', null, {
      toolCalls: [{ id: 'hm_004', name: 'get_secret', arguments: '{"key":"API_TOKEN"}' }],
    });
    recordMsg(store, convId, agentId, ctx.id, 'user', null, {
      toolResults: [{ callId: 'hm_004', name: 'get_secret', content: 'sk-supersecret-value' }],
    });

    const result = store.queryHistory({
      agentId,
      sessionKey: 'sk-hq-4',
      mode: 'tool_events',
      // no includeToolPayloads — default is redact
    });

    assert.equal(result.redacted, true, 'redacted must be true by default');

    for (const msg of result.messages) {
      if (Array.isArray(msg.toolCalls)) {
        for (const tc of msg.toolCalls) {
          assert.equal(tc.arguments, '[redacted]', 'tool call arguments must be redacted');
          assert.ok(tc.name, 'tool call name must be preserved');
        }
      }
      if (Array.isArray(msg.toolResults)) {
        for (const tr of msg.toolResults) {
          assert.equal(tr.content, '[redacted]', 'tool result content must be redacted');
          assert.ok(tr.name, 'tool result name must be preserved');
        }
      }
    }
  });

  it('includes tool payloads when includeToolPayloads is true', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-5';
    const convId = insertConversation(db, agentId, 'sk-hq-5');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-hq-5', convId);

    recordMsg(store, convId, agentId, ctx.id, 'assistant', null, {
      toolCalls: [{ id: 'hm_005', name: 'bash', arguments: '{"cmd":"echo hi"}' }],
    });

    const result = store.queryHistory({
      agentId,
      sessionKey: 'sk-hq-5',
      mode: 'tool_events',
      includeToolPayloads: true,
    });

    assert.equal(result.redacted, false, 'redacted must be false when includeToolPayloads is true');

    const tc = result.messages.find(m => Array.isArray(m.toolCalls) && m.toolCalls.length > 0);
    assert.ok(tc, 'should have a tool_calls row');
    assert.notEqual(tc.toolCalls[0].arguments, '[redacted]', 'arguments should not be redacted');
    assert.ok(tc.toolCalls[0].arguments.includes('echo'), 'original arguments should be present');
  });

  it('throws when neither sessionKey nor conversationId provided', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    assert.throws(
      () => store.queryHistory({ agentId: 'x', mode: 'tool_events' }),
      /requires sessionKey or conversationId/
    );
  });
});

// ─── cross_session: excludes below-fence messages ─────────────────────

describe('queryHistory: cross_session respects compaction fences', () => {
  it('excludes messages below the compaction fence for source conversations', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-cs';
    const convId = insertConversation(db, agentId, 'sk-cs-1');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-cs-1', convId);

    // Insert 5 messages
    const m1 = recordMsg(store, convId, agentId, ctx.id, 'user', 'message one');
    const m2 = recordMsg(store, convId, agentId, ctx.id, 'assistant', 'reply one');
    const m3 = recordMsg(store, convId, agentId, ctx.id, 'user', 'message two');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'reply two');
    recordMsg(store, convId, agentId, ctx.id, 'user', 'message three');

    // Set compaction fence at m3 — m1 and m2 should be excluded
    updateCompactionFence(db, convId, m3.id);

    const result = store.queryHistory({
      agentId,
      mode: 'cross_session',
    });

    assert.equal(result.mode, 'cross_session');
    const ids = result.messages.map(m => m.id);
    assert.ok(!ids.includes(m1.id), `m1 (id=${m1.id}) below fence should be excluded`);
    assert.ok(!ids.includes(m2.id), `m2 (id=${m2.id}) below fence should be excluded`);
    assert.ok(ids.includes(m3.id), `m3 (id=${m3.id}) at fence should be included`);
  });

  it('includes all messages when no fence is set', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-cs-nofence';
    const convId = insertConversation(db, agentId, 'sk-cs-nofence');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-cs-nofence', convId);

    recordMsg(store, convId, agentId, ctx.id, 'user', 'first');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'second');

    const result = store.queryHistory({ agentId, mode: 'cross_session' });
    assert.ok(result.messages.length >= 2, 'without fence all messages included');
  });

  it('cross_session returns only transcript rows (no tool-bearing rows)', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-cs-tools';
    const convId = insertConversation(db, agentId, 'sk-cs-tools');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-cs-tools', convId);

    recordMsg(store, convId, agentId, ctx.id, 'user', 'transcript row');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', null, {
      toolCalls: [{ id: 'hm_cs1', name: 'bash', arguments: '{}' }],
    });

    const result = store.queryHistory({ agentId, mode: 'cross_session' });
    // tool-carrying rows have null text_content and should be excluded
    for (const msg of result.messages) {
      assert.equal(msg.toolCalls, null, 'cross_session must not include tool_calls');
      assert.equal(msg.toolResults, null, 'cross_session must not include tool_results');
    }
  });
});

// ─── by_context: isolation and access control ─────────────────────────

describe('queryHistory: by_context', () => {
  it('does not leak messages from sibling contexts', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-bc';
    const convId = insertConversation(db, agentId, 'sk-bc-1');

    // Create two separate contexts for the same conversation
    const ctx1 = getOrCreateActiveContext(db, agentId, 'sk-bc-1', convId);
    recordMsg(store, convId, agentId, ctx1.id, 'user', 'context 1 message');
    recordMsg(store, convId, agentId, ctx1.id, 'assistant', 'context 1 reply');

    // Rotate to create a new context (ctx1 becomes archived, ctx2 is new active)
    rotateSessionContext(db, agentId, 'sk-bc-1', convId);
    const ctx2 = getOrCreateActiveContext(db, agentId, 'sk-bc-1', convId);
    recordMsg(store, convId, agentId, ctx2.id, 'user', 'context 2 message');
    recordMsg(store, convId, agentId, ctx2.id, 'assistant', 'context 2 reply');

    // Query only ctx2 (active)
    const result = store.queryHistory({
      agentId,
      contextId: ctx2.id,
      mode: 'by_context',
    });

    const texts = result.messages.map(m => m.textContent);
    assert.ok(texts.includes('context 2 message'), 'should include ctx2 messages');
    assert.ok(texts.includes('context 2 reply'), 'should include ctx2 replies');
    assert.ok(!texts.includes('context 1 message'), 'must not leak ctx1 messages');
    assert.ok(!texts.includes('context 1 reply'), 'must not leak ctx1 replies');
  });

  it('rejects archived context without includeArchived', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-bc2';
    const convId = insertConversation(db, agentId, 'sk-bc-2');

    const ctx = getOrCreateActiveContext(db, agentId, 'sk-bc-2', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'before archive');

    // Archive the context
    rotateSessionContext(db, agentId, 'sk-bc-2', convId);

    assert.throws(
      () => store.queryHistory({ agentId, contextId: ctx.id, mode: 'by_context' }),
      /includeArchived.*true|non-active contexts/
    );
  });

  it('allows archived context with includeArchived: true', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-bc3';
    const convId = insertConversation(db, agentId, 'sk-bc-3');

    const ctx = getOrCreateActiveContext(db, agentId, 'sk-bc-3', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'archived content');
    rotateSessionContext(db, agentId, 'sk-bc-3', convId);

    // Should not throw
    const result = store.queryHistory({
      agentId,
      contextId: ctx.id,
      mode: 'by_context',
      includeArchived: true,
    });

    assert.ok(result.messages.some(m => m.textContent === 'archived content'),
      'archived content should be accessible with includeArchived: true');
  });

  it('throws when contextId is missing', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    assert.throws(
      () => store.queryHistory({ agentId: 'x', mode: 'by_context' }),
      /requires contextId/
    );
  });

  it('throws when context does not exist', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    assert.throws(
      () => store.queryHistory({ agentId: 'x', contextId: 9999, mode: 'by_context' }),
      /not found/
    );
  });

  it('rejects context queries for another agent', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const ownerAgentId = 'agent-hq-context-owner';
    const convId = insertConversation(db, ownerAgentId, 'sk-context-owner');
    const ctx = getOrCreateActiveContext(db, ownerAgentId, 'sk-context-owner', convId);

    assert.throws(
      () => store.queryHistory({ agentId: 'agent-hq-context-intruder', contextId: ctx.id, mode: 'by_context' }),
      /not owned by agent/
    );
  });
});

// ─── by_topic ─────────────────────────────────────────────────────────

describe('queryHistory: by_topic', () => {
  it('returns messages scoped to the given topic', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-topic';
    const convId = insertConversation(db, agentId, 'sk-topic');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-topic', convId);

    recordMsg(store, convId, agentId, ctx.id, 'user', 'topic A message', { topicId: 'topic-a' });
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'topic A reply', { topicId: 'topic-a' });
    recordMsg(store, convId, agentId, ctx.id, 'user', 'topic B message', { topicId: 'topic-b' });
    // Legacy message with no topicId (should also be included per transition safety)
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'legacy no topic');

    const result = store.queryHistory({
      agentId,
      sessionKey: 'sk-topic',
      mode: 'by_topic',
      topicId: 'topic-a',
    });

    const texts = result.messages.map(m => m.textContent);
    assert.ok(texts.includes('topic A message'), 'topic-a messages included');
    assert.ok(texts.includes('topic A reply'), 'topic-a replies included');
    assert.ok(!texts.includes('topic B message'), 'topic-b messages excluded');
  });

  it('throws when topicId is missing', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const convId = insertConversation(db, 'x', 'sk-t');
    assert.throws(
      () => store.queryHistory({ agentId: 'x', conversationId: convId, mode: 'by_topic' }),
      /requires topicId/
    );
  });
});

// ─── Hard cap clamping ────────────────────────────────────────────────

describe('queryHistory: hard cap clamping', () => {
  it('clamps excessive limit for runtime_chain (hardCap=200)', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-cap';
    const convId = insertConversation(db, agentId, 'sk-cap');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-cap', convId);
    recordMsg(store, convId, agentId, ctx.id, 'user', 'cap test');

    // Requesting 999 should be clamped to 200
    const result = store.queryHistory({
      agentId,
      sessionKey: 'sk-cap',
      mode: 'runtime_chain',
      limit: 999,
    });

    // The result itself will have 1 message (only 1 inserted), but truncated should be true
    // because 999 > 200 (the hard cap)
    assert.equal(result.truncated, true, 'truncated must be true when limit exceeds hard cap');
  });

  it('clamps excessive limit for cross_session (hardCap=80)', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const result = store.queryHistory({
      agentId: 'agent-hq-cap2',
      mode: 'cross_session',
      limit: 500,
    });

    assert.equal(result.truncated, true, 'truncated must be true when limit exceeds hard cap');
  });

  it('clamps excessive limit for transcript_tail (hardCap=120)', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-cap3';
    const convId = insertConversation(db, agentId, 'sk-cap3');

    // With a valid conversationId, limit 999 > hardCap 120, so truncated must be true
    const result = store.queryHistory({
      agentId,
      conversationId: convId,
      mode: 'transcript_tail',
      limit: 999,
    });
    assert.equal(result.truncated, true, 'truncated must be true when limit exceeds hard cap');
  });

  it('defaults non-positive limits instead of passing SQLite unlimited LIMIT values', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-cap-negative';
    const convId = insertConversation(db, agentId, 'sk-cap-negative');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-cap-negative', convId);

    for (let i = 0; i < 90; i += 1) {
      recordMsg(store, convId, agentId, ctx.id, 'user', `negative cap row ${i}`);
    }

    const negative = store.queryHistory({
      agentId,
      conversationId: convId,
      mode: 'cross_session',
      limit: -1,
    });
    assert.equal(negative.messages.length, 20, 'limit -1 must default to cross_session default, not unlimited');
    assert.equal(negative.truncated, true, 'limit -1 should be marked sanitized/truncated');

    const zero = store.queryHistory({
      agentId,
      conversationId: convId,
      mode: 'cross_session',
      limit: 0,
    });
    assert.equal(zero.messages.length, 20, 'limit 0 must default to cross_session default, not unlimited/empty ambiguity');
    assert.equal(zero.truncated, true, 'limit 0 should be marked sanitized/truncated');
  });

  it('floors fractional positive limits before applying SQL LIMIT', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    const agentId = 'agent-hq-cap-fractional';
    const convId = insertConversation(db, agentId, 'sk-cap-fractional');
    const ctx = getOrCreateActiveContext(db, agentId, 'sk-cap-fractional', convId);

    recordMsg(store, convId, agentId, ctx.id, 'user', 'fractional one');
    recordMsg(store, convId, agentId, ctx.id, 'assistant', 'fractional two');

    const result = store.queryHistory({
      agentId,
      conversationId: convId,
      mode: 'transcript_tail',
      limit: 1.9,
    });
    assert.equal(result.messages.length, 1, 'fractional limit should floor to an integer');
  });

  it('HISTORY_QUERY_CAPS covers all modes', () => {
    const caps = MessageStore.HISTORY_QUERY_CAPS;
    const expectedModes = ['runtime_chain', 'transcript_tail', 'tool_events', 'by_topic', 'by_context', 'cross_session'];
    for (const mode of expectedModes) {
      assert.ok(caps[mode], `HISTORY_QUERY_CAPS missing entry for mode '${mode}'`);
      assert.ok(caps[mode].defaultLimit > 0, `defaultLimit for '${mode}' must be positive`);
      assert.ok(caps[mode].hardCap >= caps[mode].defaultLimit, `hardCap must be >= defaultLimit for '${mode}'`);
    }
  });
});

// ─── Mode allowlist / unknown mode rejection ──────────────────────────

describe('queryHistory: mode allowlist', () => {
  it('throws on unknown mode', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    assert.throws(
      () => store.queryHistory({ agentId: 'x', mode: 'sql_injection_attempt' }),
      /unknown mode/
    );
  });

  it('throws on empty string mode', () => {
    const db = createTestDb();
    const store = new MessageStore(db);
    assert.throws(
      () => store.queryHistory({ agentId: 'x', mode: '' }),
      /unknown mode/
    );
  });
});
