/**
 * hypermem Fact Store
 *
 * CRUD operations for facts (extracted knowledge that spans sessions).
 * Facts live in the central library DB, tagged by agent_id.
 * Facts have scope (agent/session/user), confidence, and decay.
 */
import { isSafeForSharedVisibility, requiresScan } from './secret-scanner.js';
function nowIso() {
    return new Date().toISOString();
}
function parseFactRow(row) {
    return {
        id: row.id,
        agentId: row.agent_id,
        scope: row.scope,
        domain: row.domain || null,
        content: row.content,
        confidence: row.confidence,
        visibility: row.visibility || 'private',
        sourceType: row.source_type || 'conversation',
        sourceSessionKey: row.source_session_key || null,
        sourceRef: row.source_ref || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at || null,
        supersededBy: row.superseded_by || null,
        decayScore: row.decay_score,
        validFrom: row.valid_from || null,
        invalidAt: row.invalid_at || null,
    };
}
export class FactStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Add a new fact. Checks for duplicates by content.
     */
    addFact(agentId, content, opts) {
        const now = nowIso();
        const scope = opts?.scope || 'agent';
        // KL-01: global scope is not yet supported — write gate is deferred to 1.0.
        // Log a warning if a caller somehow passes scope='global' (e.g. direct DB
        // access bypassing TypeScript types or a future FactScope addition).
        if (scope === 'global') {
            console.warn(`[hypermem] WARNING: agent '${agentId}' attempted to write a fact with scope='global'. ` +
                `Global-scope facts are not yet gated — this write will succeed but may propagate ` +
                `to all agents sharing library.db. Configure fact write authority before enabling global-scope facts.`);
        }
        // Secret gate: if requested visibility is shared, verify content is clean.
        // Downgrade to 'private' rather than reject — matches episode-store pattern.
        let resolvedVisibility = opts?.visibility || 'private';
        if (requiresScan(resolvedVisibility) && !isSafeForSharedVisibility(content)) {
            resolvedVisibility = 'private';
        }
        // Check for exact duplicate
        const existing = this.db.prepare(`
      SELECT * FROM facts WHERE agent_id = ? AND content = ? AND scope = ?
    `).get(agentId, content, scope);
        if (existing) {
            this.db.prepare(`
        UPDATE facts SET confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?
      `).run(opts?.confidence || 1.0, now, existing.id);
            return parseFactRow({ ...existing, updated_at: now });
        }
        const result = this.db.prepare(`
      INSERT INTO facts (agent_id, scope, domain, content, confidence,
        visibility, source_type, source_session_key, source_ref,
        created_at, updated_at, expires_at, decay_score, valid_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0, ?)
    `).run(agentId, scope, opts?.domain || null, content, opts?.confidence || 1.0, resolvedVisibility, opts?.sourceType || 'conversation', opts?.sourceSessionKey || null, opts?.sourceRef || null, now, now, opts?.expiresAt || null, now);
        const id = Number(result.lastInsertRowid);
        return {
            id,
            agentId,
            scope,
            domain: opts?.domain || null,
            content,
            confidence: opts?.confidence || 1.0,
            visibility: resolvedVisibility,
            sourceType: opts?.sourceType || 'conversation',
            sourceSessionKey: opts?.sourceSessionKey || null,
            sourceRef: opts?.sourceRef || null,
            createdAt: now,
            updatedAt: now,
            expiresAt: opts?.expiresAt || null,
            supersededBy: null,
            decayScore: 0,
            validFrom: now,
            invalidAt: null,
        };
    }
    /**
     * Get active facts for an agent.
     */
    getActiveFacts(agentId, opts) {
        let sql = `
      SELECT * FROM facts
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      AND decay_score < 0.8
    `;
        const params = [agentId];
        if (opts?.scope) {
            sql += ' AND scope = ?';
            params.push(opts.scope);
        }
        if (opts?.domain) {
            sql += ' AND domain = ?';
            params.push(opts.domain);
        }
        if (opts?.minConfidence) {
            sql += ' AND confidence >= ?';
            params.push(opts.minConfidence);
        }
        sql += ' ORDER BY confidence DESC, decay_score ASC';
        if (opts?.limit) {
            sql += ' LIMIT ?';
            params.push(opts.limit);
        }
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseFactRow);
    }
    /**
     * Full-text search facts.
     */
    searchFacts(query, opts) {
        const limit = opts?.limit || 20;
        const hasFilters = !!(opts?.agentId || opts?.domain || opts?.visibility);
        const innerLimit = hasFilters ? limit * 4 : limit;
        // Two-phase: FTS in subquery, then filter on small set.  See hybrid-retrieval.ts.
        let sql = `
      SELECT f.* FROM (
        SELECT rowid, rank FROM facts_fts WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?
      ) sub
      JOIN facts f ON f.id = sub.rowid
      WHERE f.superseded_by IS NULL
      AND f.decay_score < 0.8
    `;
        const params = [query, innerLimit];
        if (opts?.agentId) {
            sql += ' AND f.agent_id = ?';
            params.push(opts.agentId);
        }
        if (opts?.domain) {
            sql += ' AND f.domain = ?';
            params.push(opts.domain);
        }
        if (opts?.visibility) {
            sql += ' AND f.visibility = ?';
            params.push(opts.visibility);
        }
        sql += ' ORDER BY sub.rank LIMIT ?';
        params.push(limit);
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseFactRow);
    }
    /**
     * Mark an old fact as superseded by a new one.
     *
     * Sets `superseded_by` on the old fact row so it is excluded from active
     * retrieval queries (both FTS and KNN paths check `superseded_by IS NULL`).
     * Returns false if the fact is already superseded or does not exist.
     */
    markSuperseded(oldFactId, newFactId) {
        const now = new Date().toISOString();
        const result = this.db
            .prepare(`
        UPDATE facts
        SET superseded_by = ?, invalid_at = ?, updated_at = ?
        WHERE id = ? AND superseded_by IS NULL
      `)
            .run(newFactId, now, now, oldFactId);
        return result.changes > 0;
    }
    /**
     * Find the most recent active fact for an agent whose content is a near-duplicate
     * of the given content (same first 100 chars, different suffix, or same domain+topic).
     * Used by the background indexer to detect supersedes relationships.
     *
     * Returns the existing fact id if a candidate is found, otherwise null.
     */
    findSupersedableByContent(agentId, content, opts) {
        // Look for active facts from the same agent whose content starts with the
        // same 60-character prefix (covers rephrased facts about the same topic).
        const prefix = content.slice(0, 60);
        const params = [agentId, `${prefix}%`];
        let sql = `
      SELECT id FROM facts
      WHERE agent_id = ?
        AND content LIKE ?
        AND content != ?
        AND superseded_by IS NULL
    `;
        params.push(content);
        if (opts?.domain) {
            sql += ' AND domain = ?';
            params.push(opts.domain);
        }
        sql += ' ORDER BY created_at DESC LIMIT 1';
        const row = this.db.prepare(sql).get(...params);
        return row?.id ?? null;
    }
    /**
     * Decay all facts by a fixed rate.
     */
    decayFacts(agentId, decayRate = 0.01) {
        const result = this.db.prepare(`
      UPDATE facts
      SET decay_score = MIN(decay_score + ?, 1.0), updated_at = ?
      WHERE agent_id = ? AND decay_score < 1.0
    `).run(decayRate, nowIso(), agentId);
        return result.changes;
    }
    /**
     * Remove expired and fully decayed facts.
     */
    pruneFacts(agentId) {
        const result = this.db.prepare(`
      DELETE FROM facts
      WHERE agent_id = ?
      AND (
        (expires_at IS NOT NULL AND expires_at < datetime('now'))
        OR decay_score >= 1.0
      )
    `).run(agentId);
        return result.changes;
    }
    /**
     * Get fact count for an agent.
     */
    getFactCount(agentId) {
        const row = this.db.prepare('SELECT COUNT(*) AS count FROM facts WHERE agent_id = ?').get(agentId);
        return row.count;
    }
    /**
     * Get facts that were valid at a specific point in time.
     * Returns facts where valid_from <= dateMs AND (invalid_at IS NULL OR invalid_at > dateMs).
     * This enables "what was true on date X?" queries (Zep-competitive).
     */
    getFactsValidAt(agentId, dateMs, opts) {
        const dateIso = new Date(dateMs).toISOString();
        let sql = `
      SELECT * FROM facts
      WHERE agent_id = ?
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (invalid_at IS NULL OR invalid_at > ?)
      AND superseded_by IS NULL
      AND decay_score < 0.8
    `;
        const params = [agentId, dateIso, dateIso];
        if (opts?.domain) {
            sql += ' AND domain = ?';
            params.push(opts.domain);
        }
        sql += ' ORDER BY confidence DESC, decay_score ASC';
        if (opts?.limit) {
            sql += ' LIMIT ?';
            params.push(opts.limit);
        }
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseFactRow);
    }
    /**
     * Mark a fact as invalid at a specific time (or now).
     * Unlike supersede, this doesn't require a replacement fact.
     * Used by contradiction detection to mark stale facts.
     */
    invalidateFact(factId, atDate) {
        const invalidAt = atDate || new Date().toISOString();
        const result = this.db
            .prepare(`
        UPDATE facts SET invalid_at = ?, updated_at = ?
        WHERE id = ? AND invalid_at IS NULL
      `)
            .run(invalidAt, invalidAt, factId);
        return result.changes > 0;
    }
}
//# sourceMappingURL=fact-store.js.map