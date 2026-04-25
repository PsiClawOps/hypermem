#!/usr/bin/env node
/**
 * Compact Compose Report
 *
 * Runs a seeded compose pass and prints a compact operator-readable report
 * showing selected layers, budget decisions, and diagnostics.
 *
 * Usage: node scripts/compose-report.mjs [--data-dir <path>] [--agent <id>]
 */

import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const args = process.argv.slice(2);
const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : null;
const agentId = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : 'report-agent';

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
    stampedCoveragePct: topicSignalCoverage(d.composeTopicStampedMessageCount, d.composeTopicMessageCount),
  };
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Compose Report');
  console.log('═══════════════════════════════════════════════════\n');

  const tmpDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'hm-compose-report-'));
  const isTemp = !dataDir;

  let hm;
  try {
    hm = await HyperMem.create({ dataDir: tmpDir });

    const sessionKey = `agent:${agentId}:webchat:main`;

    hm.dbManager.ensureAgent(agentId, { displayName: 'Report Agent', tier: 'council' });

    await hm.recordUserMessage(agentId, sessionKey, 'What is the current deployment status?');
    await hm.recordAssistantMessage(agentId, sessionKey, {
      role: 'assistant',
      textContent: 'The staging environment is running v2.4.1 with all health checks passing.',
      toolCalls: null,
      toolResults: null,
    });
    await hm.recordUserMessage(agentId, sessionKey, 'Are there any governance constraints for the next release?');

    hm.addFact(agentId, 'Production releases require two approvals from the governance council.', {
      domain: 'governance',
      confidence: 0.95,
      visibility: 'fleet',
    });
    hm.addFact(agentId, 'Staging deployment must pass readiness gates before promotion.', {
      domain: 'deployments',
      confidence: 0.90,
      visibility: 'private',
    });
    hm.upsertKnowledge(
      agentId,
      'governance',
      'release-policy',
      'All production releases follow the two-approval governance policy with mandatory staging validation.',
      { confidence: 0.92, sourceType: 'validation' },
    );

    for (const budget of [50000, 4000]) {
      const result = await hm.compose({
        agentId,
        sessionKey,
        tokenBudget: budget,
        provider: 'anthropic',
        includeHistory: true,
        includeFacts: true,
        includeLibrary: true,
        prompt: 'governance constraints for next release',
      });

      const d = result.diagnostics ?? {};

      console.log(`── Budget: ${budget.toLocaleString()} tokens ──`);
      console.log(`  Token count:      ${result.tokenCount}`);
      console.log(`  Messages:         ${result.messages.length}`);
      console.log(`  Truncated:        ${result.truncated ?? false}`);
      console.log(`  Warnings:         ${result.warnings?.length ?? 0}`);
      console.log('  Layers:');
      if (result.slots) {
        for (const [name, count] of Object.entries(result.slots)) {
          if (count > 0) console.log(`    ${name}: ${count}`);
        }
      }
      console.log('  Diagnostics:');
      console.log(`    factsIncluded:          ${d.factsIncluded ?? 0}`);
      console.log(`    semanticResultsIncluded:${d.semanticResultsIncluded ?? 0}`);
      console.log(`    triggerHits:            ${d.triggerHits ?? 0}`);
      console.log(`    scopeFiltered:          ${d.scopeFiltered ?? 0}`);
      console.log(`    retrievalMode:          ${d.retrievalMode ?? 'n/a'}`);
      console.log(`    dynamicReserveActive:   ${d.dynamicReserveActive ?? false}`);
      if (d.composeTopicState != null || d.composeTopicTelemetryStatus != null ||
          d.composeTopicMessageCount != null || d.composeTopicStampedMessageCount != null) {
        const topicSignal = classifyTopicSignal(d);
        console.log('    composeTopicSignal:');
        console.log(`      class:                ${topicSignal.classification}`);
        console.log(`      reason:               ${topicSignal.reason}`);
        console.log(`      source:               ${topicSignal.source}`);
        console.log(`      state:                ${topicSignal.state}`);
        console.log(`      stampedHistory:       ${d.composeTopicStampedMessageCount ?? 'n/a'}/${d.composeTopicMessageCount ?? 'n/a'} ` +
                    `coverage=${topicSignal.stampedCoveragePct ?? 'n/a'}`);
        console.log(`      telemetry:            ${topicSignal.telemetryStatus}`);
      }
      // Sprint 1: observability fields
      if (d.rerankerStatus != null) {
        console.log(`    rerankerStatus:         ${d.rerankerStatus}`);
        console.log(`    rerankerCandidates:     ${d.rerankerCandidates ?? 0}`);
        console.log(`    rerankerProvider:       ${d.rerankerProvider ?? 'n/a'}`);
      }
      if (d.prefixChanged != null) {
        console.log(`    prefixChanged:          ${d.prefixChanged}`);
      }
      if (d.slotSpans) {
        console.log('    slotSpans:');
        for (const [slotName, span] of Object.entries(d.slotSpans)) {
          if (span.filled > 0) {
            const overflow = span.overflow ? ' [OVERFLOW]' : '';
            console.log(`      ${slotName}: filled=${span.filled} allocated=${span.allocated}${overflow}`);
          }
        }
      }
      if (d.compactionEligibleCount != null) {
        const ratio = d.compactionEligibleRatio != null ? ` ratio=${d.compactionEligibleRatio.toFixed(3)}` : '';
        const processed = d.compactionProcessedCount != null ? ` processed=${d.compactionProcessedCount}` : '';
        console.log(`    compactionEligible:     ${d.compactionEligibleCount}${ratio}${processed}`);
      }
      if (d.adaptiveLifecycleBand != null || d.adaptiveEvictionLifecycleBand != null) {
        console.log('    adaptiveLifecycle:');
        if (d.adaptiveLifecycleBand != null) {
          console.log(`      compose.preRecall:    band=${d.adaptiveLifecycleBand} pressure=${d.adaptiveLifecyclePressurePct ?? 'n/a'} ` +
                      `recallBudget=${d.adaptiveRecallBudgetTokens ?? 'n/a'} candidates=${d.adaptiveRecallCandidateLimit ?? 'n/a'}`);
          if (Array.isArray(d.adaptiveLifecycleReasons) && d.adaptiveLifecycleReasons.length > 0) {
            console.log(`      reasons:              ${d.adaptiveLifecycleReasons.join(',')}`);
          }
        }
        if (d.adaptiveEvictionLifecycleBand != null) {
          console.log(`      compose.eviction:     band=${d.adaptiveEvictionLifecycleBand} pressure=${d.adaptiveEvictionPressurePct ?? 'n/a'} ` +
                      `diverged=${d.adaptiveLifecycleBandDiverged ?? false}`);
          console.log(`      topicIdCoveragePct:   ${d.adaptiveEvictionTopicIdCoveragePct ?? 'n/a'}`);
          console.log(`      topicAwareClusters:   eligible=${d.adaptiveEvictionTopicAwareEligibleClusters ?? 0} ` +
                      `dropped=${d.adaptiveEvictionTopicAwareDroppedClusters ?? 0} protected=${d.adaptiveEvictionProtectedClusters ?? 0}`);
          console.log(`      bypassReason:         ${d.adaptiveEvictionBypassReason ?? 'n/a'}`);
        }
      }
      if (result.warnings?.length > 0) {
        console.log('  Warnings:');
        for (const w of result.warnings) {
          console.log(`    - ${w}`);
        }
      }
      console.log('');
    }

    await hm.close();
  } catch (err) {
    console.error('Report failed:', err);
    try { await hm?.close(); } catch {}
    process.exit(1);
  } finally {
    if (isTemp) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log('═══════════════════════════════════════════════════');
  console.log('  Report complete');
  console.log('═══════════════════════════════════════════════════');
}

run();
