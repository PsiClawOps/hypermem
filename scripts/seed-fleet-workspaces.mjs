#!/usr/bin/env node
/**
 * seed-fleet-workspaces.mjs
 *
 * Seeds governance and identity docs from all council/director workspaces
 * into HyperMem's doc chunk store (ACA Phase B — Step 3).
 *
 * What it does:
 *   For each known agent workspace, calls seedWorkspace() with the correct
 *   agentId and tier. Skips files that haven't changed since last seed.
 *
 * Usage:
 *   node scripts/seed-fleet-workspaces.mjs             # Seed all agents
 *   node scripts/seed-fleet-workspaces.mjs --dry-run   # Show what would be seeded
 *   node scripts/seed-fleet-workspaces.mjs --force     # Force re-index all
 *   node scripts/seed-fleet-workspaces.mjs --agent forge  # Single agent
 *   node scripts/seed-fleet-workspaces.mjs --stats     # Show index stats only
 *
 * Idempotent: re-running is safe. Files with unchanged content are skipped.
 * Atomic per-file: each file's chunks are swapped in a single transaction.
 */

import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';

const HYPERMEM_PATH = path.join(os.homedir(), '.openclaw/workspace/repo/hypermem/dist/index.js');
const WORKSPACE_ROOT = path.join(os.homedir(), '.openclaw/workspace-council');

const { HyperMem, seedWorkspace } = await import(HYPERMEM_PATH);

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const STATS_ONLY = args.includes('--stats');
const AGENT_FILTER = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null;

// ─── Fleet manifest ─────────────────────────────────────────────
// Maps agentId → { workspace, tier }
// Tier drives per-tier collection scoping in doc-chunker.
const FLEET = [
  // Council seats
  { agentId: 'forge',    tier: 'council',    workspace: path.join(WORKSPACE_ROOT, 'forge') },
  { agentId: 'compass',  tier: 'council',    workspace: path.join(WORKSPACE_ROOT, 'compass') },
  { agentId: 'clarity',  tier: 'council',    workspace: path.join(WORKSPACE_ROOT, 'clarity') },
  { agentId: 'sentinel', tier: 'council',    workspace: path.join(WORKSPACE_ROOT, 'sentinel') },
  { agentId: 'anvil',    tier: 'council',    workspace: path.join(WORKSPACE_ROOT, 'anvil') },
  { agentId: 'vanguard', tier: 'council',    workspace: path.join(WORKSPACE_ROOT, 'vanguard') },
  // Directors
  { agentId: 'pylon',    tier: 'director',   workspace: path.join(WORKSPACE_ROOT, 'pylon') },
  { agentId: 'vigil',    tier: 'director',   workspace: path.join(WORKSPACE_ROOT, 'vigil') },
  { agentId: 'plane',    tier: 'director',   workspace: path.join(WORKSPACE_ROOT, 'plane') },
  { agentId: 'helm',     tier: 'director',   workspace: path.join(WORKSPACE_ROOT, 'helm') },
  { agentId: 'chisel',   tier: 'director',   workspace: path.join(WORKSPACE_ROOT, 'chisel') },
  { agentId: 'facet',    tier: 'director',   workspace: path.join(WORKSPACE_ROOT, 'facet') },
  { agentId: 'bastion',  tier: 'director',   workspace: path.join(WORKSPACE_ROOT, 'bastion') },
  { agentId: 'gauge',    tier: 'director',   workspace: path.join(WORKSPACE_ROOT, 'gauge') },
  // Specialists
  { agentId: 'crucible', tier: 'specialist', workspace: path.join(WORKSPACE_ROOT, 'crucible') },
  { agentId: 'relay',    tier: 'specialist', workspace: path.join(WORKSPACE_ROOT, 'relay') },
];

// ─── Init HyperMem ──────────────────────────────────────────────

const hm = await HyperMem.create({
  dataDir: path.join(os.homedir(), '.openclaw/hypermem'),
  redis: {
    host: 'localhost',
    port: 6379,
    keyPrefix: 'hm:',
    sessionTTL: 14400,
    historyTTL: 86400,
  },
});

const libraryDb = hm.dbManager.getLibraryDb();

// ─── Stats only mode ────────────────────────────────────────────

