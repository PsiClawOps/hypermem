#!/usr/bin/env node
/**
 * sync-public.mjs — Internal → Public repo sanitization sync
 *
 * Applies the canonical substitution map to produce a sanitized public commit.
 * Run from the repo root after confirming internal main is clean and tested.
 *
 * Usage:
 *   node scripts/sync-public.mjs "commit message" [--dry-run] [--no-push]
 *
 * Process:
 *   1. Verify internal main is clean (no uncommitted changes)
 *   2. Checkout public branch
 *   3. Copy + sanitize src/, scripts/, docs/ from internal
 *   4. Sync package.json (version, description — strip internal fields)
 *   5. Build + run full test suite
 *   6. Commit with the provided message
 *   7. Push to public remote (unless --no-push)
 *   8. Return to main
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ─── CLI ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_PUSH = args.includes('--no-push') || DRY_RUN;
const commitMsg = args.filter(a => !a.startsWith('--'))[0];

if (!commitMsg) {
  console.error('Usage: node scripts/sync-public.mjs "commit message" [--dry-run] [--no-push]');
  process.exit(1);
}

// ─── Substitution Map ────────────────────────────────────────────
//
// Canonical internal → public identity substitutions.
// Order matters: longer/more-specific entries first to prevent partial matches.
// Entries are applied as whole-word replacements (word boundaries enforced).
//
// Fleet name mapping (internal agent names → generic public names):
const AGENT_NAME_MAP = [
  // Council seats
  { from: 'forge',    to: 'alice'   },
  { from: 'compass',  to: 'bob'     },
  // clarity stays as 'clarity' — generic enough, no substitution
  { from: 'sentinel', to: 'dave'    },
  { from: 'anvil',    to: 'carol'   },
  { from: 'vanguard', to: 'oscar'   },
  // Directors
  { from: 'pylon',    to: 'hank'    },
  { from: 'vigil',    to: 'jack'    },
  { from: 'plane',    to: 'irene'   },
  { from: 'helm',     to: 'eve'     },
  { from: 'chisel',   to: 'frank'   },
  { from: 'facet',    to: 'grace'   },
  { from: 'bastion',  to: 'leo'     },
  { from: 'gauge',    to: 'kate'    },
  // Specialists
  { from: 'crucible', to: 'mike'    },
  { from: 'relay',    to: 'nancy'   },
];

// Org name mapping (derived from agent → org structure)
const ORG_NAME_MAP = [
  { from: 'forge-org',    to: 'alice-org'  },
  { from: 'compass-org',  to: 'bob-org'    },
  { from: 'sentinel-org', to: 'dave-org'   },
  { from: 'anvil-org',    to: 'carol-org'  },
  { from: 'vanguard-org', to: 'oscar-org'  },
];

// Council lead references (councilLead field values)
// Applied as string replacements in quoted contexts
const COUNCIL_LEAD_MAP = [
  { from: "'forge'",    to: "'alice'"   },
  { from: "'compass'",  to: "'bob'"     },
  { from: "'sentinel'", to: "'dave'"    },
  { from: "'anvil'",    to: "'carol'"   },
  { from: "'vanguard'", to: "'oscar'"   },
];

// Path substitutions
const PATH_MAP = [
  // Internal workspace paths — replace with generic home-relative examples
  { from: /\/home\/lumadmin\/\.openclaw\/workspace-council\//g, to: '~/.openclaw/workspace/' },
  { from: /process\.env\.HOME \|\| '\/home\/user'/g,           to: "process.env.HOME || os.homedir()" },
  // Internal workspace repo paths (in comments/examples only — caught by word boundary rules above)
  { from: /~\/\.openclaw\/workspace-council\//g,               to: '~/.openclaw/workspace/' },
];

// Operator name substitutions (in code patterns, not user-facing docs)
const OPERATOR_MAP = [
  // In regex patterns that match operator name specifically
  { from: /\/\(\?:ragesaq\|operator\)/g, to: '/(?:operator)' },
];

// ─── Files to exclude from public sync ──────────────────────────
//
// These files exist in internal only and must not appear in public.
const EXCLUDE_FILES = [
  'scripts/flush-agent-session.sh',   // Internal fleet ops only
  // Add more as needed
];

// ─── Text file extensions to sanitize ───────────────────────────
const SANITIZE_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.mts', '.json',
  '.md', '.txt', '.sh', '.yaml', '.yml',
]);

// ─── Directories to sync ─────────────────────────────────────────
const SYNC_DIRS = ['src', 'test', 'scripts', 'docs'];
const SYNC_ROOT_FILES = ['package.json', 'tsconfig.json', 'README.md', 'CHANGELOG.md', '.npmignore'];

// ─── Sanitization Engine ─────────────────────────────────────────

/**
 * Apply word-boundary-aware substitutions to a string.
 * Agent names are replaced only when they appear as whole words.
 */
