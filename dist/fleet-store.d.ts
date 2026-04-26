/**
 * hypermem Fleet Registry Store
 *
 * Agent roster, org structure, roles, capabilities.
 * Lives in the central library DB.
 * The operational map of the fleet.
 */
import type { DatabaseSync } from 'node:sqlite';
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
export declare class FleetStore {
    private readonly db;
    constructor(db: DatabaseSync);
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
    }): FleetAgent;
    /**
     * Get an agent by ID.
     */
    getAgent(id: string): FleetAgent | null;
    /**
     * List all agents, optionally filtered.
     */
    listAgents(opts?: {
        tier?: string;
        orgId?: string;
        status?: string;
    }): FleetAgent[];
    /**
     * Update agent status and last_seen.
     */
    heartbeat(agentId: string, status?: string): void;
    /**
     * Find agents by domain.
     */
    findByDomain(domain: string): FleetAgent[];
    /**
     * Register or update an org.
     */
    upsertOrg(id: string, data: {
        name: string;
        leadAgentId?: string;
        mission?: string;
    }): FleetOrg;
    /**
     * Get an org by ID.
     */
    getOrg(id: string): FleetOrg | null;
    /**
     * List all orgs.
     */
    listOrgs(): FleetOrg[];
    /**
     * Get all agents in an org.
     */
    getOrgMembers(orgId: string): FleetAgent[];
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
    }): AgentCapability;
    /**
     * Bulk-sync capabilities for an agent (replace all of a given type).
     */
    syncCapabilities(agentId: string, capType: AgentCapability['capType'], caps: Array<{
        name: string;
        version?: string;
        source?: string;
        config?: Record<string, unknown>;
    }>): void;
    /**
     * Get a specific capability.
     */
    getCapability(agentId: string, capType: string, name: string): AgentCapability | null;
    /**
     * List capabilities for an agent, optionally filtered by type.
     */
    getAgentCapabilities(agentId: string, capType?: string): AgentCapability[];
    /**
     * Find agents that have a specific capability.
     */
    findByCapability(capType: string, name: string): FleetAgent[];
    /**
     * Find agents that have ANY of the given capabilities.
     */
    findByAnyCapability(caps: Array<{
        capType: string;
        name: string;
    }>): FleetAgent[];
    /**
     * Remove a capability from an agent.
     */
    removeCapability(agentId: string, capType: string, name: string): void;
    /**
     * Sync the denormalized capabilities JSON on fleet_agents.
     */
    private _syncCapabilitiesJson;
}
//# sourceMappingURL=fleet-store.d.ts.map