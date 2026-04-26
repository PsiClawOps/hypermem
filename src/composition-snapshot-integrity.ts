import { createHash } from 'node:crypto';

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

export type SnapshotIntegrityFailureReason =
  | 'malformed_slots_json'
  | 'invalid_slots_root'
  | 'missing_inline_integrity_hash'
  | 'inline_hash_mismatch'
  | 'slots_hash_mismatch';

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeSnapshotJson(value: unknown): SnapshotJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (isFiniteNumber(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(entry => normalizeSnapshotJson(entry));
  }

  if (isPlainObject(value)) {
    const out: SnapshotJsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const next = value[key];
      if (next === undefined) continue;
      out[key] = normalizeSnapshotJson(next);
    }
    return out;
  }

  throw new TypeError(`Unsupported snapshot JSON value: ${String(value)}`);
}

export function canonicalizeSnapshotJson(value: unknown): string {
  return JSON.stringify(normalizeSnapshotJson(value));
}

export function hashSnapshotJson(value: unknown): string {
  return createHash('sha256').update(canonicalizeSnapshotJson(value)).digest('hex');
}

export function parseSnapshotSlotsJson(raw: string): SnapshotSlotsRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed slots_json: ${message}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error('Invalid slots_json root: expected object');
  }

  return normalizeSnapshotJson(parsed) as SnapshotSlotsRecord;
}

export function isInlineSnapshotSlotPayload(value: SnapshotJsonValue): value is InlineSnapshotSlotPayload {
  if (!isPlainObject(value)) return false;
  return value.kind === 'inline' || value.source === 'inline' || value.inline === true;
}

function stripInlineIntegrityHash(payload: InlineSnapshotSlotPayload): SnapshotJsonObject {
  const { integrity_hash: _integrityHash, ...rest } = payload;
  return normalizeSnapshotJson(rest) as SnapshotJsonObject;
}

export function computeInlineIntegrityHash(payload: InlineSnapshotSlotPayload): string {
  return hashSnapshotJson(stripInlineIntegrityHash(payload));
}

export function attachInlineIntegrityHash(payload: InlineSnapshotSlotPayload): InlineSnapshotSlotPayload {
  return {
    ...payload,
    integrity_hash: computeInlineIntegrityHash(payload),
  };
}

export function computeSlotsIntegrityHash(slots: SnapshotSlotsRecord): string {
  return hashSnapshotJson(slots);
}

export function verifySnapshotSlotsIntegrity(
  slotsInput: SnapshotSlotsRecord | string,
  expectedSlotsHash?: string,
): SnapshotIntegrityVerification {
  let slots: SnapshotSlotsRecord;
  try {
    slots = typeof slotsInput === 'string'
      ? parseSnapshotSlotsJson(slotsInput)
      : normalizeSnapshotJson(slotsInput) as SnapshotSlotsRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason: SnapshotIntegrityFailureReason = message.startsWith('Invalid slots_json root')
      ? 'invalid_slots_root'
      : 'malformed_slots_json';
    return {
      ok: false,
      slots: null,
      actualSlotsHash: null,
      failures: [{ slotKey: '$slots', reason, error: message }],
    };
  }

  const failures: SnapshotIntegrityFailure[] = [];

  for (const [slotKey, slotValue] of Object.entries(slots)) {
    if (!isInlineSnapshotSlotPayload(slotValue)) continue;

    const actualField = slotValue.integrity_hash;
    if (typeof actualField !== 'string' || actualField.length === 0) {
      failures.push({
        slotKey,
        reason: 'missing_inline_integrity_hash',
      });
      continue;
    }

    const expectedField = computeInlineIntegrityHash(slotValue);
    if (actualField !== expectedField) {
      failures.push({
        slotKey,
        reason: 'inline_hash_mismatch',
        expected: expectedField,
        actual: actualField,
      });
    }
  }

  const actualSlotsHash = computeSlotsIntegrityHash(slots);
  if (expectedSlotsHash && actualSlotsHash !== expectedSlotsHash) {
    failures.push({
      slotKey: '$slots',
      reason: 'slots_hash_mismatch',
      expected: expectedSlotsHash,
      actual: actualSlotsHash,
    });
  }

  return {
    ok: failures.length === 0,
    slots,
    actualSlotsHash,
    failures,
  };
}
