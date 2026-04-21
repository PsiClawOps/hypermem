# HyperMem Roadmap Resequencing — 2026-04-21

**Status:** Approved planning update
**Owner:** Forge
**Integrates:**
- `specs/ADAPTIVE_CONTEXT_LIFECYCLE_0.9.0.md`
- `specs/COMPOSITION_SNAPSHOT_WARM_RESTORE_PLAN.md`
- Forge near-term plan from 2026-04-16
- Vanguard context-engineering review from 2026-04-21

## Why this reorder exists

We have 3 overlapping streams:

1. near-term compositor and trim stabilization
2. Vanguard's context-engineering corrections
3. the 0.9.0 adaptive context lifecycle work

The old ordering treated reranking as shipped, prompt ordering as a later refinement, and proactive compaction as a standalone follow-on. The current code reality is different:

- the reranker exists but is not wired into `hybridSearch()`
- the retrieval-to-prompt path still has stability debt
- 0.9.0 adaptive warming and compaction should not land on top of unstable trim ownership or soft slot boundaries

This document is the current sequencing source of truth.

## Core decisions

### 1. Wire the existing reranker now

This is a pre-0.9.0 hotfix, not future roadmap work.

Reason:
- `src/reranker.ts` is already built
- config already exists in real installs
- current retrieval precision is lower than intended because the reranker is inert
- blast radius is low because fallback behavior is already graceful

Scope:
- export and wire `createReranker()` into `hybridSearch()` after RRF fusion
- add basic telemetry for provider, candidate count, rerank applied vs bypassed
- document the actual integration status in repo docs

### 2. Finish stability before adaptive lifecycle work

The next block after reranker is still the Phase A stability block:
- duplicate compose elimination
- single trim owner
- afterTurn to next-turn steady-state fix
- tighter pre-compose history depth

Add one more item to that foundation block:
- **pressure accounting unification** moves up before 0.9.0 work because adaptive bands need one trustworthy pressure signal

### 3. Add diagnostics before prompt reordering

Vanguard is right about query-relevant material landing too deep in the prompt, but we should not reorder slots blind.

Before changing slot order, add:
- per-slot token spans
- prefix hash logging
- query-relevant tail start/end telemetry
- rerank applied/bypassed telemetry
- eligible-for-compaction counts in maintenance logs

This gives us before/after measurement instead of architecture vibes.

### 4. Reorder query-shaped content before user turn, but keep the stable prefix conservative at first

After diagnostics land, reorder prompt assembly so query-shaped material sits nearest the user turn.

Initial rule:
- keep `system`, identity, output profile, stable facts, knowledge, and preferences in the stable prefix
- move active facts, temporal context, open-domain context, semantic recall, and doc chunks toward the tail
- do **not** move knowledge or preferences out of the stable prefix yet just to chase OpenAI prefix caching

OpenAI cache work stays diagnostic-first.

### 5. Fold proactive compaction into 0.9.0 adaptive bands, not as a separate trim brain

Vanguard's proactive compaction point is real, but we should not bolt on a separate trigger before the adaptive lifecycle work lands.

Decision:
- instrument eligible message counts now
- ship any proactive compaction threshold as part of the 0.9.0 adaptive trim/compaction work
- keep one coherent compaction policy instead of competing heuristics

### 6. Delay composition snapshot warm restore until slot contracts stabilize

The composition-snapshot restore plan remains important, but it moves **after** the slot boundary and adaptive lifecycle work.

Reason:
- restore snapshots are only as good as the slot contract they capture
- capturing unstable prompt shapes now would preserve the wrong thing very efficiently

## New execution order

## Block 0 — Immediate hotfix

### 0.1 Reranker integration
- wire existing reranker into `hybridSearch()`
- preserve RRF-only fallback on any reranker failure
- add rerank telemetry and tests
- update docs to match reality

**Target:** next ship window

## Block 1 — Foundation stability

### 1.1 Eliminate duplicate compose per turn
### 1.2 Consolidate trim ownership to one steady-state owner
### 1.3 Close afterTurn to next-turn rescue-trim loop
### 1.4 Tighten pre-compose history depth
### 1.5 Unify pressure accounting

**Why first:** 0.9.0 adaptive warming and prompt-order changes are not safe on top of churny compose/trim behavior.

## Block 2 — Observability for context engineering

### 2.1 Add slot-span diagnostics
### 2.2 Log prefix hash stability
### 2.3 Log rerank applied/bypassed and candidate counts
### 2.4 Log compaction eligibility counts and ratios

**Why here:** this is the measurement layer needed before prompt reordering, OpenAI cache tuning, or compaction-threshold tuning.

## Block 3 — Prompt placement and stable boundary fixes

### 3.1 Reorder query-shaped context toward the prompt tail
### 3.2 Keep stable prefix conservative in v1 of the reorder
### 3.3 Validate cache-boundary behavior after reorder

This block absorbs Vanguard's lost-in-the-middle recommendation.

## Block 4 — Budget lanes and provider-aware cache tuning

### 4.1 Explicit compositor budget lanes
### 4.2 Model-aware budgeting
### 4.3 OpenAI prefix-cache diagnostics
### 4.4 Only then decide whether stable-prefix content should move

This keeps OpenAI-specific optimization behind provider-agnostic prompt-quality work.

## Block 5 — Correctness guards

### 5.1 Tool result guardrails
### 5.2 Oversized artifact degradation
### 5.3 Replay recovery isolation

Pressure accounting moved earlier into Block 1 because later phases depend on it.

## Block 6 — HyperMem 0.9.0 adaptive context lifecycle

Land the 0.9.0 spec after Blocks 1 through 4 establish a stable base.

### 6.1 Tiered warming
### 6.2 Smart-recall surge
### 6.3 Adaptive trim and compaction bands
### 6.4 Proactive compaction trigger, if telemetry supports it
### 6.5 0.9.0 telemetry and tuning pass

**Important 0.9.0 update:**
- reranker integration is no longer a 0.9.0 item, it is a pre-0.9.0 hotfix
- proactive compaction is part of adaptive bands, not a separate earlier phase

## Block 7 — Composition snapshot warm restore

Ship after slot contracts, stable boundaries, and adaptive lifecycle behavior are settled.

Reason:
- snapshot restore should capture the mature compositor shape, not an in-flight architecture

## Release framing

### Pre-0.9.0
- reranker hotfix
- stability block
- diagnostics
- prompt-order and lane work needed to make the compositor trustworthy

### 0.9.0
- adaptive warming
- smart-recall surge
- adaptive compaction bands
- thresholded proactive compaction if telemetry justifies it

### Post-0.9.0
- composition snapshot warm restore
- later DAG-aware path selection and reintegration work

## What changed from the prior order

1. **Reranker moved forward** from "already shipped" to immediate hotfix.
2. **Pressure accounting moved earlier** because 0.9.0 depends on it.
3. **Prompt reordering moved ahead of OpenAI cache tuning** because it improves all providers.
4. **OpenAI cache work became diagnostic-first** instead of boundary surgery first.
5. **Proactive compaction moved inside 0.9.0 adaptive bands** instead of shipping as a standalone trigger.
6. **Composition snapshot restore moved later** until slot contracts stabilize.

## Decision summary

If we only do one thing immediately, wire the reranker.

If we care about not building 0.9.0 on quicksand, the mandatory order is:

1. reranker
2. stability
3. diagnostics
4. prompt order and boundary fixes
5. lanes and model-aware budgeting
6. 0.9.0 adaptive lifecycle
7. warm restore
