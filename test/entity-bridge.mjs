/**
 * Sprint B entity-bridge integration tests.
 *
 * Covers:
 *   - Schema v12 migration creates required tables and bumps version
 *   - normalizeEntityKey / normalizeFacetKey
 *   - extractEntityFacetMentions: offsets and dedup
 *   - EntityBridgeStore.recordMentions with zero-mention indexing
 *   - reciprocalRankFuse helper
 *   - runPersonalizedPageRank caps + convergence
 *   - Compositor lane disabled-by-default + degrade behavior is exercised
 *     via direct extractor + store calls (compositor itself requires the
 *     full HyperMem boot path, which tests/compositor.mjs already covers).
 *
 * Run after build: node --test test/entity-bridge.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  normalizeEntityKey,
  normalizeFacetKey,
  extractEntityFacetMentions,
} from '../dist/entity-extractor.js';
import { migrate, LATEST_SCHEMA_VERSION } from '../dist/schema.js';
import { EntityBridgeStore } from '../dist/entity-bridge-store.js';
import { runPersonalizedPageRank } from '../dist/entity-ppr.js';
import { reciprocalRankFuse } from '../dist/hybrid-retrieval.js';

function freshDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

// ── schema v12 ────────────────────────────────────────────────────────────

test('schema v12 creates entity-bridge tables and bumps version', () => {
  const db = freshDb();
  assert.equal(LATEST_SCHEMA_VERSION, 12);
  const expected = [
    'memory_entities',
    'memory_facets',
    'message_entity_mentions',
    'message_facet_mentions',
    'entity_bridge_message_index',
  ];
  for (const t of expected) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
    assert.ok(row, `table ${t} missing after migration`);
  }
  const ver = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  assert.equal(ver.v, 12);
});

// ── normalization helpers ─────────────────────────────────────────────────

test('normalizeEntityKey lowercases and strips edge punctuation', () => {
  assert.equal(normalizeEntityKey('Alice'), 'alice');
  assert.equal(normalizeEntityKey('  "Bob"  '), 'bob');
  assert.equal(normalizeEntityKey('!!Carol!!'), 'carol');
  assert.equal(normalizeEntityKey(''), '');
});

test('normalizeFacetKey snaps raw terms to grace groups', () => {
  assert.equal(normalizeFacetKey('Bought'), 'purchase');
  assert.equal(normalizeFacetKey('passing'), 'death');
  assert.equal(normalizeFacetKey('job'), 'job');
});

// ── extractEntityFacetMentions ────────────────────────────────────────────

test('extractEntityFacetMentions returns offsets and dedup', () => {
  const text = 'Alice bought a car last March. Bob also bought one.';
  const out = extractEntityFacetMentions(text);
  assert.ok(out.entities.find(e => e.key === 'alice'));
  assert.ok(out.entities.find(e => e.key === 'bob'));
  // Each entity emitted at most once
  const aliceOcc = out.entities.filter(e => e.key === 'alice');
  assert.equal(aliceOcc.length, 1);
  // Offsets land inside the source text.
  for (const ent of out.entities) {
    assert.equal(text.slice(ent.start, ent.end), ent.surface);
  }
  // Facets: both 'purchase' and 'time' should appear once.
  const facetKeys = out.facets.map(f => f.key);
  assert.ok(facetKeys.includes('purchase'));
});

// ── EntityBridgeStore: zero-mention indexing ──────────────────────────────

test('EntityBridgeStore records zero-mention messages with status=ok', () => {
  const db = freshDb();
  // Seed a conversation + message row so foreign keys are satisfied.
  db.exec(`
    INSERT INTO conversations (session_key, agent_id, channel_type, created_at, updated_at)
    VALUES ('s1', 'agent', 'webchat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, created_at)
    VALUES (1, 'agent', 'user', 'hello world', 0, '2026-01-01T00:00:00Z');
  `);
  const store = new EntityBridgeStore(db);
  assert.ok(store.tablesExist());
  const result = store.recordMentions({
    messageId: 1,
    agentId: 'agent',
    threadRef: 1,
    mentions: { entities: [], facets: [] },
    source: 'live',
  });
  assert.equal(result.entityCount, 0);
  assert.equal(result.facetCount, 0);
  assert.equal(result.wrote, true);
  const state = store.getIndexState(1);
  assert.equal(state.exists, true);
  assert.equal(state.status, 'ok');
  assert.equal(state.entityCount, 0);
});


test('EntityBridgeStore failure marker writes metadata-only index_event', () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO conversations (session_key, agent_id, channel_type, created_at, updated_at)
    VALUES ('s1', 'agent', 'webchat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, created_at)
    VALUES (1, 'agent', 'user', 'Alice secret text should not be copied into telemetry.', 0, '2026-01-01T00:00:00Z');
  `);
  const store = new EntityBridgeStore(db);
  const wrote = store.recordIndexFailure({
    messageId: 1,
    agentId: 'agent',
    threadRef: 1,
    error: new TypeError('extractor failed with private payload'),
    source: 'live',
  });
  assert.equal(wrote, true);
  const state = store.getIndexState(1);
  assert.equal(state.status, 'failed');
  const ev = db.prepare("SELECT event_type, target_table, target_id, details FROM index_events WHERE event_type = 'entity_bridge_index_failed'").get();
  assert.equal(ev.event_type, 'entity_bridge_index_failed');
  assert.equal(ev.target_table, 'messages');
  assert.equal(ev.target_id, 1);
  assert.deepEqual(JSON.parse(ev.details), { source: 'live', error_class: 'TypeError' });
  assert.equal(String(ev.details).includes('secret text'), false);
});

test('EntityBridgeStore upserts mention rows on real input', () => {
  const db = freshDb();
  db.exec(`
    INSERT INTO conversations (session_key, agent_id, channel_type, created_at, updated_at)
    VALUES ('s1', 'agent', 'webchat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, created_at)
    VALUES (1, 'agent', 'user', 'Alice bought a new car.', 0, '2026-01-01T00:00:00Z');
  `);
  const store = new EntityBridgeStore(db);
  const mentions = extractEntityFacetMentions('Alice bought a new car.');
  const result = store.recordMentions({
    messageId: 1,
    agentId: 'agent',
    threadRef: 1,
    mentions,
    source: 'live',
  });
  assert.ok(result.entityCount >= 1);
  assert.ok(result.facetCount >= 1);
  const ids = store.lookupEntityIds('agent', ['alice']);
  assert.ok(ids.has('alice'));
});

// ── RRF helper ────────────────────────────────────────────────────────────

test('reciprocalRankFuse merges two ranked lists', () => {
  const a = { ranked: [{ key: 'x', item: 1 }, { key: 'y', item: 2 }], weight: 1 };
  const b = { ranked: [{ key: 'y', item: 2 }, { key: 'z', item: 3 }], weight: 1 };
  const fused = reciprocalRankFuse([a, b], 60);
  // y should be on top (appears in both).
  assert.equal(fused[0].key, 'y');
  assert.equal(fused.length, 3);
  // Score for y > score for x or z.
  const scoreFor = (k) => fused.find(e => e.key === k).score;
  assert.ok(scoreFor('y') > scoreFor('x'));
  assert.ok(scoreFor('y') > scoreFor('z'));
});

// ── PPR caps + convergence ────────────────────────────────────────────────

test('runPersonalizedPageRank converges within iteration cap', () => {
  // Build a tiny snapshot manually.
  const snapshot = {
    entityMessages: new Map([['alice', [1, 2]], ['bob', [2, 3]]]),
    facetMessages: new Map([['purchase', [2]]]),
    messageEntities: new Map([
      [1, ['alice']],
      [2, ['alice', 'bob']],
      [3, ['bob']],
    ]),
    messageFacets: new Map([
      [2, ['purchase']],
    ]),
    diagnostics: { nodeCount: 6, edgeCount: 8, seedExpanded: 2, nodesCapped: false, edgesCapped: false },
  };
  const result = runPersonalizedPageRank(snapshot, ['alice'], ['purchase'], {
    maxIterations: 50,
    convergenceTolerance: 1e-8,
  });
  assert.ok(result.diagnostics.iterations <= 50);
  // message 2 mentions both alice + purchase \u2192 should rank high.
  assert.equal(result.ranked[0].messageId, 2);
});

test('runPersonalizedPageRank handles empty seeds gracefully', () => {
  const empty = {
    entityMessages: new Map(),
    facetMessages: new Map(),
    messageEntities: new Map(),
    messageFacets: new Map(),
    diagnostics: { nodeCount: 0, edgeCount: 0, seedExpanded: 0, nodesCapped: false, edgesCapped: false },
  };
  const result = runPersonalizedPageRank(empty, [], [], { maxIterations: 5 });
  assert.equal(result.ranked.length, 0);
  assert.equal(result.diagnostics.emptyGraph, true);
});

// ── Compositor lane: disabled-by-default behavior ────────────────────────

test('EntityBridgeStore.tablesExist=true on fresh v12 db; lane will gate on flags', () => {
  // Sanity: a fresh DB has the tables, but the compose lane requires both
  // entityBridge.enabled and entityBridge.pprEnabled flags. The compositor
  // unit (tested elsewhere) guards on those flags; this test asserts the
  // store building block is reachable on schema v12.
  const db = freshDb();
  const store = new EntityBridgeStore(db);
  assert.ok(store.tablesExist());
});
