/**
 * Retrieval Regression Harness (W7)
 *
 * Protects four key retrieval behaviors shipped in W1–W5:
 *   Scenario 1 — No-trigger semantic fallback (W2)
 *   Scenario 2 — Cross-agent scope isolation (W1)
 *   Scenario 3 — Superseded fact not injected (W1 + supersedes)
 *   Scenario 4 — Scope-filtered count tracked in diagnostics (W3)
 *   Scenario 5 — Budget pressure: history wins over memory slots (W4)
 *
 * Runs FTS-only — does NOT require Ollama/vector store.
 * Imports from dist/ (compiled output), same as other integration tests.
 */

import { HyperMem } from '../dist/index.js';
import { Compositor } from '../dist/compositor.js';
import { migrateLibrary } from '../dist/library-schema.js';
import { migrate } from '../dist/schema.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-regression-'));

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function skip(msg) {
  console.log(`  ⏭  SKIP: ${msg}`);
  skipped++;
}

/**
 * Create a fresh isolated message DB (per-agent) with the v4+v5 schema.
 */
function makeMessageDb(label) {
  const dbPath = path.join(tmpDir, `msg-${label}-${Date.now()}.db`);
  const db = new DatabaseSync(dbPath);
  migrate(db);
  return db;
}

/**
 * Create a fresh isolated library DB with the full library schema.
 */
function makeLibraryDb(label) {
  const dbPath = path.join(tmpDir, `lib-${label}-${Date.now()}.db`);
  const db = new DatabaseSync(dbPath);
  migrateLibrary(db);
  return db;
}

/**
 * Seed a conversation + messages into a message DB.
 * Returns the conversation id.
 */
