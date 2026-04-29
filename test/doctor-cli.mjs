import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const doctor = path.join(root, 'bin', 'hypermem-doctor.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'hypermem-doctor-'));
const dataDir = path.join(tmp, 'hypermem');
mkdirSync(path.join(dataDir, 'agents', 'forge'), { recursive: true });
writeFileSync(path.join(dataDir, 'library.db'), '');
writeFileSync(path.join(dataDir, 'vectors.db'), '');
writeFileSync(path.join(dataDir, 'agents', 'forge', 'messages.db'), '');

const goodConfig = {
  plugins: {
    load: { paths: [path.join(tmp, 'hypermem', 'plugin'), path.join(tmp, 'hypermem', 'memory-plugin')] },
    slots: { contextEngine: 'hypercompositor', memory: 'hypermem' },
    allow: ['hypercompositor', 'hypermem'],
    entries: {
      hypercompositor: {
        config: {
          dataDir,
          contextWindowOverrides: {
            'openai-codex/gpt-5.4': { contextTokens: 128000, contextWindow: 128000 },
          },
          embedding: { provider: 'ollama', model: 'nomic-embed-text', dims: 768, dimensions: 768 },
          compositor: {
            turnBudget: { budgetFraction: 0.6, minContextFraction: 0.18 },
            warming: { protectedFloorEnabled: true, shapedWarmupDecay: true },
            adjacency: {
              enabled: true,
              boostMultiplier: 1.3,
              maxLookback: 5,
              maxClockDeltaMin: 10,
              evictionGuardMessages: 3,
              evictionGuardTokenCap: 4000,
            },
          },
        },
      },
    },
  },
  agents: {
    defaults: {
      model: 'openai-codex/gpt-5.4',
      contextPruning: { mode: 'off' },
      promptOverlays: { gpt5: { personality: 'off' } },
      startupContext: { dailyMemoryDays: 4, maxFileChars: 4000, maxTotalChars: 12000, maxFileBytes: 32768 },
      bootstrapMaxChars: 20000,
      compaction: { mode: 'safeguard', reserveTokens: 16384, keepRecentTokens: 6000, reserveTokensFloor: 15000, maxHistoryShare: 0.65 },
    },
  },
};
const goodPath = path.join(tmp, 'openclaw.good.json');
writeFileSync(goodPath, JSON.stringify(goodConfig, null, 2));

let result = spawnSync(process.execPath, [doctor, '--openclaw-config', goodPath, '--data-dir', dataDir, '--skip-runtime', '--json', '--strict'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr || result.stdout);
let parsed = JSON.parse(result.stdout);
assert.equal(parsed.counts.fail, 0);
assert.equal(parsed.counts.warn, 0);
assert.equal(parsed.strictStatus, 'ok');

const badConfig = structuredClone(goodConfig);
badConfig.plugins.slots.contextEngine = 'legacy';
badConfig.plugins.allow = ['hypercompositor'];
badConfig.agents.defaults.contextPruning.mode = 'cache-ttl';
badConfig.agents.defaults.promptOverlays.gpt5.personality = 'friendly';
delete badConfig.plugins.entries.hypercompositor.config.contextWindowOverrides;
const badPath = path.join(tmp, 'openclaw.bad.json');
writeFileSync(badPath, JSON.stringify(badConfig, null, 2));

result = spawnSync(process.execPath, [doctor, '--openclaw-config', badPath, '--data-dir', dataDir, '--skip-runtime', '--json'], { encoding: 'utf8' });
assert.equal(result.status, 1, result.stderr || result.stdout);
parsed = JSON.parse(result.stdout);
assert.equal(parsed.status, 'fail');
assert(parsed.checks.some(c => c.id === 'context-engine-slot' && c.status === 'fail'));
assert(parsed.checks.some(c => c.id === 'agents.defaults.contextPruning.mode' && c.status === 'fail'));
assert(parsed.checks.some(c => c.id === 'model-window:openai-codex/gpt-5.4' && c.status === 'warn'));
assert(parsed.fixPlan.some(cmd => cmd.includes('plugins.slots.contextEngine')));

console.log('doctor-cli tests passed');
