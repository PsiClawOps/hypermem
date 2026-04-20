/**
 * SQL Safety Tests
 *
 * Validates:
 * 1. temporal-store.ts timeRangeQuery uses parameterized minConfidence (not interpolated)
 * 2. open-domain.ts buildOpenDomainFtsQuery quotes terms to prevent FTS5 operator injection
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── Source-level verification for temporal-store ───────────────────────────
// We verify the source directly because TemporalStore uses TS parameter
// properties that require compilation. The runtime behavior is validated
// by the existing temporal/integration tests; here we verify the fix itself.

describe('temporal-store parameterization (source verification)', () => {
  const src = readFileSync(
    new URL('../src/temporal-store.ts', import.meta.url),
    'utf8'
  );

  it('does not interpolate minConf into SQL', () => {
    // The old vulnerable pattern: `t.confidence >= ${minConf}`
    assert.ok(
      !src.includes('`t.confidence >= ${minConf}`'),
      'template literal interpolation of minConf must not exist'
    );
    assert.ok(
      !src.includes('`t.confidence >= ${'),
      'no template interpolation in confidence condition'
    );
  });

  it('uses parameterized placeholder for confidence', () => {
    assert.ok(
      src.includes("'t.confidence >= ?'"),
      'confidence condition uses ? placeholder'
    );
  });

  it('seeds minConf into params array', () => {
    // params should be initialized with [minConf]
    assert.ok(
      src.includes('[minConf]'),
      'params array is seeded with minConf'
    );
  });
});

// ── Runtime verification for open-domain FTS quoting ──────────────────────
// buildOpenDomainFtsQuery is a pure function, test it directly.

import { buildOpenDomainFtsQuery } from '../src/open-domain.ts';

describe('open-domain FTS quoting', () => {
  it('quotes terms to neutralize FTS5 operators', () => {
    const query = 'fleet NEAR wide NOT something';
    const fts = buildOpenDomainFtsQuery(query);

    assert.ok(fts, 'produces a query');
    const terms = fts.split(' OR ');
    for (const term of terms) {
      const trimmed = term.trim();
      assert.ok(trimmed.startsWith('"'), `term starts with quote: ${trimmed}`);
      assert.ok(trimmed.endsWith('"*'), `term ends with quoted glob: ${trimmed}`);
    }
  });

  it('handles hyphenated terms without FTS5 column errors', () => {
    const query = 'fleet-wide deployment cross-region';
    const fts = buildOpenDomainFtsQuery(query);

    assert.ok(fts, 'produces a query');
    const terms = fts.split(' OR ');
    for (const term of terms) {
      const trimmed = term.trim();
      assert.ok(trimmed.startsWith('"'), `term starts with quote: ${trimmed}`);
      assert.ok(trimmed.endsWith('"*'), `term ends with quoted glob: ${trimmed}`);
    }
  });

  it('strips special characters that could break FTS5', () => {
    const query = 'test"; DROP TABLE facts; --';
    const fts = buildOpenDomainFtsQuery(query);

    if (fts) {
      assert.ok(!fts.includes(';'), 'no semicolons in output');
      assert.ok(!fts.includes('DROP'), 'no SQL keywords passed through');
    }
  });

  it('produces same quoted-glob pattern as hybrid-retrieval', () => {
    const query = 'temporal store validation';
    const fts = buildOpenDomainFtsQuery(query);

    assert.ok(fts, 'produces a query');
    // Pattern: "term"* OR "term"* OR ...
    const pattern = /^"[\w]+"(\*)?( OR "[\w]+"(\*)?)*$/;
    assert.match(fts, pattern, `output matches quoted-glob pattern: ${fts}`);
  });

  it('returns null for queries with only stop words', () => {
    const fts = buildOpenDomainFtsQuery('what is the');
    assert.equal(fts, null, 'stop-word-only query returns null');
  });
});
