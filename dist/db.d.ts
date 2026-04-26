/**
 * hypermem Database Manager
 *
 * Three-file architecture per agent:
 *   agents/{agentId}/messages.db  — write-heavy conversation log (rotatable)
 *   agents/{agentId}/vectors.db   — search index (reconstructable)
 *   library.db                    — fleet-wide structured knowledge (crown jewel)
 *
 * Uses node:sqlite (built into Node 22+) for synchronous, zero-dependency access.
 */
import { DatabaseSync } from 'node:sqlite';
export interface DatabaseManagerConfig {
    dataDir: string;
}
/**
 * Validate agentId to prevent path traversal.
 * Must match [a-z0-9][a-z0-9-]* (lowercase alphanumeric + hyphens, no dots or slashes).
 */
declare function validateAgentId(agentId: string): void;
/**
 * Validate rotated DB filename to prevent path traversal.
 * Must match the expected rotation pattern: messages_YYYYQN(_N)?.db
 */
declare function validateRotatedFilename(filename: string): void;
export { validateAgentId, validateRotatedFilename };
export declare class DatabaseManager {
    private readonly dataDir;
    private readonly messageDbs;
    private readonly vectorDbs;
    private libraryDb;
    private _vecAvailable;
    /** Whether sqlite-vec was successfully loaded on the most recent DB open. */
    get vecAvailable(): boolean;
    constructor(config?: Partial<DatabaseManagerConfig>);
    /**
     * Get or create the message database for an agent.
     * This is the write-heavy, rotatable conversation log.
     */
    getMessageDb(agentId: string): DatabaseSync;
    /**
     * Get or create the vector database for an agent.
     * This is the search index — fully reconstructable.
     * Returns null if sqlite-vec is not available.
     */
    getVectorDb(agentId: string): DatabaseSync | null;
    /**
     * Get or create the shared (fleet-wide) vector database.
     * Unlike per-agent vector DBs, this is a single vectors.db at the root of dataDir,
     * shared across all agents. Facts and episodes from all agents are indexed together,
     * keyed by (source_table, source_id) in vec_index_map.
     * Returns null if sqlite-vec is not available.
     */
    getSharedVectorDb(): DatabaseSync | null;
    /**
     * Get or create the shared library database.
     * This is the fleet-wide knowledge store — the crown jewel.
     */
    getLibraryDb(): DatabaseSync;
    /**
     * @deprecated Use getMessageDb() instead. Kept for migration period.
     * Maps to getMessageDb() for backward compatibility.
     */
    getAgentDb(agentId: string): DatabaseSync;
    /**
     * Ensure agent metadata exists in the message DB.
     */
    ensureAgent(agentId: string, meta?: {
        displayName?: string;
        tier?: string;
        org?: string;
    }): void;
    /**
     * Ensure agent exists in the fleet registry (library DB).
     */
    private ensureFleetAgent;
    /**
     * List all agents with message databases.
     */
    listAgents(): string[];
    /**
     * Get the path to an agent's directory.
     */
    getAgentDir(agentId: string): string;
    /**
     * List rotated message DB files for an agent.
     */
    listRotatedDbs(agentId: string): string[];
    /**
     * Get the size of the active messages.db for an agent (in bytes).
     */
    getMessageDbSize(agentId: string): number;
    /**
     * Rotate the message database for an agent.
     *
     * 1. Closes the active messages.db connection
     * 2. Renames messages.db → messages_{YYYYQN}.db (e.g., messages_2026Q1.db)
     * 3. Removes associated WAL/SHM files
     * 4. Next call to getMessageDb() creates a fresh database
     *
     * The rotated file is read-only archive material. The vector index
     * retains references to it via source_db in vec_index_map.
     *
     * Returns the path to the rotated file, or null if rotation wasn't needed.
     */
    rotateMessageDb(agentId: string): string | null;
    /**
     * Check if an agent's message database needs rotation.
     * Triggers on:
     *   - Size exceeds threshold (default 100MB)
     *   - Time since creation exceeds threshold (default 90 days)
     *
     * Returns the reason for rotation, or null if no rotation needed.
     */
    shouldRotate(agentId: string, opts?: {
        maxSizeBytes?: number;
        maxAgeDays?: number;
    }): {
        reason: 'size' | 'age';
        current: number;
        threshold: number;
    } | null;
    /**
     * Open a rotated message database as read-only for querying.
     */
    openRotatedDb(agentId: string, filename: string): DatabaseSync;
    /**
     * Close all open database connections.
     */
    close(): void;
}
//# sourceMappingURL=db.d.ts.map