function sanitize(content, filePath) {
  let out = content;

  // 1. Org names first (longer patterns, before agent names)
  for (const { from, to } of ORG_NAME_MAP) {
    const re = new RegExp(`\\b${escapeRegex(from)}\\b`, 'g');
    out = out.replace(re, to);
  }

  // 2. Agent names (word-boundary aware)
  for (const { from, to } of AGENT_NAME_MAP) {
    // Match whole word, preserve case for Title-case occurrences (e.g. "Forge" → "Alice")
    const re = new RegExp(`\\b${escapeRegex(from)}\\b`, 'gi');
    out = out.replace(re, (match) => {
      if (match[0] === match[0].toUpperCase()) {
        return to.charAt(0).toUpperCase() + to.slice(1);
      }
      return to;
    });
  }

  // 3. Council lead quoted strings (precise string replacement)
  for (const { from, to } of COUNCIL_LEAD_MAP) {
    out = out.split(from).join(to);
  }

  // 4. Path substitutions
  for (const { from, to } of PATH_MAP) {
    out = out.replace(from, to);
  }

  // 5. Operator name patterns
  for (const { from, to } of OPERATOR_MAP) {
    out = out.replace(from, to);
  }

  return out;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── File Operations ─────────────────────────────────────────────

function shouldExclude(relativePath) {
  return EXCLUDE_FILES.some(ex => relativePath === ex || relativePath.endsWith('/' + ex));
}

function processFile(srcPath, destPath, relPath) {
  if (shouldExclude(relPath)) {
    console.log(`  SKIP (excluded): ${relPath}`);
    return;
  }

  const ext = extname(srcPath);
  const raw = readFileSync(srcPath, 'utf8');

  if (SANITIZE_EXTENSIONS.has(ext)) {
    const sanitized = sanitize(raw, relPath);
    if (sanitized !== raw) {
      console.log(`  SANITIZED: ${relPath}`);
    }
    if (!DRY_RUN) writeFileSync(destPath, sanitized, 'utf8');
  } else {
    // Binary or unknown — copy as-is
    if (!DRY_RUN) cpSync(srcPath, destPath);
  }
}

function syncDir(srcDir, destDir, relBase = '') {
  if (!existsSync(srcDir)) return;
  if (!DRY_RUN) mkdirSync(destDir, { recursive: true });

  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const relPath = relBase ? `${relBase}/${entry}` : entry;
    const stat = statSync(srcPath);

    if (stat.isDirectory()) {
      syncDir(srcPath, destPath, relPath);
    } else {
      processFile(srcPath, destPath, relPath);
    }
  }
}

// ─── Git Helpers ─────────────────────────────────────────────────

function git(cmd, opts = {}) {
  return execSync(`git -C "${REPO_ROOT}" ${cmd}`, {
    encoding: 'utf8',
    stdio: opts.silent ? 'pipe' : 'inherit',
    ...opts,
  });
}

