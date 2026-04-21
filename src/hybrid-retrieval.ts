/**
 * hypermem Hybrid Retrieval — FTS5 + KNN Score Fusion
 *
 * Merges keyword (FTS5/BM25) and semantic (KNN/vector) results into a
 * single ranked list using Reciprocal Rank Fusion (RRF). This avoids
 * vocabulary mismatch (KNN-only misses exact terms) and semantic gap
 * (FTS5-only misses paraphrases).
 *
 * Architecture:
 *   - FTS5 results from library.db (facts_fts, knowledge_fts, episodes_fts)
 *   - KNN results from vectors.db via VectorStore
 *   - RRF merges both ranked lists with configurable k constant
 *   - Deduplication by (sourceTable, sourceId)
 *   - Token-budgeted output for compositor consumption
 */

import type { DatabaseSync } from 'node:sqlite';
import type { VectorStore, VectorSearchResult } from './vector-store.js';
import type { RerankerProvider } from './reranker.js';

// ─── Reranker telemetry ─────────────────────────────────────────
//
// Metadata-only signal emitted from hybridSearch() whenever the fused-result
// path runs: no document content, no prompts, no provider keys. The signal
// has a stable shape so operators can prove reranking actually ran without
// needing to trace the retrieval pipeline end-to-end.
export type RerankerStatus =
  | 'applied'
  | 'bypass_no_provider'
  | 'bypass_below_threshold'
  | 'failed'
  | 'timeout';

export interface RerankerTelemetry {
  /** Provider name (e.g. 'zeroentropy', 'openrouter', 'ollama') or null when no provider. */
  provider: string | null;
  /** Number of fused candidates seen by the reranker hook. */
  candidates: number;
  /** Outcome for this invocation. */
  status: RerankerStatus;
}

function emitRerankerLog(ev: RerankerTelemetry): void {
  // Single-line, structured, metadata-only — safe for production logs.
  // Guarded behind HYPERMEM_RERANKER_LOG=1 to avoid console spam on every query.
  if (process.env['HYPERMEM_RERANKER_LOG'] === '1') {
    console.log(
      `[hypermem] reranker: provider=${ev.provider ?? 'none'} candidates=${ev.candidates} status=${ev.status}`
    );
  }
}

// ─── Types ─────────────────────────────────────────────────────

export interface HybridSearchResult {
  sourceTable: string;      // 'facts' | 'knowledge' | 'episodes'
  sourceId: number;
  content: string;
  domain?: string;
  agentId?: string;
  metadata?: string;
  /** ISO timestamp from source row — used for recency decay (TUNE-015) */
  createdAt?: string;
  /** Combined RRF score (higher = more relevant) */
  score: number;
  /** Which retrieval paths contributed */
  sources: ('fts' | 'knn')[];
}

export interface HybridSearchOptions {
  /** Content types to search. Default: ['facts', 'knowledge', 'episodes'] */
  tables?: string[];
  /** Max results to return. Default: 10 */
  limit?: number;
  /** Max KNN distance (filters low-quality vectors). Default: 1.2 */
  maxKnnDistance?: number;
  /** RRF k constant. Higher = less weight to top ranks. Default: 60 */
  rrfK?: number;
  /** Agent ID filter for FTS queries */
  agentId?: string;
  /** Weight for FTS results in fusion. Default: 1.0 */
  ftsWeight?: number;
  /** Weight for KNN results in fusion. Default: 1.0 */
  knnWeight?: number;
  /** Minimum number of FTS terms to attempt a query (skip if fewer). Default: 1 */
  minFtsTerms?: number;
  /** Pre-computed embedding for the query — skips Ollama call in VectorStore.search() */
  precomputedEmbedding?: Float32Array;
  /**
   * Optional reranker applied after RRF fusion. Only runs on the fused path
   * (both FTS and KNN produced results). FTS-only and KNN-only branches are
   * unchanged. Null/undefined disables reranking.
   */
  reranker?: RerankerProvider | null;
  /**
   * Minimum fused-candidate count required to invoke the reranker.
   * Below this, the reranker is bypassed and original RRF order is returned.
   * Default: 2.
   */
  rerankerMinCandidates?: number;
  /**
   * Max documents sent to the reranker. Clamps provider cost when the fused
   * candidate list is large. Defaults to fused.length (all candidates).
   */
  rerankerMaxDocuments?: number;
  /** Top-K passed to the reranker. Defaults to the sliced candidate count. */
  rerankerTopK?: number;
  /**
   * External guard timeout for the reranker call in ms. Provider timeouts are
   * enforced inside each RerankerProvider; this is a belt-and-suspenders
   * ceiling that also distinguishes 'timeout' from 'failed' in telemetry.
   * Default: 3000.
   */
  rerankerTimeoutMs?: number;
  /** Optional telemetry sink. When omitted, falls back to emitRerankerLog. */
  onRerankerTelemetry?: (ev: RerankerTelemetry) => void;
}

