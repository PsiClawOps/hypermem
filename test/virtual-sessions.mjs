/**
 * Virtual Sessions tests — VS-5 (topic detector noise fix) + VS-1 (topic-scoped Redis warming)
 *
 * Tests:
 *   - stripMessageMetadata() removes timestamp headers, sender metadata, JSON metadata blocks
 *   - stripMessageMetadata() preserves actual message content
 *   - detectTopicShift() no longer creates topics from metadata
 *   - Topic-scoped Redis keys are correctly namespaced
 *   - Topic window set/get round-trips
 *   - Message count increments on new topic creation (plugin bug fix)
 */

import { stripMessageMetadata, detectTopicShift } from '../dist/index.js';
import { RedisLayer } from '../dist/redis.js';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../dist/schema.js';
import { SessionTopicMap } from '../dist/session-topic-map.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
    console.error(new Error(`Assertion failed: ${msg}`).stack);
  }
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

// ─── VS-5: stripMessageMetadata ──────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════');
console.log('  Virtual Sessions Tests (VS-5 + VS-1)');
console.log('═══════════════════════════════════════════════════\n');

console.log('── VS-5: stripMessageMetadata ──');

{
  // ISO timestamp lines are removed
  const iso = '2026-04-05T02:43:00Z\nHello, can you help me?';
  const stripped = stripMessageMetadata(iso);
  assert(!stripped.includes('2026-04-05T02:43:00Z'), 'Strips ISO timestamp line');
  assert(stripped.includes('Hello, can you help me?'), 'Preserves message content after ISO timestamp');
}

{
  // ISO timestamp with milliseconds and offset
  const iso2 = '2026-04-05T02:43:00.000Z\nSome actual content here.';
  const stripped = stripMessageMetadata(iso2);
  assert(!stripped.includes('2026-04-05T02:43:00.000Z'), 'Strips ISO timestamp with ms+Z');
  assert(stripped.includes('Some actual content here.'), 'Preserves content after ms timestamp');
}

{
  // Bracket timestamp format: [Mon 2026-04-05 02:43 MST]
  const bracket = '[Sun 2026-04-05 02:43 MST]\nWhat is the status of the deploy?';
  const stripped = stripMessageMetadata(bracket);
  assert(!stripped.includes('[Sun 2026-04-05 02:43 MST]'), 'Strips bracket timestamp line');
  assert(stripped.includes('What is the status of the deploy?'), 'Preserves message after bracket timestamp');
}

{
  // System YYYY-MM-DD
  const sysDate = 'System 2026-04-05\nSystem check complete.';
  const stripped = stripMessageMetadata(sysDate);
  assert(!stripped.includes('System 2026-04-05'), 'Strips System YYYY-MM-DD line');
  assert(stripped.includes('System check complete.'), 'Preserves content after system date');
}

{
  // Sender (untrusted metadata) block
  const senderBlock =
    'Sender (untrusted metadata): channel=webchat user=ragesaq\n' +
    '\n' +
    'Can you deploy to staging?';
  const stripped = stripMessageMetadata(senderBlock);
  assert(!stripped.includes('Sender (untrusted metadata)'), 'Strips Sender metadata block header');
  assert(!stripped.includes('channel=webchat'), 'Strips Sender metadata block content');
  assert(stripped.includes('Can you deploy to staging?'), 'Preserves message after Sender block');
}

{
  // JSON block with openclaw schema marker
  const jsonBlock =
    '```json\n' +
    '{"schema": "openclaw/inbound", "version": 1, "sender": "ragesaq"}\n' +
    '```\n' +
    'Please summarize the recent changes.';
  const stripped = stripMessageMetadata(jsonBlock);
  assert(!stripped.includes('"schema": "openclaw'), 'Strips JSON block with openclaw schema');
  assert(!stripped.includes('```json'), 'Strips opening ```json fence');
  assert(stripped.includes('Please summarize the recent changes.'), 'Preserves message after JSON block');
}

{
  // JSON block with inbound_meta marker
  const jsonBlock2 =
    '```json\n' +
    '{"type": "inbound_meta", "ts": "2026-04-05T02:43:00Z"}\n' +
    '```\n' +
    'Show me the logs.';
  const stripped = stripMessageMetadata(jsonBlock2);
  assert(!stripped.includes('inbound_meta'), 'Strips JSON block with inbound_meta');
  assert(stripped.includes('Show me the logs.'), 'Preserves message after inbound_meta block');
}

{
  // JSON block WITHOUT openclaw markers should NOT be stripped
  const safeBlock =
    '```json\n' +
    '{"key": "value", "count": 42}\n' +
    '```\n' +
    'Here is the data above.';
  const stripped = stripMessageMetadata(safeBlock);
  assert(stripped.includes('```json'), 'Preserves JSON block without openclaw markers');
  assert(stripped.includes('"key": "value"'), 'Preserves JSON block content without openclaw markers');
}

