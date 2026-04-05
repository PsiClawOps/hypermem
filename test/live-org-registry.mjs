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
      redis: { host: 'localhost', port: 6379, keyPrefix: 'hm-livereg:', sessionTTL: 60 },
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
    assert('forge' in fallbackReg.agents, 'forge present in fallback');
    assert('pylon' in fallbackReg.agents, 'pylon present in fallback');

    // ── With DB agents ────────────────────────────────────────
    console.log('\n  With seeded fleet:');

    // Seed some agents — use FleetStore directly to set reportsTo
    const { FleetStore } = await import('../dist/fleet-store.js');
    const fleetStore = new FleetStore(libDb);

    hm.dbManager.ensureAgent('forge', { displayName: 'Forge', tier: 'council' });
    hm.dbManager.ensureAgent('pylon', { displayName: 'Pylon', tier: 'director', org: 'forge-org' });
    hm.dbManager.ensureAgent('newagent', { displayName: 'NewAgent', tier: 'specialist' });

    // Set reportsTo via FleetStore upsert (ensureAgent doesn't support it directly)
    fleetStore.upsertAgent('pylon', {
      displayName: 'Pylon',
      tier: 'director',
      orgId: 'forge-org',
      reportsTo: 'forge',
    });

    const liveReg = buildOrgRegistryFromDb(libDb);

    assert('forge' in liveReg.agents, 'forge loaded from DB');
    assert(liveReg.agents['forge'].tier === 'council', 'forge tier is council');

    assert('pylon' in liveReg.agents, 'pylon loaded from DB');
    assert(liveReg.agents['pylon'].councilLead === 'forge', 'pylon reports to forge');
    assert(liveReg.agents['pylon'].org === 'forge-org', 'pylon in forge-org');

    assert('newagent' in liveReg.agents, 'newagent loaded from DB (not in hardcoded)');
    assert(liveReg.agents['newagent'].tier === 'specialist', 'newagent tier is specialist');

    // Agents not seeded to DB but in hardcoded registry should still be present (merge)
    assert('compass' in liveReg.agents, 'compass preserved from hardcoded fallback (not in DB)');

    // Org membership: pylon should be in forge-org
    assert(
      liveReg.orgs['forge-org']?.includes('pylon'),
      'pylon is in forge-org in live registry'
    );

    // ── Access control using live registry ────────────────────
    console.log('\n  Access control with live registry:');
    const { visibilityFilter } = await import('../dist/cross-agent.js');

    const forgeIdentity = liveReg.agents['forge'];
    const pylonIdentity = liveReg.agents['pylon'];

    // Forge (council) can read pylon's org-visible content
    const forgeFilterForPylon = visibilityFilter(forgeIdentity, 'pylon', liveReg);
    assert(forgeFilterForPylon.canReadOrg, 'forge can read pylon org-visible (same org)');

    // Pylon can read forge's org-visible content (council lead)
    const pylonFilterForForge = visibilityFilter(pylonIdentity, 'forge', liveReg);
    assert(pylonFilterForForge.canReadCouncil, 'pylon can read forge council-visible (reports to forge)');

    // NewAgent (specialist, no org) should only see fleet-visible from pylon
    const newAgentIdentity = liveReg.agents['newagent'];
    const newAgentFilterForPylon = visibilityFilter(newAgentIdentity, 'pylon', liveReg);
    assert(!newAgentFilterForPylon.canReadOrg, 'newagent cannot read pylon org-visible (different org)');
    assert(!newAgentFilterForPylon.canReadCouncil, 'newagent cannot read pylon council-visible');

    // ── Compositor wiring: orgRegistry cached at init ──────────────────────
    console.log('\n  Compositor.orgRegistry (cached on init):');
    const { Compositor } = await import('../dist/compositor.js');
    const { RedisLayer } = await import('../dist/redis.js');
    const redis = new RedisLayer({ host: 'localhost', port: 6379, keyPrefix: 'hm-livereg-comp:', sessionTTL: 60 });

    const compositor = new Compositor({ redis, libraryDb: libDb });

    // Registry should be live (has the seeded agents)
    const cached = compositor.orgRegistry;
    assert('forge' in cached.agents, 'compositor: forge in cached registry');
    assert('newagent' in cached.agents, 'compositor: newagent from DB in cached registry');

    // refreshOrgRegistry() should return the live registry
    const refreshed = compositor.refreshOrgRegistry();
    assert('forge' in refreshed.agents, 'compositor.refreshOrgRegistry returns forge');
    assert('newagent' in refreshed.agents, 'compositor.refreshOrgRegistry returns newagent');
    assert(compositor.orgRegistry === refreshed, 'compositor._orgRegistry updated after refresh');

    // Legacy constructor (RedisLayer only) falls back to hardcoded registry
    const legacyCompositor = new Compositor(redis);
    const legacyReg = legacyCompositor.orgRegistry;
    assert('forge' in legacyReg.agents, 'legacy compositor: forge in fallback registry');
    // Legacy registry is hardcoded, not DB-loaded (no newagent)
    assert(!('newagent' in legacyReg.agents), 'legacy compositor: newagent NOT in hardcoded registry');
    // refreshOrgRegistry on legacy (no libraryDb) returns existing registry unchanged
    const legacyRefreshed = legacyCompositor.refreshOrgRegistry();
    assert(legacyRefreshed === legacyReg, 'legacy refreshOrgRegistry no-ops without libraryDb');

    await redis.disconnect();

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
