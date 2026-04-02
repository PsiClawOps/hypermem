# HyperMem Stabilization Plan — 2026-04-02

**Authors:** Forge + Pylon  
**Status:** IN PROGRESS  
**Based on:** Pylon's HYPERMEM_IMPLEMENTATION_REVIEW_2026-04-02.md + HYPERMEM_QUEUE_SPLIT.md + Compass review

---

## Context

Pylon's review confirmed: HyperMem has the right architecture direction but the main failure chain is not fully fixed. The repo has landed real fixes (Incidents 1, 2, 4), but the five-part stabilization needed to make the system trustworthy in production is not done.

This plan defines what gets implemented right now, by whom, in what order.

---

## P0 Stabilizers — All blocking ACA offload and doc ingestion

### P0.1 — Prompt/query contract [Forge]
**File:** `src/types.ts`, `src/compositor.ts`

Add `prompt?: string` to core `ComposeRequest`. Use it as the retrieval query for:
- semantic recall (`buildSemanticRecall`)
- doc chunk trigger matching
- cross-session context query

Pattern: `const retrievalQuery = request.prompt?.trim() || this.getLastUserMessage(messages) || '';`

Both semantic recall and doc chunk paths currently use `getLastUserMessage(messages)` which is one-turn stale because it reads from the in-context messages array, not the live prompt. This is a correctness bug on every turn.

**Status:** ✅ DONE (this sprint)

---

### P0.2 — Redis getHistory() limit bypass [Pylon]
**File:** `src/redis.ts`, `src/compositor.ts`

Add `limit?: number` to `RedisLayer.getHistory()`. Use `LRANGE -limit -1` when limit is provided.
Pass limit through from `Compositor.getHistory()` to the Redis call.

This makes `historyDepth: 150` in the plugin actually constrain the Redis path, not just the SQLite fallback.

**Status:** ✅ DONE (this sprint)

---

### P0.3 — Bootstrap idempotency guard [Pylon]
**File:** `src/redis.ts`, `plugin/src/index.ts`

Add `RedisLayer.sessionExists()` — single `EXISTS hm:{a}:{s}:history` call.
In `plugin/bootstrap()`, early-return if session is already warm in Redis.

This eliminates the per-turn lane lock and directly fixes the followup queue drain blockage.

**Status:** ✅ DONE (this sprint)

---

### P0.4 — Tail-check dedup in pushHistory() + compose() dedup [Pylon]
**File:** `src/redis.ts`, `src/compositor.ts`

`pushHistory()`: check last entry's `id` before appending. Skip messages with `id <= lastStored.id`.
`compose()`: deduplicate history array by `id` before budget assembly (second line of defense).

This addresses the immediate warm-duplication issue without requiring the full window split.

**Status:** ✅ DONE (this sprint)

---

### P0.5 — Separate bootstrap warm cap from maxHistoryMessages [Forge]
**File:** `src/compositor.ts`

Add `WARM_BOOTSTRAP_CAP = 250` constant. Use it in `warmSession()` instead of `this.config.maxHistoryMessages`.

Cold-start bootstrap should seed a reasonable context window (250 msgs), not the entire 1000-message archive. The full archive remains in SQLite for deep retrieval.

**Status:** ✅ DONE (this sprint)

---

## P1 — Follow-on (do after P0 is green and tested)

### P1.1 — Real window split (HYPERMEM_QUEUE_SPLIT.md Parts 2–4)
- `RedisLayer`: add `getWindow/setWindow/invalidateWindow`
- Compositor writes assembled output to window slot after compose()
- Plugin checks window cache first in assemble()
- afterTurn ingest invalidates window after new messages
- Remove `safeHistoryDepth = 150` band-aid ONLY after Gate 1 validation test passes

### P1.2 — Cursor tracking (HYPERMEM_QUEUE_SPLIT.md Part 5)
- Add `SessionCursor` type to `src/types.ts`
- RedisLayer: `setCursor/getCursor`
- Compositor: write cursor after window assembly
- Background indexer: use cursor as high-signal mining boundary
- Durability: dual-write cursor to SQLite (Compass Gate 2)

### P1.3 — Test hardening
- Integration test: `historyDepth: N` constrains hot Redis sessions
- Integration test: repeated bootstrap on warm session is a no-op
- Integration test: repeated warm() doesn't grow Redis history
- Integration test: prompt-aware retrieval works before prompt is in history
- Plugin build in CI — root tests green + plugin typecheck red = false-green state

### P1.4 — Docs update
- `ARCHITECTURE.md`: split into explicit CURRENT vs PLANNED sections
- List only implemented invariants under CURRENT
- Correct Incident 3 status (message-store.ts still uses direct join)
- Update Incident 6 status (partially improved, sender/session still missing)

### P1.5 — Plugin type unification
- Remove duplicate type shims in `plugin/src/index.ts`
- Import types from HyperMem core instead of re-declaring
- This is what caused the `historyDepth` / `prompt` drift in the first place

---

## Validation Gates (per Compass review)

### Gate 1 — Before removing safeHistoryDepth = 150
Integration test in test/compositor:
1. Seed warm agent with 500-message Redis history
2. Call compose() with historyDepth: 150
3. Assert: returned message count ≤ 150
4. Assert: no provider submission exceeds context budget

DO NOT remove band-aid until this test is green.

### Gate 2 — Before cursor integrates with indexer (P1.2)
Cursor must be durable across Redis eviction.
Option A: cursor TTL = history TTL (24h)
Option B (preferred): dual-write cursor to SQLite messages.db

### Gate 3 — Before Step 3 doc chunk ingestion
Audit `defaultOrgRegistry()` in `src/cross-agent.ts` for all current fleet agents.
Plane, Vigil, Crucible (added post-2026-03-25) are at risk.
Owner: Gauge or Pylon.

---

## Work Split

| Item | Owner | Status |
|---|---|---|
| P0.1 — prompt/query contract | Forge | Done |
| P0.2 — Redis getHistory() limit | Pylon | Done |
| P0.3 — Bootstrap idempotency | Pylon | Done |
| P0.4 — pushHistory dedup + compose dedup | Pylon | Done |
| P0.5 — Bootstrap warm cap (250) | Forge | Done |
| P1.x — Window split, cursor, tests, docs | Forge + Pylon | Next sprint |

---

## What Is NOT In Scope (yet)

- ACA offload phases 3–5
- More governance stub replacement  
- More retrieval-dependent architecture claims

These are blocked until P0 is verified in production.