// ─── FTS5 Query Building ───────────────────────────────────────

/** Stop words to exclude from FTS5 queries */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'don', 'now', 'and', 'but', 'or', 'if', 'it', 'its', 'this',
  'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their', 'what',
  'which', 'who', 'whom', 'about', 'up',
]);

/**
 * Build an FTS5 query from a natural language string.
 * Extracts meaningful words, removes stop words, uses OR conjunction.
 */
export function buildFtsQuery(input: string): string {
  const words = input
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')       // strip punctuation except hyphens
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  if (words.length === 0) return '';

  // Deduplicate, sort by length descending (more specific terms first),
  // cap at 8 terms to keep queries reasonable
  const unique = [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .slice(0, 8);

  // Use prefix matching (*) and OR so any term can match
  return unique.map(w => `"${w}"*`).join(' OR ');
}

// ─── FTS5 Search Functions ─────────────────────────────────────

interface FtsResult {
  id: number;
  rank: number;       // FTS5 BM25 rank (negative — more negative = better match)
  content: string;
  domain?: string;
  agentId?: string;
  metadata?: string;
  createdAt?: string;
}

/**
 * Search facts via FTS5.
 */
function searchFactsFts(
  db: DatabaseSync,
  query: string,
  agentId?: string,
  limit: number = 20
): FtsResult[] {
  // Two-phase query: FTS runs first in subquery (fast), then filters on
  // the small result set.  Joining FTS + non-FTS predicates + ORDER BY rank
  // in one pass forces SQLite to materialise the full FTS match set before
  // applying LIMIT — O(matches) instead of O(limit).  See data-access-bench.
  const innerLimit = agentId ? limit * 4 : limit;   // over-fetch to survive filter
  let sql = `
    SELECT f.id, sub.rank, f.content, f.domain, f.agent_id
    FROM (
      SELECT rowid, rank FROM facts_fts WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?
    ) sub
    JOIN facts f ON f.id = sub.rowid
    WHERE f.superseded_by IS NULL
    AND f.decay_score < 0.8
  `;
  const params: (string | number)[] = [query, innerLimit];

  if (agentId) {
    sql += ' AND f.agent_id = ?';
    params.push(agentId);
  }

  sql += ' ORDER BY sub.rank LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number; rank: number; content: string; domain: string; agent_id: string;
  }>;

  return rows.map(r => ({
    id: r.id,
    rank: r.rank,
    content: r.content,
    domain: r.domain,
    agentId: r.agent_id,
  }));
}

/**
 * Search knowledge via FTS5.
 */
function searchKnowledgeFts(
  db: DatabaseSync,
  query: string,
  agentId?: string,
  limit: number = 20
): FtsResult[] {
  const innerLimit = agentId ? limit * 4 : limit;
  let sql = `
    SELECT k.id, sub.rank, k.content, k.domain, k.agent_id, k.key
    FROM (
      SELECT rowid, rank FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?
    ) sub
    JOIN knowledge k ON k.id = sub.rowid
    WHERE k.superseded_by IS NULL
  `;
  const params: (string | number)[] = [query, innerLimit];

  if (agentId) {
    sql += ' AND k.agent_id = ?';
    params.push(agentId);
  }

  sql += ' ORDER BY sub.rank LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number; rank: number; content: string; domain: string; agent_id: string; key: string;
  }>;

  return rows.map(r => ({
    id: r.id,
    rank: r.rank,
    content: r.content,
    domain: r.domain,
    agentId: r.agent_id,
    metadata: r.key,
  }));
}

