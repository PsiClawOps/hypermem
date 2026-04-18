import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-fleet-startup-'));
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-home-'));

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

function writeIdentity(root, agentId, body) {
  const dir = path.join(root, agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'IDENTITY.md'), body);
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Fleet Startup Seeding');
  console.log('═══════════════════════════════════════════════════\n');

  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;

  let hm;
  try {
    hm = await HyperMem.create({ dataDir: tmpDir });

    const councilRoot = path.join(tmpHome, '.openclaw', 'workspace-council');
    fs.mkdirSync(councilRoot, { recursive: true });

    writeIdentity(councilRoot, 'forge', `# IDENTITY.md — Forge, Infrastructure\n\n- **Name:** Forge\n- **Role:** Council infrastructure seat — evaluates operational fitness\n`);
    writeIdentity(councilRoot, 'compass', `# IDENTITY.md — Compass, Vision\n\n- **Name:** Compass\n- **Role:** Council vision seat — holds the destination\n`);
    writeIdentity(councilRoot, 'helm', `# IDENTITY.md — Helm, Strategy\n\n- **Name:** Helm\n- **Role:** Strategy Director — translates vision into executable direction\n- **Reports to:** Compass\n`);
    writeIdentity(councilRoot, 'pylon', `# IDENTITY.md — Pylon, Infrastructure\n\n- **Name:** Pylon\n- **Role:** Infrastructure Director — executes infra changes\n- **Reports to:** Forge\n`);
    writeIdentity(councilRoot, 'relay', `# IDENTITY.md — Relay, Aide-de-Camp\n\n- **Name:** Relay\n- **Role:** Aide-de-Camp — direct operational support\n- **Reports to:** operator (direct)\n`);

    // Simulate an existing messages.db agent directory that has not yet been
    // backfilled into fleet_agents.
    hm.dbManager.getMessageDb('ember');

    const seeded = await hm.seedFleetAgentsOnStartup({
      workspaceRoots: [councilRoot],
      includeMessageDbAgents: true,
      hydrateCache: false,
    });

    assert(seeded.discovered === 6, `discovered 6 startup candidates (got ${seeded.discovered})`);
    assert(seeded.inserted === 6, `inserted 6 fleet rows on cold start (got ${seeded.inserted})`);
    assert(seeded.updated === 0, 'no updates on first cold-start seed');
    assert(seeded.skipped === 0, 'no skips on first cold-start seed');
    assert(seeded.orgsCreated === 2, `created 2 council orgs (got ${seeded.orgsCreated})`);

    const forge = hm.getFleetAgent('forge');
    const compass = hm.getFleetAgent('compass');
    const helm = hm.getFleetAgent('helm');
    const pylon = hm.getFleetAgent('pylon');
    const relay = hm.getFleetAgent('relay');
    const ember = hm.getFleetAgent('ember');

    assert(forge?.tier === 'council', `forge tier is council (got ${forge?.tier})`);
    assert(forge?.orgId === 'forge-org', `forge orgId is forge-org (got ${forge?.orgId})`);
    assert(compass?.tier === 'council', `compass tier is council (got ${compass?.tier})`);
    assert(compass?.orgId === 'compass-org', `compass orgId is compass-org (got ${compass?.orgId})`);
    assert(helm?.tier === 'director', `helm tier is director (got ${helm?.tier})`);
    assert(helm?.reportsTo === 'compass', `helm reportsTo is compass (got ${helm?.reportsTo})`);
    assert(helm?.orgId === 'compass-org', `helm orgId is compass-org (got ${helm?.orgId})`);
    assert(pylon?.reportsTo === 'forge', `pylon reportsTo is forge (got ${pylon?.reportsTo})`);
    assert(pylon?.orgId === 'forge-org', `pylon orgId is forge-org (got ${pylon?.orgId})`);
    assert(relay?.tier === 'specialist', `relay tier is specialist (got ${relay?.tier})`);
    assert(relay?.reportsTo === null, 'relay does not map human direct report into reportsTo');
    assert(ember?.tier === 'unknown', `message-db fallback seeds ember as unknown tier (got ${ember?.tier})`);

    const orgs = hm.listFleetOrgs();
    assert(orgs.some(org => org.id === 'forge-org' && org.leadAgentId === 'forge'), 'forge-org row created');
    assert(orgs.some(org => org.id === 'compass-org' && org.leadAgentId === 'compass'), 'compass-org row created');

    const repeated = await hm.seedFleetAgentsOnStartup({
      workspaceRoots: [councilRoot],
      includeMessageDbAgents: true,
      hydrateCache: false,
    });

    assert(repeated.inserted === 0, 'repeat startup seed inserts nothing');
    assert(repeated.updated === 0, 'repeat startup seed does not churn rows');
    assert(repeated.skipped === 6, `repeat startup seed skips all 6 rows (got ${repeated.skipped})`);
    assert(repeated.orgsCreated === 0, 'repeat startup seed does not recreate org rows');
  } finally {
    process.env.HOME = originalHome;
    if (hm) {
      try { await hm.close(); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
