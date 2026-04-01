/**
 * HyperMem Database Manager
 *
 * Three-file architecture per agent:
 *   agents/{agentId}/messages.db  — write-heavy conversation log (rotatable)
 *   agents/{agentId}/vectors.db   — search index (reconstructable)
 *   library.db                    — fleet-wide structured knowledge (crown jewel)
 *
 * Uses node:sqlite (built into Node 22+) for synchronous, zero-dependency access.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './schema.js';
import { migrateLibrary } from './library-schema.js';

// sqlite-vec extension loading — optional dependency
import { createRequire } from 'node:module';

let sqliteVecAvailable: boolean | null = null;
let sqliteVecLoad: ((db: unknown) => void) | null = null;

function loadSqliteVec(db: DatabaseSync): boolean {
  if (sqliteVecAvailable === null) {
    try {
      const require = createRequire(import.meta.url);
      const mod = require('sqlite-vec');
      sqliteVecLoad = mod.load;
      sqliteVecAvailable = true;
    } catch {
      sqliteVecAvailable = false;
      sqliteVecLoad = null;
    }
  }

  if (!sqliteVecAvailable || !sqliteVecLoad) return false;

  try {
    sqliteVecLoad(db);
    return true;
  } catch {
    return false;
  }
}

export interface DatabaseManagerConfig {
  dataDir: string; // ~/.openclaw/hypermem
}

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME || '/home/lumadmin',
  '.openclaw',
  'hypermem'
);

/**
 * Apply standard pragmas to a database connection.
 */
function applyPragmas(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
}

/**
 * Get the directory for an agent's databases.
 */
function agentDir(dataDir: string, agentId: string): string {
  return path.join(dataDir, 'agents', agentId);
}

export class DatabaseManager {
  private readonly dataDir: string;
  private readonly messageDbs = new Map<string, DatabaseSync>();
  private readonly vectorDbs = new Map<string, DatabaseSync>();
  private libraryDb: DatabaseSync | null = null;
  private _vecAvailable: boolean | null = null;

  /** Whether sqlite-vec was successfully loaded on the most recent DB open. */
  get vecAvailable(): boolean {
    return this._vecAvailable === true;
  }

  constructor(config?: Partial<DatabaseManagerConfig>) {
    this.dataDir = config?.dataDir || DEFAULT_DATA_DIR;
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  /**
   * Get or create the message database for an agent.
   * This is the write-heavy, rotatable conversation log.
   */
  getMessageDb(agentId: string): DatabaseSync {
    let db = this.messageDbs.get(agentId);
    if (db) return db;

    const dir = agentDir(this.dataDir, agentId);
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'messages.db');

    db = new DatabaseSync(dbPath);
    applyPragmas(db);
    migrate(db);

    this.messageDbs.set(agentId, db);
    return db;
  }

  /**
   * Get or create the vector database for an agent.
   * This is the search index — fully reconstructable.
   * Returns null if sqlite-vec is not available.
   */
  getVectorDb(agentId: string): DatabaseSync | null {
    let db = this.vectorDbs.get(agentId);
    if (db) return db;

    const dir = agentDir(this.dataDir, agentId);
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, 'vectors.db');

    db = new DatabaseSync(dbPath, { allowExtension: true });
    applyPragmas(db);

    const vecLoaded = loadSqliteVec(db);
    this._vecAvailable = vecLoaded;

    if (!vecLoaded) {
      // Close and don't cache — no point without vec extension
      try { db.close(); } catch { /* ignore */ }
      return null;
    }

    // Create vector tables (managed by VectorStore, but we ensure the DB is ready)
    this.vectorDbs.set(agentId, db);
    return db;
  }

  /**
   * Get or create the shared library database.
   * This is the fleet-wide knowledge store — the crown jewel.
   */
  getLibraryDb(): DatabaseSync {
    if (this.libraryDb) return this.libraryDb;

    const dbPath = path.join(this.dataDir, 'library.db');
    this.libraryDb = new DatabaseSync(dbPath);
    applyPragmas(this.libraryDb);
    migrateLibrary(this.libraryDb);

    return this.libraryDb;
  }

  // ── Legacy compatibility ──────────────────────────────────────

  /**
   * @deprecated Use getMessageDb() instead. Kept for migration period.
   * Maps to getMessageDb() for backward compatibility.
   */
  getAgentDb(agentId: string): DatabaseSync {
    return this.getMessageDb(agentId);
  }

  /**
   * Ensure agent metadata exists in the message DB.
   */
  ensureAgent(agentId: string, meta?: {
    displayName?: string;
    tier?: string;
    org?: string;
  }): void {
    const db = this.getMessageDb(agentId);
    const now = new Date().toISOString();

    const existing = db
      .prepare('SELECT id FROM agent_meta WHERE id = ?')
      .get(agentId) as { id: string } | undefined;

    if (!existing) {
      db.prepare(`
        INSERT INTO agent_meta (id, display_name, tier, org, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        agentId,
        meta?.displayName || agentId,
        meta?.tier || 'unknown',
        meta?.org || 'unknown',
        now,
        now
      );
    }

    // Also register in fleet registry (library)
    this.ensureFleetAgent(agentId, meta);
  }

  /**
   * Ensure agent exists in the fleet registry (library DB).
   */
  private ensureFleetAgent(agentId: string, meta?: {
    displayName?: string;
    tier?: string;
    org?: string;
  }): void {
    const db = this.getLibraryDb();
    const now = new Date().toISOString();

    const existing = db
      .prepare('SELECT id FROM fleet_agents WHERE id = ?')
      .get(agentId) as { id: string } | undefined;

    if (!existing) {
      db.prepare(`
        INSERT INTO fleet_agents (id, display_name, tier, org_id, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(
        agentId,
        meta?.displayName || agentId,
        meta?.tier || 'unknown',
        meta?.org || null,
        now,
        now
      );
    } else {
      // Update last_seen
      db.prepare('UPDATE fleet_agents SET last_seen = ?, updated_at = ? WHERE id = ?')
        .run(now, now, agentId);
    }
  }

  /**
   * List all agents with message databases.
   */
  listAgents(): string[] {
    const agentsDir = path.join(this.dataDir, 'agents');
    if (!fs.existsSync(agentsDir)) return [];
    return fs.readdirSync(agentsDir).filter(f => {
      const stat = fs.statSync(path.join(agentsDir, f));
      return stat.isDirectory();
    });
  }

  /**
   * Get the path to an agent's directory.
   */
  getAgentDir(agentId: string): string {
    return agentDir(this.dataDir, agentId);
  }

  /**
   * List rotated message DB files for an agent.
   */
  listRotatedDbs(agentId: string): string[] {
    const dir = agentDir(this.dataDir, agentId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.startsWith('messages_') && f.endsWith('.db'))
      .sort();
  }

  /**
   * Close all open database connections.
   */
  close(): void {
    for (const [, db] of this.messageDbs) {
      try { db.close(); } catch { /* ignore */ }
    }
    this.messageDbs.clear();

    for (const [, db] of this.vectorDbs) {
      try { db.close(); } catch { /* ignore */ }
    }
    this.vectorDbs.clear();

    if (this.libraryDb) {
      try { this.libraryDb.close(); } catch { /* ignore */ }
      this.libraryDb = null;
    }
  }
}
