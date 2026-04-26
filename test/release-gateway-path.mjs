import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const coreDist = path.join(repoRoot, 'dist', 'index.js');
const pluginDist = path.join(repoRoot, 'plugin', 'dist', 'index.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed += 1;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    failed += 1;
  }
}

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => {
      if (typeof block === 'string') return block;
      if (block && typeof block.text === 'string') return block.text;
      if (block && typeof block.content === 'string') return block.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function collectSystemContext(result) {
  return [
    ...((result.messages || [])
      .filter(msg => msg.role === 'system')
      .map(msg => flattenContent(msg.content))),
    result.systemPromptAddition || '',
  ].filter(Boolean).join('\n\n');
}

function collectToolResultTexts(messages) {
  return (messages || [])
    .filter(msg => msg.role === 'toolResult')
    .map(msg => flattenContent(msg.content))
    .filter(Boolean);
}

function readTelemetry(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function latestEvent(events, predicate) {
  const matches = events.filter(predicate);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  HyperMem 0.8.1 Release Path Verification');
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (!fs.existsSync(coreDist)) {
    console.error('  dist not found. Run: npm run build');
    process.exit(1);
  }
  if (!fs.existsSync(pluginDist)) {
    console.error('  plugin dist not found. Run: npm --prefix plugin run build');
    process.exit(1);
  }

  const realHome = process.env.HOME;
  const realTelemetryFlag = process.env.HYPERMEM_TELEMETRY;
  const realTelemetryPath = process.env.HYPERMEM_TELEMETRY_PATH;
  const keepTmp = process.env.HYPERMEM_KEEP_RELEASE_TMP === '1';

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-release-path-'));
  const dataDir = path.join(tmpHome, '.openclaw', 'hypermem');
  const pluginLinkDir = path.join(tmpHome, '.openclaw', 'workspace', 'repo', 'hypermem');
  const telemetryPath = path.join(tmpHome, 'release-telemetry.jsonl');

  fs.mkdirSync(pluginLinkDir, { recursive: true });
  fs.symlinkSync(path.join(repoRoot, 'dist'), path.join(pluginLinkDir, 'dist'), 'dir');

  process.env.HOME = tmpHome;
  process.env.HYPERMEM_TELEMETRY = '1';
  process.env.HYPERMEM_TELEMETRY_PATH = telemetryPath;

  let hm = null;
  let engine = null;
  let preserveTmp = keepTmp;

  try {
    const { HyperMem } = await import(`${pathToFileURL(coreDist).href}?release=${Date.now()}`);

    const agentId = `release-path-${Date.now().toString(36)}`;
    const composeSessionKey = `agent:${agentId}:webchat:release-compose`;
    const replaySessionKey = `agent:${agentId}:webchat:release-replay`;
    const composeSessionFile = path.join(tmpHome, 'compose-session.jsonl');
    const replaySessionFile = path.join(tmpHome, 'replay-session.jsonl');
    fs.writeFileSync(composeSessionFile, '');
    fs.writeFileSync(replaySessionFile, '');

    hm = await HyperMem.create({ dataDir });
    hm.dbManager.ensureAgent(agentId, { displayName: 'Release Verification Agent', tier: 'council' });

    hm.addFact(
      agentId,
      'RELEASE_FACT prompt-path verification requires degradation telemetry.',
      { domain: 'release', confidence: 0.99, visibility: 'fleet' },
    );

    const artifactQuery = 'tool plugin path';
    const docPath = path.join(tmpHome, 'release-artifact.md');
    const oversizedDoc = [
      '# Release Verification',
      '',
      '## Prompt Path Artifact',
      '',
      `${artifactQuery} `.repeat(1200),
      '',
      'This chunk is intentionally oversized so the compositor must degrade it to an artifact reference.',
    ].join('\n');
    fs.writeFileSync(docPath, oversizedDoc);
    const seededDoc = hm.seedFile(docPath, 'operations/tools', { agentId, force: true });
    assert(
      seededDoc.result.inserted > 0 || seededDoc.result.reindexed || seededDoc.result.skipped,
      'seeded oversized doc chunk for artifact degradation coverage',
    );
    const seededHits = hm.queryDocChunks({ collection: 'operations/tools', agentId, keyword: 'tool', limit: 5 });
    assert(seededHits.length > 0, 'seeded artifact doc is queryable before plugin validation');

    const msgDb = hm.dbManager.getMessageDb(agentId);
    msgDb.prepare(`
      INSERT INTO conversations (
        session_key, session_id, agent_id, channel_type, status,
        message_count, token_count_in, token_count_out, created_at, updated_at
      ) VALUES (?, ?, ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
    `).run(composeSessionKey, 'release-compose-session', agentId);

    const conversation = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(composeSessionKey);
    const insertMessage = msgDb.prepare(`
      INSERT INTO messages (
        conversation_id, agent_id, role, text_content, tool_calls, tool_results,
        message_index, is_heartbeat, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
    `);

    const callId = 'release_stub_call';
    insertMessage.run(
      conversation.id,
      agentId,
      'assistant',
      'old tool call that should be ejected under release-path budget pressure',
      JSON.stringify([{ id: callId, name: 'web_search', arguments: JSON.stringify({ query: 'release prompt path', payload: 'A'.repeat(9000) }) }]),
      null,
      1,
    );
    insertMessage.run(
      conversation.id,
      agentId,
      'user',
      'tool output summary should survive as a canonical stub',
      null,
      JSON.stringify([{ callId, name: 'web_search', content: 'Search results for release-path verification.', isError: false }]),
      2,
    );
    insertMessage.run(
      conversation.id,
      agentId,
      'assistant',
      'recent assistant context that should remain visible after safety-valve trimming',
      null,
      null,
      3,
    );

    await hm.close();
    hm = null;

    const pluginEntry = (await import(`${pathToFileURL(pluginDist).href}?release=${Date.now()}`)).default;
    pluginEntry.register({
      registerContextEngine(_id, factory) {
        engine = factory();
      },
    });

    assert(engine != null, 'plugin registered a context engine');

    console.log('── Compose path: artifact + tool-chain degradation ──');
    await engine.bootstrap({
      sessionId: 'release-compose',
      sessionKey: composeSessionKey,
      sessionFile: composeSessionFile,
    });

    const composeResult = await engine.assemble({
      sessionId: 'release-compose',
      sessionKey: composeSessionKey,
      messages: [],
      tokenBudget: 3000,
      model: 'claude-opus-4-6',
      prompt: artifactQuery,
    });

    const composeSystemContext = collectSystemContext(composeResult);

    assert(Array.isArray(composeResult.messages), 'compose path returned messages');
    assert(composeSystemContext.includes('RELEASE_FACT'), 'compose path injected seeded fact into system context');
    assert(composeSystemContext.includes('[artifact:'), 'compose path emitted a canonical artifact reference');

    await new Promise(resolve => setTimeout(resolve, 50));
    let telemetry = readTelemetry(telemetryPath);
    const composeTrace = latestEvent(
      telemetry,
      event => event.event === 'assemble' && event.sessionKey === composeSessionKey,
    );
    const composeDegradation = latestEvent(
      telemetry,
      event => event.event === 'degradation' && event.sessionKey === composeSessionKey && event.path === 'compose',
    );

    assert(composeTrace?.toolLoop === false, 'compose telemetry recorded a normal assemble turn');
    assert(Boolean(composeDegradation?.turnId), 'compose degradation telemetry includes a turn id');
    assert((composeDegradation?.toolChainCoEjections ?? 0) > 0, 'compose degradation telemetry counted tool-chain co-ejections');
    assert((composeDegradation?.artifactDegradations ?? 0) > 0, 'compose degradation telemetry counted artifact degradations');
    assert((composeDegradation?.artifactOversizeThresholdTokens ?? 0) > 0, 'compose degradation telemetry recorded artifact threshold');

    console.log('\n── Tool-loop path: replay recovery marker ──');
    await engine.bootstrap({
      sessionId: 'release-replay',
      sessionKey: replaySessionKey,
      sessionFile: replaySessionFile,
    });

    const toolLoopMessages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'replay_call', name: 'web_search', arguments: { query: 'release replay verification' } },
        ],
        api: 'unknown',
        provider: 'unknown',
        model: 'unknown',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'toolUse',
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: 'replay_call',
        toolName: 'web_search',
        content: [{ type: 'text', text: 'R'.repeat(18000) }],
        isError: false,
        timestamp: Date.now(),
      },
    ];

    const replayResult = await engine.assemble({
      sessionId: 'release-replay',
      sessionKey: replaySessionKey,
      messages: toolLoopMessages,
      tokenBudget: 4000,
      model: 'claude-opus-4-6',
      prompt: 'release replay verification',
    });

    assert(
      typeof replayResult.systemPromptAddition === 'string' && replayResult.systemPromptAddition.includes('[replay state=entering'),
      'tool-loop path emitted the canonical replay recovery marker',
    );
    assert(Array.isArray(replayResult.messages), 'tool-loop path returned messages');

    await new Promise(resolve => setTimeout(resolve, 50));
    telemetry = readTelemetry(telemetryPath);
    const replayTrace = latestEvent(
      telemetry,
      event => event.event === 'assemble' && event.sessionKey === replaySessionKey,
    );
    const replayDegradation = latestEvent(
      telemetry,
      event => event.event === 'degradation' && event.sessionKey === replaySessionKey && event.path === 'toolLoop',
    );

    assert(replayTrace?.toolLoop === true, 'tool-loop telemetry recorded toolLoop=true');
    assert(replayDegradation?.replayState === 'entering', 'tool-loop degradation telemetry recorded replay entering state');
    assert(replayDegradation?.replayReason === 'replay_cold_redis', 'tool-loop degradation telemetry recorded replay reason');

    await engine.dispose?.();
    engine = null;
  } catch (err) {
    preserveTmp = true;
    console.error('\n💥 Release path verification failed:', err);
    failed += 1;
  } finally {
    try { await engine?.dispose?.(); } catch {}
    try { await hm?.close?.(); } catch {}

    process.env.HOME = realHome;
    if (realTelemetryFlag == null) delete process.env.HYPERMEM_TELEMETRY;
    else process.env.HYPERMEM_TELEMETRY = realTelemetryFlag;
    if (realTelemetryPath == null) delete process.env.HYPERMEM_TELEMETRY_PATH;
    else process.env.HYPERMEM_TELEMETRY_PATH = realTelemetryPath;

    if (preserveTmp || failed > 0) {
      console.log(`\nPreserved temp verification workspace: ${tmpHome}`);
    } else {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
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

main().catch(err => {
  console.error('Fatal release verification error:', err);
  process.exit(1);
});
