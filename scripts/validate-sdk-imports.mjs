#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE_ROOTS = ['plugin/src', 'memory-plugin/src'];
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.mts', '.cjs']);

const failures = [];

function fail(kind, file, detail, line, snippet) {
  failures.push({ kind, file, detail, line, snippet });
}

function readJson(rel) {
  return JSON.parse(readFileSync(resolve(root, rel), 'utf8'));
}

function extname(path) {
  const base = path.split('/').pop() || path;
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i) : '';
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (rel.split('/').includes('node_modules') || rel.split('/').includes('dist')) continue;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else if (TEXT_EXTENSIONS.has(extname(rel))) out.push(rel);
  }
  return out;
}

function stripComments(line) {
  return line.replace(/\/\/.*$/, '');
}

function scanImports() {
  const files = SOURCE_ROOTS.flatMap((rel) => walk(resolve(root, rel)));
  const deprecatedSpecifier = /['"]openclaw\/plugin-sdk\/plugin-entry['"]/;
  const privateOpenClawSpecifier = /['"](?:openclaw\/(?:dist|src|build|lib)(?:\/|['"])|.*(?:^|\/)openclaw\/(?:dist|src)\/|.*(?:^|\/)dist\/plugin-sdk\/|.*(?:^|\/)src\/plugin-sdk\/)/;
  const mcpSdkSpecifier = /['"]@modelcontextprotocol\/sdk(?:\/|['"])/;

  for (const rel of files) {
    const lines = readFileSync(resolve(root, rel), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = stripComments(lines[i]);
      if (deprecatedSpecifier.test(line)) {
        fail('deprecated-sdk-import', rel, 'use openclaw/plugin-sdk/core instead of openclaw/plugin-sdk/plugin-entry', i + 1, lines[i].trim());
      }
      if (privateOpenClawSpecifier.test(line)) {
        fail('private-openclaw-import', rel, 'do not import OpenClaw private dist/src/build/lib surfaces', i + 1, lines[i].trim());
      }
      if (mcpSdkSpecifier.test(line)) {
        fail('direct-mcp-sdk-import', rel, 'plugin packages must not couple directly to @modelcontextprotocol/sdk for OpenClaw plugin contracts', i + 1, lines[i].trim());
      }
    }
  }
}

function lockOpenClawVersion(lockRel) {
  const lock = readJson(lockRel);
  return lock.packages?.['node_modules/openclaw']?.version ?? null;
}

function installedOpenClawVersion(packageDir) {
  const rel = `${packageDir}/node_modules/openclaw/package.json`;
  if (!existsSync(resolve(root, rel))) return null;
  return readJson(rel).version ?? null;
}

function validatePackage(packageDir) {
  const pkgRel = `${packageDir}/package.json`;
  const lockRel = `${packageDir}/package-lock.json`;
  const pkg = readJson(pkgRel);
  const lockVersion = existsSync(resolve(root, lockRel)) ? lockOpenClawVersion(lockRel) : null;
  const installedVersion = installedOpenClawVersion(packageDir);
  const depVersion = pkg.devDependencies?.openclaw;
  const build = pkg.openclaw?.build ?? {};

  if (!depVersion) {
    fail('missing-openclaw-devdependency', pkgRel, 'devDependencies.openclaw must be pinned for SDK build reproducibility');
  } else if (depVersion === '*' || depVersion.startsWith('^') || depVersion.startsWith('~')) {
    fail('unpinned-openclaw-devdependency', pkgRel, `devDependencies.openclaw must be exact, got ${depVersion}`);
  }

  if (lockVersion && depVersion && depVersion !== lockVersion) {
    fail('openclaw-lock-drift', lockRel, `lockfile OpenClaw ${lockVersion} does not match devDependencies.openclaw ${depVersion}`);
  }

  if (installedVersion && lockVersion && installedVersion !== lockVersion) {
    fail('openclaw-install-drift', `${packageDir}/node_modules/openclaw/package.json`, `installed OpenClaw ${installedVersion} does not match lockfile ${lockVersion}`);
  }

  const expectedVersion = lockVersion ?? depVersion ?? installedVersion;
  if (expectedVersion) {
    for (const key of ['openclawVersion', 'pluginSdkVersion']) {
      if (build[key] !== expectedVersion) {
        fail('stale-plugin-build-metadata', pkgRel, `openclaw.build.${key}=${build[key] ?? '<missing>'} must match validated SDK ${expectedVersion}`);
      }
    }
  }
}

function validateCrossPackageParity() {
  const plugin = readJson('plugin/package.json');
  const memory = readJson('memory-plugin/package.json');
  const pluginVersion = plugin.devDependencies?.openclaw;
  const memoryVersion = memory.devDependencies?.openclaw;
  if (pluginVersion && memoryVersion && pluginVersion !== memoryVersion) {
    fail('cross-plugin-sdk-drift', 'plugin/package.json', `plugin OpenClaw SDK ${pluginVersion} != memory-plugin ${memoryVersion}`);
  }
}

scanImports();
validatePackage('plugin');
validatePackage('memory-plugin');
validateCrossPackageParity();

if (failures.length) {
  console.error(`\n❌ SDK import validation failed (${failures.length} issue(s)):`);
  for (const f of failures) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.error(`  ${f.kind}: ${loc} — ${f.detail}${f.snippet ? ` — ${f.snippet}` : ''}`);
  }
  process.exit(1);
}

console.log('✅ SDK import validation passed');
