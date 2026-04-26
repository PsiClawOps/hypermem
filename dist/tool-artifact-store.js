/**
 * Tool Artifact Store
 *
 * Durable, addressable storage for full tool result payloads. Schema v9.
 *
 * Why: the wave-guard at ingest time replaces oversized tool result payloads
 * with a small stub for pressure relief. Before this store existed, the full
 * payload was discarded. Now the stub in the transcript carries an
 * `artifactId` pointing at the durable copy here, and hydration is an
 * explicit decision, not an automatic transcript rewrite.
 *
 * Retention is deliberately independent of transcript eviction. Artifacts
 * outlive the messages that referenced them, and GC is a separate concern
 * (Phase 2).
 *
 * See: specs/TOOL_ARTIFACT_STORE.md
 */
import { createHash, randomBytes } from 'node:crypto';
/**
 * Simple char/4 heuristic matching src/compositor.ts estimateTokens().
 * Kept local to avoid a cyclic import and keep the store self-contained.
 */
function estimateTokens(text) {
    if (!text)
        return 0;
    return Math.ceil(text.length / 4);
}
function nowIso() {
    return new Date().toISOString();
}
function newArtifactId() {
    // 24-char lowercase id. Deliberately NOT a UUID — shorter, fits the stub
    // length cap in src/degradation.ts (DEGRADATION_LIMITS.artifactId = 64).
    return 'art_' + randomBytes(10).toString('hex');
}
function sha256Hex(s) {
    return createHash('sha256').update(s).digest('hex');
}
function rowToRecord(row) {
    return {
        id: row.id,
        contentHash: row.content_hash,
        agentId: row.agent_id,
        sessionKey: row.session_key,
        conversationId: row.conversation_id ?? null,
        messageId: row.message_id ?? null,
        turnId: row.turn_id ?? null,
        toolCallId: row.tool_call_id ?? null,
        toolName: row.tool_name,
        isError: row.is_error === 1,
        contentType: row.content_type,
        sizeBytes: row.size_bytes,
        tokenEstimate: row.token_estimate,
        payload: row.payload,
        summary: row.summary ?? null,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        refCount: row.ref_count,
        isSensitive: row.is_sensitive === 1,
    };
}
export class ToolArtifactStore {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Insert a new artifact, or dedupe against an existing one in the same
     * (agentId, sessionKey) scope. Dedupe is scoped to a session so distinct
     * sessions can't leak artifact ids across each other even when payload
     * content is identical.
     */
    put(input) {
        const payload = input.payload ?? '';
        const contentHash = sha256Hex(payload);
        const sizeBytes = Buffer.byteLength(payload, 'utf8');
        const tokenEstimate = estimateTokens(payload);
        const contentType = input.contentType ?? 'text/plain';
        const isError = input.isError ? 1 : 0;
        const isSensitive = input.isSensitive ? 1 : 0;
        // Dedupe within (agentId, sessionKey) — same hash bumps ref_count and
        // updates last_used_at, returning the existing record.
        const existing = this.db
            .prepare(`SELECT * FROM tool_artifacts
           WHERE agent_id = ? AND session_key = ? AND content_hash = ?
           LIMIT 1`)
            .get(input.agentId, input.sessionKey, contentHash);
        if (existing) {
            const ts = nowIso();
            this.db
                .prepare(`UPDATE tool_artifacts
             SET ref_count = ref_count + 1,
                 last_used_at = ?
             WHERE id = ?`)
                .run(ts, existing.id);
            return rowToRecord({ ...existing, ref_count: existing.ref_count + 1, last_used_at: ts, is_sensitive: existing.is_sensitive ?? 0 });
        }
        const id = newArtifactId();
        const ts = nowIso();
        this.db
            .prepare(`INSERT INTO tool_artifacts (
            id, content_hash, agent_id, session_key,
            conversation_id, message_id, turn_id, tool_call_id,
            tool_name, is_error, content_type,
            size_bytes, token_estimate, payload, summary,
            created_at, last_used_at, ref_count, is_sensitive
          ) VALUES (?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, 1, ?)`)
            .run(id, contentHash, input.agentId, input.sessionKey, input.conversationId ?? null, input.messageId ?? null, input.turnId ?? null, input.toolCallId ?? null, input.toolName, isError, contentType, sizeBytes, tokenEstimate, payload, input.summary ?? null, ts, ts, isSensitive);
        return {
            id,
            contentHash,
            agentId: input.agentId,
            sessionKey: input.sessionKey,
            conversationId: input.conversationId ?? null,
            messageId: input.messageId ?? null,
            turnId: input.turnId ?? null,
            toolCallId: input.toolCallId ?? null,
            toolName: input.toolName,
            isError: input.isError ?? false,
            contentType,
            sizeBytes,
            tokenEstimate,
            payload,
            summary: input.summary ?? null,
            createdAt: ts,
            lastUsedAt: ts,
            refCount: 1,
            isSensitive: input.isSensitive ?? false,
        };
    }
    /** Alias for get(id) — explicit name used by the compositor hydration pass. */
    getById(id) {
        return this.get(id);
    }
    get(id) {
        const row = this.db
            .prepare('SELECT * FROM tool_artifacts WHERE id = ? LIMIT 1')
            .get(id);
        return row ? rowToRecord(row) : null;
    }
    getByHash(agentId, sessionKey, contentHash) {
        const row = this.db
            .prepare(`SELECT * FROM tool_artifacts
           WHERE agent_id = ? AND session_key = ? AND content_hash = ?
           ORDER BY created_at DESC
           LIMIT 1`)
            .get(agentId, sessionKey, contentHash);
        return row ? rowToRecord(row) : null;
    }
    listByTurn(sessionKey, turnId) {
        const rows = this.db
            .prepare(`SELECT * FROM tool_artifacts
           WHERE session_key = ? AND turn_id = ?
           ORDER BY created_at ASC`)
            .all(sessionKey, turnId);
        return rows.map(rowToRecord);
    }
    listByToolCall(toolCallId) {
        const rows = this.db
            .prepare(`SELECT * FROM tool_artifacts
           WHERE tool_call_id = ?
           ORDER BY created_at ASC`)
            .all(toolCallId);
        return rows.map(rowToRecord);
    }
    listRecent(agentId, sessionKey, limit = 20) {
        const rows = this.db
            .prepare(`SELECT * FROM tool_artifacts
           WHERE agent_id = ? AND session_key = ?
           ORDER BY created_at DESC
           LIMIT ?`)
            .all(agentId, sessionKey, limit);
        return rows.map(rowToRecord);
    }
    /** Update last_used_at — call this when hydration actually surfaces the payload. */
    touch(id) {
        this.db
            .prepare('UPDATE tool_artifacts SET last_used_at = ? WHERE id = ?')
            .run(nowIso(), id);
    }
    /**
     * GC sweep: delete artifacts that exceed their TTL or per-session count cap.
     * Returns total rows deleted.
     *
     * Sensitive artifacts use sensitiveTtlMs (shorter); standard artifacts use
     * standardTtlMs. Optional maxPerSession bounds row count per (agent, session)
     * using a ROW_NUMBER() window query — oldest last_used_at removed first.
     */
    sweep(policy) {
        const now = Date.now();
        const standardCutoff = new Date(now - policy.standardTtlMs).toISOString();
        const sensitiveCutoff = new Date(now - policy.sensitiveTtlMs).toISOString();
        const ttlResult = this.db
            .prepare(`DELETE FROM tool_artifacts
           WHERE (is_sensitive = 0 AND last_used_at < ?)
              OR (is_sensitive = 1 AND last_used_at < ?)`)
            .run(standardCutoff, sensitiveCutoff);
        let deleted = ttlResult.changes ?? 0;
        if (policy.maxPerSession != null) {
            const boundResult = this.db
                .prepare(`DELETE FROM tool_artifacts
             WHERE id IN (
               SELECT id FROM (
                 SELECT id,
                        ROW_NUMBER() OVER (
                          PARTITION BY agent_id, session_key
                          ORDER BY last_used_at DESC
                        ) AS rn
                 FROM tool_artifacts
               )
               WHERE rn > ?
             )`)
                .run(policy.maxPerSession);
            deleted += boundResult.changes ?? 0;
        }
        return deleted;
    }
    /**
     * Delete artifacts whose last_used_at is older than the ISO cutoff.
     * Returns the number of rows deleted. Phase 1: manual invocation only.
     */
    deleteOlderThan(isoCutoff) {
        const result = this.db
            .prepare('DELETE FROM tool_artifacts WHERE last_used_at < ?')
            .run(isoCutoff);
        return Number(result.changes ?? 0);
    }
    /** Debug / ops: row count across a session. */
    count(agentId, sessionKey) {
        if (agentId && sessionKey) {
            const row = this.db
                .prepare('SELECT COUNT(*) AS n FROM tool_artifacts WHERE agent_id = ? AND session_key = ?')
                .get(agentId, sessionKey);
            return row?.n ?? 0;
        }
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM tool_artifacts').get();
        return row?.n ?? 0;
    }
}
//# sourceMappingURL=tool-artifact-store.js.map