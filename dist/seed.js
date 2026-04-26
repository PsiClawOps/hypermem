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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { chunkFile, inferCollection, ACA_COLLECTIONS, hashContent } from './doc-chunker.js';
import { DocChunkStore } from './doc-chunk-store.js';
// ─── Seeder ──────────────────────────────────────────────────────
export class WorkspaceSeeder {
    db;
    chunkStore;
    constructor(db) {
        this.db = db;
        this.chunkStore = new DocChunkStore(db);
    }
    /**
     * Seed all ACA files from a workspace directory.
     */
    async seedWorkspace(workspaceDir, opts = {}) {
        const result = {
            files: [],
            totalInserted: 0,
            totalDeleted: 0,
            skipped: 0,
            reindexed: 0,
            errors: [],
        };
        const gcResult = this.chunkStore.garbageCollectMissingSources({ sourcePathPrefix: workspaceDir });
        result.totalDeleted += gcResult.chunksDeleted;
        const filesToProcess = this.discoverFiles(workspaceDir, opts);
        for (const { filePath, collectionDef } of filesToProcess) {
            // Skip if collection filter provided
            if (opts.collections && !opts.collections.includes(collectionDef.collection)) {
                continue;
            }
            try {
                const chunks = chunkFile(filePath, {
                    collection: collectionDef.collection,
                    scope: collectionDef.scope,
                    tier: collectionDef.scope === 'per-tier' ? (opts.tier ?? 'all') : undefined,
                    agentId: collectionDef.scope === 'per-agent' ? opts.agentId : undefined,
                });
                if (chunks.length === 0)
                    continue;
                // Force re-index if requested
                if (opts.force) {
                    this.chunkStore.deleteSource(filePath, collectionDef.collection);
                }
                const indexResult = this.chunkStore.indexChunks(chunks);
                result.files.push({ filePath, collection: collectionDef.collection, result: indexResult });
                result.totalInserted += indexResult.inserted;
                result.totalDeleted += indexResult.deleted;
                if (indexResult.skipped)
                    result.skipped++;
                if (indexResult.reindexed)
                    result.reindexed++;
            }
            catch (err) {
                result.errors.push({
                    filePath,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return result;
    }
    /**
     * Seed a single file explicitly.
     */
    seedFile(filePath, collection, opts = {}) {
        const collectionDef = Object.values(ACA_COLLECTIONS).find(d => d.collection === collection)
            ?? { collection, scope: 'per-agent', description: '' };
        if (opts.force) {
            this.chunkStore.deleteSource(filePath, collection);
        }
        const chunks = chunkFile(filePath, {
            collection,
            scope: collectionDef.scope,
            tier: collectionDef.scope === 'per-tier' ? (opts.tier ?? 'all') : undefined,
            agentId: collectionDef.scope === 'per-agent' ? opts.agentId : undefined,
        });
        const indexResult = this.chunkStore.indexChunks(chunks);
        return { filePath, collection, result: indexResult };
    }
    /**
     * Check which workspace files need re-indexing.
     */
    checkStaleness(workspaceDir, opts = {}) {
        const filesToProcess = this.discoverFiles(workspaceDir, opts);
        return filesToProcess.map(({ filePath, collectionDef }) => {
            try {
                const content = readFileSync(filePath, 'utf-8');
                const hash = hashContent(content);
                const needsReindex = this.chunkStore.needsReindex(filePath, collectionDef.collection, hash);
                return { filePath, collection: collectionDef.collection, needsReindex };
            }
            catch {
                return { filePath, collection: collectionDef.collection, needsReindex: true };
            }
        });
    }
    /**
     * Get stats about what's currently indexed.
     */
    getIndexStats() {
        return this.chunkStore.getStats();
    }
    /**
     * Query indexed chunks by collection.
     */
    queryChunks(collection, opts = {}) {
        return this.chunkStore.queryChunks({ collection, ...opts });
    }
    // ─── Private helpers ─────────────────────────────────────────
    discoverFiles(workspaceDir, opts) {
        const files = [];
        // Known ACA files in workspace root
        for (const fileName of Object.keys(ACA_COLLECTIONS)) {
            const filePath = path.join(workspaceDir, fileName);
            if (!existsSync(filePath))
                continue;
            const collectionDef = inferCollection(fileName, opts.agentId);
            if (!collectionDef)
                continue;
            files.push({ filePath, collectionDef });
        }
        // Daily memory files
        if (opts.includeDailyMemory !== false) {
            const memoryDir = path.join(workspaceDir, 'memory');
            if (existsSync(memoryDir)) {
                const memFiles = readdirSync(memoryDir)
                    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
                    .sort()
                    .reverse(); // Most recent first
                const limit = opts.dailyMemoryLimit ?? 30;
                for (const memFile of memFiles.slice(0, limit)) {
                    const filePath = path.join(memoryDir, memFile);
                    const collectionDef = inferCollection(memFile, opts.agentId);
                    if (collectionDef) {
                        files.push({ filePath, collectionDef });
                    }
                }
            }
        }
        return files;
    }
}
// ─── Standalone seed function ────────────────────────────────────
/**
 * Seed a workspace directly from a DatabaseSync instance.
 * Convenience wrapper for use in the hook handler and CLI.
 */
export async function seedWorkspace(db, workspaceDir, opts = {}) {
    const seeder = new WorkspaceSeeder(db);
    return seeder.seedWorkspace(workspaceDir, opts);
}
//# sourceMappingURL=seed.js.map