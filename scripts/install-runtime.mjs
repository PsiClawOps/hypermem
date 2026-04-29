#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function usage() {
  console.log(`
hypermem-install — stage the HyperMem runtime for OpenClaw

Usage:
  hypermem-install [install-root] [options]
  hypermem-install --install-root <path> [options]

Options:
  --install-root <path>       Runtime install directory
                              default: ~/.openclaw/plugins/hypermem
  --skip-embedding-check      Do not require the configured embedding provider
                              to be reachable during install
  --skip-openclaw-config      Do not attempt OpenClaw config writes. Current
                              installer is read-only for OpenClaw config, so
                              this is accepted for CI/container scripts.
  -h, --help                  Show this help
`);
}

function parseArgs(argv) {
  const options = {
    installRoot: null,
    skipEmbeddingCheck: false,
    skipOpenClawConfig: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--install-root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--install-root requires a path');
      }
      options.installRoot = value;
      i += 1;
    } else if (arg === '--skip-embedding-check') {
      options.skipEmbeddingCheck = true;
    } else if (arg === '--skip-openclaw-config') {
      options.skipOpenClawConfig = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!options.installRoot) {
      options.installRoot = arg;
    } else {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  return options;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`hypermem-install: ${err.message}`);
  usage();
  process.exit(2);
}

if (options.help) {
  usage();
  process.exit(0);
}

const installRoot = options.installRoot
  ? path.resolve(options.installRoot)
  : path.join(os.homedir(), '.openclaw/plugins/hypermem');
const hypermemConfigPath = path.join(os.homedir(), '.openclaw', 'hypermem', 'config.json');
const defaultConfigSource = path.join(REPO_ROOT, 'assets', 'default-config.json');

const requiredEntries = [
  ['dist', 'dist'],
  ['package.json', 'package.json'],
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE'],
  ['assets/default-config.json', 'assets/default-config.json'],
  ['bin/hypermem-status.mjs', 'bin/hypermem-status.mjs'],
  ['bin/hypermem-model-audit.mjs', 'bin/hypermem-model-audit.mjs'],
  ['bin/hypermem-doctor.mjs', 'bin/hypermem-doctor.mjs'],
  ['bin/hypermem-bench.mjs', 'bin/hypermem-bench.mjs'],
  ['bench/data-access-bench.mjs', 'bench/data-access-bench.mjs'],
  ['plugin/dist', 'plugin/dist'],
  ['plugin/package.json', 'plugin/package.json'],
  ['plugin/openclaw.plugin.json', 'plugin/openclaw.plugin.json'],
  ['memory-plugin/dist', 'memory-plugin/dist'],
  ['memory-plugin/package.json', 'memory-plugin/package.json'],
  ['memory-plugin/openclaw.plugin.json', 'memory-plugin/openclaw.plugin.json'],
];

const optionalEntries = [
  ['plugin/README.md', 'plugin/README.md'],
  ['plugin/LICENSE', 'plugin/LICENSE'],
  ['node_modules/zod', 'node_modules/zod'],
  ['memory-plugin/README.md', 'memory-plugin/README.md'],
  ['memory-plugin/LICENSE', 'memory-plugin/LICENSE'],
  ['node_modules/sqlite-vec', 'node_modules/sqlite-vec'],
];

const sqliteVecNativeEntries = (() => {
  const nodeModulesRoot = path.join(REPO_ROOT, 'node_modules');
  if (!existsSync(nodeModulesRoot)) return [];
  return readdirSync(nodeModulesRoot)
    .filter((name) => name.startsWith('sqlite-vec-'))
    .map((name) => [`node_modules/${name}`, `node_modules/${name}`]);
})();

for (const [srcRel] of requiredEntries) {
  const src = path.join(REPO_ROOT, srcRel);
  if (!existsSync(src)) {
    console.error(`Missing runtime artifact: ${src}`);
    process.exit(1);
  }
}

const entries = [
  ...requiredEntries,
  ...optionalEntries.filter(([srcRel]) => existsSync(path.join(REPO_ROOT, srcRel))),
  ...sqliteVecNativeEntries.filter(([srcRel]) => existsSync(path.join(REPO_ROOT, srcRel))),
];


function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeDefaultConfigIfMissing() {
  if (!existsSync(defaultConfigSource)) {
    console.error(`Missing default config artifact: ${defaultConfigSource}`);
    process.exit(1);
  }
  if (existsSync(hypermemConfigPath)) {
    return { path: hypermemConfigPath, created: false, config: readJson(hypermemConfigPath) };
  }
  mkdirSync(path.dirname(hypermemConfigPath), { recursive: true, mode: 0o700 });
  const content = readFileSync(defaultConfigSource, 'utf8');
  writeFileSync(hypermemConfigPath, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 });
  return { path: hypermemConfigPath, created: true, config: JSON.parse(content) };
}

