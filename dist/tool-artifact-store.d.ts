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
import type { DatabaseSync } from 'node:sqlite';
export interface ToolArtifactRetentionPolicy {
    /** TTL in ms for non-sensitive artifacts (e.g. 7 * 24 * 60 * 60 * 1000). */
    standardTtlMs: number;
    /** TTL in ms for sensitive artifacts. Should be <= standardTtlMs. */
    sensitiveTtlMs: number;
    /** Optional: max artifacts to keep per (agent_id, session_key). Excess removed oldest-first. */
    maxPerSession?: number;
}
export interface ToolArtifactRecord {
    id: string;
    contentHash: string;
    agentId: string;
    sessionKey: string;
    conversationId: number | null;
    messageId: number | null;
    turnId: string | null;
    toolCallId: string | null;
    toolName: string;
    isError: boolean;
    contentType: string;
    sizeBytes: number;
    tokenEstimate: number;
    payload: string;
    summary: string | null;
    createdAt: string;
    lastUsedAt: string;
    refCount: number;
    isSensitive: boolean;
}
export interface PutToolArtifactInput {
    agentId: string;
    sessionKey: string;
    conversationId?: number;
    messageId?: number;
    turnId?: string;
    toolCallId?: string;
    toolName: string;
    isError?: boolean;
    contentType?: string;
    payload: string;
    summary?: string;
    isSensitive?: boolean;
}
export declare class ToolArtifactStore {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Insert a new artifact, or dedupe against an existing one in the same
     * (agentId, sessionKey) scope. Dedupe is scoped to a session so distinct
     * sessions can't leak artifact ids across each other even when payload
     * content is identical.
     */
    put(input: PutToolArtifactInput): ToolArtifactRecord;
    /** Alias for get(id) — explicit name used by the compositor hydration pass. */
    getById(id: string): ToolArtifactRecord | null;
    get(id: string): ToolArtifactRecord | null;
    getByHash(agentId: string, sessionKey: string, contentHash: string): ToolArtifactRecord | null;
    listByTurn(sessionKey: string, turnId: string): ToolArtifactRecord[];
    listByToolCall(toolCallId: string): ToolArtifactRecord[];
    listRecent(agentId: string, sessionKey: string, limit?: number): ToolArtifactRecord[];
    /** Update last_used_at — call this when hydration actually surfaces the payload. */
    touch(id: string): void;
    /**
     * GC sweep: delete artifacts that exceed their TTL or per-session count cap.
     * Returns total rows deleted.
     *
     * Sensitive artifacts use sensitiveTtlMs (shorter); standard artifacts use
     * standardTtlMs. Optional maxPerSession bounds row count per (agent, session)
     * using a ROW_NUMBER() window query — oldest last_used_at removed first.
     */
    sweep(policy: ToolArtifactRetentionPolicy): number;
    /**
     * Delete artifacts whose last_used_at is older than the ISO cutoff.
     * Returns the number of rows deleted. Phase 1: manual invocation only.
     */
    deleteOlderThan(isoCutoff: string): number;
    /** Debug / ops: row count across a session. */
    count(agentId?: string, sessionKey?: string): number;
}
//# sourceMappingURL=tool-artifact-store.d.ts.map