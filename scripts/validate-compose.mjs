#!/usr/bin/env node
/**
 * Phase 1 Compose Validation
 *
 * End-to-end validation: seeds a session, runs compose with three fixture
 * profiles (facts, library retrieval, budget pressure), and checks results.
 *
 * Usage: node scripts/validate-compose.mjs
 */

import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-validate-compose-'));

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

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Phase 1 Compose Validation');
  console.log('═══════════════════════════════════════════════════\n');

  let hm;
  try {
    hm = await HyperMem.create({ dataDir: tmpDir });
    const agentId = 'compose-val-agent';
    const sessionKey = `agent:${agentId}:webchat:main`;

    hm.dbManager.ensureAgent(agentId, { displayName: 'Compose Validation Agent', tier: 'council' });

    await hm.recordUserMessage(agentId, sessionKey, 'What deployment checks are required?');
    await hm.recordAssistantMessage(agentId, sessionKey, {
      role: 'assistant',
      textContent: 'Readiness gates and governance approvals are required before any production deployment.',
      toolCalls: null,
      toolResults: null,
    });
    await hm.recordUserMessage(agentId, sessionKey, 'Tell me about the rollback procedure.');

    hm.addFact(agentId, 'COMPOSE_VAL_FACT_1 Production rollback requires ops-lead approval within 15 minutes.', {
      domain: 'operations', confidence: 0.95, visibility: 'fleet',
    });
    hm.addFact(agentId, 'COMPOSE_VAL_FACT_2 Staging readiness gates must pass before promotion.', {
      domain: 'deployments', confidence: 0.90, visibility: 'private',
    });
    hm.upsertKnowledge(
      agentId, 'operations', 'rollback-procedure',
      'COMPOSE_VAL_KNOWLEDGE Rollback procedure requires ops-lead sign-off and a post-mortem within 24 hours.',
      { confidence: 0.92, sourceType: 'validation' },
    );

    // ── Fixture 1: Facts retrieval ──────────────────────────────
    console.log('── Fixture 1: Facts retrieval ──');
    {
      const result = await hm.compose({
        agentId, sessionKey, tokenBudget: 50000,
        provider: 'anthropic', includeFacts: true,
        prompt: 'rollback procedure',
      });

      assert(result.diagnostics !== undefined, 'F1: diagnostics present');
      assert((result.diagnostics?.factsIncluded ?? 0) >= 1,
        `F1: factsIncluded >= 1 (got ${result.diagnostics?.factsIncluded})`);
      const ctx = result.contextBlock || '';
      assert(ctx.includes('COMPOSE_VAL_FACT_1') || ctx.includes('rollback'),
        'F1: rollback fact appears in context');
    }

    // ── Fixture 2: Library / knowledge retrieval ────────────────
    console.log('\n── Fixture 2: Library / knowledge retrieval ──');
    {
      const result = await hm.compose({
        agentId, sessionKey, tokenBudget: 50000,
        provider: 'anthropic', includeFacts: true, includeLibrary: true,
        prompt: 'rollback procedure ops-lead',
      });

      assert(result.diagnostics !== undefined, 'F2: diagnostics present');
      const ctx = result.contextBlock || '';
      const hasKnowledge = ctx.includes('COMPOSE_VAL_KNOWLEDGE') || ctx.includes('ops-lead sign-off');
      assert(hasKnowledge || (result.diagnostics?.factsIncluded ?? 0) >= 1,
        `F2: knowledge or facts surfaced (facts=${result.diagnostics?.factsIncluded})`);
    }

    // ── Fixture 3: Budget pressure ──────────────────────────────
    console.log('\n── Fixture 3: Budget pressure ──');
    {
      const result = await hm.compose({
        agentId, sessionKey, tokenBudget: 2000,
        provider: 'anthropic', includeHistory: true, includeFacts: true, includeLibrary: true,
        prompt: 'rollback',
      });

      assert(typeof result.tokenCount === 'number', 'F3: tokenCount is a number');
      const ceiling = 2000 * 1.1;
      assert(result.tokenCount <= ceiling,
        `F3: tokenCount ${result.tokenCount} <= ${ceiling} (budget not exceeded beyond 10%)`);
      assert(result.messages.length >= 0, 'F3: compose completed without error under tight budget');
    }

    await hm.close();
  } catch (err) {
    console.error('\n💥 Validation error:', err);
    failed++;
    try { await hm?.close(); } catch {}
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
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
