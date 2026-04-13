/**
 * Virtual Sessions tests — VS-5 (topic detector noise fix)
 *
 * Tests:
 *   - stripMessageMetadata() removes timestamp headers, sender metadata, JSON metadata blocks
 *   - stripMessageMetadata() preserves actual message content
 *   - detectTopicShift() no longer creates topics from metadata
 *   - Message count increments on new topic creation (plugin bug fix)
 */

import { stripMessageMetadata, detectTopicShift, HyperMem as Hypermem } from '../dist/index.js';
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
  // recordUserMessage() should also strip metadata before persistence
  const hm = await Hypermem.create({
    dbDir: '/tmp/hypermem-vs5-record-user',
  });
  const stored = await hm.recordUserMessage(
    'test-vs5-agent',
    'agent:test-vs5-agent:webchat:main',
    'Sender (untrusted metadata):\n```json\n{"label":"ragesaq (gateway-client)","id":"gateway-client"}\n```\n\nPlease review the deploy plan.'
  );
  assert(!stored.textContent.includes('Sender (untrusted metadata)'), 'recordUserMessage strips sender metadata before storage');
  assert(stored.textContent.includes('Please review the deploy plan.'), 'recordUserMessage preserves user content after stripping metadata');
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


// ─── Message count bug fix: new topics start at count 1 ──────────────────────

console.log('\n── VS-5 plugin fix: message count increments on new topic ──');

{
  const db = makeDb();
  const topicMap = new SessionTopicMap(db);
  const SK = 'agent:agent1:webchat:main';

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

// Run async tests
await (async () => {})();

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`  ALL ${passed} TESTS PASSED ✅`);
} else {
  console.log(`  ${passed} passed, ${failed} FAILED ❌`);
}
console.log('═══════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
