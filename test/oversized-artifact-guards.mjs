/**
 * oversized-artifact-guards.mjs — Phase C2 test coverage
 *
 * Tests for oversized artifact handling:
 *   - resolveArtifactOversizeThreshold: scales with effective model budget from B4
 *   - degradeOversizedDocChunk: degrades large retrieved payloads to ArtifactRef
 *   - Headroom preservation: degraded references are tiny, not ceiling-filling
 *   - Canonical artifact reference format (uses C0.2 helpers from degradation.ts)
 *   - Stable-prefix invariant: degradation output stays in volatile region
 *
 * Uses exported test-only helpers from compositor.js and degradation.js.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

const compositorPath = path.join(repoRoot, 'dist', 'compositor.js');
const degradationPath = path.join(repoRoot, 'dist', 'degradation.js');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  HyperMem Phase C2: Oversized Artifact Handling');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const {
    resolveArtifactOversizeThreshold,
    degradeOversizedDocChunk,
  } = await import(`file://${compositorPath}?c2=${Date.now()}`);

  const {
    isArtifactRef,
    parseArtifactRef,
    isDegradationReason,
    isDegradedContent,
    DEGRADATION_LIMITS,
  } = await import(`file://${degradationPath}?c2=${Date.now()}`);

  // ══ Part 1: resolveArtifactOversizeThreshold — budget scaling ════════════

  console.log('── resolveArtifactOversizeThreshold: scales with effective budget ──');

  {
    // Threshold increases with budget, proportionally.
    const small = resolveArtifactOversizeThreshold(16_000);
    const medium = resolveArtifactOversizeThreshold(90_000);
    const large = resolveArtifactOversizeThreshold(200_000);

    assert(small <= medium, `threshold scales up: small(${small}) ≤ medium(${medium})`);
    assert(medium <= large, `threshold scales up: medium(${medium}) ≤ large(${large})`);
  }

  {
    // Floor: threshold is never below 500 tokens even for tiny budgets.
    const floor = resolveArtifactOversizeThreshold(1_000);
    assert(floor >= 500, `floor enforced: threshold(${floor}) >= 500 tokens for 1k budget`);
  }

  {
    // Ceiling: threshold is never above 8000 tokens even for huge budgets.
    const ceiling = resolveArtifactOversizeThreshold(10_000_000);
    assert(ceiling <= 8_000, `ceiling enforced: threshold(${ceiling}) <= 8000 tokens for enormous budget`);
  }

  {
    // C2.1 contract: threshold is 10% of soft budget, clamped to [500, 8000].
    const budget = 90_000;
    const softBudget = Math.floor(budget * 0.65);
    const expected = Math.min(8_000, Math.max(500, Math.floor(softBudget * 0.10)));
    const threshold = resolveArtifactOversizeThreshold(budget);
    assert(threshold === expected, `contract preserved: threshold(${threshold}) === softBudget*0.10 clamped (${expected})`);
  }

  {
    // Typical effective budgets produce reasonable thresholds (not absurdly small or large).
    const claude = resolveArtifactOversizeThreshold(140_000); // Claude MECW ceiling
    const gpt4 = resolveArtifactOversizeThreshold(96_000);   // GPT-4o effective (75% of 128k)
    assert(claude >= 500, `Claude threshold(${claude}) is usable (>= 500)`);
    assert(claude <= 8_000, `Claude threshold(${claude}) is bounded (<= 8000)`);
    assert(gpt4 >= 500, `GPT-4o threshold(${gpt4}) is usable (>= 500)`);
    assert(gpt4 <= 8_000, `GPT-4o threshold(${gpt4}) is bounded (<= 8000)`);
  }

  // ══ Part 2: degradeOversizedDocChunk — pass-through for small content ════

  console.log('\n── degradeOversizedDocChunk: pass-through for content within threshold ──');

  {
    // Small content (well below threshold) returns null (no degradation).
    const threshold = resolveArtifactOversizeThreshold(90_000); // ~3400 chars
    const smallContent = 'x'.repeat(100);  // ~100 chars ≈ 25 tokens
    const result = degradeOversizedDocChunk('chunk-001', '/docs/small.md', smallContent, threshold);
    assert(result === null, 'content below threshold returns null (no degradation)');
  }

  {
    // Content exactly at the threshold (in tokens) passes through.
    // At 4 chars/token, threshold tokens × 4 chars = threshold chars.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const borderlineChars = threshold * 4;  // exactly at threshold in tokens
    const borderlineContent = 'y'.repeat(borderlineChars);
    const result = degradeOversizedDocChunk('chunk-border', '/docs/border.md', borderlineContent, threshold);
    assert(result === null, `borderline content (${borderlineChars} chars ≈ ${threshold} tokens) passes through`);
  }

  // ══ Part 3: degradeOversizedDocChunk — degradation for oversized content ═

  console.log('\n── degradeOversizedDocChunk: degradation for oversized content ──');

  {
    // Large content exceeding the threshold produces a canonical ArtifactRef string.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const largeContent = 'z'.repeat(threshold * 4 * 2);  // 2x the threshold in chars
    const result = degradeOversizedDocChunk('chunk-large', '/docs/large.md', largeContent, threshold);
    assert(result !== null, 'oversized content returns a non-null artifact reference');
    assert(typeof result === 'string', 'artifact reference is a string');
    assert(isArtifactRef(result), 'returned string is a valid canonical ArtifactRef');
  }

  {
    // ArtifactRef embeds the source path.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const content = 'a'.repeat(threshold * 8);  // definitely oversized
    const result = degradeOversizedDocChunk('chunk-path-test', '/docs/arch/design.md', content, threshold);
    assert(result !== null, 'oversized content degraded');
    const parsed = parseArtifactRef(result);
    assert(parsed !== null, 'artifact ref parses correctly');
    assert(parsed.id === 'chunk-path-test', `id matches (got ${parsed.id})`);
    assert(parsed.path.includes('design.md') || parsed.path.includes('arch'), `path reference included (got ${parsed.path})`);
  }

  {
    // ArtifactRef uses canonical reason 'artifact_oversize'.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const content = 'b'.repeat(threshold * 6);
    const result = degradeOversizedDocChunk('chunk-reason', '/docs/plan.md', content, threshold);
    const parsed = parseArtifactRef(result);
    assert(parsed.reason === 'artifact_oversize', `reason is artifact_oversize (got ${parsed.reason})`);
    assert(isDegradationReason(parsed.reason), 'reason is in canonical DegradationReason surface');
  }

  {
    // ArtifactRef status is always 'degraded'.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const content = 'c'.repeat(threshold * 4 + 1);
    const result = degradeOversizedDocChunk('chunk-status', '/docs/spec.md', content, threshold);
    const parsed = parseArtifactRef(result);
    assert(parsed.status === 'degraded', `status is degraded (got ${parsed.status})`);
  }

  {
    // ArtifactRef reports the actual size in tokens (not the threshold).
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const chars = threshold * 4 * 3;  // 3× threshold chars → ~3× threshold tokens
    const content = 'd'.repeat(chars);
    const result = degradeOversizedDocChunk('chunk-size', '/docs/large.md', content, threshold);
    const parsed = parseArtifactRef(result);
    // Expected: Math.ceil(chars / 4) tokens
    const expectedTokens = Math.ceil(chars / 4);
    assert(parsed.sizeTokens === expectedTokens, `sizeTokens accurate: got ${parsed.sizeTokens}, expected ${expectedTokens}`);
  }

  {
    // ArtifactRef includes a fetchHint.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const content = 'e'.repeat(threshold * 5);
    const result = degradeOversizedDocChunk('chunk-hint', '/docs/api.md', content, threshold);
    const parsed = parseArtifactRef(result);
    assert(typeof parsed.fetchHint === 'string' && parsed.fetchHint.length > 0, `fetchHint present (got '${parsed.fetchHint}')`);
    assert(isDegradedContent(result), 'degraded chunk ref is recognized as degraded content');
  }

  // ══ Part 4: Headroom preservation — reference is tiny vs original ════════

  console.log('\n── Headroom preservation: reference cost is negligible vs original ──');

  {
    // The canonical artifact reference is much smaller than the original content.
    // This is the core headroom guarantee: degrading an oversized chunk should
    // preserve most of the lane budget instead of filling it.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const oversizedContent = 'f'.repeat(threshold * 4 * 10);  // 10× threshold
    const result = degradeOversizedDocChunk('chunk-headroom', '/docs/huge.md', oversizedContent, threshold);
    assert(result !== null, 'oversized content degraded');

    // The ref should be much smaller than the original (well under 1% of original chars)
    const compressionRatio = result.length / oversizedContent.length;
    assert(compressionRatio < 0.01, `reference is tiny vs original: ratio=${compressionRatio.toFixed(4)} (< 0.01)`);

    // The ref should be bounded by DEGRADATION_LIMITS
    const parsed = parseArtifactRef(result);
    assert(parsed.id.length <= DEGRADATION_LIMITS.artifactId, `id within artifactId limit`);
    assert(parsed.path.length <= DEGRADATION_LIMITS.artifactPath, `path within artifactPath limit`);
    assert(parsed.fetchHint.length <= DEGRADATION_LIMITS.artifactFetchHint, `fetchHint within fetchHint limit`);
  }

  {
    // Degradation cost should be well under the threshold, not at the ceiling.
    // Key invariant: the reference itself is not the full threshold size.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const content = 'g'.repeat(threshold * 4 * 5);
    const result = degradeOversizedDocChunk('chunk-cost', '/docs/cost.md', content, threshold);
    // Token cost of the reference (at 4 chars/token):
    const refTokenCost = Math.ceil(result.length / 4);
    // The reference should be < 50 tokens (a few hundred chars at most)
    assert(refTokenCost < 50, `reference token cost is minimal: ${refTokenCost} tokens (< 50)`);
    // Verify: far cheaper than the original content
    const origTokens = Math.ceil(content.length / 4);
    assert(refTokenCost < origTokens * 0.005, `reference is < 0.5% of original token cost (${refTokenCost} vs ${origTokens})`);
  }

  // ══ Part 5: Canonical format round-trip validation ════════════════════════

  console.log('\n── Canonical format: parse → re-format round-trip ──');

  {
    // degradeOversizedDocChunk output must survive parse+reformat unchanged.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const content = 'h'.repeat(threshold * 4 * 4);
    const result = degradeOversizedDocChunk('chunk-roundtrip', '/docs/rtrip.md', content, threshold);
    const parsed = parseArtifactRef(result);
    assert(parsed !== null, 'artifact ref parses');

    // Re-format using the same helpers from degradation.ts
    const { formatArtifactRef } = await import(`file://${degradationPath}?c2rt=${Date.now()}`);
    const reformatted = formatArtifactRef(parsed);
    assert(reformatted === result, 'round-trip: formatArtifactRef(parseArtifactRef(x)) === x');
  }

  // ══ Part 6: Edge cases ════════════════════════════════════════════════════

  console.log('\n── Edge cases: empty content, minimal threshold ──');

  {
    // Empty content is never degraded (0 tokens ≤ any threshold).
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const result = degradeOversizedDocChunk('empty', '/docs/empty.md', '', threshold);
    assert(result === null, 'empty content is never degraded');
  }

  {
    // Path with long directories is clamped by artifactPath limit.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const longPath = '/very/' + 'deep/'.repeat(50) + 'file.md';
    const content = 'i'.repeat(threshold * 4 * 3);
    const result = degradeOversizedDocChunk('long-path', longPath, content, threshold);
    const parsed = parseArtifactRef(result);
    assert(parsed !== null, 'long-path artifact ref parses');
    assert(parsed.path.length <= DEGRADATION_LIMITS.artifactPath, `long path clamped to artifactPath limit (${parsed.path.length})`);
  }

  {
    // Very high threshold (10 million tokens): extremely large content degrades.
    const hugeThreshold = 10_000_000;
    const smallContent = 'j'.repeat(100);
    const result = degradeOversizedDocChunk('high-threshold', '/x.md', smallContent, hugeThreshold);
    assert(result === null, 'tiny content passes through even with high threshold');
  }

  // ══ Part 7: Stable-prefix invariant ══════════════════════════════════════

  console.log('\n── Stable-prefix invariant: degraded refs are volatile, not prefix content ──');

  {
    // Artifact references are short strings, not system message blocks.
    // They should be placed in volatile context by the compositor (this is
    // enforced by integration, but here we verify the output is plain text
    // that callers inject into the volatile section).
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const content = 'k'.repeat(threshold * 4 * 3);
    const result = degradeOversizedDocChunk('prefix-test', '/docs/stable.md', content, threshold);
    // Verify it's a single-line string (no multiline content that could corrupt the prompt)
    assert(!result.includes('\n'), 'artifact reference is a single line (no embedded newlines)');
    // Verify it does not contain markdown headers (which would imply stable-prefix injection)
    assert(!result.includes('##'), 'artifact reference has no markdown headers');
    assert(!result.includes('# '), 'artifact reference has no top-level headings');
  }

  {
    // Degraded references must not use bracket notation that conflicts with tool stubs.
    // The artifact format starts with [artifact: not [tool:.
    const threshold = resolveArtifactOversizeThreshold(90_000);
    const content = 'l'.repeat(threshold * 4 * 2);
    const result = degradeOversizedDocChunk('format-test', '/docs/fmt.md', content, threshold);
    assert(result.startsWith('[artifact:'), `starts with [artifact: (got: ${result.slice(0, 20)})`);
    assert(!result.startsWith('[tool:'), 'does not start with [tool: (not a tool stub)');
  }

  // ══ Final summary ════════════════════════════════════════════════════════

  console.log('\n═══════════════════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Phase C2 oversized artifact guards test failed:', err);
  process.exit(1);
});
