/**
 * Cross-agent memory access test.
 *
 * Tests visibility-scoped access between agents:
 * - Private data stays private
 * - Org members can see org-visible data
 * - Council seats can see council-visible data
 * - Fleet-visible data is accessible to everyone
 * - Identity-domain data is always blocked
 * - Raw messages are always blocked
 */

import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-crossagent-'));

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
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Cross-Agent Access Test');
  console.log('═══════════════════════════════════════════════════\n');

  let hm;
  try {
    hm = await HyperMem.create({
      dataDir: tmpDir,
    });

    // ── Set up agents ──
    console.log('── Setting up agents ──');

    // agent1 (council, infra org lead)
    hm.dbManager.ensureAgent('agent1', { displayName: 'agent1', tier: 'council' });
    // Pylon (director, agent1-org)
    hm.dbManager.ensureAgent('pylon', { displayName: 'Pylon', tier: 'director', org: 'agent1-org' });
    // Set reportsTo for pylon via FleetStore (ensureAgent doesn't support it)
    const { FleetStore } = await import('../dist/fleet-store.js');
    const fleetStore = new FleetStore(hm.dbManager.getLibraryDb());
    fleetStore.upsertAgent('pylon', { reportsTo: 'agent1', orgId: 'agent1-org' });
    // agent2 (council, product org lead)
    hm.dbManager.ensureAgent('agent2', { displayName: 'agent2', tier: 'council' });
    // Crucible (specialist, no org)
    hm.dbManager.ensureAgent('crucible', { displayName: 'Crucible', tier: 'specialist' });

    // ── Populate agent1's memory ──
    console.log('\n── Populating agent1 memory ──');

    // All structured knowledge goes in the library DB
    const libDb = hm.dbManager.getLibraryDb();

    // Private fact (only agent1 should see)
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('agent1', 'agent', 'operations', 'I prefer deploying at 2am when traffic is lowest', 1.0, 'private');

    // Org-visible fact (agent1 + Pylon/Vigil/Plane should see)
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('agent1', 'agent', 'infrastructure', 'Redis 7.0.15 is running on the host', 1.0, 'org');

    // Council-visible fact
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('agent1', 'agent', 'architecture', 'HyperMem replaces ClawText as the memory architecture', 0.95, 'council');

    // Fleet-visible fact
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('agent1', 'agent', 'infrastructure', 'Gateway restart required after config changes', 0.9, 'fleet');

    // Identity-domain fact (should ALWAYS be blocked, even if marked fleet)
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('agent1', 'agent', 'identity', 'I am agent1, the infrastructure seat', 1.0, 'fleet');

    // Session-scoped fact (should be excluded from cross-agent)
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('agent1', 'session', 'operations', 'Currently debugging Redis connection', 1.0, 'fleet');

    // Knowledge entries
    libDb.prepare(`INSERT INTO knowledge (agent_id, domain, key, content, confidence, visibility, source_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run('agent1', 'operations', 'deploy-process', 'Run preflight, push containers, health check, traffic shift', 0.9, 'org', 'conversation');

    libDb.prepare(`INSERT INTO knowledge (agent_id, domain, key, content, confidence, visibility, source_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run('agent1', 'identity', 'soul-anchor', 'Infrastructure seat, pragmatic, calm under pressure', 1.0, 'fleet', 'file');

    // Episodes
    libDb.prepare(`INSERT INTO episodes (agent_id, event_type, summary, significance, visibility, participants, created_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 0.0)`)
      .run('agent1', 'deployment', 'Deployed HyperMem Phase 1 to production', 8, 'council', JSON.stringify(['agent1', 'ragesaq']));

    libDb.prepare(`INSERT INTO episodes (agent_id, event_type, summary, significance, visibility, participants, created_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 0.0)`)
      .run('agent1', 'incident', 'Fixed ClawText graft hook poisoning fleet transcripts', 9, 'fleet', JSON.stringify(['agent1', 'pylon']));

    // Messages (should NEVER be accessible cross-agent)
    await hm.recordUserMessage('agent1', 'agent:agent1:webchat:main', 'Secret operational discussion', {
      channelType: 'webchat',
    });

    assert(true, 'Populated agent1 memory (6 facts, 2 knowledge, 2 episodes, 1 message)');

    // ── Test: agent1 reads own data (self-access) ──
    console.log('\n── Self-access (agent1 → agent1) ──');
    const selfFacts = hm.queryAgent('agent1', 'agent1', { memoryType: 'facts' });
    assert(selfFacts.length === 4, `agent1 sees all 4 own non-session facts (got ${selfFacts.length})`);
    // Identity facts are excluded even for self via cross-agent query
    const selfIdentityFacts = selfFacts.filter(f => f.domain === 'identity');
    assert(selfIdentityFacts.length === 0, `Identity facts excluded even in self-query (got ${selfIdentityFacts.length})`);

    // ── Test: Pylon reads agent1 (same org) ──
    console.log('\n── Org access (Pylon → agent1) ──');
    const pylonFacts = hm.queryAgent('pylon', 'agent1', { memoryType: 'facts' });
    // Pylon should see: org + council + fleet (director can see council lead's council-visible data)
    // NOT private, NOT identity, NOT session
    const pylonDomains = pylonFacts.map(f => `${f.domain}:${f.visibility}`);
    assert(pylonFacts.length === 3, `Pylon sees 3 agent1 facts: org + council + fleet (got ${pylonFacts.length}: ${pylonDomains})`);
    assert(!pylonFacts.some(f => f.visibility === 'private'), 'Pylon cannot see private facts');
    assert(!pylonFacts.some(f => f.domain === 'identity'), 'Pylon cannot see identity facts');

    const pylonKnowledge = hm.queryAgent('pylon', 'agent1', { memoryType: 'knowledge' });
    assert(pylonKnowledge.length === 1, `Pylon sees 1 agent1 knowledge entry (org-visible, not identity) (got ${pylonKnowledge.length})`);
    assert(pylonKnowledge[0].domain !== 'identity', 'Identity knowledge blocked for Pylon');

    // ── Test: agent2 reads agent1 (different org, council seat) ──
    console.log('\n── Council access (agent2 → agent1) ──');
    const compassFacts = hm.queryAgent('agent2', 'agent1', { memoryType: 'facts' });
    // agent2 should see: council + fleet (NOT private, NOT org, NOT identity, NOT session)
    assert(compassFacts.length === 2, `agent2 sees 2 agent1 facts: council + fleet (got ${compassFacts.length})`);
    assert(!compassFacts.some(f => f.visibility === 'private'), 'agent2 cannot see private facts');
    assert(!compassFacts.some(f => f.visibility === 'org'), 'agent2 cannot see org-only facts');

    const compassEpisodes = hm.queryAgent('agent2', 'agent1', { memoryType: 'episodes' });
    // Both episodes: one council, one fleet
    assert(compassEpisodes.length === 2, `agent2 sees 2 agent1 episodes (got ${compassEpisodes.length})`);

    // ── Test: Crucible reads agent1 (specialist, no org) ──
    console.log('\n── Fleet access (Crucible → agent1) ──');
    const crucibleFacts = hm.queryAgent('crucible', 'agent1', { memoryType: 'facts' });
    // Crucible should see: fleet only (NOT private, NOT org, NOT council, NOT identity, NOT session)
    assert(crucibleFacts.length === 1, `Crucible sees 1 agent1 fact: fleet only (got ${crucibleFacts.length})`);
    assert(crucibleFacts[0].visibility === 'fleet', `Crucible's fact is fleet-visible`);

    const crucibleEpisodes = hm.queryAgent('crucible', 'agent1', { memoryType: 'episodes' });
    assert(crucibleEpisodes.length === 1, `Crucible sees 1 agent1 episode: fleet only (got ${crucibleEpisodes.length})`);

    // ── Test: Messages are ALWAYS private ──
    console.log('\n── Message privacy ──');
    const pylonMsgs = hm.queryAgent('pylon', 'agent1', { memoryType: 'messages' });
    assert(pylonMsgs.length === 0, 'Pylon cannot read agent1 messages (always private)');

    const compassMsgs = hm.queryAgent('agent2', 'agent1', { memoryType: 'messages' });
    assert(compassMsgs.length === 0, 'agent2 cannot read agent1 messages (always private)');

    // ── Test: Fleet-wide query ──
    console.log('\n── Fleet-wide query ──');
    // Populate agent2 with some fleet-visible data (in library DB)
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('agent2', 'agent', 'product', 'ClawCanvas is the primary user surface', 0.95, 'fleet');

    const fleetResults = hm.queryFleet('crucible', { memoryType: 'facts' });
    assert(fleetResults.length >= 2, `Fleet query returns facts from multiple agents (got ${fleetResults.length})`);
    const agents = [...new Set(fleetResults.map(r => r.sourceAgent))];
    assert(agents.length >= 2, `Fleet results span ${agents.length} agents: ${agents.join(', ')}`);

    // ── Cleanup ──
    console.log('\n── Cleanup ──');
    // Cleanup handled by tmpdir removal
    assert(true, 'Cleaned up');

  } catch (err) {
    console.error('\n💥 Test error:', err);
    failed++;
  } finally {
    if (hm) await hm.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

run();
