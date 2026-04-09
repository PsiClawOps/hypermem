/**
 * Redis integration test — exercises Redis-specific paths:
 * - Session warming (SQLite → Redis)
 * - Slot management (set/get/clear)
 * - Graceful degradation when Redis is down
 * - Cross-session compositor queries
 * - Extended memory stores (facts, knowledge, topics, episodes)
 * - Provider translation round-trip
 */

import { HyperMem, toProviderFormat, fromProviderFormat } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-redis-test-'));

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

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Redis Integration Test');
  console.log('═══════════════════════════════════════════════════\n');

  let hm;
  try {
    // ── Create instance with Redis ──
    hm = await HyperMem.create({
      dataDir: tmpDir,
      redis: { host: 'localhost', port: 6379, keyPrefix: 'hm-test:', sessionTTL: 60 },
    });

    assert(hm.redis != null, 'Redis layer initialized');

    // Clean up stale keys from previous runs
    const flushed = await hm.redis.flushPrefix();
    if (flushed > 0) console.log(`  🧹 Cleaned ${flushed} stale Redis keys`);

    const agentId = 'test-forge';
    const sessionKey1 = 'agent:test-forge:webchat:main';
    const sessionKey2 = 'agent:test-forge:discord:general';

    // ── Record messages across two sessions ──
    console.log('\n── Recording messages across sessions ──');

    hm.dbManager.ensureAgent(agentId, { displayName: 'Test Forge', tier: 'council' });

    await hm.recordUserMessage(agentId, sessionKey1, 'Deploy the new service to staging', {
      channelType: 'webchat', provider: 'anthropic',
    });
    await hm.recordAssistantMessage(agentId, sessionKey1, {
      role: 'assistant',
      textContent: 'I\'ll deploy the service to staging. Running preflight checks first.',
      toolCalls: null, toolResults: null,
    });
    await hm.recordUserMessage(agentId, sessionKey1, 'Check if Redis is configured', {
      channelType: 'webchat', provider: 'anthropic',
    });

    await hm.recordUserMessage(agentId, sessionKey2, 'What\'s the status of the staging deploy?', {
      channelType: 'discord', provider: 'openai',
    });
    await hm.recordAssistantMessage(agentId, sessionKey2, {
      role: 'assistant',
      textContent: 'The staging deploy is in progress. Preflight checks passed, now pushing containers.',
      toolCalls: null, toolResults: null,
    });

    assert(true, 'Recorded 5 messages across 2 sessions');

    // ── Composition with Redis ──
    console.log('\n── Composition ──');

    const result1 = await hm.compose({
      agentId, sessionKey: sessionKey1, tokenBudget: 4000,
      provider: 'anthropic', model: 'claude-opus-4-6',
    });
    // History messages + possible cross-session context system message
    assert(result1.messages.length >= 3, `Session 1 compose: ≥3 messages (got ${result1.messages.length})`);
    assert(result1.slots.history > 0, `Session 1 history tokens: ${result1.slots.history}`);

    const result2 = await hm.compose({
      agentId, sessionKey: sessionKey2, tokenBudget: 4000,
      provider: 'openai', model: 'gpt-5.4',
    });
    assert(result2.messages.length >= 2, `Session 2 compose: ≥2 messages (got ${result2.messages.length})`);

    // ── Redis history limit passthrough ──
    console.log('\n── Redis history limit passthrough ──');

    const limitedRedisHistory = await hm.redis.getHistory(agentId, sessionKey1, 2);
    assert(limitedRedisHistory.length === 2, `Redis getHistory(limit=2): 2 messages (got ${limitedRedisHistory.length})`);
    assert(limitedRedisHistory[0]?.textContent?.includes('preflight checks')
      && limitedRedisHistory[1]?.textContent?.includes('Check if Redis is configured'),
      'Redis getHistory(limit) returns last 2 messages in chronological order');

    const limitedCompose = await hm.compose({
      agentId, sessionKey: sessionKey1, tokenBudget: 4000,
      provider: 'openai', model: 'gpt-5.4',
      includeFacts: false, includeContext: false, includeLibrary: false, includeDocChunks: false,
      historyDepth: 2,
    });
    const limitedNonSystem = limitedCompose.messages.filter(m => m.role !== 'system');
    assert(limitedNonSystem.length === 2,
      `Compose historyDepth=2 on hot Redis session returns 2 non-system messages (got ${limitedNonSystem.length})`);

    // ── Session warming test ──
    console.log('\n── Session warming (simulate cold start) ──');

    const hotBeforeEvict = await hm.redis.sessionExists(agentId, sessionKey1);
    assert(hotBeforeEvict, 'sessionExists=true before evict');

    // Clear Redis to simulate cold start
    await hm.redis.evictSession(agentId, sessionKey1);

    const isCleared = !(await hm.redis.sessionExists(agentId, sessionKey1));
    assert(isCleared, 'sessionExists=false after evict (simulated cold start)');

    // Warm from SQLite
    await hm.warm(agentId, sessionKey1);
    assert(await hm.redis.sessionExists(agentId, sessionKey1), 'sessionExists=true after warm');

    // Verify warming restored the data
    const warmedResult = await hm.compose({
      agentId, sessionKey: sessionKey1, tokenBudget: 4000,
      provider: 'anthropic', model: 'claude-opus-4-6',
    });
    assert(warmedResult.messages.length >= 3, `Warmed session: ≥3 messages (got ${warmedResult.messages.length})`);

    const warmedHistory = await hm.redis.getHistory(agentId, sessionKey1);
    await hm.warm(agentId, sessionKey1);
    const rewarmedHistory = await hm.redis.getHistory(agentId, sessionKey1);
    assert(rewarmedHistory.length === warmedHistory.length,
      `Repeated warm does not duplicate Redis history (${warmedHistory.length} -> ${rewarmedHistory.length})`);

    // ── Window cache test ──
    console.log('\n── Window cache (setWindow / getWindow / invalidateWindow) ──');

    // Before compose, window should be null (evicted session was re-warmed)
    const preComposeWindow = await hm.redis.getWindow(agentId, sessionKey1);
    // compose() writes the window, so after our warmedResult call above it should exist
    // Let's compose fresh and check
    const windowTestResult = await hm.compose({
      agentId, sessionKey: sessionKey1, tokenBudget: 4000,
      provider: 'anthropic', model: 'claude-opus-4-6',
      includeFacts: false, includeContext: false, includeLibrary: false, includeDocChunks: false,
    });
    const cachedWindow = await hm.redis.getWindow(agentId, sessionKey1);
    assert(cachedWindow !== null, 'Window cache populated after compose()');
    assert(Array.isArray(cachedWindow), 'Window cache is an array');
    assert(cachedWindow.length === windowTestResult.messages.length,
      `Window cache length matches compose output (${cachedWindow.length} === ${windowTestResult.messages.length})`);

    // Invalidate and verify
    await hm.redis.invalidateWindow(agentId, sessionKey1);
    const afterInvalidate = await hm.redis.getWindow(agentId, sessionKey1);
    assert(afterInvalidate === null, 'Window cache null after invalidateWindow()');

    // ── Session cursor test ──
    console.log('\n── Session cursor (setCursor / getCursor) ──');

    // compose() writes the cursor when history is included
    const cursorTestResult = await hm.compose({
      agentId, sessionKey: sessionKey1, tokenBudget: 4000,
      provider: 'anthropic', model: 'claude-opus-4-6',
      includeFacts: false, includeContext: false, includeLibrary: false, includeDocChunks: false,
    });
    const cursor = await hm.redis.getCursor(agentId, sessionKey1);
    assert(cursor !== null, 'Cursor written after compose()');
    assert(typeof cursor.lastSentId === 'number', 'cursor.lastSentId is a number');
    assert(typeof cursor.lastSentIndex === 'number', 'cursor.lastSentIndex is a number');
    assert(typeof cursor.lastSentAt === 'string', 'cursor.lastSentAt is a string');
    assert(cursor.windowSize > 0, `cursor.windowSize > 0 (got ${cursor.windowSize})`);
    assert(cursor.tokenCount > 0, `cursor.tokenCount > 0 (got ${cursor.tokenCount})`);

    // Cursor survives across compose() calls (refreshed, not destroyed)
    const cursor2 = await hm.redis.getCursor(agentId, sessionKey1);
    assert(cursor2.lastSentId === cursor.lastSentId, 'Cursor stable across reads (same lastSentId)');

    // ── Cross-session query ──
    console.log('\n── Cross-session queries ──');

    const db = hm.dbManager.getAgentDb(agentId);
    const allMsgs = db.prepare('SELECT COUNT(*) as cnt FROM messages').get();
    assert(allMsgs.cnt === 5, `Agent DB: 5 total messages across sessions (got ${allMsgs.cnt})`);

    // FTS search across all sessions
    const searchResults = hm.search(agentId, 'staging deploy');
    assert(searchResults.length >= 1, `FTS "staging deploy": ${searchResults.length} results`);

    // ── Extended memory stores ──
    console.log('\n── Extended memory stores ──');

    // Facts
    hm.addFact(agentId, 'Staging environment uses Kubernetes', {
      domain: 'infrastructure', confidence: 0.95,
    });
    hm.addFact(agentId, 'Redis version is 7.0.15', {
      domain: 'infrastructure', confidence: 1.0,
    });
    const facts = hm.getActiveFacts(agentId);
    assert(facts.length === 2, `2 facts stored (got ${facts.length})`);

    // Knowledge
    hm.upsertKnowledge(agentId, 'operations', 'deploy-process',
      'Staging deploys go through preflight, container push, health check, then traffic shift.',
      { confidence: 0.9, sourceType: 'conversation' }
    );
    const knowledge = hm.getKnowledge(agentId, { domain: 'operations' });
    assert(knowledge.length === 1, `1 knowledge entry (got ${knowledge.length})`);

    // Topics
    hm.createTopic(agentId, 'Staging Deployment', 'Deployment to staging environment');
    const topics = hm.getActiveTopics(agentId);
    assert(topics.length === 1, `1 topic tracked (got ${topics.length})`);

    // Episodes
    hm.recordEpisode(agentId, 'deployment', 'Forge began staging deployment with preflight checks.', {
      significance: 7,
      participants: ['ragesaq', 'forge'],
    });
    const episodes = hm.getRecentEpisodes(agentId, { limit: 10 });
    assert(episodes.length === 1, `1 episode recorded (got ${episodes.length})`);

    // ── Provider translation round-trip ──
    console.log('\n── Provider translation ──');

    const neutralMsgs = [{
      role: 'assistant',
      textContent: 'Deploying to staging now.',
      toolCalls: [{
        id: 'hm_tc1',
        name: 'exec',
        arguments: '{"command":"kubectl apply -f staging.yaml"}',
      }],
      toolResults: null,
      createdAt: new Date().toISOString(),
    }];

    const anthropicMsgs = toProviderFormat(neutralMsgs, 'anthropic');
    assert(anthropicMsgs.length === 1, 'Anthropic: 1 message');
    assert(Array.isArray(anthropicMsgs[0].content), 'Anthropic: content is array');
    const hasText = anthropicMsgs[0].content.some(b => b.type === 'text');
    const hasToolUse = anthropicMsgs[0].content.some(b => b.type === 'tool_use');
    assert(hasText, 'Anthropic: has text block');
    assert(hasToolUse, 'Anthropic: has tool_use block');

    const openaiMsgs = toProviderFormat(neutralMsgs, 'openai');
    assert(openaiMsgs.length === 1, 'OpenAI: 1 message');
    assert(openaiMsgs[0].content === 'Deploying to staging now.', 'OpenAI: string content');
    assert(Array.isArray(openaiMsgs[0].tool_calls), 'OpenAI: has tool_calls array');

    // Round-trip
    const backFromAnthropic = fromProviderFormat(anthropicMsgs[0], 'anthropic');
    assert(backFromAnthropic.textContent === neutralMsgs[0].textContent, 'Round-trip Anthropic preserves text');

    const backFromOpenAI = fromProviderFormat(openaiMsgs[0], 'openai');
    assert(backFromOpenAI.textContent === neutralMsgs[0].textContent, 'Round-trip OpenAI preserves text');

    // ── Duplicate fact dedup ──
    console.log('\n── Deduplication ──');
    hm.addFact(agentId, 'Redis version is 7.0.15', { domain: 'infrastructure', confidence: 1.0 });
    const factsAfterDedup = hm.getActiveFacts(agentId);
    assert(factsAfterDedup.length === 2, `Dedup: still 2 facts after duplicate add (got ${factsAfterDedup.length})`);

    // ── Cleanup ──
    console.log('\n── Cleanup ──');
    await hm.redis.evictSession(agentId, sessionKey1);
    await hm.redis.evictSession(agentId, sessionKey2);
    assert(true, 'Redis test keys cleaned');

  } catch (err) {
    console.error('\n💥 Test error:', err);
    failed++;
  } finally {
    if (hm) await hm.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

run();
