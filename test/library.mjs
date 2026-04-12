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
      redis: { host: 'localhost', port: 6379, keyPrefix: 'hm-library:', sessionTTL: 60 },
    });
    await hm.redis.flushPrefix();
  } catch (err) {
    console.log(`  ❌ Failed to create HyperMem: ${err.message}`);
    process.exit(1);
  }

  // ── Preferences ──
  console.log('── Preferences ──');

  const pref1 = hm.setPreference('testuser', 'coding_style', 'Prefers architecture over speed, comprehensive and explicit', {
    domain: 'development',
    agentId: 'agent-alpha',
    confidence: 0.95,
  });
  assert(pref1.subject === 'testuser', 'Preference created');
  assert(pref1.key === 'coding_style', `Key: ${pref1.key}`);

  hm.setPreference('testuser', 'timezone', 'MST (Arizona, no DST)', {
    domain: 'personal',
    agentId: 'agent-beta',
  });

  hm.setPreference('testuser', 'communication', 'Direct, no hedging, no corporate speak', {
    domain: 'personal',
    agentId: 'agent-zeta',
  });

  const prefs = hm.getPreferences('testuser');
  assert(prefs.length === 3, `All preferences: ${prefs.length}`);

  const tzPref = hm.getPreference('testuser', 'timezone', 'personal');
  assert(tzPref !== null, 'Get specific preference');
  assert(tzPref.value.includes('MST'), `Timezone value: ${tzPref.value}`);

  // Update a preference (upsert)
  hm.setPreference('testuser', 'coding_style', 'Architecture > speed, explicit > implicit, automation-first', {
    domain: 'development',
    agentId: 'agent-alpha',
    confidence: 0.98,
  });
  const updated = hm.getPreference('testuser', 'coding_style', 'development');
  assert(updated.value.includes('automation-first'), 'Preference updated via upsert');
  assert(updated.confidence === 0.98, `Confidence updated: ${updated.confidence}`);

  // ── Fleet Registry ──
  console.log('\n── Fleet Registry ──');

  const agentAlpha = hm.upsertFleetAgent('agent-alpha', {
    displayName: 'Agent Alpha',
    tier: 'council',
    orgId: 'alpha-org',
    domains: ['infrastructure', 'architecture', 'reliability'],
    metadata: { role: 'Infrastructure seat' },
  });
  assert(agentAlpha.id === 'agent-alpha', 'Fleet agent registered');
  assert(agentAlpha.tier === 'council', `Tier: ${agentAlpha.tier}`);
  assert(agentAlpha.domains.includes('infrastructure'), 'Domains set');

  hm.upsertFleetAgent('agent-gamma', {
    displayName: 'Agent Gamma',
    tier: 'director',
    orgId: 'alpha-org',
    reportsTo: 'agent-alpha',
    domains: ['infrastructure', 'clawtext'],
  });

  hm.upsertFleetAgent('agent-beta', {
    displayName: 'Agent Beta',
    tier: 'council',
    orgId: 'beta-org',
    domains: ['product', 'strategy'],
  });

  const org = hm.upsertFleetOrg('alpha-org', {
    name: 'Infrastructure Org',
    leadAgentId: 'agent-alpha',
    mission: 'Build and run the platform the fleet depends on',
  });
  assert(org.id === 'alpha-org', 'Org registered');
  assert(org.leadAgentId === 'agent-alpha', `Lead: ${org.leadAgentId}`);

  hm.upsertFleetOrg('beta-org', {
    name: 'Product Org',
    leadAgentId: 'agent-beta',
    mission: 'Ship great products',
  });

  const allAgents = hm.listFleetAgents();
  assert(allAgents.length === 3, `Total agents: ${allAgents.length}`);

  const councilAgents = hm.listFleetAgents({ tier: 'council' });
  assert(councilAgents.length === 2, `Council agents: ${councilAgents.length}`);

  const orgs = hm.listFleetOrgs();
  assert(orgs.length === 2, `Orgs: ${orgs.length}`);

  const alphaAgent = hm.getFleetAgent('agent-alpha');
  assert(alphaAgent.metadata.role === 'Infrastructure seat', 'Metadata preserved');

  // ── System Registry ──
  console.log('\n── System Registry ──');

  const redisState = hm.setSystemState('service', 'redis', {
    status: 'running',
    port: 6379,
    version: '7.0.15',
  }, { updatedBy: 'agent-alpha' });
  assert(redisState.category === 'service', 'System state set');
  assert(redisState.value.status === 'running', `Redis status: ${redisState.value.status}`);

  hm.setSystemState('service', 'ollama', {
    status: 'running',
    models: ['nomic-embed-text'],
    gpu: false,
  }, { updatedBy: 'agent-alpha' });

  hm.setSystemState('flag', 'reboot_needed', {
    value: false,
    reason: null,
  }, { updatedBy: 'agent-eta' });

  const services = hm.getSystemCategory('service');
  assert(services.length === 2, `Services: ${services.length}`);

  const redis = hm.getSystemState('service', 'redis');
  assert(redis.value.version === '7.0.15', `Redis version: ${redis.value.version}`);

  // Update state (should record change event)
  hm.setSystemState('service', 'redis', {
    status: 'running',
    port: 6379,
    version: '7.2.0',
  }, { updatedBy: 'agent-gamma' });

  const updatedRedis = hm.getSystemState('service', 'redis');
  assert(updatedRedis.value.version === '7.2.0', 'State updated');

  // TTL test
  hm.setSystemState('flag', 'temp_flag', { active: true }, {
    updatedBy: 'agent-alpha',
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
    agentId: 'agent-alpha',
    createdBy: 'testuser',
    domain: 'infrastructure',
  });
  assert(wi1.id.startsWith('WQ-'), `Work item created: ${wi1.id}`);
  assert(wi1.status === 'incoming', `Initial status: ${wi1.status}`);
  assert(wi1.priority === 1, `Priority: ${wi1.priority}`);

  const wi2 = hm.createWorkItem({
    title: 'Build Redis registry cache layer',
    priority: 2,
    agentId: 'agent-alpha',
    createdBy: 'agent-alpha',
    domain: 'infrastructure',
  });

  const wi3 = hm.createWorkItem({
    title: 'Design knowledge graph schema',
    priority: 3,
    agentId: 'agent-beta',
    createdBy: 'testuser',
    domain: 'product',
  });

  // Status transitions
  const started = hm.updateWorkStatus(wi1.id, 'active', 'agent-alpha', 'Starting restructure');
  assert(started.status === 'active', 'Work item started');
  assert(started.startedAt !== null, 'start time recorded');

  const completed = hm.updateWorkStatus(wi1.id, 'completed', 'agent-alpha', 'Restructure done, 85 tests passing');
  assert(completed.status === 'completed', 'Work item completed');
  assert(completed.completedAt !== null, 'completion time recorded');

  hm.updateWorkStatus(wi2.id, 'active', 'agent-alpha');

  // Kanban views
  const kanban = hm.getFleetKanban();
  assert(kanban.length === 2, `Fleet kanban: ${kanban.length} items (excludes completed)`);

  const alphaWork = hm.getAgentWork('agent-alpha');
  assert(alphaWork.length === 1, `Agent Alpha active work: ${alphaWork.length}`);

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
  const skillCap = hm.upsertCapability('agent-alpha', {
    capType: 'skill',
    name: 'skill-vetter',
    version: '1.0.0',
    source: 'clawhub',
  });
  assert(skillCap.capType === 'skill', 'Skill capability registered');
  assert(skillCap.name === 'skill-vetter', `Skill name: ${skillCap.name}`);
  assert(skillCap.version === '1.0.0', `Skill version: ${skillCap.version}`);

  hm.upsertCapability('agent-alpha', {
    capType: 'tool',
    name: 'exec',
    config: { scopes: ['sandbox', 'host'] },
  });

  hm.upsertCapability('agent-alpha', {
    capType: 'tool',
    name: 'web_search',
    config: { provider: 'brave' },
  });

  hm.upsertCapability('agent-alpha', {
    capType: 'mcp_server',
    name: 'filesystem',
    config: { transport: 'stdio' },
  });

  hm.upsertCapability('agent-beta', {
    capType: 'tool',
    name: 'web_search',
    config: { provider: 'brave' },
  });

  hm.upsertCapability('agent-beta', {
    capType: 'skill',
    name: 'product-research',
    version: '0.2.0',
    source: 'local',
  });

  // Query capabilities
  const alphaCaps = hm.getAgentCapabilities('agent-alpha');
  assert(alphaCaps.length === 4, `Agent Alpha capabilities: ${alphaCaps.length}`);

  const alphaSkills = hm.getAgentCapabilities('agent-alpha', 'skill');
  assert(alphaSkills.length === 1, `Agent Alpha skills: ${alphaSkills.length}`);

  const alphaTools = hm.getAgentCapabilities('agent-alpha', 'tool');
  assert(alphaTools.length === 2, `Agent Alpha tools: ${alphaTools.length}`);

  // Find agents by capability
  const webSearchAgents = hm.findAgentsByCapability('tool', 'web_search');
  assert(webSearchAgents.length === 2, `Agents with web_search: ${webSearchAgents.length}`);

  const vetterAgents = hm.findAgentsByCapability('skill', 'skill-vetter');
  assert(vetterAgents.length === 1, `Agents with skill-vetter: ${vetterAgents.length}`);
  assert(vetterAgents[0].id === 'agent-alpha', `Vetter agent: ${vetterAgents[0].id}`);

  // Denormalized capabilities on FleetAgent
  const alphaWithCaps = hm.getFleetAgent('agent-alpha');
  assert(alphaWithCaps.capabilities !== null, 'Fleet agent has capabilities JSON');
  assert(alphaWithCaps.capabilities.length === 4, `Denormalized caps: ${alphaWithCaps.capabilities.length}`);

  // Bulk sync (should mark missing ones as removed)
  hm.syncCapabilities('agent-alpha', 'tool', [
    { name: 'exec', config: { scopes: ['sandbox'] } },
    { name: 'image', config: { provider: 'anthropic' } },
  ]);

  const afterSync = hm.getAgentCapabilities('agent-alpha', 'tool');
  assert(afterSync.length === 2, `Tools after sync: ${afterSync.length} (exec + image, web_search removed)`);
  const toolNames = afterSync.map(c => c.name).sort();
  assert(toolNames[0] === 'exec' && toolNames[1] === 'image', `Tool names: ${toolNames.join(', ')}`);

  // ── Agent Desired State ──
  console.log('\n── Agent Desired State ──');

  // Set desired config for agent-alpha
  const modelState = hm.setDesiredState('agent-alpha', 'model', 'anthropic/claude-opus-4-6', {
    source: 'operator',
    setBy: 'testuser',
    notes: 'Moved to anthropic direct — copilot-local had issues',
  });
  assert(modelState.configKey === 'model', 'Desired state set');
  assert(modelState.desiredValue === 'anthropic/claude-opus-4-6', `Desired model: ${modelState.desiredValue}`);
  assert(modelState.driftStatus === 'unknown', `Initial drift: ${modelState.driftStatus}`);

  hm.setDesiredState('agent-alpha', 'thinkingDefault', 'high', { setBy: 'testuser' });
  hm.setDesiredState('agent-alpha', 'provider', 'anthropic', { setBy: 'testuser' });
  hm.setDesiredState('agent-alpha', 'tools.exec.host', 'sandbox', { setBy: 'testuser' });

  // Set desired config for agent-beta
  hm.setDesiredState('agent-beta', 'model', 'anthropic/claude-opus-4-6', { setBy: 'testuser' });
  hm.setDesiredState('agent-beta', 'thinkingDefault', 'high', { setBy: 'testuser' });

  // Get all config for an agent
  const alphaConfig = hm.getDesiredConfig('agent-alpha');
  assert(Object.keys(forgeConfig).length === 4, `Agent Alpha config keys: ${Object.keys(forgeConfig).length}`);
  assert(alphaConfig.model === 'anthropic/claude-opus-4-6', 'Config map works');

  // Report actual state — matches desired (no drift)
  const okDrift = hm.reportActualState('agent-alpha', 'model', 'anthropic/claude-opus-4-6');
  assert(okDrift === 'ok', `Matching model drift: ${okDrift}`);

  // Report actual state — differs from desired (drift!)
  const driftedResult = hm.reportActualState('agent-alpha', 'thinkingDefault', 'medium');
  assert(driftedResult === 'drifted', `Mismatched thinking drift: ${driftedResult}`);

  // Bulk report
  const bulkDrift = hm.reportActualStateBulk('agent-beta', {
    model: 'anthropic/claude-opus-4-6',
    thinkingDefault: 'low',
  });
  assert(bulkDrift.model === 'ok', `Agent Beta model: ${bulkDrift.model}`);
  assert(bulkDrift.thinkingDefault === 'drifted', `Agent Beta thinking: ${bulkDrift.thinkingDefault}`);

  // Fleet-wide drift view
  const drifted = hm.getDriftedState();
  assert(drifted.length === 2, `Drifted entries: ${drifted.length} (agent-alpha thinking + agent-beta thinking)`);

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
  hm.setDesiredState('agent-alpha', 'model', 'anthropic/claude-sonnet-4-6', { setBy: 'testuser' });
  const history = hm.getConfigHistory('agent-alpha', 'model');
  assert(history.length === 2, `History events: ${history.length} (set + changed)`);
  assert(history[0].eventType === 'desired_changed', `Latest event: ${history[0].eventType}`);

  // ── Facts via Facade ──
  console.log('\n── Facts via Facade ──');

  const fact = hm.addFact('agent-alpha', 'Redis 7.0.15 is running on the host', {
    domain: 'infrastructure',
    visibility: 'fleet',
    sourceSessionKey: 'agent:agent-alpha:webchat:main',
  });
  assert(fact.agentId === 'agent-alpha', 'Fact added via facade');

  const facts = hm.getActiveFacts('agent-alpha');
  assert(facts.length === 1, `Active facts: ${facts.length}`);

  // ── Knowledge via Facade ──
  console.log('\n── Knowledge via Facade ──');

  hm.upsertKnowledge('agent-alpha', 'architecture', 'memory-layers',
    'L1 Redis, L2 messages.db, L3 vectors.db, L4 library.db');
  const knowledge = hm.getKnowledge('agent-alpha');
  assert(knowledge.length === 1, `Knowledge entries: ${knowledge.length}`);

  // ── Topics via Facade ──
  console.log('\n── Topics via Facade ──');

  hm.createTopic('agent-alpha', 'HyperMem Architecture', 'Four-layer memory architecture design');
  const topics = hm.getActiveTopics('agent-alpha');
  assert(topics.length === 1, `Active topics: ${topics.length}`);

  // ── Episodes via Facade ──
  console.log('\n── Episodes via Facade ──');

  hm.recordEpisode('agent-alpha', 'architecture', 'Redesigned HyperMem to three-file split', {
    significance: 0.9,
    visibility: 'council',
    participants: ['agent-alpha', 'testuser'],
    sessionKey: 'agent:agent-alpha:webchat:main',
  });
  const episodes = hm.getRecentEpisodes('agent-alpha');
  assert(episodes.length === 1, `Recent episodes: ${episodes.length}`);

  // ── Cleanup ──
  console.log('\n── Cleanup ──');
  await hm.redis.flushPrefix();
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
