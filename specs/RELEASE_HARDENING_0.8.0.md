# HyperMem 0.8.0 Release Hardening Plan

**Project:** HyperMem  
**Root:** `/home/lumadmin/.openclaw/workspace/repo/hypermem`  
**Author:** Forge  
**Date:** 2026-04-17  
**Updated:** 2026-04-18 (track 4 moved to 0.8.2; track 3 closed; temporal screen added)

## Status snapshot (2026-04-18)

- Track 1 production-path verification — **Done.** Prompt-path verification harness landed (`9411a8a`). Full Phase C correctness cluster landed (`7795afd` → `d31eef1`). Unified pressure accounting, B4 model-aware budgeting, oversized artifact degradation, budget cluster drop telemetry, replay recovery isolation, canonical degradation fixtures all merged.
- Track 2 startup completeness — **Done.** Fleet seeding on startup landed (`bb66cb7`).
- Track 3 fact contradiction handling — **Done.** Tiered contradiction resolution policy landed (`37fa1b5`, schema v19). Supersede/invalidateFact/log-only tiers active. Background indexer records audits.
- Track 3 follow-up: dreaming promoter temporal-marker screen — **In this release.** Blocks durable promotion of time-bound facts lacking `validFrom`/`invalidAt` metadata. Adds `docs/MEMORY_MD_AUTHORING.md` static-vs-dynamic contract section and `test/dreaming-promoter-temporal.mjs`.
- Track 4 council/bootstrap weight reduction — **Moved to 0.8.2.** See 0.8.2 shelf below.
- Tool-artifact store (adjacent work) — **Done.** Durable tool result storage for wave-guard (`8b2e7e2`), Sprint 2.1 active-turn hydration (`4327aac`), Sprint 2.2 retention sweep + sensitive-artifact flag (`08b9192`).

## Remaining for 0.8.0 packaging

After the temporal-screen PR lands, the remaining work is release packaging, not HyperMem feature work:

1. Bump `package.json` from `0.7.0` to `0.8.0`
2. Write `CHANGELOG.md` entry for 0.8.0 (verify, seed, supersede, screen)
3. Capture one real gateway verification run into `docs/RELEASE_0.8.0_VERIFICATION.md`
4. Run the publication pipeline: internal repo → public repo sync (currently manual per WQ-20260412-001)
5. Cut git tag `v0.8.0` on public repo
6. Publish release notes

## 0.8.2 shelf (deferred from this release)

- **Track 4 council/bootstrap weight reduction** — governance-doc seed pass, trigger-based demand loading for `JOB.md`/`MOTIVATIONS.md`/`WORKQUEUE.md`, archive oversized historical council transcripts.
- **Enhanced dreaming features** — expose `plugins.entries.hypermem.config.dreaming` knob, one-seat opt-in rollout with telemetry, human review cycle before fleet-wide enable.
- **Contradiction-aware decay** (`docs/ROADMAP.md`) — accelerated decay for superseded facts, sibling to V19 tiered resolution.
- **Cache-aware prompt boundary tracking** (`WQ-20260411-001`) — stable-prefix/dynamic-suffix compositor pattern, sticky latches, cache-hit optimization.
- **Benchmark harnesses** (WQ-BENCH-001/002/003) — LongMemEval, LOCOMO, BEAM. Pylon-owned.
- **Obsidian Vault integration** (`WQ-20260406-002`) — re-targeted from stale 0.5.0 tag.

## 0.9.0 shelf (scale work)

- **Phase 5 storage/performance** from `TURN_DAG_MIGRATION_SPEC.md`: content-addressed blob store, zstd compression, cached token estimates, GC, active-only FTS index maintenance, optional SQL FTS promotion.
- **MCP Server Wrapper** (`WQ-20260406-001`) — third-party interface layer. Blocked on Sentinel auth review.

## Goal

Ship `0.8.0` with hard proof that the prompt path is correct under load, restart, and degraded-session pressure.

This is not a feature grab. The next work should close release risk in this order:

1. verify the current Phase C behavior in real gateway flow
2. close the missing startup and integration gaps
3. tighten fact correctness
4. reduce council/bootstrap weight only after the prompt path is proven stable

## Current baseline

Already landed on `main`:

- `7795afd` feat(phase-c): add c1 tool result guards
- `49b9936` feat(phase-c): add budget cluster drop telemetry
- `59488e1` feat(phase-c): add oversized artifact degradation
- `3aeefe1` feat(phase-c): unify pressure accounting
- `d31eef1` feat(phase-c): isolate replay recovery mode

That means the immediate risk is no longer missing guard code. The immediate risk is lack of production-proof verification around those guards.

## Release tracks

### Track 1, production-path verification

**Why first:** if `assemble()` is not firing correctly in real gateway flow, every later optimization is theater.

