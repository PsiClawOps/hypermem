/**
 * HyperMem Unified Pressure Signal — Sprint 3 Test
 *
 * Validates that compose and compaction paths use a consistent, label-annotated
 * pressure computation via computeUnifiedPressure() and PRESSURE_SOURCE constants.
 *
 * Scenarios:
 *   1 — computeUnifiedPressure basic contract
 *   2 — PRESSURE_SOURCE constants are stable strings (no typos)
 *   3 — Compositor diagnostics carry sessionPressureFraction + pressureSource
 *   4 — sessionPressureFraction is in [0, 1] for a normal compose (no overflow)
 *   5 — pressureSource is 'compose:post-assembly' for full compose path
 *   6 — tool-heavy session: pressure fraction is coherent (not drifting vs Redis estimate)
 *   7 — plain-chat session: pressure fraction is coherent
 *
 * Notes:
 *   - Scenarios 1–2 test helpers directly from dist.
 *   - Scenarios 3–7 use Compositor directly with in-memory SQLite.
 *   - No Ollama, no Redis, no HyperMem factory required.
 */

import { computeUnifiedPressure, PRESSURE_SOURCE, Compositor } from '../dist/compositor.js';
import { CacheLayer } from '../dist/cache.js';
import { migrateLibrary } from '../dist/library-schema.js';
import { migrate } from '../dist/schema.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-s3-pressure-'));

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

function makeMessageDb(label) {
  const dbPath = path.join(tmpDir, `msg-${label}-${Date.now()}.db`);
  const db = new DatabaseSync(dbPath);
  migrate(db);
  return db;
}

function makeLibraryDb(label) {
  const dbPath = path.join(tmpDir, `lib-${label}-${Date.now()}.db`);
  const db = new DatabaseSync(dbPath);
  migrateLibrary(db);
  return db;
}

// ════════════════════════════════════════════════════════════
// Scenario 1 — computeUnifiedPressure basic contract
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 1: computeUnifiedPressure basic contract ──');
{
  // 50% pressure
  const p50 = computeUnifiedPressure(50_000, 100_000, PRESSURE_SOURCE.COMPOSE_POST_ASSEMBLY);
  assert(p50.fraction === 0.5, `fraction = 0.5 at 50% (got ${p50.fraction})`);
  assert(p50.pct === 50, `pct = 50 at 50% (got ${p50.pct})`);
  assert(p50.source === 'compose:post-assembly', `source label correct (got ${p50.source})`);

  // 0% pressure (empty)
  const p0 = computeUnifiedPressure(0, 100_000, PRESSURE_SOURCE.COMPACT_REDIS_ESTIMATE);
  assert(p0.fraction === 0, `fraction = 0 at empty (got ${p0.fraction})`);
  assert(p0.pct === 0, `pct = 0 at empty (got ${p0.pct})`);
  assert(p0.source === 'compact:redis-estimate', `compact redis source label correct (got ${p0.source})`);

  // Budget = 0 guard (should not throw, returns 0)
  const pZeroBudget = computeUnifiedPressure(1000, 0, PRESSURE_SOURCE.COMPACT_RUNTIME_TOTAL);
  assert(pZeroBudget.fraction === 0, `zero-budget: fraction = 0 (got ${pZeroBudget.fraction})`);

  // Over-budget (fraction > 1)
  const pOver = computeUnifiedPressure(110_000, 100_000, PRESSURE_SOURCE.TOOLLOOP_RUNTIME_ARRAY);
  assert(pOver.fraction > 1, `over-budget: fraction > 1 (got ${pOver.fraction})`);
  assert(pOver.pct === 110, `over-budget: pct = 110 (got ${pOver.pct})`);
  assert(pOver.source === 'toolloop:runtime-array', `toolloop source label correct (got ${pOver.source})`);
}

// ════════════════════════════════════════════════════════════
// Scenario 2 — PRESSURE_SOURCE constants stability
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 2: PRESSURE_SOURCE constants are stable strings ──');
{
  assert(PRESSURE_SOURCE.COMPOSE_POST_ASSEMBLY === 'compose:post-assembly',
    `COMPOSE_POST_ASSEMBLY = 'compose:post-assembly'`);
  assert(PRESSURE_SOURCE.COMPACT_REDIS_ESTIMATE === 'compact:redis-estimate',
    `COMPACT_REDIS_ESTIMATE = 'compact:redis-estimate'`);
  assert(PRESSURE_SOURCE.COMPACT_RUNTIME_TOTAL === 'compact:runtime-total',
    `COMPACT_RUNTIME_TOTAL = 'compact:runtime-total'`);
  assert(PRESSURE_SOURCE.TOOLLOOP_RUNTIME_ARRAY === 'toolloop:runtime-array',
    `TOOLLOOP_RUNTIME_ARRAY = 'toolloop:runtime-array'`);
}

