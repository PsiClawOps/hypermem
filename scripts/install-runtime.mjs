#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const installRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(os.homedir(), '.openclaw/plugins/hypermem');

const requiredEntries = [
  ['dist', 'dist'],
  ['package.json', 'package.json'],
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE'],
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
  ['plugin/node_modules/zod', 'plugin/node_modules/zod'],
  ['memory-plugin/README.md', 'memory-plugin/README.md'],
  ['memory-plugin/LICENSE', 'memory-plugin/LICENSE'],
  ['node_modules/sqlite-vec', 'node_modules/sqlite-vec'],
];

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
];

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

const desiredPaths = [`${installRoot}/plugin`, `${installRoot}/memory-plugin`];

function readOpenClawConfig(pathKey) {
  try {
    const out = execFileSync('openclaw', ['config', 'get', pathKey], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out || out === 'null' || out === 'undefined') return null;
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function mergeUnique(existing, additions) {
  const arr = Array.isArray(existing) ? existing : [];
  return [...new Set([...arr, ...additions])];
}

const existingLoadPaths = readOpenClawConfig('plugins.load.paths');
const existingAllow = readOpenClawConfig('plugins.allow');
const mergedLoadPaths = mergeUnique(existingLoadPaths, desiredPaths);
const mergedAllow = Array.isArray(existingAllow)
  ? mergeUnique(existingAllow, ['hypercompositor', 'hypermem'])
  : null;

console.log(`\n  Runtime installed to:\n    ${installRoot}\n`);
console.log(`  Next steps — wire the plugins into OpenClaw:\n`);
console.log(`    openclaw config get plugins.load.paths`);
console.log(`    openclaw config get plugins.allow`);
console.log(`    openclaw config set plugins.load.paths '${JSON.stringify(mergedLoadPaths)}' --strict-json`);
console.log(`    openclaw config set plugins.slots.contextEngine hypercompositor`);
console.log(`    openclaw config set plugins.slots.memory hypermem`);
if (mergedAllow) {
  console.log(`    openclaw config set plugins.allow '${JSON.stringify(mergedAllow)}' --strict-json`);
} else {
  console.log(`    # Only set plugins.allow if your OpenClaw config already uses an allowlist.`);
  console.log(`    # If it returns an array, append "hypercompositor" and "hypermem" to that array.`);
}
console.log(`    openclaw gateway restart\n`);
console.log(`  Verify:\n`);
console.log(`    openclaw plugins list`);
console.log(`    node bin/hypermem-status.mjs --health\n`);
