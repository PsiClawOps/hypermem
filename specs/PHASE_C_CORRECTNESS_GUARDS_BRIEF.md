# HyperMem Phase C Brief — Correctness Guards

**Project:** HyperMem
**Root:** `/home/lumadmin/.openclaw/workspace/repo/hypermem`
**Status:** Ready to start after Phase A and Phase B closeout
**Supersedes:** the Phase C section in `/home/lumadmin/.openclaw/workspace-council/forge/specs/HYPERMEM_PLAN_2026-04-16.md`

## Current baseline

Completed before this phase:
- **Phase A** complete at `69aae30`
- **Phase B1 + B2** landed at `f9364a5`
- **Phase B3** landed at `b9b0c68`
- **Phase B4** landed at `1e07a82`

That means trim ownership, stable-prefix boundaries, batch trim, and model-aware budgeting are all in place. Phase C should harden the degradation paths without reintroducing churn or volatility above the prefix boundary.

## What A and B taught us

1. **Structure beats rescue logic.** Correctness needs explicit contracts, not more cleanup heuristics.
2. **The stable prefix is sacred.** Anything degradation-related stays below the boundary unless it is truly stable.
3. **One owner per invariant.** Tool-chain ejection, pressure truth, and replay state each need a single decision point.
4. **Model-aware means threshold-aware.** Artifact and stub budgets must scale with effective budget, not a fixed token cutoff.
5. **Headroom matters.** Do not degrade content right up to the ceiling and recreate trim churn under a new name.
6. **Observability has to ship with behavior.** Counters, reason codes, and anomalies are part of the feature.
7. **The seams are where bugs live.** Golden fixtures must cover plugin ↔ compositor ↔ runtime boundaries, not only helpers.

## Revised phase shape

Before C1, add a short mandatory preflight. Call it **C0**.

### C0 — Preflight contracts and fixtures

#### C0.1. Unify budget policy constants

**Goal:** remove duplicated budget constants and make Phase C consume one canonical policy source.

Required work:
- centralize the soft-target, trigger-growth, and headroom values used by trim and compose paths
- eliminate the separate `0.65` soft-target definitions that can drift between gradient refresh and trim logic
- expose the canonical values in diagnostics/test helpers so regression fixtures can assert against one source of truth

Likely files:
- `plugin/src/index.ts`
- `src/compositor.ts`
- `src/types.ts`
- optional new shared policy module if that reduces drift instead of spreading it

Acceptance:
- one canonical source for budget policy values
- no duplicated trim/gradient target constants left in hot paths

#### C0.2. Define canonical degradation contracts

**Goal:** make every degraded output shape explicit before implementing correctness guards.

Required work:
- define a bounded stub shape for ejected tool-result chains
- define a bounded reference shape for oversized artifacts
- define a bounded replay marker for post-restart recovery mode
- define a small reason enum or equivalent typed surface for degradation decisions
- keep all degradation outputs in the volatile region by default

Canonical shapes to adopt or refine:
- tool-chain stub: `[tool:<name> id=<id> status=ejected reason=<reason> summary=<stub>]`
- artifact reference: `[artifact:<id> path=<path> size=<tokens> status=degraded fetch=<hint>]`
- replay marker: `[replay state=<state> status=bounded summary=<stub>]`

Likely files:
- `src/types.ts`
- `src/compositor.ts`
- optional new `src/degradation.ts` or equivalent shared helper

Acceptance:
- one reviewed format per degradation class
- one canonical reason surface used by telemetry and tests

#### C0.3. Build golden fixtures first

**Goal:** test the seam before modifying runtime behavior.

Required fixtures:
1. tool-use + tool-result dependency chain with ejection cases
2. oversized artifact retrieval case with bounded reference fallback
3. post-restart replay case with explicit enter/exit expectations
4. optional pressure-accounting mismatch fixture if it helps C3 land safely

Acceptance:
- fixtures exist before C1 implementation starts
- fixtures are reusable across C1, C2, C3, and C4 instead of one-off test data

---

### C1 — Tool result guards

**Revised contract:**
- tool-chain dependency handling lives in one ejection path
- on tool-use ejection, dependent tool-results are either co-ejected or replaced with the canonical stub
- emit structured reason/counter telemetry for co-eject vs stub cases
- never let orphaned tool-results survive above the stable-prefix boundary

Primary files:
- `src/compositor.ts`
- `test/tool-result-guards.mjs`
- golden fixture set from C0.3

### C2 — Oversized artifact handling

**Revised contract:**
- artifact degradation threshold scales with effective model budget from B4, not a single hard cutoff
- degraded artifact references must preserve headroom instead of filling the lane to the ceiling
- artifact references use the canonical reference shape from C0.2
- oversized artifacts become fetchable references, not raw ballast in volatile history

Primary files:
- `src/compositor.ts`
- `src/retrieval.ts`
- fixture coverage from C0.3

### C3 — Pressure accounting unification

**Revised contract:**
- the composed message array about to ship is the only authoritative pressure source
- mismatches between runtime history, hot cache, and composed-array truth are telemetry anomalies, not trim triggers
- anomaly codes should use the same reason surface introduced in C0.2 where it fits

Primary files:
- `plugin/src/index.ts`
- `src/compositor.ts`

### C4 — Isolate JSONL replay recovery

**Revised contract:**
- replay recovery is an explicit bounded mode with clear enter and exit criteria
- normal per-turn paths do not carry replay heuristics after the first successful stabilization turn
- replay artifacts use the canonical replay marker from C0.2 where prompt-visible representation is needed

Primary files:
- `plugin/src/index.ts`
- optional `src/replay-recovery.ts`

## Execution order

1. **C0.1** unify budget constants
2. **C0.2** lock degradation formats and reason codes
3. **C0.3** land golden fixtures
4. **C1** tool result guards
5. **C2** oversized artifact handling
6. **C3** pressure accounting unification
7. **C4** replay recovery isolation

## Phase acceptance criteria

Phase C is complete when:
- no orphaned tool-results survive composition
- oversized artifacts degrade to bounded references instead of flooding history
- composed-array pressure is the only trim/accounting authority
- replay recovery is visibly bounded and exits cleanly
- all degradation paths emit structured, testable telemetry
- none of the above reintroduce prefix churn or split trim ownership

## Release relevance

A clean Phase C is the difference between “better compositor internals” and “release-worthy prompt-path behavior.”

For `0.8.0`, Phase C should be treated as correctness hardening, not optional polish.
