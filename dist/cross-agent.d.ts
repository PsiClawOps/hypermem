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
import type { MemoryVisibility, CrossAgentQuery, AgentIdentity } from './types.js';
import { DatabaseManager } from './db.js';
export interface OrgRegistry {
    orgs: Record<string, string[]>;
    agents: Record<string, AgentIdentity>;
}
/**
 * Default fleet org structure.
 *
 * ── EXAMPLE DATA ──────────────────────────────────────────────────────────
 * The agent names below (alice, bob, director1, etc.) are PLACEHOLDERS.
 * Replace them with your own agent IDs to match your fleet configuration.
 *
 * Single-agent installs: you don't need to edit this. Your agent ID is
 * resolved automatically at runtime from your OpenClaw config.
 *
 * Multi-agent installs: edit the agents map and orgs map below, then
 * rebuild (`npm run build`). See INSTALL.md § "Configure your fleet" for
 * a worked example.
 * ─────────────────────────────────────────────────────────────────────────
 */
export declare function defaultOrgRegistry(): OrgRegistry;
export declare function canAccess(requester: AgentIdentity, target: AgentIdentity, visibility: MemoryVisibility, registry: OrgRegistry): boolean;
export declare function visibilityFilter(requester: AgentIdentity, targetAgentId: string, registry: OrgRegistry): {
    clause: string;
    canReadPrivate: boolean;
    canReadOrg: boolean;
    canReadCouncil: boolean;
};
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
export declare function buildOrgRegistryFromDb(libraryDb: DatabaseSync): OrgRegistry;
/**
 * Alias for buildOrgRegistryFromDb — preferred name per P1.4 spec.
 * Both names are exported for backward compatibility.
 */
export declare const loadOrgRegistryFromDb: typeof buildOrgRegistryFromDb;
/**
 * Query another agent's memory with visibility-scoped access.
 * All queries go to the central library DB — no per-agent DB needed.
 */
export declare function crossAgentQuery(dbManager: DatabaseManager, query: CrossAgentQuery, registry: OrgRegistry): unknown[];
//# sourceMappingURL=cross-agent.d.ts.map