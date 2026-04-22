import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { migrate, SCHEMA_VERSION } from '../dist/schema.js';
import { ensureContextSchema, getOrCreateActiveContext } from '../dist/context-store.js';
import {
  insertCompositionSnapshot,
  listCompositionSnapshots,
  verifyCompositionSnapshot,
  getLatestValidCompositionSnapshot,
} from '../dist/composition-snapshot-store.js';

function createDb() {
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

describe('composition snapshot store', () => {
  it('migrate creates the composition_snapshots table at the latest schema version', () => {
    const db = createDb();
    const table = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='composition_snapshots'"
    ).get();
    assert.equal(table.cnt, 1);

    const version = db.prepare('SELECT MAX(version) as version FROM schema_version').get();
    assert.equal(version.version, SCHEMA_VERSION);
  });

  it('writes canonical slots_json, stamps inline hashes, and verifies it on read', () => {
    const db = createDb();
    const convId = insertConversation(db, 'forge', 'agent:forge:webchat:test');
    const ctx = getOrCreateActiveContext(db, 'forge', 'agent:forge:webchat:test', convId);

    const snapshot = insertCompositionSnapshot(db, {
      contextId: ctx.id,
      model: 'claude-opus-4-6',
      contextWindow: 200000,
      totalTokens: 82000,
      fillPct: 0.41,
      slots: {
        repair_notice: {
          kind: 'inline',
          content: {
            text: 'Repaired continuation from snapshot snap-1',
          },
          integrity_hash: 'will-be-replaced-by-store',
        },
      },
    });

    const verification = verifyCompositionSnapshot(snapshot);
    assert.equal(verification.ok, true);
    assert.equal(typeof snapshot.slotsIntegrityHash, 'string');
    assert.match(snapshot.slotsIntegrityHash, /^[a-f0-9]{64}$/);
    assert.match(snapshot.slotsJson, /"integrity_hash":"[a-f0-9]{64}"/);
  });

  it('retains only the newest two snapshots per context', () => {
    const db = createDb();
    const convId = insertConversation(db, 'forge', 'agent:forge:webchat:retention');
    const ctx = getOrCreateActiveContext(db, 'forge', 'agent:forge:webchat:retention', convId);

    insertCompositionSnapshot(db, {
      contextId: ctx.id,
      model: 'm1',
      contextWindow: 1000,
      totalTokens: 100,
      fillPct: 0.1,
      capturedAt: '2026-04-22T10:00:00.000Z',
      slots: { a: 1 },
    });
    insertCompositionSnapshot(db, {
      contextId: ctx.id,
      model: 'm2',
      contextWindow: 1000,
      totalTokens: 200,
      fillPct: 0.2,
      capturedAt: '2026-04-22T10:01:00.000Z',
      slots: { b: 2 },
    });
    insertCompositionSnapshot(db, {
      contextId: ctx.id,
      model: 'm3',
      contextWindow: 1000,
      totalTokens: 300,
      fillPct: 0.3,
      capturedAt: '2026-04-22T10:02:00.000Z',
      slots: { c: 3 },
    });

    const snapshots = listCompositionSnapshots(db, ctx.id, 10);
    assert.equal(snapshots.length, 2);
    assert.deepEqual(snapshots.map(s => s.model), ['m3', 'm2']);
  });

  it('falls back to the previous snapshot when the latest one is tampered', () => {
    const db = createDb();
    const convId = insertConversation(db, 'forge', 'agent:forge:webchat:fallback');
    const ctx = getOrCreateActiveContext(db, 'forge', 'agent:forge:webchat:fallback', convId);

    insertCompositionSnapshot(db, {
      contextId: ctx.id,
      model: 'm1',
      contextWindow: 1000,
      totalTokens: 100,
      fillPct: 0.1,
      capturedAt: '2026-04-22T10:00:00.000Z',
      slots: { stable_prefix: { source: 'hydrated', refs: ['identity'] } },
    });
    const latest = insertCompositionSnapshot(db, {
      contextId: ctx.id,
      model: 'm2',
      contextWindow: 1000,
      totalTokens: 110,
      fillPct: 0.11,
      capturedAt: '2026-04-22T10:01:00.000Z',
      slots: { stable_prefix: { source: 'hydrated', refs: ['identity', 'policy'] } },
    });

    db.prepare('UPDATE composition_snapshots SET slots_json = ? WHERE id = ?')
      .run('{"stable_prefix":{"source":"hydrated","refs":["tampered"]}}', latest.id);

    const resolved = getLatestValidCompositionSnapshot(db, ctx.id);
    assert.ok(resolved);
    assert.equal(resolved.snapshot.model, 'm1');
    assert.equal(resolved.fallbackUsed, true);
  });
});
