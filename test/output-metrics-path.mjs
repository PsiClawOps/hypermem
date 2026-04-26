import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const pluginDist = path.join(repoRoot, 'plugin', 'dist', 'index.js');

const realHome = process.env.HOME;
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-output-metrics-'));
const dataDir = path.join(tmpHome, '.openclaw', 'hypermem');
const configPath = path.join(dataDir, 'config.json');
const pluginDataDir = dataDir;
const sessionKey = 'agent:metrics-agent:webchat:metrics';
const sessionFile = path.join(tmpHome, 'turn.jsonl');

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({ embedding: { provider: 'none' } }, null, 2));
fs.writeFileSync(sessionFile, '');
process.env.HOME = tmpHome;

let engine = null;
let failed = false;

try {
  const pluginEntry = (await import(`${pathToFileURL(pluginDist).href}?metrics=${Date.now()}`)).default;
  pluginEntry.register({
    registerContextEngine(_id, factory) {
      engine = factory();
    },
  });

  assert(engine, 'plugin registered a context engine');

  const messages = [
    {
      role: 'user',
      content: 'status telemetry ping',
      timestamp: Date.now(),
      provider: 'openrouter',
      model: 'qwen/qwen3-instruct',
      api: 'unknown',
      usage: { input: 24, output: 0, cacheRead: 0 },
    },
    {
      role: 'assistant',
      content: 'status telemetry pong',
      timestamp: Date.now(),
      provider: 'openrouter',
      model: 'qwen/qwen3-instruct',
      api: 'unknown',
      usage: { output_tokens: 42, input_tokens: 100, cache_read_tokens: 25 },
    },
  ];

  await engine.afterTurn({
    sessionId: 'metrics-agent-turn',
    sessionKey,
    sessionFile,
    messages,
    prePromptMessageCount: 0,
    runtimeContext: {
      currentTokenCount: 100,
      promptCache: {
        lastCallUsage: {
          input: 100,
          output: 42,
          cacheRead: 25,
        },
      },
    },
  });

  const libraryDbPath = path.join(pluginDataDir, 'library.db');
  assert(fs.existsSync(libraryDbPath), 'library.db was created');

  const db = new DatabaseSync(libraryDbPath, { open: true });
  try {
    const row = db.prepare(`
      SELECT model_id, provider, output_tokens, input_tokens, cache_read_tokens
      FROM output_metrics
      ORDER BY created_at DESC
      LIMIT 1
    `).get();

    assert(row, 'output_metrics row exists after afterTurn');
    assert.equal(row.model_id, 'qwen/qwen3-instruct', 'model id persisted');
    assert.equal(row.provider, 'openrouter', 'provider persisted');
    assert.equal(row.output_tokens, 42, 'output token count persisted');
    assert.equal(row.input_tokens, 100, 'input token count persisted');
    assert.equal(row.cache_read_tokens, 25, 'cache read tokens persisted');
  } finally {
    db.close();
  }
} catch (err) {
  failed = true;
  console.error('Output metrics path test failed:', err);
} finally {
  try { await engine?.dispose?.(); } catch {}
  process.env.HOME = realHome;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  process.exit(failed ? 1 : 0);
}
