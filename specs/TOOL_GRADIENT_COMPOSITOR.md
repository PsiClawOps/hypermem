# TOOL_GRADIENT_COMPOSITOR.md
## HyperMem — Gradient Tool Treatment + Transform-First Assembly

**Status:** Approved  
**Author:** Forge  
**Date:** 2026-04-02  
**Implements:** Fix for context overflow in tool-heavy sessions (Pylon overflow incident)

---

## Problem

The current compositor pipeline makes budget decisions before fully transforming messages. The `assemble()` loop stubs old tool content inline while walking messages for budget inclusion — meaning the token estimator measures pre-stub costs for some messages, leading to:

1. Messages dropped that would have fit post-transformation
2. Tool-heavy sessions (Pylon) hitting runtime overflow because estimated vs actual token cost diverges on dense tool results
3. `WARM_BOOTSTRAP_CAP=100` is a message count, not a token budget — 100 messages with large tool results can massively exceed the history budget allocation

Secondary problem: all tool pairs beyond `maxRecentToolPairs` get the same `{"_omitted":true}` / `[result omitted]` treatment regardless of how much signal the result carried. This is wasteful — a `cat` result that showed "no output" is worth 5 tokens of prose; a file read result may be worth 50 tokens of prose but costs 2000 tokens verbatim.

---

## Design

### Core Principle

**Transform everything first. Budget against transformed cost. Drop oldest to fit.**

Message text (assistant reasoning, user messages) is always kept verbatim. Only tool call/result payloads are transformed. A turn is never dropped in the transform pass — only in the budget-fit pass, and only if even its text content alone doesn't fit.

---

### Gradient Tiers (applied to tool payloads only)

Tool pairs are counted newest-to-oldest. Each pair's tool calls + results get one of three treatments:

#### Tier 1 — Last N verbatim (default N=3, config: `maxRecentToolPairs`)
Tool calls and results kept as-is. Model has full context on recent tool activity.

#### Tier 2 — Next M pairs: heuristic prose stub (default M=10, config: `maxProseToolPairs`)
Tool call + result payload replaced with a single natural-language sentence derived from metadata already on the message. No model call — pure extraction.

Examples:
- `read("/src/foo.ts")` + 1.2KB result → `"Read /src/foo.ts (1.2KB)"`
- `exec("npm test")` + exit 0 result → `"Ran npm test — exit 0"`
- `exec("git status")` + result text → `"Ran git status — 3 files modified"`
- `edit("/src/foo.ts")` → `"Edited /src/foo.ts"`
- `web_search("X")` + results → `"Searched for 'X' — 5 results"`
- `write("/path/file.ts")` → `"Wrote /path/file.ts (2.3KB)"`

Prose is emitted as `textContent` on the message. `toolCalls` and `toolResults` are nulled. The turn structure is preserved; the model gets the reasoning trajectory without the raw payloads.

Token cost: ~15-30 tokens per pair instead of 500-5000.

#### Tier 3 — Beyond M+N: tool payload dropped entirely
`toolCalls` and `toolResults` nulled. `textContent` preserved verbatim. No stub, no trace of tool activity — but the assistant's reasoning text remains.

Turn is only removed from history entirely in the budget-fit pass if even the text content doesn't fit the remaining budget.

---

### Transform Pass (new, runs before budget loop)

```
function applyToolGradient(messages: NeutralMessage[], config): NeutralMessage[]

  toolPairsSeen = 0
  walk messages newest → oldest:
    if message has toolCalls or toolResults:
      toolPairsSeen++
      if toolPairsSeen <= maxRecentToolPairs:
        tier = 1 (verbatim)
      else if toolPairsSeen <= maxRecentToolPairs + maxProseToolPairs:
        tier = 2 (prose stub)
      else:
        tier = 3 (drop payload)
      apply tier transform to message
    else:
      pass through unchanged

  return transformed messages
```

This runs on the full fetched message list before any budget math. The result is a `transformedMessages` array where every tool payload is already in its final form.

---

### Budget-Fit Pass (replaces current inline-stub loop)

```
transformedMessages = applyToolGradient(fetchedMessages, config)

remaining = tokenBudget - system - identity - facts - context - vector

walk transformedMessages newest → oldest:
  cost = estimateMessageTokens(msg)  // measures transformed cost
  if accumulated + cost > remaining:
    break (drop this and all older)
  include message
  accumulated += cost
```

No more inline stubbing. No more mid-loop transformation. The budget loop only makes include/exclude decisions.

---

### Token Estimation Correction

Tool content (JSON payloads, code, base64) is denser than English prose. Current estimator uses `length/4` uniformly. Fix:

```ts
function estimateMessageTokens(msg: NeutralMessage): number {
  let tokens = estimateTokens(msg.textContent);         // length/4 — prose
  if (msg.toolCalls) {
    tokens += estimateToolTokens(JSON.stringify(msg.toolCalls));   // length/2 — dense JSON
  }
  if (msg.toolResults) {
    tokens += estimateToolTokens(JSON.stringify(msg.toolResults)); // length/2 — dense JSON
  }
  tokens += 4; // turn overhead
  return tokens;
}

function estimateToolTokens(text: string): number {
  return Math.ceil(text.length / 2); // more conservative for tool payloads
}
```

After transform, tier-2 and tier-3 messages have null tool payloads, so this only applies to tier-1 (verbatim) tool content. Still important — tier-1 results can be large.

---

### Warm Bootstrap: Token-Budget Cap (replaces message count cap)

`WARM_BOOTSTRAP_CAP=100` (message count) → replaced with token-budget-aware seeding.

```
warmSession():
  fetch up to maxHistoryMessages from SQLite
  apply applyToolGradient() transform
  measure transformed token cost per message
  walk newest → oldest, include until WARM_HISTORY_BUDGET exhausted
  seed transformed messages into Redis
```

`WARM_HISTORY_BUDGET` = configurable, default 40% of `defaultTokenBudget` (40k tokens for a 100k budget). This ensures warm never seeds more than the history slot budget regardless of message count.

The old `WARM_BOOTSTRAP_CAP=100` constant is removed. Message count is no longer the governing variable.

---

### Configuration Changes

New fields on `CompositorConfig`:

```ts
/** Tool pairs kept verbatim (newest first). Default: 3 */
maxRecentToolPairs?: number;          // existing

/** Tool pairs converted to prose stubs beyond verbatim threshold. Default: 10 */
maxProseToolPairs?: number;           // NEW

/** Token budget fraction allocated to history during warm bootstrap. Default: 0.4 */
warmHistoryBudgetFraction?: number;   // NEW
```

---

### Heuristic Prose Extractor

New function `extractToolProseSummary(msg: NeutralMessage): string`:

```
if toolCalls present:
  name = toolCalls[0].name
  args = parse toolCalls[0].arguments (best-effort)
  
  switch name:
    'read'  → "Read {args.path or args.file_path} ({result_size}KB)"
    'write' → "Wrote {args.path} ({result_size}KB)"
    'edit'  → "Edited {args.path}"
    'exec'  → "Ran {first 60 chars of args.command} — {exit code or first line of output}"
    'web_search' → "Searched '{args.query}' — {N results or first result title}"
    'web_fetch'  → "Fetched {args.url}"
    'sessions_send' → "Sent message to {args.sessionKey or args.label}"
    'memory_search' → "Searched memory for '{args.query}'"
    default → "Used {name}"

if toolResults present and no toolCalls (result-only turn):
  content = toolResults[0].content (truncated to 100 chars)
  → "Tool result: {content}"

return prose string
```

The prose string becomes `textContent` on the transformed message. `toolCalls` and `toolResults` are nulled.

---

## Implementation Plan

### Files changed
- `src/compositor.ts` — transform pass, budget-fit loop rewrite, warm bootstrap token budget
- `src/types.ts` — add `maxProseToolPairs`, `warmHistoryBudgetFraction` to `CompositorConfig`

### New functions
- `applyToolGradient(messages, config): NeutralMessage[]` — pure transform, no side effects
- `extractToolProseSummary(msg): string` — heuristic prose extractor
- `estimateToolTokens(text): number` — denser estimator for tool payloads

### Tests needed
- `applyToolGradient`: verify tier assignment, prose extraction, text preservation
- `estimateMessageTokens`: verify tool content uses dense estimator
- Budget-fit loop: verify messages dropped by token budget not message count
- Warm bootstrap: verify token-budget cap respected, not message count

### Migration
- No schema changes
- No Redis key changes
- `WARM_BOOTSTRAP_CAP` constant removed — replaced by runtime budget calculation
- Existing `maxRecentToolPairs` config value preserved and honored

---

## What This Fixes

| Issue | Fix |
|---|---|
| Pylon overflow (120 msgs, runtime budget disagreement) | Transform-first means budget loop measures actual cost; dense tool estimator corrects undercount |
| `within_budget` compaction bail while preemptive guard fires | Resolved — transformed messages are smaller, budget estimate is more accurate, gap between estimators narrows |
| WARM_BOOTSTRAP_CAP=100 ignores token cost | Replaced with token-budget-aware warm |
| Old tool pairs wasting context with `{"_omitted":true}` | Prose stubs carry real signal at fraction of cost |
| Text content of old turns lost with tool payload | Text always preserved — only tool payloads are transformed |

---

## Non-Goals

- Model-based summarization of tool results (future pass if prose stubs prove insufficient)
- Cross-turn summarization / conversation compression (separate concern)
- Changes to OpenClaw core (this is entirely HyperMem-owned)