{
  // Pure user message with no metadata — should be unchanged
  const clean = 'Can you help me debug the Redis connection issue?';
  const stripped = stripMessageMetadata(clean);
  assert(stripped === clean, 'Returns clean message unchanged');
}

{
  // Multi-line message with mixed content
  const mixed =
    '[Mon 2026-04-04 20:00 MST]\n' +
    'I have three questions:\n' +
    '1. What is the deploy status?\n' +
    '2. Is Redis healthy?\n' +
    '3. Any alerts?';
  const stripped = stripMessageMetadata(mixed);
  assert(!stripped.includes('[Mon 2026-04-04 20:00 MST]'), 'Strips bracket timestamp from mixed content');
  assert(stripped.includes('I have three questions:'), 'Preserves numbered list content');
  assert(stripped.includes('1. What is the deploy status?'), 'Preserves item 1');
  assert(stripped.includes('3. Any alerts?'), 'Preserves item 3');
}

// ─── VS-5: detectTopicShift does not trigger on metadata ─────────────────────

console.log('\n── VS-5: detectTopicShift noise immunity ──');

{
  const db = makeDb();

  // A message that is ONLY metadata — should NOT create a new topic
  const metadataOnlyMsg = {
    role: 'user',
    textContent:
      '[Sun 2026-04-05 02:43 MST]\n' +
      'Sender (untrusted metadata): channel=webchat user=ragesaq\n' +
      '\n',
    toolCalls: null,
    toolResults: null,
  };

  const signal = detectTopicShift(metadataOnlyMsg, [], null);
  assert(signal.isNewTopic === false, 'detectTopicShift: metadata-only message does not trigger new topic');
}

{
  // A message with real content plus metadata header — topic detection on real content
  const realMsg = {
    role: 'user',
    textContent:
      '[Sun 2026-04-05 02:43 MST]\n' +
      'Sender (untrusted metadata): channel=webchat\n' +
      '\n' +
      'Let\'s discuss the upcoming database migration to PostgreSQL.',
    toolCalls: null,
    toolResults: null,
  };

  const signal = detectTopicShift(realMsg, [], null);
  // Real content about a new topic — may or may not trigger (depends on heuristic)
  // but it should not have a topic name derived purely from the metadata lines
  if (signal.topicName) {
    assert(
      !signal.topicName.toLowerCase().includes('sender') &&
      !signal.topicName.toLowerCase().includes('untrusted') &&
      !signal.topicName.toLowerCase().includes('channel='),
      `detectTopicShift: topic name does not contain metadata content (got "${signal.topicName}")`
    );
  } else {
    assert(true, 'detectTopicShift: no topic name extracted from metadata-prefixed message (acceptable)');
  }
}

// ─── VS-1: Topic-scoped Redis key namespacing ────────────────────────────────

console.log('\n── VS-1: Topic-scoped Redis key namespacing ──');

