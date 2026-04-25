/**
 * HyperMem Trim Telemetry — Unit Test Fixture (Phase A Sprint 1)
 *
 * Goal: exercise every telemetry call site at least once and assert the JSONL
 * stream has the expected structure. Also validates the "one primary trim per
 * turn" invariant: each simulated turn emits exactly one assemble.* trim event
 * (plus optional secondary/afterTurn events).
 *
 * Scope:
 *   - Loads the built plugin's __telemetryForTests emitters directly
 *     (in-memory fake — NOT a real session). Per sprint guidance.
 *   - Does not import HyperMem core or start Redis.
 *   - Runs the trim-report.mjs script against the emitted file and asserts
 *     it flags the afterTurn->next-assemble churn pattern on a crafted log.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else           { console.log(`  ❌ FAIL: ${msg}`); failed++; }
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Trim Telemetry Unit Test');
  console.log('═══════════════════════════════════════════════════\n');

  // Telemetry sink lives in a fresh tmp file for this run.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-trim-telem-'));
  const telemPath = path.join(tmpDir, 'telemetry.jsonl');

  // Plugin dist must be built before this test runs. validate:plugin-pipeline
  // handles that in CI. For local runs, fail fast with a clear message.
  const pluginDist = path.join(repoRoot, 'plugin', 'dist', 'index.js');
  if (!fs.existsSync(pluginDist)) {
    console.error('  plugin dist not found. Run: npm --prefix plugin run build');
    process.exit(1);
  }

  // ── Case A: telemetry OFF → byte-identical no-op ────────────────────
  {
    process.env.HYPERMEM_TELEMETRY = '';
    process.env.HYPERMEM_TELEMETRY_PATH = telemPath;
    // Re-import plugin fresh by using a cache-busting URL query string.
    const mod = await import(`file://${pluginDist}?off=${Date.now()}`);
    mod.__telemetryForTests.reset();
    mod.__telemetryForTests.trimTelemetry({
      path: 'assemble.normal', agentId: 'a', sessionKey: 'sk', preTokens: 1,
      postTokens: 0, removed: 0, cacheInvalidated: false, reason: 'off-test',
    });
    mod.__telemetryForTests.assembleTrace({
      agentId: 'a', sessionKey: 'sk', turnId: 'off', path: 'cold',
      toolLoop: false, msgCount: 0,
    });
    assert(!fs.existsSync(telemPath) || fs.statSync(telemPath).size === 0,
      'telemetry OFF: nothing written to sink');
  }

  // ── Case B: telemetry ON → all call sites covered ───────────────────
  process.env.HYPERMEM_TELEMETRY = '1';
  process.env.HYPERMEM_TELEMETRY_PATH = telemPath;
  const pluginOn = await import(`file://${pluginDist}?on=${Date.now()}`);
  const T = pluginOn.__telemetryForTests;
  T.reset();

  // Closed set of trim paths the plugin emits. If any are missing, test fails.
  const expectedPaths = [
    'assemble.normal',
    'assemble.toolLoop',
    'assemble.subagent',
    'reshape',
    'compact.nuclear',
    'compact.history',
    'compact.history2',
    'afterTurn.secondary',
    'warmstart',
  ];

  // Simulate 3 turns of known trim pressure. Each turn: one assemble.* trim
  // (primary), plus an afterTurn.secondary. Turn 2 also exercises reshape +
  // compact paths. Turn 3 is a subagent turn.
  const agentId = 'council/test';
  const sk = 'agent:council/test:webchat:test-session';
  const subSk = 'agent:council/test:subagent:abc-123';

  // --- Turn 1 ---
  const t1 = T.nextTurnId();
  T.assembleTrace({ agentId, sessionKey: sk, turnId: t1, path: 'cold', toolLoop: false, msgCount: 40 });
  T.trimTelemetry({ path: 'assemble.normal', agentId, sessionKey: sk,
    preTokens: 90000, postTokens: 60000, removed: 30, cacheInvalidated: true, reason: 'budget*0.65' });
  T.trimTelemetry({ path: 'afterTurn.secondary', agentId, sessionKey: sk,
    preTokens: 85000, postTokens: 50000, removed: 20, cacheInvalidated: false, reason: 'postTurnPressure=82%' });

  // --- Turn 2 (churn target: afterTurn on turn 1 + assemble trim on turn 2) ---
  const t2 = T.nextTurnId();
  T.assembleTrace({ agentId, sessionKey: sk, turnId: t2, path: 'cold', toolLoop: false, msgCount: 55 });
  T.trimTelemetry({ path: 'assemble.normal', agentId, sessionKey: sk,
    preTokens: 88000, postTokens: 58000, removed: 25, cacheInvalidated: true, reason: 'budget*0.65' });
  T.trimTelemetry({ path: 'reshape', agentId, sessionKey: sk,
    preTokens: 72000, postTokens: 45000, removed: 12, cacheInvalidated: true, reason: 'downshift 128k->90k' });
  T.trimTelemetry({ path: 'compact.nuclear', agentId, sessionKey: sk,
    preTokens: 120000, postTokens: 30000, removed: 80, cacheInvalidated: true, reason: 'nuclear' });
  T.trimTelemetry({ path: 'compact.history', agentId, sessionKey: sk,
    preTokens: 95000, postTokens: 55000, removed: 20, cacheInvalidated: true, reason: 'large-inbound' });
  T.trimTelemetry({ path: 'compact.history2', agentId, sessionKey: sk,
    preTokens: 85000, postTokens: 42000, removed: 22, cacheInvalidated: true, reason: 'over-budget' });
  T.trimTelemetry({ path: 'warmstart', agentId, sessionKey: sk,
    preTokens: 85000, postTokens: 45000, removed: 18, cacheInvalidated: true, reason: 'warmPressure=95%' });

  // --- Turn 3 (subagent) ---
  const t3 = T.nextTurnId();
  T.assembleTrace({ agentId, sessionKey: subSk, turnId: t3, path: 'subagent', toolLoop: false, msgCount: 15 });
  T.trimTelemetry({ path: 'assemble.subagent', agentId, sessionKey: subSk,
    preTokens: 30000, postTokens: 22000, removed: 5, cacheInvalidated: true, reason: 'subagent normal' });
  T.trimTelemetry({ path: 'assemble.toolLoop', agentId, sessionKey: sk,
    preTokens: 70000, postTokens: 50000, removed: 10, cacheInvalidated: true, reason: 'toolLoop' });

  // Give the append stream a tick to flush.
  T.reset();
  await new Promise(r => setTimeout(r, 50));

  // ── Assertions on raw stream ────────────────────────────────────────
  assert(fs.existsSync(telemPath), 'telemetry sink file created when flag ON');
  const rawLines = fs.readFileSync(telemPath, 'utf8').split(/\n/).filter(Boolean);
  const events = rawLines.map(l => JSON.parse(l));
  assert(events.length >= 3 /*assembleTraces*/ + 9 /*trims*/, `event count >= 12 (got ${events.length})`);
  const trimEvents = events.filter(e => e.event === 'trim');
  const assembleEvents = events.filter(e => e.event === 'assemble');
  assert(assembleEvents.length === 3, `3 assembleTrace events emitted (got ${assembleEvents.length})`);

  // Required fields on every trim event
  const requiredTrimFields = ['event', 'ts', 'path', 'agentId', 'sessionKey',
    'preTokens', 'postTokens', 'removed', 'cacheInvalidated', 'reason'];
  for (const ev of trimEvents) {
    for (const f of requiredTrimFields) {
      assert(Object.prototype.hasOwnProperty.call(ev, f),
        `trim event has required field '${f}' (path=${ev.path})`);
    }
  }
  // Required fields on every assembleTrace event
  const requiredAsmFields = ['event', 'ts', 'agentId', 'sessionKey', 'turnId',
    'path', 'toolLoop', 'msgCount'];
  for (const ev of assembleEvents) {
    for (const f of requiredAsmFields) {
      assert(Object.prototype.hasOwnProperty.call(ev, f),
        `assemble event has required field '${f}' (turnId=${ev.turnId})`);
    }
  }

  // Closed set: every expected trim path is represented at least once
  const seenPaths = new Set(trimEvents.map(e => e.path));
  for (const p of expectedPaths) {
    assert(seenPaths.has(p), `trim path '${p}' emitted at least once`);
  }

  // "One primary trim fires per turn": Sprint 1 MEASURES current behavior;
  // Sprint 3 ENFORCES the exactly-one invariant after the afterTurn rescue-trim
  // loop is removed. Current assertion is `>= 1` by design: `=== 1` would fail
  // today and teach us nothing. When Sprint 3 lands the rescue-loop removal,
  // tighten this to `=== 1` across non-empty trim turns.
  // Trim taxonomy: assemble.* is primary; afterTurn.secondary, reshape,
  // compact.*, and warmstart are NOT primary.
  // Walk events in order, slice into turn buckets at assembleTrace boundaries.
  const buckets = [];
  let cur = null;
  for (const ev of events) {
    if (ev.event === 'assemble') { if (cur) buckets.push(cur); cur = { asm: ev, trims: [] }; }
    else if (ev.event === 'trim' && cur) { cur.trims.push(ev); }
  }
  if (cur) buckets.push(cur);
  for (const b of buckets) {
    const primary = b.trims.filter(t => t.path.startsWith('assemble.'));
    // Each turn may carry multiple assemble.* paths (normal + toolLoop if a
    // tool-loop trim happens in the same turn bucket — turn 3 does this).
    // Measurement invariant (Sprint 1): >= 1 assemble.* trim per turn that
    // performs trim work. Turns with zero trims are allowed (no-trim turns
    // exist in the real path). Enforcement to `=== 1` happens in Sprint 3.
    if (b.trims.length > 0) {
      assert(primary.length >= 1,
        `turn ${b.asm.turnId} has at least one assemble.* primary trim (got ${primary.length})`);
    }
  }

  // ── Run trim-report.mjs and assert churn flag fires ─────────────────
  const scriptPath = path.join(repoRoot, 'scripts', 'trim-report.mjs');
  const r = spawnSync(process.execPath, [scriptPath, '--input', telemPath, '--json'], {
    encoding: 'utf8',
  });
  // Script exits 2 when churn detected — that's expected for this fixture.
  assert(r.status === 2 || r.status === 0,
    `trim-report.mjs exits cleanly (got ${r.status}); stderr=${r.stderr?.slice(0, 200)}`);
  const report = JSON.parse(r.stdout);
  assert(report.totals.churnTurns >= 1,
    `trim-report.mjs flags afterTurn->next-assemble churn pattern (churnTurns=${report.totals.churnTurns})`);
  assert(report.totals.trimCount === trimEvents.length,
    `trim-report.mjs counted all trims (${report.totals.trimCount} === ${trimEvents.length})`);

  // ── Churn-negative fixture: afterTurn secondary with NO following assemble trim ──
  const negPath = path.join(tmpDir, 'no-churn.jsonl');
  const negLines = [
    { event: 'assemble', ts: '2026-01-01T00:00:00Z', agentId, sessionKey: sk, turnId: 'n1', path: 'cold', toolLoop: false, msgCount: 10 },
    { event: 'trim', ts: '2026-01-01T00:00:01Z', path: 'afterTurn.secondary', agentId, sessionKey: sk, preTokens: 80000, postTokens: 50000, removed: 15, cacheInvalidated: false, reason: 'pressure' },
    { event: 'assemble', ts: '2026-01-01T00:00:02Z', agentId, sessionKey: sk, turnId: 'n2', path: 'replay', toolLoop: false, msgCount: 10 },
    // no trim on second turn
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  fs.writeFileSync(negPath, negLines);
  const r2 = spawnSync(process.execPath, [scriptPath, '--input', negPath, '--json'], { encoding: 'utf8' });
  assert(r2.status === 0, `no-churn fixture: trim-report.mjs exits 0 (got ${r2.status})`);
  const report2 = JSON.parse(r2.stdout);
  assert(report2.totals.churnTurns === 0,
    `no-churn fixture: churnTurns=0 (got ${report2.totals.churnTurns})`);
  assert(report2.evidenceGate.status === 'blocked-no-topic-bearing-evidence',
    `no-churn fixture: evidence gate remains blocked without topic-bearing samples (got ${report2.evidenceGate.status})`);

  // ── Topic-signal classification fixture: no live DB mutation ─────────
  const topicSignalPath = path.join(tmpDir, 'topic-signal.jsonl');
  const topicSignalEvents = [
    {
      event: 'assemble', ts: '2026-01-01T00:10:00Z', agentId, sessionKey: sk, turnId: 'topic-none',
      path: 'cold', toolLoop: false, msgCount: 12,
      composeTopicSource: 'none',
      composeTopicState: 'no-active-topic',
      composeTopicMessageCount: 12,
      composeTopicStampedMessageCount: 0,
      composeTopicTelemetryStatus: 'emitted',
      adaptiveEvictionBypassReason: 'no-active-topic',
    },
    {
      event: 'assemble', ts: '2026-01-01T00:11:00Z', agentId, sessionKey: sk, turnId: 'topic-present',
      path: 'cold', toolLoop: false, msgCount: 10,
      composeTopicSource: 'session-topic-map',
      composeTopicState: 'active-topic-ready',
      composeTopicMessageCount: 10,
      composeTopicStampedMessageCount: 8,
      composeTopicTelemetryStatus: 'emitted',
    },
    {
      event: 'assemble', ts: '2026-01-01T00:12:00Z', agentId, sessionKey: sk, turnId: 'topic-incomplete',
      path: 'cold', toolLoop: false, msgCount: 6,
      composeTopicSource: 'request-topic-id',
      composeTopicState: 'active-topic-missing-stamped-history',
      composeTopicMessageCount: 6,
      composeTopicStampedMessageCount: 0,
      composeTopicTelemetryStatus: 'emitted',
      adaptiveEvictionBypassReason: 'no-stamped-clusters',
    },
    {
      event: 'assemble', ts: '2026-01-01T00:13:00Z', agentId, sessionKey: sk, turnId: 'topic-suppressed',
      path: 'cold', toolLoop: false, msgCount: 0,
      composeTopicSource: 'none',
      composeTopicState: 'history-disabled',
      composeTopicMessageCount: 0,
      composeTopicStampedMessageCount: 0,
      composeTopicTelemetryStatus: 'intentionally-omitted',
    },
  ];
  fs.writeFileSync(topicSignalPath, topicSignalEvents.map(x => JSON.stringify(x)).join('\n') + '\n');

  const topicReportRun = spawnSync(process.execPath, [scriptPath, '--input', topicSignalPath, '--json'], { encoding: 'utf8' });
  assert(topicReportRun.status === 0, `topic-signal fixture: trim-report exits 0 (got ${topicReportRun.status})`);
  const topicReport = JSON.parse(topicReportRun.stdout);
  assert(topicReport.totals.topicSignalSamples === 4,
    `topic-signal fixture: four topic metadata samples counted (got ${topicReport.totals.topicSignalSamples})`);
  assert(topicReport.totals.topicSignalClassifications.present === 1, 'topic-signal fixture: present classification counted');
  assert(topicReport.totals.topicSignalClassifications['absent-no-active-topic'] === 1,
    'topic-signal fixture: absent-no-active-topic classification counted');
  assert(topicReport.totals.topicSignalClassifications['absent-stamping-incomplete'] === 1,
    'topic-signal fixture: absent-stamping-incomplete classification counted');
  assert(topicReport.totals.topicSignalClassifications['intentionally-suppressed'] === 1,
    'topic-signal fixture: intentionally-suppressed classification counted');
  assert(topicReport.evidenceGate.status === 'replaced-by-deterministic-evidence',
    `topic-signal fixture: evidence gate replaced by deterministic evidence (got ${topicReport.evidenceGate.status})`);
  assert(topicReport.turns.find(t => t.turnId === 'topic-present')?.topicSignal?.reason === 'active-topic-stamped-history',
    'topic-signal fixture: propagated/present path has active-topic-stamped-history reason');
  assert(topicReport.turns.find(t => t.turnId === 'topic-none')?.topicSignal?.reason === 'no-active-topic',
    'topic-signal fixture: no-active-topic absence reason is explicit');
  assert(topicReport.turns.find(t => t.turnId === 'topic-incomplete')?.topicSignal?.reason === 'active-topic-missing-stamped-history',
    'topic-signal fixture: missing stamp propagation reason is explicit');

  const topicReportText = spawnSync(process.execPath, [scriptPath, '--input', topicSignalPath], { encoding: 'utf8' });
  assert(topicReportText.status === 0, `topic-signal text report exits 0 (got ${topicReportText.status})`);
  assert(/Topic signal:/.test(topicReportText.stdout), 'topic-signal text report renders operator-facing summary');
  assert(/absent-no-active-topic=1/.test(topicReportText.stdout), 'topic-signal text report explains no-active-topic absence');
  assert(/absent-stamping-incomplete=1/.test(topicReportText.stdout), 'topic-signal text report explains stamping-incomplete absence');
  assert(!/What is the|governance constraints|release policy/.test(topicReportText.stdout),
    'topic-signal text report remains metadata-only');
  assert(/Evidence gate: replaced-by-deterministic-evidence/.test(topicReportText.stdout),
    'topic-signal text report renders deterministic evidence gate summary');

  // ── Compose-report deterministic evidence fixture ───────────────────
  const composeScriptPath = path.join(repoRoot, 'scripts', 'compose-report.mjs');
  const composeJsonRun = spawnSync(process.execPath, [composeScriptPath, '--json'], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  assert(composeJsonRun.status === 0,
    `compose-report --json exits 0 (got ${composeJsonRun.status}); stderr=${composeJsonRun.stderr?.slice(0, 200)}`);
  const composeReport = JSON.parse(composeJsonRun.stdout);
  assert(composeReport.evidenceGate.status === 'replaced-by-deterministic-evidence',
    `compose-report closes release evidence gate via deterministic sample (got ${composeReport.evidenceGate.status})`);
  assert(composeReport.samples.find(s => s.scenario === 'topic-bearing-deterministic')?.topicSignal?.classification === 'present',
    'compose-report captures deterministic topic-bearing present classification');
  assert(composeReport.samples.find(s => s.scenario === 'history-disabled')?.topicSignal?.classification === 'intentionally-suppressed',
    'compose-report preserves intentionally-suppressed metadata-only path');
  assert(!/report-seed-user|report-seed-assistant|report-seed-prompt|report-topic-name-alpha/.test(composeJsonRun.stdout),
    'compose-report JSON output remains metadata-only');

  const composeTextRun = spawnSync(process.execPath, [composeScriptPath], {
    encoding: 'utf8',
    cwd: repoRoot,
  });
  assert(composeTextRun.status === 0, `compose-report text output exits 0 (got ${composeTextRun.status})`);
  assert(/Evidence gate: replaced-by-deterministic-evidence/.test(composeTextRun.stdout),
    'compose-report text output renders deterministic evidence gate summary');
  assert(!/report-seed-user|report-seed-assistant|report-seed-prompt|report-topic-name-alpha/.test(composeTextRun.stdout),
    'compose-report text output remains metadata-only');

  // ── Cleanup ─────────────────────────────────────────────────────────
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('test failed:', err);
  process.exit(1);
});
