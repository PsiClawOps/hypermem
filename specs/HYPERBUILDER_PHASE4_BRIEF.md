# HyperBuilder Task Brief — Turn DAG Phase 4: Active vs Archived Context Split

**Project:** HyperMem
**Root:** `/home/lumadmin/.openclaw/workspace/repo/hypermem`
**Phase:** 4 of 5 (Turn DAG Migration)
**Spec:** `specs/TURN_DAG_MIGRATION_SPEC.md`
**Priority:** P0

## Objective

Separate **live prompt composition** from **archived mining**.

After this phase:
- standard composition paths only see the active branch
- archived and forked contexts remain queryable, but only through explicit mining surfaces
- background fact extraction and recall jobs do not scan archived branches by accident
- operators can inspect archived chains without contaminating the active prompt path

This phase is mostly a **policy and read-surface split**, not a schema rewrite. The schema already has `status`, `parent_context_id`, and `context_id` support. Use that foundation.

## Prior Work (Do Not Redo)

Already shipped:
- **Phase 0:** fence enforcement on live read paths
- **Phase 1:** `contexts` table and active context plumbing
- **Phase 2:** `parent_id`, `depth`, DAG-capable writes, session rotation
- **Phase 3:** DAG-native reads in compositor, context-scoped recall
- **B2:** stable-prefix cache signal propagation and boundary verification

Already present in code:
- `src/context-store.ts`
  - `getActiveContext(...)`
  - `archiveContext(...)`
  - `rotateSessionContext(...)`
  - `status: 'active' | 'archived' | 'forked'`
- `src/message-store.ts`
  - `getMessagesByContextId(...)`
  - `searchMessagesByContextId(...)`
- `src/compositor.ts`
  - active-context resolution for DAG-native history
  - active-context scoping on keystone/FTS/topic recall paths

**Do not reopen B2 or rework the cache-boundary logic in this phase.**

## Problem Statement

HyperMem now has branch-aware storage, but the product surface is still missing a clean split between:
- **live composition**, which should only see the active branch
- **archived mining**, which should only happen intentionally

The operational risk is not the schema. The risk is **policy leakage**:
- archived contexts may still be reachable through convenience or fallback read paths
- fact extraction jobs may ingest archived material without explicit authorization
- operator inspection needs a clean API so people stop reaching for broad conversation or agent-wide queries

## Dependency Analysis

### Existing live composition surfaces

| Surface | Current Phase 3 state | Phase 4 requirement |
|---|---|---|
| `Compositor.getHistory()` | DAG walk from active head when available | Keep active-only |
| `warmSession()` | uses active context head when available | Keep active-only |
| `refreshRedisGradient()` | uses active context head when available | Keep active-only |
| `buildKeystones()` | accepts active context | Keep active-only |
| `getKeystonesByTopic()` | accepts active context | Keep active-only |
| context-scoped FTS | supported via `searchMessagesByContextId()` | Keep active-only |

### Surfaces that still need an explicit archived/mining split

| Surface | Risk | Desired outcome |
|---|---|---|
| `context-store.ts` | lifecycle exists, operator inspection APIs do not | list/get/fork helpers for explicit context inspection |
| `message-store.ts` | context-scoped reads exist, but no explicit archived-mining entrypoints | dedicated archived-context retrieval/search helpers |
| `background-indexer.ts` | routine indexing can process broad message sets | default active-only behavior, explicit archived mode only |
| `index.ts` facade | no clear operator-facing archived mining API | separate live vs archived entrypoints |
| tests | no Phase 4 contract proving archived invisibility | regression coverage for composition and mining split |

## Design Rules

1. **Separate methods beat boolean footguns.**
   Prefer explicit archived-mining entrypoints over sprinkling `includeArchived` across live methods.

2. **Live composition stays active-only.**
   No fallback or convenience path should silently widen from active context to archived contexts.

3. **Archived access must read like archived access.**
   Naming should make intent obvious, for example `listSessionContexts`, `getArchivedContextHistory`, `searchArchivedContexts`.

4. **Indexing follows policy, not convenience.**
   Routine fact extraction should not mine archived branches unless an explicit archived-mining job is invoked.

5. **No schema churn unless needed.**
   Use the existing `status`, `parent_context_id`, `head_message_id`, and `context_id` model unless a blocker appears.

## Implementation Tasks

### Task 1: Expand context lifecycle and inspection APIs

Update `src/context-store.ts` with explicit inspection helpers:
- `getContextById(db, contextId)`
- `listContextsForSession(db, agentId, sessionKey, opts?)`
- `listArchivedContextsForSession(db, agentId, sessionKey)`
- `createForkedContext(...)` or equivalent explicit fork helper if current archive/rotate helpers are insufficient
- optional metadata helpers if needed for auditability of archive/fork origin