async function probeEmbeddingProvider(config) {
  const embedding = config?.embedding ?? {};
  const provider = embedding.provider ?? 'ollama';
  if (provider === 'none') return { ok: true, skipped: true, reason: 'embedding provider disabled' };
  if (provider !== 'ollama') return { ok: true, skipped: true, reason: `embedding provider ${provider} is not probed by installer` };

  const baseUrl = String(embedding.ollamaUrl ?? 'http://localhost:11434').replace(/\/$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { ok: false, provider, baseUrl, reason: `HTTP ${res.status}` };
    const body = await res.json().catch(() => ({}));
    const model = embedding.model ?? 'nomic-embed-text';
    const models = Array.isArray(body.models) ? body.models : [];
    const hasModel = models.some((entry) => entry?.name === model || entry?.model === model || String(entry?.name ?? '').startsWith(`${model}:`));
    if (!hasModel) {
      return { ok: false, provider, baseUrl, reason: `model ${model} is not installed` };
    }
    return { ok: true, provider, baseUrl, model };
  } catch (err) {
    const detail = err.cause?.code ? `${err.message} (${err.cause.code})` : err.message;
    return { ok: false, provider, baseUrl, reason: err.name === 'AbortError' ? 'probe timed out' : `cannot reach ${baseUrl}: ${detail}` };
  } finally {
    clearTimeout(timer);
  }
}

const configResult = writeDefaultConfigIfMissing();

if (!options.skipEmbeddingCheck) {
  const probe = await probeEmbeddingProvider(configResult.config);
  if (!probe.ok) {
    console.error(`
Embedding provider check failed: ${probe.reason}

HyperMem default semantic recall uses Ollama with nomic-embed-text.
Remediation:
  1. Install and start Ollama: https://ollama.com/download
  2. Pull the embedding model: ollama pull nomic-embed-text
  3. Re-run hypermem-install

Advanced/CI override:
  hypermem-install --skip-embedding-check

Config checked:
  ${configResult.path}
`);
    process.exit(3);
  }
}

rmSync(installRoot, { recursive: true, force: true });
mkdirSync(installRoot, { recursive: true });

for (const [srcRel, destRel] of entries) {
  cpSync(path.join(REPO_ROOT, srcRel), path.join(installRoot, destRel), {
    recursive: true,
    force: true,
  });
}

const openclawInstallPath = path.join(os.homedir(), '.npm-global/lib/node_modules/openclaw');
mkdirSync(path.join(installRoot, 'plugin/node_modules/@psiclawops'), { recursive: true });
mkdirSync(path.join(installRoot, 'memory-plugin/node_modules/@psiclawops'), { recursive: true });
symlinkSync(openclawInstallPath, path.join(installRoot, 'plugin/node_modules/openclaw'));
symlinkSync(openclawInstallPath, path.join(installRoot, 'memory-plugin/node_modules/openclaw'));
symlinkSync('../../..', path.join(installRoot, 'plugin/node_modules/@psiclawops/hypermem'));
symlinkSync('../../..', path.join(installRoot, 'memory-plugin/node_modules/@psiclawops/hypermem'));

console.log(`
  Runtime installed to:
    ${installRoot}
`);
console.log(`  HyperMem config:
    ${configResult.path} ${configResult.created ? '(created)' : '(already existed, unchanged)'}
`);
if (options.skipEmbeddingCheck) {
  console.log(`  Embedding provider check skipped by --skip-embedding-check.
`);
}
console.log(`  Next steps — wire the plugins into OpenClaw:\n`);
console.log(`    openclaw config set plugins.load.paths '["${installRoot}/plugin","${installRoot}/memory-plugin"]' --strict-json`);
console.log(`    openclaw config set plugins.slots.contextEngine hypercompositor`);
console.log(`    openclaw config set plugins.slots.memory hypermem`);
console.log(`    # Check existing allowed plugins first, then merge hypermem entries in:`);
console.log(`    openclaw config get plugins.allow`);
console.log(`    # Example merge (if "my-plugin" was already allowed):`);
console.log(`    #   openclaw config set plugins.allow '["my-plugin","hypercompositor","hypermem"]' --strict-json`);
console.log(`    # If plugins.allow is empty or unset, skip that step instead of creating a new allowlist.`);
console.log(`    openclaw plugins registry --refresh`);
console.log(`    openclaw doctor --fix --yes`);
console.log(`    openclaw gateway restart\n`);
console.log(`  Verify:\n`);
console.log(`    openclaw plugins registry --refresh`);
console.log(`    openclaw plugins list`);
console.log(`    node bin/hypermem-status.mjs --health\n`);
