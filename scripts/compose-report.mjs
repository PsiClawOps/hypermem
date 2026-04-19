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