Requirements:
- active context lookup remains unchanged for live composition
- archived/forked contexts are easy to inspect intentionally
- ordering is deterministic, newest updated or newest created first

### Task 2: Add explicit archived mining read surfaces

Use `src/message-store.ts` as the main retrieval layer.

Add dedicated archived read/search helpers rather than widening normal composition APIs:
- `getMessagesForContextId(...)` may stay as the primitive if already sufficient
- add higher-level archived helpers as needed, for example:
  - `getArchivedMessagesByContextId(...)`
  - `searchArchivedMessagesByContextId(...)`
  - `searchSessionContexts(agentId, sessionKey, query, opts?)`

Requirements:
- archived-mining calls validate the target context status
- live composition calls do not change semantics
- no global `searchMessages()` fallback is used by live paths when an active context exists

### Task 3: Lock live compositor and recall surfaces to active-only policy

Review and tighten `src/compositor.ts`:
- `getHistory()`
- `warmSession()`
- `refreshRedisGradient()`
- `buildKeystones()`
- `getKeystonesByTopic()`
- semantic recall and open-domain retrieval paths
- cross-session context builder

Requirements:
- archived contexts never appear in standard composition
- active-context fallback logic does not widen into archived branches
- diagnostics stay truthful when content is filtered for scope policy

### Task 4: Split routine fact extraction from archived mining

Update `src/background-indexer.ts` and `src/index.ts` facade so routine indexing is policy-safe.

Requirements:
- default indexing behavior is active-only
- archived mining requires an explicit method, job, or mode
- archived extraction paths are clearly named and testable
- no accidental archived ingestion from routine cursor-based indexing

Preferred shape:
- keep routine `run()` or equivalent behavior active-only
- add a separate archived-mining entrypoint for deliberate operator use

### Task 5: Add Phase 4 regression coverage

Create focused tests, for example:
- `test/turn-dag-phase4.test.mjs`
- targeted updates to `test/cross-topic-keystone.mjs`
- targeted updates to `test/proactive-pass.mjs` or indexer tests if needed

Must prove:
1. archived contexts are invisible to standard composition
2. archived contexts are invisible to warm preload and gradient refresh
3. archived contexts are invisible to standard keystone and recall paths
4. explicit archived-mining APIs can still retrieve archived history
5. routine background indexing does not mine archived contexts
6. explicit archived-mining mode can mine archived contexts intentionally

## Testing

### Type check
```bash
cd /home/lumadmin/.openclaw/workspace/repo/hypermem && npx tsc --noEmit
```

### Test targets
```bash
cd /home/lumadmin/.openclaw/workspace/repo/hypermem && npm test
```

If the suite is too broad during iteration, at minimum run the targeted Phase 4 and retrieval/indexing regressions before final full-suite validation.

## Constraints

- **Do not change normal compose outputs except to remove archived leakage**
- **Do not reopen B2 cache work**
- **Do not widen archived access behind a silent boolean default**
- **Do not delete archived history**
- **Preserve operator inspectability of old contexts**
- **Prefer additive APIs over risky rewrites**
- **Keep live and archived policies obvious in names and tests**

## Acceptance Criteria

1. Standard composition only sees the active context branch
2. Warm preload and gradient refresh only see the active branch
3. Standard keystone/FTS/semantic recall do not surface archived messages
4. Archived context inspection is available through explicit APIs
5. Routine background indexing does not process archived contexts
6. Archived mining is available only through an explicit archived path
7. `npx tsc --noEmit` passes
8. Relevant tests pass, including new Phase 4 regression coverage

## Files Likely Touched

| File | Change Type |
|---|---|
| `src/context-store.ts` | MODIFY — context inspection and fork/archive helpers |
| `src/message-store.ts` | MODIFY — explicit archived mining retrieval/search surfaces |
| `src/compositor.ts` | MODIFY — active-only policy enforcement on live paths |
| `src/background-indexer.ts` | MODIFY — active-only default indexing, explicit archived mode |
| `src/index.ts` | MODIFY — facade methods for archived inspection/mining |
| `test/turn-dag-phase4.test.mjs` | **NEW** — Phase 4 regression suite |
| `test/cross-topic-keystone.mjs` | MODIFY — archived exclusion coverage if needed |
| `test/proactive-pass.mjs` and/or indexer tests | MODIFY — active-only vs archived-mining policy checks |

## Deliverable

At the end of this phase, HyperMem should have a clean contract:
- **compose and routine memory work:** active branch only
- **operator/history mining:** archived branches only when explicitly requested

That is the product boundary this phase exists to enforce.