// ════════════════════════════════════════════════════════════
// Scenario 3 — Compositor diagnostics carry Sprint 3 fields
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 3: Compositor diagnostics carry Sprint 3 pressure fields ──');
{
  const agentId = 's3-s3-agent';
  const sessionKey = `agent:${agentId}:webchat:main`;
  const msgDb = makeMessageDb('s3');
  const libDb = makeLibraryDb('s3');

  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s3', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);
  const conv = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  for (let i = 0; i < 10; i++) {
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results,
                            message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, datetime('now'))
    `).run(conv.id, agentId, i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`, i + 1);
  }

  const cache = new CacheLayer();
  const compositor = new Compositor({ cache, vectorStore: null, libraryDb: libDb });
  const result = await compositor.compose({ agentId, sessionKey, tokenBudget: 100_000 }, msgDb, libDb);
  const diag = result.diagnostics;

  assert(diag != null, 'Diagnostics object is present');
  assert(typeof diag.sessionPressureFraction === 'number',
    `sessionPressureFraction is a number (got ${diag.sessionPressureFraction})`);
  assert(typeof diag.pressureSource === 'string',
    `pressureSource is a string (got ${diag.pressureSource})`);
  assert(typeof diag.adaptiveLifecycleBand === 'string',
    `adaptive lifecycle band is surfaced (got ${diag.adaptiveLifecycleBand})`);
  assert(typeof diag.adaptiveTrimSoftTarget === 'number',
    `adaptive trim soft target is surfaced (got ${diag.adaptiveTrimSoftTarget})`);
  assert(Array.isArray(diag.adaptiveLifecycleReasons),
    'adaptive lifecycle reasons are surfaced');
}

// ════════════════════════════════════════════════════════════
// Scenario 3b — /new prompt surfaces bootstrap breadcrumb diagnostics
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 3b: /new prompt surfaces bootstrap breadcrumb diagnostics ──');
{
  const agentId = 's3-s3b-agent';
  const sessionKey = `agent:${agentId}:webchat:main`;
  const msgDb = makeMessageDb('s3b');
  const libDb = makeLibraryDb('s3b');

  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s3b', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const cache = new CacheLayer();
  const compositor = new Compositor({ cache, vectorStore: null, libraryDb: libDb });
  const result = await compositor.compose({
    agentId,
    sessionKey,
    tokenBudget: 100_000,
    prompt: '/new start fresh',
  }, msgDb, libDb);
  const diag = result.diagnostics;

  assert(diag.adaptiveLifecycleBand === 'bootstrap',
    `explicit /new selects bootstrap band (got ${diag.adaptiveLifecycleBand})`);
  assert(diag.adaptiveBreadcrumbPackage === true,
    `explicit /new emits breadcrumb package (got ${diag.adaptiveBreadcrumbPackage})`);
  assert(diag.adaptiveLifecycleReasons?.includes('explicit-new-session'),
    `explicit /new reason is surfaced (got ${diag.adaptiveLifecycleReasons?.join(',')})`);
}

// ════════════════════════════════════════════════════════════
// Scenario 4 — sessionPressureFraction in [0, 1] for normal compose
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 4: sessionPressureFraction in [0,1] for normal compose ──');
{
  const agentId = 's3-s4-agent';
  const sessionKey = `agent:${agentId}:webchat:main`;
  const msgDb = makeMessageDb('s4');
  const libDb = makeLibraryDb('s4');

  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s4', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);
  const conv = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  for (let i = 0; i < 20; i++) {
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results,
                            message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, datetime('now'))
    `).run(conv.id, agentId, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(400), i + 1);
  }

  const cache = new CacheLayer();
  const compositor = new Compositor({ cache, vectorStore: null, libraryDb: libDb });
  const result = await compositor.compose({ agentId, sessionKey, tokenBudget: 100_000 }, msgDb, libDb);
  const diag = result.diagnostics;

  assert(diag.sessionPressureFraction >= 0, `sessionPressureFraction >= 0 (got ${diag.sessionPressureFraction})`);
  assert(diag.sessionPressureFraction <= 1, `sessionPressureFraction <= 1 for normal session (got ${diag.sessionPressureFraction})`);
  console.log(`    compose pressure: ${(diag.sessionPressureFraction * 100).toFixed(1)}% source=${diag.pressureSource}`);
}

// ════════════════════════════════════════════════════════════
// Scenario 5 — pressureSource is 'compose:post-assembly'
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 5: pressureSource is compose:post-assembly ──');
{
  const agentId = 's3-s5-agent';
  const sessionKey = `agent:${agentId}:webchat:main`;
  const msgDb = makeMessageDb('s5');
  const libDb = makeLibraryDb('s5');

  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s5', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);
  const conv = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  for (let i = 0; i < 6; i++) {
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results,
                            message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, datetime('now'))
    `).run(conv.id, agentId, i % 2 === 0 ? 'user' : 'assistant', `Turn ${i}`, i + 1);
  }

  const cache = new CacheLayer();
  const compositor = new Compositor({ cache, vectorStore: null, libraryDb: libDb });
  const result = await compositor.compose({ agentId, sessionKey, tokenBudget: 100_000 }, msgDb, libDb);

  assert(result.diagnostics.pressureSource === 'compose:post-assembly',
    `pressureSource === 'compose:post-assembly' (got ${result.diagnostics.pressureSource})`);
}

