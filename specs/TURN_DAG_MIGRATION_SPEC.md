# Turn DAG Migration Spec

**Status:** Phases 0–3 and B2 implemented; Phase 4 next
**Priority:** P0 (correctness + productivity)
**Filed:** 2026-04-13
**Filed by:** Forge
**Last updated:** 2026-04-17

## Execution Policy

Turn DAG Phase 4 and later are **HyperBuilder-managed**.

Required HyperBuilder configuration for this workstream: `turn-dag-phase4-full-fleet`.

Before any new implementation work starts for a HyperBuilder-managed phase, the controlling artifact must name the required HyperBuilder configuration:
- composition tier or named pipeline profile
- mandatory stage roles
- required evaluation lanes
- any allowed override path

Until that configuration is written down in the phase brief or sprint contract, implementation is blocked.

Out of policy for HyperBuilder-managed work:
- ad hoc single-agent implementation
- partial-role or simplified pipeline execution
- swapping to a different HyperBuilder configuration without updating the controlling artifact first

Only ragesaq can approve a one-off deviation, and that approval must be explicit for the exact run.

## Problem

`messages.db` stores conversation history as flat per-conversation lists. That model has three operational failures:

1. **Zombie history:** old session rows remain queryable after rotation/restart unless every read path filters them correctly.
2. **Weak session continuity:** a restart creates a new conversation row instead of a continuation of the same logical thread.
3. **No branch semantics:** speculative paths, forks, and shared ancestry are not representable in storage.

Phase 0 fence enforcement is now live. It stops stale rows from polluting normal composition, warming, and keystone recall. It does **not** fix the underlying storage model.

## Goal

Move HyperMem from flat conversation tails to a **Turn DAG** model with explicit context heads, branch-scoped reads, and a clean split between:

- **live prompt composition**, which should only see the active branch
- **historical mining**, which should still be able to inspect archived branches and old sessions on purpose

## Non-Goals

- Replacing SQLite
- Adopting CXDB directly
- Rewriting fact extraction or library storage in this migration
- Deleting old message history during initial rollout

## Design Summary

Adopt the useful CXDB ideas in SQLite:

1. **Context heads**: an explicit current head for each active session/context
2. **Parent-linked turns**: every message points to its predecessor
3. **Branch-scoped reads**: composer walks backward from head instead of querying a flat tail
4. **Archived context separation**: mining old history becomes explicit, not accidental
5. **Optional later optimization**: content-addressed blob dedup for repeated large payloads

## Data Model

### New table: contexts

```sql
CREATE TABLE contexts (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  conversation_id INTEGER REFERENCES conversations(id),
  head_message_id INTEGER REFERENCES messages(id),
  parent_context_id INTEGER REFERENCES contexts(id),
  status TEXT NOT NULL DEFAULT 'active', -- active|archived|forked
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE UNIQUE INDEX idx_contexts_active_session
  ON contexts(agent_id, session_key, status)
  WHERE status = 'active';

CREATE INDEX idx_contexts_head ON contexts(head_message_id);
```

### New columns on messages

```sql
ALTER TABLE messages ADD COLUMN parent_id INTEGER REFERENCES messages(id);
ALTER TABLE messages ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN context_id INTEGER REFERENCES contexts(id);
```

### Optional later table: blobs

```sql
CREATE TABLE blobs (
  content_hash BLOB PRIMARY KEY,
  content BLOB NOT NULL,
  compression TEXT,
  ref_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
```

This is Phase 5, not required for DAG rollout.

## Read Model

### Current

- history: `WHERE conversation_id = ? ORDER BY message_index DESC LIMIT ?`
- keystones/FTS: search global pool, then filter
- warming: tail query from conversation

### Target

- resolve active `context.head_message_id`
- walk backward through `parent_id`
- stop by token budget / depth / branch policy
- FTS and semantic queries constrained to `context_id` or to message IDs reachable from the active head

### Canonical traversal

```sql
WITH RECURSIVE chain AS (
  SELECT id, parent_id, depth, role, text_content, created_at
  FROM messages
  WHERE id = :head_message_id

  UNION ALL

  SELECT m.id, m.parent_id, m.depth, m.role, m.text_content, m.created_at
  FROM messages m
  JOIN chain c ON m.id = c.parent_id
  WHERE c.depth > :min_depth
)
SELECT * FROM chain;
```

In practice, composer should stop on token budget before extreme depth.

## Write Model

### New message insert path

For every new message:

