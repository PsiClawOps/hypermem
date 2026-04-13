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

  const pref1 = hm.setPreference('ragesaq', 'coding_style', 'Prefers architecture over speed, comprehensive and explicit', {
    domain: 'development',
    agentId: 'agent1',
    confidence: 0.95,
  });
  assert(pref1.subject === 'ragesaq', 'Preference created');
  assert(pref1.key === 'coding_style', `Key: ${pref1.key}`);

  hm.setPreference('ragesaq', 'timezone', 'MST (Arizona, no DST)', {
    domain: 'personal',
    agentId: 'agent2',
  });

  hm.setPreference('ragesaq', 'communication', 'Direct, no hedging, no corporate speak', {
    domain: 'personal',
    agentId: 'agent4',
  });

  const prefs = hm.getPreferences('ragesaq');
  assert(prefs.length === 3, `All preferences: ${prefs.length}`);

  const tzPref = hm.getPreference('ragesaq', 'timezone', 'personal');
  assert(tzPref !== null, 'Get specific preference');
  assert(tzPref.value.includes('MST'), `Timezone value: ${tzPref.value}`);

  // Update a preference (upsert)
  hm.setPreference('ragesaq', 'coding_style', 'Architecture > speed, explicit > implicit, automation-first', {
    domain: 'development',
    agentId: 'agent1',
    confidence: 0.98,
  });
  const updated = hm.getPreference('ragesaq', 'coding_style', 'development');
  assert(updated.value.includes('automation-first'), 'Preference updated via upsert');
  assert(updated.confidence === 0.98, `Confidence updated: ${updated.confidence}`);

  // ── Fleet Registry ──
  console.log('\n── Fleet Registry ──');

  const agent1 = hm.upsertFleetAgent('agent1', {
    displayName: 'agent1',
    tier: 'council',
    orgId: 'agent1-org',
    domains: ['infrastructure', 'architecture', 'reliability'],
    metadata: { role: 'Infrastructure seat' },
  });
  assert(agent1.id === 'agent1', 'Fleet agent registered');
  assert(agent1.tier === 'council', `Tier: ${agent1.tier}`);
  assert(agent1.domains.includes('infrastructure'), 'Domains set');

  hm.upsertFleetAgent('pylon', {
    displayName: 'Pylon',
    tier: 'director',
    orgId: 'agent1-org',
    reportsTo: 'agent1',
    domains: ['infrastructure', 'clawtext'],
  });

  hm.upsertFleetAgent('agent2', {
    displayName: 'agent2',
    tier: 'council',
    orgId: 'agent2-org',
    domains: ['product', 'strategy'],
  });

  const org = hm.upsertFleetOrg('agent1-org', {
    name: 'Infrastructure Org',
    leadAgentId: 'agent1',
    mission: 'Build and run the platform the fleet depends on',
  });
  assert(org.id === 'agent1-org', 'Org registered');
  assert(org.leadAgentId === 'agent1', `Lead: ${org.leadAgentId}`);

  hm.upsertFleetOrg('agent2-org', {
    name: 'Product Org',
    leadAgentId: 'agent2',
    mission: 'Ship great products',
  });

  const allAgents = hm.listFleetAgents();
  assert(allAgents.length === 3, `Total agents: ${allAgents.length}`);

  const councilAgents = hm.listFleetAgents({ tier: 'council' });
  assert(councilAgents.length === 2, `Council agents: ${councilAgents.length}`);

  const orgs = hm.listFleetOrgs();
  assert(orgs.length === 2, `Orgs: ${orgs.length}`);

  const forgeAgent = hm.getFleetAgent('agent1');
  assert(forgeAgent.metadata.role === 'Infrastructure seat', 'Metadata preserved');

  // ── System Registry ──
  console.log('\n── System Registry ──');

  const redisState = hm.setSystemState('service', 'redis', {
    status: 'running',
    port: 6379,
    version: '7.0.15',
  }, { updatedBy: 'agent1' });
  assert(redisState.category === 'service', 'System state set');
  assert(redisState.value.status === 'running', `Redis status: ${redisState.value.status}`);

  hm.setSystemState('service', 'ollama', {
    status: 'running',
    models: ['nomic-embed-text'],
    gpu: false,
  }, { updatedBy: 'agent1' });

  hm.setSystemState('flag', 'reboot_needed', {
    value: false,
    reason: null,
  }, { updatedBy: 'vigil' });

  const services = hm.getSystemCategory('service');
  assert(services.length === 2, `Services: ${services.length}`);

  const redis = hm.getSystemState('service', 'redis');
  assert(redis.value.version === '7.0.15', `Redis version: ${redis.value.version}`);

  // Update state (should record change event)
  hm.setSystemState('service', 'redis', {
    status: 'running',
    port: 6379,
    version: '7.2.0',
  }, { updatedBy: 'pylon' });

  const updatedRedis = hm.getSystemState('service', 'redis');
  assert(updatedRedis.value.version === '7.2.0', 'State updated');

  // TTL test
  hm.setSystemState('flag', 'temp_flag', { active: true }, {
    updatedBy: 'agent1',
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
    agentId: 'agent1',
    createdBy: 'ragesaq',
    domain: 'infrastructure',
  });
  assert(wi1.id.startsWith('WQ-'), `Work item created: ${wi1.id}`);
  assert(wi1.status === 'incoming', `Initial status: ${wi1.status}`);
  assert(wi1.priority === 1, `Priority: ${wi1.priority}`);

  const wi2 = hm.createWorkItem({
    title: 'Build Redis registry cache layer',
    priority: 2,
    agentId: 'agent1',
    createdBy: 'agent1',
    domain: 'infrastructure',
  });

  const wi3 = hm.createWorkItem({
    title: 'Design knowledge graph schema',
    priority: 3,
    agentId: 'agent2',
    createdBy: 'ragesaq',
    domain: 'product',
  });

  // Status transitions
  const started = hm.updateWorkStatus(wi1.id, 'active', 'agent1', 'Starting restructure');
  assert(started.status === 'active', 'Work item started');
  assert(started.startedAt !== null, 'start time recorded');

  const completed = hm.updateWorkStatus(wi1.id, 'completed', 'agent1', 'Restructure done, 85 tests passing');
  assert(completed.status === 'completed', 'Work item completed');
  assert(completed.completedAt !== null, 'completion time recorded');

  hm.updateWorkStatus(wi2.id, 'active', 'agent1');

  // Kanban views
  const kanban = hm.getFleetKanban();
  assert(kanban.length === 2, `Fleet kanban: ${kanban.length} items (excludes completed)`);

  const forgeWork = hm.getAgentWork('agent1');
  assert(forgeWork.length === 1, `agent1 active work: ${forgeWork.length}`);

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
  const skillCap = hm.upsertCapability('agent1', {
    capType: 'skill',
    name: 'skill-vetter',
    version: '1.0.0',
    source: 'clawhub',
  });
  assert(skillCap.capType === 'skill', 'Skill capability registered');
  assert(skillCap.name === 'skill-vetter', `Skill name: ${skillCap.name}`);
  assert(skillCap.version === '1.0.0', `Skill version: ${skillCap.version}`);

  hm.upsertCapability('agent1', {
    capType: 'tool',
    name: 'exec',
    config: { scopes: ['sandbox', 'host'] },
  });

  hm.upsertCapability('agent1', {
    capType: 'tool',
    name: 'web_search',
    config: { provider: 'brave' },
  });

  hm.upsertCapability('agent1', {
    capType: 'mcp_server',
    name: 'filesystem',
    config: { transport: 'stdio' },
  });

  hm.upsertCapability('agent2', {
    capType: 'tool',
    name: 'web_search',
    config: { provider: 'brave' },
  });

  hm.upsertCapability('agent2', {
    capType: 'skill',
    name: 'product-research',
    version: '0.2.0',
    source: 'local',
  });

  // Query capabilities
  const forgeCaps = hm.getAgentCapabilities('agent1');
  assert(forgeCaps.length === 4, `agent1 capabilities: ${forgeCaps.length}`);

  const forgeSkills = hm.getAgentCapabilities('agent1', 'skill');
  assert(forgeSkills.length === 1, `agent1 skills: ${forgeSkills.length}`);

  const forgeTools = hm.getAgentCapabilities('agent1', 'tool');
  assert(forgeTools.length === 2, `agent1 tools: ${forgeTools.length}`);

  // Find agents by capability
  const webSearchAgents = hm.findAgentsByCapability('tool', 'web_search');
  assert(webSearchAgents.length === 2, `Agents with web_search: ${webSearchAgents.length}`);

  const vetterAgents = hm.findAgentsByCapability('skill', 'skill-vetter');
  assert(vetterAgents.length === 1, `Agents with skill-vetter: ${vetterAgents.length}`);
  assert(vetterAgents[0].id === 'agent1', `Vetter agent: ${vetterAgents[0].id}`);

  // Denormalized capabilities on FleetAgent
  const forgeWithCaps = hm.getFleetAgent('agent1');
  assert(forgeWithCaps.capabilities !== null, 'Fleet agent has capabilities JSON');
  assert(forgeWithCaps.capabilities.length === 4, `Denormalized caps: ${forgeWithCaps.capabilities.length}`);

  // Bulk sync (should mark missing ones as removed)
  hm.syncCapabilities('agent1', 'tool', [
    { name: 'exec', config: { scopes: ['sandbox'] } },
    { name: 'image', config: { provider: 'anthropic' } },
  ]);

  const afterSync = hm.getAgentCapabilities('agent1', 'tool');
  assert(afterSync.length === 2, `Tools after sync: ${afterSync.length} (exec + image, web_search removed)`);
  const toolNames = afterSync.map(c => c.name).sort();
  assert(toolNames[0] === 'exec' && toolNames[1] === 'image', `Tool names: ${toolNames.join(', ')}`);

  // ── Agent Desired State ──
  console.log('\n── Agent Desired State ──');

  // Set desired config for agent1
  const modelState = hm.setDesiredState('agent1', 'model', 'anthropic/claude-opus-4-6', {
    source: 'operator',
    setBy: 'ragesaq',
    notes: 'Moved to anthropic direct — copilot-local had issues',
  });
  assert(modelState.configKey === 'model', 'Desired state set');
  assert(modelState.desiredValue === 'anthropic/claude-opus-4-6', `Desired model: ${modelState.desiredValue}`);
  assert(modelState.driftStatus === 'unknown', `Initial drift: ${modelState.driftStatus}`);

  hm.setDesiredState('agent1', 'thinkingDefault', 'high', { setBy: 'ragesaq' });
  hm.setDesiredState('agent1', 'provider', 'anthropic', { setBy: 'ragesaq' });
  hm.setDesiredState('agent1', 'tools.exec.host', 'sandbox', { setBy: 'ragesaq' });

  // Set desired config for agent2
  hm.setDesiredState('agent2', 'model', 'anthropic/claude-opus-4-6', { setBy: 'ragesaq' });
  hm.setDesiredState('agent2', 'thinkingDefault', 'high', { setBy: 'ragesaq' });

  // Get all config for an agent
  const forgeConfig = hm.getDesiredConfig('agent1');
  assert(Object.keys(forgeConfig).length === 4, `agent1 config keys: ${Object.keys(forgeConfig).length}`);
  assert(forgeConfig.model === 'anthropic/claude-opus-4-6', 'Config map works');

  // Report actual state — matches desired (no drift)
  const okDrift = hm.reportActualState('agent1', 'model', 'anthropic/claude-opus-4-6');
  assert(okDrift === 'ok', `Matching model drift: ${okDrift}`);

  // Report actual state — differs from desired (drift!)
  const driftedResult = hm.reportActualState('agent1', 'thinkingDefault', 'medium');
  assert(driftedResult === 'drifted', `Mismatched thinking drift: ${driftedResult}`);

  // Bulk report
  const bulkDrift = hm.reportActualStateBulk('agent2', {
    model: 'anthropic/claude-opus-4-6',
    thinkingDefault: 'low',
  });
  assert(bulkDrift.model === 'ok', `agent2 model: ${bulkDrift.model}`);
  assert(bulkDrift.thinkingDefault === 'drifted', `agent2 thinking: ${bulkDrift.thinkingDefault}`);

  // Fleet-wide drift view
  const drifted = hm.getDriftedState();
  assert(drifted.length === 2, `Drifted entries: ${drifted.length} (agent1 thinking + agent2 thinking)`);

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
  hm.setDesiredState('agent1', 'model', 'anthropic/claude-sonnet-4-6', { setBy: 'ragesaq' });
  const history = hm.getConfigHistory('agent1', 'model');
  assert(history.length === 2, `History events: ${history.length} (set + changed)`);
  assert(history[0].eventType === 'desired_changed', `Latest event: ${history[0].eventType}`);

  // ── Facts via Facade ──
  console.log('\n── Facts via Facade ──');

  const fact = hm.addFact('agent1', 'Redis 7.0.15 is running on the host', {
    domain: 'infrastructure',
    visibility: 'fleet',
    sourceSessionKey: 'agent:agent1:webchat:main',
  });
  assert(fact.agentId === 'agent1', 'Fact added via facade');

  const facts = hm.getActiveFacts('agent1');
  assert(facts.length === 1, `Active facts: ${facts.length}`);

  // ── Knowledge via Facade ──
  console.log('\n── Knowledge via Facade ──');

  hm.upsertKnowledge('agent1', 'architecture', 'memory-layers',
    'L1 Redis, L2 messages.db, L3 vectors.db, L4 library.db');
  const knowledge = hm.getKnowledge('agent1');
  assert(knowledge.length === 1, `Knowledge entries: ${knowledge.length}`);

  // ── Topics via Facade ──
  console.log('\n── Topics via Facade ──');

  hm.createTopic('agent1', 'HyperMem Architecture', 'Four-layer memory architecture design');
  const topics = hm.getActiveTopics('agent1');
  assert(topics.length === 1, `Active topics: ${topics.length}`);

  // ── Episodes via Facade ──
  console.log('\n── Episodes via Facade ──');

  hm.recordEpisode('agent1', 'architecture', 'Redesigned HyperMem to three-file split', {
    significance: 0.9,
    visibility: 'council',
    participants: ['agent1', 'ragesaq'],
    sessionKey: 'agent:agent1:webchat:main',
  });
  const episodes = hm.getRecentEpisodes('agent1');
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