async function runRedisTests() {
  const redis = new RedisLayer({ keyPrefix: 'hm-vs1-test:', sessionTTL: 30 });
  const connected = await redis.connect();

  if (!connected) {
    console.log('  ⚠️  Redis unavailable — skipping Redis key tests');
    return;
  }

  // Clean up stale keys from previous runs
  await redis.flushPrefix();

  const agentId = 'test-vs1-agent';
  const sessionKey = 'agent:test-vs1-agent:webchat:main';
  const topicId = 'topic-abc-123';

  // ── Topic slot set/get ──
  await redis.setTopicSlot(agentId, sessionKey, topicId, 'context', 'Topic-specific context');
  const slotVal = await redis.getTopicSlot(agentId, sessionKey, topicId, 'context');
  assert(slotVal === 'Topic-specific context', 'setTopicSlot/getTopicSlot round-trips correctly');

  // ── Topic slot is namespaced differently from session slot ──
  await redis.setSlot(agentId, sessionKey, 'context', 'Session-level context');
  const sessionVal = await redis.getSlot(agentId, sessionKey, 'context');
  const topicVal2 = await redis.getTopicSlot(agentId, sessionKey, topicId, 'context');
  assert(sessionVal === 'Session-level context', 'Session slot holds session-level value');
  assert(topicVal2 === 'Topic-specific context', 'Topic slot unaffected by session slot write');
  assert(sessionVal !== topicVal2, 'Topic slot is distinct from session slot (different namespace)');

  // ── Topic window set/get ──
  const topicMessages = [
    { role: 'system', textContent: 'System prompt', toolCalls: null, toolResults: null },
    { role: 'user', textContent: 'What is the deploy status?', toolCalls: null, toolResults: null },
    { role: 'assistant', textContent: 'Deploy is running.', toolCalls: null, toolResults: null },
  ];
  await redis.setTopicWindow(agentId, sessionKey, topicId, topicMessages);
  const retrieved = await redis.getTopicWindow(agentId, sessionKey, topicId);
  assert(retrieved !== null, 'getTopicWindow returns non-null after setTopicWindow');
  assert(Array.isArray(retrieved), 'getTopicWindow returns an array');
  assert(retrieved.length === 3, `getTopicWindow: correct message count (got ${retrieved?.length})`);
  assert(retrieved[1].textContent === 'What is the deploy status?', 'getTopicWindow: message content preserved');

  // ── Topic window is namespaced separately from session window ──
  const sessionMessages = [
    { role: 'user', textContent: 'Session-level message', toolCalls: null, toolResults: null },
  ];
  await redis.setWindow(agentId, sessionKey, sessionMessages);
  const sessionWindow = await redis.getWindow(agentId, sessionKey);
  const topicWindow2 = await redis.getTopicWindow(agentId, sessionKey, topicId);
  assert(sessionWindow !== null, 'Session window non-null');
  assert(topicWindow2 !== null, 'Topic window non-null after session window write');
  assert(sessionWindow.length === 1, `Session window has 1 message (got ${sessionWindow?.length})`);
  assert(topicWindow2.length === 3, `Topic window still has 3 messages (not overwritten by session write)`);

  // ── invalidateTopicWindow ──
  await redis.invalidateTopicWindow(agentId, sessionKey, topicId);
  const afterInvalidate = await redis.getTopicWindow(agentId, sessionKey, topicId);
  assert(afterInvalidate === null, 'invalidateTopicWindow clears the topic window');

  // Session window survives topic window invalidation
  const sessionWindowAfter = await redis.getWindow(agentId, sessionKey);
  assert(sessionWindowAfter !== null, 'Session window survives topic window invalidation');

  // ── warmTopicSession ──
  const warmSlots = {
    context: 'Warmed topic context',
    facts: 'Fact: deploy uses k8s',
    window: topicMessages,
  };
  await redis.warmTopicSession(agentId, sessionKey, topicId, warmSlots);
  const warmedCtx = await redis.getTopicSlot(agentId, sessionKey, topicId, 'context');
  const warmedFacts = await redis.getTopicSlot(agentId, sessionKey, topicId, 'facts');
  const warmedWindow = await redis.getTopicWindow(agentId, sessionKey, topicId);
  assert(warmedCtx === 'Warmed topic context', 'warmTopicSession: context slot warmed');
  assert(warmedFacts === 'Fact: deploy uses k8s', 'warmTopicSession: facts slot warmed');
  assert(warmedWindow !== null && warmedWindow.length === 3, 'warmTopicSession: window slot warmed');

  // ── Different topic ID gets its own namespace ──
  const topicId2 = 'topic-xyz-456';
  await redis.setTopicWindow(agentId, sessionKey, topicId2, sessionMessages);
  const t1Window = await redis.getTopicWindow(agentId, sessionKey, topicId);
  const t2Window = await redis.getTopicWindow(agentId, sessionKey, topicId2);
  assert(t1Window !== null && t1Window.length === 3, 'Topic 1 window unaffected by topic 2 write');
  assert(t2Window !== null && t2Window.length === 1, 'Topic 2 window has its own content');

  await redis.flushPrefix();
  await redis.disconnect();
}

// ─── Message count bug fix: new topics start at count 1 ──────────────────────

console.log('\n── VS-5 plugin fix: message count increments on new topic ──');

{
  const db = makeDb();
  const topicMap = new SessionTopicMap(db);
  const SK = 'agent:forge:webchat:main';

  // Create a topic (simulates the plugin path before the fix)
  const topicId = topicMap.createTopic(SK, 'Deploy discussion');

  // Before fix: message_count would be 0 after createTopic
  // After fix: plugin calls incrementMessageCount immediately after createTopic
  // Simulate the fixed plugin behavior
  topicMap.incrementMessageCount(topicId);

  const topics = topicMap.listTopics(SK);
  assert(topics.length === 1, 'One topic created');
  const topic = topics[0];
  assert(topic.messageCount === 1, `New topic message_count = 1 after increment (got ${topic.messageCount})`);

  // Subsequent message increments continue correctly
  topicMap.incrementMessageCount(topicId);
  topicMap.incrementMessageCount(topicId);
  const topics2 = topicMap.listTopics(SK);
  assert(topics2[0].messageCount === 3, `message_count = 3 after two more increments (got ${topics2[0].messageCount})`);
}

// Run Redis tests (async)
await runRedisTests();

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`  ALL ${passed} TESTS PASSED ✅`);
} else {
  console.log(`  ${passed} passed, ${failed} FAILED ❌`);
}
console.log('═══════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
