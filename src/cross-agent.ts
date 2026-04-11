/**
 * Cross-Agent Memory Access
 *
 * Enables agents to read each other's memory with visibility-scoped access.
 * All structured knowledge lives in the central library DB, so cross-agent
 * queries are now single-DB operations — no per-agent DB hopping.
 *
 * Visibility levels:
 * - private:  Owner only. Identity, SOUL, personal reflections, raw conversations.
 * - org:      Same org (council lead + their directors).
 * - council:  All council seats.
 * - fleet:    Any agent.
 *
 * What's ALWAYS private (hardcoded, not configurable):
 * - Raw message history — an agent's conversations are theirs
 * - Identity/SOUL-derived knowledge — domain='identity'
 * - Facts with scope='session' — ephemeral session context
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  MemoryVisibility,
  CrossAgentQuery,
  AgentIdentity,
} from './types.js';
import { DatabaseManager } from './db.js';
import { FleetStore } from './fleet-store.js';

// ─── Org Membership Registry ─────────────────────────────────────

export interface OrgRegistry {
  orgs: Record<string, string[]>;
  agents: Record<string, AgentIdentity>;
}

/**
 * Default fleet org structure.
 */
export function defaultOrgRegistry(): OrgRegistry {
  const agents: Record<string, AgentIdentity> = {
    alice:    { agentId: 'alice',    tier: 'council' },
    bob:  { agentId: 'bob',  tier: 'council' },
    clarity:  { agentId: 'clarity',  tier: 'council' },
    dave: { agentId: 'dave', tier: 'council' },
    carol:    { agentId: 'carol',    tier: 'council' },
    oscar: { agentId: 'oscar', tier: 'council' },
    hank:    { agentId: 'hank',  tier: 'director', org: 'alice-org', councilLead: 'alice' },
    jack:    { agentId: 'jack',  tier: 'director', org: 'alice-org', councilLead: 'alice' },
    irene:    { agentId: 'irene',  tier: 'director', org: 'alice-org', councilLead: 'alice' },
    eve:     { agentId: 'eve',   tier: 'director', org: 'bob-org', councilLead: 'bob' },
    frank:   { agentId: 'frank', tier: 'director', org: 'bob-org', councilLead: 'bob' },
    grace:    { agentId: 'grace',  tier: 'director', org: 'bob-org', councilLead: 'bob' },
    leo:  { agentId: 'leo', tier: 'director', org: 'dave-org', councilLead: 'dave' },
    kate:    { agentId: 'kate',   tier: 'director', org: 'dave-org', councilLead: 'dave' },
    mike: { agentId: 'mike', tier: 'specialist' },
    nancy:    { agentId: 'nancy', tier: 'specialist' },
  };

  const orgs: Record<string, string[]> = {
    'alice-org':    ['alice', 'hank', 'jack', 'irene'],
    'bob-org':  ['bob', 'eve', 'frank', 'grace'],
    'dave-org': ['dave', 'leo', 'kate'],
  };

  return { orgs, agents };
}

// ─── Access Control ──────────────────────────────────────────────

export function canAccess(
  requester: AgentIdentity,
  target: AgentIdentity,
  visibility: MemoryVisibility,
  registry: OrgRegistry,
): boolean {
  if (requester.agentId === target.agentId) return true;

  switch (visibility) {
    case 'private': return false;
    case 'org': return sameOrg(requester, target, registry);
    case 'council':
      if (requester.tier === 'council') return true;
      if (requester.councilLead === target.agentId) return true;
      return false;
    case 'fleet': return true;
    default: return false;
  }
}

function sameOrg(a: AgentIdentity, b: AgentIdentity, registry: OrgRegistry): boolean {
  for (const members of Object.values(registry.orgs)) {
    if (members.includes(a.agentId) && members.includes(b.agentId)) return true;
  }
  return false;
}

