#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OWN_PLUGIN_IDS = new Set(['hypercompositor', 'hypermem']);

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: process.env,
  });
  return typeof output === 'string' ? output : '';
}

function runCaptured(command, args) {
  const output = run(command, args, { capture: true });
  process.stdout.write(output);
  if (output && !output.endsWith('\n')) process.stdout.write('\n');
  return output;
}

function parseJsonFromCli(output, label) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error(`${label} did not produce a JSON object`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

function assertCleanInspection(id, inspection) {
  const errors = Array.isArray(inspection.errors) ? inspection.errors : [];
  const warnings = Array.isArray(inspection.warnings) ? inspection.warnings : [];
  if (errors.length || warnings.length) {
    throw new Error(`${id} runtime inspection is not clean: ${errors.length} error(s), ${warnings.length} warning(s)`);
  }

  if (id === 'hypercompositor') {
    const capabilities = Array.isArray(inspection.capabilities) ? inspection.capabilities : [];
    const hasContextEngine = capabilities.some((capability) => {
      return capability?.kind === 'context-engine'
        && Array.isArray(capability.ids)
        && capability.ids.includes('hypercompositor');
    });
    if (!hasContextEngine) {
      throw new Error('hypercompositor runtime inspection did not expose the context-engine capability');
    }
  }
}

console.log('[openclaw-plugin-runtime] Installing packed HyperMem runtime artifact');
run('npm', ['run', 'install:runtime:packed']);

console.log('\n[openclaw-plugin-runtime] Refreshing OpenClaw plugin registry');
runCaptured('openclaw', ['plugins', 'registry', '--refresh']);

console.log('\n[openclaw-plugin-runtime] Running OpenClaw plugin doctor');
const doctorOutput = runCaptured('openclaw', ['plugins', 'doctor']);
const ownDoctorDiagnostics = doctorOutput
  .split(/\r?\n/)
  .filter((line) => /^\s*-\s*(hypercompositor|hypermem):/.test(line));
if (ownDoctorDiagnostics.length) {
  throw new Error(`OpenClaw plugin doctor reported HyperMem diagnostics:\n${ownDoctorDiagnostics.join('\n')}`);
}

const unrelatedDiagnostics = doctorOutput
  .split(/\r?\n/)
  .filter((line) => /^\s*-\s*([^:]+):/.test(line))
  .filter((line) => {
    const match = line.match(/^\s*-\s*([^:]+):/);
    return match && !OWN_PLUGIN_IDS.has(match[1]);
  });
if (unrelatedDiagnostics.length) {
  console.log(`\n[openclaw-plugin-runtime] Ignored ${unrelatedDiagnostics.length} unrelated plugin doctor diagnostic(s).`);
}

for (const id of OWN_PLUGIN_IDS) {
  console.log(`\n[openclaw-plugin-runtime] Inspecting ${id} runtime`);
  const inspectOutput = runCaptured('openclaw', ['plugins', 'inspect', '--runtime', '--json', id]);
  const inspection = parseJsonFromCli(inspectOutput, `openclaw plugins inspect ${id}`);
  assertCleanInspection(id, inspection);
}

console.log('\n✅ Packed HyperMem runtime passes OpenClaw plugin doctor and runtime inspection');
