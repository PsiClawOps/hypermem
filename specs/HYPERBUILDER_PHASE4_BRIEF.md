# HyperBuilder Task Brief — Turn DAG Phase 4: Archived Mining Separation

**Project:** HyperMem
**Root:** `/home/lumadmin/.openclaw/workspace/repo/hypermem`
**Phase:** 4 of 5 (Turn DAG Migration)
**Spec:** `specs/TURN_DAG_MIGRATION_SPEC.md`
**Priority:** P0
**Status:** Sprint 2 complete, closeout captured, Sprint 3 ready

## Execution Contract

- **Required HyperBuilder configuration:** `turn-dag-phase4-full-fleet`
- **Pipeline profile:** Full PGE, Canonical Spec v1.1
- **Mandatory stage roles:** planner, generator, build-evaluator, security-evaluator, finding-verifier, cross-validator, integrator
- **Required evaluation lanes:** build, security, finding verification, cross-validation, integration review
- **Allowed override path:** only `ragesaq`, explicit per-run approval, plus artifact update naming the replacement configuration

No ad hoc implementation is allowed for this phase.

## Objective

Separate live composition from archived mining so HyperMem has two clean operating modes:
- **composition:** active branch only
- **mining / operator inspection:** archived contexts only when explicitly requested

Phase 4 is where archived history stops being a side effect and becomes an intentional surface.

## Prior Work

Already shipped:
- Phase 0: fence enforcement on live read paths
- Phase 1: context heads
- Phase 2: DAG-capable writes
- Phase 3: DAG-native active-branch reads
- Phase B2: stable-prefix cache signal propagation

Do not redo those phases. Build on them.

## Scope

### In scope
1. Explicit context lifecycle handling for `active`, `archived`, and `forked`
2. Archived-context store APIs for listing, loading, and inspecting archived chains
3. Archived mining entry points that are separate from standard composition paths
4. Tests proving standard composition stays active-only while mining can intentionally inspect archived contexts
5. Operator-safe surfaces that label archived results as historical

### Out of scope
- New storage engine work
- Blob dedup or compression
- Live composition broadening to archived branches
- Unscoped global mining paths
- Phase 5 optimizations

## Sprint plan

### Sprint 1
**Archived context surface and inspection primitives**
- extend `context-store.ts` with explicit archived / forked lookup helpers
- add archived-chain read helpers in `message-store.ts`
- export the new surface through `src/index.ts`
- add tests for archive visibility, fork lineage, and archived chain inspection

### Sprint 2
**Explicit mining APIs**
- add mining-only query surfaces that require explicit archived context selection
- keep composition APIs active-only
- label archived results as historical in returned metadata
- add regression coverage proving archived contexts do not leak into composition
- document or constrain status-blind helper usage at mining call sites
- add explicit limit-path coverage for archived inspection helpers

### Sprint 3
**Operator and job integration**
- add the hard `maxContexts` cap on `mineArchivedContexts` before any operator-facing wiring begins
- wire archived mining surfaces into the operator / job-facing entry points that need them
- keep policy boundaries explicit and documented
- decide the archived-wrapper policy and `ftsQuery` scope at the operator boundary
- finish validation and rollout notes

## Acceptance criteria

1. Standard composition cannot read archived contexts by accident
2. Archived contexts can be enumerated and inspected intentionally
3. Fork lineage is preserved and queryable
4. Public exports expose the archived-mining surface without changing default compose behavior
5. `npm run build` passes
6. Relevant targeted tests pass, plus no regression in active-branch behavior

## Files likely touched

- `src/context-store.ts`
- `src/message-store.ts`
- `src/index.ts`
- `test/context-store.test.mjs`
- new archived-mining regression tests if needed

## First managed run

The kickoff implementation contract for Sprint 1 lives at:
`/home/lumadmin/.openclaw/workspace/repo/hyperbuilder/tasks/hypermem-phase4-sprint-1.md`

## Sprint 1 closeout

**Implementation commit:** `ee98144` `feat(turn-dag): add archived context inspection APIs`

### Closeout classification

**Must-fix now**
- none

**Explicitly deferred to Sprint 2**
- `getHistoryByDAGWalk` remains public, Sprint 2 should define call-site policy around shared DAG primitives used by mining surfaces
- `getContextById` is intentionally status-blind, Sprint 2 should document it as inspection-only or wrap it behind narrower mining entry points
- lineage and fork helpers can cross status boundaries by design, Sprint 2 should decide whether mining-facing surfaces need archived-only wrappers or explicit status filtering guidance
- archived inspection helpers do not yet have explicit limit-path coverage, Sprint 2 should add it alongside the mining query surface tests

**Blocked by external prerequisite**
- none

### Project learnings

- explicit archived API naming plus zero compositor imports kept active composition archived-blind, keep that separation hard
- the full evaluator wave was useful even without code blockers, the closeout sprint still has to happen so deferred items do not vanish into chat history
- for archived-mining work, "by design but status-blind" helpers need to be called out in the next sprint contract up front, not rediscovered at the evaluator stage

### Carry-forward into Sprint 2

Sprint 2 should absorb the deferred items above directly in its contract, alongside the existing planned work for explicit mining APIs and historical metadata labeling.

## Sprint 2

**Implementation commit:** `006cfb5` `feat(turn-dag): add archived mining APIs`

### Closeout classification

**Must-fix now**
- none

**Explicitly deferred to Sprint 3**
- `mineArchivedContexts` needs a hard `maxContexts` cap on input `contextIds` before any operator-facing wiring begins
- shared DAG helper policy must be written down for operator-facing call sites, especially around `getHistoryByDAGWalk`
- `getContextById` and `getContextLineage` need inspection-only boundary callouts matching the status-crossing warning already used on `getForkChildren`
- Sprint 3 must decide whether status-crossing helpers need archived-only wrappers or whether documented boundary policy plus call-site review is sufficient
- Sprint 3 must decide whether `ftsQuery` stays client-side or graduates to SQL FTS for operator-facing search surfaces

**Blocked by external prerequisite**
- none

### Project learnings

- explicit archived mining APIs plus `isHistorical: true` kept historical data visibly separate from live composition
- the remaining real risk shifted from compose leakage to operator fan-out, which means the cap must land before integration wiring
- helper-boundary policy needs to be written before operator-facing code starts, not rediscovered during evaluation

### Repo learnings and failure modes

- `src/message-store.ts` is still the main hotspot for archived-mining behavior and performance risk in Phase 4
- status-crossing helpers are safe only when the call-site intent is explicit and documented
- client-side `ftsQuery` is acceptable as an internal sprint detail, but operator-facing use needs an explicit correctness and performance story

### Carry-forward into Sprint 3

Sprint 3 took the `maxContexts` cap as task one, then completed operator-facing archived-mining integration on top of the capped surface.

Sprint 3 outcomes:
- `mineArchivedContexts` now enforces a hard server-side `maxContexts` gate with default 20 and hard ceiling 50
- shared DAG helper policy is now canonical in `specs/DAG_HELPER_POLICY.md`
- `ftsQuery` remains a client-side substring filter for Sprint 3, with SQL FTS deferred to Phase 5
- `HyperMem` now exposes `listArchivedContexts`, `mineArchivedContext`, and `mineArchivedContexts`
- `BackgroundIndexer` remains active-scope by design, with no archived-mining wiring added in Sprint 3
