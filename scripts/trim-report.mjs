#!/usr/bin/env node
/**
 * HyperMem Trim Telemetry Report
 *
 * Parses a HyperMem telemetry JSONL stream (captured with HYPERMEM_TELEMETRY=1)
 * and emits a per-turn summary:
 *   - compose count  (assembleTrace events)
 *   - trim count     (trimTelemetry events)
 *   - tokens removed (pre - post, summed)
 *   - afterTurn -> next-assemble churn pattern flag
 *   - lifecycle-policy observations for adaptive lifecycle tuning evidence
 *
 * The churn pattern is defined as: an `afterTurn.secondary` trim event
 * followed (within the same agent/sessionKey) by an `assemble.*` trim event
 * at the very next assembleTrace boundary. This matches the failure mode
 * Sprint 1 is hunting: afterTurn pre-trims, and the immediately following
 * assemble() re-trims the same (or nearby) window on entry.
 *
 * Usage:
 *   node scripts/trim-report.mjs [--input <path>] [--json]
 *
 * Defaults:
 *   --input defaults to $HYPERMEM_TELEMETRY_PATH, falling back to
 *           ./hypermem-telemetry.jsonl
 *   Output is a human-readable table unless --json is passed.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = { input: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/trim-report.mjs [--input <path>] [--json]');
      process.exit(0);
    }
  }
  return out;
}

function resolveInputPath(fromArg) {
  if (fromArg) return fromArg;
  if (process.env.HYPERMEM_TELEMETRY_PATH) return process.env.HYPERMEM_TELEMETRY_PATH;
  return path.resolve(process.cwd(), 'hypermem-telemetry.jsonl');
}

function readJsonl(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`telemetry file not found: ${inputPath}`);
  }
  const raw = fs.readFileSync(inputPath, 'utf8');
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines — the stream is append-only and partial writes
      // can produce a final truncated line.
    }
  }
  return events;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function increment(map, key) {
  const k = key || 'unknown';
  map[k] = (map[k] ?? 0) + 1;
}

function enumValue(value, allowed, fallback = 'unknown') {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function pct(part, total) {
  if (typeof part !== 'number' || typeof total !== 'number' || !Number.isFinite(part) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return Math.round((part / total) * 100000) / 1000;
}

function classifyTopicSignal(meta) {
  const source = enumValue(meta?.composeTopicSource, ['request-topic-id', 'session-topic-map', 'none']);
  const state = enumValue(meta?.composeTopicState, [
    'no-active-topic',
    'active-topic-ready',
    'active-topic-missing-stamped-history',
    'history-disabled',
  ]);
  const telemetryStatus = enumValue(meta?.composeTopicTelemetryStatus, ['emitted', 'intentionally-omitted']);
  const messageCount = finiteNumber(meta?.composeTopicMessageCount);
  const stampedMessageCount = finiteNumber(meta?.composeTopicStampedMessageCount);
  const hasTopicMetadata = source !== 'unknown' || state !== 'unknown' || telemetryStatus !== 'unknown' ||
    messageCount != null || stampedMessageCount != null;

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
  } else if ((messageCount ?? 0) > 0 && (stampedMessageCount ?? 0) === 0) {
    classification = 'absent-stamping-incomplete';
    reason = 'history-present-without-topic-stamps';
  } else if ((stampedMessageCount ?? 0) > 0) {
    classification = 'present';
    reason = 'stamped-history-observed';
  }

  return {
    observed: hasTopicMetadata,
    classification,
    reason,
    source,
    state,
    telemetryStatus,
    messageCount,
    stampedMessageCount,
    stampedCoveragePct: pct(stampedMessageCount, messageCount),
  };
}

function lifecycleDiverged(turn) {
  if (turn.adaptiveLifecycleBandDiverged === true) return true;
  const composeEviction = turn.lifecyclePolicies.find(ev => ev.path === 'compose.eviction');
  const composePreRecall = turn.lifecyclePolicies.find(ev => ev.path === 'compose.preRecall');
  return Boolean(composeEviction?.band && composePreRecall?.band && composeEviction.band !== composePreRecall.band);
}

/**
 * Group events into per-turn buckets. A "turn" boundary is an assembleTrace
 * event. Every event up to (but not including) the next assembleTrace
 * belongs to the current turn. Events that appear before the first
 * assembleTrace are grouped into a synthetic "preamble" turn.
 *
 * The churn detector operates across turn boundaries: an afterTurn.secondary
 * in turn N paired with any assemble.* trim event in turn N+1 for the same
 * (agentId, sessionKey) triggers the churn flag on turn N+1.
 */
