#!/usr/bin/env node
/**
 * fix-fleet-tiers.mjs
 *
 * One-shot script to fix tier resolution in the fleet registry.
 * Reads IDENTITY.md for each agent workspace and updates the fleet_agents table.
 * Run once after deploying the tier resolution fix.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HYPERMEM_PATH = path.join(os.homedir(), '.openclaw/workspace/repo/hypermem/dist/index.js');
const { HyperMem } = await import(HYPERMEM_PATH);

const hm = await HyperMem.create();

// Known agent registry with workspace paths
const WORKSPACE_BASE_COUNCIL = path.join(os.homedir(), '.openclaw/workspace-council');
const WORKSPACE_BASE_DIRECTOR = path.join(os.homedir(), '.openclaw/workspace-director');
const WORKSPACE_BASE_RESEARCH = path.join(os.homedir(), '.openclaw/workspace-research');
const WORKSPACE_BASE_MAIN = path.join(os.homedir(), '.openclaw/workspace');

const AGENT_WORKSPACES = {
  // Council
  anvil: path.join(WORKSPACE_BASE_COUNCIL, 'anvil'),
  clarity: path.join(WORKSPACE_BASE_COUNCIL, 'clarity'),
  compass: path.join(WORKSPACE_BASE_COUNCIL, 'compass'),
  forge: path.join(WORKSPACE_BASE_COUNCIL, 'forge'),
  sentinel: path.join(WORKSPACE_BASE_COUNCIL, 'sentinel'),
  vanguard: path.join(WORKSPACE_BASE_COUNCIL, 'vanguard'),
  // Directors
  helm: path.join(WORKSPACE_BASE_COUNCIL, 'helm'),
  chisel: path.join(WORKSPACE_BASE_COUNCIL, 'chisel'),
  facet: path.join(WORKSPACE_BASE_COUNCIL, 'facet'),
  pylon: path.join(WORKSPACE_BASE_COUNCIL, 'pylon'),
  plane: path.join(WORKSPACE_BASE_COUNCIL, 'plane'),
  vigil: path.join(WORKSPACE_BASE_COUNCIL, 'vigil'),
  gauge: path.join(WORKSPACE_BASE_COUNCIL, 'gauge'),
  bastion: path.join(WORKSPACE_BASE_COUNCIL, 'bastion'),
  // Specialists
  crucible: path.join(WORKSPACE_BASE_RESEARCH, 'crucible'),
  relay: path.join(WORKSPACE_BASE_COUNCIL, 'relay'),
  // Main
  main: path.join(WORKSPACE_BASE_DIRECTOR, 'qatux'),
};

function parseIdentity(workspaceDir) {
  const identityPath = path.join(workspaceDir, 'IDENTITY.md');
  if (!existsSync(identityPath)) return {};

  const content = readFileSync(identityPath, 'utf-8');
  const result = {};

  const nameMatch = content.match(/\*\*Name:\*\*\s*(.+)/);
  if (nameMatch) result.displayName = nameMatch[1].trim();

  const roleMatch = content.match(/\*\*Role:\*\*\s*(.+)/);
  if (roleMatch) {
    result.role = roleMatch[1].trim();
    const roleLower = result.role.toLowerCase();
    if (roleLower.startsWith('council')) {
      result.tier = 'council';
    } else if (roleLower.includes('director')) {
      result.tier = 'director';
    } else if (roleLower.includes('specialist') || roleLower.includes('researcher')) {
      result.tier = 'specialist';
    } else if (roleLower.includes('aide-de-camp') || roleLower.includes('relay')) {
      result.tier = 'specialist';
    }
  }

  const tierMatch = content.match(/\*\*Tier:\*\*\s*(.+)/i);
  if (tierMatch) result.tier = tierMatch[1].trim().toLowerCase();

  const reportsMatch = content.match(/\*\*Reports to:\*\*\s*(.+)/i);
  if (reportsMatch) {
    const reportsTo = reportsMatch[1].trim().replace(/\s*\(.*\)/, '').toLowerCase();
    if (reportsTo !== 'ragesaq') {
      result.reportsTo = reportsTo;
    }
  }

  return result;
}

function parseToolsDomains(workspaceDir) {
  const toolsPath = path.join(workspaceDir, 'TOOLS.md');
  if (!existsSync(toolsPath)) return {};

  const content = readFileSync(toolsPath, 'utf-8');
  const result = {};

  const domainsMatch = content.match(/\|\s*Domains?\s*\|\s*([^|]+)\|/i);
  if (domainsMatch) {
    result.domains = domainsMatch[1].trim().split(/[,;]+/).map(d => d.trim()).filter(Boolean);
  }

  return result;
}

console.log('Fixing fleet tier resolution...\n');

let fixed = 0;
let skipped = 0;

for (const [agentId, workspaceDir] of Object.entries(AGENT_WORKSPACES)) {
  if (!existsSync(workspaceDir)) {
    console.log(`  SKIP ${agentId}: workspace not found at ${workspaceDir}`);
    skipped++;
    continue;
  }

  const identity = parseIdentity(workspaceDir);
  const tools = parseToolsDomains(workspaceDir);
  const tier = identity.tier || 'unknown';

  const updateData = {
    displayName: identity.displayName || agentId,
    tier,
    status: 'active',
    metadata: {
      role: identity.role,
      fixedBy: 'fix-fleet-tiers.mjs',
      fixedAt: new Date().toISOString(),
    },
  };

  if (tools.domains) updateData.domains = tools.domains;
  if (identity.reportsTo) updateData.reportsTo = identity.reportsTo;

  // Derive orgId
  if (tier === 'council') {
    updateData.orgId = `${agentId}-org`;
  } else if (identity.reportsTo) {
    updateData.orgId = `${identity.reportsTo}-org`;
  }

  hm.upsertFleetAgent(agentId, updateData);
  console.log(`  ✅ ${agentId}: tier=${tier}, reportsTo=${identity.reportsTo || '—'}, org=${updateData.orgId || '—'}`);
  fixed++;
}

// Also register orgs
const ORGS = [
  { id: 'compass-org', name: 'Product & Strategy', leadAgentId: 'compass', mission: 'Product vision, roadmap, user experience' },
  { id: 'forge-org', name: 'Infrastructure & Operations', leadAgentId: 'forge', mission: 'Platform reliability, DevEx, operational health' },
  { id: 'sentinel-org', name: 'Security & Risk', leadAgentId: 'sentinel', mission: 'Security posture, risk management, compliance' },
];

console.log('\nRegistering orgs...');
for (const org of ORGS) {
  hm.upsertFleetOrg(org.id, { name: org.name, leadAgentId: org.leadAgentId, mission: org.mission });
  console.log(`  ✅ ${org.id}: ${org.name} (lead: ${org.leadAgentId})`);
}

// Hydrate fleet cache
console.log('\nHydrating fleet cache...');
const result = await hm.hydrateFleetCache();
console.log(`  Hydrated ${result.agents} agents, summary: ${result.summary}`);

console.log(`\nDone. Fixed: ${fixed}, Skipped: ${skipped}`);
await hm.close();
