import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HyperMem } from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

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

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem C2 Regression: Doc Chunk Artifact Retrieval');
  console.log('═══════════════════════════════════════════════════\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-doc-artifact-'));
  const dataDir = path.join(tmpDir, 'hypermem');
  const docPath = path.join(tmpDir, 'artifact-source.md');

  let hm = null;
  try {
    hm = await HyperMem.create({ dataDir });

    const agentId = 'doc-artifact-test';
    const sessionKey = `agent:${agentId}:webchat:main`;
    hm.dbManager.ensureAgent(agentId, { displayName: 'Doc Artifact Test', tier: 'council' });

    fs.writeFileSync(docPath, [
      '# Tooling',
      '',
      '## Prompt Path Artifact',
      '',
      'tool plugin path '.repeat(1500),
      '',
      'This section must degrade to an artifact reference before the collection budget gate runs.',
    ].join('\n'));

    const seeded = hm.seedFile(docPath, 'operations/tools', { agentId, force: true });
    assert(seeded.result.inserted > 0 || seeded.result.reindexed || seeded.result.skipped,
      'seeded oversized operations/tools doc chunk');

    const msgDb = hm.dbManager.getMessageDb(agentId);
    const libDb = hm.dbManager.getLibraryDb();

    const result = await hm.compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 4000,
      prompt: 'tool plugin path',
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      includeHistory: false,
      includeFacts: false,
      includeLibrary: true,
      includeContext: false,
    }, msgDb, libDb);

    const systemText = (result.contextBlock || '') + '\n' + result.messages
      .filter(msg => msg.role === 'system' && typeof msg.content === 'string')
      .map(msg => msg.content)
      .join('\n');

    assert(systemText.includes('[artifact:'), 'compose output contains canonical artifact reference');
    assert((result.diagnostics?.artifactDegradations ?? 0) > 0, 'compose diagnostics count artifact degradation');
    assert(result.diagnostics?.docChunksCollections === 1, `doc chunk collection count is 1 (got ${result.diagnostics?.docChunksCollections})`);
  } catch (err) {
    console.error('Fatal doc chunk artifact retrieval failure:', err);
    failed += 1;
  } finally {
    try { await hm?.close?.(); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
  console.error('Unhandled doc chunk artifact retrieval error:', err);
  process.exit(1);
});
