/**
 * HyperMem Plugin Pipeline Validation
 *
 * Verifies the real context-engine plugin assemble() path returns a non-empty
 * systemPromptAddition when facts/knowledge are seeded for a live session.
 *
 * This is intentionally a validation script (not part of root npm test) because
 * it exercises the built plugin dist and its hardcoded home-relative HyperMem
 * import path. The wrapper script builds the plugin first, then runs this file
 * in an isolated temporary HOME.
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

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Plugin Pipeline Validation');
  console.log('═══════════════════════════════════════════════════\n');

  const repoRoot = '/home/lumadmin/.openclaw/workspace/repo/hypermem';
  const realHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-plugin-home-'));
  const dataDir = path.join(tmpHome, '.openclaw', 'hypermem');
  const pluginLinkDir = path.join(tmpHome, '.openclaw', 'workspace', 'repo', 'hypermem');

  fs.mkdirSync(pluginLinkDir, { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'dist'), path.join(pluginLinkDir, 'dist'), 'dir');

  process.env.HOME = tmpHome;

  let hm = null;
  let engine = null;

  try {
    const { HyperMem } = await import(pathToFileURL(path.join(repoRoot, 'dist', 'index.js')).href);

    const agentId = `plugin-test-${Date.now().toString(36)}`;
    const sessionKey = `agent:${agentId}:webchat:main`;
    const sessionFile = path.join(tmpHome, 'session.jsonl');
    fs.writeFileSync(sessionFile, '');

    hm = await HyperMem.create({
      dataDir,
      redis: { host: 'localhost', port: 6379, keyPrefix: 'hm:' },
    });

    hm.dbManager.ensureAgent(agentId, { displayName: 'Plugin Test Agent', tier: 'council' });

    await hm.recordUserMessage(agentId, sessionKey, 'Can you review the deployment checklist?');
    await hm.recordAssistantMessage(agentId, sessionKey, {
      role: 'assistant',
      textContent: 'Yes — I can review the deployment checklist.',
      toolCalls: null,
      toolResults: null,
    });
    await hm.recordUserMessage(agentId, sessionKey, 'Also include any governance constraints.');

    hm.addFact(agentId, 'PLUGIN_PIPELINE_FACT Kubernetes staging deployment requires readiness gates.', {
      domain: 'deployments',
      confidence: 0.99,
      visibility: 'fleet',
    });
    hm.upsertKnowledge(
      agentId,
      'deployments',
      'staging-rollout',
      'PLUGIN_PIPELINE_KNOWLEDGE Kubernetes staging deployment requires rollout checks and rollback verification.',
      { confidence: 0.95, sourceType: 'validation' },
    );

    await hm.close();
    hm = null;

    const pluginEntry = (await import(pathToFileURL(path.join(repoRoot, 'plugin', 'dist', 'index.js')).href)).default;
    pluginEntry.register({
      registerContextEngine(_id, factory) {
        engine = factory();
      },
    });

    assert(engine != null, 'Plugin registered a context engine');

    await engine.bootstrap({
      sessionId: 'plugin-pipeline-session',
      sessionKey,
      sessionFile,
    });

    const assembleResult = await engine.assemble({
      sessionId: 'plugin-pipeline-session',
      sessionKey,
      messages: [],
      tokenBudget: 12000,
      model: 'claude-opus-4-6',
      prompt: 'kubernetes staging deployment',
    });

    assert(Array.isArray(assembleResult.messages), 'assemble() returned a message array');
    assert(assembleResult.messages.length > 0, `assemble() returned ${assembleResult.messages.length} messages`);
    assert(typeof assembleResult.estimatedTokens === 'number' && assembleResult.estimatedTokens > 0,
      `assemble() estimated tokens: ${assembleResult.estimatedTokens}`);
    assert(typeof assembleResult.systemPromptAddition === 'string' && assembleResult.systemPromptAddition.length > 0,
      'assemble() returned non-empty systemPromptAddition');
    assert(assembleResult.systemPromptAddition.includes('PLUGIN_PIPELINE_FACT')
      || assembleResult.systemPromptAddition.includes('PLUGIN_PIPELINE_KNOWLEDGE'),
      'systemPromptAddition contains seeded L4 memory');
    assert(assembleResult.systemPromptAddition.includes('Kubernetes staging deployment'),
      'systemPromptAddition reflects prompt-aware retrieval content');

    await engine.dispose?.();
  } catch (err) {
    console.error('\n💥 Validation error:', err);
    failed++;
  } finally {
    try {
      await engine?.dispose?.();
    } catch {}
    try {
      await hm?.close?.();
    } catch {}
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