export function visibilityFilter(
  requester: AgentIdentity,
  targetAgentId: string,
  registry: OrgRegistry,
): { clause: string; canReadPrivate: boolean; canReadOrg: boolean; canReadCouncil: boolean } {
  const target = registry.agents[targetAgentId];
  if (!target) {
    // Restrictive Default: unknown agents get fleet-only visibility.
    // This is a deliberate safety-side fallback — queries succeed with narrowed
    // results rather than failing. The warning surfaces registry gaps so operators
    // can add the missing agent to the org registry.
    // See ARCHITECTURE.md § Cross-Agent Access Control → Unknown Agent Fallback.
    console.warn(`[cross-agent] visibilityFilter: agent "${targetAgentId}" not found in registry — restricting to fleet-only visibility. Add this agent to the org registry if this is unexpected.`);
    return { clause: "visibility = 'fleet'", canReadPrivate: false, canReadOrg: false, canReadCouncil: false };
  }

  if (requester.agentId === targetAgentId) {
    return { clause: '1=1', canReadPrivate: true, canReadOrg: true, canReadCouncil: true };
  }

  const canReadOrg = sameOrg(requester, target, registry);
  const canReadCouncil = requester.tier === 'council' || requester.councilLead === targetAgentId;

  const levels: string[] = ["'fleet'"];
  if (canReadCouncil) levels.push("'council'");
  if (canReadOrg) levels.push("'org'");

  return {
    clause: `visibility IN (${levels.join(', ')})`,
    canReadPrivate: false,
    canReadOrg,
    canReadCouncil,
  };
}

// ─── Live Registry Loader ────────────────────────────────────────

/**
 * Build an OrgRegistry by reading from the fleet_agents and fleet_orgs tables.
 *
 * Falls back to defaultOrgRegistry() when:
 *   - The library DB is unavailable
 *   - The fleet tables are empty (not yet seeded)
 *   - An unexpected schema error occurs
 *
 * This replaces the hardcoded registry with a live source, so new agents and
 * org restructures propagate automatically without a code change.
 *
 * Merge strategy: DB entries OVERRIDE hardcoded defaults. Agents present only
 * in the hardcoded registry (not yet seeded to the DB) are preserved as fallback.
 */
export function buildOrgRegistryFromDb(libraryDb: DatabaseSync): OrgRegistry {
  const fallback = defaultOrgRegistry();

  try {
    const fleetStore = new FleetStore(libraryDb);
    const dbAgents = fleetStore.listAgents();

    if (dbAgents.length === 0) {
      // Fleet not yet seeded — use hardcoded registry
      return fallback;
    }

    const agents: Record<string, AgentIdentity> = { ...fallback.agents };

    for (const agent of dbAgents) {
      const tier = agent.tier as AgentIdentity['tier'];
      agents[agent.id] = {
        agentId: agent.id,
        tier,
        org: agent.orgId ?? undefined,
        councilLead: agent.reportsTo ?? undefined,
      };
    }

    // Build orgs from DB: group agents by orgId
    const orgs: Record<string, string[]> = {};

    // Seed with hardcoded orgs for agents not in DB
    for (const [orgId, members] of Object.entries(fallback.orgs)) {
      orgs[orgId] = [...members];
    }

    // Apply DB agents — update org membership
    for (const agent of dbAgents) {
      if (!agent.orgId) continue;
      if (!orgs[agent.orgId]) {
        orgs[agent.orgId] = [];
      }
      if (!orgs[agent.orgId].includes(agent.id)) {
        orgs[agent.orgId].push(agent.id);
      }
    }

    return { orgs, agents };
  } catch {
    // DB error is non-fatal — fall back to hardcoded registry
    return fallback;
  }
}

/**
 * Alias for buildOrgRegistryFromDb — preferred name per P1.4 spec.
 * Both names are exported for backward compatibility.
 */
export const loadOrgRegistryFromDb = buildOrgRegistryFromDb;

// ─── Cross-Agent Query Engine ────────────────────────────────────

/**
 * Query another agent's memory with visibility-scoped access.
 * All queries go to the central library DB — no per-agent DB needed.
 */