if (STATS_ONLY) {
  const { WorkspaceSeeder } = await import(HYPERMEM_PATH);
  const seeder = new WorkspaceSeeder(libraryDb);
  const stats = seeder.getIndexStats();
  console.log('\n── Doc chunk index stats ──');
  if (stats.length === 0) {
    console.log('  (empty — no files indexed yet)');
  } else {
    for (const row of stats) {
      console.log(`  ${row.collection}: ${row.count} chunks, ${row.sources} files, ${row.totalTokens} tokens`);
    }
  }
  await hm.close();
  process.exit(0);
}

// ─── Seed ───────────────────────────────────────────────────────

const targets = AGENT_FILTER
  ? FLEET.filter(a => a.agentId === AGENT_FILTER)
  : FLEET;

if (targets.length === 0) {
  console.error(`Unknown agent: ${AGENT_FILTER}`);
  process.exit(1);
}

let totalInserted = 0;
let totalDeleted = 0;
let totalSkipped = 0;
let totalReindexed = 0;
const allErrors = [];

for (const { agentId, tier, workspace } of targets) {
  if (!existsSync(workspace)) {
    console.log(`⚠️  ${agentId}: workspace not found at ${workspace} — skipping`);
    continue;
  }

  console.log(`\n── ${agentId} (${tier}) ──`);
  console.log(`   workspace: ${workspace}`);

  if (DRY_RUN) {
    // Show staleness check without seeding
    const { WorkspaceSeeder } = await import(HYPERMEM_PATH);
    const seeder = new WorkspaceSeeder(libraryDb);
    const staleness = seeder.checkStaleness(workspace, { agentId, tier, includeDailyMemory: true, dailyMemoryLimit: 10 });
    for (const s of staleness) {
      const rel = path.relative(workspace, s.filePath);
      const status = s.needsReindex ? '🔄 needs index' : '✅ up to date';
      console.log(`   ${status}  ${rel}  → ${s.collection}`);
    }
    continue;
  }

  try {
    const result = await seedWorkspace(libraryDb, workspace, {
      agentId,
      tier,
      force: FORCE,
      includeDailyMemory: true,
      dailyMemoryLimit: 10,  // last 10 daily memory files
    });

    totalInserted += result.totalInserted;
    totalDeleted += result.totalDeleted;
    totalSkipped += result.skipped;
    totalReindexed += result.reindexed;

    for (const f of result.files) {
      if (f.result.inserted > 0 || f.result.reindexed) {
        const rel = path.relative(workspace, f.filePath);
        console.log(`   ✅ ${rel} → ${f.collection} (${f.result.inserted} chunks inserted)`);
      }
    }
    if (result.skipped > 0) {
      console.log(`   ⏭️  ${result.skipped} files up to date (skipped)`);
    }
    for (const e of result.errors) {
      const rel = path.relative(workspace, e.filePath);
      console.log(`   ❌ ${rel}: ${e.error}`);
      allErrors.push({ agentId, filePath: e.filePath, error: e.error });
    }
  } catch (err) {
    console.log(`   ❌ FATAL: ${err.message}`);
    allErrors.push({ agentId, error: err.message });
  }
}

// ─── Summary ────────────────────────────────────────────────────

if (!DRY_RUN) {
  console.log('\n══════════════════════════════════════════════');
  console.log(`  Seed complete`);
  console.log(`  Inserted:   ${totalInserted} chunks`);
  console.log(`  Deleted:    ${totalDeleted} stale chunks`);
  console.log(`  Re-indexed: ${totalReindexed} files`);
  console.log(`  Skipped:    ${totalSkipped} files (unchanged)`);
  if (allErrors.length > 0) {
    console.log(`  Errors:     ${allErrors.length}`);
    for (const e of allErrors) {
      console.log(`    - ${e.agentId}: ${e.error}`);
    }
  }
  console.log('══════════════════════════════════════════════\n');
}

// ─── Post-seed stats ────────────────────────────────────────────

if (!DRY_RUN && totalInserted > 0) {
  console.log('── Post-seed index stats ──');
  const { WorkspaceSeeder } = await import(HYPERMEM_PATH);
  const seeder = new WorkspaceSeeder(libraryDb);
  const stats = seeder.getIndexStats();
  for (const row of stats) {
    console.log(`  ${row.collection}: ${row.count} chunks, ${row.sources} files, ${row.totalTokens} tokens`);
  }
}

await hm.close();
