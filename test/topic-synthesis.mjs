/**
 * Topic synthesis tests.
 */

import { HyperMem, TopicSynthesizer, lintKnowledge } from '../dist/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function sqliteTime(msAgo) {
  return new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
}

function isoMinutesAgo(minutes) {
  return sqliteTime(minutes * 60 * 1000);
}

function isoHoursAgo(hours) {
  return sqliteTime(hours * 60 * 60 * 1000);
}

function isoDaysAgo(days) {
  return sqliteTime(days * 24 * 60 * 60 * 1000);
}

async function createHarness(label = 'default') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hm-topic-synth-${label}-`));
  const hm = await HyperMem.create({
    dataDir: tmpDir,
    redis: { host: '127.0.0.1', port: 6379, keyPrefix: `hm-topic-synth-${label}:`, sessionTTL: 60 },
  });

  const agentId = 'forge';
  const sessionKey = `agent:${agentId}:webchat:${label}`;
  const msgDb = hm.dbManager.getMessageDb(agentId);
  const libDb = hm.dbManager.getLibraryDb();

  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status, message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, ?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, `${label}-sess-1`, agentId);

  const convId = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey).id;

  return { hm, tmpDir, agentId, sessionKey, msgDb, libDb, convId };
}

function insertTopic(h, {
  name,
  messageCount = 0,
  status = 'active',
  updatedAt = isoMinutesAgo(45),
  createdAt = isoHoursAgo(2),
  description = 'test topic',
}) {
  h.libDb.prepare(`
    INSERT INTO topics (agent_id, name, description, status, visibility, last_session_key, message_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'org', ?, ?, ?, ?)
  `).run(h.agentId, name, description, status, h.sessionKey, messageCount, createdAt, updatedAt);

  const row = h.libDb.prepare('SELECT id FROM topics WHERE agent_id = ? AND name = ? ORDER BY id DESC LIMIT 1').get(h.agentId, name);
  return row.id;
}

function insertMessage(h, topicId, {
  text = 'generic synthesis test message with enough body to avoid filters',
  agentId = h.agentId,
  role = 'assistant',
  createdAt = isoMinutesAgo(90),
  messageIndex = 0,
  toolCalls = null,
}) {
  h.msgDb.prepare(`
    INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results, metadata, token_count, message_index, is_heartbeat, created_at, topic_id)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, 0, ?, ?)
  `).run(h.convId, agentId, role, text, toolCalls, messageIndex, createdAt, String(topicId));
}

function seedTopicMessages(h, topicId, messages) {
  messages.forEach((m, idx) => insertMessage(h, topicId, { messageIndex: idx + 1, ...m }));
  h.libDb.prepare('UPDATE topics SET message_count = ?, updated_at = ? WHERE id = ?')
    .run(messages.length, h.libDb.prepare('SELECT updated_at FROM topics WHERE id = ?').get(topicId).updated_at, topicId);
}

function fetchKnowledge(h, key) {
  return h.libDb.prepare(`
    SELECT * FROM knowledge
    WHERE agent_id = ? AND domain = 'topic-synthesis' AND key = ? AND superseded_by IS NULL
    ORDER BY version DESC LIMIT 1
  `).get(h.agentId, key);
}

function summarySection(content) {
  const match = content.match(/## Summary\n([\s\S]*?)\n\n## Key Decisions/);
  return match ? match[1] : '';
}

async function testEmptyTopicList() {
  const h = await createHarness('empty');
  const synth = new TopicSynthesizer(h.libDb, () => h.msgDb);
  const result = synth.tick(h.agentId);
  assert(result.topicsSynthesized === 0, 'empty topic list: 0 synthesized');
  assert(result.knowledgeEntriesWritten === 0, 'empty topic list: 0 knowledge writes');
  await h.hm.close();
}

async function testMinMessageThreshold() {
  const h = await createHarness('min-threshold');
  const topicId = insertTopic(h, { name: 'too-small', messageCount: 4, updatedAt: isoMinutesAgo(60) });
  seedTopicMessages(h, topicId, [
    { text: 'message 1 with enough content to count in the topic discussion' },
    { text: 'message 2 with enough content to count in the topic discussion' },
    { text: 'message 3 with enough content to count in the topic discussion' },
    { text: 'message 4 with enough content to count in the topic discussion' },
  ]);
  const synth = new TopicSynthesizer(h.libDb, () => h.msgDb);
  const result = synth.tick(h.agentId);
  assert(result.topicsSynthesized === 0, 'topic with < 5 messages is skipped');
  await h.hm.close();
}

async function testStaleTopicSynthesizes() {
  const h = await createHarness('stale');
  const topicId = insertTopic(h, { name: 'stale-topic', updatedAt: isoMinutesAgo(60) });
  seedTopicMessages(h, topicId, [
    { text: 'We decided to use sqlite for this topic because it keeps deployment simple and local.' },
    { text: 'The plan is to keep the first cut heuristic-only and avoid model calls for synthesis.' },
    { text: 'Can we keep the wiki pages compact and readable for recall?' },
    { text: 'I wrote /tmp/demo.txt during the prototype and captured output in the thread.' },
    { text: 'This thread is stale now and has enough information to synthesize safely.' },
  ]);
  const synth = new TopicSynthesizer(h.libDb, () => h.msgDb);
  const result = synth.tick(h.agentId);
  const row = fetchKnowledge(h, 'stale-topic');
  assert(result.topicsSynthesized === 1, 'stale topic with >= 5 messages is synthesized');
  assert(!!row, 'knowledge entry exists after synthesis');
  assert(row.domain === 'topic-synthesis' && row.key === 'stale-topic', 'knowledge row has correct domain and key');
  await h.hm.close();
}

async function testRecentTopicSkipped() {
  const h = await createHarness('recent');
  const topicId = insertTopic(h, { name: 'recent-topic', updatedAt: isoMinutesAgo(5) });
  seedTopicMessages(h, topicId, new Array(5).fill(0).map((_, i) => ({ text: `recent message ${i} with enough body to count and remain unsynthesized for now` })));
  const synth = new TopicSynthesizer(h.libDb, () => h.msgDb);
  const result = synth.tick(h.agentId);
  assert(result.topicsSynthesized === 0, 'recent topic is skipped');
  await h.hm.close();
}

async function testResynthesisThresholds() {
  const h = await createHarness('resynth');
  const topicId = insertTopic(h, { name: 'growing-topic', updatedAt: isoMinutesAgo(90) });
  const baseMessages = [
    { text: 'We decided to keep synthesis in the background indexer for predictable runtime behavior.' },
    { text: 'The plan is to write wiki pages into the knowledge table with topic-synthesis as domain.' },
    { text: 'Question: should the first version avoid LLM calls entirely?' },
    { text: 'Yes, the approach is heuristic-only for v1 and that keeps failures bounded.' },
    { text: 'We also want artifact extraction from tool call paths in the thread.' },
  ];
  seedTopicMessages(h, topicId, baseMessages);
  const synth = new TopicSynthesizer(h.libDb, () => h.msgDb);
  const first = synth.tick(h.agentId);
  assert(first.topicsSynthesized === 1, 'initial synthesis succeeds for growing topic');

  h.libDb.prepare('UPDATE topics SET message_count = ?, updated_at = ? WHERE id = ?').run(7, isoMinutesAgo(90), topicId);
  insertMessage(h, topicId, { messageIndex: 6, text: 'small growth message one with enough content to be stored cleanly' });
  insertMessage(h, topicId, { messageIndex: 7, text: 'small growth message two with enough content to be stored cleanly' });
  const second = synth.tick(h.agentId);
  assert(second.topicsSynthesized === 0, 're-synthesis skipped when growth < 5 messages');

  h.libDb.prepare('UPDATE topics SET message_count = ?, updated_at = ? WHERE id = ?').run(10, isoMinutesAgo(90), topicId);
  insertMessage(h, topicId, { messageIndex: 8, text: 'growth message three with enough content to count for re-synthesis logic' });
  insertMessage(h, topicId, { messageIndex: 9, text: 'growth message four with enough content to count for re-synthesis logic' });
  insertMessage(h, topicId, { messageIndex: 10, text: 'growth message five with enough content to count for re-synthesis logic' });
  const third = synth.tick(h.agentId);
  const row = fetchKnowledge(h, 'growing-topic');
  assert(third.topicsSynthesized === 1, 're-synthesis runs when growth >= 5 messages');
  assert(row.version === 2, 're-synthesis creates a new knowledge version');
  await h.hm.close();
}

async function testContentExtraction() {
  const h = await createHarness('content');
  const topicId = insertTopic(h, { name: 'content-rich', updatedAt: isoMinutesAgo(75) });
  const longText = 'decided path '.repeat(120) + '/home/lumadmin/.openclaw/workspace/repo/hypermem/src/topic-synthesizer.ts `inline-ref`';

  seedTopicMessages(h, topicId, [
    {
      agentId: 'forge',
      text: 'We decided to keep topic synthesis heuristic-only and write compiled markdown into knowledge.',
      toolCalls: JSON.stringify([{ name: 'write', arguments: { path: '/home/lumadmin/.openclaw/workspace/repo/hypermem/src/topic-synthesizer.ts' } }]),
    },
    {
      agentId: 'forge',
      text: 'This message cites /home/lumadmin/.openclaw/workspace/repo/hypermem/specs/TOPIC_SYNTHESIS.md and mentions forge and compass for scoring.',
    },
    {
      agentId: 'clarity',
      text: 'We will go with a wiki page format that includes summary, decisions, open questions, and artifacts.',
      toolCalls: JSON.stringify([{ input: { filePath: '/home/lumadmin/.openclaw/workspace/repo/hypermem/specs/TOPIC_SYNTHESIS.md' } }]),
    },
    {
      agentId: 'forge',
      text: longText,
    },
    {
      agentId: 'compass',
      text: 'Another long reference-rich message with `code refs`, /home/lumadmin/project/file.ts, and enough body to force summary truncation once combined with the others.'.repeat(8),
    },
    {
      agentId: 'compass',
      text: 'What should happen with open questions that never got an explicit decision follow-up?',
    },
  ]);

  const synth = new TopicSynthesizer(h.libDb, () => h.msgDb);
  synth.tick(h.agentId);
  const row = fetchKnowledge(h, 'content-rich');
  const summary = summarySection(row.content);

  assert(row.content.includes('## Key Decisions') && row.content.includes('We decided to keep topic synthesis heuristic-only'), 'synthesis content includes decisions');
  assert(row.content.includes('## Open Questions') && row.content.includes('What should happen with open questions'), 'synthesis content includes open questions');
  assert(row.content.includes('/home/lumadmin/.openclaw/workspace/repo/hypermem/src/topic-synthesizer.ts'), 'synthesis content includes artifact paths from tool calls');
  assert(
    row.content.includes('**Participants:**') &&
    row.content.includes('forge') &&
    row.content.includes('compass') &&
    row.content.includes('clarity'),
    'synthesis content includes participant list'
  );
  assert(summary.length <= 800, `summary is truncated to max chars (got ${summary.length})`);
  assert(summary.includes(' ... '), 'summary uses head+tail truncation when oversized');
  await h.hm.close();
}

async function testLintChecks() {
  const h = await createHarness('lint');

  // Stale synthesis
  const staleTopicId = insertTopic(h, { name: 'old-synth', messageCount: 5, updatedAt: isoDaysAgo(8), createdAt: isoDaysAgo(10) });
  seedTopicMessages(h, staleTopicId, [
    { text: 'We decided to keep the old topic around as a synthesized knowledge entry for lint testing.' },
    { text: 'second message with enough content for the threshold to pass cleanly' },
    { text: 'third message with enough content for the threshold to pass cleanly' },
    { text: 'fourth message with enough content for the threshold to pass cleanly' },
    { text: 'fifth message with enough content for the threshold to pass cleanly' },
  ]);
  const synth = new TopicSynthesizer(h.libDb, () => h.msgDb);
  synth.tick(h.agentId);
  const staleKnowledge = fetchKnowledge(h, 'old-synth');
  h.libDb.prepare('UPDATE knowledge SET updated_at = ? WHERE id = ?').run(isoDaysAgo(8), staleKnowledge.id);

  // Orphan topic
  insertTopic(h, { name: 'tiny-orphan', messageCount: 2, updatedAt: isoHoursAgo(72), createdAt: isoHoursAgo(96) });

  // Coverage gap
  insertTopic(h, { name: 'big-unsynthesized', messageCount: 20, updatedAt: isoMinutesAgo(10), createdAt: isoHoursAgo(3) });

  const lint = lintKnowledge(h.libDb);
  const decayed = fetchKnowledge(h, 'old-synth');

  assert(lint.staleDecayed === 1, 'lint decays stale synthesis confidence');
  assert(Number(decayed.confidence) === 0.3, 'stale synthesis confidence set to 0.3');
  assert(lint.orphansFound >= 1, 'lint detects orphan topic');
  assert(lint.coverageGaps.includes('big-unsynthesized'), 'lint detects coverage gap for large unsynthesized topic');
  await h.hm.close();
}

async function testMultipleTopicsOneTick() {
  const h = await createHarness('multi');
  const a = insertTopic(h, { name: 'multi-a', updatedAt: isoMinutesAgo(80) });
  const b = insertTopic(h, { name: 'multi-b', updatedAt: isoMinutesAgo(81) });
  seedTopicMessages(h, a, new Array(5).fill(0).map((_, i) => ({ text: `topic a message ${i} with enough content for synthesis to succeed cleanly` })));
  seedTopicMessages(h, b, new Array(6).fill(0).map((_, i) => ({ text: `topic b message ${i} with enough content for synthesis to succeed cleanly` })));

  const synth = new TopicSynthesizer(h.libDb, () => h.msgDb);
  const result = synth.tick(h.agentId);
  assert(result.topicsSynthesized === 2, 'multiple qualifying topics are processed in one tick');
  assert(!!fetchKnowledge(h, 'multi-a') && !!fetchKnowledge(h, 'multi-b'), 'multiple knowledge entries are written in one tick');
  await h.hm.close();
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Topic Synthesis Tests');
  console.log('═══════════════════════════════════════════════════\n');

  await testEmptyTopicList();
  await testMinMessageThreshold();
  await testStaleTopicSynthesizes();
  await testRecentTopicSkipped();
  await testResynthesisThresholds();
  await testContentExtraction();
  await testLintChecks();
  await testMultipleTopicsOneTick();

  console.log(`\nPassed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