function buildReport(events) {
  const turns = [];
  let current = null;
  const startTurn = (meta) => {
    if (current) turns.push(current);
    current = {
      turnId: meta?.turnId ?? null,
      agentId: meta?.agentId ?? null,
      sessionKey: meta?.sessionKey ?? null,
      path: meta?.path ?? null,
      toolLoop: Boolean(meta?.toolLoop),
      msgCount: meta?.msgCount ?? null,
      composeCount: meta ? 1 : 0,
      trimCount: 0,
      tokensRemoved: 0,
      trims: [],
      lifecyclePolicies: [],
      adaptiveLifecycleBand: meta?.adaptiveLifecycleBand ?? null,
      adaptiveEvictionLifecycleBand: meta?.adaptiveEvictionLifecycleBand ?? null,
      adaptiveLifecycleBandDiverged: meta?.adaptiveLifecycleBandDiverged ?? false,
      adaptiveEvictionTopicIdCoveragePct: finiteNumber(meta?.adaptiveEvictionTopicIdCoveragePct),
      adaptiveEvictionTopicAwareEligibleClusters: finiteNumber(meta?.adaptiveEvictionTopicAwareEligibleClusters),
      adaptiveEvictionTopicAwareDroppedClusters: finiteNumber(meta?.adaptiveEvictionTopicAwareDroppedClusters),
      adaptiveEvictionProtectedClusters: finiteNumber(meta?.adaptiveEvictionProtectedClusters),
      adaptiveEvictionBypassReason: meta?.adaptiveEvictionBypassReason ?? null,
      topicSignal: classifyTopicSignal(meta),
      churn: false,
    };
  };
  startTurn(null); // synthetic preamble

  for (const ev of events) {
    if (ev.event === 'assemble') {
      startTurn(ev);
    } else if (ev.event === 'trim') {
      current.trimCount++;
      const delta = Math.max(0, (ev.preTokens ?? 0) - (ev.postTokens ?? 0));
      current.tokensRemoved += delta;
      current.trims.push({
        path: ev.path,
        removed: ev.removed ?? 0,
        preTokens: ev.preTokens ?? 0,
        postTokens: ev.postTokens ?? 0,
        cacheInvalidated: Boolean(ev.cacheInvalidated),
        reason: ev.reason ?? '',
        agentId: ev.agentId ?? null,
        sessionKey: ev.sessionKey ?? null,
      });
    } else if (ev.event === 'lifecycle-policy') {
      current.lifecyclePolicies.push({
        path: ev.path ?? 'unknown',
        band: ev.band ?? 'unknown',
        pressurePct: finiteNumber(ev.pressurePct),
        topicShiftConfidence: finiteNumber(ev.topicShiftConfidence),
        trimSoftTarget: finiteNumber(ev.trimSoftTarget),
        reasons: Array.isArray(ev.reasons) ? ev.reasons.filter(r => typeof r === 'string') : [],
        agentId: ev.agentId ?? null,
        sessionKey: ev.sessionKey ?? null,
      });
    }
  }
  if (current) turns.push(current);

  // Churn detection: afterTurn.secondary in turn N, followed by any
  // assemble.* trim event in turn N+1 for the same (agentId, sessionKey).
  for (let i = 0; i + 1 < turns.length; i++) {
    const a = turns[i];
    const b = turns[i + 1];
    const hasAfterTurnSecondary = a.trims.some(t => t.path === 'afterTurn.secondary');
    if (!hasAfterTurnSecondary) continue;
    const aKey = a.trims.find(t => t.path === 'afterTurn.secondary');
    const matchesNextAssemble = b.trims.some(t =>
      t.path.startsWith('assemble.') &&
      (!aKey || (t.agentId === aKey.agentId && t.sessionKey === aKey.sessionKey))
    );
    if (matchesNextAssemble) {
      b.churn = true;
    }
  }

  const lifecyclePolicyPaths = {};
  const lifecycleBandCounts = {};
  const adaptiveBypassReasons = {};
  const topicSignalClassifications = {};
  const topicSignalReasons = {};
  const topicSignalSources = {};
  let topicCoverageTotal = 0;
  let topicCoverageSamples = 0;
  let topicAwareEligibleClusters = 0;
  let topicAwareDroppedClusters = 0;
  let topicAwareProtectedClusters = 0;
  let topicSignalSamples = 0;
  let topicSignalCoverageTotal = 0;
  let topicSignalCoverageSamples = 0;

  for (const t of turns) {
    for (const ev of t.lifecyclePolicies) {
      increment(lifecyclePolicyPaths, ev.path);
      increment(lifecycleBandCounts, `${ev.path}:${ev.band}`);
    }
    if (t.adaptiveEvictionBypassReason) increment(adaptiveBypassReasons, t.adaptiveEvictionBypassReason);
    if (t.adaptiveEvictionTopicIdCoveragePct != null) {
      topicCoverageSamples++;
      topicCoverageTotal += t.adaptiveEvictionTopicIdCoveragePct;
    }
    topicAwareEligibleClusters += t.adaptiveEvictionTopicAwareEligibleClusters ?? 0;
    topicAwareDroppedClusters += t.adaptiveEvictionTopicAwareDroppedClusters ?? 0;
    topicAwareProtectedClusters += t.adaptiveEvictionProtectedClusters ?? 0;
    if (t.topicSignal?.observed) {
      topicSignalSamples++;
      increment(topicSignalClassifications, t.topicSignal.classification);
      increment(topicSignalReasons, t.topicSignal.reason);
      increment(topicSignalSources, t.topicSignal.source);
      if (t.topicSignal.stampedCoveragePct != null) {
        topicSignalCoverageSamples++;
        topicSignalCoverageTotal += t.topicSignal.stampedCoveragePct;
      }
    }
  }

  const totals = {
    turns: turns.length,
    composeCount: turns.reduce((s, t) => s + t.composeCount, 0),
    trimCount: turns.reduce((s, t) => s + t.trimCount, 0),
    tokensRemoved: turns.reduce((s, t) => s + t.tokensRemoved, 0),
    churnTurns: turns.filter(t => t.churn).length,
    lifecyclePolicyCount: turns.reduce((s, t) => s + t.lifecyclePolicies.length, 0),
    lifecyclePolicyPaths,
    lifecycleBandCounts,
    adaptiveBandDivergenceTurns: turns.filter(lifecycleDiverged).length,
    adaptiveBypassReasons,
    topicCoverageSamples,
    averageTopicIdCoveragePct: topicCoverageSamples > 0
      ? Math.round((topicCoverageTotal / topicCoverageSamples) * 1000) / 1000
      : null,
    topicAwareEligibleClusters,
    topicAwareDroppedClusters,
    topicAwareProtectedClusters,
    topicSignalSamples,
    topicSignalClassifications,
    topicSignalReasons,
    topicSignalSources,
    averageTopicSignalStampedCoveragePct: topicSignalCoverageSamples > 0
      ? Math.round((topicSignalCoverageTotal / topicSignalCoverageSamples) * 1000) / 1000
      : null,
  };
  return { turns, totals };
}

