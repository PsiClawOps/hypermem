#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const packageDirs = ['plugin', 'memory-plugin'];
const tmp = mkdtempSync(join(tmpdir(), 'hypermem-sdk-canary-'));
let tarballPath = null;

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { cwd: opts.cwd ?? root, stdio: opts.stdio ?? 'inherit', env: process.env });
}

function out(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: opts.cwd ?? root, encoding: 'utf8', env: process.env }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function copyPackageDir(rel) {
  const src = join(root, rel);
  const dest = join(tmp, rel);
  cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const normalized = p.replace(/\\/g, '/');
      return !normalized.includes('/node_modules')
        && !normalized.includes('/dist')
        && !normalized.endsWith('/package-lock.json');
    },
  });
  return dest;
}

try {
  const requested = process.env.HYPERMEM_SDK_CANARY_VERSION || 'latest';
  const sdkVersion = out('npm', ['view', `openclaw@${requested}`, 'version']);
  console.log(`SDK canary target: openclaw@${sdkVersion}`);

  console.log('Building root package for local plugin dependency...');
  run('npm', ['run', 'build']);
  const tarballName = out('npm', ['pack', '--ignore-scripts', '--silent']);
  tarballPath = join(root, basename(tarballName.split('\n').pop() || tarballName));
  if (!existsSync(tarballPath)) throw new Error(`npm pack did not create ${tarballPath}`);
  const tarballRef = pathToFileURL(tarballPath).href;

  for (const rel of packageDirs) {
    const dest = copyPackageDir(rel);
    const pkgPath = join(dest, 'package.json');
    const pkg = readJson(pkgPath);
    const pinned = pkg.devDependencies?.openclaw ?? '<missing>';
    pkg.dependencies = pkg.dependencies ?? {};
    pkg.dependencies['@psiclawops/hypermem'] = tarballRef;
    pkg.devDependencies = pkg.devDependencies ?? {};
    pkg.devDependencies.openclaw = sdkVersion;
    writeJson(pkgPath, pkg);

    console.log(`\n[${rel}] pinned OpenClaw SDK: ${pinned}`);
    console.log(`[${rel}] canary OpenClaw SDK: ${sdkVersion}`);
    run('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: dest });
    run('npm', ['run', 'typecheck'], { cwd: dest });
    run('npm', ['run', 'build'], { cwd: dest });
  }

  console.log('\n✅ Latest OpenClaw SDK canary passed');
} finally {
  if (tarballPath) rmSync(tarballPath, { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
