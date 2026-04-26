import { attachInlineIntegrityHash, canonicalizeSnapshotJson, computeSlotsIntegrityHash, isInlineSnapshotSlotPayload, parseSnapshotSlotsJson, verifySnapshotSlotsIntegrity, } from './composition-snapshot-integrity.js';
export const MAX_WARM_RESTORE_REPAIR_DEPTH = 1;
function nowIso() {
    return new Date().toISOString();
}
function parseSnapshotRow(row) {
    return {
        id: row.id,
        contextId: row.context_id,
        headMessageId: row.head_message_id ?? null,
        schemaVersion: row.schema_version,
        capturedAt: row.captured_at,
        model: row.model,
        contextWindow: row.context_window,
        totalTokens: row.total_tokens,
        fillPct: row.fill_pct,
        snapshotKind: row.snapshot_kind,
        repairDepth: row.repair_depth,
        slotsJson: row.slots_json,
        slotsIntegrityHash: row.slots_integrity_hash,
        createdAt: row.created_at,
    };
}
function normalizeSlots(slots) {
    const parsed = typeof slots === 'string' ? parseSnapshotSlotsJson(slots) : parseSnapshotSlotsJson(canonicalizeSnapshotJson(slots));
    const normalized = {};
    for (const [slotKey, slotValue] of Object.entries(parsed)) {
        normalized[slotKey] = isInlineSnapshotSlotPayload(slotValue)
            ? attachInlineIntegrityHash(slotValue)
            : slotValue;
    }
    return normalized;
}
function normalizeRepairDepth(repairDepth) {
    const normalized = repairDepth ?? 0;
    if (!Number.isInteger(normalized) || normalized < 0 || normalized > MAX_WARM_RESTORE_REPAIR_DEPTH) {
        throw new Error(`composition snapshot repair_depth must be an integer between 0 and ${MAX_WARM_RESTORE_REPAIR_DEPTH}`);
    }
    return normalized;
}
export function insertCompositionSnapshot(db, input) {
    const capturedAt = input.capturedAt ?? nowIso();
    const createdAt = input.createdAt ?? capturedAt;
    const repairDepth = normalizeRepairDepth(input.repairDepth);
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
  `).run(input.contextId, input.headMessageId ?? null, input.schemaVersion ?? 1, capturedAt, input.model, input.contextWindow, input.totalTokens, input.fillPct, input.snapshotKind ?? 'full', repairDepth, slotsJson, slotsIntegrityHash, createdAt);
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
        .get(Number(result.lastInsertRowid));
    if (!row) {
        throw new Error('Failed to read back inserted composition snapshot');
    }
    return parseSnapshotRow(row);
}
export function listCompositionSnapshots(db, contextId, limit = 2) {
    const rows = db.prepare(`
    SELECT *
    FROM composition_snapshots
    WHERE context_id = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT ?
  `).all(contextId, limit);
    return rows.map(parseSnapshotRow);
}
export function getCompositionSnapshot(db, snapshotId) {
    const row = db.prepare('SELECT * FROM composition_snapshots WHERE id = ?')
        .get(snapshotId);
    return row ? parseSnapshotRow(row) : null;
}
export function verifyCompositionSnapshot(snapshot) {
    return verifySnapshotSlotsIntegrity(snapshot.slotsJson, snapshot.slotsIntegrityHash);
}
export function getLatestValidCompositionSnapshot(db, contextId) {
    const candidates = listCompositionSnapshots(db, contextId, 2)
        .filter(snapshot => snapshot.repairDepth < MAX_WARM_RESTORE_REPAIR_DEPTH);
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
//# sourceMappingURL=composition-snapshot-store.js.map