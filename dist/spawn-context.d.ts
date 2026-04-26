/**
 * hypermem Spawn Context — Subagent Context Inheritance
 *
 * Provides tools to snapshot a parent session's working context and make it
 * available to a spawned subagent at compose time.
 *
 * Usage:
 *   const ctx = await buildSpawnContext(messageStore, docChunkStore, agentId, {
 *     parentSessionKey: 'agent:alice:webchat:main',
 *     workingSnapshot: 10,
 *     documents: ['/path/to/spec.md'],
 *   });
 *   // Inject ctx.parentContextBlock into the subagent task prompt.
 *   // Pass ctx.sessionKey as ComposeRequest.parentSessionKey for doc chunk retrieval.
 *   // When done: docChunkStore.clearSessionChunks(ctx.sessionKey);
 */
import type { MessageStore } from './message-store.js';
import type { DocChunkStore } from './doc-chunk-store.js';
export interface SpawnContextOptions {
    /** Parent session key to snapshot working context from */
    parentSessionKey: string;
    /** Number of recent turns to include (default 25, max 50) */
    workingSnapshot?: number;
    /** File paths to chunk and inject as session-scoped doc chunks */
    documents?: string[];
    /** Token budget for the entire spawn context (default 4000) */
    budgetTokens?: number;
}
export interface SpawnContext {
    /** Formatted parent context block for injection into subagent task prompt */
    parentContextBlock: string | null;
    /** Session key to use for querying injected doc chunks at compose time */
    sessionKey: string;
    /** Summary of what was injected (for logging) */
    summary: {
        turnsIncluded: number;
        documentsIndexed: number;
        documentsSkipped: string[];
        tokenEstimate: number;
    };
}
/**
 * Build a spawn context for a subagent by snapshotting the parent session.
 *
 * 1. Generates a unique session key for this spawn.
 * 2. Pulls recent turns from the parent session (L2 messages).
 * 3. Formats them into a compact block for injection into the task prompt.
 * 4. Optionally chunks and indexes documents as session-scoped doc chunks.
 * 5. Returns the context block, spawn session key, and a summary.
 *
 * Errors are handled gracefully — this function never throws.
 */
export declare function buildSpawnContext(messageStore: MessageStore, docChunkStore: DocChunkStore, agentId: string, options: SpawnContextOptions): Promise<SpawnContext>;
//# sourceMappingURL=spawn-context.d.ts.map