/**
 * Search episodes via FTS5.
 */
function searchEpisodesFts(
  db: DatabaseSync,
  query: string,
  agentId?: string,
  limit: number = 20
): FtsResult[] {
  let sql: string;
  let params: (string | number)[];

  if (agentId) {
    // Agent-scoped: use WHERE IN (FTS5 subquery) instead of FTS5→JOIN→filter.
    // SQLite uses the agent_id index to narrow first, then checks FTS5 membership.
    // Benchmarked: 2.3ms avg vs 8.5ms avg for the post-join approach (13k+ episodes).
    sql = `
      SELECT e.id, 0 as rank, e.summary, e.event_type, e.agent_id, e.participants, e.created_at
      FROM episodes e
      WHERE e.agent_id = ?
        AND e.decay_score < 0.8
        AND e.id IN (SELECT rowid FROM episodes_fts WHERE episodes_fts MATCH ?)
      ORDER BY e.created_at DESC
      LIMIT ?
    `;
    params = [agentId, query, limit];
  } else {
    sql = `
      SELECT e.id, sub.rank, e.summary, e.event_type, e.agent_id, e.participants, e.created_at
      FROM (
        SELECT rowid, rank FROM episodes_fts WHERE episodes_fts MATCH ? ORDER BY rank LIMIT ?
      ) sub
      JOIN episodes e ON e.id = sub.rowid
      WHERE e.decay_score < 0.8
      ORDER BY sub.rank LIMIT ?
    `;
    params = [query, limit, limit];
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    id: number; rank: number; summary: string; event_type: string; agent_id: string; participants: string | null; created_at: string;
  }>;

  return rows.map(r => ({
    id: r.id,
    rank: r.rank,
    content: r.summary,
    domain: r.event_type,
    agentId: r.agent_id,
    metadata: r.participants || undefined,
    createdAt: r.created_at || undefined,
  }));
}

// ─── Reciprocal Rank Fusion ────────────────────────────────────

type ResultKey = string; // "table:id"

interface FusionEntry {
  sourceTable: string;
  sourceId: number;
  content: string;
  domain?: string;
  agentId?: string;
  metadata?: string;
  createdAt?: string;
  ftsRank?: number;       // Position in FTS result list (1-based)
  knnRank?: number;       // Position in KNN result list (1-based)
  knnDistance?: number;
  score: number;
  sources: ('fts' | 'knn')[];
}

function resultKey(table: string, id: number): ResultKey {
  return `${table}:${id}`;
}

/**
 * Merge FTS5 and KNN results using Reciprocal Rank Fusion.
 *
 * RRF score = Σ (weight / (k + rank)) for each result list the item appears in.
 * k is a constant (default 60) that dampens the effect of high rank positions.
 */
