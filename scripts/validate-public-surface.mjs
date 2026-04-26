#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const strict = process.argv.includes('--strict');

const BLOCKED_PATHS = [
  'docs/ROADMAP.md',
  'docs/KNOWN_LIMITATIONS.md',
  'docs/reviews',
  'docs/PHASE1-VALIDATION.md',
  'docs/RELEASE_0.8.0_VALIDATION.md',
  'scripts/flush-agent-session.sh',
  'scripts/migrate-clawtext.mjs',
  'scripts/sync-public.mjs',
];

const BLOCKED_TERMS = [
  'ocplatform',
  'ROADMAP.md',
  'KNOWN_LIMITATIONS.md',
  'workspace-council',
  'ragesaq',
  'lumadmin',
  'Anvil (Antagonist)',
  'anvil@psiclawops.dev',
  'Forge <forge@psiclawops.dev>',
  'forge@psiclawops.dev',
];

const TEXT_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.mts', '.json', '.md', '.txt', '.sh', '.yaml', '.yml', '.toml', '.html', '.css'
]);

const ALLOWED_INTERNAL_GUARD_FILES = new Set([
  'scripts/sync-public.mjs',
  'scripts/validate-public-surface.mjs',
]);

function extname(path) {
  const base = path.split('/').pop() || path;
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i) : '';
}

function shouldSkipDir(rel) {
  const parts = rel.split('/');
  return parts.includes('.git') || parts.includes('node_modules') || rel === 'dist' || rel === 'plugin/dist' || rel === 'memory-plugin/dist';
}

function isBlockedPath(rel) {
  return BLOCKED_PATHS.some(p => rel === p || rel.startsWith(p + '/'));
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (shouldSkipDir(rel)) continue;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, out);
    else out.push(rel);
  }
  return out;
}

const failures = [];

if (!strict) {
  console.log('✅ Public surface validation configured. Use --strict against a public-sync worktree.');
  process.exit(0);
}

if (strict) {
  for (const rel of BLOCKED_PATHS) {
    if (existsSync(join(root, rel))) {
      failures.push({ kind: 'blocked-path', file: rel, detail: 'must not exist in public surface' });
    }
  }
}

for (const rel of walk(root)) {
  if (ALLOWED_INTERNAL_GUARD_FILES.has(rel)) continue;
  if (!strict && isBlockedPath(rel)) continue;
  if (!TEXT_EXTENSIONS.has(extname(rel))) continue;
  let text;
  try { text = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  for (const term of BLOCKED_TERMS) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        failures.push({ kind: 'blocked-term', file: rel, line: i + 1, detail: term, snippet: lines[i].trim().slice(0, 140) });
      }
    }
  }
}

if (failures.length) {
  console.error(`\n❌ Public surface validation failed (${failures.length} issue(s)):`);
  for (const f of failures) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.error(`  ${f.kind}: ${loc} — ${f.detail}${f.snippet ? ` — ${f.snippet}` : ''}`);
  }
  process.exit(1);
}

console.log('✅ Public surface validation passed');
