# HyperMem 0.8.0 Release Hardening Plan

**Project:** HyperMem  
**Root:** `/home/lumadmin/.openclaw/workspace/repo/hypermem`  
**Author:** Forge  
**Date:** 2026-04-17

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
- contradiction handling writes `superseded_by` chains correctly
- council doc demand-loading is working for at least one real seat without prompt regressions
- README and release notes describe the new hardening guarantees plainly

## What not to do next

- do not start benchmark vanity work before the prompt path is proven live
- do not start memory-core deprecation before contradiction handling is in place
- do not cut bootstrap context aggressively before telemetry makes regressions obvious
- do not stack new retrieval features on top of unverified release-path behavior

## Short version

Next for HyperMem is: **verify, seed, supersede, then slim.**
