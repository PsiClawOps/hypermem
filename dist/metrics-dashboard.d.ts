/**
 * hypermem Metrics Dashboard
 *
 * Provides a unified surface for observing system health:
 * - Memory counts (facts, pages, episodes, vectors)
 * - Composition performance (avg assembly time, budget utilization)
 * - Ingestion stats (indexer throughput, promotion rate)
 * - Embedding stats (cache hit rate, Ollama availability)
 *
 * All queries are read-only and safe to call on hot DBs.
 */
import type { DatabaseSync } from 'node:sqlite';
export interface FactMetrics {
    /** Total facts indexed across all agents */
    totalFacts: number;
    /** Facts per agent breakdown */
    byAgent: Record<string, number>;
    /** Facts added in the last 24h */
    recentFacts: number;
}
export interface WikiMetrics {
    /** Total synthesized wiki pages (non-superseded) */
    totalPages: number;
    /** Pages per agent */
    byAgent: Record<string, number>;
    /** Pages synthesized in the last 24h */
    recentPages: number;
    /** Oldest page age in hours (staleness indicator) */
    oldestPageAgeHours: number | null;
}
export interface EpisodeMetrics {
    /** Total episodes stored */
    totalEpisodes: number;
    /** Episodes per agent */
    byAgent: Record<string, number>;
    /** Average episode significance score (0-1) */
    avgSignificance: number | null;
}
export interface VectorMetrics {
    /** Total vectors indexed */
    totalVectors: number;
    /** Breakdown by source table */
    byTable: Record<string, number>;
    /** Embedding cache hit rate (0-1) for this process lifetime */
    cacheHitRate: number | null;
}
export interface DocChunkMetrics {
    /** Total doc chunks indexed across all collections */
    totalDocChunks: number;
    /** Doc chunks per collection */
    byCollection: Record<string, number>;
    /** Doc chunks added in the last 24h */
    recentDocChunks: number;
}
export interface CompositionMetrics {
    /** Average assembly time in ms (from output_metrics table) */
    avgAssemblyMs: number | null;
    /** p95 assembly time in ms */
    p95AssemblyMs: number | null;
    /** Average output tokens per turn */
    avgOutputTokens: number | null;
    /** Average input tokens per turn (context size) */
    avgInputTokens: number | null;
    /** Number of turns recorded */
    totalTurns: number;
    /** Average cache read tokens (Anthropic prompt cache utilization) */
    avgCacheReadTokens: number | null;
}
export interface IngestionMetrics {
    /** Total messages processed by the background indexer */
    totalMessagesIndexed: number;
    /** Total facts extracted */
    totalFactsExtracted: number;
    /** Noise rejection rate (1 - facts/messages, approximate) */
    noiseRejectionRate: number | null;
    /** Total episodes created */
    totalEpisodesCreated: number;
    /** Total knowledge items promoted by dreaming promoter */
    totalKnowledgePromoted: number;
}
export interface SystemHealth {
    /** Whether the main DB is readable */
    mainDbOk: boolean;
    /** Whether the library DB is readable */
    libraryDbOk: boolean;
    /** Main DB schema version */
    mainSchemaVersion: number | null;
    /** Library DB schema version */
    librarySchemaVersion: number | null;
    /** hypermem package version */
    packageVersion: string;
    /** Resolved embedding provider from the installed config */
    embeddingProvider: string | null;
    /** Resolved embedding model from the installed config */
    embeddingModel: string | null;
    /** Cache connection status (if provided) */
    cacheOk: boolean | null;
    /** Timestamp of this snapshot */
    snapshotAt: string;
}
export interface HyperMemMetrics {
    facts: FactMetrics;
    docChunks: DocChunkMetrics;
    wiki: WikiMetrics;
    episodes: EpisodeMetrics;
    vectors: VectorMetrics;
    composition: CompositionMetrics;
    ingestion: IngestionMetrics;
    health: SystemHealth;
}
export interface MetricsDashboardOptions {
    /** Agent IDs to scope to. If omitted, returns fleet-wide metrics. */
    agentIds?: string[];
    /** Include per-agent breakdowns. Default: true */
    includeBreakdowns?: boolean;
    /** Resolved embedding provider for health display. */
    embeddingProvider?: string | null;
    /** Resolved embedding model for health display. */
    embeddingModel?: string | null;
}
/**
 * Collect all metrics in a single pass.
 * Safe to call on live DBs — all queries are read-only.
 */
export declare function collectMetrics(mainDb: DatabaseSync, libraryDb: DatabaseSync, opts?: MetricsDashboardOptions, vectorDb?: DatabaseSync | null): Promise<HyperMemMetrics>;
/**
 * Format metrics as a human-readable summary string.
 * Suitable for logging or status replies.
 */
export declare function formatMetricsSummary(m: HyperMemMetrics): string;
//# sourceMappingURL=metrics-dashboard.d.ts.map