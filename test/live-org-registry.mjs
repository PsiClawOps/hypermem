/**
 * Live Org Registry Test
 *
 * Validates that buildOrgRegistryFromDb() loads org structure from the
 * fleet_agents/fleet_orgs tables instead of the hardcoded fallback,
 * and that the fallback works correctly when the DB is empty.
 */

import { buildOrgRegistryFromDb, defaultOrgRegistry } from '../dist/cross-agent.js';
import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-livereg-'));

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

async function run() {
  console.log('\n─── Live Org Registry ───');

  let hm;
  try {
    hm = await HyperMem.create({
      dataDir: tmpDir,
    });

    const libDb = hm.dbManager.getLibraryDb();

    // ── Fallback: empty fleet ─────────────────────────────────
    console.log('\n  Fallback (empty fleet):');
    const fallbackReg = buildOrgRegistryFromDb(libDb);
    const hardcoded = defaultOrgRegistry();

    // When fleet is empty, should match hardcoded registry
    assert(
      Object.keys(fallbackReg.agents).length === Object.keys(hardcoded.agents).length,
      `empty fleet returns hardcoded registry (${Object.keys(fallbackReg.agents).length} agents)`
    );
    assert('alice' in fallbackReg.agents, 'alice present in fallback');
    assert('director1' in fallbackReg.agents, 'director1 present in fallback');

    // ── With DB agents ────────────────────────────────────────
    console.log('\n  With seeded fleet:');

    // Seed some agents — use FleetStore directly to set reportsTo
    const { FleetStore } = await import('../dist/fleet-store.js');
    const fleetStore = new FleetStore(libDb);

    hm.dbManager.ensureAgent('alice', { displayName: 'alice', tier: 'council' });
    hm.dbManager.ensureAgent('director1', { displayName: 'Director1', tier: 'director', org: 'alice-org' });
    hm.dbManager.ensureAgent('newagent', { displayName: 'NewAgent', tier: 'specialist' });

    // Set reportsTo via FleetStore upsert (ensureAgent doesn't support it directly)
    fleetStore.upsertAgent('director1', {
      displayName: 'Director1',
      tier: 'director',
      orgId: 'alice-org',
      reportsTo: 'alice',
    });

    const liveReg = buildOrgRegistryFromDb(libDb);

    assert('alice' in liveReg.agents, 'alice loaded from DB');
    assert(liveReg.agents['alice'].tier === 'council', 'alice tier is council');

    assert('director1' in liveReg.agents, 'director1 loaded from DB');
    assert(liveReg.agents['director1'].councilLead === 'alice', 'director1 reports to alice');
    assert(liveReg.agents['director1'].org === 'alice-org', 'director1 in alice-org');

    assert('newagent' in liveReg.agents, 'newagent loaded from DB (not in hardcoded)');
    assert(liveReg.agents['newagent'].tier === 'specialist', 'newagent tier is specialist');

    // Agents not seeded to DB but in hardcoded registry should still be present (merge)
    assert('bob' in liveReg.agents, 'bob preserved from hardcoded fallback (not in DB)');

    // Org membership: director1 should be in alice-org
    assert(
      liveReg.orgs['alice-org']?.includes('director1'),
      'director1 is in alice-org in live registry'
    );

    // ── Access control using live registry ────────────────────
    console.log('\n  Access control with live registry:');
    const { visibilityFilter } = await import('../dist/cross-agent.js');

    const forgeIdentity = liveReg.agents['alice'];
    const director1Identity = liveReg.agents['director1'];

    // alice (council) can read director1's org-visible content
    const forgeFilterForDirector1 = visibilityFilter(forgeIdentity, 'director1', liveReg);
    assert(forgeFilterForDirector1.canReadOrg, 'alice can read director1 org-visible (same org)');

    // Director1 can read alice's org-visible content (council lead)
    const director1FilterForForge = visibilityFilter(director1Identity, 'alice', liveReg);
    assert(director1FilterForForge.canReadCouncil, 'director1 can read alice council-visible (reports to alice)');

    // NewAgent (specialist, no org) should only see fleet-visible from director1
    const newAgentIdentity = liveReg.agents['newagent'];
    const newAgentFilterForDirector1 = visibilityFilter(newAgentIdentity, 'director1', liveReg);
    assert(!newAgentFilterForDirector1.canReadOrg, 'newagent cannot read director1 org-visible (different org)');
    assert(!newAgentFilterForDirector1.canReadCouncil, 'newagent cannot read director1 council-visible');

    // ── Compositor wiring: orgRegistry cached at init ──────────────────────
    console.log('\n  Compositor.orgRegistry (cached on init):');
    const { Compositor } = await import('../dist/compositor.js');

    const compositor = new Compositor({ cache: hm.cache, libraryDb: libDb });

    // Registry should be live (has the seeded agents)
    const cached = compositor.orgRegistry;
    assert('alice' in cached.agents, 'compositor: alice in cached registry');
    assert('newagent' in cached.agents, 'compositor: newagent from DB in cached registry');

    // refreshOrgRegistry() should return the live registry
    const refreshed = compositor.refreshOrgRegistry();
    assert('alice' in refreshed.agents, 'compositor.refreshOrgRegistry returns alice');
    assert('newagent' in refreshed.agents, 'compositor.refreshOrgRegistry returns newagent');
    assert(compositor.orgRegistry === refreshed, 'compositor._orgRegistry updated after refresh');

    // Minimal constructor falls back to hardcoded registry
    const minimalCompositor = new Compositor({ cache: hm.cache });
    const minimalReg = minimalCompositor.orgRegistry;
    assert('alice' in minimalReg.agents, 'minimal compositor: alice in fallback registry');
    // Fallback registry is hardcoded, not DB-loaded (no newagent)
    assert(!('newagent' in minimalReg.agents), 'minimal compositor: newagent NOT in hardcoded registry');
    // refreshOrgRegistry on minimal (no libraryDb) returns existing registry unchanged
    const minimalRefreshed = minimalCompositor.refreshOrgRegistry();
    assert(minimalRefreshed === minimalReg, 'minimal refreshOrgRegistry no-ops without libraryDb');

  } finally {
    if (hm) {
      try { await hm.close(); } catch { /* ignore */ }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().then(() => {
  console.log(`\n═══ LiveOrgRegistry: ${passed} passed, ${failed} failed ═══\n`);
  if (failed > 0) process.exit(1);
}).catch(err => {
  // Redis not available — skip gracefully
  if (err.message?.includes('ECONNREFUSED') || err.message?.includes('connect')) {
    console.log('  ⚠️  Redis not available — skipping live registry test');
    process.exit(0);
  }
  console.error('Test error:', err);
  process.exit(1);
});
