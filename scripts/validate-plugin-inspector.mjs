#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = new Set(process.argv.slice(2));
const runtime = argv.has('--runtime') || argv.has('--ci');

const targets = [
  { id: 'hypercompositor', root: path.join(root, 'plugin') },
  { id: 'hypermem', root: path.join(root, 'memory-plugin') },
];

function inspectorBin() {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  const local = path.join(root, 'node_modules', '.bin', `plugin-inspector${suffix}`);
  return existsSync(local) ? local : `plugin-inspector${suffix}`;
}

function runInspector(target) {
  const outDir = path.join(
    root,
    '.artifacts',
    runtime ? 'plugin-inspector-runtime' : 'plugin-inspector',
    target.id,
  );
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const args = runtime
    ? [
        'ci',
        '--plugin-root', target.root,
        '--out', outDir,
        '--no-openclaw',
        '--runtime',
        '--real-sdk',
        '--allow-execute',
      ]
    : [
        'inspect',
        '--plugin-root', target.root,
        '--out', outDir,
        '--no-openclaw',
      ];

  console.log(`\n[plugin-inspector] ${runtime ? 'runtime' : 'static'} check: ${target.id}`);
  const result = spawnSync(inspectorBin(), args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`plugin-inspector failed for ${target.id} with exit ${result.status}`);
  }
}

for (const target of targets) runInspector(target);

console.log(`\n✅ Plugin Inspector ${runtime ? 'runtime' : 'static'} validation passed for HyperMem plugins`);
