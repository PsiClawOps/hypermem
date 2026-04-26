#!/usr/bin/env node
/**
 * Compact Compose Report
 *
 * Runs deterministic, metadata-only compose scenarios and prints a compact
 * operator-readable report showing topic-signal diagnostics and the current
 * release evidence gate state.
 *
 * Usage: node scripts/compose-report.mjs [--data-dir <path>] [--agent <id>] [--json]
 */

import { HyperMem, MessageStore, SessionTopicMap } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

function parseArgs(argv) {
  const out = { dataDir: null, agentId: 'report-agent', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--agent') out.agentId = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/compose-report.mjs [--data-dir <path>] [--agent <id>] [--json]');
      process.exit(0);
    }
  }
  return out;
}

function topicSignalCoverage(stamped, total) {
  return typeof stamped === 'number' && typeof total === 'number' && total > 0
    ? Math.round((stamped / total) * 100000) / 1000
    : null;
}

function classifyTopicSignal(d) {
  const state = d.composeTopicState ?? 'unknown';
  const source = d.composeTopicSource ?? 'unknown';
  const telemetryStatus = d.composeTopicTelemetryStatus ?? 'unknown';
  let classification = 'unknown';
  let reason = 'missing-topic-metadata';

  if (telemetryStatus === 'intentionally-omitted') {
    classification = 'intentionally-suppressed';
    reason = 'topic-telemetry-intentionally-omitted';
  } else if (state === 'history-disabled') {
    classification = 'intentionally-suppressed';
    reason = 'history-disabled';
  } else if (state === 'active-topic-ready') {
    classification = 'present';
    reason = 'active-topic-stamped-history';
  } else if (state === 'no-active-topic') {
    classification = 'absent-no-active-topic';
    reason = 'no-active-topic';
  } else if (state === 'active-topic-missing-stamped-history') {
    classification = 'absent-stamping-incomplete';
    reason = 'active-topic-missing-stamped-history';
  } else if (source === 'none') {
    classification = 'absent-no-active-topic';
    reason = 'no-active-topic';
  } else if ((d.composeTopicMessageCount ?? 0) > 0 && (d.composeTopicStampedMessageCount ?? 0) === 0) {
    classification = 'absent-stamping-incomplete';
    reason = 'history-present-without-topic-stamps';
  } else if ((d.composeTopicStampedMessageCount ?? 0) > 0) {
    classification = 'present';
    reason = 'stamped-history-observed';
  }

  return {
    classification,
    reason,
    source,
    state,
    telemetryStatus,
    messageCount: d.composeTopicMessageCount ?? null,
    stampedMessageCount: d.composeTopicStampedMessageCount ?? null,
    stampedCoveragePct: topicSignalCoverage(d.composeTopicStampedMessageCount, d.composeTopicMessageCount),
  };
}

function resolveEvidenceGate(samples) {
  const topicBearingSamples = samples.filter(sample => sample.topicSignal.classification === 'present').length;
  if (topicBearingSamples > 0) {
    return {
      status: 'replaced-by-deterministic-evidence',
      reason: 'metadata-only-topic-bearing-compose-sample-observed',
      topicBearingSamples,
      liveTopicBearingSample: 'deferred-for-post-release-tuning',
    };
  }
  return {
    status: 'blocked-no-topic-bearing-evidence',
    reason: 'no-metadata-only-topic-bearing-compose-sample-observed',
    topicBearingSamples: 0,
    liveTopicBearingSample: 'not-observed',
  };
}

function getConversationId(db, sessionKey) {
  const row = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey);
  if (!row?.id) {
    throw new Error(`conversation not found for session ${sessionKey}`);
  }
  return row.id;
}

async function seedNeutralHistory(hm, agentId, sessionKey) {
  await hm.recordUserMessage(agentId, sessionKey, 'report-seed-user-1');
  await hm.recordAssistantMessage(agentId, sessionKey, {
    role: 'assistant',
    textContent: 'report-seed-assistant-1',
    toolCalls: null,
    toolResults: null,
  });
  await hm.recordUserMessage(agentId, sessionKey, 'report-seed-user-2');
}

async function stampHistoryToActiveTopic(hm, agentId, sessionKey) {
  const db = hm.dbManager.getMessageDb(agentId);
  const topicMap = new SessionTopicMap(db);
  const topicId = topicMap.createTopic(sessionKey, 'report-topic-name-alpha');
  topicMap.activateTopic(sessionKey, topicId);
  const conversationId = getConversationId(db, sessionKey);
  db.prepare('UPDATE messages SET topic_id = ? WHERE conversation_id = ?').run(topicId, conversationId);
  db.prepare(`
    UPDATE topics
    SET message_count = (
      SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND topic_id = ?
    )
    WHERE id = ?
  `).run(conversationId, topicId, topicId);
  const store = new MessageStore(db);
  await hm.cache.replaceHistory(agentId, sessionKey, store.getRecentMessagesByTopic(conversationId, topicId, 250));
  return topicId;
}

