/**
 * hypermem Retrieval Policy
 *
 * Single enforced policy layer for scope-based access control during retrieval.
 * Called by the compositor to filter items before they are injected into context.
 *
 * Scope rules:
 *   'agent' (default / null / undefined): allowed if agentId matches OR is null/undefined (global)
 *   'session': allowed if both agentId AND sessionKey match
 *   'user': allowed if agentId matches
 *   'global': always allowed
 *   any other value: denied with reason 'ambiguous_scope'
 */
export type RetrievalScope = 'agent' | 'session' | 'user' | 'global';
export interface RetrievalContext {
    agentId: string;
    sessionKey: string;
}
export interface ScopeCheckResult {
    allowed: boolean;
    /** One of: 'allowed' | 'scope_filtered' | 'ambiguous_scope' */
    reason: string;
}
/**
 * Check whether a single item is accessible in the given retrieval context.
 *
 * @param itemScope       The scope stored on the item (null/undefined → defaults to 'agent')
 * @param itemAgentId     The agentId stored on the item (null/undefined → global)
 * @param itemSessionKey  The sessionKey stored on the item (null/undefined → any)
 * @param ctx             The requester's retrieval context
 */
export declare function checkScope(itemScope: string | null | undefined, itemAgentId: string | null | undefined, itemSessionKey: string | null | undefined, ctx: RetrievalContext): ScopeCheckResult;
/**
 * Filter an array of items by scope, returning allowed items and a filtered count.
 *
 * Items are expected to have optional `agentId`, `sessionKey`, and `scope` fields.
 * Null/undefined fields are treated as "unset" (permissive for their slot).
 *
 * @param items  Array of items to filter
 * @param ctx    The requester's retrieval context
 * @returns      { allowed: T[], filteredCount: number }
 */
export declare function filterByScope<T extends {
    agentId?: string | null;
    sessionKey?: string | null;
    scope?: string | null;
}>(items: T[], ctx: RetrievalContext): {
    allowed: T[];
    filteredCount: number;
};
//# sourceMappingURL=retrieval-policy.d.ts.map