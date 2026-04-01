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
 * Validate agentId to prevent path traversal.
 * Must match [a-z0-9][a-z0-9-]* (lowercase alphanumeric + hyphens, no dots or slashes).
 */
function validateAgentId(agentId: string): void {
  if (!agentId || !/^[a-z0-9][a-z0-9-]*$/.test(agentId)) {
    throw new Error(`Invalid agentId: "${agentId}". Must match [a-z0-9][a-z0-9-]*`);
  }
}

/**
 * Validate rotated DB filename to prevent path traversal.
 * Must match the expected rotation pattern: messages_YYYYQN(_N)?.db
 */
function validateRotatedFilename(filename: string): void {
  if (!/^messages_\d{4}Q[1-4](_\d+)?\.db$/.test(filename)) {
    throw new Error(`Invalid rotated DB filename: "${filename}". Must match messages_YYYYQN.db pattern`);
  }
}

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

export { validateAgentId, validateRotatedFilename };

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
    validateAgentId(agentId);
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
    validateAgentId(agentId);
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
    validateAgentId(agentId);
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
    validateAgentId(agentId);
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
   * Get the size of the active messages.db for an agent (in bytes).
   */
  getMessageDbSize(agentId: string): number {
    const dir = agentDir(this.dataDir, agentId);
    const dbPath = path.join(dir, 'messages.db');
    try {
      const stat = fs.statSync(dbPath);
      return stat.size;
    } catch {
      return 0;
    }
  }

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
  rotateMessageDb(agentId: string): string | null {
    const dir = agentDir(this.dataDir, agentId);
    const activePath = path.join(dir, 'messages.db');

    if (!fs.existsSync(activePath)) return null;

    // Close the active connection first
    const existingDb = this.messageDbs.get(agentId);
    if (existingDb) {
      try {
        // Checkpoint WAL into the main database before rotating
        existingDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        existingDb.close();
      } catch { /* ignore */ }
      this.messageDbs.delete(agentId);
    }

    // Generate rotation name: messages_YYYYQN.db
    const now = new Date();
    const year = now.getFullYear();
    const quarter = Math.ceil((now.getMonth() + 1) / 3);
    let rotatedName = `messages_${year}Q${quarter}.db`;
    let rotatedPath = path.join(dir, rotatedName);

    // Handle collision — append a suffix if this quarter already has a rotation
    let suffix = 1;
    while (fs.existsSync(rotatedPath)) {
      rotatedName = `messages_${year}Q${quarter}_${suffix}.db`;
      rotatedPath = path.join(dir, rotatedName);
      suffix++;
    }

    // Rename the active DB to the rotated name
    fs.renameSync(activePath, rotatedPath);

    // Clean up WAL and SHM files
    for (const ext of ['-wal', '-shm']) {
      const walPath = activePath + ext;
      if (fs.existsSync(walPath)) {
        try { fs.unlinkSync(walPath); } catch { /* ignore */ }
      }
    }

    return rotatedPath;
  }

  /**
   * Check if an agent's message database needs rotation.
   * Triggers on:
   *   - Size exceeds threshold (default 100MB)
   *   - Time since creation exceeds threshold (default 90 days)
   * 
   * Returns the reason for rotation, or null if no rotation needed.
   */
  shouldRotate(agentId: string, opts?: {
    maxSizeBytes?: number;  // Default: 100MB
    maxAgeDays?: number;    // Default: 90 days
  }): { reason: 'size' | 'age'; current: number; threshold: number } | null {
    const maxSize = opts?.maxSizeBytes ?? 100 * 1024 * 1024; // 100MB
    const maxAge = opts?.maxAgeDays ?? 90;

    // Check size
    const size = this.getMessageDbSize(agentId);
    if (size > maxSize) {
      return { reason: 'size', current: size, threshold: maxSize };
    }

    // Check age — look at the earliest conversation in the DB
    const db = this.getMessageDb(agentId);
    const oldest = db.prepare(
      'SELECT MIN(created_at) as earliest FROM conversations'
    ).get() as { earliest: string | null } | undefined;

    if (oldest?.earliest) {
      const created = new Date(oldest.earliest);
      const ageMs = Date.now() - created.getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays > maxAge) {
        return { reason: 'age', current: Math.round(ageDays), threshold: maxAge };
      }
    }

    return null;
  }

  /**
   * Open a rotated message database as read-only for querying.
   */
  openRotatedDb(agentId: string, filename: string): DatabaseSync {
    validateAgentId(agentId);
    validateRotatedFilename(filename);
    const dir = agentDir(this.dataDir, agentId);
    const dbPath = path.join(dir, filename);

    if (!fs.existsSync(dbPath)) {
      throw new Error(`Rotated DB not found: ${dbPath}`);
    }

    const db = new DatabaseSync(dbPath, { readOnly: true } as unknown as Record<string, unknown>);
    return db;
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
