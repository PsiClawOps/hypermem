/**
 * Library collections test.
 *
 * Tests all library DB collections:
 * - Preferences (behavioral patterns)
 * - Fleet registry (agents, orgs)
 * - System registry (state, events)
 * - Work items (fleet kanban)
 * - Facts via facade
 * - Knowledge via facade
 * - Episodes via facade
 * - Topics via facade
 */

import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-library-'));

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
  console.log('  HyperMem Library Collections Test');
  console.log('═══════════════════════════════════════════════════\n');

  let hm;
  try {
    hm = await HyperMem.create({
      dataDir: tmpDir,
    });
  } catch (err) {
    console.log(`  ❌ Failed to create HyperMem: ${err.message}`);
    process.exit(1);
  }

  // ── Preferences ──
  console.log('── Preferences ──');

  const pref1 = hm.setPreference('operator', 'coding_style', 'Prefers architecture over speed, comprehensive and explicit', {
    domain: 'development',
    agentId: 'alice',
    confidence: 0.95,
  });
  assert(pref1.subject === 'operator', 'Preference created');
  assert(pref1.key === 'coding_style', `Key: ${pref1.key}`);

  hm.setPreference('operator', 'timezone', 'MST (Arizona, no DST)', {
    domain: 'personal',
    agentId: 'bob',
  });

  hm.setPreference('operator', 'communication', 'Direct, no hedging, no corporate speak', {
    domain: 'personal',
    agentId: 'agent4',
  });

  const prefs = hm.getPreferences('operator');
  assert(prefs.length === 3, `All preferences: ${prefs.length}`);

  const tzPref = hm.getPreference('operator', 'timezone', 'personal');
  assert(tzPref !== null, 'Get specific preference');
  assert(tzPref.value.includes('MST'), `Timezone value: ${tzPref.value}`);

  // Update a preference (upsert)
  hm.setPreference('operator', 'coding_style', 'Architecture > speed, explicit > implicit, automation-first', {
    domain: 'development',
    agentId: 'alice',
    confidence: 0.98,
  });
  const updated = hm.getPreference('operator', 'coding_style', 'development');
  assert(updated.value.includes('automation-first'), 'Preference updated via upsert');
  assert(updated.confidence === 0.98, `Confidence updated: ${updated.confidence}`);

  // ── Fleet Registry ──
  console.log('\n── Fleet Registry ──');

  const alice = hm.upsertFleetAgent('alice', {
    displayName: 'alice',
    tier: 'council',
    orgId: 'alice-org',
    domains: ['infrastructure', 'architecture', 'reliability'],
    metadata: { role: 'Infrastructure seat' },
  });
  assert(alice.id === 'alice', 'Fleet agent registered');
  assert(alice.tier === 'council', `Tier: ${alice.tier}`);
  assert(alice.domains.includes('infrastructure'), 'Domains set');

  hm.upsertFleetAgent('director1', {
    displayName: 'Director1',
    tier: 'director',
    orgId: 'alice-org',
    reportsTo: 'alice',
    domains: ['infrastructure', 'clawtext'],
  });

  hm.upsertFleetAgent('bob', {
    displayName: 'bob',
    tier: 'council',
    orgId: 'bob-org',
    domains: ['product', 'strategy'],
  });

  const org = hm.upsertFleetOrg('alice-org', {
    name: 'Infrastructure Org',
    leadAgentId: 'alice',
    mission: 'Build and run the platform the fleet depends on',
  });
  assert(org.id === 'alice-org', 'Org registered');
  assert(org.leadAgentId === 'alice', `Lead: ${org.leadAgentId}`);

  hm.upsertFleetOrg('bob-org', {
    name: 'Product Org',
    leadAgentId: 'bob',
    mission: 'Ship great products',
  });

  const allAgents = hm.listFleetAgents();
  assert(allAgents.length === 3, `Total agents: ${allAgents.length}`);

  const councilAgents = hm.listFleetAgents({ tier: 'council' });
  assert(councilAgents.length === 2, `Council agents: ${councilAgents.length}`);

  const orgs = hm.listFleetOrgs();
  assert(orgs.length === 2, `Orgs: ${orgs.length}`);

  const forgeAgent = hm.getFleetAgent('alice');
  assert(forgeAgent.metadata.role === 'Infrastructure seat', 'Metadata preserved');

  // ── System Registry ──
  console.log('\n── System Registry ──');

  const redisState = hm.setSystemState('service', 'redis', {
    status: 'running',
    port: 6379,
    version: '7.0.15',
  }, { updatedBy: 'alice' });
  assert(redisState.category === 'service', 'System state set');
  assert(redisState.value.status === 'running', `Redis status: ${redisState.value.status}`);

  hm.setSystemState('service', 'ollama', {
    status: 'running',
    models: ['nomic-embed-text'],
    gpu: false,
  }, { updatedBy: 'alice' });

  hm.setSystemState('flag', 'reboot_needed', {
    value: false,
    reason: null,
  }, { updatedBy: 'director2' });

  const services = hm.getSystemCategory('service');
  assert(services.length === 2, `Services: ${services.length}`);

  const redis = hm.getSystemState('service', 'redis');
  assert(redis.value.version === '7.0.15', `Redis version: ${redis.value.version}`);

  // Update state (should record change event)
  hm.setSystemState('service', 'redis', {
    status: 'running',
    port: 6379,
    version: '7.2.0',
  }, { updatedBy: 'director1' });

  const updatedRedis = hm.getSystemState('service', 'redis');
  assert(updatedRedis.value.version === '7.2.0', 'State updated');

  // TTL test
  hm.setSystemState('flag', 'temp_flag', { active: true }, {
    updatedBy: 'alice',
    ttl: new Date(Date.now() - 1000).toISOString(), // already expired
  });
  const expired = hm.getSystemState('flag', 'temp_flag');
  assert(expired === null, 'Expired TTL state returns null');

  // ── Work Items ──
  console.log('\n── Work Items ──');

  const wi1 = hm.createWorkItem({
    title: 'Restructure DatabaseManager for three-file split',
    description: 'messages.db + vectors.db per agent, library.db fleet-wide',
    priority: 1,
    agentId: 'alice',
    createdBy: 'operator',
    domain: 'infrastructure',
  });
  assert(wi1.id.startsWith('WQ-'), `Work item created: ${wi1.id}`);
  assert(wi1.status === 'incoming', `Initial status: ${wi1.status}`);
  assert(wi1.priority === 1, `Priority: ${wi1.priority}`);

  const wi2 = hm.createWorkItem({
    title: 'Build Redis registry cache layer',
    priority: 2,
    agentId: 'alice',
    createdBy: 'alice',
    domain: 'infrastructure',
  });

  const wi3 = hm.createWorkItem({
    title: 'Design knowledge graph schema',
    priority: 3,
    agentId: 'bob',
    createdBy: 'operator',
    domain: 'product',
  });

  // Status transitions
  const started = hm.updateWorkStatus(wi1.id, 'active', 'alice', 'Starting restructure');
  assert(started.status === 'active', 'Work item started');
  assert(started.startedAt !== null, 'start time recorded');

  const completed = hm.updateWorkStatus(wi1.id, 'completed', 'alice', 'Restructure done, 85 tests passing');
  assert(completed.status === 'completed', 'Work item completed');
  assert(completed.completedAt !== null, 'completion time recorded');

  hm.updateWorkStatus(wi2.id, 'active', 'alice');

  // Kanban views
  const kanban = hm.getFleetKanban();
  assert(kanban.length === 2, `Fleet kanban: ${kanban.length} items (excludes completed)`);

  const forgeWork = hm.getAgentWork('alice');
  assert(forgeWork.length === 1, `alice active work: ${forgeWork.length}`);

  // Stats
  const stats = hm.getWorkStats();
  assert(stats.completed === 1, `Completed: ${stats.completed}`);
  assert(stats.active === 1, `Active: ${stats.active}`);
  assert(stats.incoming === 1, `Incoming: ${stats.incoming}`);

  // Blocked items
  const blocked = hm.getBlockedWork();
  assert(blocked.length === 0, 'No blocked items');

  // ── Agent Capabilities ──
  console.log('\n── Agent Capabilities ──');

  // Register individual capabilities
  const skillCap = hm.upsertCapability('alice', {
    capType: 'skill',
    name: 'skill-vetter',
    version: '1.0.0',
    source: 'clawhub',
  });
  assert(skillCap.capType === 'skill', 'Skill capability registered');
  assert(skillCap.name === 'skill-vetter', `Skill name: ${skillCap.name}`);
  assert(skillCap.version === '1.0.0', `Skill version: ${skillCap.version}`);

  hm.upsertCapability('alice', {
    capType: 'tool',
    name: 'exec',
    config: { scopes: ['sandbox', 'host'] },
  });

  hm.upsertCapability('alice', {
    capType: 'tool',
    name: 'web_search',
    config: { provider: 'brave' },
  });

  hm.upsertCapability('alice', {
    capType: 'mcp_server',
    name: 'filesystem',
    config: { transport: 'stdio' },
  });

  hm.upsertCapability('bob', {
    capType: 'tool',
    name: 'web_search',
    config: { provider: 'brave' },
  });

  hm.upsertCapability('bob', {
    capType: 'skill',
    name: 'product-research',
    version: '0.2.0',
    source: 'local',
  });

  // Query capabilities
  const forgeCaps = hm.getAgentCapabilities('alice');
  assert(forgeCaps.length === 4, `alice capabilities: ${forgeCaps.length}`);

  const forgeSkills = hm.getAgentCapabilities('alice', 'skill');
  assert(forgeSkills.length === 1, `alice skills: ${forgeSkills.length}`);

  const forgeTools = hm.getAgentCapabilities('alice', 'tool');
  assert(forgeTools.length === 2, `alice tools: ${forgeTools.length}`);

  // Find agents by capability
  const webSearchAgents = hm.findAgentsByCapability('tool', 'web_search');
  assert(webSearchAgents.length === 2, `Agents with web_search: ${webSearchAgents.length}`);

  const vetterAgents = hm.findAgentsByCapability('skill', 'skill-vetter');
  assert(vetterAgents.length === 1, `Agents with skill-vetter: ${vetterAgents.length}`);
  assert(vetterAgents[0].id === 'alice', `Vetter agent: ${vetterAgents[0].id}`);

  // Denormalized capabilities on FleetAgent
  const forgeWithCaps = hm.getFleetAgent('alice');
  assert(forgeWithCaps.capabilities !== null, 'Fleet agent has capabilities JSON');
  assert(forgeWithCaps.capabilities.length === 4, `Denormalized caps: ${forgeWithCaps.capabilities.length}`);

  // Bulk sync (should mark missing ones as removed)
  hm.syncCapabilities('alice', 'tool', [
    { name: 'exec', config: { scopes: ['sandbox'] } },
    { name: 'image', config: { provider: 'anthropic' } },
  ]);

  const afterSync = hm.getAgentCapabilities('alice', 'tool');
  assert(afterSync.length === 2, `Tools after sync: ${afterSync.length} (exec + image, web_search removed)`);
  const toolNames = afterSync.map(c => c.name).sort();
  assert(toolNames[0] === 'exec' && toolNames[1] === 'image', `Tool names: ${toolNames.join(', ')}`);

  // ── Agent Desired State ──
  console.log('\n── Agent Desired State ──');

  // Set desired config for alice
  const modelState = hm.setDesiredState('alice', 'model', 'anthropic/claude-opus-4-6', {
    source: 'operator',
    setBy: 'operator',
    notes: 'Moved to anthropic direct — copilot-local had issues',
  });
  assert(modelState.configKey === 'model', 'Desired state set');
  assert(modelState.desiredValue === 'anthropic/claude-opus-4-6', `Desired model: ${modelState.desiredValue}`);
  assert(modelState.driftStatus === 'unknown', `Initial drift: ${modelState.driftStatus}`);

  hm.setDesiredState('alice', 'thinkingDefault', 'high', { setBy: 'operator' });
  hm.setDesiredState('alice', 'provider', 'anthropic', { setBy: 'operator' });
  hm.setDesiredState('alice', 'tools.exec.host', 'sandbox', { setBy: 'operator' });

  // Set desired config for bob
  hm.setDesiredState('bob', 'model', 'anthropic/claude-opus-4-6', { setBy: 'operator' });
  hm.setDesiredState('bob', 'thinkingDefault', 'high', { setBy: 'operator' });

  // Get all config for an agent
  const forgeConfig = hm.getDesiredConfig('alice');
  assert(Object.keys(forgeConfig).length === 4, `alice config keys: ${Object.keys(forgeConfig).length}`);
  assert(forgeConfig.model === 'anthropic/claude-opus-4-6', 'Config map works');

  // Report actual state — matches desired (no drift)
  const okDrift = hm.reportActualState('alice', 'model', 'anthropic/claude-opus-4-6');
  assert(okDrift === 'ok', `Matching model drift: ${okDrift}`);

  // Report actual state — differs from desired (drift!)
  const driftedResult = hm.reportActualState('alice', 'thinkingDefault', 'medium');
  assert(driftedResult === 'drifted', `Mismatched thinking drift: ${driftedResult}`);

  // Bulk report
  const bulkDrift = hm.reportActualStateBulk('bob', {
    model: 'anthropic/claude-opus-4-6',
    thinkingDefault: 'low',
  });
  assert(bulkDrift.model === 'ok', `bob model: ${bulkDrift.model}`);
  assert(bulkDrift.thinkingDefault === 'drifted', `bob thinking: ${bulkDrift.thinkingDefault}`);

  // Fleet-wide drift view
  const drifted = hm.getDriftedState();
  assert(drifted.length === 2, `Drifted entries: ${drifted.length} (alice thinking + bob thinking)`);

  // Fleet-wide config key view
  const fleetModels = hm.getFleetConfigKey('model');
  assert(fleetModels.length === 2, `Fleet model entries: ${fleetModels.length}`);

  // Drift summary
  const summary = hm.getDriftSummary();
  assert(summary.ok === 2, `OK: ${summary.ok}`);
  assert(summary.drifted === 2, `Drifted: ${summary.drifted}`);
  assert(summary.unknown === 2, `Unknown: ${summary.unknown}`);
  assert(summary.total === 6, `Total: ${summary.total}`);

  // Update desired state and verify history
  hm.setDesiredState('alice', 'model', 'anthropic/claude-sonnet-4-6', { setBy: 'operator' });
  const history = hm.getConfigHistory('alice', 'model');
  assert(history.length === 2, `History events: ${history.length} (set + changed)`);
  assert(history[0].eventType === 'desired_changed', `Latest event: ${history[0].eventType}`);

  // ── Facts via Facade ──
  console.log('\n── Facts via Facade ──');

  const fact = hm.addFact('alice', 'Redis 7.0.15 is running on the host', {
    domain: 'infrastructure',
    visibility: 'fleet',
    sourceSessionKey: 'agent:alice:webchat:main',
  });
  assert(fact.agentId === 'alice', 'Fact added via facade');

  const facts = hm.getActiveFacts('alice');
  assert(facts.length === 1, `Active facts: ${facts.length}`);

  // ── Knowledge via Facade ──
  console.log('\n── Knowledge via Facade ──');

  hm.upsertKnowledge('alice', 'architecture', 'memory-layers',
    'L1 Redis, L2 messages.db, L3 vectors.db, L4 library.db');
  const knowledge = hm.getKnowledge('alice');
  assert(knowledge.length === 1, `Knowledge entries: ${knowledge.length}`);

  // ── Topics via Facade ──
  console.log('\n── Topics via Facade ──');

  hm.createTopic('alice', 'HyperMem Architecture', 'Four-layer memory architecture design');
  const topics = hm.getActiveTopics('alice');
  assert(topics.length === 1, `Active topics: ${topics.length}`);

  // ── Episodes via Facade ──
  console.log('\n── Episodes via Facade ──');

  hm.recordEpisode('alice', 'architecture', 'Redesigned HyperMem to three-file split', {
    significance: 0.9,
    visibility: 'council',
    participants: ['alice', 'operator'],
    sessionKey: 'agent:alice:webchat:main',
  });
  const episodes = hm.getRecentEpisodes('alice');
  assert(episodes.length === 1, `Recent episodes: ${episodes.length}`);

  // ── Cleanup ──
  console.log('\n── Cleanup ──');
  await hm.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert(true, 'Cleaned up');

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
