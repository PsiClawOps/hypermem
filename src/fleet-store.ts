/**
 * HyperMem Fleet Registry Store
 *
 * Agent roster, org structure, roles, capabilities.
 * Lives in the central library DB.
 * The operational map of the fleet.
 */

import type { DatabaseSync } from 'node:sqlite';

function nowIso(): string {
  return new Date().toISOString();
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
}
