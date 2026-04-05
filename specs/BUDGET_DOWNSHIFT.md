# HyperMem: Budget Downshift / Model Switch Reshaping

**Status:** Proposed  
**Priority:** P1  
**Triggered by:** Pylon session — gpt-5.4 (large window) → copilot-local/claude-sonnet-4.6 (smaller window), compaction struggling with tool results

---

## Problem

When an agent switches from a high-context model to a lower-context model mid-session (or across sessions), the Redis history window was sized for the old budget. HyperMem's existing mechanisms handle this *eventually* but not *smoothly*:

1. `trimHistoryToTokenBudget` in `assemble()` trims the window but only by message count walking newest→oldest. It does not apply tool gradient logic — so a few large tool result payloads can consume a disproportionate share of the new budget.
2. The tool gradient runs inside the compositor safety valve, but by that point we've already fed the compositor a window that may be over-budget in token estimation terms.
3. `compact()` only fires after the runtime detects overflow. That's a reactive, last-resort path — not a smooth reshape.
4. The conversation *feels* OK because the compositor's safety valve eventually trims the assembled output, but the Redis window itself stays bloated, causing repeated over-budget warnings and compaction churn every turn until enough messages age out naturally.

**Net result:** several turns of instability after a model switch — compaction fighting tool results, over-budget estimates, potentially truncated recent context.

---

## Terminology

- **Budget downshift**: new tokenBudget < last composed tokenBudget by more than a threshold (e.g. 10%)
- **Budget upshift**: new tokenBudget > last composed tokenBudget — no action needed, just expand
- **Reshape pass**: a proactive pre-compose operation that aggressively applies tool gradient + trim to bring the Redis window inside the new budget before the compositor runs

---

## Proposed Solution

### 1. Model State Tracking in Redis

Store per-session model state after each successful compose:

```
hm:{agent}:{sk}:model_state → JSON {
  model: string,
  tokenBudget: number,
  composedAt: ISO string,
  historyDepth: number
}
```

TTL: 7 days (same as session keys).

This is a single Redis SET per compose — negligible cost.

### 2. Budget Downshift Detection in `assemble()`

At the start of `assemble()`, after computing `effectiveBudget`:

```typescript
const lastState = await hm.redis.getModelState(agentId, sk);
const isDownshift = lastState && 
  (lastState.tokenBudget - effectiveBudget) / lastState.tokenBudget > 0.10;
```

A 10% budget reduction is the threshold. Switching from gpt-5.4 (~200K effective) to claude-sonnet (~90K) is a ~55% downshift — clearly over threshold.

### 3. Proactive Reshape Pass

When `isDownshift === true`, before calling `compose()`:

**Step 1: Apply tool gradient to the full window at new budget**

Pull the current Redis window. Walk it with `applyToolGradient()` using the new budget target (not the old one). This demotes tool payloads that were kept verbatim under the old budget to T2/T3 prose stubs under the new budget.

**Step 2: Trim to new budget**

After gradient application, trim the reshaped window to `effectiveBudget * 0.65` (same 65% target used in the histogram-based depth calculation).

**Step 3: Write back and invalidate**

- `setWindow(agentId, sk, reshaped)`
- `invalidateWindow(agentId, sk)` — force compose cache miss
- Log the reshape event with budget delta

**Step 4: Update model state**

Write new model state after reshape so the next turn doesn't trigger reshape again unnecessarily.

```
[hypermem-plugin] budget-downshift: forge/session-key 200000→90000 tokens, reshaped 180→94 messages, tool-gradient-applied
```

### 4. `compact()` Coordination

After a reshape pass, the `compact()` call should detect that the window is already within budget and return `compacted: false, reason: 'reshaped_by_downshift'` instead of running its own trim pass. This avoids double-processing.

Add a flag to Redis model state: `reshapedAt` timestamp. `compact()` checks: if `reshapedAt` is within the last 30 seconds, skip.

---

## What This Does NOT Change

- The tool gradient tier boundaries (T0/T1/T2/T3 by turn age) — these stay fixed
- The compositor safety valve — still runs as last defense
- The compaction path — still available for genuine overflow cases
- Budget upshifts — no action, just update stored state and let the next compose use the larger window

---

## Failure Modes Addressed

| Scenario | Before | After |
|---|---|---|
| gpt-5.4 → sonnet model switch | Several turns of compaction churn | One reshape pass at first `assemble()` call with new model |
| Tool-heavy session with large payloads | Over-budget estimates linger until natural aging | Gradient demotes payloads proactively at reshape |
| Repeated compaction on same turn | `compact()` → `assemble()` → `compact()` loop possible | `reshapedAt` flag breaks the loop |
| Temporary model switch back to large model | Budget upshift: no reshape needed | Model state updated, next downshift will detect cleanly |

---

## Implementation Scope

**Files to change:**
- `src/redis.ts` — add `getModelState()`, `setModelState()` (simple JSON get/set with TTL)
- `plugin/src/index.ts` — add downshift detection + reshape pass in `assemble()`, coordinate `compact()`
- `src/compositor.ts` — expose `applyToolGradientToWindow()` helper (already has `applyToolGradient` internally, just needs a public wrapper for the pre-compose path)

**Tests to add:**
- `test/budget-downshift.mjs`
  - Populate a Redis window sized for 200K budget
  - Call `assemble()` with 90K budget
  - Assert reshape pass ran (log check or model state TTL check)
  - Assert output window is within 90K target
  - Assert tool payloads in old messages are demoted to prose stubs

**Estimated complexity:** Medium — 3 files, ~150 LOC net, 1 new test file.

---

## Sequencing

**P0 blockers:** None — this is additive, does not touch existing hot paths.  
**Dependencies:** Tool gradient must be working (it is, as of 2026-04-02).  
**Recommended slot:** After dual-record cleanup and envelope cleanup are confirmed clean. Before fleet-wide compaction audit.

---

## Open Questions

1. **Threshold tuning**: Is 10% the right downshift trigger? Could be too sensitive for minor budget adjustments (e.g. config tweak). Consider 20% as a safer default with a config override.
2. **Reshape depth**: Should we reshape to 65% of new budget or 50%? 65% leaves more room for L3/L4 context slots. 50% is more conservative.
3. **Cross-session persistence**: If an agent restarts on the smaller model, the Redis model state may have expired. The bootstrap warm path should write an initial model state entry after warm completes.