1. resolve active context for `(agent_id, session_key)`
2. set `parent_id = context.head_message_id`
3. set `depth = parent.depth + 1` or `0` if first message
4. set `context_id = active_context.id`
5. insert message
6. update `contexts.head_message_id` to the new message
7. update `contexts.updated_at`

### Fork path

To create a branch:

1. create new `contexts` row
2. point `parent_context_id` to source context
3. set new `head_message_id` to chosen ancestor message
4. mark source/child relationship in metadata

Forks become O(1) pointer operations.

## Migration Phases

## Phase 0 — complete

**Fence enforcement on live read paths**

Done:
- composition history
- keystones
- topic keystones
- warm session preload
- redis gradient refresh

Purpose: stop zombie pollution immediately.

## Phase 1 — complete

**Introduce context heads without changing live read semantics**

### What shipped
- `src/context-store.ts`: `ensureContextSchema`, `getOrCreateActiveContext`, `updateContextHead`, `archiveContext`, `rotateSessionContext`
- `src/context-backfill.ts`: `backfillContexts` for existing conversations
- `src/message-store.ts`: `getOrCreateConversation` calls `getOrCreateActiveContext`; writes are context-aware
- `src/index.ts`: exports context-store surface; `recordUserMessage`/`recordAssistantMessage` pass contextId

### Acceptance criteria — met
- every active session has exactly one active context
- writes populate `context_id`
- no change in prompt output versus Phase 0

## Phase 2 — complete

**Make writes DAG-capable**

### What shipped
- `src/context-backfill.ts`: `backfillParentChains` reconstructs `parent_id`/`depth` for existing flat conversations by `message_index` order
- `src/message-store.ts` `recordMessage`: sets `parent_id = context.head_message_id`, `depth = parent.depth + 1` on every new insert
- Session rotations create a new context row via `rotateSessionContext`

### Acceptance criteria — met
- all messages have correct `parent_id`/`depth`
- new writes maintain head pointer correctly
- no prompt regression under compatibility reads

## Phase 3 — complete

**Switch composer, warming, and recall to DAG-native reads**

### What shipped
- `src/message-store.ts`: `getHistoryByDAGWalk` walks backward through `parent_id` chain from a head message
- `src/compositor.ts`: `warmSession` and `refreshRedisGradient` use `getHistoryByDAGWalk` when an active context head is available
- `src/compositor.ts`: `getHistory` resolves active context and uses DAG walk as primary path; fence retained as fallback
- FTS and keystone recall in compositor are scoped to `context_id` when active context is present
- Stable-prefix assembly: `getStablePrefixMessages`, `computeStablePrefixHash`, `CACHE_PREFIX_BOUNDARY_SLOT` boundary marker injected; `provider-translator.ts` applies `cache_control: {type: 'ephemeral'}` at the boundary

### Acceptance criteria — met
- prompt output matches Phase 0 intent without relying on fence as main boundary
- no cross-branch leakage in composition
- restart continuity works via context rotation

### Phase B2 outcome
Stable-prefix signal propagation is now implemented and verified.

## Phase B2 — complete

**Cache-prefix signal propagation and end-to-end verification**

### Delivered
- `prefixHash` is propagated into cache invalidation so stale window cache entries with a mismatched stable prefix are bypassed instead of returned as hits
- window cache read and write paths are stable-prefix aware, including the volatile-only fast-exit path and bypass diagnostics via `prevPrefixHash`
- end-to-end verification covers `cache_control: {type: 'ephemeral'}` placement at `CACHE_PREFIX_BOUNDARY_SLOT`
- session lifecycle coverage includes `rotateSessionContext` continuity checks

### Acceptance criteria — met
- stale cache entries with mismatched stable prefix do not return as hits
- unchanged stable prefix can return `windowCacheHit: true` on the volatile-only path
- bypasses surface the previous prefix hash for diagnostics
- boundary-scoped `cache_control: {type: 'ephemeral'}` placement is verified

---

## Phase 4 — pending

**Separate live composition from archived mining**

**Execution mode:** HyperBuilder-managed (`turn-dag-phase4-full-fleet`). Do not begin Phase 4 implementation until a fresh phase brief or sprint contract carries that exact HyperBuilder configuration.

### Changes
- introduce context lifecycle: `active`, `archived`, `forked`
- define explicit APIs/jobs for mining archived contexts
- fact extraction jobs may scan archived branches by policy, never by accident