async function runScenario(hm, agentId, label, options = {}) {
  const sessionKey = `agent:${agentId}:webchat:${label}`;
  await seedNeutralHistory(hm, agentId, sessionKey);
  if (options.stampActiveTopic) {
    await stampHistoryToActiveTopic(hm, agentId, sessionKey);
  }

  const result = await hm.compose({
    agentId,
    sessionKey,
    tokenBudget: 4000,
    provider: 'anthropic',
    includeHistory: options.includeHistory !== false,
    includeFacts: false,
    includeLibrary: false,
    prompt: 'report-seed-prompt',
  });

  const d = result.diagnostics ?? {};
  return {
    scenario: label,
    evidenceSource: 'deterministic',
    tokenCount: result.tokenCount,
    messageCount: result.messages.length,
    truncated: result.truncated ?? false,
    warnings: result.warnings?.length ?? 0,
    adaptiveLifecycleBand: d.adaptiveLifecycleBand ?? null,
    adaptiveEvictionLifecycleBand: d.adaptiveEvictionLifecycleBand ?? null,
    adaptiveEvictionBypassReason: d.adaptiveEvictionBypassReason ?? null,
    topicSignal: classifyTopicSignal(d),
  };
}

function renderText(report) {
  const lines = [];
  lines.push('═══════════════════════════════════════════════════');
  lines.push('  HyperMem Compose Report');
  lines.push('═══════════════════════════════════════════════════');
  lines.push(`Evidence gate: ${report.evidenceGate.status}`);
  lines.push(`Reason:        ${report.evidenceGate.reason}`);
  lines.push(`Topic samples: ${report.evidenceGate.topicBearingSamples}`);
  lines.push(`Live sample:   ${report.evidenceGate.liveTopicBearingSample}`);
  lines.push('');
  for (const sample of report.samples) {
    lines.push(`── Scenario: ${sample.scenario} ──`);
    lines.push(`  evidenceSource:     ${sample.evidenceSource}`);
    lines.push(`  tokenCount:         ${sample.tokenCount}`);
    lines.push(`  messageCount:       ${sample.messageCount}`);
    lines.push(`  truncated:          ${sample.truncated}`);
    lines.push(`  warnings:           ${sample.warnings}`);
    lines.push(`  adaptiveBand:       ${sample.adaptiveLifecycleBand ?? 'n/a'}`);
    lines.push(`  evictionBand:       ${sample.adaptiveEvictionLifecycleBand ?? 'n/a'}`);
    lines.push(`  evictionBypass:     ${sample.adaptiveEvictionBypassReason ?? 'n/a'}`);
    lines.push(`  topicSignal.class:  ${sample.topicSignal.classification}`);
    lines.push(`  topicSignal.reason: ${sample.topicSignal.reason}`);
    lines.push(`  topicSignal.source: ${sample.topicSignal.source}`);
    lines.push(`  topicSignal.state:  ${sample.topicSignal.state}`);
    lines.push(`  stampedHistory:     ${sample.topicSignal.stampedMessageCount ?? 'n/a'}/${sample.topicSignal.messageCount ?? 'n/a'} ` +
      `coverage=${sample.topicSignal.stampedCoveragePct ?? 'n/a'}`);
    lines.push(`  telemetry:          ${sample.topicSignal.telemetryStatus}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const tmpDir = args.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'hm-compose-report-'));
  const isTemp = !args.dataDir;

  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  let hm;
  try {
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};

    hm = await HyperMem.create({ dataDir: tmpDir });
    hm.dbManager.ensureAgent(args.agentId, { displayName: 'Report Agent', tier: 'council' });

    const samples = [];
    samples.push(await runScenario(hm, args.agentId, 'no-active-topic'));
    samples.push(await runScenario(hm, args.agentId, 'topic-bearing-deterministic', { stampActiveTopic: true }));
    samples.push(await runScenario(hm, args.agentId, 'history-disabled', { includeHistory: false }));

    const report = {
      evidenceGate: resolveEvidenceGate(samples),
      samples,
    };

    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    if (args.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(renderText(report) + '\n');
    }

    await hm.close();
  } catch (err) {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error('Report failed:', err);
    try { await hm?.close(); } catch {}
    process.exit(1);
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    console.warn = originalWarn;
    if (isTemp) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
}

run();
