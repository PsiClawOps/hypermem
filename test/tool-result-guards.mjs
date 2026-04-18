/**
 * tool-result-guards.mjs — Phase C1 test coverage
 *
 * Tests for tool-use + dependent tool-result ejection, stub vs co-eject behavior,
 * no-orphan invariants, and canonical stub reasons / telemetry structure.
 *
 * Uses the C0.3 golden fixtures (via degradation.js) as the format seam.
 * Exercises functions exported from compositor.js (test-only surface):
 *   - getTurnAge
 *   - applyToolGradient
 *   - evictLargeToolResults
 *   - applyTierPayloadCap
 *
 * And from degradation.js (public surface):
 *   - isToolChainStub, parseToolChainStub, formatToolChainStub
 *   - isDegradationReason, DEGRADATION_REASONS, DEGRADATION_LIMITS
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

// ── Fixture helpers ────────────────────────────────────────────────────────

/** NeutralMessage: assistant with a single tool call */
function makeAssistantTool(callId, toolName = 'read', args = { path: '/file.ts' }) {
  return {
    role: 'assistant',
    textContent: 'Running tool',
    toolCalls: [{ id: callId, name: toolName, arguments: JSON.stringify(args) }],
    toolResults: null,
  };
}

/** NeutralMessage: user message carrying a tool result */
function makeToolResultMsg(callId, toolName, contentSize) {
  return {
    role: 'user',
    textContent: null,
    toolCalls: null,
    toolResults: [{ callId, name: toolName, content: 'r'.repeat(contentSize) }],
  };
}

/** NeutralMessage: plain user query (no tool content — advances turn age counter) */
function makeUserQuery(text) {
  return { role: 'user', textContent: text, toolCalls: null, toolResults: null };
}

/**
 * Build a realistic conversation.
 * @param {Array<{callId: string, toolName: string, size: number}>} completedTurns
 * @param {number} plainUserQueriesAfter  How many plain user queries to append (advances age)
 */
function buildConversation(completedTurns, plainUserQueriesAfter = 0) {
  const msgs = [];
  for (const { callId, toolName = 'read', size } of completedTurns) {
    msgs.push(makeAssistantTool(callId, toolName));
    msgs.push(makeToolResultMsg(callId, toolName, size));
  }
  for (let i = 0; i < plainUserQueriesAfter; i++) {
    msgs.push(makeUserQuery(`query-${i + 1}`));
  }
  return msgs;
}

/**
 * Check the no-orphan invariant: every tool-result in `messages` must have
 * a corresponding tool-call with a matching id somewhere in `messages`.
 * Returns the count of orphaned tool-results.
 */
