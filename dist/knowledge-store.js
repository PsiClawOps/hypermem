/**
 * hypermem Knowledge Store
 *
 * Long-term structured knowledge — replaces MEMORY.md.
 * Lives in the central library DB.
 * Knowledge entries are keyed (domain + key), versioned via superseded_by,
 * and linked to each other via knowledge_links.
 */
import { isSafeForSharedVisibility, requiresScan } from './secret-scanner.js';
function nowIso() {
    return new Date().toISOString();
}
function parseKnowledgeRow(row) {
    return {
        id: row.id,
        agentId: row.agent_id,
        domain: row.domain,
        key: row.key,
        content: row.content,
        confidence: row.confidence,
        sourceType: row.source_type,
        sourceRef: row.source_ref || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at || null,
        supersededBy: row.superseded_by || null,
    };
}
export class KnowledgeStore {
    db;
    constructor(db) {
        this.db = db;
    }
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
    upsert(agentId, domain, key, content, opts) {
        const now = nowIso();
        const sourceType = opts?.sourceType || 'manual';
        const confidence = opts?.confidence ?? 1.0;
        // Secret gate: if requested visibility is shared, verify content is clean.
        // Downgrade to 'private' rather than reject — matches episode-store pattern.
        let visibility = opts?.visibility ?? 'private';
        if (requiresScan(visibility) && !isSafeForSharedVisibility(content)) {
            visibility = 'private';
        }
        // Find current active entry (not superseded, not expired)
        const existing = this.db.prepare(`
      SELECT * FROM knowledge
      WHERE agent_id = ? AND domain = ? AND key = ?
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY version DESC LIMIT 1
    `).get(agentId, domain, key);
        if (existing && existing.content === content) {
            // Same content — refresh confidence/timestamp and synthesis metadata
            // (source_ref, source_type, expires_at) so watermark-style refs advance
            // without minting a new version row.
            const nextSourceRef = opts?.sourceRef !== undefined
                ? opts.sourceRef
                : (existing.source_ref ?? null);
            const nextSourceType = opts?.sourceType !== undefined
                ? sourceType
                : (existing.source_type ?? sourceType);
            const nextExpiresAt = opts?.expiresAt !== undefined
                ? opts.expiresAt
                : (existing.expires_at ?? null);
            this.db.prepare(`UPDATE knowledge
           SET confidence = ?, updated_at = ?, source_ref = ?, source_type = ?, expires_at = ?
         WHERE id = ?`).run(confidence, now, nextSourceRef, nextSourceType, nextExpiresAt, existing.id);
            return parseKnowledgeRow({
                ...existing,
                confidence,
                updated_at: now,
                source_ref: nextSourceRef,
                source_type: nextSourceType,
                expires_at: nextExpiresAt,
            });
        }
        // Determine next version number
        const maxVersionRow = this.db.prepare(`
      SELECT MAX(version) AS max_version FROM knowledge
      WHERE agent_id = ? AND domain = ? AND key = ?
    `).get(agentId, domain, key);
        const nextVersion = (maxVersionRow?.max_version ?? 0) + 1;
        // Insert new version row (no ON CONFLICT — version column ensures uniqueness)
        const result = this.db.prepare(`
      INSERT INTO knowledge
        (agent_id, domain, key, version, content, confidence, visibility, source_type, source_ref,
         created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(agentId, domain, key, nextVersion, content, confidence, visibility, sourceType, opts?.sourceRef ?? null, now, now, opts?.expiresAt ?? null);
        const newId = result.lastInsertRowid;
        // Mark previous active entry as superseded by this new version
        if (existing) {
            this.db.prepare('UPDATE knowledge SET superseded_by = ?, updated_at = ? WHERE id = ?').run(newId, now, existing.id);
            // Link: new version supersedes old version
            this.addLink(newId, existing.id, 'supersedes');
        }
        return {
            id: newId,
            agentId,
            domain,
            key,
            content,
            confidence,
            sourceType,
            sourceRef: opts?.sourceRef ?? null,
            createdAt: now,
            updatedAt: now,
            expiresAt: opts?.expiresAt ?? null,
            supersededBy: null,
        };
    }
    /**
     * Get current (non-superseded) knowledge for an agent.
     */
    getActive(agentId, opts) {
        let sql = `
      SELECT * FROM knowledge
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    `;
        const params = [agentId];
        if (opts?.domain) {
            sql += ' AND domain = ?';
            params.push(opts.domain);
        }
        sql += ' ORDER BY domain, key';
        if (opts?.limit) {
            sql += ' LIMIT ?';
            params.push(opts.limit);
        }
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseKnowledgeRow);
    }
    /**
     * Get a specific knowledge entry by domain + key.
     */
    get(agentId, domain, key) {
        const row = this.db.prepare(`
      SELECT * FROM knowledge
      WHERE agent_id = ? AND domain = ? AND key = ?
      AND superseded_by IS NULL
    `).get(agentId, domain, key);
        return row ? parseKnowledgeRow(row) : null;
    }
    /**
     * Get the version history of a knowledge entry.
     */
    getHistory(agentId, domain, key) {
        const rows = this.db.prepare(`
      SELECT * FROM knowledge
      WHERE agent_id = ? AND domain = ? AND key = ?
      ORDER BY created_at DESC
    `).all(agentId, domain, key);
        return rows.map(parseKnowledgeRow);
    }
    /**
     * Search knowledge by content.
     */
    search(agentId, query, limit = 20) {
        const rows = this.db.prepare(`
      SELECT * FROM knowledge
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (content LIKE ? OR key LIKE ?)
      ORDER BY confidence DESC
      LIMIT ?
    `).all(agentId, `%${query}%`, `%${query}%`, limit);
        return rows.map(parseKnowledgeRow);
    }
    /**
     * List all domains for an agent.
     */
    getDomains(agentId) {
        const rows = this.db.prepare(`
      SELECT DISTINCT domain FROM knowledge
      WHERE agent_id = ? AND superseded_by IS NULL
      ORDER BY domain
    `).all(agentId);
        return rows.map(r => r.domain);
    }
    /**
     * Add a link between knowledge entries.
     */
    addLink(fromId, toId, linkType) {
        this.db.prepare(`
      INSERT OR IGNORE INTO knowledge_links (from_type, from_id, to_type, to_id, link_type, created_at)
      VALUES ('knowledge', ?, 'knowledge', ?, ?, ?)
    `).run(fromId, toId, linkType, nowIso());
    }
    /**
     * Get knowledge count.
     */
    getCount(agentId) {
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM knowledge WHERE agent_id = ? AND superseded_by IS NULL').get(agentId);
        return row.count;
    }
    /**
     * Import from MEMORY.md content.
     * Parses markdown sections into domain/key/content entries.
     */
    importFromMarkdown(agentId, markdown, sourcePath) {
        const lines = markdown.split('\n');
        let currentDomain = 'general';
        let currentKey = '';
        let currentContent = [];
        let imported = 0;
        const flush = () => {
            if (currentKey && currentContent.length > 0) {
                this.upsert(agentId, currentDomain, currentKey, currentContent.join('\n').trim(), {
                    sourceType: 'manual',
                    sourceRef: sourcePath,
                });
                imported++;
            }
            currentContent = [];
        };
        for (const line of lines) {
            // ## Section = domain
            if (line.startsWith('## ')) {
                flush();
                currentDomain = line.replace('## ', '').trim().toLowerCase().replace(/\s+/g, '_');
                currentKey = '';
                continue;
            }
            // ### Subsection or **Bold** = key
            if (line.startsWith('### ')) {
                flush();
                currentKey = line.replace('### ', '').trim();
                continue;
            }
            // - **Key:** Value pattern
            const kvMatch = line.match(/^[-*]\s+\*\*(.+?)\*\*[:\s]+(.+)/);
            if (kvMatch) {
                flush();
                currentKey = kvMatch[1].trim();
                currentContent.push(kvMatch[2].trim());
                continue;
            }
            // Regular content line
            if (currentKey) {
                currentContent.push(line);
            }
            else if (line.trim()) {
                // Content without a key — use line hash as key
                currentKey = `note_${lines.indexOf(line)}`;
                currentContent.push(line);
            }
        }
        flush();
        return imported;
    }
}
//# sourceMappingURL=knowledge-store.js.map