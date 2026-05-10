/**
 * entity-ppr.ts \u2014 Sprint B
 *
 * Sparse, in-memory Personalized PageRank over a small message/entity/grace
 * adjacency snapshot from `EntityBridgeStore.buildGraphSnapshot()`.
 *
 * Caps:
 *   - Iteration cap (default 20).
 *   - Convergence tolerance (default 1e-6).
 *   - Hard message/edge caps come from the snapshot itself; PPR never grows it.
 *
 * Returns ranked message IDs and diagnostics. Never reads from the DB
 * directly \u2014 callers pass an already-bounded snapshot.
 */
import type { BridgeGraphSnapshot } from './entity-bridge-store.js';
export interface PprOptions {
    /** Restart probability (alpha). Default 0.15 \u2192 0.85 walk continuation. */
    teleportProbability?: number;
    /** Maximum power iterations. Default 20. */
    maxIterations?: number;
    /** L1 convergence tolerance over the score vector. Default 1e-6. */
    convergenceTolerance?: number;
    /** Optional cap on how many messages to return. Default: all ranked. */
    topK?: number;
}
export interface PprDiagnostics {
    iterations: number;
    converged: boolean;
    /** Final L1 delta. */
    delta: number;
    /** Total messages scored. */
    messageCount: number;
    /** Number of seeds used. */
    seedCount: number;
    /** Whether seeds had no neighbors at all (dead start). */
    emptyGraph: boolean;
}
export interface PprResult {
    /** Ranked array of `{ messageId, score }` in descending order. */
    ranked: Array<{
        messageId: number;
        score: number;
    }>;
    diagnostics: PprDiagnostics;
}
/**
 * Run sparse personalized PageRank. The graph is bipartite-like:
 *   message <-> entity
 *   message <-> grace
 *
 * We treat each message/entity/grace as a node. Edge weights are uniform
 * (1.0) within the snapshot \u2014 RRF/recency scoring is the caller's job.
 */
export declare function runPersonalizedPageRank(snapshot: BridgeGraphSnapshot, seedEntityKeys: string[], seedFacetKeys: string[], opts?: PprOptions): PprResult;
//# sourceMappingURL=entity-ppr.d.ts.map