/**
 * test/spawn-context.mjs — HyperMem 0.3.0 Subagent Context Inheritance
 *
 * Tests:
 *   S1: getRecentTurns returns correct turns in chronological order, strips tool calls
 *   S2: buildSpawnContext with workingSnapshot:5 produces a non-null parentContextBlock
 *   S3: documents injection — a real file gets chunked and stored with the spawn sessionKey
 *   S4: Session isolation — chunks stored with spawn sessionKey A don't appear when querying sessionKey B
 *   S5: Empty parent session returns null parentContextBlock gracefully (no crash)
 *   S6: Missing document file is skipped, added to documentsSkipped, doesn't fail
 */

import { HyperMem, buildSpawnContext } from '../dist/index.js';
import { MessageStore } from '../dist/message-store.js';
import { DocChunkStore } from '../dist/doc-chunk-store.js';
import { DatabaseManager } from '../dist/db.js';
import fs from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const testDir = path.join(os.tmpdir(), `hm-spawn-test-${Date.now()}`);
fs.mkdirSync(testDir, { recursive: true });

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function assertEq(actual, expected, msg) {
  if (actual === expected) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ─── Setup ──────────────────────────────────────────────────────

let hm;
let dbManager;

async function setup() {
  hm = await HyperMem.create({
    dataDir: testDir,
  });

  dbManager = hm.dbManager;
  console.log(`  HyperMem: data dir ${testDir}`);
  console.log(`  Redis: ${hm.cache.isConnected ? 'connected' : 'unavailable (SQLite-only mode)'}`);
}

async function teardown() {
  await hm.close();
  fs.rmSync(testDir, { recursive: true, force: true });
}

// ─── S1: getRecentTurns ─────────────────────────────────────────

async function testS1_getRecentTurns() {
  console.log('\nS1: getRecentTurns — chronological order, tool calls stripped');

  const agentId = 'test-spawn-s1';
  const sessionKey = `agent:${agentId}:webchat:main`;

  // Seed messages (user + assistant + user with tool call result)
  await hm.recordUserMessage(agentId, sessionKey, 'Hello, what is the capital of France?');
  await hm.recordAssistantMessage(agentId, sessionKey, {
    role: 'assistant',
    textContent: 'The capital of France is Paris.',
    toolCalls: null,
    toolResults: null,
  });
  await hm.recordUserMessage(agentId, sessionKey, 'Can you search for more details?');
  // Assistant message with tool call (text + tool call)
  await hm.recordAssistantMessage(agentId, sessionKey, {
    role: 'assistant',
    textContent: 'Let me search for that.',
    toolCalls: [{ id: 'hm_abc123', name: 'web_search', arguments: '{"query":"Paris France"}' }],
    toolResults: null,
  });

  const db = dbManager.getMessageDb(agentId);
  const store = new MessageStore(db);

  const turns = store.getRecentTurns(sessionKey, 10);

  assert(Array.isArray(turns), 'Returns an array');
  assert(turns.length === 4, `Returns 4 turns (got ${turns.length})`);

  // Chronological order: seq should be ascending
  assert(turns[0].seq <= turns[1].seq && turns[1].seq <= turns[2].seq, 'Turns in chronological order (seq ascending)');

  // First turn is user
  assertEq(turns[0].role, 'user', 'First turn role is user');
  assert(turns[0].content.includes('France'), 'First turn content includes question text');

  // Second turn is assistant
  assertEq(turns[1].role, 'assistant', 'Second turn role is assistant');
  assert(turns[1].content.includes('Paris'), 'Second turn content includes answer text');

  // Fourth turn: tool call text preserved, but no raw tool call JSON in content
  assertEq(turns[3].role, 'assistant', 'Fourth turn role is assistant');
  assert(turns[3].content.includes('Let me search'), 'Fourth turn text content preserved');
  assert(!turns[3].content.includes('hm_abc123'), 'Tool call ID not leaked into text content');

  // timestamp is a number
  assert(typeof turns[0].timestamp === 'number' && turns[0].timestamp > 0, 'Timestamp is a positive number');

  // Limit: only get last 2
  const last2 = store.getRecentTurns(sessionKey, 2);
  assertEq(last2.length, 2, 'Limit n=2 returns exactly 2 turns');
  assert(last2[0].seq > turns[0].seq, 'Limit n=2 returns the most recent turns');

  // Capped at 50
  const capped = store.getRecentTurns(sessionKey, 200);
  assert(capped.length <= 50, 'Capped at 50 turns max');
}

// ─── S2: buildSpawnContext produces parentContextBlock ───────────

async function testS2_buildSpawnContext() {
  console.log('\nS2: buildSpawnContext with workingSnapshot:5');

  const agentId = 'test-spawn-s2';
  const sessionKey = `agent:${agentId}:webchat:main`;

  // Seed 8 messages
  for (let i = 0; i < 4; i++) {
    await hm.recordUserMessage(agentId, sessionKey, `User message ${i} about infrastructure and deployment.`);
    await hm.recordAssistantMessage(agentId, sessionKey, {
      role: 'assistant',
      textContent: `Assistant reply ${i} about architecture patterns.`,
      toolCalls: null,
      toolResults: null,
    });
  }

  const db = dbManager.getMessageDb(agentId);
  const messageStore = new MessageStore(db);
  const libDb = dbManager.getLibraryDb();
  const docChunkStore = new DocChunkStore(libDb);

  const ctx = await buildSpawnContext(messageStore, docChunkStore, agentId, {
    parentSessionKey: sessionKey,
    workingSnapshot: 5,
  });

  assert(ctx !== null, 'Returns a SpawnContext object');
  assert(typeof ctx.sessionKey === 'string', 'sessionKey is a string');
  assert(ctx.sessionKey.startsWith(`spawn:${agentId}:`), 'sessionKey has correct prefix');
  assert(ctx.parentContextBlock !== null, 'parentContextBlock is non-null');
  assert(ctx.parentContextBlock.includes('Parent Session Context'), 'parentContextBlock contains header');
  assert(ctx.parentContextBlock.includes(sessionKey), 'parentContextBlock includes session key');
  assert(ctx.summary.turnsIncluded > 0, `turnsIncluded > 0 (got ${ctx.summary.turnsIncluded})`);
  assert(ctx.summary.turnsIncluded <= 5, `turnsIncluded <= 5 (workingSnapshot, got ${ctx.summary.turnsIncluded})`);
  assert(ctx.summary.tokenEstimate > 0, 'tokenEstimate > 0');
  assertEq(ctx.summary.documentsSkipped.length, 0, 'No documents skipped');
  assertEq(ctx.summary.documentsIndexed, 0, 'No documents indexed (none provided)');
}

// ─── S3: Documents injection ─────────────────────────────────────

async function testS3_documentsInjection() {
  console.log('\nS3: documents injection — file gets chunked and stored with spawn sessionKey');

  const agentId = 'test-spawn-s3';
  const sessionKey = `agent:${agentId}:webchat:main`;

  // Seed a message so getRecentTurns has something
  await hm.recordUserMessage(agentId, sessionKey, 'Starting task.');

  // Create a real temp file
  const docPath = path.join(testDir, 'test-doc-s3.md');
  await writeFile(docPath, [
    '# HyperMem Architecture',
    '',
    'HyperMem uses a four-layer architecture for context management.',
    '',
    'L1 Redis handles hot session working memory.',
    '',
    'L2 SQLite stores per-agent conversation logs that are rotatable.',
    '',
    'L3 Vectors provides per-agent semantic search via sqlite-vec.',
    '',
    'L4 Library is the fleet-wide structured knowledge crown jewel.',
    '',
    'Each layer has distinct durability and performance characteristics.',
    '',
    'The compositor assembles context from all layers at compose time.',
  ].join('\n'), 'utf8');

  const db = dbManager.getMessageDb(agentId);
  const messageStore = new MessageStore(db);
  const libDb = dbManager.getLibraryDb();
  const docChunkStore = new DocChunkStore(libDb);

  const ctx = await buildSpawnContext(messageStore, docChunkStore, agentId, {
    parentSessionKey: sessionKey,
    workingSnapshot: 5,
    documents: [docPath],
  });

  assert(ctx.summary.documentsIndexed === 1, `documentsIndexed === 1 (got ${ctx.summary.documentsIndexed})`);
  assertEq(ctx.summary.documentsSkipped.length, 0, 'No documents skipped');

  // Query back the chunks for this spawn session
  const chunks = docChunkStore.queryDocChunks(agentId, 'architecture', { sessionKey: ctx.sessionKey });
  assert(chunks.length > 0, `Querying with spawn sessionKey returns chunks (got ${chunks.length})`);
  assert(chunks.every(c => c.content.length > 0), 'All returned chunks have content');

  // Cleanup
  await rm(docPath);
}

// ─── S4: Session isolation ───────────────────────────────────────

async function testS4_sessionIsolation() {
  console.log('\nS4: Session isolation — chunks under sessionKey A don\'t appear in sessionKey B query');

  const agentId = 'test-spawn-s4';
  const sessionKey = `agent:${agentId}:webchat:main`;

  await hm.recordUserMessage(agentId, sessionKey, 'Isolation test.');

  const docPath = path.join(testDir, 'isolation-doc.md');
  await writeFile(docPath, [
    '# Isolation Document',
    '',
    'This content is unique to session A and must not appear in session B.',
    '',
    'The content uses very specific words: ZEPHYR_UNIQUE_TOKEN_S4A.',
  ].join('\n'), 'utf8');

  const db = dbManager.getMessageDb(agentId);
  const messageStore = new MessageStore(db);
  const libDb = dbManager.getLibraryDb();
  const docChunkStore = new DocChunkStore(libDb);

  // Build context for spawn A
  const ctxA = await buildSpawnContext(messageStore, docChunkStore, agentId, {
    parentSessionKey: sessionKey,
    documents: [docPath],
  });

  // Use a different session key B
  const sessionKeyB = `spawn:${agentId}:9999999`;

  // Query with sessionKey B — should return nothing about our unique token
  const chunksB = docChunkStore.queryDocChunks(agentId, 'ZEPHYR_UNIQUE_TOKEN_S4A', {
    sessionKey: sessionKeyB,
  });
  assertEq(chunksB.length, 0, 'Session B returns no chunks from session A');

  // Query with sessionKey A — should find our content
  const chunksA = docChunkStore.queryDocChunks(agentId, 'ZEPHYR_UNIQUE_TOKEN_S4A', {
    sessionKey: ctxA.sessionKey,
  });
  assert(chunksA.length > 0, 'Session A finds its own chunks');

  // Cleanup: clear session A chunks
  const cleared = docChunkStore.clearSessionChunks(ctxA.sessionKey);
  assert(cleared > 0, `clearSessionChunks removed ${cleared} chunks`);

  // Verify cleared
  const afterClear = docChunkStore.queryDocChunks(agentId, 'ZEPHYR_UNIQUE_TOKEN_S4A', {
    sessionKey: ctxA.sessionKey,
  });
  assertEq(afterClear.length, 0, 'After clearSessionChunks, session A chunks are gone');

  await rm(docPath);
}

// ─── S5: Empty parent session ────────────────────────────────────

async function testS5_emptyParentSession() {
  console.log('\nS5: Empty parent session returns null parentContextBlock gracefully');

  const agentId = 'test-spawn-s5';
  const libDb = dbManager.getLibraryDb();

  // Use a fake session key that has no messages
  const db = dbManager.getMessageDb(agentId);
  const messageStore = new MessageStore(db);
  const docChunkStore = new DocChunkStore(libDb);

  let ctx;
  let threw = false;
  try {
    ctx = await buildSpawnContext(messageStore, docChunkStore, agentId, {
      parentSessionKey: 'agent:nonexistent:webchat:does-not-exist',
      workingSnapshot: 10,
    });
  } catch (err) {
    threw = true;
    console.error('  Threw unexpectedly:', err.message);
  }

  assert(!threw, 'Does not throw when parent session is empty');
  assert(ctx !== null, 'Returns a SpawnContext object');
  assertEq(ctx.parentContextBlock, null, 'parentContextBlock is null for empty session');
  assertEq(ctx.summary.turnsIncluded, 0, 'turnsIncluded is 0');
  assert(typeof ctx.sessionKey === 'string', 'sessionKey is still generated');
}

// ─── S6: Missing document file ───────────────────────────────────

async function testS6_missingDocument() {
  console.log('\nS6: Missing document file is skipped, added to documentsSkipped, doesn\'t fail');

  const agentId = 'test-spawn-s6';
  const sessionKey = `agent:${agentId}:webchat:main`;

  await hm.recordUserMessage(agentId, sessionKey, 'Test with missing docs.');

  const db = dbManager.getMessageDb(agentId);
  const messageStore = new MessageStore(db);
  const libDb = dbManager.getLibraryDb();
  const docChunkStore = new DocChunkStore(libDb);

  const missingPath = '/tmp/this-file-does-not-exist-hypermem-spawn-test.md';

  let ctx;
  let threw = false;
  try {
    ctx = await buildSpawnContext(messageStore, docChunkStore, agentId, {
      parentSessionKey: sessionKey,
      documents: [missingPath],
    });
  } catch (err) {
    threw = true;
    console.error('  Threw unexpectedly:', err.message);
  }

  assert(!threw, 'Does not throw when document file is missing');
  assert(ctx !== null, 'Returns a SpawnContext object');
  assertEq(ctx.summary.documentsIndexed, 0, 'documentsIndexed is 0 (no file was indexed)');
  assert(ctx.summary.documentsSkipped.includes(missingPath), 'Missing file path in documentsSkipped');
  assertEq(ctx.summary.documentsSkipped.length, 1, 'documentsSkipped has 1 entry');
}

// ─── Runner ─────────────────────────────────────────────────────

async function run() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  HyperMem 0.3.0 — Subagent Context Inheritance Tests');
  console.log('═══════════════════════════════════════════════════════════\n');

  await setup();

  try {
    await testS1_getRecentTurns();
    await testS2_buildSpawnContext();
    await testS3_documentsInjection();
    await testS4_sessionIsolation();
    await testS5_emptyParentSession();
    await testS6_missingDocument();
  } finally {
    await teardown();
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
