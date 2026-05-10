/**
 * Replay idempotency regression test.
 *
 * Gateway restart can restore an existing transcript into the runtime and feed
 * those turns back through recordUserMessage/recordAssistantMessage. The message
 * store must reject already-recorded recent turns instead of appending a second
 * identical batch to messages.db.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HyperMem } from '../dist/index.js';
import { isReplayDedupedMessage } from '../dist/message-store.js';

const testDir = path.join(os.tmpdir(), `hypermem-replay-dedupe-${Date.now()}`);
const agentId = 'replay-dedupe-agent';
const sessionKey = 'agent:replay-dedupe-agent:webchat:main';

function countMessages(hm) {
  const db = hm.dbManager.getMessageDb(agentId);
  return db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
}

try {
  fs.mkdirSync(testDir, { recursive: true });
  const hm = await HyperMem.create({ dataDir: testDir });

  const userText = 'Please review the restart replay idempotency guard for duplicate restored transcript turns.';
  const assistantText = 'The replay idempotency guard should suppress exact recent transcript duplicates without advancing message_index.';

  const firstUser = await hm.recordUserMessage(agentId, sessionKey, userText);
  const firstAssistant = await hm.recordAssistantMessage(agentId, sessionKey, {
    role: 'assistant',
    textContent: assistantText,
    toolCalls: null,
    toolResults: null,
  });

  assert.equal(countMessages(hm), 2, 'initial transcript has two rows');

  const replayedUser = await hm.recordUserMessage(agentId, sessionKey, userText);
  const replayedAssistant = await hm.recordAssistantMessage(agentId, sessionKey, {
    role: 'assistant',
    textContent: assistantText,
    toolCalls: null,
    toolResults: null,
  });

  assert.equal(countMessages(hm), 2, 'replayed transcript rows are not appended');
  assert.equal(replayedUser.id, firstUser.id, 'replayed user resolves to original row');
  assert.equal(replayedAssistant.id, firstAssistant.id, 'replayed assistant resolves to original row');
  assert.equal(isReplayDedupedMessage(replayedUser), true, 'user replay is marked for cache-skip');
  assert.equal(isReplayDedupedMessage(replayedAssistant), true, 'assistant replay is marked for cache-skip');

  const shortUser = await hm.recordUserMessage(agentId, sessionKey, 'ok');
  await hm.recordAssistantMessage(agentId, sessionKey, {
    role: 'assistant',
    textContent: 'Progress happened between the two short acknowledgements.',
    toolCalls: null,
    toolResults: null,
  });
  const repeatedShortUser = await hm.recordUserMessage(agentId, sessionKey, 'ok');

  assert.notEqual(repeatedShortUser.id, shortUser.id, 'short repeated text after progress is preserved');
  assert.equal(countMessages(hm), 5, 'legitimate short repeat is appended');

  const stampedOk = '[Sat 2026-05-09 18:49 MST] Ok';
  const firstStampedOk = await hm.recordUserMessage(agentId, sessionKey, stampedOk);
  await hm.recordAssistantMessage(agentId, sessionKey, {
    role: 'assistant',
    textContent: 'Progress happened after the stamped short acknowledgement.',
    toolCalls: null,
    toolResults: null,
  });
  const replayedStampedOk = await hm.recordUserMessage(agentId, sessionKey, stampedOk);

  assert.equal(replayedStampedOk.id, firstStampedOk.id, 'timestamp-stamped short replay resolves to original row');
  assert.equal(isReplayDedupedMessage(replayedStampedOk), true, 'timestamp-stamped short replay is marked for cache-skip');
  assert.equal(countMessages(hm), 7, 'timestamp-stamped short replay is not appended');

  console.log('✅ replay dedupe suppresses restored transcript batches, stamped short replays, and preserves unstamped short repeats after progress');
} finally {
  fs.rmSync(testDir, { recursive: true, force: true });
}
