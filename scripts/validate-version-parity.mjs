#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(root, rel), 'utf8'));
}

function fail(msg) {
  console.error(`version-parity: ${msg}`);
  process.exit(1);
}

const rootPkg = readJson('package.json');
const rootVersion = rootPkg.version;

for (const rel of ['plugin/package.json', 'memory-plugin/package.json']) {
  const pkg = readJson(rel);
  if (pkg.version != rootVersion) {
    fail(`${rel} version ${pkg.version} != root package.json ${rootVersion}`);
  }
}

for (const rel of ['package-lock.json', 'plugin/package-lock.json', 'memory-plugin/package-lock.json']) {
  if (!existsSync(resolve(root, rel))) continue;
  const lock = readJson(rel);
  if (lock.version != rootVersion) {
    fail(`${rel} version ${lock.version} != root package.json ${rootVersion}`);
  }
  const rootPkgEntry = lock.packages?.[''];
  if (rootPkgEntry?.version && rootPkgEntry.version != rootVersion) {
    fail(`${rel} packages[""] version ${rootPkgEntry.version} != root package.json ${rootVersion}`);
  }
}

const engineVersion = execFileSync(
  process.execPath,
  ['--input-type=module', '-e', "import('./src/version.ts').then(m => process.stdout.write(m.ENGINE_VERSION))"],
  { cwd: root, encoding: 'utf8' },
).trim();

if (engineVersion != rootVersion) {
  fail(`src/version.ts ENGINE_VERSION ${engineVersion} != root package.json ${rootVersion}`);
}

if (existsSync(resolve(root, 'dist/version.js'))) {
  const distEngineVersion = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./dist/version.js').then(m => process.stdout.write(m.ENGINE_VERSION))"],
    { cwd: root, encoding: 'utf8' },
  ).trim();

  if (distEngineVersion != rootVersion) {
    fail(`dist/version.js ENGINE_VERSION ${distEngineVersion} != root package.json ${rootVersion}`);
  }
}

console.log(`version-parity: ok (${rootVersion})`);