export function crossAgentQuery(
  dbManager: DatabaseManager,
  query: CrossAgentQuery,
  registry: OrgRegistry,
): unknown[] {
  const requester = registry.agents[query.requesterId];
  if (!requester) throw new Error(`Unknown requester agent: ${query.requesterId}`);

  const target = registry.agents[query.targetAgentId];
  if (!target) throw new Error(`Unknown target agent: ${query.targetAgentId}`);

  // All structured knowledge is now in the library DB
  const db = dbManager.getLibraryDb();
  const filter = visibilityFilter(requester, query.targetAgentId, registry);
  const limit = query.limit || 20;

  switch (query.memoryType) {
    case 'facts':
      return queryFacts(db, query, filter.clause, limit);
    case 'knowledge':
      return queryKnowledge(db, query, filter.clause, limit);
    case 'topics':
      return queryTopics(db, query, filter.clause, limit);
    case 'episodes':
      return queryEpisodes(db, query, filter.clause, limit);
    case 'messages':
      // Messages are always private
      return [];
    default:
      return [
        ...queryFacts(db, query, filter.clause, Math.ceil(limit / 4)),
        ...queryKnowledge(db, query, filter.clause, Math.ceil(limit / 4)),
        ...queryTopics(db, query, filter.clause, Math.ceil(limit / 4)),
        ...queryEpisodes(db, query, filter.clause, Math.ceil(limit / 4)),
      ];
  }
}

function queryFacts(
  db: DatabaseSync,
  query: CrossAgentQuery,
  visFilter: string,
  limit: number,
): unknown[] {
  let sql = `SELECT id, domain, content, confidence, visibility, created_at
    FROM facts WHERE agent_id = ? AND ${visFilter}
    AND scope != 'session'
    AND (domain IS NULL OR domain != 'identity')
    AND superseded_by IS NULL
    AND decay_score < 0.8`;
  const params: (string | number)[] = [query.targetAgentId];

  if (query.domain) {
    sql += ' AND domain = ?';
    params.push(query.domain);
  }
  sql += ' ORDER BY confidence DESC, created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params).map((r: any) => ({
    type: 'fact',
    sourceAgent: query.targetAgentId,
    ...r,
  }));
}

function queryKnowledge(
  db: DatabaseSync,
  query: CrossAgentQuery,
  visFilter: string,
  limit: number,
): unknown[] {
  let sql = `SELECT id, domain, key, content, confidence, visibility, updated_at
    FROM knowledge WHERE agent_id = ? AND ${visFilter}
    AND superseded_by IS NULL
    AND domain != 'identity'`;
  const params: (string | number)[] = [query.targetAgentId];

  if (query.domain) {
    sql += ' AND domain = ?';
    params.push(query.domain);
  }
  sql += ' ORDER BY confidence DESC, updated_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params).map((r: any) => ({
    type: 'knowledge',
    sourceAgent: query.targetAgentId,
    ...r,
  }));
}

function queryTopics(
  db: DatabaseSync,
  query: CrossAgentQuery,
  visFilter: string,
  limit: number,
): unknown[] {
  const sql = `SELECT id, name, description, status, visibility, message_count, updated_at
    FROM topics WHERE agent_id = ? AND ${visFilter} AND status = 'active'
    ORDER BY updated_at DESC LIMIT ?`;

  return db.prepare(sql).all(query.targetAgentId, limit).map((r: any) => ({
    type: 'topic',
    sourceAgent: query.targetAgentId,
    ...r,
  }));
}

function queryEpisodes(
  db: DatabaseSync,
  query: CrossAgentQuery,
  visFilter: string,
  limit: number,
): unknown[] {
  const sql = `SELECT id, event_type, summary, significance, visibility, participants, created_at
    FROM episodes WHERE agent_id = ? AND ${visFilter}
    ORDER BY significance DESC, created_at DESC LIMIT ?`;

  return db.prepare(sql).all(query.targetAgentId, limit).map((r: any) => ({
    type: 'episode',
    sourceAgent: query.targetAgentId,
    ...r,
  }));
}
