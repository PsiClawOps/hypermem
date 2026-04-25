/**
 * HyperMem 0.9.0 adaptive eviction-order tests.
 *
 * Locks the pure compose-window cluster-drop ordering helper:
 *   - bootstrap/warmup/steady: no topic-aware drop (baseline preserved).
 *   - elevated/high/critical: inactive-topic clusters drop before
 *     active-topic recent clusters when an active topic is known.
 *   - System prefix, dynamicBoundary, and the latest user-role cluster
 *     are protected from the topic-aware drop list.
 *   - Tool-call/result clusters are excluded from the topic-aware drop
 *     list so chains stay atomic and ballast reduction handles them.
 */

import {
  resolveAdaptiveLifecyclePolicy,
} from '../dist/adaptive-lifecycle.js';
import { orderClustersForAdaptiveEviction } from '../dist/compositor.js';
import { migrate } from '../dist/schema.js';
import { MessageStore } from '../dist/message-store.js';
import { ensureContextSchema } from '../dist/context-store.js';
import { DatabaseSync } from 'node:sqlite';

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

function msg(role, opts = {}) {
  const m = {
    role,
    textContent: opts.text ?? `${role}-text`,
    toolCalls: opts.toolCalls ?? null,
    toolResults: opts.toolResults ?? null,
  };
  if (opts.metadata) m.metadata = opts.metadata;
  if (opts.topicId !== undefined) m.topicId = opts.topicId;
  return m;
}

function cluster(messages) {
  return {
    messages,
    tokenCost: messages.reduce((s, m) => s + ((m.textContent ?? '').length), 0) + 4,
  };
}

const ACTIVE = 'topic-active';
const INACTIVE = 'topic-inactive';

console.log('\n── Scenario 1: steady band keeps baseline (no topic-aware drop) ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 20,
    pressureFraction: 0.50,
  });
  const clusters = [
    cluster([msg('user', { topicId: INACTIVE })]),
    cluster([msg('assistant', { topicId: INACTIVE })]),
    cluster([msg('user', { topicId: ACTIVE })]),
    cluster([msg('assistant', { topicId: ACTIVE })]),
  ];
  const ord = orderClustersForAdaptiveEviction(clusters, policy, { activeTopicId: ACTIVE });
  assert(ord.preferTopicAwareDrop === false, 'steady: preferTopicAwareDrop false');
  assert(ord.topicAwareDropOrder.length === 0,
    `steady: topicAwareDropOrder empty (got ${ord.topicAwareDropOrder.length})`);
}

console.log('\n── Scenario 2: elevated promotes inactive-topic clusters first ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 20,
    pressureFraction: 0.70,
  });
  const clusters = [
    cluster([msg('user', { topicId: INACTIVE })]),       // 0 — inactive
    cluster([msg('assistant', { topicId: INACTIVE })]),  // 1 — inactive
    cluster([msg('user', { topicId: ACTIVE })]),         // 2 — active recent
    cluster([msg('assistant', { topicId: ACTIVE })]),    // 3 — active recent
    cluster([msg('user', { topicId: ACTIVE })]),         // 4 — current user (latest user) — protected
  ];
  const ord = orderClustersForAdaptiveEviction(clusters, policy, { activeTopicId: ACTIVE });
  assert(ord.preferTopicAwareDrop === true, 'elevated: preferTopicAwareDrop true');
  assert(ord.topicAwareDropOrder.length === 2,
    `elevated: two inactive clusters listed for drop (got ${ord.topicAwareDropOrder.length})`);
  assert(ord.topicAwareDropOrder[0] === 0 && ord.topicAwareDropOrder[1] === 1,
    'elevated: inactive-topic clusters ordered oldest→newest at the head of the drop list');
  // Active-topic recent clusters are NOT in the topic-aware drop list.
  assert(!ord.topicAwareDropOrder.includes(2) && !ord.topicAwareDropOrder.includes(3),
    'elevated: active-topic recent clusters are NOT in topic-aware drop list');
}

console.log('\n── Scenario 3: protections — system prefix, dynamicBoundary, current user ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 20,
    pressureFraction: 0.80, // high band
  });
  const clusters = [
    cluster([msg('system', { topicId: undefined })]),                                         // 0 system prefix
    cluster([msg('system', { metadata: { dynamicBoundary: true }, topicId: INACTIVE })]),     // 1 dynamicBoundary
    cluster([msg('user', { topicId: INACTIVE })]),                                            // 2 inactive (drop candidate)
    cluster([msg('assistant', { topicId: INACTIVE })]),                                       // 3 inactive (drop candidate)
    cluster([msg('user', { topicId: ACTIVE })]),                                              // 4 latest user — protected
    cluster([msg('assistant', { topicId: ACTIVE })]),                                         // 5 active recent
  ];
  const ord = orderClustersForAdaptiveEviction(clusters, policy, { activeTopicId: ACTIVE });
  assert(ord.protectedIndices.has(0), 'system-prefix cluster protected');
  assert(ord.protectedIndices.has(1), 'dynamicBoundary cluster protected');
  assert(ord.protectedIndices.has(4), 'latest user-role cluster protected (current user proxy)');
  assert(!ord.topicAwareDropOrder.includes(0), 'system prefix never appears in topic-aware drop list');
  assert(!ord.topicAwareDropOrder.includes(1), 'dynamicBoundary cluster never appears in topic-aware drop list');
  assert(!ord.topicAwareDropOrder.includes(4), 'current user cluster never appears in topic-aware drop list');
  assert(ord.topicAwareDropOrder.includes(2) && ord.topicAwareDropOrder.includes(3),
    'inactive-topic non-protected clusters are drop candidates');
}

