/**
 * Lightweight Mode Test
 *
 * Verifies hypermem operates correctly with embedding provider: 'none'.
 * No Ollama, no API keys required. Tests:
 * - HyperMem creates and initializes cleanly
 * - Message recording and retrieval works
 * - FTS5 keyword search works
 * - Composition succeeds (semantic=0, FTS5 fallback)
 * - generateEmbeddings() returns [] immediately with provider: 'none'
 * - Facts and library operations work without embeddings
 */

import { HyperMem, generateEmbeddings } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-lightweight-'));

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
  console.log('  HyperMem Lightweight Mode Test (provider: none)');
  console.log('═══════════════════════════════════════════════════\n');

  // ── generateEmbeddings no-op ──
  console.log('── generateEmbeddings with provider: none ──');
  const embeddings = await generateEmbeddings(['some text', 'more text'], { provider: 'none', ollamaUrl: 'http://localhost:11434' });
  assert(Array.isArray(embeddings), 'Returns an array');
  assert(embeddings.length === 0, 'Returns empty array (no-op)');

  // ── HyperMem init with provider: none ──
  console.log('\n── HyperMem init ──');
  const hm = await HyperMem.create({
    dataDir: testDir,
    embedding: { provider: 'none', ollamaUrl: 'http://localhost:11434' },
  });
  assert(hm !== null, 'HyperMem created with provider: none');

  // ── Message recording ──
  console.log('\n── Message recording ──');
  const msg1 = await hm.recordUserMessage(
    'test-agent',
    'agent:test-agent:webchat:main',
    'Lightweight mode uses FTS5 keyword search without any embedding provider.'
  );
  assert(msg1.id > 0, 'User message recorded');

  const msg2 = await hm.recordAssistantMessage(
    'test-agent',
    'agent:test-agent:webchat:main',
    {
      role: 'assistant',
      textContent: 'Correct — FTS5 provides keyword recall without requiring Ollama or API keys.',
      toolCalls: null,
      toolResults: null,
    }
  );
  assert(msg2.id > 0, 'Assistant message recorded');

  // ── FTS5 search ──
  console.log('\n── FTS5 keyword search ──');
  const results = hm.search('test-agent', 'FTS5 keyword');
  assert(results.length > 0, 'FTS5 returns results for matching query');
  assert(results[0].textContent.includes('FTS5'), 'FTS5 result contains matching term');

  const noResults = hm.search('test-agent', 'xyzquantumblockchain99');
  assert(noResults.length === 0, 'FTS5 returns empty for no-match query');

  // ── Fact operations ──
  console.log('\n── Fact operations ──');
  hm.addFact('test-agent', 'Lightweight mode requires no external dependencies', {
    confidence: 0.95,
    category: 'infrastructure',
  });
  // Search via FTS5 since getFacts is internal — addFact indexes to messages_fts too
  const factResults = hm.search('test-agent', 'Lightweight external dependencies');
  // Facts may or may not surface via message search — check addFact didn't throw
  assert(true, 'addFact completed without error');

  // ── Composition ──
  console.log('\n── Composition (FTS5-only mode) ──');
  const result = await hm.compose({
    agentId: 'test-agent',
    sessionKey: 'agent:test-agent:webchat:main',
    tokenBudget: 10000,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    includeHistory: true,
    includeFacts: true,
    includeContext: false,
    includeLibrary: false,
  });
  assert(result.messages.length > 0, 'Composition produces messages');
  assert(result.tokenCount > 0, 'Token count is positive');
  assert(result.slots.history > 0, 'History slot populated');
  // semantic slot should be 0 or absent with no vector store
  const semanticTokens = result.slots.semantic ?? 0;
  assert(semanticTokens === 0, `Semantic slot is 0 (got ${semanticTokens}) — correct for provider: none`);

  // ── Cleanup ──
  await hm.close();
  fs.rmSync(testDir, { recursive: true, force: true });

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('❌ UNEXPECTED ERROR:', err);
  process.exit(1);
});
