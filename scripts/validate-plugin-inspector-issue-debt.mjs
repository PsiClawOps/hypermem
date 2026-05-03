#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const reportPaths = [
  '.artifacts/plugin-inspector/hypercompositor/plugin-inspector-report.json',
  '.artifacts/plugin-inspector/hypermem/plugin-inspector-report.json',
  '.artifacts/plugin-inspector-runtime/hypercompositor/plugin-inspector-report.json',
  '.artifacts/plugin-inspector-runtime/hypermem/plugin-inspector-report.json',
];

const coveredInspectorGapCodes = new Set(['package-dependency-install-required']);

function readJson(relPath) {
  const abs = path.join(repoRoot, relPath);
  return JSON.parse(readFileSync(abs, 'utf8'));
}

function proofArtifactFor(issue) {
  if (!coveredInspectorGapCodes.has(issue.code)) return null;
  const proofPath = path.join(repoRoot, '.artifacts', 'plugin-isolated-cold-import', `${issue.fixture}.json`);
  if (!existsSync(proofPath)) return null;
  const proof = JSON.parse(readFileSync(proofPath, 'utf8'));
  return proof.status === 'pass' ? proofPath : null;
}

const failures = [];
const covered = [];

for (const relPath of reportPaths) {
  const abs = path.join(repoRoot, relPath);
  if (!existsSync(abs)) {
    failures.push(`${relPath}: missing Plugin Inspector report; run npm run validate:plugin-inspector and npm run validate:plugin-inspector:runtime first`);
    continue;
  }

  const report = readJson(relPath);
  if (report.status !== 'pass') {
    failures.push(`${relPath}: Plugin Inspector status is ${report.status}`);
  }
  if ((report.summary?.breakageCount ?? 0) > 0) {
    failures.push(`${relPath}: ${report.summary.breakageCount} hard breakage(s)`);
  }

  for (const issue of report.issues ?? []) {
    if (issue.status === 'runtime-covered') continue;
    const proof = proofArtifactFor(issue);
    if (proof) {
      covered.push(`${relPath}: ${issue.fixture}/${issue.code} covered by ${path.relative(repoRoot, proof)}`);
      continue;
    }
    failures.push(
      `${relPath}: open ${issue.severity} ${issue.issueClass} ${issue.fixture}/${issue.code} (${issue.title})`,
    );
  }
}

if (failures.length > 0) {
  console.error('Plugin Inspector issue debt validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

for (const item of covered) console.log(`[plugin-inspector-debt] ${item}`);
console.log('✅ Plugin Inspector issue debt validation passed');
