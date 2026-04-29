#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
let installRoot = path.join(os.homedir(), '.openclaw/plugins/hypermem');
let inputTarball = null;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--install-root' && argv[i + 1]) {
    installRoot = path.resolve(argv[++i]);
  } else if (arg === '--tarball' && argv[i + 1]) {
    inputTarball = path.resolve(argv[++i]);
  } else if (arg.endsWith('.tgz')) {
    inputTarball = path.resolve(arg);
  } else if (!arg.startsWith('--')) {
    installRoot = path.resolve(arg);
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: options.stdio ?? 'pipe',
    encoding: options.encoding ?? 'utf8',
    env: process.env,
  });
}

function safeRemove(filePath) {
  try {
    if (existsSync(filePath) && statSync(filePath).isFile()) rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup only. Never delete directories here.
  }
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'hypermem-packed-runtime-'));
const tempApp = path.join(tempRoot, 'app');
let tarballPath = inputTarball;
let createdTarball = false;

try {
  if (!tarballPath) {
    console.log('Packing HyperMem via npm pack...');
    const packOutput = run('npm', ['pack', '--silent']).trim();
    const tarballName = packOutput.split('\n').filter(Boolean).pop();
    if (!tarballName) throw new Error('npm pack did not return a tarball name');
    tarballPath = path.join(repoRoot, tarballName);
    createdTarball = true;
  } else if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
    throw new Error(`Tarball not found or not a file: ${tarballPath}`);
  }

  console.log(`Installing packed artifact into temp app: ${tempApp}`);
  run('npm', ['--prefix', tempApp, 'init', '-y'], { stdio: 'ignore' });
  run('npm', ['--prefix', tempApp, 'install', '--no-audit', '--no-fund', tarballPath], {
    stdio: 'inherit',
  });

  const backupPath = `${installRoot}.backup.${stamp}`;
  if (existsSync(installRoot)) {
    console.log(`Backing up current runtime: ${backupPath}`);
    cpSync(installRoot, backupPath, { recursive: true, force: false, errorOnExist: true });
  }

  const installer = path.join(
    tempApp,
    'node_modules',
    '@psiclawops',
    'hypermem',
    'scripts',
    'install-runtime.mjs',
  );
  console.log(`Installing packed runtime to: ${installRoot}`);
  run(process.execPath, [installer, installRoot], { stdio: 'inherit' });

  const pkg = JSON.parse(
    run(process.execPath, [
      '-e',
      `console.log(require('fs').readFileSync(${JSON.stringify(path.join(installRoot, 'package.json'))}, 'utf8'))`,
    ]),
  );
  console.log(`Installed ${pkg.name}@${pkg.version} from packed artifact.`);
  console.log(`Runtime path: ${installRoot}`);
  console.log('Restart OpenClaw gateway before validating runtime behavior.');
} finally {
  if (createdTarball && tarballPath) safeRemove(tarballPath);
  rmSync(tempRoot, { recursive: true, force: true });
}
