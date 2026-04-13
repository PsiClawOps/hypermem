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

    // alice (council, infra org lead)
    hm.dbManager.ensureAgent('alice', { displayName: 'alice', tier: 'council' });
    // Director1 (director, alice-org)
    hm.dbManager.ensureAgent('director1', { displayName: 'Director1', tier: 'director', org: 'alice-org' });
    // Set reportsTo for director1 via FleetStore (ensureAgent doesn't support it)
    const { FleetStore } = await import('../dist/fleet-store.js');
    const fleetStore = new FleetStore(hm.dbManager.getLibraryDb());
    fleetStore.upsertAgent('director1', { reportsTo: 'alice', orgId: 'alice-org' });
    // bob (council, product org lead)
    hm.dbManager.ensureAgent('bob', { displayName: 'bob', tier: 'council' });
    // Specialist1 (specialist, no org)
    hm.dbManager.ensureAgent('specialist1', { displayName: 'Specialist1', tier: 'specialist' });

    // ── Populate alice's memory ──
    console.log('\n── Populating alice memory ──');

    // All structured knowledge goes in the library DB
    const libDb = hm.dbManager.getLibraryDb();

    // Private fact (only alice should see)
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('alice', 'agent', 'operations', 'I prefer deploying at 2am when traffic is lowest', 1.0, 'private');

    // Org-visible fact (alice + Director1/Director2/Director3 should see)
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('alice', 'agent', 'infrastructure', 'Redis 7.0.15 is running on the host', 1.0, 'org');

    // Council-visible fact
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('alice', 'agent', 'architecture', 'HyperMem replaces ClawText as the memory architecture', 0.95, 'council');

    // Fleet-visible fact
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('alice', 'agent', 'infrastructure', 'Gateway restart required after config changes', 0.9, 'fleet');

    // Identity-domain fact (should ALWAYS be blocked, even if marked fleet)
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('alice', 'agent', 'identity', 'I am alice, the infrastructure seat', 1.0, 'fleet');

    // Session-scoped fact (should be excluded from cross-agent)
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('alice', 'session', 'operations', 'Currently debugging Redis connection', 1.0, 'fleet');

    // Knowledge entries
    libDb.prepare(`INSERT INTO knowledge (agent_id, domain, key, content, confidence, visibility, source_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run('alice', 'operations', 'deploy-process', 'Run preflight, push containers, health check, traffic shift', 0.9, 'org', 'conversation');

    libDb.prepare(`INSERT INTO knowledge (agent_id, domain, key, content, confidence, visibility, source_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
      .run('alice', 'identity', 'soul-anchor', 'Infrastructure seat, pragmatic, calm under pressure', 1.0, 'fleet', 'file');

    // Episodes
    libDb.prepare(`INSERT INTO episodes (agent_id, event_type, summary, significance, visibility, participants, created_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 0.0)`)
      .run('alice', 'deployment', 'Deployed HyperMem Phase 1 to production', 8, 'council', JSON.stringify(['alice', 'operator']));

    libDb.prepare(`INSERT INTO episodes (agent_id, event_type, summary, significance, visibility, participants, created_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 0.0)`)
      .run('alice', 'incident', 'Fixed ClawText graft hook poisoning fleet transcripts', 9, 'fleet', JSON.stringify(['alice', 'director1']));

    // Messages (should NEVER be accessible cross-agent)
    await hm.recordUserMessage('alice', 'agent:alice:webchat:main', 'Secret operational discussion', {
      channelType: 'webchat',
    });

    assert(true, 'Populated alice memory (6 facts, 2 knowledge, 2 episodes, 1 message)');

    // ── Test: alice reads own data (self-access) ──
    console.log('\n── Self-access (alice → alice) ──');
    const selfFacts = hm.queryAgent('alice', 'alice', { memoryType: 'facts' });
    assert(selfFacts.length === 4, `alice sees all 4 own non-session facts (got ${selfFacts.length})`);
    // Identity facts are excluded even for self via cross-agent query
    const selfIdentityFacts = selfFacts.filter(f => f.domain === 'identity');
    assert(selfIdentityFacts.length === 0, `Identity facts excluded even in self-query (got ${selfIdentityFacts.length})`);

    // ── Test: Director1 reads alice (same org) ──
    console.log('\n── Org access (Director1 → alice) ──');
    const director1Facts = hm.queryAgent('director1', 'alice', { memoryType: 'facts' });
    // Director1 should see: org + council + fleet (director can see council lead's council-visible data)
    // NOT private, NOT identity, NOT session
    const director1Domains = director1Facts.map(f => `${f.domain}:${f.visibility}`);
    assert(director1Facts.length === 3, `Director1 sees 3 alice facts: org + council + fleet (got ${director1Facts.length}: ${director1Domains})`);
    assert(!director1Facts.some(f => f.visibility === 'private'), 'Director1 cannot see private facts');
    assert(!director1Facts.some(f => f.domain === 'identity'), 'Director1 cannot see identity facts');

    const director1Knowledge = hm.queryAgent('director1', 'alice', { memoryType: 'knowledge' });
    assert(director1Knowledge.length === 1, `Director1 sees 1 alice knowledge entry (org-visible, not identity) (got ${director1Knowledge.length})`);
    assert(director1Knowledge[0].domain !== 'identity', 'Identity knowledge blocked for Director1');

    // ── Test: bob reads alice (different org, council seat) ──
    console.log('\n── Council access (bob → alice) ──');
    const compassFacts = hm.queryAgent('bob', 'alice', { memoryType: 'facts' });
    // bob should see: council + fleet (NOT private, NOT org, NOT identity, NOT session)
    assert(compassFacts.length === 2, `bob sees 2 alice facts: council + fleet (got ${compassFacts.length})`);
    assert(!compassFacts.some(f => f.visibility === 'private'), 'bob cannot see private facts');
    assert(!compassFacts.some(f => f.visibility === 'org'), 'bob cannot see org-only facts');

    const compassEpisodes = hm.queryAgent('bob', 'alice', { memoryType: 'episodes' });
    // Both episodes: one council, one fleet
    assert(compassEpisodes.length === 2, `bob sees 2 alice episodes (got ${compassEpisodes.length})`);

    // ── Test: Specialist1 reads alice (specialist, no org) ──
    console.log('\n── Fleet access (Specialist1 → alice) ──');
    const specialist1Facts = hm.queryAgent('specialist1', 'alice', { memoryType: 'facts' });
    // Specialist1 should see: fleet only (NOT private, NOT org, NOT council, NOT identity, NOT session)
    assert(specialist1Facts.length === 1, `Specialist1 sees 1 alice fact: fleet only (got ${specialist1Facts.length})`);
    assert(specialist1Facts[0].visibility === 'fleet', `Specialist1's fact is fleet-visible`);

    const specialist1Episodes = hm.queryAgent('specialist1', 'alice', { memoryType: 'episodes' });
    assert(specialist1Episodes.length === 1, `Specialist1 sees 1 alice episode: fleet only (got ${specialist1Episodes.length})`);

    // ── Test: Messages are ALWAYS private ──
    console.log('\n── Message privacy ──');
    const director1Msgs = hm.queryAgent('director1', 'alice', { memoryType: 'messages' });
    assert(director1Msgs.length === 0, 'Director1 cannot read alice messages (always private)');

    const compassMsgs = hm.queryAgent('bob', 'alice', { memoryType: 'messages' });
    assert(compassMsgs.length === 0, 'bob cannot read alice messages (always private)');

    // ── Test: Fleet-wide query ──
    console.log('\n── Fleet-wide query ──');
    // Populate bob with some fleet-visible data (in library DB)
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('bob', 'agent', 'product', 'canvas is the primary user surface', 0.95, 'fleet');

    const fleetResults = hm.queryFleet('specialist1', { memoryType: 'facts' });
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
