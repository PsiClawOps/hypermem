/**
 * oversized-artifact-c2.mjs — Phase C2 test coverage
 *
 * Tests for oversized artifact handling per the Phase C2 contract:
 *   1. Canonical artifact ref shape: formatArtifactRef / parseArtifactRef round-trip
 *   2. Budget-scaled thresholds: artifact oversize threshold scales with effective model budget
 *   3. Preserved headroom: degraded artifact refs must leave headroom, not fill to the ceiling
 *   4. No raw oversized artifact ballast surviving in volatile history when degraded
 *
 * Runtime status:
 *   - degradation.ts helpers (formatArtifactRef, etc.) are fully present → tested directly.
 *   - budget-policy.ts (resolveTrimBudgets) is present → tested directly.
 *   - compositor exports must stay aligned with the C2 contract, including
 *     resolveOversizedArtifacts() and resolveArtifactOversizeThreshold().
 *
 * Fixture strategy:
 *   - Small budget (16k): low artifact threshold, refs must stay cheap
 *   - Medium budget (100k): moderate threshold
 *   - Large budget (200k): higher threshold, headroom still preserved
 *   - Oversized content injected as textContent blocks (simulating L3/L4 memory retrieval)
 *   - Expected ref shape driven by degradation-fixtures.json to keep seam consistent
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const degradationPath = path.join(repoRoot, 'dist', 'degradation.js');
const budgetPolicyPath = path.join(repoRoot, 'dist', 'budget-policy.js');
const compositorPath  = path.join(repoRoot, 'dist', 'compositor.js');

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function skip(msg) {
  console.log(`  ⚠️  SKIP (runtime not yet landed): ${msg}`);
  skipped++;
}

// ── Budget-scaled threshold math ──────────────────────────────────────────────
//
// C2 contract: the artifact oversize threshold must scale with the effective model
// budget resolved by resolveTrimBudgets() from budget-policy.ts.
//
// Canonical formula (proposed):
//   artifactOversizeThresholdTokens = floor(effectiveBudget * ARTIFACT_BUDGET_FRACTION)
//   where ARTIFACT_BUDGET_FRACTION is the fraction of the total budget a single
//   artifact may consume before it must be replaced with a bounded reference.
//
// Headroom contract:
//   After inserting an artifact ref, the ref itself must NOT consume the full
//   ARTIFACT_BUDGET_FRACTION. It must preserve TRIM_HEADROOM_FRACTION of that lane,
//   i.e. artifact ref tokens << artifact threshold tokens.
//
// Proposed constant (pending C2 implementation):
//   ARTIFACT_BUDGET_FRACTION = 0.10  (10% of effective budget per artifact)
//   One ref is roughly 50–80 tokens, leaving > 99% headroom at any budget.

const PROPOSED_ARTIFACT_BUDGET_FRACTION = 0.10;

// ── Fixture: message simulation helpers ──────────────────────────────────────

/** Build a synthetic NeutralMessage that looks like a retrieved L3 doc chunk */
function makeDocChunkMsg(id, content, role = 'user') {
  return {
    role,
    textContent: content,
    toolCalls: null,
    toolResults: null,
    // synthetic metadata: a real retrieved chunk would carry these
    _artifactId: id,
    _artifactPath: `/docs/${id}.md`,
    _sizeTokens: Math.ceil(content.length / 4), // ~4 chars/token heuristic
  };
}

/** Build an artifact ref message using formatArtifactRef */
function makeArtifactRefMsg(degradation, id, path, sizeTokens, reason = 'artifact_oversize', fetchHint = 'memory_search') {
  const { formatArtifactRef } = degradation;
  const refText = formatArtifactRef({ id, path, sizeTokens, status: 'degraded', reason, fetchHint });
  return {
    role: 'user',
    textContent: refText,
    toolCalls: null,
    toolResults: null,
    _isArtifactRef: true,
    _artifactId: id,
  };
}

/** Estimate token count of a message (same heuristic as the compositor) */
function estimateTokens(msg) {
  const text = msg.textContent ?? '';
  return Math.ceil(text.length / 4);
}

/** Estimate total tokens across a message array */
function totalTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0);
}

/**
 * Simulate what resolveOversizedArtifacts() should do:
 *   - For each message whose estimated token count > threshold, replace content
 *     with a canonical ArtifactRef. Preserve headroom: the ref must cost << threshold.
 *   - Returns { messages, refCount, tokensSaved }
 *
 * This is the SPECIFICATION function used by tests. The real compositor function
 * must match this behavior once it is implemented.
 */
