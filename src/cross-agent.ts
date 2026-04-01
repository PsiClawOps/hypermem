/**
 * Cross-Agent Memory Access
 *
 * Enables agents to read each other's memory with visibility-scoped access.
 *
 * Visibility levels:
 * - private:  Owner only. Identity, SOUL, personal reflections, raw conversations.
 * - org:      Same org (council lead + their directors). Operational context sharing.
 * - council:  All council seats. Strategic context, deliberation history.
 * - fleet:    Any agent. Shared knowledge, public facts, fleet-wide patterns.
 *
 * What's ALWAYS private (hardcoded, not configurable):
 * - Raw message history (conversations table) — an agent's conversations are theirs
 * - Identity/SOUL-derived knowledge — anything with domain='identity'
 * - Facts with scope='session' — ephemeral session context, not meaningful cross-agent
 *
 * What's shared by default:
 * - Episodes (default: org) — significant events are operationally relevant
 * - Knowledge (default: private, but agents can promote to org/council/fleet)
 * - Facts with scope='agent' (default: private, promotable)
 * - Topics (readable at org level — what is this agent working on?)
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  MemoryVisibility,
  CrossAgentQuery,
  AgentIdentity,
} from './types.js';
import { DatabaseManager } from './db.js';

// ─── Org Membership Registry ─────────────────────────────────────

/**
 * Fleet org structure. This is the source of truth for who can see what.
 * Loaded from config or hardcoded for now — could move to Redis/SQLite later.
 */
export interface OrgRegistry {
  /** Map of org name → member agent IDs */
  orgs: Record<string, string[]>;
  /** Map of agent ID → identity */
  agents: Record<string, AgentIdentity>;
}

/**
 * Default fleet org structure matching the current council/director setup.
 */
export function defaultOrgRegistry(): OrgRegistry {
  const agents: Record<string, AgentIdentity> = {
    // Council seats
    forge:    { agentId: 'forge',    tier: 'council' },
    compass:  { agentId: 'compass',  tier: 'council' },
    clarity:  { agentId: 'clarity',  tier: 'council' },
    sentinel: { agentId: 'sentinel', tier: 'council' },
    anvil:    { agentId: 'anvil',    tier: 'council' },
    vanguard: { agentId: 'vanguard', tier: 'council' },

    // Forge org (infrastructure)
    pylon:  { agentId: 'pylon',  tier: 'director', org: 'forge-org', councilLead: 'forge' },
    vigil:  { agentId: 'vigil',  tier: 'director', org: 'forge-org', councilLead: 'forge' },
    plane:  { agentId: 'plane',  tier: 'director', org: 'forge-org', councilLead: 'forge' },

    // Compass org (product)
    helm:   { agentId: 'helm',   tier: 'director', org: 'compass-org', councilLead: 'compass' },
    chisel: { agentId: 'chisel', tier: 'director', org: 'compass-org', councilLead: 'compass' },
    facet:  { agentId: 'facet',  tier: 'director', org: 'compass-org', councilLead: 'compass' },

    // Sentinel org (security)
    bastion: { agentId: 'bastion', tier: 'director', org: 'sentinel-org', councilLead: 'sentinel' },
    gauge:   { agentId: 'gauge',   tier: 'director', org: 'sentinel-org', councilLead: 'sentinel' },

    // Research
    crucible: { agentId: 'crucible', tier: 'specialist' },

    // Utility
    relay: { agentId: 'relay', tier: 'specialist' },
  };

  const orgs: Record<string, string[]> = {
    'forge-org':    ['forge', 'pylon', 'vigil', 'plane'],
    'compass-org':  ['compass', 'helm', 'chisel', 'facet'],
    'sentinel-org': ['sentinel', 'bastion', 'gauge'],
  };

  return { orgs, agents };
}

// ─── Access Control ──────────────────────────────────────────────

/**
 * Check if requester can access memories at a given visibility level
 * from the target agent.
 */
export function canAccess(
  requester: AgentIdentity,
  target: AgentIdentity,
  visibility: MemoryVisibility,
  registry: OrgRegistry,
): boolean {
  // Owner can always access their own data
  if (requester.agentId === target.agentId) return true;

  switch (visibility) {
    case 'private':
      return false;

    case 'org':
      return sameOrg(requester, target, registry);

    case 'council':
      // Council seats can read council-visible data from anyone
      if (requester.tier === 'council') return true;
      // Directors can read council-visible data from their own council lead
      if (requester.councilLead === target.agentId) return true;
      return false;

    case 'fleet':
      return true;

    default:
      return false;
  }
}

/**
 * Check if two agents are in the same org.
 */
function sameOrg(
  a: AgentIdentity,
  b: AgentIdentity,
  registry: OrgRegistry,
): boolean {
  for (const members of Object.values(registry.orgs)) {
    if (members.includes(a.agentId) && members.includes(b.agentId)) {
      return true;
    }
  }
  return false;
}

/**
 * Build a SQL visibility filter for cross-agent queries.
 * Returns the WHERE clause fragment and bind parameters.
 */
export function visibilityFilter(
  requester: AgentIdentity,
  targetAgentId: string,
  registry: OrgRegistry,
): { clause: string; canReadPrivate: boolean; canReadOrg: boolean; canReadCouncil: boolean } {
  const target = registry.agents[targetAgentId];
  if (!target) {
    // Unknown agent — fleet-only access
    return { clause: "visibility = 'fleet'", canReadPrivate: false, canReadOrg: false, canReadCouncil: false };
  }

  // Self-access: no filter needed
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

// ─── Cross-Agent Query Engine ────────────────────────────────────

/**
 * Query another agent's memory with visibility-scoped access.
 */
export function crossAgentQuery(
  dbManager: DatabaseManager,
  query: CrossAgentQuery,
  registry: OrgRegistry,
): unknown[] {
  const requester = registry.agents[query.requesterId];
  if (!requester) {
    throw new Error(`Unknown requester agent: ${query.requesterId}`);
  }

  const target = registry.agents[query.targetAgentId];
  if (!target) {
    throw new Error(`Unknown target agent: ${query.targetAgentId}`);
  }

  const db = dbManager.getAgentDb(query.targetAgentId);
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
      // Messages are always private — cross-agent message access is blocked
      return [];
    default:
      // Query all accessible memory types
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
    FROM facts WHERE agent_id = ? AND ${visFilter} AND scope != 'session'`;
  const params: (string | number)[] = [query.targetAgentId];

  // Exclude identity-domain facts (always private regardless of visibility column)
  sql += " AND (domain IS NULL OR domain != 'identity')";

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
    FROM knowledge WHERE agent_id = ? AND ${visFilter} AND superseded_by IS NULL`;
  const params: (string | number)[] = [query.targetAgentId];

  // Exclude identity knowledge
  sql += " AND domain != 'identity'";

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
  _visFilter: string,
  limit: number,
): unknown[] {
  // Topics are readable at org level — they tell you what an agent is working on
  // No visibility column on topics yet, so we use a simple status filter
  const sql = `SELECT id, name, description, status, message_count, updated_at
    FROM topics WHERE agent_id = ? AND status = 'active'
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
