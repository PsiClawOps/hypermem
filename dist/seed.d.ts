/**
 * hypermem Workspace Seeder
 *
 * Reads ACA workspace files, chunks them by logical section, and indexes
 * into hypermem for demand-loaded retrieval (ACA offload).
 *
 * Usage:
 *   const seeder = new WorkspaceSeeder(hypermem);
 *   const result = await seeder.seedWorkspace('/path/to/workspace', { agentId: 'alice' });
 *
 * Idempotent: skips files whose source hash hasn't changed since last index.
 * Atomic: each file's chunks are swapped in a single transaction.
 *
 * Files seeded (from ACA_COLLECTIONS):
 *   POLICY.md      → governance/policy   (shared-fleet)
 *   CHARTER.md     → governance/charter  (per-tier)
 *   COMMS.md       → governance/comms    (shared-fleet)
 *   AGENTS.md      → operations/agents   (per-tier)
 *   TOOLS.md       → operations/tools    (per-agent)
 *   SOUL.md        → identity/soul       (per-agent)
 *   JOB.md         → identity/job        (per-agent)
 *   MOTIVATIONS.md → identity/motivations(per-agent)
 *   MEMORY.md      → memory/decisions    (per-agent)
 *   memory/*.md    → memory/daily        (per-agent)
 */
import { type IndexResult } from './doc-chunk-store.js';
export interface SeedOptions {
    /** Agent ID for per-agent scoped chunks */
    agentId?: string;
    /** Tier for per-tier scoped chunks (council/director) */
    tier?: string;
    /** Whether to force re-index even if hash unchanged */
    force?: boolean;
    /** Only seed specific collections (e.g., ['governance/policy']) */
    collections?: string[];
    /** Whether to include daily memory files (memory/YYYY-MM-DD.md) */
    includeDailyMemory?: boolean;
    /** Max daily memory files to include (most recent first) */
    dailyMemoryLimit?: number;
}
export interface SeedFileResult {
    filePath: string;
    collection: string;
    result: IndexResult;
}
export interface SeedResult {
    /** Files successfully processed */
    files: SeedFileResult[];
    /** Total new chunks inserted */
    totalInserted: number;
    /** Total stale chunks deleted */
    totalDeleted: number;
    /** Files that were up to date (skipped) */
    skipped: number;
    /** Files that were re-indexed */
    reindexed: number;
    /** Files that had errors */
    errors: Array<{
        filePath: string;
        error: string;
    }>;
}
export declare class WorkspaceSeeder {
    private db;
    private chunkStore;
    constructor(db: import('node:sqlite').DatabaseSync);
    /**
     * Seed all ACA files from a workspace directory.
     */
    seedWorkspace(workspaceDir: string, opts?: SeedOptions): Promise<SeedResult>;
    /**
     * Seed a single file explicitly.
     */
    seedFile(filePath: string, collection: string, opts?: SeedOptions): SeedFileResult;
    /**
     * Check which workspace files need re-indexing.
     */
    checkStaleness(workspaceDir: string, opts?: SeedOptions): Array<{
        filePath: string;
        collection: string;
        needsReindex: boolean;
    }>;
    /**
     * Get stats about what's currently indexed.
     */
    getIndexStats(): {
        collection: string;
        count: number;
        sources: number;
        totalTokens: number;
    }[];
    /**
     * Query indexed chunks by collection.
     */
    queryChunks(collection: string, opts?: {
        agentId?: string;
        tier?: string;
        limit?: number;
        keyword?: string;
    }): import("./doc-chunk-store.js").DocChunkRow[];
    private discoverFiles;
}
/**
 * Seed a workspace directly from a DatabaseSync instance.
 * Convenience wrapper for use in the hook handler and CLI.
 */
export declare function seedWorkspace(db: import('node:sqlite').DatabaseSync, workspaceDir: string, opts?: SeedOptions): Promise<SeedResult>;
//# sourceMappingURL=seed.d.ts.map