**Deliverables**
- compose-path verification checklist for a live gateway session
- structured telemetry that proves which degradation path fired, with session-safe counters
- one reproducible manual verification run captured in repo docs

**Primary files**
- `plugin/src/index.ts`
- `src/compositor.ts`
- `src/types.ts`
- `test/`
- `docs/` or `specs/`

**Expected commit slices**
- `test(release): add gateway compose-path verification harness`
- `feat(telemetry): expose phase-c degradation counters`
- `docs(release): capture 0.8.0 verification procedure`

**Exit criteria**
- one real session proves composed history, degradation, and replay recovery are entering the model path
- telemetry distinguishes normal compose, ejected tool-chain, oversized artifact reference, and replay recovery mode
- no prompt-visible degradation shape differs from the canonical Phase C contract

### Track 2, startup completeness

**Why second:** `fleet_agents` and related registry state should not depend on every agent having already booted after deploy.

**Deliverables**
- startup sweep seeds missing fleet agents from known workspace identity files or registry inputs
- idempotent behavior on repeated startup
- tests for cold-start fleet population

**Primary files**
- `src/index.ts`
- `src/library-db.ts`
- `src/system-registry.ts`
- `test/`

**Expected commit slices**
- `feat(registry): seed fleet agents on startup`
- `test(registry): cover cold-start fleet seeding`

**Exit criteria**
- a clean boot on a fresh or partially seeded install produces complete fleet rows without waiting for agent bootstrap
- repeated boot does not duplicate or churn rows

### Track 3, fact contradiction handling

**Why third:** if facts can contradict without linkage, recall quality degrades silently and council memory splits.

**Deliverables**
- contradiction check during fact ingest
- `superseded_by` wiring for replaced facts
- tests for same-domain contradiction and non-contradictory coexistence

**Primary files**
- `src/background-indexer.ts`
- `src/fact-store.ts`
- `src/types.ts`
- `test/`

**Expected commit slices**
- `feat(facts): link superseded facts during ingest`
- `test(facts): cover contradiction and supersede paths`

**Exit criteria**
- a newer canonical fact can demote or supersede an older one in the same domain
- retrieval prefers the live fact chain without surfacing stale siblings first

### Track 4, council/bootstrap weight reduction

**Why after verification:** slimming context before verification makes diagnosis harder. Prove the engine first, then cut token ballast.

**Deliverables**
- governance-doc seed pass into HyperMem storage
- trigger-based retrieval for `JOB.md`, `MOTIVATIONS.md`, and `WORKQUEUE.md`
- archive or exclude large historical one-off files from hot prompt composition

**Primary files**
- `src/doc-chunker.ts`
- `src/retrieval.ts`
- `src/compositor.ts`
- `specs/`
- supporting workspace governance docs after approval

**Expected commit slices**
- `feat(seed): ingest governance docs for retrieval`
- `feat(triggers): demand-load governance and workqueue docs`
- `chore(context): archive oversized historical council transcript`

**Exit criteria**
- council sessions stop paying always-on cost for low-frequency governance docs
- the same docs remain retrievable on demand from HyperMem
- prompt footprint drops without losing operational guidance when the topic actually calls for it

## Recommended execution order

### Sprint 1, prove the path
1. Track 1 verification harness
2. Track 1 telemetry
3. Track 2 startup seeding

### Sprint 2, tighten correctness
1. Track 3 supersedes handling
2. Track 1 final release verification pass on fresh gateway state

### Sprint 3, trim weight safely
1. Track 4 governance doc seeding
2. Track 4 trigger-based demand loading
3. archive oversized historical hot-context files

## Release gate for `0.8.0`

Do not call `0.8.0` release-ready until all of these are true:

- Phase C behavior is proven in a real gateway session, not just unit fixtures
- cold-start fleet seeding is automatic and idempotent
- contradiction handling writes `superseded_by` chains correctly via the V19 tiered policy
- dreaming promoter temporal-marker screen blocks time-bound facts without recency metadata (Track 3 follow-up)
- static-vs-dynamic `MEMORY.md` contract is documented in `docs/MEMORY_MD_AUTHORING.md`
- `CHANGELOG.md` entry and release notes describe the hardening guarantees plainly
- public repo is in sync with internal (manual sync until CI pipeline in `WQ-20260412-001` lands)

**Explicitly deferred from the 0.8.0 gate:** Track 4 council/bootstrap weight reduction. Moved to 0.8.2. See shelf above.

## What not to do next

- do not start benchmark vanity work before the prompt path is proven live
- do not start memory-core deprecation before contradiction handling is in place
- do not cut bootstrap context aggressively before telemetry makes regressions obvious
- do not stack new retrieval features on top of unverified release-path behavior

## Short version

Next for HyperMem is: **verify, seed, supersede, then slim.**
