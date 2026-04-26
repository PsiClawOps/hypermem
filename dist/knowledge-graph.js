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
function nowIso() {
    return new Date().toISOString();
}
export class KnowledgeGraph {
    db;
    constructor(db) {
        this.db = db;
    }
    // ─── Link Management ───────────────────────────────────────
    /**
     * Create a directed link between two entities.
     * Idempotent — unique constraint on (from_type, from_id, to_type, to_id, link_type).
     */
    addLink(fromType, fromId, toType, toId, linkType) {
        const now = nowIso();
        this.db.prepare(`
      INSERT OR IGNORE INTO knowledge_links (from_type, from_id, to_type, to_id, link_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(fromType, fromId, toType, toId, linkType, now);
        const row = this.db.prepare(`
      SELECT * FROM knowledge_links
      WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND link_type = ?
    `).get(fromType, fromId, toType, toId, linkType);
        return this.rowToLink(row);
    }
    /**
     * Remove a specific link.
     */
    removeLink(fromType, fromId, toType, toId, linkType) {
        const result = this.db.prepare(`
      DELETE FROM knowledge_links
      WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND link_type = ?
    `).run(fromType, fromId, toType, toId, linkType);
        return result.changes > 0;
    }
    /**
     * Remove all links involving an entity (both directions).
     */
    removeEntityLinks(type, id) {
        const r1 = this.db.prepare('DELETE FROM knowledge_links WHERE from_type = ? AND from_id = ?').run(type, id);
        const r2 = this.db.prepare('DELETE FROM knowledge_links WHERE to_type = ? AND to_id = ?').run(type, id);
        return r1.changes + r2.changes;
    }
    // ─── Direct Queries ────────────────────────────────────────
    /**
     * Get outbound links from an entity.
     */
    getOutbound(type, id, linkType) {
        if (linkType) {
            return this.db.prepare('SELECT * FROM knowledge_links WHERE from_type = ? AND from_id = ? AND link_type = ?').all(type, id, linkType).map(r => this.rowToLink(r));
        }
        return this.db.prepare('SELECT * FROM knowledge_links WHERE from_type = ? AND from_id = ?').all(type, id).map(r => this.rowToLink(r));
    }
    /**
     * Get inbound links to an entity.
     */
    getInbound(type, id, linkType) {
        if (linkType) {
            return this.db.prepare('SELECT * FROM knowledge_links WHERE to_type = ? AND to_id = ? AND link_type = ?').all(type, id, linkType).map(r => this.rowToLink(r));
        }
        return this.db.prepare('SELECT * FROM knowledge_links WHERE to_type = ? AND to_id = ?').all(type, id).map(r => this.rowToLink(r));
    }
    /**
     * Get all links for an entity (both directions).
     */
    getLinks(type, id) {
        return this.db.prepare(`
      SELECT * FROM knowledge_links
      WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
      ORDER BY created_at DESC
    `).all(type, id, type, id).map(r => this.rowToLink(r));
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
    traverse(startType, startId, opts) {
        const maxDepth = opts?.maxDepth ?? 3;
        const maxResults = opts?.maxResults ?? 50;
        const direction = opts?.direction ?? 'both';
        const linkTypes = opts?.linkTypes;
        const targetTypes = opts?.targetTypes;
        const visited = new Set();
        const nodes = [];
        const edges = [];
        let truncated = false;
        // BFS queue: [type, id, depth]
        const queue = [[startType, startId, 0]];
        visited.add(`${startType}:${startId}`);
        while (queue.length > 0 && nodes.length < maxResults) {
            const [currentType, currentId, depth] = queue.shift();
            if (depth >= maxDepth) {
                if (depth > maxDepth)
                    truncated = true;
                continue;
            }
            // Get neighbors
            const neighbors = [];
            if (direction === 'outbound' || direction === 'both') {
                const outbound = linkTypes
                    ? this.getOutbound(currentType, currentId).filter(l => linkTypes.includes(l.linkType))
                    : this.getOutbound(currentType, currentId);
                for (const link of outbound) {
                    const nodeType = link.toType;
                    if (targetTypes && !targetTypes.includes(nodeType))
                        continue;
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
                    if (targetTypes && !targetTypes.includes(nodeType))
                        continue;
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
                if (visited.has(key))
                    continue;
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
        if (queue.length > 0)
            truncated = true;
        return { nodes, edges, truncated };
    }
    /**
     * Find the shortest path between two entities.
     * Uses BFS — returns null if no path exists within maxDepth.
     */
    findPath(fromType, fromId, toType, toId, maxDepth = 5) {
        const visited = new Map();
        const startKey = `${fromType}:${fromId}`;
        const endKey = `${toType}:${toId}`;
        visited.set(startKey, {
            parent: null,
            node: { type: fromType, id: fromId, depth: 0, linkType: 'start', direction: 'outbound' },
        });
        const queue = [[fromType, fromId, 0]];
        while (queue.length > 0) {
            const [currentType, currentId, depth] = queue.shift();
            const currentKey = `${currentType}:${currentId}`;
            if (currentKey === endKey) {
                // Reconstruct path
                const path = [];
                let key = endKey;
                while (key) {
                    const entry = visited.get(key);
                    if (!entry)
                        break;
                    path.unshift(entry.node);
                    key = entry.parent;
                }
                return path;
            }
            if (depth >= maxDepth)
                continue;
            // Expand in both directions
            const allLinks = this.getLinks(currentType, currentId);
            for (const link of allLinks) {
                let nextType;
                let nextId;
                let dir;
                if (link.fromType === currentType && link.fromId === currentId) {
                    nextType = link.toType;
                    nextId = link.toId;
                    dir = 'outbound';
                }
                else {
                    nextType = link.fromType;
                    nextId = link.fromId;
                    dir = 'inbound';
                }
                const nextKey = `${nextType}:${nextId}`;
                if (visited.has(nextKey))
                    continue;
                const node = {
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
    getMostConnected(opts) {
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
            ? this.db.prepare(query).all(opts.type, opts.type, limit)
            : this.db.prepare(query).all(limit);
        return rows.map(r => ({
            type: r.type,
            id: r.id,
            degree: r.degree,
        }));
    }
    /**
     * Count links by type.
     */
    getLinkStats() {
        const rows = this.db.prepare('SELECT link_type, COUNT(*) as count FROM knowledge_links GROUP BY link_type ORDER BY count DESC').all();
        return rows.map(r => ({
            linkType: r.link_type,
            count: r.count,
        }));
    }
    /**
     * Total link count.
     */
    getTotalLinks() {
        const row = this.db.prepare('SELECT COUNT(*) as count FROM knowledge_links').get();
        return row.count;
    }
    // ─── Helpers ───────────────────────────────────────────────
    rowToLink(row) {
        return {
            id: row.id,
            fromType: row.from_type,
            fromId: row.from_id,
            toType: row.to_type,
            toId: row.to_id,
            linkType: row.link_type,
            createdAt: row.created_at,
        };
    }
}
//# sourceMappingURL=knowledge-graph.js.map