/**
 * HyperMem Database Manager
 *
 * Manages SQLite database connections per agent.
 * Uses node:sqlite (built into Node 22+) for synchronous, zero-dependency access.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { migrate } from './schema.js';
import { migrateLibrary } from './library-schema.js';

// sqlite-vec extension loading — optional dependency
// Uses createRequire for synchronous resolution in ESM context.
import { createRequire } from 'node:module';

let sqliteVecAvailable: boolean | null = null; // null = not yet tested
let sqliteVecLoad: ((db: unknown) => void) | null = null;

function loadSqliteVec(db: DatabaseSync): boolean {
  // Lazy-load on first call
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
    // Extension load failed on this specific DB
    return false;
  }
}

export interface DatabaseManagerConfig {
  dataDir: string;  // ~/.openclaw/hypermem
}

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME || '/home/lumadmin',
  '.openclaw',
  'hypermem'
);

export class DatabaseManager {
  private readonly dataDir: string;
  private readonly agentDbs = new Map<string, DatabaseSync>();
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
   * Get or create the database for an agent.
   * Runs migrations on first open.
   */
  getAgentDb(agentId: string): DatabaseSync {
    let db = this.agentDbs.get(agentId);
    if (db) return db;

    const dbPath = path.join(this.dataDir, `${agentId}.db`);
    db = new DatabaseSync(dbPath, { allowExtension: true });

    // Enable WAL mode for better concurrent read performance
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');

    // Load sqlite-vec extension (optional — degrades to FTS-only if unavailable)
    this._vecAvailable = loadSqliteVec(db);

    // Run migrations
    migrate(db);

    this.agentDbs.set(agentId, db);
    return db;
  }

  /**
   * Get or create the shared library database.
   */
  getLibraryDb(): DatabaseSync {
    if (this.libraryDb) return this.libraryDb;

    const dbPath = path.join(this.dataDir, 'library.db');
    this.libraryDb = new DatabaseSync(dbPath, { allowExtension: true });

    this.libraryDb.exec('PRAGMA journal_mode = WAL');
    this.libraryDb.exec('PRAGMA synchronous = NORMAL');
    this.libraryDb.exec('PRAGMA foreign_keys = ON');
    this.libraryDb.exec('PRAGMA busy_timeout = 5000');

    loadSqliteVec(this.libraryDb);
    migrateLibrary(this.libraryDb);

    return this.libraryDb;
  }

  /**
   * Ensure the agent row exists in the agents table.
   */
  ensureAgent(agentId: string, meta?: {
    displayName?: string;
    tier?: string;
    org?: string;
  }): void {
    const db = this.getAgentDb(agentId);
    const now = new Date().toISOString();

    const existing = db
      .prepare('SELECT id FROM agents WHERE id = ?')
      .get(agentId) as { id: string } | undefined;

    if (!existing) {
      db.prepare(`
        INSERT INTO agents (id, display_name, tier, org, created_at, updated_at)
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
  }

  /**
   * List all agent databases.
   */
  listAgents(): string[] {
    const files = fs.readdirSync(this.dataDir);
    return files
      .filter(f => f.endsWith('.db') && f !== 'library.db')
      .map(f => f.replace('.db', ''));
  }

  /**
   * Close all open database connections.
   */
  close(): void {
    for (const [, db] of this.agentDbs) {
      try { db.close(); } catch { /* ignore */ }
    }
    this.agentDbs.clear();

    if (this.libraryDb) {
      try { this.libraryDb.close(); } catch { /* ignore */ }
      this.libraryDb = null;
    }
  }
}
