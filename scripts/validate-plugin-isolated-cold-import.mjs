#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const artifactRoot = path.join(repoRoot, '.artifacts', 'plugin-isolated-cold-import');
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'hypermem-plugin-cold-import-'));

const targets = [
  {
    id: 'hypercompositor',
    packageDir: 'plugin',
    packageName: '@psiclawops/hypercompositor',
  },
  {
    id: 'hypermem',
    packageDir: 'memory-plugin',
    packageName: '@psiclawops/hypermem-memory',
  },
];

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? 'pipe',
    env: process.env,
  });
}

function runJson(command, args, options = {}) {
  try {
    const stdout = run(command, args, options);
    return { ok: true, stdout, json: JSON.parse(stdout || '{}') };
  } catch (err) {
    const stdout = String(err.stdout ?? '');
    let json = null;
    try {
      json = JSON.parse(stdout || '{}');
    } catch {
      // Keep raw stdout below for diagnostics.
    }
    return { ok: false, status: err.status, stdout, stderr: String(err.stderr ?? ''), json };
  }
}

function pack(cwd) {
  const out = run('npm', ['pack', '--silent', '--pack-destination', tempRoot], { cwd }).trim();
  const tarball = out.split('\n').filter(Boolean).pop();
  if (!tarball) throw new Error(`npm pack did not return a tarball for ${cwd}`);
  const tarballPath = path.join(tempRoot, tarball);
  if (!existsSync(tarballPath)) throw new Error(`npm pack artifact missing: ${tarballPath}`);
  return tarballPath;
}

function vulnerabilityTotal(auditJson) {
  const vuln = auditJson?.metadata?.vulnerabilities ?? {};
  return Number(vuln.total ?? 0);
}

function assertNoProductionAuditFindings(target, audit) {
  if (!audit.json) {
    throw new Error(`${target.id}: npm audit did not return parseable JSON`);
  }
  const total = vulnerabilityTotal(audit.json);
  if (total !== 0) {
    throw new Error(`${target.id}: production dependency audit reported ${total} finding(s)`);
  }
}

try {
  mkdirSync(artifactRoot, { recursive: true });

  const openclawPath = path.join(repoRoot, 'plugin', 'node_modules', 'openclaw');
  if (!existsSync(openclawPath)) {
    throw new Error(`OpenClaw SDK dependency is missing at ${openclawPath}; run npm --prefix plugin install first`);
  }

  console.log('[plugin-cold-import] packing root and plugin packages');
  const rootTarball = pack(repoRoot);
  const tarballs = new Map(targets.map((target) => [target.id, pack(path.join(repoRoot, target.packageDir))]));

  for (const target of targets) {
    const appDir = path.join(tempRoot, `${target.id}-app`);
    mkdirSync(appDir, { recursive: true });
    run('npm', ['--prefix', appDir, 'init', '-y'], { stdio: 'ignore' });

    console.log(`[plugin-cold-import] installing ${target.packageName} in isolated workspace`);
    run(
      'npm',
      [
        '--prefix',
        appDir,
        'install',
        '--no-audit',
        '--no-fund',
        '--legacy-peer-deps',
        rootTarball,
        tarballs.get(target.id),
      ],
      { stdio: 'inherit' },
    );

    const nodeModules = path.join(appDir, 'node_modules');
    const linkedOpenClaw = path.join(nodeModules, 'openclaw');
    if (!existsSync(linkedOpenClaw)) {
      symlinkSync(openclawPath, linkedOpenClaw, 'dir');
    }

    console.log(`[plugin-cold-import] cold importing ${target.packageName}`);
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const mod = await import(${JSON.stringify(target.packageName)}); if (!mod.default) throw new Error('missing default plugin export');`,
      ],
      { cwd: appDir, stdio: 'pipe' },
    );

    const audit = runJson('npm', ['--prefix', appDir, 'audit', '--omit=dev', '--json']);
    assertNoProductionAuditFindings(target, audit);

    const artifact = {
      generatedAt: new Date().toISOString(),
      status: 'pass',
      fixture: target.id,
      packageName: target.packageName,
      assertions: [
        'runtime dependencies install in an isolated workspace',
        'OpenClaw host peer is linked explicitly instead of fetched as plugin production dependency',
        'plugin entrypoint cold imports after dependency installation',
        'production dependency audit has zero findings',
      ],
      audit: audit.json?.metadata?.vulnerabilities ?? {},
    };
    writeFileSync(path.join(artifactRoot, `${target.id}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
  }

  console.log('✅ Isolated plugin dependency-install cold import validation passed');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
