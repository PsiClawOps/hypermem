/**
 * hypermem Fleet Registry Store
 *
 * Agent roster, org structure, roles, capabilities.
 * Lives in the central library DB.
 * The operational map of the fleet.
 */

import type { DatabaseSync } from 'node:sqlite';

function nowIso(): string {
  return new Date().toISOString();
}

export interface AgentCapability {
  capType: 'skill' | 'tool' | 'mcp_server';
  name: string;
  version?: string;
  source?: string;
  config?: Record<string, unknown>;
  status: string;
  lastVerified?: string;
}

export interface FleetAgent {
  id: string;
  displayName: string;
  tier: string;
  orgId: string | null;
  reportsTo: string | null;
  domains: string[];
  sessionKeys: string[];
  status: string;
  lastSeen: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
  capabilities: AgentCapability[] | null;
}

export interface FleetOrg {
  id: string;
  name: string;
  leadAgentId: string | null;
  mission: string | null;
  createdAt: string;
}

function parseAgentRow(row: Record<string, unknown>): FleetAgent {
  return {
    id: row.id as string,
    displayName: row.display_name as string,
    tier: row.tier as string,
    orgId: (row.org_id as string) || null,
    reportsTo: (row.reports_to as string) || null,
    domains: row.domains ? JSON.parse(row.domains as string) : [],
    sessionKeys: row.session_keys ? JSON.parse(row.session_keys as string) : [],
    status: row.status as string,
    lastSeen: (row.last_seen as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
    capabilities: row.capabilities ? JSON.parse(row.capabilities as string) : null,
  };
}

function parseCapabilityRow(row: Record<string, unknown>): AgentCapability {
  return {
    capType: row.cap_type as AgentCapability['capType'],
    name: row.name as string,
    version: (row.version as string) || undefined,
    source: (row.source as string) || undefined,
    config: row.config ? JSON.parse(row.config as string) : undefined,
    status: row.status as string,
    lastVerified: (row.last_verified as string) || undefined,
  };
}

function parseOrgRow(row: Record<string, unknown>): FleetOrg {
  return {
    id: row.id as string,
    name: row.name as string,
    leadAgentId: (row.lead_agent_id as string) || null,
    mission: (row.mission as string) || null,
    createdAt: row.created_at as string,
  };
}

export class FleetStore {
  constructor(private readonly db: DatabaseSync) {}

  // ── Agents ──────────────────────────────────────────────────

  /**
   * Register or update an agent.
   */
  upsertAgent(id: string, data: {
    displayName?: string;
    tier?: string;
    orgId?: string;
    reportsTo?: string;
    domains?: string[];
    sessionKeys?: string[];
    status?: string;
    metadata?: Record<string, unknown>;
  }): FleetAgent {
    const now = nowIso();

    const existing = this.db.prepare('SELECT * FROM fleet_agents WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE fleet_agents SET
          display_name = COALESCE(?, display_name),
          tier = COALESCE(?, tier),
          org_id = COALESCE(?, org_id),
          reports_to = COALESCE(?, reports_to),
          domains = COALESCE(?, domains),
          session_keys = COALESCE(?, session_keys),
          status = COALESCE(?, status),
          metadata = COALESCE(?, metadata),
          last_seen = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        data.displayName || null,
        data.tier || null,
        data.orgId || null,
        data.reportsTo || null,
        data.domains ? JSON.stringify(data.domains) : null,
        data.sessionKeys ? JSON.stringify(data.sessionKeys) : null,
        data.status || null,
        data.metadata ? JSON.stringify(data.metadata) : null,
        now,
        now,
        id
      );
    } else {
      this.db.prepare(`
        INSERT INTO fleet_agents (id, display_name, tier, org_id, reports_to,
          domains, session_keys, status, last_seen, created_at, updated_at, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        data.displayName || id,
        data.tier || 'unknown',
        data.orgId || null,
        data.reportsTo || null,
        data.domains ? JSON.stringify(data.domains) : '[]',
        data.sessionKeys ? JSON.stringify(data.sessionKeys) : '[]',
        data.status || 'active',
        now,
        now,
        now,
        data.metadata ? JSON.stringify(data.metadata) : null
      );
    }

    return this.getAgent(id)!;
  }

  /**
   * Get an agent by ID.
   */
  getAgent(id: string): FleetAgent | null {
    const row = this.db.prepare('SELECT * FROM fleet_agents WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;

    return row ? parseAgentRow(row) : null;
  }

  /**
   * List all agents, optionally filtered.
   */
  listAgents(opts?: {
    tier?: string;
    orgId?: string;
    status?: string;
  }): FleetAgent[] {
    let sql = 'SELECT * FROM fleet_agents WHERE 1=1';
    const params: string[] = [];

    if (opts?.tier) {
      sql += ' AND tier = ?';
      params.push(opts.tier);
    }
    if (opts?.orgId) {
      sql += ' AND org_id = ?';
      params.push(opts.orgId);
    }
    if (opts?.status) {
      sql += ' AND status = ?';
      params.push(opts.status);
    }

    sql += ' ORDER BY tier, id';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseAgentRow);
  }

  /**
   * Update agent status and last_seen.
   */
  heartbeat(agentId: string, status: string = 'active'): void {
    const now = nowIso();
    this.db.prepare(
      'UPDATE fleet_agents SET status = ?, last_seen = ?, updated_at = ? WHERE id = ?'
    ).run(status, now, now, agentId);
  }

  /**
   * Find agents by domain.
   */
  findByDomain(domain: string): FleetAgent[] {
    const rows = this.db.prepare(
      "SELECT * FROM fleet_agents WHERE domains LIKE ? AND status = 'active'"
    ).all(`%"${domain}"%`) as Record<string, unknown>[];

    return rows.map(parseAgentRow);
  }

  // ── Orgs ────────────────────────────────────────────────────

  /**
   * Register or update an org.
   */
  upsertOrg(id: string, data: {
    name: string;
    leadAgentId?: string;
    mission?: string;
  }): FleetOrg {
    const now = nowIso();

    this.db.prepare(`
      INSERT INTO fleet_orgs (id, name, lead_agent_id, mission, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        lead_agent_id = COALESCE(excluded.lead_agent_id, lead_agent_id),
        mission = COALESCE(excluded.mission, mission)
    `).run(id, data.name, data.leadAgentId || null, data.mission || null, now);

    return this.getOrg(id)!;
  }

  /**
   * Get an org by ID.
   */
  getOrg(id: string): FleetOrg | null {
    const row = this.db.prepare('SELECT * FROM fleet_orgs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;

    return row ? parseOrgRow(row) : null;
  }

  /**
   * List all orgs.
   */
  listOrgs(): FleetOrg[] {
    const rows = this.db.prepare('SELECT * FROM fleet_orgs ORDER BY name')
      .all() as Record<string, unknown>[];

    return rows.map(parseOrgRow);
  }

  /**
   * Get all agents in an org.
   */
  getOrgMembers(orgId: string): FleetAgent[] {
    const rows = this.db.prepare(
      "SELECT * FROM fleet_agents WHERE org_id = ? ORDER BY tier, id"
    ).all(orgId) as Record<string, unknown>[];

    return rows.map(parseAgentRow);
  }

  // ── Capabilities ────────────────────────────────────────────

  /**
   * Register or update a capability for an agent.
   */
  upsertCapability(agentId: string, cap: {
    capType: AgentCapability['capType'];
    name: string;
    version?: string;
    source?: string;
    config?: Record<string, unknown>;
    status?: string;
  }): AgentCapability {
    const now = nowIso();

    this.db.prepare(`
      INSERT INTO agent_capabilities (agent_id, cap_type, name, version, source, config, status, last_verified, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, cap_type, name) DO UPDATE SET
        version = COALESCE(excluded.version, version),
        source = COALESCE(excluded.source, source),
        config = COALESCE(excluded.config, config),
        status = excluded.status,
        last_verified = excluded.last_verified,
        updated_at = excluded.updated_at
    `).run(
      agentId,
      cap.capType,
      cap.name,
      cap.version || null,
      cap.source || null,
      cap.config ? JSON.stringify(cap.config) : null,
      cap.status || 'active',
      now,
      now,
      now
    );

    // Also update the denormalized JSON on fleet_agents
    this._syncCapabilitiesJson(agentId);

    return this.getCapability(agentId, cap.capType, cap.name)!;
  }

  /**
   * Bulk-sync capabilities for an agent (replace all of a given type).
   */
  syncCapabilities(agentId: string, capType: AgentCapability['capType'], caps: Array<{
    name: string;
    version?: string;
    source?: string;
    config?: Record<string, unknown>;
  }>): void {
    const now = nowIso();
    const capNames = caps.map(c => c.name);

    // Mark missing ones as removed
    const existing = this.db.prepare(
      'SELECT name FROM agent_capabilities WHERE agent_id = ? AND cap_type = ? AND status = ?'
    ).all(agentId, capType, 'active') as Array<{ name: string }>;

    for (const row of existing) {
      if (!capNames.includes(row.name)) {
        this.db.prepare(
          'UPDATE agent_capabilities SET status = ?, updated_at = ? WHERE agent_id = ? AND cap_type = ? AND name = ?'
        ).run('removed', now, agentId, capType, row.name);
      }
    }

    // Upsert current ones
    for (const cap of caps) {
      this.upsertCapability(agentId, { capType, ...cap });
    }

    this._syncCapabilitiesJson(agentId);
  }

  /**
   * Get a specific capability.
   */
  getCapability(agentId: string, capType: string, name: string): AgentCapability | null {
    const row = this.db.prepare(
      'SELECT * FROM agent_capabilities WHERE agent_id = ? AND cap_type = ? AND name = ?'
    ).get(agentId, capType, name) as Record<string, unknown> | undefined;

    return row ? parseCapabilityRow(row) : null;
  }

  /**
   * List capabilities for an agent, optionally filtered by type.
   */
  getAgentCapabilities(agentId: string, capType?: string): AgentCapability[] {
    let sql = 'SELECT * FROM agent_capabilities WHERE agent_id = ? AND status = ?';
    const params: (string)[] = [agentId, 'active'];

    if (capType) {
      sql += ' AND cap_type = ?';
      params.push(capType);
    }

    sql += ' ORDER BY cap_type, name';

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseCapabilityRow);
  }

  /**
   * Find agents that have a specific capability.
   */
  findByCapability(capType: string, name: string): FleetAgent[] {
    const rows = this.db.prepare(`
      SELECT fa.* FROM fleet_agents fa
      INNER JOIN agent_capabilities ac ON ac.agent_id = fa.id
      WHERE ac.cap_type = ? AND ac.name = ? AND ac.status = 'active' AND fa.status = 'active'
      ORDER BY fa.tier, fa.id
    `).all(capType, name) as Record<string, unknown>[];

    return rows.map(parseAgentRow);
  }

  /**
   * Find agents that have ANY of the given capabilities.
   */
  findByAnyCapability(caps: Array<{ capType: string; name: string }>): FleetAgent[] {
    if (caps.length === 0) return [];

    const conditions = caps.map(() => '(ac.cap_type = ? AND ac.name = ?)').join(' OR ');
    const params = caps.flatMap(c => [c.capType, c.name]);

    const rows = this.db.prepare(`
      SELECT DISTINCT fa.* FROM fleet_agents fa
      INNER JOIN agent_capabilities ac ON ac.agent_id = fa.id
      WHERE (${conditions}) AND ac.status = 'active' AND fa.status = 'active'
      ORDER BY fa.tier, fa.id
    `).all(...params) as Record<string, unknown>[];

    return rows.map(parseAgentRow);
  }

  /**
   * Remove a capability from an agent.
   */
  removeCapability(agentId: string, capType: string, name: string): void {
    const now = nowIso();
    this.db.prepare(
      'UPDATE agent_capabilities SET status = ?, updated_at = ? WHERE agent_id = ? AND cap_type = ? AND name = ?'
    ).run('removed', now, agentId, capType, name);

    this._syncCapabilitiesJson(agentId);
  }

  // ── Internal ────────────────────────────────────────────────

  /**
   * Sync the denormalized capabilities JSON on fleet_agents.
   */
  private _syncCapabilitiesJson(agentId: string): void {
    const caps = this.getAgentCapabilities(agentId);
    const now = nowIso();

    this.db.prepare(
      'UPDATE fleet_agents SET capabilities = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(caps), now, agentId);
  }
}