function fuseResults(
  ftsResults: Map<ResultKey, FusionEntry>,
  knnResults: Map<ResultKey, FusionEntry>,
  k: number,
  ftsWeight: number,
  knnWeight: number
): FusionEntry[] {
  const merged = new Map<ResultKey, FusionEntry>();

  // Add FTS results
  for (const [key, entry] of ftsResults) {
    const score = ftsWeight / (k + (entry.ftsRank || 1));
    merged.set(key, { ...entry, score, sources: ['fts'] });
  }

  // Merge KNN results
  for (const [key, entry] of knnResults) {
    const knnScore = knnWeight / (k + (entry.knnRank || 1));
    const existing = merged.get(key);

    if (existing) {
      // Item found by both — boost score
      existing.score += knnScore;
      existing.knnRank = entry.knnRank;
      existing.knnDistance = entry.knnDistance;
      existing.sources = ['fts', 'knn'];
    } else {
      merged.set(key, { ...entry, score: knnScore, sources: ['knn'] });
    }
  }

  // Sort by fused score descending
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Hybrid search combining FTS5 keyword search and KNN vector search.
 *
 * When vectorStore is null, falls back to FTS5-only.
 * When FTS5 query is empty (all stop words), falls back to KNN-only.
 */
export async function hybridSearch(
  libraryDb: DatabaseSync,
  vectorStore: VectorStore | null,
  query: string,
  opts?: HybridSearchOptions
): Promise<HybridSearchResult[]> {
  const tables = opts?.tables || ['facts', 'knowledge', 'episodes'];
  const limit = opts?.limit || 10;
  const maxKnnDistance = opts?.maxKnnDistance || 1.2;
  const rrfK = opts?.rrfK || 60;
  const ftsWeight = opts?.ftsWeight || 1.0;
  const knnWeight = opts?.knnWeight || 1.0;
  const minFtsTerms = opts?.minFtsTerms || 1;

  // ── FTS5 retrieval ──
  const ftsQuery = buildFtsQuery(query);
  const ftsMap = new Map<ResultKey, FusionEntry>();

  if (ftsQuery && ftsQuery.split(' OR ').length >= minFtsTerms) {
    try {
      const perTableLimit = Math.ceil(limit * 1.5); // Over-fetch for fusion

      if (tables.includes('facts')) {
        const results = searchFactsFts(libraryDb, ftsQuery, opts?.agentId, perTableLimit);
        results.forEach((r, i) => {
          const key = resultKey('facts', r.id);
          ftsMap.set(key, {
            sourceTable: 'facts',
            sourceId: r.id,
            content: r.content,
            domain: r.domain,
            agentId: r.agentId,
            ftsRank: i + 1,
            score: 0,
            sources: ['fts'],
          });
        });
      }

      if (tables.includes('knowledge')) {
        const results = searchKnowledgeFts(libraryDb, ftsQuery, opts?.agentId, perTableLimit);
        results.forEach((r, i) => {
          const key = resultKey('knowledge', r.id);
          ftsMap.set(key, {
            sourceTable: 'knowledge',
            sourceId: r.id,
            content: r.content,
            domain: r.domain,
            agentId: r.agentId,
            metadata: r.metadata,
            ftsRank: i + 1,
            score: 0,
            sources: ['fts'],
          });
        });
      }

      if (tables.includes('episodes')) {
        const results = searchEpisodesFts(libraryDb, ftsQuery, opts?.agentId, perTableLimit);
        results.forEach((r, i) => {
          const key = resultKey('episodes', r.id);
          ftsMap.set(key, {
            sourceTable: 'episodes',
            sourceId: r.id,
            content: r.content,
            domain: r.domain,
            agentId: r.agentId,
            metadata: r.metadata,
            createdAt: r.createdAt,
            ftsRank: i + 1,
            score: 0,
            sources: ['fts'],
          });
        });
      }
    } catch {
      // FTS5 failure is non-fatal — fall through to KNN-only
    }
  }

  // ── KNN retrieval ──
  const knnMap = new Map<ResultKey, FusionEntry>();

  if (vectorStore) {
    try {
      const knnResults = await vectorStore.search(query, {
        tables,
        limit: Math.ceil(limit * 1.5),
        maxDistance: maxKnnDistance,
        precomputedEmbedding: opts?.precomputedEmbedding,
      });

      knnResults.forEach((r, i) => {
        const key = resultKey(r.sourceTable, r.sourceId);
        knnMap.set(key, {
          sourceTable: r.sourceTable,
          sourceId: r.sourceId,
          content: r.content,
          domain: r.domain,
          agentId: r.agentId,
          metadata: r.metadata,
          knnRank: i + 1,
          knnDistance: r.distance,
          score: 0,
          sources: ['knn'],
        });
      });
    } catch {
      // KNN failure is non-fatal — use FTS-only
    }
  }

  // ── Fusion ──
  if (ftsMap.size === 0 && knnMap.size === 0) {
    return [];
  }

  // If only one source has results, skip fusion overhead but assign scores
  if (ftsMap.size === 0) {
    // KNN-only: score by inverse distance
    return [...knnMap.values()]
      .sort((a, b) => (a.knnDistance || 99) - (b.knnDistance || 99))
      .slice(0, limit)
      .map((entry, i) => toHybridResult({
        ...entry,
        score: knnWeight / (rrfK + i + 1),
      }));
  }

  if (knnMap.size === 0) {
    // FTS-only: score by rank position
    return [...ftsMap.values()]
      .sort((a, b) => (a.ftsRank || 99) - (b.ftsRank || 99))
      .slice(0, limit)
      .map((entry, i) => toHybridResult({
        ...entry,
        score: ftsWeight / (rrfK + i + 1),
      }));
  }

  // Both sources present — RRF fusion
  const fused = fuseResults(ftsMap, knnMap, rrfK, ftsWeight, knnWeight);

  // ── Reranker hook ─────────────────────────────────────────────
  // Reranking runs only on the fused path. FTS-only / KNN-only branches
  // above return before this point. On any error, timeout, or null result
  // the original fused ordering is preserved.
  const reranked = await maybeRerank(fused, query, opts);
  return reranked.slice(0, limit).map(toHybridResult);
}

/**
 * Apply a reranker to the fused candidate list, falling back to the original
 * order on any failure. Emits a single-line telemetry event.
 */
async function maybeRerank(
  fused: FusionEntry[],
  query: string,
  opts?: HybridSearchOptions
): Promise<FusionEntry[]> {
  const reranker = opts?.reranker ?? null;
  const emit = opts?.onRerankerTelemetry ?? emitRerankerLog;

  if (!reranker) {
    emit({ provider: null, candidates: fused.length, status: 'bypass_no_provider' });
    return fused;
  }

  const minCandidates = opts?.rerankerMinCandidates ?? 2;
  if (fused.length < minCandidates) {
    emit({ provider: reranker.name, candidates: fused.length, status: 'bypass_below_threshold' });
    return fused;
  }

  const maxDocs = opts?.rerankerMaxDocuments ?? fused.length;
  const slice = fused.slice(0, Math.max(0, maxDocs));
  const topK = opts?.rerankerTopK ?? slice.length;
  const timeoutMs = opts?.rerankerTimeoutMs ?? 3000;

  let timedOut = false;
  const timeoutToken = Symbol('rerank-timeout');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof timeoutToken>((resolve) => {
    timer = setTimeout(() => { timedOut = true; resolve(timeoutToken); }, timeoutMs);
  });

  try {
    const rerankCall = reranker.rerank(query, slice.map((e) => e.content), topK);
    const race = await Promise.race([rerankCall, timeoutPromise]);

    if (race === timeoutToken) {
      emit({ provider: reranker.name, candidates: slice.length, status: 'timeout' });
      return fused;
    }

    const results = race as Awaited<typeof rerankCall>;
    if (!results || results.length === 0) {
      emit({ provider: reranker.name, candidates: slice.length, status: 'failed' });
      return fused;
    }

    const seen = new Set<number>();
    const reordered: FusionEntry[] = [];
    for (const r of results) {
      if (r.index < 0 || r.index >= slice.length) continue;
      if (seen.has(r.index)) continue;
      seen.add(r.index);
      reordered.push(slice[r.index]);
    }
    // Preserve any fused entries the reranker did not score so we never shrink
    // the candidate set on a graceful-degrade path. Keep original RRF order
    // for the tail.
    for (let i = 0; i < fused.length; i++) {
      if (i < slice.length && seen.has(i)) continue;
      reordered.push(fused[i]);
    }

    emit({ provider: reranker.name, candidates: slice.length, status: 'applied' });
    return reordered;
  } catch {
    if (timedOut) {
      emit({ provider: reranker.name, candidates: slice.length, status: 'timeout' });
    } else {
      emit({ provider: reranker.name, candidates: slice.length, status: 'failed' });
    }
    return fused;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toHybridResult(entry: FusionEntry): HybridSearchResult {
  return {
    sourceTable: entry.sourceTable,
    sourceId: entry.sourceId,
    content: entry.content,
    domain: entry.domain,
    agentId: entry.agentId,
    metadata: entry.metadata,
    createdAt: entry.createdAt,
    score: entry.score,
    sources: entry.sources,
  };
}
