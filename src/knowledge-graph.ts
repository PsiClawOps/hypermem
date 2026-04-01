/**
 * HyperMem Knowledge Graph
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
  linkType: string;   // How we arrived here
  direction: 'outbound' | 'inbound';
}

export interface TraversalResult {
  nodes: GraphNode[];
  edges: KnowledgeLink[];
  truncated: boolean;  // Hit max depth or max results
}

function nowIso(): string {
  return new Date().toISOString();
}

export class KnowledgeGraph {
  constructor(private readonly db: DatabaseSync) {}

  // ─── Link Management ───────────────────────────────────────

  /**
   * Create a directed link between two entities.
   * Idempotent — unique constraint on (from_type, from_id, to_type, to_id, link_type).
   */
  addLink(
    fromType: EntityType,
    fromId: number,
    toType: EntityType,
    toId: number,
    linkType: string
  ): KnowledgeLink {
    const now = nowIso();

    this.db.prepare(`
      INSERT OR IGNORE INTO knowledge_links (from_type, from_id, to_type, to_id, link_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(fromType, fromId, toType, toId, linkType, now);

    const row = this.db.prepare(`
      SELECT * FROM knowledge_links
      WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND link_type = ?
    `).get(fromType, fromId, toType, toId, linkType) as Record<string, unknown>;

    return this.rowToLink(row);
  }

  /**
   * Remove a specific link.
   */
  removeLink(
    fromType: EntityType,
    fromId: number,
    toType: EntityType,
    toId: number,
    linkType: string
  ): boolean {
    const result = this.db.prepare(`
      DELETE FROM knowledge_links
      WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND link_type = ?
    `).run(fromType, fromId, toType, toId, linkType);

    return (result as unknown as { changes: number }).changes > 0;
  }

  /**
   * Remove all links involving an entity (both directions).
   */
  removeEntityLinks(type: EntityType, id: number): number {
    const r1 = this.db.prepare(
      'DELETE FROM knowledge_links WHERE from_type = ? AND from_id = ?'
    ).run(type, id) as unknown as { changes: number };

    const r2 = this.db.prepare(
      'DELETE FROM knowledge_links WHERE to_type = ? AND to_id = ?'
    ).run(type, id) as unknown as { changes: number };

    return r1.changes + r2.changes;
  }

  // ─── Direct Queries ────────────────────────────────────────

  /**
   * Get outbound links from an entity.
   */
  getOutbound(type: EntityType, id: number, linkType?: string): KnowledgeLink[] {
    if (linkType) {
      return (this.db.prepare(
        'SELECT * FROM knowledge_links WHERE from_type = ? AND from_id = ? AND link_type = ?'
      ).all(type, id, linkType) as Record<string, unknown>[]).map(r => this.rowToLink(r));
    }
    return (this.db.prepare(
      'SELECT * FROM knowledge_links WHERE from_type = ? AND from_id = ?'
    ).all(type, id) as Record<string, unknown>[]).map(r => this.rowToLink(r));
  }

  /**
   * Get inbound links to an entity.
   */
  getInbound(type: EntityType, id: number, linkType?: string): KnowledgeLink[] {
    if (linkType) {
      return (this.db.prepare(
        'SELECT * FROM knowledge_links WHERE to_type = ? AND to_id = ? AND link_type = ?'
      ).all(type, id, linkType) as Record<string, unknown>[]).map(r => this.rowToLink(r));
    }
    return (this.db.prepare(
      'SELECT * FROM knowledge_links WHERE to_type = ? AND to_id = ?'
    ).all(type, id) as Record<string, unknown>[]).map(r => this.rowToLink(r));
  }

  /**
   * Get all links for an entity (both directions).
   */
  getLinks(type: EntityType, id: number): KnowledgeLink[] {
    return (this.db.prepare(`
      SELECT * FROM knowledge_links
      WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
      ORDER BY created_at DESC
    `).all(type, id, type, id) as Record<string, unknown>[]).map(r => this.rowToLink(r));
  }

  // ─── Traversal ─────────────────────────────────────────────

  /**
   * Breadth-first traversal from a starting entity.
   * Follows links in both directions up to maxDepth.
   * 
   * @param startType - Entity type to start from
   * @param startId - Entity ID to start from
   * @param opts - Traversal options
   * @returns Discovered nodes and edges
   */
  traverse(
    startType: EntityType,
    startId: number,
    opts?: {
      maxDepth?: number;       // Default: 3
      maxResults?: number;     // Default: 50
      linkTypes?: string[];    // Filter to specific link types
      direction?: 'outbound' | 'inbound' | 'both'; // Default: both
      targetTypes?: EntityType[]; // Filter to specific entity types
    }
  ): TraversalResult {
    const maxDepth = opts?.maxDepth ?? 3;
    const maxResults = opts?.maxResults ?? 50;
    const direction = opts?.direction ?? 'both';
    const linkTypes = opts?.linkTypes;
    const targetTypes = opts?.targetTypes;

    const visited = new Set<string>();
    const nodes: GraphNode[] = [];
    const edges: KnowledgeLink[] = [];
    let truncated = false;

    // BFS queue: [type, id, depth]
    const queue: Array<[EntityType, number, number]> = [[startType, startId, 0]];
    visited.add(`${startType}:${startId}`);

    while (queue.length > 0 && nodes.length < maxResults) {
      const [currentType, currentId, depth] = queue.shift()!;

      if (depth >= maxDepth) {
        if (depth > maxDepth) truncated = true;
        continue;
      }

      // Get neighbors
      const neighbors: Array<{ node: GraphNode; link: KnowledgeLink }> = [];

      if (direction === 'outbound' || direction === 'both') {
        const outbound = linkTypes
          ? this.getOutbound(currentType, currentId).filter(l => linkTypes.includes(l.linkType))
          : this.getOutbound(currentType, currentId);

        for (const link of outbound) {
          const nodeType = link.toType;
          if (targetTypes && !targetTypes.includes(nodeType)) continue;

          neighbors.push({
            node: {
              type: nodeType,
              id: link.toId,
              depth: depth + 1,
              linkType: link.linkType,
              direction: 'outbound',
            },
            link,
          });
        }
      }

      if (direction === 'inbound' || direction === 'both') {
        const inbound = linkTypes
          ? this.getInbound(currentType, currentId).filter(l => linkTypes.includes(l.linkType))
          : this.getInbound(currentType, currentId);

        for (const link of inbound) {
          const nodeType = link.fromType;
          if (targetTypes && !targetTypes.includes(nodeType)) continue;

          neighbors.push({
            node: {
              type: nodeType,
              id: link.fromId,
              depth: depth + 1,
              linkType: link.linkType,
              direction: 'inbound',
            },
            link,
          });
        }
      }

      for (const { node, link } of neighbors) {
        const key = `${node.type}:${node.id}`;
        if (visited.has(key)) continue;
        visited.add(key);

        if (nodes.length >= maxResults) {
          truncated = true;
          break;
        }

        nodes.push(node);
        edges.push(link);
        queue.push([node.type, node.id, node.depth]);
      }
    }

    if (queue.length > 0) truncated = true;

    return { nodes, edges, truncated };
  }

  /**
   * Find the shortest path between two entities.
   * Uses BFS — returns null if no path exists within maxDepth.
   */
  findPath(
    fromType: EntityType,
    fromId: number,
    toType: EntityType,
    toId: number,
    maxDepth: number = 5
  ): GraphNode[] | null {
    const visited = new Map<string, { parent: string | null; node: GraphNode }>();
    const startKey = `${fromType}:${fromId}`;
    const endKey = `${toType}:${toId}`;

    visited.set(startKey, {
      parent: null,
      node: { type: fromType, id: fromId, depth: 0, linkType: 'start', direction: 'outbound' },
    });

    const queue: Array<[EntityType, number, number]> = [[fromType, fromId, 0]];

    while (queue.length > 0) {
      const [currentType, currentId, depth] = queue.shift()!;
      const currentKey = `${currentType}:${currentId}`;

      if (currentKey === endKey) {
        // Reconstruct path
        const path: GraphNode[] = [];
        let key: string | null = endKey;
        while (key) {
          const entry = visited.get(key);
          if (!entry) break;
          path.unshift(entry.node);
          key = entry.parent;
        }
        return path;
      }

      if (depth >= maxDepth) continue;

      // Expand in both directions
      const allLinks = this.getLinks(currentType, currentId);
      for (const link of allLinks) {
        let nextType: EntityType;
        let nextId: number;
        let dir: 'outbound' | 'inbound';

        if (link.fromType === currentType && link.fromId === currentId) {
          nextType = link.toType;
          nextId = link.toId;
          dir = 'outbound';
        } else {
          nextType = link.fromType;
          nextId = link.fromId;
          dir = 'inbound';
        }

        const nextKey = `${nextType}:${nextId}`;
        if (visited.has(nextKey)) continue;

        const node: GraphNode = {
          type: nextType,
          id: nextId,
          depth: depth + 1,
          linkType: link.linkType,
          direction: dir,
        };

        visited.set(nextKey, { parent: currentKey, node });
        queue.push([nextType, nextId, depth + 1]);
      }
    }

    return null; // No path found
  }

  // ─── Analytics ─────────────────────────────────────────────

  /**
   * Get the most connected entities (highest degree).
   */
  getMostConnected(opts?: { type?: EntityType; limit?: number }): Array<{
    type: EntityType;
    id: number;
    degree: number;
  }> {
    const limit = opts?.limit ?? 10;

    const query = opts?.type
      ? `
        SELECT type, id, COUNT(*) as degree FROM (
          SELECT from_type as type, from_id as id FROM knowledge_links WHERE from_type = ?
          UNION ALL
          SELECT to_type as type, to_id as id FROM knowledge_links WHERE to_type = ?
        )
        GROUP BY type, id
        ORDER BY degree DESC
        LIMIT ?
      `
      : `
        SELECT type, id, COUNT(*) as degree FROM (
          SELECT from_type as type, from_id as id FROM knowledge_links
          UNION ALL
          SELECT to_type as type, to_id as id FROM knowledge_links
        )
        GROUP BY type, id
        ORDER BY degree DESC
        LIMIT ?
      `;

    const rows = opts?.type
      ? this.db.prepare(query).all(opts.type, opts.type, limit) as Array<Record<string, unknown>>
      : this.db.prepare(query).all(limit) as Array<Record<string, unknown>>;

    return rows.map(r => ({
      type: r.type as EntityType,
      id: r.id as number,
      degree: r.degree as number,
    }));
  }

  /**
   * Count links by type.
   */
  getLinkStats(): Array<{ linkType: string; count: number }> {
    const rows = this.db.prepare(
      'SELECT link_type, COUNT(*) as count FROM knowledge_links GROUP BY link_type ORDER BY count DESC'
    ).all() as Array<Record<string, unknown>>;

    return rows.map(r => ({
      linkType: r.link_type as string,
      count: r.count as number,
    }));
  }

  /**
   * Total link count.
   */
  getTotalLinks(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as count FROM knowledge_links'
    ).get() as { count: number };
    return row.count;
  }

  // ─── Helpers ───────────────────────────────────────────────

  private rowToLink(row: Record<string, unknown>): KnowledgeLink {
    return {
      id: row.id as number,
      fromType: row.from_type as EntityType,
      fromId: row.from_id as number,
      toType: row.to_type as EntityType,
      toId: row.to_id as number,
      linkType: row.link_type as string,
      createdAt: row.created_at as string,
    };
  }
}