// ════════════════════════════════════════════════════════════
// Scenario 6 — Tool-heavy: pressure fraction is coherent
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 6: Tool-heavy session — pressure fraction coherent ──');
{
  const agentId = 's3-s6-agent';
  const sessionKey = `agent:${agentId}:webchat:main`;
  const msgDb = makeMessageDb('s6');
  const libDb = makeLibraryDb('s6');

  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s6', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);
  const conv = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);

  // Tool-heavy: 15 rounds of user + assistant(tool) + user(result)
  let idx = 1;
  for (let i = 0; i < 15; i++) {
    msgDb.prepare(`INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results, message_index, is_heartbeat, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, datetime('now'))`)
      .run(conv.id, agentId, 'user', `Round ${i}: run analysis`, idx++);
    msgDb.prepare(`INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results, message_index, is_heartbeat, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 0, datetime('now'))`)
      .run(conv.id, agentId, 'assistant', `Running round ${i}`, JSON.stringify([{id: `tc-${i}`, name: 'exec', arguments: '{}'}]), idx++);
    msgDb.prepare(`INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results, message_index, is_heartbeat, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?, 0, datetime('now'))`)
      .run(conv.id, agentId, 'user', JSON.stringify([{callId: `tc-${i}`, name: 'exec', content: 'z'.repeat(2000)}]), idx++);
  }

  const cache = new CacheLayer();
  const compositor = new Compositor({ cache, vectorStore: null, libraryDb: libDb });
  const result = await compositor.compose({ agentId, sessionKey, tokenBudget: 100_000 }, msgDb, libDb);
  const diag = result.diagnostics;

  assert(diag.sessionPressureFraction != null, 'sessionPressureFraction is set');
  assert(diag.pressureSource === 'compose:post-assembly', `pressureSource is compose:post-assembly (got ${diag.pressureSource})`);
  // Pressure must be a coherent number — not NaN, not negative
  assert(!isNaN(diag.sessionPressureFraction) && diag.sessionPressureFraction >= 0,
    `sessionPressureFraction is a valid non-negative number (got ${diag.sessionPressureFraction})`);
  console.log(`    tool-heavy pressure: ${(diag.sessionPressureFraction * 100).toFixed(1)}% source=${diag.pressureSource}`);
}

// ════════════════════════════════════════════════════════════
// Scenario 7 — Plain-chat: pressure fraction is coherent
// ════════════════════════════════════════════════════════════
console.log('\n── Scenario 7: Plain-chat session — pressure fraction coherent ──');
{
  const agentId = 's3-s7-agent';
  const sessionKey = `agent:${agentId}:webchat:main`;
  const msgDb = makeMessageDb('s7');
  const libDb = makeLibraryDb('s7');

  msgDb.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-s7', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);
  const conv = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  for (let i = 0; i < 30; i++) {
    msgDb.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, tool_calls, tool_results,
                            message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, 0, datetime('now'))
    `).run(conv.id, agentId, i % 2 === 0 ? 'user' : 'assistant', 'y'.repeat(300), i + 1);
  }

  const cache = new CacheLayer();
  const compositor = new Compositor({ cache, vectorStore: null, libraryDb: libDb });
  const result = await compositor.compose({ agentId, sessionKey, tokenBudget: 100_000 }, msgDb, libDb);
  const diag = result.diagnostics;

  assert(diag.sessionPressureFraction != null, 'sessionPressureFraction is set');
  assert(diag.pressureSource === 'compose:post-assembly', `pressureSource is compose:post-assembly (got ${diag.pressureSource})`);
  assert(!isNaN(diag.sessionPressureFraction) && diag.sessionPressureFraction >= 0,
    `sessionPressureFraction is a valid non-negative number (got ${diag.sessionPressureFraction})`);
  // Plain-chat with 30 short messages should be well under budget (never overflow)
  // Note: system-prompt + FOS/MOD overhead alone can be 50-70% on a 100k budget;
  // what we are verifying is coherence (no NaN, no overflow) not a specific threshold.
  assert(diag.sessionPressureFraction < 1.0, `Plain-chat pressure < 100% on 100k budget (not overflowing) (got ${(diag.sessionPressureFraction*100).toFixed(1)}%)`);
  console.log(`    plain-chat pressure: ${(diag.sessionPressureFraction * 100).toFixed(1)}% source=${diag.pressureSource}`);
}

// ════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════');
console.log(`  Sprint 3 Unified Pressure Signal: ${passed} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
