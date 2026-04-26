/**
 * hypermem Preference Store
 *
 * Behavioral patterns observed about people, systems, and workflows.
 * Lives in the central library DB.
 * "operator prefers architectural stability" is a preference, not a fact.
 */
function nowIso() {
    return new Date().toISOString();
}
function parseRow(row) {
    return {
        id: row.id,
        subject: row.subject,
        domain: row.domain,
        key: row.key,
        value: row.value,
        agentId: row.agent_id,
        confidence: row.confidence,
        visibility: row.visibility || 'fleet',
        sourceType: row.source_type || 'observation',
        sourceRef: row.source_ref || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
export class PreferenceStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Set or update a preference. Upserts on (subject, domain, key).
     */
    set(subject, key, value, opts) {
        const now = nowIso();
        const domain = opts?.domain || 'general';
        const result = this.db.prepare(`
      INSERT INTO preferences (subject, domain, key, value, agent_id, confidence,
        visibility, source_type, source_ref, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject, domain, key) DO UPDATE SET
        value = excluded.value,
        confidence = excluded.confidence,
        agent_id = excluded.agent_id,
        source_type = excluded.source_type,
        source_ref = excluded.source_ref,
        updated_at = excluded.updated_at
    `).run(subject, domain, key, value, opts?.agentId || 'system', opts?.confidence || 1.0, opts?.visibility || 'fleet', opts?.sourceType || 'observation', opts?.sourceRef || null, now, now);
        const id = Number(result.lastInsertRowid);
        return {
            id,
            subject,
            domain,
            key,
            value,
            agentId: opts?.agentId || 'system',
            confidence: opts?.confidence || 1.0,
            visibility: opts?.visibility || 'fleet',
            sourceType: opts?.sourceType || 'observation',
            sourceRef: opts?.sourceRef || null,
            createdAt: now,
            updatedAt: now,
        };
    }
    /**
     * Get a specific preference.
     */
    get(subject, key, domain = 'general') {
        const row = this.db.prepare('SELECT * FROM preferences WHERE subject = ? AND domain = ? AND key = ?').get(subject, domain, key);
        return row ? parseRow(row) : null;
    }
    /**
     * Get all preferences for a subject.
     */
    getForSubject(subject, domain) {
        let sql = 'SELECT * FROM preferences WHERE subject = ?';
        const params = [subject];
        if (domain) {
            sql += ' AND domain = ?';
            params.push(domain);
        }
        sql += ' ORDER BY domain, key';
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseRow);
    }
    /**
     * Search preferences by value content.
     */
    search(query, subject) {
        let sql = 'SELECT * FROM preferences WHERE (value LIKE ? OR key LIKE ?)';
        const params = [`%${query}%`, `%${query}%`];
        if (subject) {
            sql += ' AND subject = ?';
            params.push(subject);
        }
        sql += ' ORDER BY confidence DESC LIMIT 20';
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(parseRow);
    }
    /**
     * Delete a preference.
     */
    delete(subject, key, domain = 'general') {
        const result = this.db.prepare('DELETE FROM preferences WHERE subject = ? AND domain = ? AND key = ?').run(subject, domain, key);
        return result.changes > 0;
    }
}
//# sourceMappingURL=preference-store.js.map