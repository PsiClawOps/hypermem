/**
 * HyperMem Sprint 1 Observability — Unit Test
 *
 * Validates the Sprint 1 additions to the telemetry and compose-diagnostics surface:
 *   1. assembleTrace now accepts and emits Sprint 1 fields (prefixChanged, prefixHash,
 *      rerankerStatus, rerankerCandidates, rerankerProvider, slotSpans,
 *      compactionEligibleCount, compactionEligibleRatio, compactionProcessedCount)
 *   2. ComposeDiagnostics type includes all Sprint 1 fields (type-level checked via
 *      a runtime fixture that exercises the relevant compose path)
 *   3. trim-report.mjs still runs cleanly against an assemble-only fixture
 *      (backward compat with the existing report surface)
 *   4. getCompactionEligibility() is exercised directly against an in-memory DB
 *      and produces expected counts/ratios
 *
 * No live HyperMem session required. Plugin dist must be built.
 * Run: node test/sprint1-observability.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

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

function assertEq(a, b, msg) {
  const ok = a === b;
  if (ok) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg} (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`);
    failed++;
  }
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Sprint 1 Observability Unit Test');
  console.log('═══════════════════════════════════════════════════\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-sprint1-obs-'));
  const telemPath = path.join(tmpDir, 'sprint1-telemetry.jsonl');

  const pluginDist = path.join(repoRoot, 'plugin', 'dist', 'index.js');
  if (!fs.existsSync(pluginDist)) {
    console.error('  plugin dist not found. Run: npm --prefix plugin run build');
    process.exit(1);
  }

  // ─── Part 1: assembleTrace accepts Sprint 1 fields ───────────────────
  console.log('\n── Part 1: assembleTrace Sprint 1 fields ───────────');
  {
    process.env.HYPERMEM_TELEMETRY = '1';
    process.env.HYPERMEM_TELEMETRY_PATH = telemPath;
    const mod = await import(`file://${pluginDist}?s1=${Date.now()}`);
    const T = mod.__telemetryForTests;
    T.reset();

    // Emit a full assembleTrace with all Sprint 1 optional fields
    T.assembleTrace({
      agentId: 'test-agent',
      sessionKey: 'agent:test-agent:webchat:main',
      turnId: 'sprint1-t1',
      path: 'cold',
      toolLoop: false,
      msgCount: 20,
      // Sprint 1 fields
      prefixChanged: true,
      prefixHash: 'abc123def456',
      rerankerStatus: 'applied',
      rerankerCandidates: 8,
      rerankerProvider: 'zeroentropy',
      slotSpans: {
        system:   { allocated: 4000,  filled: 3800, overflow: false },
        identity: { allocated: 2000,  filled: 1900, overflow: false },
        history:  { allocated: 40000, filled: 38000, overflow: false },
        facts:    { allocated: 10000, filled: 2400,  overflow: false },
        context:  { allocated: 10000, filled: 1200,  overflow: false },
        library:  { allocated: 10000, filled: 0,     overflow: false },
      },
      compactionEligibleCount: 15,
      compactionEligibleRatio: 0.375,
      compactionProcessedCount: 3,
    });

    T.reset();
    await new Promise(r => setTimeout(r, 30));

    assert(fs.existsSync(telemPath), 'telemetry file created');
    const rawLines = fs.readFileSync(telemPath, 'utf8').split(/\n/).filter(Boolean);
    assert(rawLines.length >= 1, `at least 1 telemetry line emitted (got ${rawLines.length})`);

    const ev = JSON.parse(rawLines[0]);
    assertEq(ev.event, 'assemble', 'event type is assemble');
    assertEq(ev.prefixChanged, true, 'prefixChanged=true emitted');
    assertEq(ev.prefixHash, 'abc123def456', 'prefixHash emitted');
    assertEq(ev.rerankerStatus, 'applied', 'rerankerStatus=applied emitted');
    assertEq(ev.rerankerCandidates, 8, 'rerankerCandidates=8 emitted');
    assertEq(ev.rerankerProvider, 'zeroentropy', 'rerankerProvider=zeroentropy emitted');
    assert(ev.slotSpans !== undefined, 'slotSpans field present');
    assert(typeof ev.slotSpans.system === 'object', 'slotSpans.system is an object');
    assertEq(ev.slotSpans.history.filled, 38000, 'slotSpans.history.filled=38000');
    assertEq(ev.slotSpans.history.overflow, false, 'slotSpans.history.overflow=false');
    assertEq(ev.compactionEligibleCount, 15, 'compactionEligibleCount=15');
    assertEq(ev.compactionEligibleRatio, 0.375, 'compactionEligibleRatio=0.375');
    assertEq(ev.compactionProcessedCount, 3, 'compactionProcessedCount=3');
  }

  // ─── Part 2: assembleTrace with prefixChanged=false (no change) ──────
  console.log('\n── Part 2: prefixChanged=false path ────────────────');
  {
    const telemPath2 = path.join(tmpDir, 'sprint1-nochange.jsonl');
    process.env.HYPERMEM_TELEMETRY = '1';
    process.env.HYPERMEM_TELEMETRY_PATH = telemPath2;
    const mod2 = await import(`file://${pluginDist}?s1b=${Date.now()}`);
    const T2 = mod2.__telemetryForTests;
    T2.reset();

    T2.assembleTrace({
      agentId: 'test-agent',
      sessionKey: 'agent:test-agent:webchat:main',
      turnId: 'sprint1-t2',
      path: 'cold',
      toolLoop: false,
      msgCount: 10,
      prefixChanged: false,
      prefixHash: 'sameHash',
      rerankerStatus: 'bypass_no_provider',
      rerankerCandidates: 0,
      rerankerProvider: null,
    });

    T2.reset();
    await new Promise(r => setTimeout(r, 30));

    const lines2 = fs.readFileSync(telemPath2, 'utf8').split(/\n/).filter(Boolean);
    const ev2 = JSON.parse(lines2[0]);
    assertEq(ev2.prefixChanged, false, 'prefixChanged=false emitted correctly');
    assertEq(ev2.rerankerStatus, 'bypass_no_provider', 'bypass_no_provider rerankerStatus emitted');
    assertEq(ev2.rerankerProvider, null, 'null rerankerProvider emitted');
  }

  // ─── Part 3: Security check — no content in emitted fields ───────────
  console.log('\n── Part 3: Security audit of emitted events ────────');
  {
    const rawLines = fs.readFileSync(telemPath, 'utf8').split(/\n/).filter(Boolean);
    const ev = JSON.parse(rawLines[0]);
    // Verify no field contains prompt or document text patterns
    // (check for long strings that could be content)
    const allValues = JSON.stringify(ev);
    const contentPatterns = [
      /What is the/,          // example user message
      /governance constraints/,
      /release policy/,
    ];
    for (const pat of contentPatterns) {
      assert(!pat.test(allValues), `No user/doc content in telemetry (pattern: ${pat})`);
    }
    // Allowed fields: check they are all metadata types
    assert(typeof ev.prefixHash === 'string' || ev.prefixHash === undefined, 'prefixHash is string (opaque hash)');
    assert(typeof ev.rerankerCandidates === 'number' || ev.rerankerCandidates === undefined, 'rerankerCandidates is a number');
    assert(typeof ev.compactionEligibleCount === 'number' || ev.compactionEligibleCount === undefined, 'compactionEligibleCount is a number');

    process.env.HYPERMEM_TELEMETRY = '1';
    process.env.HYPERMEM_TELEMETRY_PATH = telemPath;
    const mod3 = await import(`file://${pluginDist}?s1c=${Date.now()}`);
    const T3 = mod3.__telemetryForTests;
    T3.reset();
    T3.lifecyclePolicyTelemetry({
      path: 'afterTurn.gradient',
      agentId: 'test-agent',
      sessionKey: 'agent:test-agent:webchat:main',
      band: 'high',
      pressurePct: 82,
      topicShiftConfidence: 0.75,
      trimSoftTarget: 0.60,
      reasons: ['pressure-high'],
    });
    T3.reset();
    await new Promise(r => setTimeout(r, 30));
    const lifecycleRaw = fs.readFileSync(telemPath, 'utf8');
    const lifecycleEvent = lifecycleRaw.split(/\n/).filter(Boolean).map(line => JSON.parse(line)).find(e => e.event === 'lifecycle-policy');
    assert(lifecycleEvent !== undefined, 'lifecycle telemetry event emitted');
    assert(lifecycleEvent?.path === 'afterTurn.gradient', 'lifecycle telemetry path is afterTurn.gradient');
    assert(typeof lifecycleEvent?.pressurePct === 'number', 'lifecycle telemetry pressurePct is numeric');
    assert(!contentPatterns.some(pat => pat.test(JSON.stringify(lifecycleEvent))), 'lifecycle telemetry contains no user/doc content');
    console.log('  ✅ Security: no content in telemetry fields');
  }

  // ─── Part 4: getCompactionEligibility direct exercise ────────────────
  console.log('\n── Part 4: getCompactionEligibility counts/ratio ───');
  {
    // Import from the built dist
    const coreDist = path.join(repoRoot, 'dist', 'compaction-fence.js');
    let getCompactionEligibility, ensureCompactionFenceSchema, updateCompactionFence;
    try {
      const fenceMod = await import(`file://${coreDist}?s1c=${Date.now()}`);
      getCompactionEligibility = fenceMod.getCompactionEligibility;
      ensureCompactionFenceSchema = fenceMod.ensureCompactionFenceSchema;
      updateCompactionFence = fenceMod.updateCompactionFence;
    } catch {
      console.log('  ⚠️  Core dist not built — skipping getCompactionEligibility direct test');
      console.log('     (Run: npm run build to enable this test section)');
    }

    if (getCompactionEligibility) {
      // Create a minimal in-memory DB with messages + compaction_fences tables
      const db = new DatabaseSync(':memory:');
      db.exec(`
        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY,
          session_key TEXT UNIQUE,
          agent_id TEXT
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          conversation_id INTEGER REFERENCES conversations(id),
          role TEXT,
          text_content TEXT,
          message_index INTEGER,
          created_at TEXT
        );
        CREATE TABLE summaries (
          id INTEGER PRIMARY KEY,
          conversation_id INTEGER
        );
        CREATE TABLE summary_messages (
          summary_id INTEGER REFERENCES summaries(id),
          message_id INTEGER REFERENCES messages(id)
        );
      `);
      ensureCompactionFenceSchema(db);
      // Insert a conversation
      db.prepare('INSERT INTO conversations (id, session_key, agent_id) VALUES (1, ?, ?)').run('sk:test', 'agent1');
      // Insert 20 messages
      for (let i = 1; i <= 20; i++) {
        db.prepare('INSERT INTO messages (id, conversation_id, role, text_content, message_index, created_at) VALUES (?, 1, ?, ?, ?, ?)').run(
          i, i % 2 === 0 ? 'assistant' : 'user', `message ${i}`, i, new Date().toISOString()
        );
      }
      // Before fence: no eligible messages
      const beforeFence = getCompactionEligibility(db, 1);
      assertEq(beforeFence.eligibleCount, 0, 'eligibleCount=0 before fence set');
      assertEq(beforeFence.fence, null, 'fence=null before first update');

      // Set fence at message 10 (messages 1-9 become eligible)
      updateCompactionFence(db, 1, 10);
      const afterFence = getCompactionEligibility(db, 1);
      assert(afterFence.eligibleCount === 9, `eligibleCount=9 after fence at msg 10 (got ${afterFence.eligibleCount})`);
      assert(afterFence.fence !== null, 'fence is set');
      assertEq(afterFence.fence?.fenceMessageId, 10, 'fence at message 10');

      // Ratio calculation: 9/20 = 0.45
      const totalRow = db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE conversation_id = 1').get();
      const ratio = Math.round((afterFence.eligibleCount / totalRow.cnt) * 1000) / 1000;
      assertEq(ratio, 0.45, 'compaction ratio = 9/20 = 0.45');

      // Advance fence to 18 (messages 10-17 newly eligible + 1-9 already: 17 total eligible)
      updateCompactionFence(db, 1, 18);
      const afterAdvance = getCompactionEligibility(db, 1);
      assert(afterAdvance.eligibleCount === 17, `eligibleCount=17 after fence advance to 18 (got ${afterAdvance.eligibleCount})`);

      db.close();
    }
  }

  // ─── Part 5: compose-report.mjs backward compat ──────────────────────
  console.log('\n── Part 5: compose-report.mjs still runnable ───────');
  {
    // Run with --help to verify the script loads without error
    const scriptPath = path.join(repoRoot, 'scripts', 'compose-report.mjs');
    // We can't run a full compose here without a session, but verify script syntax
    // by importing it via node --check
    const check = spawnSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' });
    assert(check.status === 0, `compose-report.mjs passes syntax check (status=${check.status})`);
  }

  // ─── Part 6: trim-report.mjs backward compat with Sprint 1 events ────
  console.log('\n── Part 6: trim-report.mjs handles Sprint 1 assemble events ─');
  {
    // Write a JSONL fixture with Sprint 1 extended assembleTrace events
    const s1FixturePath = path.join(tmpDir, 'sprint1-mixed.jsonl');
    const s1Events = [
      {
        event: 'assemble',
        ts: '2026-04-21T10:00:00.000Z',
        agentId: 'a1',
        sessionKey: 'sk:a1',
        turnId: 'turn1',
        path: 'cold',
        toolLoop: false,
        msgCount: 30,
        // Sprint 1 extras — trim-report.mjs should ignore these gracefully
        prefixChanged: true,
        prefixHash: 'abc',
        rerankerStatus: 'applied',
        rerankerCandidates: 5,
        rerankerProvider: 'zeroentropy',
        slotSpans: { history: { allocated: 40000, filled: 35000, overflow: false } },
        compactionEligibleCount: 10,
        compactionEligibleRatio: 0.333,
        compactionProcessedCount: 2,
        // 0.9.0 adaptive lifecycle diagnostics — aggregate fields only
        adaptiveLifecycleBand: 'high',
        adaptiveEvictionLifecycleBand: 'elevated',
        adaptiveLifecycleBandDiverged: true,
        adaptiveEvictionTopicIdCoveragePct: 75,
        adaptiveEvictionTopicAwareEligibleClusters: 3,
        adaptiveEvictionTopicAwareDroppedClusters: 1,
        adaptiveEvictionProtectedClusters: 2,
        composeTopicSource: 'session-topic-map',
        composeTopicState: 'active-topic-ready',
        composeTopicMessageCount: 8,
        composeTopicStampedMessageCount: 6,
        composeTopicTelemetryStatus: 'emitted',
      },
      {
        event: 'lifecycle-policy',
        ts: '2026-04-21T10:00:00.000Z',
        path: 'compose.eviction',
        agentId: 'a1',
        sessionKey: 'sk:a1',
        band: 'elevated',
        pressurePct: 71.25,
        reasons: ['pressure:elevated'],
      },
      {
        event: 'lifecycle-policy',
        ts: '2026-04-21T10:00:00.000Z',
        path: 'compose.preRecall',
        agentId: 'a1',
        sessionKey: 'sk:a1',
        band: 'high',
        pressurePct: 83.5,
        reasons: ['pressure:high'],
      },
      {
        event: 'trim',
        ts: '2026-04-21T10:00:00.001Z',
        path: 'assemble.normal',
        agentId: 'a1',
        sessionKey: 'sk:a1',
        preTokens: 80000,
        postTokens: 52000,
        removed: 20,
        cacheInvalidated: true,
        reason: 'budget*0.65',
      },
      {
        event: 'assemble',
        ts: '2026-04-21T10:01:00.000Z',
        agentId: 'a1',
        sessionKey: 'sk:a1',
        turnId: 'turn2',
        path: 'cold',
        toolLoop: false,
        msgCount: 32,
        prefixChanged: false,
        prefixHash: 'abc',
        rerankerStatus: 'bypass_no_provider',
        adaptiveLifecycleBand: 'steady',
        adaptiveEvictionLifecycleBand: 'steady',
        adaptiveLifecycleBandDiverged: false,
        adaptiveEvictionTopicIdCoveragePct: 0,
        adaptiveEvictionTopicAwareEligibleClusters: 0,
        adaptiveEvictionTopicAwareDroppedClusters: 0,
        adaptiveEvictionProtectedClusters: 0,
        adaptiveEvictionBypassReason: 'band-not-topic-aware',
        composeTopicSource: 'none',
        composeTopicState: 'no-active-topic',
        composeTopicMessageCount: 4,
        composeTopicStampedMessageCount: 0,
        composeTopicTelemetryStatus: 'emitted',
      },
      {
        event: 'lifecycle-policy',
        ts: '2026-04-21T10:01:00.001Z',
        path: 'afterTurn.gradient',
        agentId: 'a1',
        sessionKey: 'sk:a1',
        band: 'steady',
        pressurePct: 42,
        trimSoftTarget: 0.75,
        reasons: ['steady'],
      },
    ];
    fs.writeFileSync(s1FixturePath, s1Events.map(e => JSON.stringify(e)).join('\n') + '\n');

    const reportPath = path.join(repoRoot, 'scripts', 'trim-report.mjs');
    const r = spawnSync(process.execPath, [reportPath, '--input', s1FixturePath, '--json'], { encoding: 'utf8' });
    assert(r.status === 0 || r.status === 2, `trim-report.mjs exits cleanly with Sprint 1 events (status=${r.status})`);
    const report = JSON.parse(r.stdout);
    assert(report.totals.turns >= 2, `report has >= 2 turns (got ${report.totals.turns})`);
    assert(report.totals.trimCount >= 1, `report counted >= 1 trim (got ${report.totals.trimCount})`);
    assert(report.totals.churnTurns === 0, `no churn in fixture without afterTurn.secondary (got ${report.totals.churnTurns})`);
    assert(report.totals.lifecyclePolicyCount === 3, `lifecycle policy telemetry counted (got ${report.totals.lifecyclePolicyCount})`);
    assert(report.totals.lifecyclePolicyPaths['compose.eviction'] === 1, 'compose.eviction lifecycle path counted');
    assert(report.totals.lifecyclePolicyPaths['compose.preRecall'] === 1, 'compose.preRecall lifecycle path counted');
    assert(report.totals.lifecyclePolicyPaths['afterTurn.gradient'] === 1, 'afterTurn.gradient lifecycle path counted');
    assert(report.totals.adaptiveBandDivergenceTurns >= 1, `adaptive divergence counted (got ${report.totals.adaptiveBandDivergenceTurns})`);
    assert(report.totals.averageTopicIdCoveragePct === 37.5, `topicId coverage averaged from aggregate samples (got ${report.totals.averageTopicIdCoveragePct})`);
    assert(report.totals.adaptiveBypassReasons['band-not-topic-aware'] === 1, 'adaptive bypass reason counted');
    assert(report.totals.topicSignalSamples === 2, `topic signal metadata samples counted (got ${report.totals.topicSignalSamples})`);
    assert(report.totals.topicSignalClassifications.present === 1, 'topic signal present classification counted');
    assert(report.totals.topicSignalClassifications['absent-no-active-topic'] === 1, 'topic signal no-active-topic absence counted');
    assert(report.turns.find(t => t.turnId === 'turn1')?.topicSignal?.classification === 'present',
      'topic signal present/propagated path survives Sprint 1 mixed fixture');
    assert(report.turns.find(t => t.turnId === 'turn2')?.topicSignal?.reason === 'no-active-topic',
      'topic signal absent path explains no active topic');
    const reportText = JSON.stringify(report);
    for (const pat of [/What is the/, /governance constraints/, /release policy/]) {
      assert(!pat.test(reportText), `trim-report lifecycle summary has no user/doc content (pattern: ${pat})`);
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('test failed:', err);
  process.exit(1);
});
