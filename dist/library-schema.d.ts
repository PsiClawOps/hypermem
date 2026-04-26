/**
 * hypermem Library Schema — Fleet-Wide Structured Knowledge
 *
 * Single database: ~/.openclaw/hypermem/library.db
 * The "crown jewel" — durable, backed up, low-write-frequency.
 *
 * Collections:
 *   1. Library entries (versioned docs, specs, reference material)
 *   2. Facts (agent-learned truths with confidence, visibility, temporal validity)
 *   3. Preferences (behavioral patterns)
 *   4. Knowledge/wiki (structured domain knowledge, supersedable topic syntheses)
 *   5. Episodes (significant events, decisions, discoveries)
 *   6. Topics (cross-session thread tracking)
 *   7. Knowledge graph links (relationships between facts, knowledge, topics, episodes)
 *   8. Fleet registry (agents, orgs, capabilities)
 *   9. Desired state and config events (drift detection)
 *  10. System registry and work items (server state, work queues, events)
 *  11. Session registry and lifecycle events
 *  12. Document sources/chunks and trigger retrieval metadata
 *  13. Output standards, model directives, and output metrics
 *  14. Temporal index, expertise patterns, contradiction audits, and indexer watermarks
 */
import { DatabaseSync } from 'node:sqlite';
export declare const LIBRARY_SCHEMA_VERSION = 19;
export declare function repairLibraryDb(dbPath: string): {
    repaired: boolean;
    backupPath?: string;
    message: string;
};
export declare function migrateLibrary(db: DatabaseSync, engineVersion?: string): void;
//# sourceMappingURL=library-schema.d.ts.map