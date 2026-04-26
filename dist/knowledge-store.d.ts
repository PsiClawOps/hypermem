/**
 * hypermem Knowledge Store
 *
 * Long-term structured knowledge — replaces MEMORY.md.
 * Lives in the central library DB.
 * Knowledge entries are keyed (domain + key), versioned via superseded_by,
 * and linked to each other via knowledge_links.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Knowledge } from './types.js';
export type LinkType = 'supports' | 'contradicts' | 'depends_on' | 'supersedes' | 'related';
export declare class KnowledgeStore {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Upsert a knowledge entry.
     *
     * Versioning semantics:
     * - If no active entry exists: insert as version 1
     * - If same content: refresh confidence + timestamp + source_ref/expiry
     *   metadata only (no new version). Refreshing source_ref advances
     *   synthesis watermarks (e.g. "topic:<id>:mc:<count>") so callers that
     *   re-run with identical compiled content do not loop forever.
     * - If different content: insert as new version (max_version + 1), mark
     *   previous active row as superseded_by = new_id
     *
     * This guarantees version history is real rows, not in-place overwrites.
     * The unique constraint is (agent_id, domain, key, version) so each
     * version is a distinct row.
     */
    upsert(agentId: string, domain: string, key: string, content: string, opts?: {
        confidence?: number;
        visibility?: string;
        sourceType?: string;
        sourceRef?: string;
        expiresAt?: string;
    }): Knowledge;
    /**
     * Get current (non-superseded) knowledge for an agent.
     */
    getActive(agentId: string, opts?: {
        domain?: string;
        limit?: number;
    }): Knowledge[];
    /**
     * Get a specific knowledge entry by domain + key.
     */
    get(agentId: string, domain: string, key: string): Knowledge | null;
    /**
     * Get the version history of a knowledge entry.
     */
    getHistory(agentId: string, domain: string, key: string): Knowledge[];
    /**
     * Search knowledge by content.
     */
    search(agentId: string, query: string, limit?: number): Knowledge[];
    /**
     * List all domains for an agent.
     */
    getDomains(agentId: string): string[];
    /**
     * Add a link between knowledge entries.
     */
    addLink(fromId: number, toId: number, linkType: LinkType): void;
    /**
     * Get knowledge count.
     */
    getCount(agentId: string): number;
    /**
     * Import from MEMORY.md content.
     * Parses markdown sections into domain/key/content entries.
     */
    importFromMarkdown(agentId: string, markdown: string, sourcePath: string): number;
}
//# sourceMappingURL=knowledge-store.d.ts.map