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

Closed in warm-restore gate closeout:
- repair notice placement and non-suppressibility: repair notices are emitted as system context above restored/history content even when budget is exhausted.
- repair-depth cap enforcement: repaired snapshots are capped at depth 1 and cannot become restore sources.

Remaining closeout work:
- cross-provider assistant-turn policy
- `slots_json` integrity-hash verification end to end
- parity telemetry and rollout gates for automatic restore
- explicit zero-tolerance checks for required-slot loss, stable-prefix violations, and tool-pair parity
- CI commit-data review for every failing warm-restore-related GitHub Actions run before sprint scope is finalized. The review must map failing workflow run, head commit SHA, commit title, failing step, and failing assertion back to a roadmap gate or triage item.

Rule: no new warm-restore expansion before these gates are closed. Failing CI tied to warm restore is a closeout blocker, not generic backlog.

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

---

## Historical triage appendix

This appendix is the cleanup pass for older improvement lists that were still floating around in the repo and workspace.

### Triage legend
- **SHIPPED**: landed in release code or on `main`
- **OPEN**: still active in the canonical roadmap above
- **BACKLOG**: valid idea, but not in the current active execution order
- **SUPERSEDED**: replaced by a later implementation or a narrower canonical item above

### Historical improvement triage

| Historical item | First appeared in | Disposition | Canonical location / note |
|---|---|---|---|
| End-to-end integration verification | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **SHIPPED** | Closed by the 0.8.0 release-hardening verification work. |
| Real gateway integration test | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **SHIPPED** | Closed by the 0.8.0 release-hardening verification work. |
| Fact contradiction handling | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **SHIPPED** | Landed as V19 tiered contradiction resolution in 0.8.0. |
| Post-retrieval reranking | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **SHIPPED** | Already landed on `main`; no longer roadmap future work. |
| Oversized-payload artifact handling | workspace `active/hypermem-prioritized-improvements-2026-04-14.md`, workspace `specs/HYPERMEM_PLAN_2026-04-16.md` | **SHIPPED** | Landed in the 0.8.0 correctness cluster. |
| Model-aware compositor budgeting | workspace `active/hypermem-prioritized-improvements-2026-04-14.md`, workspace `specs/HYPERMEM_PLAN_2026-04-16.md` | **SHIPPED** | Landed as B4 model-aware budgeting in 0.8.0. |
| Benchmark suite completion | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **BACKLOG** | Still valid, but not part of the current active execution order. |
| Trust-aware composition / prompt-boundary hygiene | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **SUPERSEDED** | Survives only as narrower work inside warm-restore gates and future lifecycle tuning. |
| Fleet agent seeding on startup | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **SHIPPED** | Closed in 0.8.0 startup completeness work. |
| Governance and workspace doc ingestion | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **BACKLOG** | Not an active HyperMem improvement priority right now. |
| Prompt-cache validation | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **SUPERSEDED** | Replaced by shipped cache-boundary work and current warm-restore parity gates. |
| Cross-seat and org-visible fact sharing | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **BACKLOG** | Still deferred pending stronger write-auth and provenance rules. |
| Knowledge extraction expansion | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **BACKLOG** | Valid future work, not in the current active sequence. |
| memory-core deprecation path | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **BACKLOG** | Deferred until the current roadmap blocks are complete. |
| ACA kernel reduction | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **BACKLOG** | Deferred. |
| Phase A stability block (duplicate compose, trim ownership, rescue-trim loop, history depth) | workspace `specs/HYPERMEM_PLAN_2026-04-16.md` | **SUPERSEDED** | Historical restructuring plan. Remaining active work is tracked only through the canonical sections above. |
| Phase B compositor restructure | workspace `specs/HYPERMEM_PLAN_2026-04-16.md` | **SUPERSEDED** | Do not treat as a second roadmap. Re-open only by adding a new item above. |
| Phase C correctness guards | workspace `specs/HYPERMEM_PLAN_2026-04-16.md`, `specs/RELEASE_HARDENING_0.8.0.md` | **SHIPPED** | Landed in 0.8.0. |
| Phase D graph semantics follow-on | workspace `specs/HYPERMEM_PLAN_2026-04-16.md` | **SUPERSEDED** | Turn DAG follow-on now lives only as item 4 in the canonical roadmap. |
| Turn DAG Phase 5 storage/perf | `specs/TURN_DAG_MIGRATION_SPEC.md`, `specs/HYPERBUILDER_PHASE4_BRIEF.md` | **OPEN** | Canonical roadmap item 4. |

### Rule after this cleanup

If an older workspace note or historical spec lists future work that does not also appear in the main roadmap sections above, treat it as historical context only, not an active plan.
