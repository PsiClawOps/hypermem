/**
 * dreaming-promoter.ts
 *
 * hypermem-native dreaming promotion pass.
 *
 * Unlike the stock memory-core dreaming feature (which appends raw content to
 * MEMORY.md), this promoter generates pointer-format entries that match the
 * council's MEMORY.md convention:
 *
 *   - **{domain} — {title}:** {summary}
 *     → `memory_search("{query}")`
 *
 * Scoring uses confidence, decay, recency, and domain cluster weight.
 * Dedup prevents re-promoting topics already covered by existing pointers.
 *
 * Dry-run mode returns what would be written without modifying any files.
 */
import type { DatabaseSync } from 'node:sqlite';
export interface DreamerConfig {
    /** Enable the promotion pass. Default: false */
    enabled: boolean;
    /** Minimum composite score for promotion. Default: 0.70 */
    minScore: number;
    /** Minimum confidence threshold (pre-scoring). Default: 0.70 */
    minConfidence: number;
    /** Max new pointer entries to write per agent per run. Default: 5 */
    maxPromotionsPerRun: number;
    /** How often to run: every N indexer ticks. Default: 12 (~1hr at 5min interval) */
    tickInterval: number;
    /** Preview what would be promoted without writing. Default: false */
    dryRun: boolean;
    /** Recency half-life in days (score decays to 0.5 at this age). Default: 14 */
    recencyHalfLifeDays: number;
    /** Max age in days to consider a fact. Default: 90 */
    maxAgeDays: number;
}
export declare const DEFAULT_DREAMER_CONFIG: DreamerConfig;
export interface FactCandidate {
    id: number;
    agentId: string;
    domain: string;
    content: string;
    confidence: number;
    decayScore: number;
    ageDays: number;
    score: number;
}
export interface PromotionEntry {
    factId: number;
    domain: string;
    pointer: string;
    title: string;
    summary: string;
    query: string;
    score: number;
    dryRun: boolean;
}
export interface DreamerResult {
    agentId: string;
    candidates: number;
    promoted: number;
    skippedDuplicate: number;
    skippedThreshold: number;
    entries: PromotionEntry[];
    memoryPath: string | null;
    dryRun: boolean;
}
/**
 * Resolve the workspace directory for an agent.
 * Council agents live at ~/.openclaw/workspace/{agentId}/
 * Other agents at ~/.openclaw/workspace/{agentId}/
 */
export declare function resolveAgentWorkspacePath(agentId: string): Promise<string | null>;
/**
 * Temporal-state markers that indicate a fact is time-bound or conditional.
 *
 * Facts containing any of these markers MUST carry structured recency metadata
 * (`validFrom` / `invalidAt` columns) to be eligible for durable promotion.
 * Plain ISO dates in the content text do NOT satisfy this requirement — a
 * dated sentence like "suspended pending X as of 2026-04-18" is still temporary
 * and would harden stale state if promoted.
 *
 * Exported so tests and downstream callers can verify coverage and extend it.
 * Keep this list centralized; do not fork copies into other modules.
 */
export declare const TEMPORAL_MARKERS: RegExp[];
/**
 * Returns true if content contains any temporal-state marker.
 * Exported for test coverage and for callers that want to gate their own writes.
 */
export declare function hasTemporalMarker(content: string): boolean;
/**
 * Structured recency metadata from the facts table.
 * Either field being set (non-null, non-empty) signals the fact row was
 * authored with temporal bounds the store can enforce.
 */
export interface FactRecencyMeta {
    validFrom?: string | null;
    invalidAt?: string | null;
}
/**
 * Reject facts that are clearly noise at promotion time.
 * A second line of defense — the indexer's isQualityFact() is the primary filter,
 * but legacy noise in the DB (pre-TUNE-013) still needs to be caught here.
 *
 * Additionally blocks promotion of temporally-scoped facts that lack structured
 * recency metadata. A fact like "model frozen until provider routing stable"
 * without `validFrom`/`invalidAt` would harden a temporary state into durable
 * memory forever. Plain ISO dates in content text do NOT bypass this check.
 */
export declare function isPromotable(content: string, meta?: FactRecencyMeta): boolean;
/**
 * Run the dreaming promotion pass for a single agent.
 *
 * Reads qualified facts from library.db, scores them, deduplicates against
 * existing MEMORY.md pointers, and writes new pointer entries.
 */
export declare function runDreamingPromoter(agentId: string, libraryDb: DatabaseSync, config?: Partial<DreamerConfig>): Promise<DreamerResult>;
/**
 * Run the dreaming promotion pass for all agents in a fleet.
 * Called from the BackgroundIndexer on every N ticks.
 */
export declare function runDreamingPassForFleet(agentIds: string[], libraryDb: DatabaseSync, config?: Partial<DreamerConfig>): Promise<DreamerResult[]>;
//# sourceMappingURL=dreaming-promoter.d.ts.map