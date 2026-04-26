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
/**
 * Check whether a single item is accessible in the given retrieval context.
 *
 * @param itemScope       The scope stored on the item (null/undefined → defaults to 'agent')
 * @param itemAgentId     The agentId stored on the item (null/undefined → global)
 * @param itemSessionKey  The sessionKey stored on the item (null/undefined → any)
 * @param ctx             The requester's retrieval context
 */
export function checkScope(itemScope, itemAgentId, itemSessionKey, ctx) {
    const scope = itemScope ?? 'agent';
    switch (scope) {
        case 'agent':
            // Global agent facts (null/undefined agentId) are readable by all agents.
            // Agent-specific facts are only readable by the owning agent.
            if (itemAgentId == null || itemAgentId === ctx.agentId) {
                return { allowed: true, reason: 'allowed' };
            }
            return { allowed: false, reason: 'scope_filtered' };
        case 'session':
            // Session-scoped: both agentId AND sessionKey must match.
            if ((itemAgentId == null || itemAgentId === ctx.agentId) &&
                (itemSessionKey == null || itemSessionKey === ctx.sessionKey)) {
                return { allowed: true, reason: 'allowed' };
            }
            return { allowed: false, reason: 'scope_filtered' };
        case 'user':
            // User-scoped: agentId must match (user prefs are keyed by agent).
            if (itemAgentId == null || itemAgentId === ctx.agentId) {
                return { allowed: true, reason: 'allowed' };
            }
            return { allowed: false, reason: 'scope_filtered' };
        case 'global':
            // Global: always accessible.
            return { allowed: true, reason: 'allowed' };
        default:
            // Unknown scope — deny with ambiguous_scope.
            return { allowed: false, reason: 'ambiguous_scope' };
    }
}
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
export function filterByScope(items, ctx) {
    const allowed = [];
    let filteredCount = 0;
    for (const item of items) {
        const result = checkScope(item.scope, item.agentId, item.sessionKey, ctx);
        if (result.allowed) {
            allowed.push(item);
        }
        else {
            filteredCount++;
        }
    }
    return { allowed, filteredCount };
}
//# sourceMappingURL=retrieval-policy.js.map