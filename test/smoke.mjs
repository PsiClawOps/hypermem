/**
 * HyperMem Smoke Test
 *
 * Tests: DB creation, schema migration, message recording, retrieval, FTS, composition.
 * Does NOT require Redis (tests SQLite-only mode).
 */

import { HyperMem } from '../dist/index.js';
import { userMessageToNeutral } from '../dist/provider-translator.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const testDir = path.join(os.tmpdir(), `hypermem-test-${Date.now()}`);
let hm;

async function setup() {
  fs.mkdirSync(testDir, { recursive: true });
  hm = await HyperMem.create({
    dataDir: testDir,
  });
  console.log('✅ HyperMem created');
  console.log(`   Data dir: ${testDir}`);
}

async function testDbCreation() {
  const conv = hm.getOrCreateConversation('test-agent', 'agent:test-agent:webchat:main', {
    channelType: 'webchat',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  });

  console.assert(conv.id > 0, 'Conversation should have an ID');
  console.assert(conv.agentId === 'test-agent', 'Agent ID should match');
  console.assert(conv.channelType === 'webchat', 'Channel type should match');
  console.log('✅ DB creation + conversation');
}

async function testMessageRecording() {
  const msg1 = await hm.recordUserMessage('test-agent', 'agent:test-agent:webchat:main', 'Hello, this is a test message about Redis architecture.');
  console.assert(msg1.id > 0, 'Message should have an ID');
  console.assert(msg1.role === 'user', 'Role should be user');
  console.assert(msg1.textContent === 'Hello, this is a test message about Redis architecture.', 'Content should match');
  console.assert(msg1.messageIndex === 0, 'First message index should be 0');

  const msg2 = await hm.recordAssistantMessage('test-agent', 'agent:test-agent:webchat:main', {
    role: 'assistant',
    textContent: 'I recommend using Redis as the hot compositor layer with SQLite for persistence.',
    toolCalls: null,
    toolResults: null,
  });
  console.assert(msg2.messageIndex === 1, 'Second message index should be 1');

  const msg3 = await hm.recordUserMessage('test-agent', 'agent:test-agent:webchat:main', 'What about the SQLite schema for HyperMem?');
  console.assert(msg3.messageIndex === 2, 'Third message index should be 2');

  console.log('✅ Message recording (3 messages)');
}

async function testMessageRetrieval() {
  const db = hm.dbManager.getAgentDb('test-agent');
  const { MessageStore } = await import('../dist/message-store.js');
  const store = new MessageStore(db);

  const conv = store.getConversation('agent:test-agent:webchat:main');
  console.assert(conv !== null, 'Conversation should exist');
  console.assert(conv.messageCount === 3, `Message count should be 3, got ${conv.messageCount}`);

  const messages = store.getRecentMessages(conv.id, 10);
  console.assert(messages.length === 3, `Should have 3 messages, got ${messages.length}`);
  console.assert(messages[0].role === 'user', 'First message should be user');
  console.assert(messages[1].role === 'assistant', 'Second message should be assistant');

  console.log('✅ Message retrieval');
}

async function testFTS() {
  const results = hm.search('test-agent', 'Redis architecture');
  console.assert(results.length > 0, `FTS should return results, got ${results.length}`);
  console.assert(results[0].textContent.includes('Redis'), 'FTS result should contain search term');

  const noResults = hm.search('test-agent', 'nonexistent quantum blockchain');
  console.assert(noResults.length === 0, `FTS should return no results for garbage query, got ${noResults.length}`);

  console.log('✅ Full-text search');
}

async function testComposition() {
  const result = await hm.compose({
    agentId: 'test-agent',
    sessionKey: 'agent:test-agent:webchat:main',
    tokenBudget: 10000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    includeHistory: true,
    includeFacts: true,
    includeContext: false,
    includeLibrary: false,
  });

  console.assert(result.messages.length > 0, `Composition should produce messages, got ${result.messages.length}`);
  console.assert(result.tokenCount > 0, `Token count should be positive, got ${result.tokenCount}`);
  console.assert(result.slots.history > 0, `History slot should have tokens, got ${result.slots.history}`);

  // Check that messages are in provider format (Anthropic)
  const hasUserMsg = result.messages.some(m => m.role === 'user');
  const hasAssistantMsg = result.messages.some(m => m.role === 'assistant');
  console.assert(hasUserMsg, 'Should have user messages in output');
  console.assert(hasAssistantMsg, 'Should have assistant messages in output');

  console.log(`✅ Composition (${result.messages.length} messages, ~${result.tokenCount} tokens)`);
  console.log(`   Slots: system=${result.slots.system} identity=${result.slots.identity} history=${result.slots.history} facts=${result.slots.facts}`);
}