console.log('\n── Scenario 4: tool-call/result clusters stay atomic — excluded from topic-aware drop ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 20,
    pressureFraction: 0.92, // critical band
  });
  // A two-message tool cluster: assistant tool_use + tool_result. They share
  // the same inactive topic. The helper should refuse to add either index to
  // the topic-aware drop list (so the existing oldest-first sweep keeps
  // them atomic). Note: the existing oldest-first sweep can still drop the
  // pair as a unit if budget forces it — that path is intentionally
  // unchanged and not exercised here.
  const toolUse = msg('assistant', {
    topicId: INACTIVE,
    toolCalls: [{ id: 't1', name: 'search', arguments: {} }],
  });
  const toolResult = msg('tool', {
    topicId: INACTIVE,
    toolResults: [{ callId: 't1', name: 'search', content: 'ok' }],
  });
  const clusters = [
    cluster([toolUse, toolResult]),                       // 0 — tool cluster, inactive
    cluster([msg('user', { topicId: INACTIVE })]),        // 1 — inactive plain (drop candidate)
    cluster([msg('user', { topicId: ACTIVE })]),          // 2 — current user — protected
  ];
  const ord = orderClustersForAdaptiveEviction(clusters, policy, { activeTopicId: ACTIVE });
  assert(!ord.topicAwareDropOrder.includes(0),
    'tool-call/result cluster excluded from topic-aware drop (atomic chain protected)');
  assert(ord.topicAwareDropOrder.includes(1),
    'inactive-topic non-tool cluster IS a topic-aware drop candidate');
  assert(ord.protectedIndices.has(2), 'current user cluster protected');
}

console.log('\n── Scenario 5: no activeTopicId → no topic-aware drop list (graceful) ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 20,
    pressureFraction: 0.80,
  });
  const clusters = [
    cluster([msg('user', { topicId: 'x' })]),
    cluster([msg('assistant', { topicId: 'y' })]),
    cluster([msg('user', { topicId: 'z' })]),
  ];
  const ord = orderClustersForAdaptiveEviction(clusters, policy, {});
  assert(ord.preferTopicAwareDrop === true, 'high band still reports preferTopicAwareDrop=true');
  assert(ord.topicAwareDropOrder.length === 0,
    'no activeTopicId → empty topic-aware drop list (falls through to historical sweep)');
}

console.log('\n── Scenario 6: missing topicId on messages is NOT promoted to drop ──');
{
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 20,
    pressureFraction: 0.80,
  });
  const clusters = [
    cluster([msg('user', { /* no topicId */ })]),                // 0 — legacy, leave alone
    cluster([msg('assistant', { topicId: INACTIVE })]),          // 1 — inactive, drop candidate
    cluster([msg('user', { topicId: ACTIVE })]),                 // 2 — current user — protected
  ];
  const ord = orderClustersForAdaptiveEviction(clusters, policy, { activeTopicId: ACTIVE });
  assert(!ord.topicAwareDropOrder.includes(0),
    'legacy/unscoped clusters (no topicId) NOT promoted to drop candidates');
  assert(ord.topicAwareDropOrder.includes(1),
    'explicit inactive-topic cluster IS promoted to drop candidate');
}

console.log('\n── Scenario 7: MessageStore round-trips topic_id for runtime inputs ──');
{
  const db = new DatabaseSync(':memory:');
  migrate(db);
  ensureContextSchema(db);
  const store = new MessageStore(db);
  const conversation = store.getOrCreateConversation('agent-adaptive', 'agent-adaptive:webchat:runtime-topic');

  store.recordMessage(conversation.id, 'agent-adaptive', msg('user', {
    text: 'inactive topic user message',
    topicId: INACTIVE,
  }));
  store.recordMessage(conversation.id, 'agent-adaptive', msg('assistant', {
    text: 'inactive topic assistant message',
    topicId: INACTIVE,
  }));
  store.recordMessage(conversation.id, 'agent-adaptive', msg('user', {
    text: 'active topic current user message',
    topicId: ACTIVE,
  }));

  const runtimeMessages = store.getRecentMessages(conversation.id, 10);
  const policy = resolveAdaptiveLifecyclePolicy({
    userTurnCount: 20,
    pressureFraction: 0.80,
  });
  const ord = orderClustersForAdaptiveEviction(
    runtimeMessages.map(m => cluster([m])),
    policy,
    { activeTopicId: ACTIVE },
  );

  assert(runtimeMessages[0].topicId === INACTIVE,
    'MessageStore exposes inactive topic_id as NeutralMessage.topicId');
  assert(runtimeMessages[2].topicId === ACTIVE,
    'MessageStore exposes active topic_id as NeutralMessage.topicId');
  assert(ord.topicAwareDropOrder.includes(0) && ord.topicAwareDropOrder.includes(1),
    'topic-aware order works on real MessageStore messages, not just synthetic fixtures');
  assert(!ord.topicAwareDropOrder.includes(2),
    'current active-topic user message from MessageStore is not promoted to topic-aware drop');

  db.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