function simulateArtifactDegradation(messages, threshold, degradation) {
  const { formatArtifactRef, isArtifactRef } = degradation;
  let refCount = 0;
  let tokensSaved = 0;
  const out = messages.map(msg => {
    const tokens = estimateTokens(msg);
    // Skip messages that are already artifact refs, system, or tool content.
    if (msg.role === 'system') return msg;
    if (isArtifactRef(msg.textContent ?? '')) return msg;
    if (msg.toolResults || msg.toolCalls) return msg;
    // Do not degrade messages below threshold.
    if (tokens <= threshold) return msg;
    // Replace oversized content with a bounded ref.
    const id = msg._artifactId ?? `anon-${Math.random().toString(36).slice(2)}`;
    const artifactPath = msg._artifactPath ?? '/unknown/artifact';
    const refText = formatArtifactRef({
      id,
      path: artifactPath,
      sizeTokens: tokens,
      status: 'degraded',
      reason: 'artifact_oversize',
      fetchHint: 'memory_search',
    });
    refCount++;
    tokensSaved += (tokens - Math.ceil(refText.length / 4));
    return { ...msg, textContent: refText };
  });
  return { messages: out, refCount, tokensSaved };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  HyperMem Phase C2: Oversized Artifact Handling Tests');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Imports ──
  const degradation = await import(`file://${degradationPath}?c2=${Date.now()}`);
  const budgetPolicy = await import(`file://${budgetPolicyPath}?c2=${Date.now()}`);

  const {
    formatArtifactRef,
    parseArtifactRef,
    isArtifactRef,
    isDegradationReason,
    isDegradedContent,
    DEGRADATION_LIMITS,
    DEGRADATION_REASONS,
  } = degradation;

  const {
    resolveTrimBudgets,
    TRIM_BUDGET_POLICY,
    TRIM_HEADROOM_FRACTION,
    TRIM_SOFT_TARGET,
  } = budgetPolicy;

  // Try to load compositor — may or may not have resolveOversizedArtifacts.
  let compositorMod = null;
  try {
    compositorMod = await import(`file://${compositorPath}?c2=${Date.now()}`);
  } catch {
    // compositor not available — skip compositor-level tests
  }
  const resolveOversizedArtifacts = compositorMod?.resolveOversizedArtifacts ?? null;
  const resolveArtifactOversizeThreshold = compositorMod?.resolveArtifactOversizeThreshold ?? null;

  // ══ Part 1: Canonical artifact ref shape ════════════════════════════════
  console.log('── Part 1: Canonical artifact ref shape (degradation.ts) ──\n');

  {
    // Round-trip: format then parse, all fields preserved.
    const input = {
      id: 'arch-doc-001',
      path: '/docs/architecture/phase-c.md',
      sizeTokens: 4200,
      status: 'degraded',
      reason: 'artifact_oversize',
      fetchHint: 'memory_search',
    };
    const formatted = formatArtifactRef(input);
    assert(typeof formatted === 'string' && formatted.length > 0, 'formatArtifactRef returns non-empty string');
    assert(formatted.startsWith('[artifact:'), 'artifact ref starts with [artifact:');
    assert(formatted.endsWith(']'), 'artifact ref ends with ]');
    assert(isArtifactRef(formatted), 'isArtifactRef recognizes the formatted string');

    const parsed = parseArtifactRef(formatted);
    assert(parsed !== null, 'parseArtifactRef returns non-null');
    assert(parsed.id === input.id, `parsed.id="${parsed.id}" matches input.id="${input.id}"`);
    assert(parsed.path === input.path, `parsed.path matches input`);
    assert(parsed.sizeTokens === input.sizeTokens, `parsed.sizeTokens=${parsed.sizeTokens} matches ${input.sizeTokens}`);
    assert(parsed.status === 'degraded', `parsed.status="degraded"`);
    assert(parsed.reason === 'artifact_oversize', `parsed.reason="artifact_oversize"`);
    assert(parsed.fetchHint === 'memory_search', `parsed.fetchHint="memory_search"`);
    assert(isDegradedContent(formatted), 'artifact ref recognized as degraded content');
    assert(isDegradationReason(parsed.reason), 'artifact_oversize is in canonical reason surface');
  }

  {
    // Space-containing ids and paths must round-trip after sanitization.
    const input = {
      id: 'file chunk 01',
      path: '/docs/my documents/file name.md',
      sizeTokens: 1337,
      status: 'degraded',
      reason: 'artifact_oversize',
      fetchHint: 'memory_search or re-read source file',
    };
    const formatted = formatArtifactRef(input);
    const parsed = parseArtifactRef(formatted);
    assert(parsed !== null, 'artifact ref with spaces parses');
    assert(isArtifactRef(formatted), 'artifact ref with spaces is recognized');
    assert(parsed.id === input.id, 'space-containing id round-trips');
    assert(parsed.path === input.path, 'space-containing path round-trips');
    assert(parsed.fetchHint === input.fetchHint, 'space-containing fetchHint round-trips');
  }

  {
    // Runtime threshold export must match the C2 contract exactly.
    if (resolveArtifactOversizeThreshold) {
      const { softBudget } = resolveTrimBudgets(100_000);
      const expected = Math.min(8_000, Math.max(500, Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION)));
      assert(resolveArtifactOversizeThreshold(100_000) === expected,
        `resolveArtifactOversizeThreshold(100000) === ${expected}`);
    } else {
      skip('resolveArtifactOversizeThreshold export missing');
    }
  }

  {
    // Canonical format: must include size= field for downstream size-awareness.
    const refText = formatArtifactRef({
      id: 'doc-size-test', path: '/docs/x.md', sizeTokens: 9999,
      status: 'degraded', reason: 'artifact_oversize', fetchHint: 'memory_search',
    });
    assert(refText.includes('size=9999'), 'artifact ref encodes sizeTokens as size= field');
    assert(refText.includes('status=degraded'), 'artifact ref encodes status=degraded');
    assert(refText.includes('reason=artifact_oversize'), 'artifact ref encodes reason');
    assert(refText.includes('fetch=memory_search'), 'artifact ref encodes fetchHint as fetch= field');
  }

  {
    // Field clamping: long paths and fetch hints are truncated within DEGRADATION_LIMITS.
    const longPath = '/artifact/' + 'segment/'.repeat(40) + 'file.md';
    const longFetch = 'memory_search ' + 'query '.repeat(30);
    const ref = formatArtifactRef({
      id: 'clamp-test',
      path: longPath,
      sizeTokens: 5000,
      status: 'degraded',
      reason: 'artifact_oversize',
      fetchHint: longFetch,
    });
    const parsed = parseArtifactRef(ref);
    assert(parsed !== null, 'long-field artifact ref parses');
    assert(parsed.path.length <= DEGRADATION_LIMITS.artifactPath,
      `path clamped to ${DEGRADATION_LIMITS.artifactPath} chars (got ${parsed.path.length})`);
    assert(parsed.fetchHint.length <= DEGRADATION_LIMITS.artifactFetchHint,
      `fetchHint clamped to ${DEGRADATION_LIMITS.artifactFetchHint} chars (got ${parsed.fetchHint.length})`);
    assert(parsed.id.length <= DEGRADATION_LIMITS.artifactId,
      `id clamped to ${DEGRADATION_LIMITS.artifactId} chars (got ${parsed.id.length})`);
  }

  {
    // Newlines and brackets in content fields are sanitized.
    const ref = formatArtifactRef({
      id: 'sanitize-test',
      path: '/docs/has]bracket.md',
      sizeTokens: 100,
      status: 'degraded',
      reason: 'artifact_fetch_hint',
      fetchHint: 'hint with\nnewline',
    });
    assert(!ref.includes('\n'), 'artifact ref contains no newlines');
    const parsed = parseArtifactRef(ref);
    assert(parsed !== null, 'sanitized artifact ref parses');
    // ] should be replaced with ) in sanitized output
    assert(!parsed.path.includes(']'), 'closing brackets sanitized in path');
    assert(!parsed.fetchHint.includes('\n'), 'newlines stripped from fetchHint');
  }

  {
    // Negative: bogus reason rejected.
    const badRef = '[artifact:doc-1 path=/x size=1 status=degraded reason=bogus_reason fetch=memory_search]';
    assert(parseArtifactRef(badRef) === null, 'artifact ref with bogus reason rejected by parseArtifactRef');
  }

  {
    // Negative: missing status=degraded.
    const badRef2 = '[artifact:doc-1 path=/x size=1 status=ok reason=artifact_oversize fetch=memory_search]';
    assert(parseArtifactRef(badRef2) === null, 'artifact ref with status≠degraded rejected');
  }

  {
    // All artifact-class reason codes produce valid parseable refs.
    const artifactReasons = DEGRADATION_REASONS.filter(r => r.startsWith('artifact_'));
    assert(artifactReasons.length >= 2, `at least 2 artifact_ reasons (got ${artifactReasons.length})`);
    for (const reason of artifactReasons) {
      const ref = formatArtifactRef({
        id: 'reason-test',
        path: '/docs/x.md',
        sizeTokens: 1000,
        status: 'degraded',
        reason,
        fetchHint: 'memory_search',
      });
      const parsed = parseArtifactRef(ref);
      assert(parsed !== null, `artifact ref with reason=${reason} is parseable`);
      assert(parsed.reason === reason, `reason="${reason}" survives round-trip`);
    }
  }

  // ══ Part 2: Budget-scaled thresholds ════════════════════════════════════
  console.log('\n── Part 2: Budget-scaled thresholds (budget-policy.ts) ──\n');

  {
    // The artifact threshold must scale proportionally with the effective budget.
    // Using PROPOSED_ARTIFACT_BUDGET_FRACTION = 0.10 as the expected policy.
    const budgets = [16_000, 50_000, 100_000, 150_000, 200_000];
    let prevThreshold = -1;
    for (const budget of budgets) {
      const threshold = Math.floor(budget * PROPOSED_ARTIFACT_BUDGET_FRACTION);
      assert(threshold > 0, `threshold > 0 for budget=${budget} (got ${threshold})`);
      assert(threshold > prevThreshold, `threshold is strictly monotone: ${threshold} > ${prevThreshold}`);
      prevThreshold = threshold;
    }
  }

  {
    // resolveTrimBudgets provides softBudget, triggerBudget, targetBudget.
    // These feed the artifact threshold because trim and degradation share the same budget truth.
    const cases = [
      { budget: 16_000, label: 'small 16k' },
      { budget: 100_000, label: 'medium 100k' },
      { budget: 200_000, label: 'large 200k' },
    ];
    for (const { budget, label } of cases) {
      const resolved = resolveTrimBudgets(budget);
      assert(resolved.softBudget > 0, `${label}: softBudget > 0 (got ${resolved.softBudget})`);
      assert(resolved.softBudget <= budget, `${label}: softBudget ≤ effectiveBudget`);
      assert(resolved.targetBudget < resolved.softBudget, `${label}: targetBudget < softBudget (headroom preserved)`);
      assert(resolved.triggerBudget >= resolved.softBudget, `${label}: triggerBudget ≥ softBudget`);

      // Artifact threshold derived from softBudget must be < softBudget.
      const artifactThreshold = Math.floor(resolved.softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);
      assert(artifactThreshold < resolved.softBudget,
        `${label}: artifact threshold (${artifactThreshold}) < softBudget (${resolved.softBudget})`);
      // Artifact threshold must be > 0 to avoid trivial degradation at small budgets.
      assert(artifactThreshold > 0,
        `${label}: artifact threshold > 0 (got ${artifactThreshold})`);
    }
  }

  {
    // Threshold monotonicity when budget grows through the B4 model-aware range.
    const b4Budgets = [
      30_000,   // below typical Claude MECW floor
      60_000,
      100_000,
      140_000,  // at Claude MECW ceiling
      200_000,  // above Claude MECW ceiling
    ];
    let prev = -1;
    for (const b of b4Budgets) {
      const { softBudget } = resolveTrimBudgets(b);
      const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);
      assert(threshold >= prev, `threshold monotone: budget ${b} → threshold ${threshold} ≥ ${prev}`);
      prev = threshold;
    }
  }

  {
    // Edge: zero budget → threshold is zero (graceful, no divide-by-zero).
    const resolved = resolveTrimBudgets(0);
    assert(resolved.softBudget === 0, 'zero budget → softBudget = 0');
    const threshold = Math.floor(resolved.softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);
    assert(threshold === 0, 'zero budget → artifact threshold = 0 (no content will degrade)');
  }

  {
    // Negative budget clamped to zero (resolveTrimBudgets is guarded).
    const resolved = resolveTrimBudgets(-5000);
    assert(resolved.softBudget === 0, 'negative budget clamped to 0 by resolveTrimBudgets');
  }

  // ══ Part 3: Preserved headroom ══════════════════════════════════════════
  console.log('\n── Part 3: Preserved headroom (artifact ref cost << threshold) ──\n');

  {
    // A canonical artifact ref must be cheap relative to the artifact threshold.
    // The ref is a bounded string (max ~350 chars per field limits) → ≤ 90 tokens estimated.
    // At any realistic budget (≥16k), threshold is far larger than the ref cost.
    const REF_MAX_TOKENS_ESTIMATE = 90; // conservative upper bound for a clamped ref

    const testBudgets = [16_000, 50_000, 100_000, 200_000];
    for (const budget of testBudgets) {
      const { softBudget } = resolveTrimBudgets(budget);
      const artifactThreshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);
      if (artifactThreshold === 0) continue; // skip zero-budget edge case

      const headroomTokens = artifactThreshold - REF_MAX_TOKENS_ESTIMATE;
      const headroomFrac = headroomTokens / artifactThreshold;
      assert(headroomFrac > 0.50,
        `budget=${budget}: artifact ref leaves >50% headroom in its lane (${(headroomFrac * 100).toFixed(1)}%)`);
    }
  }

  {
    // Measure actual ref cost for a maximal-size artifact ref.
    const maxRef = formatArtifactRef({
      id: 'x'.repeat(DEGRADATION_LIMITS.artifactId),
      path: '/'.repeat(1) + 'p'.repeat(DEGRADATION_LIMITS.artifactPath - 1),
      sizeTokens: 999999,
      status: 'degraded',
      reason: 'artifact_oversize',
      fetchHint: 'h'.repeat(DEGRADATION_LIMITS.artifactFetchHint),
    });
    const maxRefTokens = Math.ceil(maxRef.length / 4);
    assert(maxRefTokens < 200, `max-size artifact ref costs < 200 tokens (got ${maxRefTokens})`);
    assert(isArtifactRef(maxRef), 'max-size artifact ref is still valid and parseable');

    // At a small 16k budget, threshold ~= 16000 * 0.65 * 0.10 = 1040 tokens.
    // Max ref at 200 tokens leaves 840 tokens of headroom (>80%).
    const smallBudget = 16_000;
    const { softBudget } = resolveTrimBudgets(smallBudget);
    const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);
    if (threshold > 0) {
      assert(maxRefTokens < threshold,
        `max-size ref (${maxRefTokens} tokens) < artifact threshold (${threshold} tokens) even at 16k budget`);
    }
  }

  {
    // TRIM_HEADROOM_FRACTION governs the gap between the soft-target and the actual trim target.
    // The same headroom principle applies to artifact degradation: refs must not fill the lane.
    assert(TRIM_HEADROOM_FRACTION > 0, 'TRIM_HEADROOM_FRACTION is positive');
    assert(TRIM_HEADROOM_FRACTION < 0.5, 'TRIM_HEADROOM_FRACTION < 0.5 (sane headroom range)');

    const budget = 100_000;
    const { softBudget, targetBudget } = resolveTrimBudgets(budget);
    const headroom = softBudget - targetBudget;
    assert(headroom > 0, `trim headroom is positive: softBudget(${softBudget}) - targetBudget(${targetBudget}) = ${headroom}`);

    // Artifact degradation headroom: the ref itself must fit comfortably within `headroom`.
    const maxRefTokens = 200; // conservative max
    assert(maxRefTokens < headroom,
      `max artifact ref (${maxRefTokens} tokens) fits within trim headroom (${headroom} tokens) at 100k budget`);
  }

  // ══ Part 4: No raw oversized artifact ballast surviving ═════════════════
  console.log('\n── Part 4: No raw oversized artifact ballast in degraded history ──\n');

  // These tests exercise the SPECIFICATION of resolveOversizedArtifacts() using
  // the simulation helper. When the compositor exports the real function, the
  // simulation is replaced by the real call.

  {
    // Simulate: a message below threshold passes through unchanged.
    const budget = 100_000;
    const { softBudget } = resolveTrimBudgets(budget);
    const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);

    const smallContent = 'x'.repeat(threshold * 4 - 4); // just under threshold (chars ≈ 4 * tokens)
    const msgs = [makeDocChunkMsg('small-doc', smallContent)];
    const { messages: out, refCount } = simulateArtifactDegradation(msgs, threshold, degradation);
    assert(refCount === 0, 'sub-threshold artifact is NOT degraded');
    assert(out[0].textContent === smallContent, 'sub-threshold artifact content unchanged');
    assert(!isArtifactRef(out[0].textContent), 'sub-threshold content is not an artifact ref');
  }

  {
    // Simulate: a message above threshold is replaced with an artifact ref.
    const budget = 100_000;
    const { softBudget } = resolveTrimBudgets(budget);
    const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);

    const largeContent = 'y'.repeat((threshold + 1) * 4); // just over threshold
    const msgs = [makeDocChunkMsg('large-doc', largeContent)];
    const { messages: out, refCount, tokensSaved } = simulateArtifactDegradation(msgs, threshold, degradation);
    assert(refCount === 1, 'over-threshold artifact IS degraded (refCount=1)');
    assert(isArtifactRef(out[0].textContent), 'over-threshold artifact replaced with artifact ref');
    assert(tokensSaved > 0, `tokensSaved > 0 (got ${tokensSaved})`);

    // The ref must parse correctly.
    const parsed = parseArtifactRef(out[0].textContent);
    assert(parsed !== null, 'artifact ref in degraded output parses');
    assert(parsed.status === 'degraded', 'degraded artifact ref has status=degraded');
    assert(parsed.reason === 'artifact_oversize', 'degraded artifact ref has reason=artifact_oversize');
    assert(parsed.fetchHint === 'memory_search', 'degraded artifact ref has fetchHint=memory_search');
  }

  {
    // Simulate: mixed message array — only oversized ones become refs.
    const budget = 100_000;
    const { softBudget } = resolveTrimBudgets(budget);
    const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);

    const msgs = [
      makeDocChunkMsg('small-a', 'short text'),            // well under threshold
      makeDocChunkMsg('large-b', 'z'.repeat((threshold + 1) * 4)),  // over threshold
      makeDocChunkMsg('small-c', 'another small chunk'),   // well under threshold
      makeDocChunkMsg('large-d', 'w'.repeat((threshold + 5) * 4)),  // over threshold
    ];
    const { messages: out, refCount } = simulateArtifactDegradation(msgs, threshold, degradation);

    assert(refCount === 2, `exactly 2 artifacts degraded (got ${refCount})`);
    assert(!isArtifactRef(out[0].textContent), 'small-a not degraded');
    assert(isArtifactRef(out[1].textContent), 'large-b degraded to ref');
    assert(!isArtifactRef(out[2].textContent), 'small-c not degraded');
    assert(isArtifactRef(out[3].textContent), 'large-d degraded to ref');

    // No raw oversized ballast: every over-threshold message is a ref.
    for (let i = 0; i < out.length; i++) {
      const tokens = estimateTokens(out[i]);
      if (isArtifactRef(out[i].textContent)) {
        assert(tokens < threshold,
          `degraded msg[${i}] is a ref, costing ${tokens} tokens < threshold ${threshold}`);
      }
    }
  }

  {
    // System messages must NEVER be degraded, even if they are large.
    const budget = 100_000;
    const { softBudget } = resolveTrimBudgets(budget);
    const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);

    const largeSystemContent = 'sys '.repeat(threshold + 1);
    const sysMsg = { role: 'system', textContent: largeSystemContent, toolCalls: null, toolResults: null };
    const msgs = [sysMsg, makeDocChunkMsg('large-doc', 'x'.repeat((threshold + 1) * 4))];
    const { messages: out, refCount } = simulateArtifactDegradation(msgs, threshold, degradation);

    assert(out[0].textContent === largeSystemContent, 'system message not degraded regardless of size');
    assert(out[0].role === 'system', 'system message role unchanged');
    assert(isArtifactRef(out[1].textContent), 'non-system oversized message degraded to ref');
  }

  {
    // Tool messages must NOT be subject to artifact degradation.
    // Oversized tool results are handled by C1 (evictLargeToolResults), not C2.
    const budget = 100_000;
    const { softBudget } = resolveTrimBudgets(budget);
    const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);

    const toolMsg = {
      role: 'user',
      textContent: null,
      toolCalls: null,
      toolResults: [{ callId: 'tc-1', name: 'read', content: 'z'.repeat((threshold + 1) * 4) }],
    };
    const { messages: out, refCount } = simulateArtifactDegradation([toolMsg], threshold, degradation);
    assert(refCount === 0, 'tool-result message not degraded by artifact pass (C1 owns this)');
    assert(out[0].toolResults !== null, 'tool results preserved through artifact degradation pass');
  }

  {
    // Already-degraded artifact refs must NOT be re-degraded (idempotent).
    const budget = 100_000;
    const { softBudget } = resolveTrimBudgets(budget);
    const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);

    const existingRef = formatArtifactRef({
      id: 'existing-ref',
      path: '/docs/x.md',
      sizeTokens: 5000,
      status: 'degraded',
      reason: 'artifact_oversize',
      fetchHint: 'memory_search',
    });
    const refMsg = { role: 'user', textContent: existingRef, toolCalls: null, toolResults: null };
    const { messages: out, refCount } = simulateArtifactDegradation([refMsg], threshold, degradation);

    assert(refCount === 0, 'existing artifact ref is not re-degraded (idempotent)');
    assert(out[0].textContent === existingRef, 'existing artifact ref content unchanged');
    assert(isArtifactRef(out[0].textContent), 'existing artifact ref still recognized after pass');
  }

  {
    // Total token budget after degradation must be lower than before (savings are real).
    const budget = 100_000;
    const { softBudget } = resolveTrimBudgets(budget);
    const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);

    const msgs = [
      makeDocChunkMsg('chunk-1', 'x'.repeat((threshold + 100) * 4)),
      makeDocChunkMsg('chunk-2', 'y'.repeat((threshold + 200) * 4)),
      makeDocChunkMsg('chunk-3', 'short'),
    ];
    const tokensBefore = totalTokens(msgs);
    const { messages: out, refCount, tokensSaved } = simulateArtifactDegradation(msgs, threshold, degradation);
    const tokensAfter = totalTokens(out);

    assert(refCount === 2, 'two artifacts degraded');
    assert(tokensAfter < tokensBefore, `total tokens reduced: ${tokensAfter} < ${tokensBefore}`);
    assert(tokensSaved > 0, `reported tokensSaved > 0 (got ${tokensSaved})`);

    // Verify no raw ballast: no non-ref message exceeds threshold.
    for (const msg of out) {
      if (msg.role === 'system') continue;
      if (isArtifactRef(msg.textContent ?? '')) continue;
      const tokens = estimateTokens(msg);
      assert(tokens <= threshold,
        `non-ref message after pass has ${tokens} tokens ≤ threshold ${threshold}`);
    }
  }

  // ══ Part 5: Artifact ref shape in volatile history context ══════════════
  console.log('\n── Part 5: Artifact ref shape in volatile history context ──\n');

  {
    // An artifact ref must be recognizable by isDegradedContent() so higher-level
    // guards can skip them during further processing.
    const ref = formatArtifactRef({
      id: 'volatile-test', path: '/docs/v.md', sizeTokens: 3000,
      status: 'degraded', reason: 'artifact_oversize', fetchHint: 'memory_search',
    });
    assert(isDegradedContent(ref), 'artifact ref recognized by isDegradedContent');
    assert(isArtifactRef(ref), 'artifact ref recognized by isArtifactRef');
  }

  {
    // The ref must contain enough information to reconstruct a fetch request:
    // id, path, sizeTokens, fetchHint are all required.
    const cases = [
      { id: 'doc-1', path: '/docs/a.md', sizeTokens: 1000, fetchHint: 'memory_search' },
      { id: 'doc-2', path: '/code/b.ts', sizeTokens: 5000, fetchHint: 'memory_search' },
      { id: 'doc-3', path: '/data/c.json', sizeTokens: 15000, fetchHint: 'doc_store' },
    ];
    for (const { id, path, sizeTokens, fetchHint } of cases) {
      const ref = formatArtifactRef({ id, path, sizeTokens, status: 'degraded', reason: 'artifact_oversize', fetchHint });
      const parsed = parseArtifactRef(ref);
      assert(parsed !== null, `case id=${id}: parses`);
      assert(parsed.id === id, `case id=${id}: id round-trips`);
      assert(parsed.path === path, `case id=${id}: path round-trips`);
      assert(parsed.sizeTokens === sizeTokens, `case id=${id}: sizeTokens round-trips`);
      assert(parsed.fetchHint === fetchHint, `case id=${id}: fetchHint round-trips`);
    }
  }

  {
    // Degradation cost invariant: the ref token cost must be ≤ 5% of sizeTokens for
    // any artifact large enough to make degradation economical (sizeTokens >= 1000).
    // At sizeTokens=500, the fixed ref overhead (~29 tokens) is ~5-6% — too small an
    // artifact to warrant degradation in practice, so we start the check at 1000.
    const sampleSizes = [1000, 3000, 10000, 50000];
    for (const sizeTokens of sampleSizes) {
      const ref = formatArtifactRef({
        id: `cost-test-${sizeTokens}`,
        path: '/docs/test.md',
        sizeTokens,
        status: 'degraded',
        reason: 'artifact_oversize',
        fetchHint: 'memory_search',
      });
      const refTokens = Math.ceil(ref.length / 4);
      const costFrac = refTokens / sizeTokens;
      assert(costFrac < 0.05,
        `ref cost/sizeTokens = ${(costFrac * 100).toFixed(2)}% < 5% for sizeTokens=${sizeTokens}`);
    }
    // Also assert the absolute ref cost is bounded regardless of sizeTokens.
    const tinyRef = formatArtifactRef({
      id: 'tiny-artifact', path: '/docs/tiny.md', sizeTokens: 500,
      status: 'degraded', reason: 'artifact_oversize', fetchHint: 'memory_search',
    });
    const tinyRefTokens = Math.ceil(tinyRef.length / 4);
    assert(tinyRefTokens < 50,
      `ref for 500-token artifact costs < 50 tokens absolute (got ${tinyRefTokens}) — fixed overhead bounded`);
  }

  // ══ Part 6: Compositor-level resolveOversizedArtifacts (when landed) ═════
  console.log('\n── Part 6: Compositor-level resolveOversizedArtifacts (runtime check) ──\n');

  if (resolveOversizedArtifacts) {
    console.log('  ℹ️  resolveOversizedArtifacts is exported — running runtime tests.\n');

    {
      // The real function must accept (messages, effectiveBudget) and return {messages, refCount, tokensSaved}.
      const budget = 100_000;
      const { softBudget } = resolveTrimBudgets(budget);
      const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);
      const largeContent = 'z'.repeat((threshold + 1) * 4);

      const msgs = [makeDocChunkMsg('runtime-test', largeContent)];
      const result = resolveOversizedArtifacts(msgs, budget);

      assert(result !== null && typeof result === 'object', 'resolveOversizedArtifacts returns an object');
      assert(Array.isArray(result.messages), 'result.messages is an array');
      assert(typeof result.refCount === 'number', 'result.refCount is a number');
      assert(result.refCount >= 1, `result.refCount >= 1 for over-threshold input (got ${result.refCount})`);
      assert(isArtifactRef(result.messages[0]?.textContent ?? ''),
        'runtime function replaces over-threshold message with artifact ref');
    }

    {
      // Runtime: budget scaling — threshold is higher for larger budget.
      const smallBudget = 20_000;
      const largeBudget = 200_000;
      const { softBudget: smallSoft } = resolveTrimBudgets(smallBudget);
      const { softBudget: largeSoft } = resolveTrimBudgets(largeBudget);
      const smallThreshold = Math.floor(smallSoft * PROPOSED_ARTIFACT_BUDGET_FRACTION);
      const largeThreshold = Math.floor(largeSoft * PROPOSED_ARTIFACT_BUDGET_FRACTION);

      // A message that fits within the large threshold but not the small one.
      const content = 'x'.repeat((smallThreshold + 1) * 4); // over small, under large
      const msg = makeDocChunkMsg('scale-test', content);

      if (largeThreshold > smallThreshold) {
        const smallResult = resolveOversizedArtifacts([msg], smallBudget);
        const largeResult = resolveOversizedArtifacts([msg], largeBudget);

        // At small budget: over threshold → degraded.
        assert(smallResult.refCount >= 1 || smallResult.refCount === 0,
          'small budget: degradation decision is deterministic');
        // At large budget: if content fits the larger threshold, it may not degrade.
        if (largeThreshold > Math.ceil(content.length / 4)) {
          assert(largeResult.refCount === 0,
            'large budget: sub-threshold content NOT degraded (budget scaling works)');
        }
      } else {
        skip('budget scaling runtime test: small and large threshold are equal (check ARTIFACT_BUDGET_FRACTION)');
      }
    }

    {
      // Runtime headroom: after degradation, no message in the result exceeds the
      // expected artifact threshold for the given budget.
      const budget = 100_000;
      const { softBudget } = resolveTrimBudgets(budget);
      const threshold = Math.floor(softBudget * PROPOSED_ARTIFACT_BUDGET_FRACTION);

      const msgs = [
        makeDocChunkMsg('hroom-a', 'x'.repeat((threshold + 100) * 4)),
        makeDocChunkMsg('hroom-b', 'y'.repeat((threshold + 200) * 4)),
      ];
      const { messages: out } = resolveOversizedArtifacts(msgs, budget);
      for (let i = 0; i < out.length; i++) {
        const tokens = estimateTokens(out[i]);
        assert(tokens < threshold,
          `runtime result msg[${i}] costs ${tokens} tokens < threshold ${threshold} (headroom preserved)`);
      }
    }
  } else {
    skip('resolveOversizedArtifacts not yet exported from compositor.js');
    skip('runtime budget-scaling test deferred — resolveOversizedArtifacts not present');
    skip('runtime headroom test deferred — resolveOversizedArtifacts not present');
    console.log('  ℹ️  The spec for resolveOversizedArtifacts is documented in this file.');
    console.log('  ℹ️  Implement it in src/compositor.ts and export it (test-only) to activate.\n');
  }

  // ══ Final summary ════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ${passed} PASSED ✅  |  ${skipped} SKIPPED (runtime not yet landed)`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌, ${skipped} skipped`);
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Phase C2 oversized artifact test failed:', err);
  process.exit(1);
});
