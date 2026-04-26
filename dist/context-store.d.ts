/**
 * hypermem Context Store
 *
 * Manages the `contexts` table — a durable record of agent conversation
 * contexts that tracks which session is active, what the current head
 * message is, and supports archival and forking.
 *
 * Each agent + session pair has at most one active context at a time.
 * Contexts are the anchor point for the compositor: they track the
 * head message (most recent message included in composed context) and
 * link back to the underlying conversation.
 *
 * Design principles:
 *   - All functions take DatabaseSync as first arg (standalone, no classes)
 *   - Fully idempotent — safe to call on every startup
 *   - Head pointer is monotone-forward (never moves backward)
 *   - Archive is idempotent (no-op if already archived)
 */
import type { DatabaseSync } from 'node:sqlite';
export interface Context {
    id: number;
    agentId: string;
    sessionKey: string;
    conversationId: number;
    headMessageId: number | null;
    parentContextId: number | null;
    status: 'active' | 'archived' | 'forked';
    createdAt: string;
    updatedAt: string;
    metadataJson: string | null;
}
/**
 * Add the contexts table and related indexes to an existing messages.db.
 * Also ALTERs the messages table to add a context_id foreign key column.
 * Idempotent — safe to call on every startup.
 */
export declare function ensureContextSchema(db: DatabaseSync): void;
/**
 * Get the active context for an agent + session pair.
 * Returns null if no active context exists.
 */
export declare function getActiveContext(db: DatabaseSync, agentId: string, sessionKey: string): Context | null;
/**
 * Get the active context for an agent + session, creating one if none exists.
 *
 * If an active context already exists, returns it unchanged.
 * Otherwise INSERTs a new context with status='active', head_message_id=NULL,
 * and the given conversationId.
 *
 * Idempotent — safe to call repeatedly.
 */
export declare function getOrCreateActiveContext(db: DatabaseSync, agentId: string, sessionKey: string, conversationId: number): Context;
/**
 * Update the head message pointer for a context.
 *
 * Monotone forward: only updates if messageId > current head_message_id
 * (or current is NULL). This prevents accidental regression of the head
 * pointer, matching the compaction-fence monotone progress pattern.
 */
export declare function updateContextHead(db: DatabaseSync, contextId: number, messageId: number): void;
/**
 * Archive a context, setting its status to 'archived'.
 * Idempotent — no-op if already archived.
 */
export declare function archiveContext(db: DatabaseSync, contextId: number): void;
/**
 * Get any context by id, regardless of status.
 * Returns null if not found.
 *
 * @boundary INSPECTION ONLY — not a mining entry point.
 * @policy See specs/DAG_HELPER_POLICY.md for helper classifications.
 * Do not use this function to retrieve messages for active composition or
 * historical mining. Use getArchivedContext + mineArchivedContext for archived
 * mining, and getActiveContext for composition-path access.
 */
export declare function getContextById(db: DatabaseSync, contextId: number): Context | null;
/**
 * Get all archived or forked contexts for an agent.
 * Optionally filter by sessionKey and/or limit.
 * Returns in reverse-chronological order (most recently updated first).
 *
 * @policy See specs/DAG_HELPER_POLICY.md. This is the operator-safe
 * archived-context enumeration path.
 */
export declare function getArchivedContexts(db: DatabaseSync, agentId: string, opts?: {
    sessionKey?: string;
    limit?: number;
}): Context[];
/**
 * Get an archived or forked context by id.
 * Returns null if the context does not exist OR if it is active.
 *
 * @policy See specs/DAG_HELPER_POLICY.md. This is the operator-safe
 * single-context lookup path.
 */
export declare function getArchivedContext(db: DatabaseSync, contextId: number): Context | null;
/**
 * Walk the parent_context_id chain upward from the given context.
 * Returns contexts in leaf-to-root order (starting context first).
 * Includes the starting context itself.
 * Caps traversal depth at 100 to avoid corrupt loops.
 *
 * @boundary STATUS-CROSSING BY DESIGN — this function traverses across
 * active, archived, and forked contexts without filtering by status.
 * @policy See specs/DAG_HELPER_POLICY.md for the call-site filtering rule.
 * If you need only archived/forked contexts in the lineage chain, filter
 * the returned array at the call site (e.g. `.filter(c => c.status !== 'active')`).
 */
export declare function getContextLineage(db: DatabaseSync, contextId: number): Context[];
/**
 * Get direct fork children of a context (contexts with parent_context_id = parentContextId).
 * Returns in ascending creation order.
 *
 * @boundary STATUS-CROSSING BY DESIGN — returns children regardless of their status
 * (may include active, archived, or forked children).
 * @policy See specs/DAG_HELPER_POLICY.md for the call-site filtering rule.
 * Filter at the call site if archived-only results are needed.
 */
export declare function getForkChildren(db: DatabaseSync, parentContextId: number): Context[];
/**
 * Rotate a session's active context: archive the current active context
 * and create a new one, optionally linking back via parent_context_id.
 *
 * Used on session restarts/rotations so the new context starts with a
 * clean head pointer instead of inheriting the stale tail.
 *
 * Returns the newly created active context.
 * If no active context exists, simply creates one (no archive step).
 */
export declare function rotateSessionContext(db: DatabaseSync, agentId: string, sessionKey: string, conversationId: number): Context;
//# sourceMappingURL=context-store.d.ts.map