function gitOut(cmd) {
  return execSync(`git -C "${REPO_ROOT}" ${cmd}`, { encoding: 'utf8' }).trim();
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log('=== HyperMem Public Sync ===');
  console.log(`Commit message: "${commitMsg}"`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : NO_PUSH ? 'local only' : 'push to public'}`);
  console.log('');

  // 1. Verify clean working tree on internal main
  const currentBranch = gitOut('rev-parse --abbrev-ref HEAD');
  if (currentBranch !== 'main') {
    console.error(`Must be run from main branch (currently on: ${currentBranch})`);
    process.exit(1);
  }

  const dirty = gitOut('status --porcelain');
  if (dirty) {
    console.error('Working tree has uncommitted changes. Commit or stash first.');
    console.error(dirty);
    process.exit(1);
  }

  const internalHead = gitOut('rev-parse --short HEAD');
  console.log(`Internal main HEAD: ${internalHead}`);

  // 2. Switch to public branch
  console.log('\n[1/6] Switching to public branch...');
  if (!DRY_RUN) {
    git('checkout -B public-sync public/main');
  } else {
    console.log('  DRY RUN: would checkout public-sync from public/main');
  }

  // 3. Sync and sanitize source files
  console.log('\n[2/6] Syncing and sanitizing files...');

  for (const dir of SYNC_DIRS) {
    const srcDir = join(REPO_ROOT, '..', '..', '..', REPO_ROOT, dir);
    // We need to read from the stashed internal main state.
    // Since we're on public-sync now, read internal files via git show.
    // Actually: sync from a temp export of internal main.
  }

  // Use git show to read each file from internal main, sanitize, write to working tree
  const internalFiles = gitOut(`ls-tree -r --name-only ${internalHead}`).split('\n').filter(Boolean);

  let synced = 0;
  let skipped = 0;
  let sanitized = 0;

  for (const relPath of internalFiles) {
    // Check if this file should be synced
    const shouldSync = SYNC_DIRS.some(d => relPath.startsWith(d + '/')) ||
                       SYNC_ROOT_FILES.includes(relPath);
    if (!shouldSync) continue;
    if (shouldExclude(relPath)) { skipped++; continue; }

    let content;
    try {
      content = execSync(`git -C "${REPO_ROOT}" show ${internalHead}:${relPath}`, {
        encoding: 'buffer',
      });
    } catch {
      console.warn(`  WARN: could not read ${relPath} from ${internalHead}`);
      continue;
    }

    const ext = extname(relPath);
    const destPath = join(REPO_ROOT, relPath);

    // Ensure parent dir exists
    const parentDir = join(REPO_ROOT, relPath.split('/').slice(0, -1).join('/'));
    if (!DRY_RUN && relPath.includes('/')) mkdirSync(parentDir, { recursive: true });

    if (SANITIZE_EXTENSIONS.has(ext)) {
      const raw = content.toString('utf8');
      const clean = sanitize(raw, relPath);
      if (clean !== raw) {
        console.log(`  sanitized: ${relPath}`);
        sanitized++;
      }
      if (!DRY_RUN) writeFileSync(destPath, clean, 'utf8');
    } else {
      if (!DRY_RUN) writeFileSync(destPath, content);
    }
    synced++;
  }

  console.log(`  ${synced} files synced, ${sanitized} sanitized, ${skipped} excluded`);

  if (DRY_RUN) {
    console.log('\nDRY RUN complete. No changes written.');
    return;
  }

  // 4. Build
  console.log('\n[3/6] Building...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });

  // 5. Test
  console.log('\n[4/6] Running test suite...');
  execSync('npm test', { cwd: REPO_ROOT, stdio: 'inherit' });

  // 6. Commit
  console.log('\n[5/6] Committing...');
  git('add -A');
  const diffStat = gitOut('diff --cached --stat');
  if (!diffStat) {
    console.log('  Nothing to commit — public branch is already up to date.');
    git('checkout main');
    return;
  }
  console.log(diffStat);
  git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);

  // 7. Push
  if (!NO_PUSH) {
    console.log('\n[6/6] Pushing to public remote...');
    git('push public HEAD:main');
    console.log('  ✅ Pushed to public/main');
  } else {
    console.log('\n[6/6] Skipped push (--no-push)');
    console.log('  To push manually: git push public HEAD:main');
  }

  // 8. Return to main
  git('checkout main');
  console.log('\n✅ Sync complete.');
  console.log(`   Internal: ${internalHead}`);
  console.log(`   Public commit: ${gitOut('rev-parse --short public/main')}`);
}

main().catch(err => {
  console.error('\n❌ Sync failed:', err.message);
  // Try to return to main on failure
  try { execSync(`git -C "${REPO_ROOT}" checkout main`, { stdio: 'pipe' }); } catch {}
  process.exit(1);
});