function countOrphanedToolResults(messages) {
  let orphans = 0;
  for (const msg of messages) {
    if (!msg.toolResults) continue;
    for (const tr of msg.toolResults) {
      const hasMatch = messages.some(m => m.toolCalls?.some(tc => tc.id === tr.callId));
      if (!hasMatch) orphans++;
    }
  }
  return orphans;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  HyperMem Phase C1: Tool-Result Guards & Ejection Coverage');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // ── Imports ──
  const {
    getTurnAge,
    applyToolGradient,
    evictLargeToolResults,
    applyTierPayloadCap,
  } = await import(`file://${compositorPath}?c1=${Date.now()}`);

  const {
    isToolChainStub,
    parseToolChainStub,
    formatToolChainStub,
    isDegradationReason,
    isDegradedContent,
    DEGRADATION_REASONS,
    DEGRADATION_LIMITS,
  } = await import(`file://${degradationPath}?c1=${Date.now()}`);

  // ══ Part 1: getTurnAge semantics ═════════════════════════════════════════

  console.log('── getTurnAge: turn-age semantics ──');

  {
    // Only plain user messages (no toolResults) advance the age counter.
    // Tool-result user messages do NOT count as a new "turn" for age purposes.
    const msgs = [
      makeAssistantTool('c0'),
      makeToolResultMsg('c0', 'read', 100),
      makeUserQuery('q1'),
      makeUserQuery('q2'),
    ];
    const age0 = getTurnAge(msgs, 0); // oldest assistant
    const age1 = getTurnAge(msgs, 1); // oldest tool-result user
    const ageQ1 = getTurnAge(msgs, 2); // first query
    const ageQ2 = getTurnAge(msgs, 3); // last query
    assert(age0 === age1, 'tool-result user msg has same turn age as its paired assistant');
    assert(ageQ1 === 1, 'first plain user query has age=1');
    assert(ageQ2 === 0, 'last message always has age=0');
    assert(age0 === 2, 'oldest messages have age=2 with 2 plain queries after');
  }

  {
    // Tool-result user messages are NOT counted in the age tally.
    // Three plain queries after a turn pushes it to age=3.
    const msgs = [
      makeAssistantTool('c0'),
      makeToolResultMsg('c0', 'read', 100),
      makeUserQuery('q1'),
      makeUserQuery('q2'),
      makeUserQuery('q3'),
    ];
    const age0 = getTurnAge(msgs, 0);
    assert(age0 === 3, 'turn age increments only on plain user queries, reaches 3 with 3 queries');
  }

  // ══ Part 2: evictLargeToolResults – stub creation ════════════════════════

  console.log('\n── evictLargeToolResults: stub creation for oversized results ──');

  // TOOL_RESULT_EVICTION_CHAR_THRESHOLD = 3200 chars
  const EVICTION_THRESHOLD = 3200;

  {
    // Results below threshold are preserved as-is (no stub).
    const msgs = buildConversation(
      [{ callId: 'small-0', toolName: 'read', size: EVICTION_THRESHOLD - 1 }],
      3, // push to age=3
    );
    const evicted = evictLargeToolResults(msgs);
    const result = evicted.find(m => m.toolResults?.some(tr => tr.callId === 'small-0'));
    const tr = result?.toolResults?.find(t => t.callId === 'small-0');
    assert(tr !== undefined, 'small result message preserved');
    assert(!isToolChainStub(tr.content), 'small result content is NOT a stub');
    assert(tr.content.length === EVICTION_THRESHOLD - 1, 'small result content unchanged');
  }

  {
    // Results at/above threshold get replaced with a ToolChainStub.
    const msgs = buildConversation(
      [{ callId: 'large-0', toolName: 'read', size: EVICTION_THRESHOLD + 100 }],
      3,
    );
    const evicted = evictLargeToolResults(msgs);
    const result = evicted.find(m => m.toolResults?.some(tr => tr.callId === 'large-0'));
    const tr = result?.toolResults?.find(t => t.callId === 'large-0');
    assert(tr !== undefined, 'large result message preserved (with stub)');
    assert(isToolChainStub(tr.content), 'large result is replaced with a ToolChainStub');
    const parsed = parseToolChainStub(tr.content);
    assert(parsed !== null, 'stub is parseable');
    assert(parsed.reason === 'eviction_oversize', 'stub reason is eviction_oversize');
    assert(isDegradationReason(parsed.reason), 'stub reason is in canonical reason surface');
    assert(parsed.name === 'read', 'stub name matches original tool name');
    assert(parsed.id === 'large-0', 'stub id matches original callId');
    assert(parsed.status === 'ejected', 'stub status is ejected');
  }

  {
    // Multiple results in one conversation: only oversized ones are stubbed.
    const msgs = buildConversation([
      { callId: 'small-a', toolName: 'read', size: 100 },
      { callId: 'large-b', toolName: 'exec', size: EVICTION_THRESHOLD + 500 },
      { callId: 'large-c', toolName: 'web_search', size: EVICTION_THRESHOLD + 1000 },
    ], 3);

    const evicted = evictLargeToolResults(msgs);
    const resultA = evicted.find(m => m.toolResults?.some(tr => tr.callId === 'small-a'))?.toolResults?.find(t => t.callId === 'small-a');
    const resultB = evicted.find(m => m.toolResults?.some(tr => tr.callId === 'large-b'))?.toolResults?.find(t => t.callId === 'large-b');
    const resultC = evicted.find(m => m.toolResults?.some(tr => tr.callId === 'large-c'))?.toolResults?.find(t => t.callId === 'large-c');

    assert(!isToolChainStub(resultA.content), 'small result preserved without stub');
    assert(isToolChainStub(resultB.content), 'large exec result is stubbed');
    assert(isToolChainStub(resultC.content), 'large web_search result is stubbed');

    const parsedB = parseToolChainStub(resultB.content);
    const parsedC = parseToolChainStub(resultC.content);
    assert(parsedB.name === 'exec', 'stubbed exec name correct');
    assert(parsedC.name === 'web_search', 'stubbed web_search name correct');
    assert(parsedB.reason === 'eviction_oversize', 'exec stub reason is eviction_oversize');
    assert(parsedC.reason === 'eviction_oversize', 'web_search stub reason is eviction_oversize');
  }

  {
    // Protected recent turns (age <= TOOL_GRADIENT_T0_TURNS=2) are NOT evicted.
    // Only 1 plain query after → age=1 for the turns.
    const msgs = buildConversation(
      [{ callId: 'recent-0', toolName: 'read', size: EVICTION_THRESHOLD + 1000 }],
      1, // age=1, under T0_TURNS=2 protection
    );
    const evicted = evictLargeToolResults(msgs);
    const tr = evicted.find(m => m.toolResults?.some(t => t.callId === 'recent-0'))?.toolResults?.find(t => t.callId === 'recent-0');
    assert(tr !== undefined, 'recent result message present');
    assert(!isToolChainStub(tr.content), 'recent large result NOT evicted (protected turn)');
  }

  // ══ Part 3: No orphaned tool-results invariant ═══════════════════════════

  console.log('\n── No-orphan invariant: every tool-result must have a paired tool-call ──');

  {
    // Baseline: clean conversation, no orphans before any transforms.
    const msgs = buildConversation([
      { callId: 'c0', size: 100 },
      { callId: 'c1', size: 200 },
    ], 3);
    const orphans = countOrphanedToolResults(msgs);
    assert(orphans === 0, 'no orphans in baseline fixture');
  }

  {
    // After evictLargeToolResults: stubs keep the same callId, so no orphans.
    const msgs = buildConversation([
      { callId: 'ev-0', toolName: 'read', size: EVICTION_THRESHOLD + 100 },
      { callId: 'ev-1', toolName: 'exec', size: 100 },
    ], 3);
    const evicted = evictLargeToolResults(msgs);
    const orphans = countOrphanedToolResults(evicted);
    assert(orphans === 0, 'no orphans after evictLargeToolResults (stubs preserve callId)');
  }

  {
    // After applyToolGradient: T2/T3 tiers null out toolCalls+toolResults together.
    // Verify that the gradient never leaves a result without a paired call in the output.
    const msgs = buildConversation([
      { callId: 't3-0', toolName: 'read', size: 200 },
      { callId: 't3-1', toolName: 'exec', size: 200 },
    ], 5); // 5 queries → age=5 → T3 tier (stubs only in text)
    const grad = applyToolGradient(msgs, {});
    const orphans = countOrphanedToolResults(grad);
    assert(orphans === 0, 'no orphans after applyToolGradient (T3 nulls both sides)');
    // Both old turns should have toolCalls and toolResults set to null in T3.
    const hasStructuredToolCalls = grad.some(m => m.toolCalls && m.toolCalls.length > 0);
    assert(!hasStructuredToolCalls, 'T3-tier old turns: no structured toolCalls remain');
  }

  {
    // After both applyToolGradient + evictLargeToolResults chained together.
    const msgs = buildConversation([
      { callId: 'chain-0', toolName: 'read', size: 100 },          // small
      { callId: 'chain-1', toolName: 'exec', size: EVICTION_THRESHOLD + 100 }, // large
      { callId: 'chain-2', toolName: 'web_search', size: 200 },    // small
    ], 3);
    const grad = applyToolGradient(msgs, {});
    const evicted = evictLargeToolResults(grad);
    const orphans = countOrphanedToolResults(evicted);
    assert(orphans === 0, 'no orphans after gradient + eviction pipeline');
  }

  {
    // No orphans across a long conversation with mixed turns.
    const turns = [];
    for (let i = 0; i < 8; i++) {
      turns.push({ callId: `mix-${i}`, toolName: i % 2 === 0 ? 'read' : 'exec', size: i % 3 === 0 ? EVICTION_THRESHOLD + 200 : 150 });
    }
    const msgs = buildConversation(turns, 4);
    const grad = applyToolGradient(msgs, {});
    const evicted = evictLargeToolResults(grad);
    const orphans = countOrphanedToolResults(evicted);
    assert(orphans === 0, 'no orphans in extended 8-turn mixed conversation');
  }

  // ══ Part 4: applyTierPayloadCap – stub vs co-eject ══════════════════════

  console.log('\n── applyTierPayloadCap: individual stub vs co-eject behavior ──');

  // When perResultCap is hit but perTurnCap is NOT, individual results are truncated.
  // When usedSoFar + truncated > perTurnCap, the whole turn co-ejects to text.

  {
    // Individual truncation (perResultCap hit, turn stays structured).
    const msg = {
      role: 'user',
      textContent: null,
      toolCalls: [{ id: 'cap-a', name: 'read', arguments: '{"path":"/f"}' }],
      toolResults: [{ callId: 'cap-a', name: 'read', content: 'x'.repeat(10000) }],
    };
    const PER_RESULT_CAP = 800;
    const { msg: cappedMsg, usedChars } = applyTierPayloadCap(msg, PER_RESULT_CAP, undefined, 0);

    assert(cappedMsg.toolResults !== null, 'individual cap: toolResults still present');
    assert(cappedMsg.toolResults.length === 1, 'individual cap: one result');
    const resultLen = cappedMsg.toolResults[0].content.length;
    // The cap leaves space for a '\n[trimmed]' suffix, so result is approx perResultCap
    assert(resultLen <= PER_RESULT_CAP + 20, `individual cap: result content bounded (~${resultLen} ≤ ~${PER_RESULT_CAP})`);
    assert(usedChars <= PER_RESULT_CAP + 20, `individual cap: usedChars bounded (~${usedChars})`);
  }

  {
    // Co-eject: when usedSoFar + truncated > perTurnCap, turn becomes prose text.
    const msg = {
      role: 'user',
      textContent: null,
      toolCalls: [{ id: 'co-a', name: 'read', arguments: '{"path":"/file.ts"}' }],
      toolResults: [{ callId: 'co-a', name: 'read', content: 'x'.repeat(10000) }],
    };
    // With usedSoFar=180 and perTurnCap=200, even the smallest truncated result
    // will push over the limit → triggers co-eject.
    const { msg: coMsg } = applyTierPayloadCap(msg, 800, 200, 180);

    assert(coMsg.toolResults === null, 'co-eject: toolResults set to null');
    assert(coMsg.toolCalls === null, 'co-eject: toolCalls set to null');
    assert(typeof coMsg.textContent === 'string', 'co-eject: textContent is a string (prose summary)');
    assert(coMsg.textContent.length > 0, 'co-eject: textContent is non-empty');
    // The prose summary should reference the file path (from toolLabelFromCall)
    assert(coMsg.textContent.includes('file.ts') || coMsg.textContent.includes('Read'), 'co-eject: prose summary references tool identity');
  }

  {
    // Two results: first fits, second pushes over turn cap → co-eject of whole turn.
    const msg = {
      role: 'user',
      textContent: null,
      toolCalls: [
        { id: 'two-a', name: 'read', arguments: '{"path":"/a.ts"}' },
        { id: 'two-b', name: 'exec', arguments: '{"command":"ls"}' },
      ],
      toolResults: [
        { callId: 'two-a', name: 'read', content: 'x'.repeat(500) },
        { callId: 'two-b', name: 'exec', content: 'y'.repeat(500) },
      ],
    };
    // perResultCap=600 (both fit), perTurnCap=300 (usedSoFar=0, adding 500+500=1000 chars → exceeds 300)
    // After first result: usedChars=500, usedChars > perTurnCap=300 → co-eject
    const { msg: coMsg } = applyTierPayloadCap(msg, 600, 300, 0);
    assert(coMsg.toolResults === null, 'two-result co-eject: toolResults null');
    assert(coMsg.toolCalls === null, 'two-result co-eject: toolCalls null');
  }

  {
    // Very large result where perResultCap is less than 30% of stripped content
    // AND less than 2000 chars → sentinel string instead of truncated fragment.
    const msg = {
      role: 'user',
      textContent: null,
      toolCalls: [{ id: 'huge-a', name: 'read', arguments: '{"path":"/huge.ts"}' }],
      toolResults: [{ callId: 'huge-a', name: 'read', content: 'h'.repeat(20000) }],
    };
    // perResultCap=100 < 20000*0.30=6000 AND < 2000 → sentinel
    const { msg: cappedMsg } = applyTierPayloadCap(msg, 100, undefined, 0);
    const resultContent = cappedMsg.toolResults?.[0]?.content ?? '';
    assert(resultContent.includes('too large'), 'tiny cap: sentinel "too large" message returned');
    assert(!resultContent.startsWith('h'), 'tiny cap: original content not present in sentinel');
  }

  // ══ Part 5: Canonical stub reasons ══════════════════════════════════════

  console.log('\n── Canonical stub reasons: eviction stubs use closed reason surface ──');

  {
    // evictLargeToolResults always emits 'eviction_oversize'.
    const msgs = buildConversation([
      { callId: 'rsn-0', toolName: 'read', size: EVICTION_THRESHOLD + 1 },
      { callId: 'rsn-1', toolName: 'exec', size: EVICTION_THRESHOLD + 1 },
    ], 3);
    const evicted = evictLargeToolResults(msgs);
    for (const msg of evicted) {
      if (!msg.toolResults) continue;
      for (const tr of msg.toolResults) {
        if (!isToolChainStub(tr.content)) continue;
        const parsed = parseToolChainStub(tr.content);
        assert(parsed !== null, `stub is parseable (callId=${tr.callId})`);
        assert(isDegradationReason(parsed.reason), `stub reason is in canonical surface (${parsed.reason})`);
        assert(parsed.reason === 'eviction_oversize', `eviction stub uses reason=eviction_oversize (got ${parsed.reason})`);
        assert(isDegradedContent(tr.content), 'eviction stub recognized as degraded content');
      }
    }
  }

  {
    // formatToolChainStub with other canonical reasons produces valid stubs.
    const canonicalEvictionReasons = [
      'gradient_t3_stub',
      'eviction_oversize',
      'eviction_turn0_trim',
    ];
    for (const reason of canonicalEvictionReasons) {
      const stub = formatToolChainStub({
        name: 'read',
        id: 'test-id',
        status: 'ejected',
        reason,
        summary: 'test summary',
      });
      const parsed = parseToolChainStub(stub);
      assert(parsed !== null, `stub with reason=${reason} is parseable`);
      assert(parsed.reason === reason, `round-trip reason survives (${reason})`);
      assert(isDegradationReason(parsed.reason), `reason=${reason} is in canonical surface`);
    }
  }

  {
    // Stubs must have reason from the closed DegradationReason set (parseToolChainStub rejects bogus reasons).
    const bogusStub = '[tool:read id=t1 status=ejected reason=not_a_real_reason summary=test]';
    assert(parseToolChainStub(bogusStub) === null, 'stub with bogus reason rejected by parseToolChainStub');
  }

  // ══ Part 6: Stub field length bounds ════════════════════════════════════

  console.log('\n── Stub bounds: eviction stubs respect DEGRADATION_LIMITS ──');

  {
    // Long tool names and summaries are clamped to DEGRADATION_LIMITS.
    const longName = 'a'.repeat(200);
    const longSummary = 'b'.repeat(500);
    const stub = formatToolChainStub({
      name: longName,
      id: 'test-id',
      status: 'ejected',
      reason: 'eviction_oversize',
      summary: longSummary,
    });
    const parsed = parseToolChainStub(stub);
    assert(parsed !== null, 'long-name stub is parseable');
    assert(parsed.name.length <= DEGRADATION_LIMITS.toolName, `name clamped to ${DEGRADATION_LIMITS.toolName}`);
    assert(parsed.summary.length <= DEGRADATION_LIMITS.toolSummary, `summary clamped to ${DEGRADATION_LIMITS.toolSummary}`);
  }

  {
    // Stubs produced by evictLargeToolResults obey length limits.
    const msgs = buildConversation([
      { callId: 'bounds-0', toolName: 'web_search', size: EVICTION_THRESHOLD + 1 },
    ], 3);
    const evicted = evictLargeToolResults(msgs);
    const tr = evicted.find(m => m.toolResults?.some(t => t.callId === 'bounds-0'))?.toolResults?.find(t => t.callId === 'bounds-0');
    assert(isToolChainStub(tr.content), 'eviction produces a stub');
    const parsed = parseToolChainStub(tr.content);
    assert(parsed.name.length <= DEGRADATION_LIMITS.toolName, 'eviction stub name within toolName limit');
    assert(parsed.id.length <= DEGRADATION_LIMITS.toolId, 'eviction stub id within toolId limit');
    assert(parsed.summary.length <= DEGRADATION_LIMITS.toolSummary, 'eviction stub summary within toolSummary limit');
  }

  // ══ Part 7: Telemetry counter structure ════════════════════════════════

  console.log('\n── Telemetry counters: count stubs vs non-stubs accurately ──');

  {
    // Helper function for counting degradation events (as a counter helper).
    // Mirrors the kind of telemetry a caller would collect over the pipeline.
    function collectDegradationCounters(messages) {
      const counters = {
        total: 0,
        stubs: 0,
        nonStub: 0,
        byReason: {},
        orphans: countOrphanedToolResults(messages),
      };
      for (const msg of messages) {
        if (!msg.toolResults) continue;
        for (const tr of msg.toolResults) {
          counters.total++;
          if (isToolChainStub(tr.content)) {
            counters.stubs++;
            const parsed = parseToolChainStub(tr.content);
            counters.byReason[parsed.reason] = (counters.byReason[parsed.reason] ?? 0) + 1;
          } else {
            counters.nonStub++;
          }
        }
      }
      return counters;
    }

    const msgs = buildConversation([
      { callId: 'tel-0', size: 100 },                          // small, no stub
      { callId: 'tel-1', size: EVICTION_THRESHOLD + 100 },     // large, stubbed
      { callId: 'tel-2', size: EVICTION_THRESHOLD + 200 },     // large, stubbed
      { callId: 'tel-3', size: 150 },                          // small, no stub
    ], 3);
    const evicted = evictLargeToolResults(msgs);
    const counters = collectDegradationCounters(evicted);

    assert(counters.total === 4, `total results=4 (got ${counters.total})`);
    assert(counters.stubs === 2, `stubs=2 (got ${counters.stubs})`);
    assert(counters.nonStub === 2, `non-stubs=2 (got ${counters.nonStub})`);
    assert(counters.byReason['eviction_oversize'] === 2, `eviction_oversize count=2 (got ${counters.byReason['eviction_oversize']})`);
    assert(counters.orphans === 0, `no orphans (got ${counters.orphans})`);
  }

  // ══ Part 8: Stable-prefix boundary ═════════════════════════════════════

  console.log('\n── Stable-prefix boundary: no tool-results cross into stable system prefix ──');

  {
    // System messages (before any user/assistant messages) form the stable prefix.
    // Tool content must NEVER appear in them. Verify this property holds.
    const systemMsg = { role: 'system', textContent: 'You are a helpful assistant.', toolCalls: null, toolResults: null };
    const msgs = [
      systemMsg,
      makeAssistantTool('sp-0', 'read'),
      makeToolResultMsg('sp-0', 'read', EVICTION_THRESHOLD + 100),
      makeUserQuery('q1'),
      makeUserQuery('q2'),
      makeUserQuery('q3'),
    ];
    const evicted = evictLargeToolResults(msgs);
    const systemAfter = evicted[0]; // system message should be first and unchanged
    assert(systemAfter.role === 'system', 'system message is first after eviction');
    assert(systemAfter.toolCalls === null && systemAfter.toolResults === null, 'system message has no tool content');
    assert(systemAfter.textContent === systemMsg.textContent, 'system message text unchanged');
  }

  {
    // Applying both transforms to a conversation with a system prefix: verify
    // the prefix is byte-for-byte identical after both transforms.
    const systemMsg1 = { role: 'system', textContent: 'Identity block A', toolCalls: null, toolResults: null };
    const systemMsg2 = { role: 'system', textContent: 'Identity block B', toolCalls: null, toolResults: null };
    const msgs = [
      systemMsg1,
      systemMsg2,
      makeAssistantTool('pfx-0', 'exec'),
      makeToolResultMsg('pfx-0', 'exec', EVICTION_THRESHOLD + 200),
      makeUserQuery('q1'),
      makeUserQuery('q2'),
      makeUserQuery('q3'),
    ];
    const grad = applyToolGradient(msgs, {});
    const evicted = evictLargeToolResults(grad);

    assert(evicted[0].textContent === systemMsg1.textContent, 'first system block unchanged after pipeline');
    assert(evicted[1].textContent === systemMsg2.textContent, 'second system block unchanged after pipeline');
    assert(evicted[0].toolResults === null && evicted[1].toolResults === null, 'no tool-results in prefix after pipeline');
  }

  // ══ Part 9: applyToolGradient tier ejection – T2/T3 structure ══════════

  console.log('\n── applyToolGradient: T2/T3 tier ejection removes structured tool content ──');

  {
    // T1 tier (age=3-4): individual caps applied, structured toolCalls/Results kept.
    const msgs = buildConversation(
      [{ callId: 't1-0', toolName: 'read', size: 200 }],
      3, // age=3 → T1 tier
    );
    const grad = applyToolGradient(msgs, {});
    const resultMsg = grad.find(m => m.toolResults && m.toolResults.length > 0);
    // T1 keeps structured results but may truncate them
    assert(resultMsg !== undefined || grad.some(m => m.textContent?.includes('[')), 'T1 tier: result or prose summary present');
    const orphans = countOrphanedToolResults(grad);
    assert(orphans === 0, 'T1 tier: no orphans');
  }

  {
    // T3 tier (age=8+): tool content fully ejected, becomes text only.
    const msgs = buildConversation(
      [{ callId: 't3-a', toolName: 'read', size: 200 }],
      8, // age=8 → T3 tier
    );
    const grad = applyToolGradient(msgs, {});
    const hasRemainingToolResults = grad.some(m => m.toolResults && m.toolResults.length > 0);
    const hasRemainingToolCalls = grad.some(m => m.toolCalls && m.toolCalls.length > 0);
    assert(!hasRemainingToolResults, 'T3 tier: no structured toolResults remain');
    assert(!hasRemainingToolCalls, 'T3 tier: no structured toolCalls remain');
    assert(countOrphanedToolResults(grad) === 0, 'T3 tier: no orphans (both sides are null)');
  }

  {
    // T3 tier text summary should contain a compact trace of the tool activity.
    const msgs = buildConversation(
      [{ callId: 't3-b', toolName: 'web_search', size: 200 }],
      8,
    );
    const grad = applyToolGradient(msgs, {});
    // The T3 assistant message originally had tool calls; after gradient it should
    // have a textContent that includes some summary of the web_search action.
    const assistantMsg = grad.find(m => m.role === 'assistant' && m.textContent);
    assert(assistantMsg !== undefined, 'T3 tier: assistant has textContent summary');
    // The summary should mention the tool (web_search) or its label
    assert(
      assistantMsg.textContent.includes('web_search') ||
      assistantMsg.textContent.includes('Searched') ||
      assistantMsg.textContent.includes('[') ||
      assistantMsg.textContent.includes('search'),
      'T3 tier: assistant summary references tool activity'
    );
  }

  // ══ Part 10: Integration – stable ID threading ══════════════════════════

  console.log('\n── Integration: stub id threading across pipeline ──');

  {
    // After eviction, the stub's id should match the original callId
    // and the paired tool-call should still have the same id.
    // This ensures any downstream consumer can correlate stub ↔ call.
    const CALL_ID = 'thread-id-01';
    const msgs = buildConversation(
      [{ callId: CALL_ID, toolName: 'read', size: EVICTION_THRESHOLD + 500 }],
      3,
    );
    const evicted = evictLargeToolResults(msgs);

    // Find the assistant message with the tool call
    const callMsg = evicted.find(m => m.toolCalls?.some(tc => tc.id === CALL_ID));
    // Find the user message with the result (now a stub)
    const resultMsg = evicted.find(m => m.toolResults?.some(tr => tr.callId === CALL_ID));

    assert(callMsg !== undefined, 'tool-call message preserved after eviction');
    assert(resultMsg !== undefined, 'tool-result (stub) message preserved after eviction');

    const tr = resultMsg.toolResults.find(t => t.callId === CALL_ID);
    const parsed = parseToolChainStub(tr.content);
    assert(parsed.id === CALL_ID, `stub id=${parsed.id} matches original callId=${CALL_ID}`);
    assert(countOrphanedToolResults(evicted) === 0, 'no orphans: stub id links back to call');
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
  console.error('Phase C1 tool-result guards test failed:', err);
  process.exit(1);
});
