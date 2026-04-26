# HyperMem Roadmap

This is the single planning source of truth for HyperMem.

If a future-work item is not tracked here, it is not in the active improvement plan.
If an older spec disagrees with this file, this file wins.

For shipped capabilities, see [CHANGELOG.md](../CHANGELOG.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## Current state

### Released
- Current release: **0.9.0** — adaptive context lifecycle. Published 2026-04-25.
  - Internal `main`: `8f805b8`
  - Public `main`: `25dd469`
  - Public tag `v0.9.0`: pushed
  - Public CI: green (`24942512824`)
  - GitHub Release: https://github.com/PsiClawOps/hypermem/releases/tag/v0.9.0
  - npm at 0.9.0: `@psiclawops/hypermem`, `@psiclawops/hypercompositor`, `@psiclawops/hypermem-memory`
  - New install validator shipped: `hypermem-doctor`
- Previous release: **0.8.6**

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
10. `99b2e61` CI commit-data review for warm-restore gate closeout
11. `7acec79` stable-prefix CI regression test stabilization
12. `ef37137` missing doc-chunk source pruning during seeding
13. `2c0fd7a` legacy keystone preservation under active context
14. `e931524` warm-restore repair gates
15. `87a4be9` snapshot slot integrity verification
16. `31d07a6` warm-restore auto-rollout parity gates
17. `eeedccf` cross-provider warm-restore policy
18. `a03dc01` HyperMem governance trigger coverage
19. `c94def0` adaptive lifecycle policy kernel
20. `0d33286` doctrine-first retrieval over stale memory folklore
21. `322a416` adaptive lifecycle diagnostics wiring

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

## 1. Warm-restore gate closeout
Status: **DONE for the tracked gate-closeout scope.**

Warm restore moved ahead of the earlier draft order and became a partially landed capability. The gate-closeout stream is no longer the highest-priority unfinished work.

Closed in warm-restore gate closeout:
- repair notice placement and non-suppressibility: repair notices are emitted as system context above restored/history content even when budget is exhausted.
- repair-depth cap enforcement: repaired snapshots are capped at depth 1 and cannot become restore sources.
- `slots_json` integrity-hash verification end to end: composed snapshots are verified after write, persisted hash mismatches are rejected, and restore resolution falls back to the previous valid snapshot.
- parity telemetry and rollout gates for automatic restore: restore diagnostics now surface rollout-gate pass/fail state and automatic warm restore falls back to cold rewarm when measurement gates fail.
- explicit zero-tolerance checks for required-slot loss, stable-prefix violations, and tool-pair parity: all three conditions are rollout blockers.
- cross-provider assistant-turn policy: foreign-provider assistant turns are explicitly counted and block automatic warm restore with a zero-tolerance rollout gate. User turns may restore cross-provider only when all measurement gates pass.

Final closeout work now complete:
- CI commit-data review for every failing warm-restore-related GitHub Actions run before sprint scope is finalized. The review maps failing workflow run, head commit SHA, commit title, failing step, and failing assertion back to a roadmap gate or triage item.

Rule going forward: do not reopen warm restore from historical planning notes. New warm-restore work needs a fresh defect, measurement gap, or roadmap item.

## 2. HyperMem 0.9.0 adaptive context lifecycle
Status: **CLOSED — shipped 2026-04-25.** Public tag `v0.9.0` (`25dd469`), GitHub Release published, all three npm packages at 0.9.0. `hypermem-doctor` shipped as part of this release.

The core runtime slices have landed: the pure adaptive lifecycle policy kernel, compose diagnostics wiring, afterTurn Redis gradient-cap wiring, adaptive recall breadth, adaptive eviction ordering, lifecycle telemetry, report tooling, forked-context lifecycle integration, and metadata-only topic-signal report classification. The first live telemetry baseline is populated; it shows steady/warmup behavior with zero lifecycle-band divergence, so no threshold tuning is warranted from the current evidence.

The lifecycle policy makes compose, afterTurn, recall, trim, compaction, and eviction share one pressure-band decision source instead of growing independent heuristics:
- tiered warming — policy bands: bootstrap, warmup, steady, elevated, high, critical
- T0 `/new` breadcrumb package — bootstrap policy emits the package trigger
- smart-recall surge — `/new` and confident topic shifts widen recall; high/critical pressure gates it down
- adaptive trim and compaction bands — trim and compaction targets resolve from the same lifecycle band
- topic-centroid-guided eviction — enabled only once pressure reaches elevated or worse
- telemetry and tuning pass — policy returns stable band, pressure, and reason fields for later runtime instrumentation

Done in this stream:
- adaptive lifecycle policy kernel — `c94def0`, CI `24879881852`
- compose diagnostics wiring + afterTurn Redis gradient-cap wiring — `322a416`
- adaptive recall breadth adjustment — `5e47fce`, CI `24918184839`
- adaptive eviction ordering — `a0f6780`, CI `24918940291`
- adaptive lifecycle telemetry — `61f9b9e`, CI `24919418833`
- telemetry report tooling — `a923987`, CI `24920282389`
- forked-context lifecycle integration — `85b5e3c`, CI `24921417908`

Remaining slices:
- runtime tuning only after evidence shows a specific threshold or behavior change is warranted; live topic-bearing samples are now future tuning evidence, not a 0.9.0 release gate

Closed release-readiness gates:
- vector coverage repair: `scripts/embed-existing.mjs` now supports active `knowledge` backfill, eligibility-aware coverage reporting, and a regression covering knowledge coverage. Production backfill reached 100% eligible coverage for facts, knowledge, and episodes on 2026-04-24.
- lifecycle telemetry baseline: the 2026-04-25 live one-hour window reported 222 lifecycle-policy records across `compose.preRecall`, `compose.eviction`, and `afterTurn.gradient`; bands were steady/warmup only, lifecycle divergence was zero, pressure p95 was 18%, and no threshold tuning was indicated.
- topic-signal interpretation path: compose/assemble telemetry now exposes metadata-only topic-state fields, and `trim-report.mjs`/`compose-report.mjs` classify `present`, `absent-no-active-topic`, `absent-stamping-incomplete`, and `intentionally-suppressed` without topic names, prompt text, document text, or user content. This closes the reporting ambiguity from the first baseline.
- topic-bearing compose evidence gate: the 0.9.0 release gate is now **replaced by a safer deterministic evidence gate**. `compose-report.mjs` seeds deterministic topic-bearing history in a temp workspace, `trim-report.mjs`/`compose-report.mjs` both emit `replaced-by-deterministic-evidence` only from metadata-only topic-state observations, and targeted tests cover the gate without live DB mutation or content-bearing telemetry. Live topic-bearing samples remain desirable for future tuning claims, but they are no longer required before tagging 0.9.0.

Release-candidate next steps before tagging 0.9.0:
- run targeted lifecycle evidence checks (`node test/trim-telemetry.mjs` and the existing adaptive lifecycle regression set)
- validate release docs/version surface (`npm run validate:docs`, `npm run validate:version-parity`, changelog review)
- complete the normal release checklist: final smoke/tests, tag notes, and publish/tag verification

Do not confuse this with the shipped governance-retrieval work. Governance trigger retrieval is closed unless a new regression appears.

## 2a. Runtime diagnostics API allowlist defect
Status: **CLOSED, upstream verified.** Verified 2026-04-24 against the installed OpenClaw runtime.

`openclaw doctor --non-interactive` no longer reports the public-surface allowlist blocker, and a direct memory-core runtime facade probe can load `memory-core/runtime-api.js` through the installed OpenClaw public-surface loader.

This remains an upstream OpenClaw surface, not HyperMem-owned code. If the blocker reappears, classify it as `upstream-required` unless HyperMem is failing to expose its own memory plugin diagnostics.

## 2b. Topic synthesis bridge defect
Status: **CLOSED.** Fixed in `8b9f928`; CI `24917765384` passed.

Health stats on 2026-04-24 showed `knowledge: 0 active` despite eligible topics, indexed facts, and indexed episodes. Investigation found `TopicSynthesizer` still assumes `library.db.topics.id` matches `messages.db.messages.topic_id`. That invariant broke when per-session `SessionTopicMap` introduced UUID topic ids in messages DBs while library topics kept integer ids. The result is silent topic-wiki synthesis loss: eligible global topics cannot resolve their source messages.

Closed fix summary:
- bridges library topics to per-agent message topics where names align and falls back to the same content detector that created library topics;
- preserves legacy direct-id fallback for older integer-linked data;
- emits diagnostics when eligible topics cannot resolve message topic ids or source messages;
- refreshes unchanged-content upsert metadata so source-ref watermarks do not silently suppress regenerated pages;
- repairs long-lived `knowledge.visibility` schema drift;
- covers UUID topic ids, duplicate same-name session topic fragments, content-detector fallback, no-match skips, legacy direct-id fallback, schema-drift repair, unchanged-content watermark refresh, and idempotent upsert.

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
| Runtime diagnostics API allowlist defect | ✅ CLOSED | Verified installed OpenClaw runtime can reach `memory-core/runtime-api.js`; re-open only with a fresh public-surface failure trace. |
| Topic synthesis bridge defect | ✅ CLOSED | Fixed in `8b9f928`; CI `24917765384` passed. |
| Adaptive context lifecycle (0.9.0) | ✅ SHIPPED | Released 2026-04-25 as 0.9.0. Threshold tuning remains deferred until future live evidence warrants it. |
| Vector coverage repair gate | ✅ CLOSED | `embed-existing` now supports knowledge and eligibility-aware coverage reporting; production vectors reached facts 113/113, knowledge 85/85, episodes 30,121/30,121 eligible coverage on 2026-04-24. |
| Contradiction-aware decay | 🟡 OPEN | Prevents stale-fact poisoning after architectural pivots. |
| Turn DAG Phase 5 storage/perf | 🟡 OPEN | Important, but later than the items above. |
| Warm-restore gate closeout | ✅ DONE | Tracked gate-closeout scope is complete; reopen only for a new concrete defect or measurement gap. |

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
| ACA Step 4 retrieval stubs replace static files | 🔲 PENDING | Still relevant, but downstream of lifecycle/diagnostics stability. Do not start from older ACA notes. |
| ACA Step 5 governance context assembly | 🔲 PENDING | Still relevant, but depends on Step 4. Do not start until Step 4 has an accepted implementation contract. |
| Tokenjuice + HyperMem tool-result pipeline integration | 🔲 TRIAGE | OpenClaw 2026.4.24 ships `tokenjuice`, a deterministic rule-based tool-result pre-trim hook (collapses ANSI/build noise/repeated frames). It and HyperMem's size-based `tool_result_trim` both fire on tool results. Three integration concerns before fleet-wide enable: (1) **Hook ordering**: tokenjuice must run before HyperMem trim so HyperMem only collapses what tokenjuice cannot already remove deterministically. Reverse order wastes savings. (2) **Tool-artifact store**: HyperMem's L4 durable artifact store must capture the **untransformed** tool result, not the tokenjuice-trimmed one. The hook chain should pass `{ raw, transformed }` so artifacts get `raw` while message stream gets `transformed`. (3) **Telemetry**: unify `tool_result_trim_event` schema with `source: "tokenjuice" \| "hypermem"` and per-turn rollup so operators see one report. Sequencing: pilot tokenjuice standalone on one heavy-exec agent (HyperBuilder generator candidate) to measure rule-trim savings on our actual workloads before formalizing the contract. Do not write the contract before we have numbers. Surfaced 2026-04-25 during operator review. |
| Codex harness compatibility for HyperMem hooks | 🔲 TRIAGE | OpenClaw is generalizing the embedded executor (PI stays default; Codex is a registered plugin harness via `agents.defaults.embeddedHarness`). When a turn runs through the Codex harness, OpenClaw owns mirror transcript + tool dispatch but Codex owns the agent loop and native compaction. Investigate before any agent moves off PI: (1) whether HyperMem's `before_prompt_build`, `before_compaction`, `after_compaction`, `before_message_write`, `llm_input`, `llm_output`, `agent_end`, `after_tool_call` hooks fire with the same timing on Codex turns; (2) collision between HyperCompositor compaction and Codex native app-server compaction (need an explicit disable on one side or a coordination contract); (3) whether the locally mirrored transcript loses any content the indexer assumes is present; (4) `subagent` `context: "fork"` behavior when parent runs on Codex (parent JSONL is mirror, not source of truth); (5) keep `openai-codex/*` provider routes (PI under the hood) distinct from `codex/*` runtime selection (Codex harness). Pilot on one non-critical agent with `runtime: "codex"`, `fallback: "pi"` once the parity gap closes; do not adopt fleet-wide before then. Surfaced 2026-04-24 during operator review. |

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
| Governance and workspace doc ingestion | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **SUPERSEDED** | Broad ingestion work was replaced by scoped governance trigger retrieval, doctrine-first ranking, and later ACA Step 4/5 items. Do not reopen the broad item. |
| Prompt-cache validation | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **SUPERSEDED** | Replaced by shipped cache-boundary work and current warm-restore parity gates. |
| Cross-seat and org-visible fact sharing | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **BACKLOG** | Still deferred pending stronger write-auth and provenance rules. |
| Knowledge extraction expansion | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **BACKLOG** | Valid future work, not in the current active sequence. |
| memory-core deprecation path | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **BACKLOG** | Deferred until the current roadmap blocks are complete. |
| ACA kernel reduction | workspace `active/hypermem-prioritized-improvements-2026-04-14.md` | **SUPERSEDED** | Broad kernel-reduction framing is replaced by adaptive lifecycle 0.9.0 and later ACA Step 4/5 work. |
| Phase A stability block (duplicate compose, trim ownership, rescue-trim loop, history depth) | workspace `specs/HYPERMEM_PLAN_2026-04-16.md` | **SUPERSEDED** | Historical restructuring plan. Remaining active work is tracked only through the canonical sections above. |
| Phase B compositor restructure | workspace `specs/HYPERMEM_PLAN_2026-04-16.md` | **SUPERSEDED** | Do not treat as a second roadmap. Re-open only by adding a new item above. |
| Phase C correctness guards | workspace `specs/HYPERMEM_PLAN_2026-04-16.md`, `specs/RELEASE_HARDENING_0.8.0.md` | **SHIPPED** | Landed in 0.8.0. |
| Phase D graph semantics follow-on | workspace `specs/HYPERMEM_PLAN_2026-04-16.md` | **SUPERSEDED** | Turn DAG follow-on now lives only as item 4 in the canonical roadmap. |
| Turn DAG Phase 5 storage/perf | `specs/TURN_DAG_MIGRATION_SPEC.md`, `specs/HYPERBUILDER_PHASE4_BRIEF.md` | **OPEN** | Canonical roadmap item 4. |
| ACA governance trigger retrieval | direct roadmap follow-up, commits `a03dc01` and `0d33286` | **SHIPPED** | Governance trigger coverage and doctrine-first retrieval are done. Reopen only for a new failing query or regression test. |
| Adaptive lifecycle diagnostics | direct roadmap follow-up, commits `c94def0` and `322a416` | **SHIPPED** | Kernel and compose diagnostics wiring landed. Remaining lifecycle behavior stays under roadmap item 2, not a separate historical activity. |

### Rule after this cleanup

If an older workspace note or historical spec lists future work that does not also appear in the main roadmap sections above, treat it as historical context only, not an active plan.
