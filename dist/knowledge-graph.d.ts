/**
 * hypermem Knowledge Graph
 *
 * DAG traversal over knowledge_links in library.db.
 * Links connect entities across collections:
 *   - fact ↔ fact (supersedes, contradicts, supports)
 *   - fact ↔ knowledge (references, derived_from)
 *   - knowledge ↔ knowledge (depends_on, extends)
 *   - topic ↔ fact (covers)
 *   - agent ↔ fact (authored_by)
 *
 * Traversal is bounded (max depth, max results) to prevent runaway queries.
 */
import type { DatabaseSync } from 'node:sqlite';
export type EntityType = 'fact' | 'knowledge' | 'topic' | 'episode' | 'agent' | 'preference';
export interface KnowledgeLink {
    id: number;
    fromType: EntityType;
    fromId: number;
    toType: EntityType;
    toId: number;
    linkType: string;
    createdAt: string;
}
export interface GraphNode {
    type: EntityType;
    id: number;
    depth: number;
    linkType: string;
    direction: 'outbound' | 'inbound';
}
export interface TraversalResult {
    nodes: GraphNode[];
    edges: KnowledgeLink[];
    truncated: boolean;
}
export declare class KnowledgeGraph {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Create a directed link between two entities.
     * Idempotent — unique constraint on (from_type, from_id, to_type, to_id, link_type).
     */
    addLink(fromType: EntityType, fromId: number, toType: EntityType, toId: number, linkType: string): KnowledgeLink;
    /**
     * Remove a specific link.
     */
    removeLink(fromType: EntityType, fromId: number, toType: EntityType, toId: number, linkType: string): boolean;
    /**
     * Remove all links involving an entity (both directions).
     */
    removeEntityLinks(type: EntityType, id: number): number;
    /**
     * Get outbound links from an entity.
     */
    getOutbound(type: EntityType, id: number, linkType?: string): KnowledgeLink[];
    /**
     * Get inbound links to an entity.
     */
    getInbound(type: EntityType, id: number, linkType?: string): KnowledgeLink[];
    /**
     * Get all links for an entity (both directions).
     */
    getLinks(type: EntityType, id: number): KnowledgeLink[];
    /**
     * Breadth-first traversal from a starting entity.
     * Follows links in both directions up to maxDepth.
     *
     * @param startType - Entity type to start from
     * @param startId - Entity ID to start from
     * @param opts - Traversal options
     * @returns Discovered nodes and edges
     */
    traverse(startType: EntityType, startId: number, opts?: {
        maxDepth?: number;
        maxResults?: number;
        linkTypes?: string[];
        direction?: 'outbound' | 'inbound' | 'both';
        targetTypes?: EntityType[];
    }): TraversalResult;
    /**
     * Find the shortest path between two entities.
     * Uses BFS — returns null if no path exists within maxDepth.
     */
    findPath(fromType: EntityType, fromId: number, toType: EntityType, toId: number, maxDepth?: number): GraphNode[] | null;
    /**
     * Get the most connected entities (highest degree).
     */
    getMostConnected(opts?: {
        type?: EntityType;
        limit?: number;
    }): Array<{
        type: EntityType;
        id: number;
        degree: number;
    }>;
    /**
     * Count links by type.
     */
    getLinkStats(): Array<{
        linkType: string;
        count: number;
    }>;
    /**
     * Total link count.
     */
    getTotalLinks(): number;
    private rowToLink;
}
//# sourceMappingURL=knowledge-graph.d.ts.map