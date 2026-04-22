import type { DatabaseSync } from 'node:sqlite';

import {
  attachInlineIntegrityHash,
  canonicalizeSnapshotJson,
  computeSlotsIntegrityHash,
  isInlineSnapshotSlotPayload,
  parseSnapshotSlotsJson,
  verifySnapshotSlotsIntegrity,
  type SnapshotIntegrityVerification,
  type SnapshotSlotsRecord,
} from './composition-snapshot-integrity.js';

export interface CompositionSnapshotRecord {
  id: number;
  contextId: number;
  headMessageId: number | null;
  schemaVersion: number;
  capturedAt: string;
  model: string;
  contextWindow: number;
  totalTokens: number;
  fillPct: number;
  snapshotKind: string;
  repairDepth: number;
  slotsJson: string;
  slotsIntegrityHash: string;
  createdAt: string;
}

export interface InsertCompositionSnapshotInput {
  contextId: number;
  headMessageId?: number | null;
  schemaVersion?: number;
  capturedAt?: string;
  model: string;
  contextWindow: number;
  totalTokens: number;
  fillPct: number;
  snapshotKind?: string;
  repairDepth?: number;
  slots: SnapshotSlotsRecord | string;
  createdAt?: string;
}

export interface LatestValidCompositionSnapshot {
  snapshot: CompositionSnapshotRecord;
  verification: SnapshotIntegrityVerification;
  fallbackUsed: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseSnapshotRow(row: Record<string, unknown>): CompositionSnapshotRecord {
  return {
    id: row.id as number,
    contextId: row.context_id as number,
    headMessageId: (row.head_message_id as number | null) ?? null,
    schemaVersion: row.schema_version as number,
    capturedAt: row.captured_at as string,
    model: row.model as string,
    contextWindow: row.context_window as number,
    totalTokens: row.total_tokens as number,
    fillPct: row.fill_pct as number,
    snapshotKind: row.snapshot_kind as string,
    repairDepth: row.repair_depth as number,
    slotsJson: row.slots_json as string,
    slotsIntegrityHash: row.slots_integrity_hash as string,
    createdAt: row.created_at as string,
  };
}

function normalizeSlots(slots: SnapshotSlotsRecord | string): SnapshotSlotsRecord {
  const parsed = typeof slots === 'string' ? parseSnapshotSlotsJson(slots) : parseSnapshotSlotsJson(canonicalizeSnapshotJson(slots));
  const normalized: SnapshotSlotsRecord = {};
  for (const [slotKey, slotValue] of Object.entries(parsed)) {
    normalized[slotKey] = isInlineSnapshotSlotPayload(slotValue)
      ? attachInlineIntegrityHash(slotValue)
      : slotValue;
  }
  return normalized;
}

export function insertCompositionSnapshot(
  db: DatabaseSync,
  input: InsertCompositionSnapshotInput,
): CompositionSnapshotRecord {
  const capturedAt = input.capturedAt ?? nowIso();
  const createdAt = input.createdAt ?? capturedAt;
  const normalizedSlots = normalizeSlots(input.slots);
  const slotsJson = canonicalizeSnapshotJson(normalizedSlots);
  const slotsIntegrityHash = computeSlotsIntegrityHash(normalizedSlots);

  const result = db.prepare(`
    INSERT INTO composition_snapshots (
      context_id,
      head_message_id,
      schema_version,
      captured_at,
      model,
      context_window,
      total_tokens,
      fill_pct,
      snapshot_kind,
      repair_depth,
      slots_json,
      slots_integrity_hash,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.contextId,
    input.headMessageId ?? null,
    input.schemaVersion ?? 1,
    capturedAt,
    input.model,
    input.contextWindow,
    input.totalTokens,
    input.fillPct,
    input.snapshotKind ?? 'full',
    input.repairDepth ?? 0,
    slotsJson,
    slotsIntegrityHash,
    createdAt,
  );

  db.prepare(`
    DELETE FROM composition_snapshots
    WHERE context_id = ?
      AND id NOT IN (
        SELECT id
        FROM composition_snapshots
        WHERE context_id = ?
        ORDER BY captured_at DESC, id DESC
        LIMIT 2
      )
  `).run(input.contextId, input.contextId);

  const row = db.prepare('SELECT * FROM composition_snapshots WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error('Failed to read back inserted composition snapshot');
  }

  return parseSnapshotRow(row);
}

export function listCompositionSnapshots(
  db: DatabaseSync,
  contextId: number,
  limit = 2,
): CompositionSnapshotRecord[] {
  const rows = db.prepare(`
    SELECT *
    FROM composition_snapshots
    WHERE context_id = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT ?
  `).all(contextId, limit) as Record<string, unknown>[];

  return rows.map(parseSnapshotRow);
}

export function getCompositionSnapshot(
  db: DatabaseSync,
  snapshotId: number,
): CompositionSnapshotRecord | null {
  const row = db.prepare('SELECT * FROM composition_snapshots WHERE id = ?')
    .get(snapshotId) as Record<string, unknown> | undefined;
  return row ? parseSnapshotRow(row) : null;
}

export function verifyCompositionSnapshot(
  snapshot: CompositionSnapshotRecord,
): SnapshotIntegrityVerification {
  return verifySnapshotSlotsIntegrity(snapshot.slotsJson, snapshot.slotsIntegrityHash);
}

export function getLatestValidCompositionSnapshot(
  db: DatabaseSync,
  contextId: number,
): LatestValidCompositionSnapshot | null {
  const candidates = listCompositionSnapshots(db, contextId, 2);
  for (let i = 0; i < candidates.length; i++) {
    const snapshot = candidates[i];
    const verification = verifyCompositionSnapshot(snapshot);
    if (verification.ok) {
      return {
        snapshot,
        verification,
        fallbackUsed: i > 0,
      };
    }
  }
  return null;
}
