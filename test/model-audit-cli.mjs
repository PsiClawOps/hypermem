import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = mkdtempSync(path.join(tmpdir(), 'hypermem-model-audit-'));
const openclawConfig = path.join(tempDir, 'openclaw.json');
const hypermemConfig = path.join(tempDir, 'config.json');
const script = path.resolve('bin/hypermem-model-audit.mjs');

writeFileSync(openclawConfig, JSON.stringify({
  models: {
    providers: {
      openai: {
        models: ['gpt-4o-mini']
      },
      localproxy: {
        models: [{ id: 'mystery-large' }]
      }
    }
  },
  agents: {
    defaults: {
      model: 'openai-codex/gpt-5.4',
      models: {
        'ollama/qwen3-custom': {}
      }
    },
    list: [
      { id: 'local', model: 'foo/bar' },
      { id: 'safe', model: 'anthropic/claude-sonnet-4-6' }
    ]
  },
  channels: {
    modelByChannel: {
      discord: {
        '123': 'openai-codex/GPT-5.4'
      }
    }
  },
  tools: {
    media: {
      models: [
        { provider: 'openai', model: 'gpt-image-2' }
      ]
    }
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

if (byModel.get('openai/gpt-4o-mini')?.status !== 'warn') {
  throw new Error('expected registered OpenAI provider catalog model to warn without override');
}

if (byModel.get('ollama/qwen3-custom')?.status !== 'warn') {
  throw new Error('expected registered agents.defaults.models entry to be audited');
}

if (byModel.get('localproxy/mystery-large')?.status !== 'fail') {
  throw new Error('expected unknown registered provider catalog model to fail');
}

if (!byModel.get('openai/gpt-4o-mini')?.validationActions?.length) {
  throw new Error('expected high-risk models to include validation actions');
}

const configuredOnly = spawnSync(process.execPath, [
  script,
  '--openclaw-config', openclawConfig,
  '--hypermem-config', hypermemConfig,
  '--json',
  '--configured-only'
], { encoding: 'utf8' });

const configuredOnlyReport = JSON.parse(configuredOnly.stdout);
const configuredOnlyModels = new Map(configuredOnlyReport.models.map(item => [item.model, item]));

if (configuredOnlyModels.has('localproxy/mystery-large')) {
  throw new Error('expected --configured-only to omit provider catalog-only models');
}

rmSync(tempDir, { recursive: true, force: true });
console.log('model-audit-cli ok');
