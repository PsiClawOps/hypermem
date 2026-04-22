import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HyperMem } from '../dist/index.js';
import { Compositor } from '../dist/compositor.js';
import { getActiveContext, getOrCreateActiveContext } from '../dist/context-store.js';
import { insertCompositionSnapshot, listCompositionSnapshots } from '../dist/composition-snapshot-store.js';

async function createHarness() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-snapshot-runtime-'));
  const hm = await HyperMem.create({ dataDir });
  const agentId = 'forge';
  const sessionKey = `agent:${agentId}:webchat:test-${Math.random().toString(16).slice(2)}`;
  const msgDb = hm.dbManager.getMessageDb(agentId);
  const libDb = hm.dbManager.getLibraryDb();
  const compositor = new Compositor({ cache: hm.cache, vectorStore: null, libraryDb: libDb });

  const now = new Date().toISOString();
  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status, message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-test', ?, 'webchat', 'active', 0, 0, 0, ?, ?)
  `).run(sessionKey, agentId, now, now);

  const conv = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  const convId = conv.id;

  const messages = [
    { role: 'user', text: 'User asks for snapshot capture', idx: 1 },
    { role: 'assistant', text: 'Assistant replies with useful context', idx: 2 },
    { role: 'user', text: 'User follows up after the reply', idx: 3 },
  ];

  for (const message of messages) {
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(convId, agentId, message.role, message.text, message.idx, now);
  }

  return { hm, compositor, agentId, sessionKey, msgDb, libDb, convId, now };
}

describe('composition snapshot runtime wiring', () => {
  it('compose writes a snapshot row for the active context', async () => {
    const { compositor, agentId, sessionKey, msgDb, libDb } = await createHarness();

    await compositor.warmSession(agentId, sessionKey, msgDb, {
      systemPrompt: 'snapshot system prompt',
      identity: 'snapshot identity',
      libraryDb: libDb,
      model: 'claude-opus-4-6',
    });

    const result = await compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 12000,
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      includeHistory: true,
      includeFacts: false,
      includeContext: false,
      includeLibrary: false,
      includeSemanticRecall: false,
      includeDocChunks: false,
      skipProviderTranslation: true,
      skipWindowCache: true,
    }, msgDb, libDb);

    assert.ok(result.tokenCount > 0);

    const context = getActiveContext(msgDb, agentId, sessionKey);
    assert.ok(context, 'active context exists after compose');

    const snapshots = listCompositionSnapshots(msgDb, context.id, 10);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].snapshotKind, 'composed_window');
    assert.equal(snapshots[0].model, 'claude-opus-4-6');
    assert.ok(snapshots[0].totalTokens > 0);
    assert.match(snapshots[0].slotsJson, /"history"/);
    assert.match(snapshots[0].slotsJson, /"system"/);
    assert.match(snapshots[0].slotsJson, /"identity"/);
  });

  it('warmSession restores from the previous valid snapshot when the latest snapshot is tampered', async () => {
    const { hm, compositor, agentId, sessionKey, msgDb, libDb, convId, now } = await createHarness();
    const context = getOrCreateActiveContext(msgDb, agentId, sessionKey, convId);

    insertCompositionSnapshot(msgDb, {
      contextId: context.id,
      capturedAt: '2026-04-22T10:00:00.000Z',
      model: 'claude-opus-4-6',
      contextWindow: 200000,
      totalTokens: 8000,
      fillPct: 0.04,
      slots: {
        system: { kind: 'inline', content: 'restored system from snapshot' },
        identity: { kind: 'inline', content: 'restored identity from snapshot' },
        history: {
          kind: 'inline',
          content: [{
            id: 5001,
            conversationId: convId,
            agentId,
            role: 'user',
            textContent: 'history restored from previous valid snapshot',
            toolCalls: null,
            toolResults: null,
            metadata: { origin: 'snapshot-prev' },
            messageIndex: 1,
            tokenCount: null,
            isHeartbeat: false,
            createdAt: now,
          }],
        },
      },
    });

    const latest = insertCompositionSnapshot(msgDb, {
      contextId: context.id,
      capturedAt: '2026-04-22T10:01:00.000Z',
      model: 'claude-opus-4-6',
      contextWindow: 200000,
      totalTokens: 8100,
      fillPct: 0.0405,
      slots: {
        system: { kind: 'inline', content: 'tampered system' },
        identity: { kind: 'inline', content: 'tampered identity' },
        history: {
          kind: 'inline',
          content: [{
            id: 5002,
            conversationId: convId,
            agentId,
            role: 'user',
            textContent: 'history from invalid latest snapshot',
            toolCalls: null,
            toolResults: null,
            metadata: { origin: 'snapshot-latest' },
            messageIndex: 2,
            tokenCount: null,
            isHeartbeat: false,
            createdAt: now,
          }],
        },
      },
    });

    msgDb.prepare('UPDATE composition_snapshots SET slots_json = ? WHERE id = ?')
      .run('{"history":{"kind":"inline","content":[{"role":"user","textContent":"tampered"}]}}', latest.id);

    await hm.cache.evictSession(agentId, sessionKey);
    await compositor.warmSession(agentId, sessionKey, msgDb, {
      systemPrompt: 'cold system fallback',
      identity: 'cold identity fallback',
      model: 'claude-opus-4-6',
    });

    const restoredSystem = await hm.cache.getSlot(agentId, sessionKey, 'system');
    const restoredIdentity = await hm.cache.getSlot(agentId, sessionKey, 'identity');
    const repairedNotice = await hm.cache.getSlot(agentId, sessionKey, 'repair_notice');
    const restoredHistory = await hm.cache.getHistory(agentId, sessionKey, 10);

    assert.equal(restoredSystem, 'restored system from snapshot');
    assert.equal(restoredIdentity, 'restored identity from snapshot');
    assert.match(repairedNotice ?? '', /Repair notice: this session is a repaired continuation/);
    assert.equal(restoredHistory.length, 1);
    assert.equal(restoredHistory[0].textContent, 'history restored from previous valid snapshot');
    assert.equal(restoredHistory[0].metadata._warmed, true);

    const repairedResult = await compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 12000,
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      includeHistory: true,
      includeFacts: false,
      includeContext: false,
      includeLibrary: false,
      includeSemanticRecall: false,
      includeDocChunks: false,
      skipProviderTranslation: true,
      skipWindowCache: true,
    }, msgDb, libDb);

    assert.ok(repairedResult.tokenCount > 0);
    const repairedSnapshots = listCompositionSnapshots(msgDb, context.id, 10);
    assert.equal(repairedSnapshots[0].repairDepth, 1);
    assert.match(repairedSnapshots[0].slotsJson, /"repair_notice"/);
  });

  it('warmSession falls back to cold rewarm when no valid snapshot is usable', async () => {
    const { hm, compositor, agentId, sessionKey, msgDb, convId } = await createHarness();
    const context = getOrCreateActiveContext(msgDb, agentId, sessionKey, convId);

    const broken = insertCompositionSnapshot(msgDb, {
      contextId: context.id,
      capturedAt: '2026-04-22T10:02:00.000Z',
      model: 'claude-opus-4-6',
      contextWindow: 200000,
      totalTokens: 8200,
      fillPct: 0.041,
      slots: {
        system: { kind: 'inline', content: 'broken snapshot system' },
        identity: { kind: 'inline', content: 'broken snapshot identity' },
        history: { kind: 'inline', content: [] },
      },
    });

    msgDb.prepare('UPDATE composition_snapshots SET slots_json = ? WHERE id = ?')
      .run('{"system":{"kind":"inline","content":"broken"}}', broken.id);

    await hm.cache.evictSession(agentId, sessionKey);
    await compositor.warmSession(agentId, sessionKey, msgDb, {
      systemPrompt: 'cold system fallback',
      identity: 'cold identity fallback',
      model: 'claude-opus-4-6',
    });

    const restoredSystem = await hm.cache.getSlot(agentId, sessionKey, 'system');
    const restoredIdentity = await hm.cache.getSlot(agentId, sessionKey, 'identity');
    const restoredHistory = await hm.cache.getHistory(agentId, sessionKey, 10);

    assert.equal(restoredSystem, 'cold system fallback');
    assert.equal(restoredIdentity, 'cold identity fallback');
    assert.ok(restoredHistory.some(message => message.textContent === 'User asks for snapshot capture'));
    assert.ok(restoredHistory.every(message => message.metadata?._warmed === true));
  });
});
