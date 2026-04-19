/**
 * Tool Artifact Store Tests (schema v9)
 *
 * Covers:
 *   1. put + get round-trip
 *   2. dedupe within (agentId, sessionKey) by content hash bumps ref_count
 *   3. dedupe does NOT collapse across sessions
 *   4. listByTurn preserves insertion order
 *   5. listByToolCall returns matches only
 *   6. touch updates last_used_at
 *   7. deleteOlderThan deletes stale rows and returns count
 *   8. ToolChainStub artifactId round-trips through format/parse
 *   9. ToolChainStub parses legacy (no-artifact) stubs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { ToolArtifactStore } from '../dist/tool-artifact-store.js';
import { formatToolChainStub, parseToolChainStub } from '../dist/degradation.js';
import { migrate } from '../dist/schema.js';

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

describe('ToolArtifactStore', () => {
  it('put + get round-trip', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);
    const rec = store.put({
      agentId: 'forge',
      sessionKey: 'agent:forge:webchat:main',
      toolName: 'exec',
      toolCallId: 'call_1',
      payload: 'lots of output ...',
    });
    assert.ok(rec.id.startsWith('art_'));
    assert.equal(rec.refCount, 1);
    assert.equal(rec.agentId, 'forge');
    assert.equal(rec.toolName, 'exec');
    assert.equal(rec.payload, 'lots of output ...');
    const got = store.get(rec.id);
    assert.ok(got);
    assert.equal(got.id, rec.id);
    assert.equal(got.payload, 'lots of output ...');
  });

  it('dedupes within a session and bumps ref_count', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);
    const a = store.put({
      agentId: 'forge',
      sessionKey: 'sk1',
      toolName: 'exec',
      payload: 'identical payload',
    });
    const b = store.put({
      agentId: 'forge',
      sessionKey: 'sk1',
      toolName: 'exec',
      payload: 'identical payload',
    });
    assert.equal(a.id, b.id);
    assert.equal(b.refCount, 2);
    assert.equal(store.count('forge', 'sk1'), 1);
  });

  it('does not dedupe across different sessions', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);
    const a = store.put({
      agentId: 'forge',
      sessionKey: 'sk1',
      toolName: 'exec',
      payload: 'same',
    });
    const b = store.put({
      agentId: 'forge',
      sessionKey: 'sk2',
      toolName: 'exec',
      payload: 'same',
    });
    assert.notEqual(a.id, b.id);
    assert.equal(store.count(), 2);
  });

  it('listByTurn preserves insertion order', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);
    const turnId = 'turn-xyz';
    const first = store.put({
      agentId: 'forge',
      sessionKey: 'sk',
      turnId,
      toolName: 'a',
      payload: 'first',
    });
    const second = store.put({
      agentId: 'forge',
      sessionKey: 'sk',
      turnId,
      toolName: 'b',
      payload: 'second',
    });
    const list = store.listByTurn('sk', turnId);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, first.id);
    assert.equal(list[1].id, second.id);
  });

  it('listByToolCall filters correctly', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);
    const r1 = store.put({
      agentId: 'forge',
      sessionKey: 'sk',
      toolCallId: 'call_keep',
      toolName: 'x',
      payload: 'a',
    });
    store.put({
      agentId: 'forge',
      sessionKey: 'sk',
      toolCallId: 'call_drop',
      toolName: 'y',
      payload: 'b',
    });
    const hits = store.listByToolCall('call_keep');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, r1.id);
  });

  it('touch updates last_used_at', async () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);
    const rec = store.put({
      agentId: 'forge',
      sessionKey: 'sk',
      toolName: 't',
      payload: 'p',
    });
    const before = rec.lastUsedAt;
    await new Promise(r => setTimeout(r, 5));
    store.touch(rec.id);
    const after = store.get(rec.id).lastUsedAt;
    assert.ok(after > before, `expected ${after} > ${before}`);
  });

  it('deleteOlderThan evicts stale rows', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);
    store.put({
      agentId: 'forge',
      sessionKey: 'sk',
      toolName: 't',
      payload: 'old',
    });
    // Backdate the row we just inserted.
    const backdated = '1999-01-01T00:00:00.000Z';
    db.prepare('UPDATE tool_artifacts SET last_used_at = ?').run(backdated);
    const deleted = store.deleteOlderThan('2000-01-01T00:00:00.000Z');
    assert.equal(deleted, 1);
    assert.equal(store.count(), 0);
  });
});

describe('ToolChainStub artifactId wiring', () => {
  it('round-trips artifactId through format/parse', () => {
    const stub = {
      name: 'exec',
      id: 'call_1',
      status: 'ejected',
      reason: 'wave_guard_pressure_high',
      summary: 'short summary',
      artifactId: 'art_deadbeef00',
    };
    const text = formatToolChainStub(stub);
    assert.ok(text.includes('artifact=art_deadbeef00'), `stub: ${text}`);
    const parsed = parseToolChainStub(text);
    assert.ok(parsed);
    assert.equal(parsed.artifactId, 'art_deadbeef00');
    assert.equal(parsed.reason, 'wave_guard_pressure_high');
  });

  it('parses legacy stubs without artifact field', () => {
    const legacy = '[tool:exec id=call_1 status=ejected reason=wave_guard_pressure_high summary=short]';
    const parsed = parseToolChainStub(legacy);
    assert.ok(parsed);
    assert.equal(parsed.artifactId, undefined);
    assert.equal(parsed.reason, 'wave_guard_pressure_high');
    assert.equal(parsed.summary, 'short');
  });

  it('format without artifactId omits the artifact field', () => {
    const text = formatToolChainStub({
      name: 'exec',
      id: 'call_1',
      status: 'ejected',
      reason: 'wave_guard_pressure_elevated',
      summary: 'short',
    });
    assert.ok(!text.includes('artifact='));
    const parsed = parseToolChainStub(text);
    assert.ok(parsed);
    assert.equal(parsed.artifactId, undefined);
  });
});
