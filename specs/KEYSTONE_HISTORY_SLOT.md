# hypermem — Keystone History Slot (Phase 2)

**Status:** Spec  
**Author:** Forge  
**Date:** 2026-04-02  
**Depends on:** `TOOL_GRADIENT_COMPOSITOR.md` (Phase 1, shipped `a5f8a49`)

---

## Problem

The current budget-fit pass fills the history slot newest-first. Age is used as a proxy for relevance. This is wrong in a predictable way:

- A founding decision from 80 turns ago ("the warm path should never re-emit seeded messages") is worth more than 20 recent turns of implementation churn
- A one-off question/acknowledgment exchange from 3 turns ago is worth less than a keystone constraint established earlier
- Sliding-window context means the model loses institutional memory of the session as the conversation grows — exactly when it most needs it

**Age is a bad proxy for value. Reference density is a better one.**

---

## Design

### Core Principle

Messages that are referenced again later in the conversation have proven relevance. Score messages by how much of their signal is echoed in subsequent turns, then fill the keystone slot with high-scorers regardless of age.

---

## Full Budget Slot Order

Priority high → low. Each slot is filled in order; remainder passed to next slot.

| Priority | Slot | Description | Status |
|---|---|---|---|
| 1 | System + Identity | SOUL.md, IDENTITY.md anchors. Never truncated. | Existing |
| 2 | Tripwires (ACA) | Keyword-triggered governance/policy/charter injections | Existing |
| 3 | Facts / Knowledge / Preferences | L4 library structured memory | Existing |
| 4 | Semantic recall | L3 vector search results, per-turn relevance | Existing |
| 5 | **Keystone history** | High reference-density messages, age-independent | **New** |
| 6 | Recent history verbatim | Last N full turns (text + tool verbatim) | Existing |
| 7 | Tool calls verbatim | Last 3 tool pairs, full payload | Existing (Phase 1) |
| 8 | Tool calls prose stubs | Next 10 tool pairs as heuristic sentences | Existing (Phase 1) |
| 9 | History text-only | Older turns, tool payload dropped, text kept | Existing (Phase 1) |
| 10 | Cross-session context | Other active agent sessions | Existing, lowest priority |

---

## Keystone Scoring

### Signal axes

**1. Reference density** (primary)  
Count entity overlap between a candidate message and the most recent R turns (default R=20). Entities include:
- File paths (`/src/foo.ts`, `specs/BAR.md`)
- Named identifiers (function names, agent names, config keys)
- Decision keywords: "never", "always", "requirement", "constraint", "must", "should not", "the rule is"
- Topic anchors: proper nouns, capitalized concepts that recur

Score = `overlapping_entities / total_entities_in_candidate` (Jaccard-like, capped at 1.0)

**2. Decisional weight** (multiplier)  
Cheap heuristic pass over text content. Presence of decision markers boosts score:
- `+0.3` for declarative constraint language ("never", "always", "must", "the rule is", "requirement")
- `+0.2` for architectural terms ("architecture", "design", "spec", "pattern")
- `-0.2` for pure acknowledgment patterns ("got it", "sounds good", "ok", "👍" with no other content)
- `-0.1` for question-only messages (ends with `?`, no declarative content)

**3. Recency** (tiebreaker only)  
Among equal-scoring messages, prefer newer. Age does not reduce score for high-density messages.

### Final score

```
keystoneScore(msg) = referenceDensity(msg) * (1.0 + decisionalWeight(msg))
```

Scores range 0.0–1.3. Threshold for keystone inclusion: `>= 0.4` (configurable: `keystoneScoreThreshold`).

---

## Implementation

### New function: `scoreKeystoneMessages`

```ts
function scoreKeystoneMessages(
  messages: NeutralMessage[],
  recentWindow: number = 20
): Array<{ msg: NeutralMessage; score: number; index: number }>
```

- Extracts entity set from each candidate message
- Extracts entity set from union of last `recentWindow` messages
- Computes reference density + decisional weight
- Returns scored list sorted by score descending
- Pure function, no side effects

### New function: `extractEntities`

```ts
function extractEntities(text: string): Set<string>
```

Lightweight extraction — no NLP model, no external calls:
- File paths: `/\/?[\w.-]+\/[\w./-]+/g`
- Quoted identifiers: backtick or single-quote wrapped tokens
- Decision markers: keyword list match
- Capitalized multi-word phrases (≥2 words, each capitalized, not sentence-start)
- Recurrent proper nouns (appears ≥2 times in message)

Fast enough to run on 1000 messages synchronously. No async required.

### Pipeline integration

```
// After applyToolGradient(), before budget-fit pass:

recentWindow = messages.slice(-20)
candidates = messages.slice(0, -recentWindowSize)  // everything older than recent window

scored = scoreKeystoneMessages(candidates, recentWindow)
keystones = scored
  .filter(s => s.score >= config.keystoneScoreThreshold ?? 0.4)
  .slice(0, config.maxKeystoneMessages ?? 15)  // cap to prevent slot bloat

// Budget allocation:
// keystoneTokenBudget = remaining * keystoneBudgetFraction (default 0.25)
// Fill keystone slot from scored list until keystoneTokenBudget exhausted
// Remaining budget passed to recent history slot as before
```

### Deduplication

Keystone messages are removed from the history pool before the recent-history and text-only passes. A message cannot appear twice — once as a keystone and again as a regular history entry.

---

## Configuration Changes

New fields on `CompositorConfig`:

```ts
/** Minimum keystone score for inclusion (0.0–1.3). Default: 0.4 */
keystoneScoreThreshold?: number;

/** Max messages in keystone slot. Default: 15 */
maxKeystoneMessages?: number;

/** Fraction of remaining budget allocated to keystone slot. Default: 0.25 */
keystoneBudgetFraction?: number;

/** How many recent turns to use as reference window for scoring. Default: 20 */
keystoneReferenceWindow?: number;
```

---

## What This Fixes

| Problem | Fix |
|---|---|
| Founding decisions lost as session grows | Keystone slot preserves high-density messages regardless of age |
| Sliding window loses institutional memory | Reference-scored messages persist even when recent churn would otherwise push them out |
| Age used as proxy for relevance | Replaced with reference density — proven relevance |
| Acknowledgments and filler wasting budget | Decisional weight penalty drops them below threshold |

---

## What This Does Not Do

- **No model calls** — scoring is pure text heuristics, sub-millisecond per message
- **No schema changes** — scores are computed at compose time, not stored
- **No summarization** — keystone messages are included verbatim (or prose-stubbed if tool-heavy), never rewritten
- **No cross-session scoring** — only scores within the current session's history

---

## Non-Goals / Future

- Cross-session keystone retrieval (pull founding decisions from previous sessions via L3 vector search — already handled by semantic recall slot)
- Model-based importance scoring (future; current heuristic is sufficient for Phase 2)
- Persistent score storage (compute-on-assemble is fast enough; caching is premature optimization)

---

## Test Cases

- Message from turn 5 containing `/src/compositor.ts` scores high when turns 80-100 also reference that path
- Pure acknowledgment ("sounds good, let's do it") scores low and is excluded
- Decision message ("the warm path must never re-emit seeded messages") scores high via decisional weight even with low entity overlap
- Keystone message is not duplicated in regular history pass
- Budget cap respected — keystone slot never exceeds `keystoneBudgetFraction` of remaining
- Empty candidate set (short sessions) — graceful no-op, no keystone slot injected
