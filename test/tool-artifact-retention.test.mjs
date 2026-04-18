/**
 * Tool Artifact Retention Tests — Sprint 2.2
 *
 * Covers acceptance criteria for retention sweep + sensitive-artifact flag:
 *
 * 1. Schema v10 migration adds is_sensitive column (idempotent on re-run).
 * 2. put() persists isSensitive flag; returned record reflects it.
 * 3. sweep() removes expired standard artifacts (past standardTtlMs).
 * 4. sweep() removes expired sensitive artifacts (past sensitiveTtlMs).
 * 5. sweep() keeps fresh artifacts regardless of sensitivity flag.
 * 6. Sensitive artifacts expire sooner than standard when ttls differ.
 * 7. maxPerSession cap: excess artifacts removed oldest-first.
 * 8. Repeated sweep() is idempotent (no double-delete error).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../dist/schema.js';
import { ToolArtifactStore } from '../dist/tool-artifact-store.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

/**
 * Backdate an artifact's last_used_at to simulate aging.
 * SQLite stores ISO strings — we write directly via UPDATE.
 */
function backdateArtifact(db, id, ageMs) {
  const ts = new Date(Date.now() - ageMs).toISOString();
  db.prepare('UPDATE tool_artifacts SET last_used_at = ? WHERE id = ?').run(ts, id);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Sprint 2.2 — Retention Sweep + Sensitive-Artifact Flag', () => {

  // ── 1. Schema v10 migration idempotency ───────────────────────────────────
  it('1. schema v10 adds is_sensitive column; re-running migrate is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);

    const cols = db.prepare('PRAGMA table_info(tool_artifacts)').all().map(r => r.name);
    assert.ok(cols.includes('is_sensitive'), 'is_sensitive column must exist after v10 migration');

    // schema_version must include row 10
    const row = db.prepare('SELECT version FROM schema_version WHERE version = 10').get();
    assert.ok(row, 'schema_version must have version=10 row');

    // Second migrate() call must not throw
    assert.doesNotThrow(() => migrate(db), 'second migrate() must be idempotent');

    // Column still exists and there is still exactly one v10 row
    const row2 = db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version = 10').get();
    assert.equal(row2.n, 1, 'schema_version must have exactly one v10 row after idempotent re-run');
  });

  // ── 2. put() persists isSensitive flag ────────────────────────────────────
  it('2. put() persists isSensitive flag; returned record reflects it', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);

    const sensRec = store.put({
      agentId: 'ag', sessionKey: 'sk', toolName: 'exec',
      payload: 'sensitive content', isSensitive: true,
    });
    assert.equal(sensRec.isSensitive, true, 'returned record must have isSensitive=true');

    const stdRec = store.put({
      agentId: 'ag', sessionKey: 'sk', toolName: 'read',
      payload: 'standard content', isSensitive: false,
    });
    assert.equal(stdRec.isSensitive, false, 'returned record must have isSensitive=false');

    // Verify DB column directly
    const row = db.prepare('SELECT is_sensitive FROM tool_artifacts WHERE id = ?').get(sensRec.id);
    assert.equal(row.is_sensitive, 1, 'DB column must be 1 for sensitive artifact');

    const row2 = db.prepare('SELECT is_sensitive FROM tool_artifacts WHERE id = ?').get(stdRec.id);
    assert.equal(row2.is_sensitive, 0, 'DB column must be 0 for standard artifact');

    // Default (no flag) is non-sensitive
    const defaultRec = store.put({
      agentId: 'ag', sessionKey: 'sk', toolName: 'web_search',
      payload: 'default content no flag',
    });
    assert.equal(defaultRec.isSensitive, false, 'default isSensitive must be false');
  });

  // ── 3. sweep() removes expired standard artifacts ─────────────────────────
  it('3. sweep() removes expired standard artifacts (past standardTtlMs)', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);

    const policy = { standardTtlMs: 60_000, sensitiveTtlMs: 10_000 };

    // Standard artifact aged 2 minutes — beyond standardTtlMs
    const expiredStd = store.put({
      agentId: 'ag', sessionKey: 'sk', toolName: 'exec', payload: 'expired standard',
    });
    backdateArtifact(db, expiredStd.id, 120_000);

    const deleted = store.sweep(policy);
    assert.equal(deleted, 1, 'one expired standard artifact must be deleted');

    const fetched = store.get(expiredStd.id);
    assert.equal(fetched, null, 'expired artifact must no longer exist');
  });

  // ── 4. sweep() removes expired sensitive artifacts ────────────────────────
  it('4. sweep() removes expired sensitive artifacts (past sensitiveTtlMs)', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);

    // sensitiveTtlMs=30s; artifact aged 60s
    const policy = { standardTtlMs: 3_600_000, sensitiveTtlMs: 30_000 };

    const expiredSens = store.put({
      agentId: 'ag', sessionKey: 'sk', toolName: 'exec',
      payload: 'expired sensitive', isSensitive: true,
    });
    backdateArtifact(db, expiredSens.id, 60_000);

    const deleted = store.sweep(policy);
    assert.equal(deleted, 1, 'one expired sensitive artifact must be deleted');
    assert.equal(store.get(expiredSens.id), null, 'expired sensitive artifact must not exist');
  });

  // ── 5. sweep() keeps fresh artifacts ─────────────────────────────────────
  it('5. sweep() keeps fresh artifacts regardless of sensitivity flag', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);

    const policy = { standardTtlMs: 60_000, sensitiveTtlMs: 20_000 };

    // Fresh standard artifact (not aged — just inserted)
    const freshStd = store.put({
      agentId: 'ag', sessionKey: 'sk', toolName: 'exec', payload: 'fresh standard',
    });

    // Fresh sensitive artifact
    const freshSens = store.put({
      agentId: 'ag', sessionKey: 'sk', toolName: 'read',
      payload: 'fresh sensitive', isSensitive: true,
    });

    const deleted = store.sweep(policy);
    assert.equal(deleted, 0, 'no fresh artifacts should be deleted');

    assert.ok(store.get(freshStd.id), 'fresh standard artifact must persist');
    assert.ok(store.get(freshSens.id), 'fresh sensitive artifact must persist');
  });

  // ── 6. Sensitive expires before standard when ttls differ ────────────────
  it('6. sensitive artifact expires before standard when aged past sensitiveTtlMs only', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);

    // standardTtlMs=10min, sensitiveTtlMs=1min; artifact aged 2 min
    const policy = { standardTtlMs: 600_000, sensitiveTtlMs: 60_000 };

    const stdArtifact = store.put({
      agentId: 'ag', sessionKey: 'sk', toolName: 'exec', payload: 'standard aged 2min',
    });
    const sensArtifact = store.put({
      agentId: 'ag', sessionKey: 'sk', toolName: 'exec',
      payload: 'sensitive aged 2min', isSensitive: true,
    });

    // Age both 2 minutes — past sensitiveTtlMs but not standardTtlMs
    backdateArtifact(db, stdArtifact.id, 120_000);
    backdateArtifact(db, sensArtifact.id, 120_000);

    const deleted = store.sweep(policy);
    assert.equal(deleted, 1, 'only the sensitive artifact should be deleted');

    assert.ok(store.get(stdArtifact.id), 'standard artifact must still exist');
    assert.equal(store.get(sensArtifact.id), null, 'sensitive artifact must be gone');
  });

  // ── 7. maxPerSession cap removes excess oldest-first ─────────────────────
  it('7. maxPerSession cap removes excess artifacts oldest-first', async () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);

    const policy = { standardTtlMs: 3_600_000, sensitiveTtlMs: 1_800_000, maxPerSession: 2 };

    // Insert 4 artifacts with distinct last_used_at timestamps
    const recs = [];
    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 5)); // ensure distinct timestamps
      const rec = store.put({
        agentId: 'ag', sessionKey: 'sk', toolName: 'exec',
        payload: `artifact ${i}`,
      });
      recs.push(rec);
    }

    // Age the two oldest artificially so ordering is clear
    backdateArtifact(db, recs[0].id, 3_000);
    backdateArtifact(db, recs[1].id, 2_000);
    // recs[2] and recs[3] are fresh

    const deleted = store.sweep(policy);
    assert.equal(deleted, 2, '2 excess artifacts beyond maxPerSession=2 must be deleted');

    // The 2 oldest must be gone
    assert.equal(store.get(recs[0].id), null, 'oldest artifact must be deleted');
    assert.equal(store.get(recs[1].id), null, 'second-oldest artifact must be deleted');

    // The 2 newest must survive
    assert.ok(store.get(recs[2].id), 'third artifact must survive');
    assert.ok(store.get(recs[3].id), 'newest artifact must survive');
  });

  // ── 8. Repeated sweep() is idempotent ────────────────────────────────────
  it('8. repeated sweep() is idempotent — second call deletes nothing', () => {
    const db = createTestDb();
    const store = new ToolArtifactStore(db);

    const policy = { standardTtlMs: 60_000, sensitiveTtlMs: 20_000 };

    const rec = store.put({
      agentId: 'ag', sessionKey: 'sk', toolName: 'exec', payload: 'will expire',
    });
    backdateArtifact(db, rec.id, 120_000);

    const firstSweep = store.sweep(policy);
    assert.equal(firstSweep, 1, 'first sweep must delete 1 artifact');

    // Second sweep must not throw and must delete 0
    let secondSweep;
    assert.doesNotThrow(() => {
      secondSweep = store.sweep(policy);
    }, 'second sweep must not throw');
    assert.equal(secondSweep, 0, 'second sweep must be a no-op');
  });

});
