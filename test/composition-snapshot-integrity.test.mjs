import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalizeSnapshotJson,
  parseSnapshotSlotsJson,
  attachInlineIntegrityHash,
  computeInlineIntegrityHash,
  computeSlotsIntegrityHash,
  verifySnapshotSlotsIntegrity,
} from '../dist/composition-snapshot-integrity.js';

describe('composition snapshot integrity helpers', () => {
  it('canonicalizeSnapshotJson sorts object keys deterministically', () => {
    const left = {
      z: 1,
      a: {
        y: true,
        x: ['b', { d: 4, c: 3 }],
      },
    };
    const right = {
      a: {
        x: ['b', { c: 3, d: 4 }],
        y: true,
      },
      z: 1,
    };

    assert.equal(canonicalizeSnapshotJson(left), canonicalizeSnapshotJson(right));
  });

  it('computes the same inline hash regardless of key order', () => {
    const left = {
      source: 'inline',
      slot: 'active_facts',
      content: {
        text: 'Keep the repair notice above restored content.',
        tokens: 44,
      },
    };
    const right = {
      content: {
        tokens: 44,
        text: 'Keep the repair notice above restored content.',
      },
      slot: 'active_facts',
      source: 'inline',
    };

    assert.equal(computeInlineIntegrityHash(left), computeInlineIntegrityHash(right));
  });

  it('verifies untouched inline hashes and top-level slots hash', () => {
    const slots = {
      stable_prefix: {
        source: 'hydrated',
        refs: ['identity', 'soul'],
      },
      repair_notice: attachInlineIntegrityHash({
        kind: 'inline',
        content: {
          text: 'This session was repaired from snapshot snap-123.',
          source_snapshot_id: 'snap-123',
        },
      }),
      active_facts: attachInlineIntegrityHash({
        source: 'inline',
        content: {
          items: ['budget clamp fixed', 'tail placement shipped'],
        },
      }),
    };

    const topHash = computeSlotsIntegrityHash(slots);
    const verified = verifySnapshotSlotsIntegrity(slots, topHash);

    assert.equal(verified.ok, true);
    assert.equal(verified.failures.length, 0);
    assert.equal(verified.actualSlotsHash, topHash);
  });

  it('rejects tampered inline content', () => {
    const original = attachInlineIntegrityHash({
      source: 'inline',
      content: {
        text: 'original payload',
        tokens: 12,
      },
    });

    const slots = {
      active_facts: {
        ...original,
        content: {
          text: 'tampered payload',
          tokens: 12,
        },
      },
    };

    const verified = verifySnapshotSlotsIntegrity(slots);
    assert.equal(verified.ok, false);
    assert.equal(verified.failures[0]?.reason, 'inline_hash_mismatch');
    assert.equal(verified.failures[0]?.slotKey, 'active_facts');
  });

  it('rejects inline slots missing integrity_hash', () => {
    const slots = {
      active_facts: {
        source: 'inline',
        content: {
          text: 'payload without integrity hash',
        },
      },
    };

    const verified = verifySnapshotSlotsIntegrity(slots);
    assert.equal(verified.ok, false);
    assert.equal(verified.failures[0]?.reason, 'missing_inline_integrity_hash');
  });

  it('rejects mismatched top-level slots hash', () => {
    const slots = {
      repair_notice: attachInlineIntegrityHash({
        kind: 'inline',
        content: { text: 'repaired continuation' },
      }),
    };

    const verified = verifySnapshotSlotsIntegrity(slots, 'deadbeef');
    assert.equal(verified.ok, false);
    assert.equal(verified.failures[0]?.reason, 'slots_hash_mismatch');
  });

  it('rejects truncated slots_json', () => {
    const raw = '{"repair_notice":{"kind":"inline","content":{"text":"oops"}';
    const verified = verifySnapshotSlotsIntegrity(raw);
    assert.equal(verified.ok, false);
    assert.equal(verified.failures[0]?.reason, 'malformed_slots_json');
  });

  it('parses valid slots_json into canonical order', () => {
    const parsed = parseSnapshotSlotsJson('{"b":1,"a":{"d":4,"c":3}}');
    assert.deepEqual(parsed, {
      a: { c: 3, d: 4 },
      b: 1,
    });
  });
});