### Why this matters
We want two different behaviors:
- **composition:** only active branch
- **research/mining:** archived branches allowed when explicitly requested

This preserves discoverability of old work without poisoning routine prompts.

### Acceptance criteria
- archived contexts are invisible to standard composition
- mining jobs can still access archived contexts intentionally
- operators can inspect old chains without changing active prompt behavior

## Phase 5

**Storage and performance optimization**

### Candidate work
- content-addressed blob store for repeated large text/tool payloads
- zstd compression for large message bodies
- cached token estimates on insert
- optional garbage collection for unreachable junk
- active-only FTS index maintenance

### Note
This phase is important for scale, but not for correctness.

## Search and Recall Strategy

### Short term
During Phases 1-2:
- keep current retrieval behavior
- scope by fence and, where possible, by `context_id`

### Medium term
During Phase 3:
- history: DAG walk from head
- keystones: active `context_id` only
- FTS: filter to current `context_id`
- semantic recall: same scope policy as FTS

### Long term
For cross-context or archived mining:
- separate query surfaces
- explicit operator or system intent required
- results clearly labeled as archived/historical

## Session Warming Impact

The new model improves warming:

- current behavior warms from conversation tail and needed Phase 0 fence filtering
- target behavior warms from active head backward
- archived branches remain available for mining but do not get preloaded into hot context by default

This reduces stale-cache pollution.

## Compaction Impact

The DAG does **not** remove the need for compaction. It changes what compaction means.

### Before
Compaction needed to distinguish old rows from current rows in a flat list.

### After
Compaction can operate on:
- archived contexts
- old segments below a summarized checkpoint on an active branch
- repeated large payload blobs

The fence becomes transitional and eventually optional. The primary boundary is branch reachability from the active head.

## Old Session Mining

This migration should **not** make old-session mining harder.

It should make it safer.

### Standard composition
Only active branch content is visible.

### Mining mode
Operators or background jobs can still:
- walk archived contexts
- search historical branches
- extract facts from old sessions
- run one-time cleanup or upgrade jobs over legacy rows

The key change is intent. Old history is no longer included by default just because it happens to be in the same table.

## Rollout Plan

1. ship schema additions behind compatibility reads
2. backfill contexts
3. backfill parent chains and depths
4. dual-write new messages with both old and new fields
5. switch one read path at a time to DAG-native traversal
6. validate prompt diffs and token budgets
7. archive old flat-only assumptions
8. remove fence dependence only after DAG reads are stable

## Rollback Plan

At each phase, rollback is bounded:

- **Phase 1:** ignore `contexts`, continue using flat reads
- **Phase 2:** continue dual-write, ignore DAG fields in reads
- **Phase 3:** flip read paths back to Phase 0 fence-based queries
- no destructive deletion of legacy rows during migration

This is why the migration should preserve `conversation_id` until Phase 3 is proven stable.

## Risks

### 1. Backfill correctness
If parent chains are backfilled incorrectly, traversal will be wrong.

**Mitigation:** validate per-conversation chain length, head identity, and depth monotonicity before enabling DAG reads.

### 2. Query complexity
Recursive CTEs are more complex than tail queries.

**Mitigation:** keep traversal bounded by token budget and message count, add indexes on `messages(parent_id)`, `messages(context_id)`, and `contexts(head_message_id)`.

### 3. Dual-write drift
If old and new fields diverge during migration, debugging gets ugly.

**Mitigation:** add invariant checks in tests and write-path assertions in debug mode.

### 4. Search leakage
FTS or semantic recall may continue to surface archived rows if scope filters are missed.

**Mitigation:** treat every read path as a migration checklist item, not just `getHistory()`.

## Success Metrics

- zero zombie-message leakage into standard composition after DAG read cutover
- restarts no longer create prompt pollution from prior sessions
- warm session preload only includes active-branch messages
- keystone recall precision improves on long-lived sessions
- operators can still mine archived sessions intentionally
- no increase in compose failures or token budget overruns

## Recommended Priority Order

1. **P1:** context heads
2. **P2:** parent pointers + depth + backfill
3. **P3:** DAG-native reads + scoped recall
4. **P4:** archive/mining split
5. **P5:** dedup/compression/token caching

## Decision

Proceed with a staged Turn DAG migration in SQLite.

Do **not** jump straight to blob CAS or deep optimization work. The immediate win is correctness: explicit heads, parent-linked turns, and branch-scoped composition. That is the shortest path to a memory system that keeps productivity moving forward instead of reintroducing stale history into active work.
