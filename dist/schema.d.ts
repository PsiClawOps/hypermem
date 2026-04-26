/**
 * hypermem Agent Message Schema
 *
 * Per-agent database: ~/.openclaw/hypermem/agents/{agentId}/messages.db
 * Write-heavy, temporal, rotatable.
 * Contains ONLY conversation data — structured knowledge lives in library.db.
 */
import type { DatabaseSync } from 'node:sqlite';
export declare const LATEST_SCHEMA_VERSION = 11;
/**
 * Run migrations on an agent message database.
 */
export declare function migrate(db: DatabaseSync): void;
export { LATEST_SCHEMA_VERSION as SCHEMA_VERSION };
//# sourceMappingURL=schema.d.ts.map