# HyperMem Roadmap

This is the single planning source of truth for HyperMem.

If a future-work item is not tracked here, it is not in the active improvement plan.
If an older spec disagrees with this file, this file wins.

For shipped capabilities, see [CHANGELOG.md](../CHANGELOG.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## Current state

### Released
- Current release: **0.8.6**

### Landed on `main` after 0.8.6
In the order work actually landed:
1. `47c1962` wire reranker into fused retrieval
2. `157bca6` Sprint 1 observability telemetry
3. `1b1cf51` Sprint 2 config-surface gaps
4. `a62143d` Sprint 3 and Sprint 4 context engineering
5. `be0457c` ZeroEntropy reranker endpoint fix
6. `2af624f` sqlite-vec runtime installer native packaging fix
7. `27046b7` composition snapshot integrity helpers
8. `748c418` composition snapshot store and schema
9. `1bf4785` repaired warm restore snapshot path

### What changed in planning
We had overlapping planning streams for:
- near-term compositor fixes
- 0.9.0 adaptive context lifecycle
- warm restore
- long-tail memory-quality improvements

That produced split priorities and made it too easy to treat multiple drafts as active at once.

This roadmap consolidates those streams into one ordered list.

---

## Canonical execution order

## 0. Already landed
These are complete enough to stop planning around as future work:
- reranker integration
- Sprint 1 observability telemetry
- Sprint 2 config-surface gaps
- Sprint 3 and Sprint 4 context engineering
- ZeroEntropy reranker endpoint fix
- sqlite-vec runtime installer packaging fix
- warm-restore foundation work: integrity helpers, snapshot store/schema, repaired restore path

Warm restore moved ahead of the earlier draft order and is now a partially landed capability, not a hypothetical future-only item.

## 1. Validate and close remaining warm-restore gates
Warm restore is the highest-priority unfinished stream because code is already in the tree.

Remaining closeout work:
- repair notice placement and non-suppressibility
- repair-depth cap enforcement
- cross-provider assistant-turn policy
- `slots_json` integrity-hash verification end to end
- parity telemetry and rollout gates for automatic restore
- explicit zero-tolerance checks for required-slot loss, stable-prefix violations, and tool-pair parity

Rule: no new warm-restore expansion before these gates are closed.

## 2. HyperMem 0.9.0 adaptive context lifecycle
Once warm-restore gates are closed, the next major workstream is 0.9.0 adaptive context lifecycle:
- tiered warming
- T0 `/new` breadcrumb package
- smart-recall surge
- adaptive trim and compaction bands
- topic-centroid-guided eviction
- telemetry and tuning pass

This remains the next major roadmap block, but it is no longer competing with reranker or Sprint 1-4 work. Those are already done.

## 3. Contradiction-aware decay
After 0.9.0 lifecycle work:
- accelerate decay for superseded facts
- reduce stale architectural facts surviving long after pivots
- prevent repeated ghost-fact failures after deletes, renames, and interface changes

This is a quality and correctness improvement, not a release blocker.

## 4. Turn DAG Phase 5 storage and performance
After the above correctness and continuity work:
- content-addressed blob store for repeated large payloads
- zstd compression for large message bodies
- cached token estimates on insert
- optional garbage collection
- active-only FTS index maintenance

Phase 5 stays important, but it is not the next sprint until the higher-priority continuity and lifecycle work is settled.

---

## Open items

### High priority
| Item | Status | Notes |
|---|---|---|
| Warm-restore gate closeout | 🟡 OPEN | Highest-priority unfinished stream because implementation already landed partially. |
| Adaptive context lifecycle (0.9.0) | 🟡 OPEN | Next major feature block after warm-restore closeout. |
| Contradiction-aware decay | 🟡 OPEN | Prevents stale-fact poisoning after architectural pivots. |
| Turn DAG Phase 5 storage/perf | 🟡 OPEN | Important, but later than the items above. |

### Medium priority
| Item | Status | Notes |
|---|---|---|
| Cross-session context boundary markers | 🟡 OPEN | `buildCrossSessionContext()` still renders flat previews without strong per-message boundaries or sender identity. |
| Cursor durability (SQLite dual-write) | 🟡 DEFERRED | Needed before background indexer can rely on cursor state across restarts. |
| Cross-agent registry live load | 🟡 DEFERRED | Replace hardcoded org registry with library.db-backed load on startup. |
| Write authorization for global-scope facts | 🟡 DEFERRED | Add designated-writer policy for `scope='global'`. |

### Lower priority / deferred
| Item | Status | Notes |
|---|---|---|
| Plugin type unification | 🟡 DEFERRED | Structural cleanup, not urgent product work. |
| Strict topic mode legacy NULL backfill | 🟡 DEFERRED | Wait for stable topic coverage before running the migration/backfill. |
| ACA Step 4 retrieval stubs replace static files | 🔲 PENDING | Future governance/context assembly work. |
| ACA Step 5 governance context assembly | 🔲 PENDING | Depends on Step 4. |

---

## Working rules for future planning

1. Add future-work items here first.
2. Do not create a second roadmap doc for the same workstream.
3. If a feature needs a design spec, that spec should support implementation details only and must point back here for priority/order.
4. If code lands out of the planned order, update this file in the same work session.
5. Historical phase briefs are not roadmap authority.

---

## Retired planning documents

The following overlapping roadmap/spec files were consolidated into this roadmap and removed to stop split-planning:
- `specs/ROADMAP_RESEQUENCING_2026-04-21.md`
- `specs/ADAPTIVE_CONTEXT_LIFECYCLE_0.9.0.md`
- `specs/COMPOSITION_SNAPSHOT_WARM_RESTORE_PLAN.md`
- `specs/CONTRADICTION_AWARE_DECAY.md`

Their useful content is now represented here.