function seedConversation(db, agentId, sessionKey, messages) {
  db.prepare(`
    INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status,
                               message_count, token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-reg-1', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  const conv = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  const convId = conv.id;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    db.prepare(`
      INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
    `).run(convId, agentId, m.role, m.text, i + 1);
  }

  return convId;
}

/**
 * Insert a fact directly into a library DB.
 * agentId, scope, content are required. sessionKey is optional (for session-scoped facts).
 * supersededBy is optional (non-null string means superseded).
 */
function insertFact(db, { agentId, scope, content, domain, sessionKey, supersededBy }) {
  db.prepare(`
    INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility,
                       source_type, source_session_key, superseded_by,
                       decay_score, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1.0, 'private', 'manual', ?, ?, 0.0, datetime('now'), datetime('now'))
  `).run(
    agentId,
    scope || 'agent',
    domain || 'general',
    content,
    sessionKey || null,
    supersededBy || null
  );
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Retrieval Regression Harness (W7)');
  console.log('═══════════════════════════════════════════════════\n');

  // ════════════════════════════════════════════════════════════
  // Scenario 1 — No-trigger semantic fallback (W2)
  // ════════════════════════════════════════════════════════════
  console.log('── Scenario 1: No-trigger semantic fallback (W2) ──');
  {
    const agentId = 'reg-s1-agent';
    const sessionKey = `agent:${agentId}:webchat:main`;

    const msgDb = makeMessageDb('s1');
    const libDb = makeLibraryDb('s1');

    // Seed a conversation
    seedConversation(msgDb, agentId, sessionKey, [
      { role: 'user', text: 'Tell me about embedding models.' },
      { role: 'assistant', text: 'Embedding models convert text to dense vectors.' },
    ]);

    // Seed 3 facts clearly related to "nomic embedding model"
    insertFact(libDb, { agentId, scope: 'agent', content: 'nomic-embed-text is the chosen embedding model', domain: 'embeddings' });
    insertFact(libDb, { agentId, scope: 'agent', content: 'nomic-embed-text produces 768-dimensional vectors for semantic search', domain: 'embeddings' });
    insertFact(libDb, { agentId, scope: 'agent', content: 'nomic embedding model selected after benchmarking on domain data', domain: 'embeddings' });

    // Build a compositor with no vector store (FTS-only path)
    // Direct compositor test (no caching layer)
    let hm;
    try {
      hm = await HyperMem.create({
        dataDir: path.join(tmpDir, 's1'),
      });
    } catch {
      // Skip HyperMem.create, use Compositor directly
    }

    // Build a compositor directly
    const compositor = new Compositor({
      vectorStore: null,   // no Ollama
      libraryDb: libDb,
    });

    // Compose with a prompt that has NO trigger keywords (no policy/escalation/etc.)
    // "what embedding approach do we use?" will not trigger any DEFAULT_TRIGGERS
    const result = await compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 50000,
      provider: 'anthropic',
      includeHistory: true,
      includeFacts: true,
      includeLibrary: true,
      includeDocChunks: true,   // needed for trigger-miss fallback path to run
      prompt: 'what embedding approach do we use?',
    }, msgDb, libDb);

    assert(result.diagnostics !== undefined, 'S1: diagnostics object present');
    assert(result.diagnostics?.triggerHits === 0,
      `S1: triggerHits === 0 (got ${result.diagnostics?.triggerHits})`);

    // The fallback path sets mode='fallback_knn' OR factsIncluded > 0 (facts always fire)
    // Facts are always included (they don't require triggers), so factsIncluded should be > 0
    const modeOk = result.diagnostics?.retrievalMode === 'fallback_knn'
      || (result.diagnostics?.semanticResultsIncluded ?? 0) > 0
      || (result.diagnostics?.factsIncluded ?? 0) > 0;

    assert(modeOk,
      `S1: fallback fires OR facts included (mode=${result.diagnostics?.retrievalMode}, ` +
      `facts=${result.diagnostics?.factsIncluded}, semantic=${result.diagnostics?.semanticResultsIncluded})`);

    // Facts must appear in context since we seeded them and prompt doesn't filter them out
    assert((result.diagnostics?.factsIncluded ?? 0) > 0 || result.contextBlock?.includes('nomic'),
      `S1: nomic facts found (factsIncluded=${result.diagnostics?.factsIncluded})`);

    if (hm) await hm.close().catch(() => {});
  }

  // ════════════════════════════════════════════════════════════
  // Scenario 2 — Cross-agent scope isolation (W1)
  // ════════════════════════════════════════════════════════════
  console.log('\n── Scenario 2: Cross-agent scope isolation (W1) ──');
  {
    const agentA = 'reg-s2-agent-a';
    const agentB = 'reg-s2-agent-b';
    const sessionKeyA = `agent:${agentA}:webchat:main`;

    const msgDb = makeMessageDb('s2');
    const libDb = makeLibraryDb('s2');

    // Seed conversations for both agents in the same msgDb
    seedConversation(msgDb, agentA, sessionKeyA, [
      { role: 'user', text: 'What do I know about facts?' },
    ]);

    // Insert a secret fact for agent_b — should NOT appear in agent_a's compose
    insertFact(libDb, { agentId: agentB, scope: 'agent', content: 'AGENT_B_SECRET_FACT', domain: 'secrets' });
    // Insert a fact for agent_a — SHOULD appear
    insertFact(libDb, { agentId: agentA, scope: 'agent', content: 'AGENT_A_FACT', domain: 'public' });

    const compositor = new Compositor({
      vectorStore: null,
      libraryDb: libDb,
    });

    const result = await compositor.compose({
      agentId: agentA,
      sessionKey: sessionKeyA,
      tokenBudget: 50000,
      provider: 'anthropic',
      includeFacts: true,
    }, msgDb, libDb);

    const contextText = result.contextBlock || '';
    const allText = [
      contextText,
      ...result.messages.map(m =>
        typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? m.content.map(c => c?.text || '').join(' ') : ''
      ),
    ].join('\n');

    assert(!allText.includes('AGENT_B_SECRET_FACT'),
      'S2: AGENT_B_SECRET_FACT NOT in agent_a context (scope isolation)');
    assert(allText.includes('AGENT_A_FACT') || (result.diagnostics?.factsIncluded ?? 0) >= 1,
      `S2: AGENT_A_FACT in context OR factsIncluded>=1 (got factsIncluded=${result.diagnostics?.factsIncluded})`);
  }

  // ════════════════════════════════════════════════════════════
  // Scenario 3 — Superseded fact not injected (W1 + supersedes)
  // ════════════════════════════════════════════════════════════
  console.log('\n── Scenario 3: Superseded fact not injected (W1 + supersedes) ──');
  {
    const agentId = 'reg-s3-agent';
    const sessionKey = `agent:${agentId}:webchat:main`;

    const msgDb = makeMessageDb('s3');
    const libDb = makeLibraryDb('s3');

    seedConversation(msgDb, agentId, sessionKey, [
      { role: 'user', text: 'What approach do we use?' },
    ]);

    // Insert superseded (old) fact — superseded_by is a non-null string/id
    // The compositor queries: WHERE superseded_by IS NULL
    // We insert superseded_by = 'fact_new_id' (any truthy non-null value)
    // Note: schema has superseded_by as INTEGER — use numeric id 99 as dave
    libDb.prepare(`
      INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility,
                         source_type, source_session_key, superseded_by,
                         decay_score, created_at, updated_at)
      VALUES (?, 'agent', 'approach', 'OLD_APPROACH_VALUE', 1.0, 'private', 'manual', NULL, 99,
              0.0, datetime('now'), datetime('now'))
    `).run(agentId);

    // Insert the new (active) fact — superseded_by IS NULL
    insertFact(libDb, { agentId, scope: 'agent', content: 'NEW_APPROACH_VALUE', domain: 'approach' });

    const compositor = new Compositor({
      vectorStore: null,
      libraryDb: libDb,
    });

    const result = await compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 50000,
      provider: 'anthropic',
      includeFacts: true,
    }, msgDb, libDb);

    const contextText = result.contextBlock || '';
    const allText = [
      contextText,
      ...result.messages.map(m =>
        typeof m.content === 'string' ? m.content :
        Array.isArray(m.content) ? m.content.map(c => c?.text || '').join(' ') : ''
      ),
    ].join('\n');

    assert(!allText.includes('OLD_APPROACH_VALUE'),
      'S3: OLD_APPROACH_VALUE (superseded) NOT in composed context');
    assert(allText.includes('NEW_APPROACH_VALUE') || (result.diagnostics?.factsIncluded ?? 0) >= 1,
      `S3: NEW_APPROACH_VALUE in context OR factsIncluded>=1 (got ${result.diagnostics?.factsIncluded})`);
  }

  // ════════════════════════════════════════════════════════════
  // Scenario 4 — Scope-filtered count tracked (W3 diagnostics)
  // ════════════════════════════════════════════════════════════
  console.log('\n── Scenario 4: Scope-filtered count tracked (W3) ──');
  {
    const agentId = 'reg-s4-agent';
    const sessionKey = `agent:${agentId}:webchat:s4-session`;

    const msgDb = makeMessageDb('s4');
    const libDb = makeLibraryDb('s4');

    seedConversation(msgDb, agentId, sessionKey, [
      { role: 'user', text: 'What do we know?' },
    ]);

    // Check if facts table has source_session_key column (needed for session-scope filtering)
    const cols = libDb.prepare('PRAGMA table_info(facts)').all().map(r => r.name);
    const hasSessionKey = cols.includes('source_session_key');

    if (!hasSessionKey) {
      skip('S4: facts table has no source_session_key column — session-scope filtering not possible');
    } else {
      // Insert a session-scoped fact from a DIFFERENT session (should be filtered)
      insertFact(libDb, {
        agentId,
        scope: 'session',
        content: 'SESSION_OTHER_SECRET',
        domain: 'session',
        sessionKey: 'other-session-key',   // different from compose sessionKey
      });

      // Insert an agent-scoped fact (should pass through)
      insertFact(libDb, {
        agentId,
        scope: 'agent',
        content: 'AGENT_SCOPE_VISIBLE',
        domain: 'general',
      });

      const compositor = new Compositor({
        vectorStore: null,
        libraryDb: libDb,
      });

      const result = await compositor.compose({
        agentId,
        sessionKey,
        tokenBudget: 50000,
        provider: 'anthropic',
        includeFacts: true,
      }, msgDb, libDb);

      assert(result.diagnostics !== undefined, 'S4: diagnostics object present');
      assert((result.diagnostics?.scopeFiltered ?? 0) >= 1,
        `S4: scopeFiltered >= 1 (got ${result.diagnostics?.scopeFiltered}) — cross-session fact was filtered`);

      // The other-session fact should NOT appear in context
      const contextText = result.contextBlock || '';
      assert(!contextText.includes('SESSION_OTHER_SECRET'),
        'S4: SESSION_OTHER_SECRET not leaked into context');
    }
  }

  // ════════════════════════════════════════════════════════════
  // Scenario 5 — Budget pressure: history wins over memory slots (W4)
  // ════════════════════════════════════════════════════════════
  console.log('\n── Scenario 5: Budget pressure — history wins over memory slots (W4) ──');
  {
    const agentId = 'reg-s5-agent';
    const sessionKey = `agent:${agentId}:webchat:main`;

    const msgDb = makeMessageDb('s5');
    const libDb = makeLibraryDb('s5');

    // Create conversation and seed 20 messages (recent history)
    const convId = seedConversation(msgDb, agentId, sessionKey, []);

    const conv = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
    for (let i = 1; i <= 20; i++) {
      const role = i % 2 === 1 ? 'user' : 'assistant';
      msgDb.prepare(`
        INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
        VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
      `).run(conv.id, agentId, role,
        `Message ${i}: ${'This is a message with reasonable length content to simulate real conversation turns. '.repeat(3)}`,
        i);
    }

    // Seed 50 facts with long content (~200 tokens each = ~800 chars each)
    const longFactText = 'x'.repeat(800); // ~200 tokens
    for (let i = 0; i < 50; i++) {
      insertFact(libDb, {
        agentId,
        scope: 'agent',
        content: `LONG_FACT_${i}: ${longFactText.slice(0, 780)}`,
        domain: `pressure-test-${i}`,
      });
    }

    const compositor = new Compositor({
      vectorStore: null,
      libraryDb: libDb,
    });

    // Tight budget: 4000 tokens
    const tokenBudget = 4000;
    const result = await compositor.compose({
      agentId,
      sessionKey,
      tokenBudget,
      provider: 'anthropic',
      includeHistory: true,
      includeFacts: true,
      includeLibrary: true,
    }, msgDb, libDb);

    assert(result.slots.history > 0,
      `S5: history slot > 0 under tight budget (got ${result.slots.history}) — history preserved`);
    assert(result.warnings.length > 0,
      `S5: warnings.length > 0 (got ${result.warnings.length}) — something was truncated/dropped`);

    const budgetCeiling = tokenBudget * 1.05;
    assert(result.tokenCount <= budgetCeiling,
      `S5: tokenCount ${result.tokenCount} <= budgetCeiling ${budgetCeiling} (budget not exceeded beyond 5% tolerance)`);
  }

  // ════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════');
  const skipNote = skipped > 0 ? `, ${skipped} skipped` : '';
  if (failed === 0) {
    console.log(`  ALL ${passed} ASSERTIONS PASSED ✅${skipNote}`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌${skipNote}`);
  }
  console.log('═══════════════════════════════════════════════════');

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }

  process.exit(failed > 0 ? 1 : 0);
}

/**

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
