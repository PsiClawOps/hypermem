# HyperBuilder Task Brief — Turn DAG Phase 4: Archived Mining Separation

**Project:** HyperMem
**Root:** `/home/lumadmin/.openclaw/workspace/repo/hypermem`
**Phase:** 4 of 5 (Turn DAG Migration)
**Spec:** `specs/TURN_DAG_MIGRATION_SPEC.md`
**Priority:** P0
**Status:** Ready for managed execution

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

### Sprint 3
**Operator and job integration**
- wire archived mining surfaces into the operator / job-facing entry points that need them
- keep policy boundaries explicit and documented
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
