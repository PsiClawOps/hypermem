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

describe('message-slot SQL scoping', () => {
  const compositorSrc = readFileSync(new URL('../src/compositor.ts', import.meta.url), 'utf8');
  const messageStoreSrc = readFileSync(new URL('../src/message-store.ts', import.meta.url), 'utf8');
  const openDomainSrc = readFileSync(new URL('../src/open-domain.ts', import.meta.url), 'utf8');

  it('transcript-only slots require user/assistant text rows, not carrier rows', () => {
    for (const [name, src] of [
      ['compositor', compositorSrc],
      ['message-store', messageStoreSrc],
      ['open-domain', openDomainSrc],
    ]) {
      assert.ok(src.includes("role IN ('user', 'assistant')") || src.includes("m.role IN ('user', 'assistant')"),
        `${name} scopes transcript queries to user/assistant roles`);
      assert.ok(src.includes('trim(text_content) !=') || src.includes('trim(m.text_content) !='),
        `${name} excludes whitespace-only transcript rows`);
    }
  });

  it('cross-session context respects each source conversation compaction fence', () => {
    assert.ok(
      compositorSrc.includes('LEFT JOIN compaction_fences cf ON cf.conversation_id = m.conversation_id'),
      'cross-session context joins per-conversation compaction fences'
    );
    assert.ok(
      compositorSrc.includes('cf.fence_message_id IS NULL OR m.id >= cf.fence_message_id'),
      'cross-session context excludes below-fence zombie messages'
    );
  });

  it('continuity dedup prefers full tool-bearing history rows over transcript projections', () => {
    assert.ok(
      compositorSrc.includes('Transcript projections intentionally null'),
      'continuity merge documents projection/full-row boundary'
    );
    assert.ok(
      compositorSrc.includes('m.toolCalls != null ? 2 : 0') && compositorSrc.includes('m.toolResults != null ? 2 : 0'),
      'continuity merge scores tool-bearing rows higher than stripped projections'
    );
  });
});

// ── History Query Surface mode allowlist (0.9.4) ─────────────────────────
// Verifies that queryHistory is a closed-mode dispatcher:
// no raw SQL execution, no action-passthrough via unknown mode strings.

import { DatabaseSync } from 'node:sqlite';
import { MessageStore } from '../dist/message-store.js';
import { migrate } from '../dist/schema.js';

describe('queryHistory SQL safety', () => {
  it('mode is validated against a closed allowlist before any SQL executes', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    const store = new MessageStore(db);

    const dangerousModes = [
      'sql_injection_attempt',
      'DROP TABLE messages',
      'SELECT * FROM messages',
      '../etc/passwd',
      '',
      '\0',
    ];

    for (const mode of dangerousModes) {
      assert.throws(
        () => store.queryHistory({ agentId: 'x', mode }),
        /unknown mode/,
        `mode '${mode}' must be rejected by the allowlist`
      );
    }
  });

  it('queryHistory source does not interpolate mode into SQL queries', () => {
    const src = readFileSync(
      new URL('../src/message-store.ts', import.meta.url),
      'utf8'
    );

    // The mode value must never be interpolated into a SQL template literal.
    // Check that no SQL SELECT/INSERT/UPDATE/DELETE string embeds ${mode}.
    // We do this by scanning for template literals that contain both SQL keywords
    // and ${mode} in proximity, rather than a blanket check that would catch
    // safe usage in error messages.
    const sqlModePattern = /`[^`]*(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^`]*\$\{mode\}/;
    assert.ok(
      !sqlModePattern.test(src),
      'mode must not be interpolated into SQL template literals'
    );

    // Verify the closed mode dispatch exists
    assert.ok(
      src.includes('ALLOWED_MODES'),
      'queryHistory must use an ALLOWED_MODES allowlist'
    );
    assert.ok(
      src.includes("'runtime_chain'"),
      'allowlist must include runtime_chain'
    );
    assert.ok(
      src.includes("'cross_session'"),
      'allowlist must include cross_session'
    );
  });

  it('queryHistory caps are defined for every mode in the allowlist', () => {
    const caps = MessageStore.HISTORY_QUERY_CAPS;
    const allowedModes = ['runtime_chain', 'transcript_tail', 'tool_events', 'by_topic', 'by_context', 'cross_session'];
    for (const mode of allowedModes) {
      assert.ok(caps[mode], `HISTORY_QUERY_CAPS must have entry for '${mode}'`);
      assert.ok(typeof caps[mode].hardCap === 'number' && caps[mode].hardCap > 0,
        `hardCap for '${mode}' must be a positive number`);
      assert.ok(typeof caps[mode].defaultLimit === 'number' && caps[mode].defaultLimit > 0,
        `defaultLimit for '${mode}' must be a positive number`);
      assert.ok(caps[mode].hardCap >= caps[mode].defaultLimit,
        `hardCap must be >= defaultLimit for '${mode}'`);
    }
  });

  it('cross_session query enforces compaction fence via parameterized JOIN (source verification)', () => {
    const src = readFileSync(
      new URL('../src/message-store.ts', import.meta.url),
      'utf8'
    );

    assert.ok(
      src.includes('LEFT JOIN compaction_fences cf ON cf.conversation_id = m.conversation_id'),
      'cross_session must JOIN compaction_fences'
    );
    assert.ok(
      src.includes('cf.fence_message_id IS NULL OR m.id >= cf.fence_message_id'),
      'cross_session must apply per-conversation fence'
    );
  });
});

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
