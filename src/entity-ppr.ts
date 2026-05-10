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
  ranked: Array<{ messageId: number; score: number }>;
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
export function runPersonalizedPageRank(
  snapshot: BridgeGraphSnapshot,
  seedEntityKeys: string[],
  seedFacetKeys: string[],
  opts?: PprOptions,
): PprResult {
  const alpha = clamp(opts?.teleportProbability ?? 0.15, 1e-3, 0.99);
  const maxIters = Math.max(1, Math.min(200, opts?.maxIterations ?? 20));
  const tol = Math.max(1e-12, opts?.convergenceTolerance ?? 1e-6);

  // Build the union of node ids. We use string ids: 'm:<id>', 'e:<key>', 'f:<key>'.
  const nodeIds: string[] = [];
  const nodeIndex = new Map<string, number>();
  const adj: number[][] = [];

  function ensureNode(id: string): number {
    let idx = nodeIndex.get(id);
    if (idx == null) {
      idx = nodeIds.length;
      nodeIds.push(id);
      nodeIndex.set(id, idx);
      adj.push([]);
    }
    return idx;
  }

  // Add edges: entity <-> message
  for (const [key, msgs] of snapshot.entityMessages) {
    const eIdx = ensureNode(`e:${key}`);
    for (const mid of msgs) {
      const mIdx = ensureNode(`m:${mid}`);
      adj[eIdx].push(mIdx);
      adj[mIdx].push(eIdx);
    }
  }
  // grace <-> message (from seed expansion)
  for (const [key, msgs] of snapshot.facetMessages) {
    const fIdx = ensureNode(`f:${key}`);
    for (const mid of msgs) {
      const mIdx = ensureNode(`m:${mid}`);
      adj[fIdx].push(mIdx);
      adj[mIdx].push(fIdx);
    }
  }
  // Add second-hop adjacencies derived from messageEntities / messageFacets.
  for (const [mid, ents] of snapshot.messageEntities) {
    const mIdx = ensureNode(`m:${mid}`);
    for (const ek of ents) {
      const eIdx = ensureNode(`e:${ek}`);
      adj[eIdx].push(mIdx);
      adj[mIdx].push(eIdx);
    }
  }
  for (const [mid, facs] of snapshot.messageFacets) {
    const mIdx = ensureNode(`m:${mid}`);
    for (const fk of facs) {
      const fIdx = ensureNode(`f:${fk}`);
      adj[fIdx].push(mIdx);
      adj[mIdx].push(fIdx);
    }
  }

  // Build seed teleport vector.
  const seedVec = new Float64Array(nodeIds.length);
  let seedMass = 0;
  for (const k of seedEntityKeys) {
    const idx = nodeIndex.get(`e:${k}`);
    if (idx != null) {
      seedVec[idx] += 1;
      seedMass += 1;
    }
  }
  for (const k of seedFacetKeys) {
    const idx = nodeIndex.get(`f:${k}`);
    if (idx != null) {
      seedVec[idx] += 1;
      seedMass += 1;
    }
  }
  if (seedMass === 0 || nodeIds.length === 0) {
    return {
      ranked: [],
      diagnostics: {
        iterations: 0,
        converged: true,
        delta: 0,
        messageCount: 0,
        seedCount: seedEntityKeys.length + seedFacetKeys.length,
        emptyGraph: true,
      },
    };
  }
  for (let i = 0; i < seedVec.length; i++) seedVec[i] /= seedMass;

  // Power iteration: r_{t+1} = alpha * seedVec + (1 - alpha) * Wt * r_t
  // where Wt is the column-stochastic transpose of the adjacency.
  // For undirected adjacency we approximate degrees from neighbor counts.
  const degrees = adj.map(n => n.length);
  let r = new Float64Array(seedVec); // start at the seed distribution
  let next = new Float64Array(nodeIds.length);
  let iterations = 0;
  let delta = Infinity;
  let converged = false;

  for (; iterations < maxIters; iterations++) {
    next.fill(0);
    for (let i = 0; i < nodeIds.length; i++) {
      const ri = r[i];
      if (ri === 0) continue;
      const neighbors = adj[i];
      const deg = degrees[i];
      if (deg === 0) {
        // Dangling: contribute back to the seed distribution.
        for (let s = 0; s < nodeIds.length; s++) next[s] += ri * seedVec[s];
        continue;
      }
      const share = ri / deg;
      for (const j of neighbors) next[j] += share;
    }
    // Apply teleport.
    delta = 0;
    for (let i = 0; i < nodeIds.length; i++) {
      const v = alpha * seedVec[i] + (1 - alpha) * next[i];
      delta += Math.abs(v - r[i]);
      next[i] = v;
    }
    // Swap r and next.
    const tmp = r; r = next; next = tmp;
    if (delta < tol) {
      converged = true;
      iterations++;
      break;
    }
  }

  // Collect message scores.
  const ranked: Array<{ messageId: number; score: number }> = [];
  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i];
    if (id.charCodeAt(0) === 109 /* 'm' */ && id.charCodeAt(1) === 58 /* ':' */) {
      const mid = Number(id.slice(2));
      if (Number.isFinite(mid)) ranked.push({ messageId: mid, score: r[i] });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  const topK = opts?.topK;
  const final = typeof topK === 'number' && topK >= 0 ? ranked.slice(0, topK) : ranked;

  return {
    ranked: final,
    diagnostics: {
      iterations,
      converged,
      delta,
      messageCount: ranked.length,
      seedCount: seedEntityKeys.length + seedFacetKeys.length,
      emptyGraph: false,
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
