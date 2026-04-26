import { createHash } from 'node:crypto';
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function normalizeSnapshotJson(value) {
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
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const next = value[key];
            if (next === undefined)
                continue;
            out[key] = normalizeSnapshotJson(next);
        }
        return out;
    }
    throw new TypeError(`Unsupported snapshot JSON value: ${String(value)}`);
}
export function canonicalizeSnapshotJson(value) {
    return JSON.stringify(normalizeSnapshotJson(value));
}
export function hashSnapshotJson(value) {
    return createHash('sha256').update(canonicalizeSnapshotJson(value)).digest('hex');
}
export function parseSnapshotSlotsJson(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Malformed slots_json: ${message}`);
    }
    if (!isPlainObject(parsed)) {
        throw new Error('Invalid slots_json root: expected object');
    }
    return normalizeSnapshotJson(parsed);
}
export function isInlineSnapshotSlotPayload(value) {
    if (!isPlainObject(value))
        return false;
    return value.kind === 'inline' || value.source === 'inline' || value.inline === true;
}
function stripInlineIntegrityHash(payload) {
    const { integrity_hash: _integrityHash, ...rest } = payload;
    return normalizeSnapshotJson(rest);
}
export function computeInlineIntegrityHash(payload) {
    return hashSnapshotJson(stripInlineIntegrityHash(payload));
}
export function attachInlineIntegrityHash(payload) {
    return {
        ...payload,
        integrity_hash: computeInlineIntegrityHash(payload),
    };
}
export function computeSlotsIntegrityHash(slots) {
    return hashSnapshotJson(slots);
}
export function verifySnapshotSlotsIntegrity(slotsInput, expectedSlotsHash) {
    let slots;
    try {
        slots = typeof slotsInput === 'string'
            ? parseSnapshotSlotsJson(slotsInput)
            : normalizeSnapshotJson(slotsInput);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const reason = message.startsWith('Invalid slots_json root')
            ? 'invalid_slots_root'
            : 'malformed_slots_json';
        return {
            ok: false,
            slots: null,
            actualSlotsHash: null,
            failures: [{ slotKey: '$slots', reason, error: message }],
        };
    }
    const failures = [];
    for (const [slotKey, slotValue] of Object.entries(slots)) {
        if (!isInlineSnapshotSlotPayload(slotValue))
            continue;
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
//# sourceMappingURL=composition-snapshot-integrity.js.map