async function testMultiSession() {
  // Create a second session for the same agent
  await hm.recordUserMessage('test-agent', 'agent:test-agent:discord:council', 'Council discussion about HyperMem architecture.', {
    channelType: 'discord',
    channelId: '123456',
    provider: 'openai',
    model: 'gpt-5.4',
  });

  const agents = hm.listAgents();
  console.assert(agents.includes('test-agent'), 'Agent should be listed');

  const db = hm.dbManager.getAgentDb('test-agent');
  const { MessageStore } = await import('../dist/message-store.js');
  const store = new MessageStore(db);

  const allConvs = store.getConversations('test-agent');
  console.assert(allConvs.length === 2, `Should have 2 conversations, got ${allConvs.length}`);

  const webchatConvs = store.getConversations('test-agent', { channelType: 'webchat' });
  console.assert(webchatConvs.length === 1, `Should have 1 webchat conversation, got ${webchatConvs.length}`);

  // Cross-session message query
  const allMessages = store.getAgentMessages('test-agent', { limit: 100 });
  console.assert(allMessages.length === 4, `Should have 4 total messages across sessions, got ${allMessages.length}`);

  console.log('✅ Multi-session (2 conversations, 4 messages total)');
}

async function testProviderTranslation() {
  // Record a message with tool calls
  await hm.recordAssistantMessage('test-agent', 'agent:test-agent:webchat:main', {
    role: 'assistant',
    textContent: 'Let me check that for you.',
    toolCalls: [{
      id: 'hm_test001',
      name: 'exec',
      arguments: JSON.stringify({ command: 'ls -la' }),
    }],
    toolResults: null,
  });

  // Compose for Anthropic
  const anthropicResult = await hm.compose({
    agentId: 'test-agent',
    sessionKey: 'agent:test-agent:webchat:main',
    tokenBudget: 10000,
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  });

  // Compose for OpenAI
  const openaiResult = await hm.compose({
    agentId: 'test-agent',
    sessionKey: 'agent:test-agent:webchat:main',
    tokenBudget: 10000,
    provider: 'openai',
    model: 'gpt-5.4',
  });

  // Both should have messages but in different formats
  console.assert(anthropicResult.messages.length > 0, 'Anthropic composition should produce messages');
  console.assert(openaiResult.messages.length > 0, 'OpenAI composition should produce messages');

  // Find the tool call message in each
  const anthropicToolMsg = anthropicResult.messages.find(m =>
    m.role === 'assistant' && Array.isArray(m.content) && m.content.some(c => c.type === 'tool_use')
  );
  const openaiToolMsg = openaiResult.messages.find(m =>
    m.role === 'assistant' && m.tool_calls !== undefined
  );

  console.assert(anthropicToolMsg !== undefined, 'Anthropic output should have tool_use content block');
  console.assert(openaiToolMsg !== undefined, 'OpenAI output should have tool_calls field');

  console.log('✅ Provider translation (same data, different formats)');
}

async function cleanup() {
  await hm.close();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✅ Cleanup complete');
}

// ─── Run ─────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════');
console.log('  HyperMem Smoke Test');
console.log('═══════════════════════════════════════════════════');

try {
  await setup();
  await testDbCreation();
  await testMessageRecording();
  await testMessageRetrieval();
  await testFTS();
  await testComposition();
  await testMultiSession();
  await testProviderTranslation();
  await cleanup();
  console.log('═══════════════════════════════════════════════════');
  console.log('  ALL TESTS PASSED ✅');
  console.log('═══════════════════════════════════════════════════');
} catch (err) {
  console.error('❌ TEST FAILED:', err);
  try { await cleanup(); } catch { /* ignore */ }
  process.exit(1);
}
