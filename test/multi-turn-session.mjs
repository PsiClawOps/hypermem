/**
 * HyperMem Multi-Turn Session Validation
 *
 * Simulates a realistic multi-turn agent session to verify:
 *   1. dispose() is a no-op — singleton persists across turns, no reconnect
 *   2. History dedup — messages not duplicated across turns
 *   3. Token budget — assemble() stays under budget even with large tool outputs
 *   4. ownsCompaction — compact() returns gracefully without error
 *   5. Tool-pair stripping — old tool content replaced with stubs
 *
 * Run directly: node test/multi-turn-session.mjs
 * Or via: npm run test:multi-turn
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

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

function assertLte(actual, max, msg) {
  if (actual <= max) {
    console.log(`  ✅ ${msg} (${actual} ≤ ${max})`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg} — got ${actual}, expected ≤ ${max}`);
    failed++;
  }
}

// Simulate a large tool result (like a file read or search result)
function makeLargeToolResult(id, sizeChars = 3000) {
  return {
    role: 'user',
    textContent: null,
    toolCalls: null,
    toolResults: [{ id: `tr_${id}`, name: 'read', content: 'x'.repeat(sizeChars) }],
  };
}

function makeAssistantToolCall(id) {
  return {
    role: 'assistant',
    textContent: null,
    toolCalls: [{ id: `tc_${id}`, name: 'read', arguments: JSON.stringify({ file: `/path/to/file${id}.ts` }) }],
    toolResults: null,
  };
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Multi-Turn Session Validation');
  console.log('═══════════════════════════════════════════════════\n');

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const realHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-multi-turn-'));
  const dataDir = path.join(tmpHome, '.openclaw', 'hypermem');
  const pluginLinkDir = path.join(tmpHome, '.openclaw', 'workspace', 'repo', 'hypermem');

  fs.mkdirSync(pluginLinkDir, { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'dist'), path.join(pluginLinkDir, 'dist'), 'dir');

  process.env.HOME = tmpHome;

  let hm = null;
  let engine = null;

  try {
    const { HyperMem } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'index.js')).href);

    const agentId = `multi-turn-test-${Date.now().toString(36)}`;
    const sessionKey = `agent:${agentId}:webchat:main`;
    const sessionFile = path.join(tmpHome, 'session.jsonl');
    fs.writeFileSync(sessionFile, '');

    // ── Seed HyperMem with history ─────────────────────────────
    hm = await HyperMem.create({
      dataDir,
      redis: { host: 'localhost', port: 6379, keyPrefix: 'hm:mt:' },
    });

    hm.dbManager.ensureAgent(agentId, { displayName: 'Multi-Turn Test Agent', tier: 'test' });

    // Seed 10 turns of conversation with tool calls
    for (let i = 0; i < 10; i++) {
      await hm.recordUserMessage(agentId, sessionKey, `Turn ${i}: please review file${i}.ts`);
      await hm.recordAssistantMessage(agentId, sessionKey, makeAssistantToolCall(i));
      // Tool result is stored as a user message in neutral format
      const tr = makeLargeToolResult(i, 2000);
      await hm.recordUserMessage(agentId, sessionKey, `[tool result for turn ${i}]`);
      await hm.recordAssistantMessage(agentId, sessionKey, {
        role: 'assistant',
        textContent: `Turn ${i} analysis complete. Found 3 issues in file${i}.ts.`,
        toolCalls: null,
        toolResults: null,
      });
    }

    await hm.close();
    hm = null;

    // ── Load plugin ────────────────────────────────────────────
    const pluginEntry = (await import(pathToFileURL(path.join(repoRoot, 'plugin', 'dist', 'index.js')).href)).default;
    pluginEntry.register({
      registerContextEngine(_id, factory) {
        engine = factory();
      },
    });

    assert(engine != null, 'Plugin registered a context engine');

    // ── TURN 1 ─────────────────────────────────────────────────
    console.log('\n  — Turn 1');

    await engine.bootstrap({
      sessionId: 'multi-turn-session',
      sessionKey,
      sessionFile,
    });

    const TOKEN_BUDGET = 12000;

    const turn1 = await engine.assemble({
      sessionId: 'multi-turn-session',
      sessionKey,
      messages: [],
      tokenBudget: TOKEN_BUDGET,
      model: 'claude-sonnet-4-6',
      prompt: 'review typescript files',
    });

    assert(Array.isArray(turn1.messages), 'Turn 1: assemble() returned messages array');
    assert(turn1.messages.length > 0, `Turn 1: got ${turn1.messages.length} messages`);
    assertLte(turn1.estimatedTokens, TOKEN_BUDGET, 'Turn 1: estimatedTokens within budget');

    const turn1MessageCount = turn1.messages.length;
    console.log(`    history messages in turn 1: ${turn1MessageCount}, ~${turn1.estimatedTokens} tokens`);

    // ── dispose() no-op check ──────────────────────────────────
    console.log('\n  — dispose() no-op');
    await engine.dispose?.();

    // ── TURN 2 — after dispose ─────────────────────────────────
    console.log('\n  — Turn 2 (after dispose)');

    await engine.bootstrap({
      sessionId: 'multi-turn-session',
      sessionKey,
      sessionFile,
    });

    const turn2 = await engine.assemble({
      sessionId: 'multi-turn-session',
      sessionKey,
      messages: [],
      tokenBudget: TOKEN_BUDGET,
      model: 'claude-sonnet-4-6',
      prompt: 'review typescript files',
    });

    assert(Array.isArray(turn2.messages), 'Turn 2: assemble() still works after dispose()');
    assertLte(turn2.estimatedTokens, TOKEN_BUDGET, 'Turn 2: estimatedTokens within budget after dispose()');

    // History should not grow after dispose — same messages, no duplication
    assert(
      turn2.messages.length <= turn1MessageCount + 2,
      `Turn 2: no history explosion after dispose (${turn2.messages.length} vs ${turn1MessageCount})`
    );

    console.log(`    history messages in turn 2: ${turn2.messages.length}, ~${turn2.estimatedTokens} tokens`);

    // ── Tool pair stripping check ──────────────────────────────
    console.log('\n  — Tool pair stripping');

    // Count messages with full tool content (non-omitted) in turn 2
    const fullToolMessages = turn2.messages.filter(m => {
      if (m.tool_calls) {
        const args = m.tool_calls[0]?.function?.arguments || '';
        return args !== '{"_omitted":true}';
      }
      if (m.content && Array.isArray(m.content)) {
        return m.content.some(c => c.type === 'tool_result' && c.content !== '[result omitted]');
      }
      return false;
    });

    // With maxRecentToolPairs=3, at most 3 pairs should have full content
    assertLte(
      fullToolMessages.length,
      6, // 3 pairs × 2 messages (call + result)
      `Tool stripping: at most 3 pairs with full content (${fullToolMessages.length} full-content tool messages)`
    );

    // ── TURN 3 — compact() ────────────────────────────────────
    console.log('\n  — Turn 3: compact()');

    const compactResult = await engine.compact?.({
      sessionId: 'multi-turn-session',
      sessionKey,
      messages: turn2.messages,
      tokenBudget: TOKEN_BUDGET,
      model: 'claude-sonnet-4-6',
    });

    // compact() should return without throwing — ownsCompaction=true means
    // it returns a summary, not undefined/null
    assert(
      compactResult !== undefined,
      'compact() returned a result (ownsCompaction=true)'
    );
    console.log(`    compact() result type: ${typeof compactResult}`);

    // ── TURN 3 — assemble after compact ───────────────────────
    const turn3 = await engine.assemble({
      sessionId: 'multi-turn-session',
      sessionKey,
      messages: [],
      tokenBudget: TOKEN_BUDGET,
      model: 'claude-sonnet-4-6',
      prompt: 'review typescript files',
    });

    assert(Array.isArray(turn3.messages), 'Turn 3: assemble() works after compact()');
    assertLte(turn3.estimatedTokens, TOKEN_BUDGET, 'Turn 3: estimatedTokens within budget after compact()');

    console.log(`    history messages in turn 3: ${turn3.messages.length}, ~${turn3.estimatedTokens} tokens`);

  } catch (err) {
    console.error('\n💥 Validation error:', err);
    failed++;
  } finally {
    try { await engine?.dispose?.(); } catch {}
    try { await hm?.close?.(); } catch {}
    process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} CHECKS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

run();