function renderText(report, inputPath) {
  const lines = [];
  lines.push('═══════════════════════════════════════════════════');
  lines.push('  HyperMem Trim Telemetry Report');
  lines.push('═══════════════════════════════════════════════════');
  lines.push(`Input:   ${inputPath}`);
  lines.push(`Turns:   ${report.totals.turns}   Compose: ${report.totals.composeCount}   ` +
             `Trims: ${report.totals.trimCount}   Tokens removed: ${report.totals.tokensRemoved}   ` +
             `Churn turns: ${report.totals.churnTurns}`);
  lines.push(`Lifecycle policies: ${report.totals.lifecyclePolicyCount}   ` +
             `Divergence turns: ${report.totals.adaptiveBandDivergenceTurns}   ` +
             `Avg topicId coverage: ${report.totals.averageTopicIdCoveragePct ?? 'n/a'}`);
  if (Object.keys(report.totals.lifecyclePolicyPaths).length > 0) {
    lines.push(`Lifecycle paths: ${Object.entries(report.totals.lifecyclePolicyPaths).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  if (Object.keys(report.totals.adaptiveBypassReasons).length > 0) {
    lines.push(`Adaptive bypass reasons: ${Object.entries(report.totals.adaptiveBypassReasons).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  if (report.totals.topicCoverageSamples > 0) {
    lines.push(`Topic-aware clusters: eligible=${report.totals.topicAwareEligibleClusters}  ` +
               `dropped=${report.totals.topicAwareDroppedClusters}  protected=${report.totals.topicAwareProtectedClusters}`);
  }
  if (report.totals.topicSignalSamples > 0) {
    lines.push(`Topic signal: ${Object.entries(report.totals.topicSignalClassifications).map(([k, v]) => `${k}=${v}`).join('  ')}  ` +
               `avgStampedCoverage=${report.totals.averageTopicSignalStampedCoveragePct ?? 'n/a'}`);
    lines.push(`Topic signal reasons: ${Object.entries(report.totals.topicSignalReasons).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  lines.push('');
  lines.push('Per-turn summary:');
  lines.push('  # | path      | tL | trims | pre→post | removed | churn | turnId');
  lines.push('  --+-----------+----+-------+----------+---------+-------+---------');
  report.turns.forEach((t, i) => {
    const pathStr = (t.path ?? '-').padEnd(9);
    const tl = t.toolLoop ? 'Y' : 'n';
    const pre = t.trims.length > 0 ? String(t.trims[0].preTokens) : '-';
    const post = t.trims.length > 0 ? String(t.trims[t.trims.length - 1].postTokens) : '-';
    const churn = t.churn ? 'YES' : '   ';
    lines.push(
      `  ${String(i).padStart(2)} | ${pathStr} | ${tl}  | ${String(t.trimCount).padStart(5)} | ` +
      `${String(pre).padStart(4)}→${String(post).padEnd(4)} | ${String(t.tokensRemoved).padStart(7)} | ` +
      ` ${churn}  | ${t.turnId ?? '-'}`
    );
    if (t.trims.length > 0) {
      for (const tr of t.trims) {
        lines.push(`       └ ${tr.path.padEnd(22)} removed=${tr.removed} reason=${tr.reason}`);
      }
    }
    if (t.adaptiveEvictionLifecycleBand || t.adaptiveEvictionTopicIdCoveragePct != null || t.adaptiveEvictionBypassReason) {
      lines.push(`       ↳ adaptive compose.eviction band=${t.adaptiveEvictionLifecycleBand ?? '-'} ` +
        `preRecall=${t.adaptiveLifecycleBand ?? '-'} diverged=${Boolean(t.adaptiveLifecycleBandDiverged)} ` +
        `coverage=${t.adaptiveEvictionTopicIdCoveragePct ?? 'n/a'} bypass=${t.adaptiveEvictionBypassReason ?? '-'}`);
    }
    if (t.topicSignal?.observed) {
      lines.push(`       ↳ topicSignal class=${t.topicSignal.classification} reason=${t.topicSignal.reason} ` +
        `source=${t.topicSignal.source} state=${t.topicSignal.state} ` +
        `stamped=${t.topicSignal.stampedMessageCount ?? 'n/a'}/${t.topicSignal.messageCount ?? 'n/a'} ` +
        `coverage=${t.topicSignal.stampedCoveragePct ?? 'n/a'} telemetry=${t.topicSignal.telemetryStatus}`);
    }
    if (t.lifecyclePolicies.length > 0) {
      for (const ev of t.lifecyclePolicies) {
        const pressure = ev.pressurePct == null ? 'n/a' : ev.pressurePct;
        const target = ev.trimSoftTarget == null ? 'n/a' : ev.trimSoftTarget;
        lines.push(`       ↳ lifecycle ${String(ev.path).padEnd(18)} band=${ev.band} pressure=${pressure} trimSoftTarget=${target}`);
      }
    }
  });
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolveInputPath(args.input);
  const events = readJsonl(inputPath);
  const report = buildReport(events);
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(report, inputPath) + '\n');
  }
  // Non-zero exit if churn detected, so the script can gate CI tests.
  if (report.totals.churnTurns > 0) process.exit(2);
}

main();
