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
const PUBLIC_REMOTE_URL = 'github-psiclawops:PsiClawOps/hypermem.git';
const PUBLIC_REMOTE = 'public';

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
  { from: 'agent1',    to: 'alice'   },
  { from: 'agent2',  to: 'bob'     },
  // agent4 stays as 'agent4' — generic enough, no substitution
  { from: 'agent3', to: 'dave'    },
  { from: 'agent6',    to: 'carol'   },
  { from: 'agent5', to: 'oscar'   },
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
  { from: 'agent1-org',    to: 'alice-org'  },
  { from: 'agent2-org',  to: 'bob-org'    },
  { from: 'agent3-org', to: 'dave-org'   },
  { from: 'agent6-org',    to: 'carol-org'  },
  { from: 'agent5-org', to: 'oscar-org'  },
];

// Council lead references (councilLead field values)
// Applied as string replacements in quoted contexts
const COUNCIL_LEAD_MAP = [
  { from: "'agent1'",    to: "'alice'"   },
  { from: "'agent2'",  to: "'bob'"     },
  { from: "'agent3'", to: "'dave'"    },
  { from: "'agent6'",    to: "'carol'"   },
  { from: "'agent5'", to: "'oscar'"   },
];

// Path substitutions
const PATH_MAP = [
  // Internal workspace paths — replace with generic home-relative examples
  { from: /\/home\/lumadmin\/\.openclaw\/workspace-council\//g, to: '~/.openclaw/workspace/' },
  { from: /process\.env\.HOME \|\| '\/home\/user'/g,           to: "process.env.HOME || os.homedir()" },
  // Internal workspace repo paths (in comments/examples only — caught by word boundary rules above)
  { from: /~\/\.openclaw\/workspace-council\//g,               to: '~/.openclaw/workspace/' },
  // Bare home path (with trailing slash)
  { from: /\/home\/lumadmin\//g, to: '~/' },
  // Quoted home path (in path.join fallbacks like '/home/lumadmin')
  { from: /'\/home\/lumadmin'/g, to: "os.homedir()" },
  // Bare string in path.join() calls
  { from: /workspace-council/g, to: 'workspace' },
  // Internal repo URL → public repo URL
  { from: /hypermem-internal/g, to: 'hypermem' },
];

// Operator name substitutions (in code patterns, not user-facing docs)
const OPERATOR_MAP = [
  // In regex patterns that match operator name specifically
  { from: /\/\(\?:operator\|operator\)/g, to: '/(?:operator)' },
];

// ─── Product name substitutions ─────────────────────────────────
//
// Internal product names → generic public descriptions.
// Applied as whole-word replacements, case-preserved.
const PRODUCT_NAME_MAP = [
  // ClawText is the real predecessor product name — kept as-is in migration docs
  // { from: 'ClawText',     to: 'memory system' },
  { from: 'ClawDash',     to: 'dashboard' },
  { from: 'ClawCanvas',   to: 'canvas' },
  { from: 'ClawCouncil',  to: 'council' },
  { from: 'ClawTomation', to: 'automation' },
  { from: 'ClawMap',      to: 'dependency analyzer' },
  { from: 'ClawDispatch', to: 'dispatch' },
];

// Broad operator name substitution (in all text contexts)
const OPERATOR_BROAD_MAP = [
  { from: 'operator', to: 'operator' },
];

// ─── Leak detection terms ───────────────────────────────────────
//
// Post-sanitization scan. If any of these survive in the output,
// the sync fails. Case-insensitive matching.
const LEAK_TERMS = [
  'lumadmin',
  'ragesaq',
  // ClawText is a legitimate public product name (predecessor to HyperMem)
  // 'ClawText',
  'ClawDash',
  'ClawCanvas',
  'ClawCouncil',
  'ClawTomation',
  'ClawMap',
  'ClawDispatch',
  'workspace-council',
  // Agent names that should have been substituted (check Title case too)
  // Note: 'agent4' is intentionally not here — it's a generic word
];

// ─── Files to exclude from public sync ──────────────────────────
//
// These files exist in internal only and must not appear in public.
const EXCLUDE_FILES = [
  'scripts/flush-agent-session.sh',     // Internal fleet ops only
  'scripts/migrate-clawtext.mjs',       // Internal migration tool, ClawText refs
  'scripts/sync-public.mjs',            // The sync script itself
  'docs/ROADMAP.md',                    // Internal future work — not for public release
  'docs/PHASE1-VALIDATION.md',          // Internal validation artifact
  'docs/RELEASE_0.8.0_VALIDATION.md',   // Internal release checklist
];

// ─── Text file extensions to sanitize ───────────────────────────
const SANITIZE_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.mts', '.json',
  '.md', '.txt', '.sh', '.yaml', '.yml',
]);

// ─── Directories to sync ─────────────────────────────────────────
const SYNC_DIRS = ['src', 'test', 'scripts', 'docs', '.github', 'plugin', 'memory-plugin'];
const SYNC_ROOT_FILES = [
  'package.json', 'tsconfig.json',
  'README.md', 'CHANGELOG.md', 'INSTALL.md',
  'ARCHITECTURE.md', 'MIGRATION_GUIDE.md',
  'LICENSE', '.npmignore',
];

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
    // Match whole word, preserve case for Title-case occurrences (e.g. "agent1" → "Alice")
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

  // 4. Product names (word-boundary aware, case-preserved)
  for (const { from, to } of PRODUCT_NAME_MAP) {
    const re = new RegExp(`\\b${escapeRegex(from)}\\b`, 'g');
    out = out.replace(re, to);
  }

  // 5. Path substitutions
  for (const { from, to } of PATH_MAP) {
    out = out.replace(from, to);
  }

  // 6. Operator name patterns (specific regex patterns)
  for (const { from, to } of OPERATOR_MAP) {
    out = out.replace(from, to);
  }

  // 7. Broad operator name substitution (word-boundary)
  for (const { from, to } of OPERATOR_BROAD_MAP) {
    const re = new RegExp(`\\b${escapeRegex(from)}\\b`, 'gi');
    out = out.replace(re, to);
  }

  return out;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── File Operations ─────────────────────────────────────────────

function shouldExclude(relativePath) {
  if (relativePath.includes('node_modules')) return true;
  if (relativePath.endsWith('package-lock.json') && relativePath !== 'package-lock.json') return true;
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

  // 2. Add ephemeral public remote
  console.log('\n[1/6] Adding public remote (ephemeral)...');
  try { git(`remote remove ${PUBLIC_REMOTE}`, { silent: true }); } catch { /* didn't exist */ }
  git(`remote add ${PUBLIC_REMOTE} ${PUBLIC_REMOTE_URL}`);
  git(`fetch ${PUBLIC_REMOTE}`);
  console.log(`  Added ${PUBLIC_REMOTE} → ${PUBLIC_REMOTE_URL}`);

  // 3. Switch to public branch
  console.log('\n[2/6] Switching to public branch...');
  if (!DRY_RUN) {
    git(`checkout -B public-sync ${PUBLIC_REMOTE}/main`);
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

  // Post-sanitization leak scan
  console.log('\n[2.5/6] Running identity leak scan...');
  const leaks = [];
  for (const relPath of internalFiles) {
    const shouldSync = SYNC_DIRS.some(d => relPath.startsWith(d + '/')) ||
                       SYNC_ROOT_FILES.includes(relPath);
    if (!shouldSync || shouldExclude(relPath)) continue;

    const ext = extname(relPath);
    if (!SANITIZE_EXTENSIONS.has(ext)) continue;

    const destPath = join(REPO_ROOT, relPath);
    let content;
    try {
      content = DRY_RUN
        ? sanitize(execSync(`git -C "${REPO_ROOT}" show ${internalHead}:${relPath}`, { encoding: 'utf8' }), relPath)
        : readFileSync(destPath, 'utf8');
    } catch { continue; }

    for (const term of LEAK_TERMS) {
      const re = new RegExp(term, 'gi');
      const matches = content.match(re);
      if (matches) {
        // Find line numbers
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (new RegExp(term, 'gi').test(lines[i])) {
            leaks.push({ file: relPath, line: i + 1, term, snippet: lines[i].trim().slice(0, 100) });
          }
        }
      }
    }
  }

  if (leaks.length > 0) {
    console.error(`\n\u274C Identity leak scan found ${leaks.length} leaked term(s):`);
    for (const l of leaks) {
      console.error(`  ${l.file}:${l.line} — "${l.term}" — ${l.snippet}`);
    }
    if (!DRY_RUN) {
      console.error('\nSync aborted. Fix the substitution map or add exclusions, then re-run.');
      git('checkout main');
      process.exit(1);
    } else {
      console.warn('\n\u26A0\uFE0F  DRY RUN: leaks would block the real sync. Fix before running without --dry-run.');
    }
  } else {
    console.log('  \u2705 No leaked identity terms found.');
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN complete. No changes written.');
    return;
  }

  // 4. Docs accuracy gate (structural — blocks sync if docs contradict code)
  console.log('\n[3/7] Validating docs accuracy...');
  try {
    execSync('node scripts/validate-docs.mjs', { cwd: REPO_ROOT, stdio: 'inherit' });
  } catch {
    console.error('\n\u274C Docs validation failed. Fix the docs before releasing.');
    console.error('Run: node scripts/validate-docs.mjs');
    git('checkout main');
    process.exit(1);
  }

  // 5. Build all published artifacts
  console.log('\n[4/7] Building published artifacts...');
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  execSync('npm --prefix plugin run build', { cwd: REPO_ROOT, stdio: 'inherit' });
  execSync('npm --prefix memory-plugin run build', { cwd: REPO_ROOT, stdio: 'inherit' });

  // 6. Test release path, including plugin runtime artifacts
  console.log('\n[5/7] Running release-path validation...');
  execSync('npm run validate:release-path', { cwd: REPO_ROOT, stdio: 'inherit' });
  execSync('npm test', { cwd: REPO_ROOT, stdio: 'inherit' });

  // 7. Commit
  console.log('\n[6/7] Committing...');
  git('add -A');
  const diffStat = gitOut('diff --cached --stat');
  if (!diffStat) {
    console.log('  Nothing to commit — public branch is already up to date.');
    git('checkout main');
    return;
  }
  console.log(diffStat);
  git(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);

  // 8. Push
  if (!NO_PUSH) {
    console.log('\n[7/7] Pushing to public remote...');
    git(`push ${PUBLIC_REMOTE} HEAD:main`);
    console.log('  ✅ Pushed to public/main');
  } else {
    console.log('\n[7/7] Skipped push (--no-push)');
    console.log('  To push manually: re-run without --no-push');
  }

  // 9. Return to main, remove ephemeral remote
  const publicCommit = NO_PUSH ? '(not pushed)' : gitOut(`rev-parse --short ${PUBLIC_REMOTE}/main`);
  git('checkout main');
  try { git(`remote remove ${PUBLIC_REMOTE}`); } catch { /* best effort */ }
  console.log('\n✅ Sync complete.');
  console.log(`   Internal: ${internalHead}`);
  console.log(`   Public commit: ${publicCommit}`);
  console.log(`   Public remote removed (ephemeral).`);

  // 10. Wait for CI (optional — requires GH_TOKEN or GITHUB_TOKEN)
  if (!NO_PUSH) {
    await waitForCI(publicCommit);
  }
}

// ─── CI Status Checker ───────────────────────────────────────────

const CI_OWNER = 'PsiClawOps';
const CI_REPO  = 'hypermem';
const CI_POLL_INTERVAL_MS = 15_000;  // 15 seconds
const CI_TIMEOUT_MS = 300_000;       // 5 minutes

async function waitForCI(commitSha) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_PSICLAWOPS_TOKEN;
  if (!token) {
    console.log('\n⏭️  Skipping CI check (no GH_TOKEN/GITHUB_TOKEN set).');
    console.log('   Check manually: https://github.com/PsiClawOps/hypermem/actions');
    return;
  }

  console.log(`\n[CI] Waiting for GitHub Actions on ${commitSha}...`);
  const apiBase = `https://api.github.com/repos/${CI_OWNER}/${CI_REPO}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'hypermem-sync-public',
  };

  const start = Date.now();
  while (Date.now() - start < CI_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, CI_POLL_INTERVAL_MS));

    try {
      const res = await fetch(`${apiBase}/actions/runs?per_page=5`, { headers });
      if (!res.ok) {
        console.log(`   ⚠️  GitHub API ${res.status}: ${res.statusText}`);
        continue;
      }
      const data = await res.json();
      // Find a run that matches our commit (short sha prefix match)
      const run = data.workflow_runs?.find(r =>
        r.head_sha?.startsWith(commitSha) || commitSha.startsWith(r.head_sha?.slice(0, 7))
      );

      if (!run) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        process.stdout.write(`   ⏳ No run found yet (${elapsed}s)\r`);
        continue;
      }

      if (run.status === 'completed') {
        if (run.conclusion === 'success') {
          console.log(`   ✅ CI passed: ${run.html_url}`);
          return;
        } else {
          console.error(`   ❌ CI failed (${run.conclusion}): ${run.html_url}`);
          process.exitCode = 1;
          return;
        }
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(`   ⏳ CI ${run.status} (${elapsed}s)\r`);
    } catch (err) {
      console.log(`   ⚠️  CI check error: ${err.message}`);
    }
  }

  console.log(`\n   ⚠️  CI check timed out after ${CI_TIMEOUT_MS / 1000}s.`);
  console.log(`   Check manually: https://github.com/${CI_OWNER}/${CI_REPO}/actions`);
}

main().catch(err => {
  console.error('\n❌ Sync failed:', err.message);
  // Try to return to main and clean up ephemeral remote on failure
  try { execSync(`git -C "${REPO_ROOT}" checkout main`, { stdio: 'pipe' }); } catch {}
  try { execSync(`git -C "${REPO_ROOT}" remote remove ${PUBLIC_REMOTE}`, { stdio: 'pipe' }); } catch {}
  process.exit(1);
});
