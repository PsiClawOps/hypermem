import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = mkdtempSync(path.join(tmpdir(), 'hypermem-model-audit-'));
const openclawConfig = path.join(tempDir, 'openclaw.json');
const hypermemConfig = path.join(tempDir, 'config.json');
const script = path.resolve('bin/hypermem-model-audit.mjs');

writeFileSync(openclawConfig, JSON.stringify({
  agents: {
    defaults: { model: 'openai-codex/gpt-5.4' },
    list: [
      { id: 'local', model: 'foo/bar' },
      { id: 'safe', model: 'anthropic/claude-sonnet-4-6' }
    ]
  }
}, null, 2));

writeFileSync(hypermemConfig, JSON.stringify({
  compositor: {
    contextWindowOverrides: {
      'openai-codex/gpt-5.4': { contextTokens: 200000, contextWindow: 200000 }
    }
  }
}, null, 2));

const run = spawnSync(process.execPath, [
  script,
  '--openclaw-config', openclawConfig,
  '--hypermem-config', hypermemConfig,
  '--json'
], { encoding: 'utf8' });

if (run.status !== 1) {
  console.error(run.stdout);
  console.error(run.stderr);
  throw new Error(`expected exit code 1 because foo/bar should fail, got ${run.status}`);
}

const report = JSON.parse(run.stdout);
const byModel = new Map(report.models.map(item => [item.model, item]));

if (byModel.get('openai-codex/gpt-5.4')?.status !== 'ok') {
  throw new Error('expected explicit override to make openai-codex/gpt-5.4 ok');
}

if (byModel.get('foo/bar')?.status !== 'fail') {
  throw new Error('expected unknown model foo/bar to fail');
}

if (byModel.get('anthropic/claude-sonnet-4-6')?.status !== 'ok') {
  throw new Error('expected known safe model family to pass autodetect');
}

rmSync(tempDir, { recursive: true, force: true });
console.log('model-audit-cli ok');
