export type SnapshotJsonPrimitive = string | number | boolean | null;
export type SnapshotJsonValue = SnapshotJsonPrimitive | SnapshotJsonValue[] | SnapshotJsonObject;
export interface SnapshotJsonObject {
    [key: string]: SnapshotJsonValue;
}
export type SnapshotSlotsRecord = Record<string, SnapshotJsonValue>;
export type InlineSnapshotSlotPayload = SnapshotJsonObject & {
    kind?: string | null;
    source?: string | null;
    inline?: boolean | null;
    content?: SnapshotJsonValue;
    integrity_hash?: string | null;
};
export type SnapshotIntegrityFailureReason = 'malformed_slots_json' | 'invalid_slots_root' | 'missing_inline_integrity_hash' | 'inline_hash_mismatch' | 'slots_hash_mismatch';
export interface SnapshotIntegrityFailure {
    slotKey: string;
    reason: SnapshotIntegrityFailureReason;
    expected?: string;
    actual?: string;
    error?: string;
}
export interface SnapshotIntegrityVerification {
    ok: boolean;
    slots: SnapshotSlotsRecord | null;
    actualSlotsHash: string | null;
    failures: SnapshotIntegrityFailure[];
}
export declare function canonicalizeSnapshotJson(value: unknown): string;
export declare function hashSnapshotJson(value: unknown): string;
export declare function parseSnapshotSlotsJson(raw: string): SnapshotSlotsRecord;
export declare function isInlineSnapshotSlotPayload(value: SnapshotJsonValue): value is InlineSnapshotSlotPayload;
export declare function computeInlineIntegrityHash(payload: InlineSnapshotSlotPayload): string;
export declare function attachInlineIntegrityHash(payload: InlineSnapshotSlotPayload): InlineSnapshotSlotPayload;
export declare function computeSlotsIntegrityHash(slots: SnapshotSlotsRecord): string;
export declare function verifySnapshotSlotsIntegrity(slotsInput: SnapshotSlotsRecord | string, expectedSlotsHash?: string): SnapshotIntegrityVerification;
//# sourceMappingURL=composition-snapshot-integrity.d.ts.map