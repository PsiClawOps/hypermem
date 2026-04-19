# Changelog

All notable changes to hypermem are documented here.

## 0.8.0 — Phase C correctness, tool-artifact store, tiered contradiction resolution

- **Reranker credentials via environment variable:** `ZEROENTROPY_API_KEY` and `OPENROUTER_API_KEY` are now read from the environment. Config file `zeroEntropyApiKey` / `openrouterApiKey` still works as fallback. Recommended setup puts the key in a shell env file so it never lands in config-under-version-control.
- **Recommended operator tuning refreshed:** suggested full-deployment config lowered `warmHistoryBudgetFraction` to 0.27 and `budgetFraction` to 0.55, with corresponding fact/history/keystone trims. Produces steadier turn-over-turn pressure on long-running agent fleets and avoids the tight warm→trim→compact cycling that the previous richer defaults encouraged on 200k+ models. Existing deployments with custom configs are unaffected.
- **`contextWindowSize` retired from recommended config:** runtime autodetection from the active model identifier is stable; manual override is no longer suggested. The field is still honored if present for back-compat.
- **Phase C correctness cluster:** tool result guards (C1), budget cluster drop telemetry, oversized artifact degradation with canonical reference format, unified pressure accounting, replay recovery isolation. Prompt-path verification harness proves Phase C behavior in real gateway flow.
- **Tool-artifact store:** durable tool result storage for wave-guard (Sprint 2.1 active-turn hydration, Sprint 2.2 retention sweep + sensitive-artifact flag). Tool results survive compaction cycles.
- **Fleet registry seeding on startup:** fleet agents seeded from known identity files on every gateway start. No cold-start gaps in registry state after deploy.
- **Tiered contradiction resolution (V19):** auto-supersede at ≥0.80 confidence, `invalidateFact` at 0.60–0.80, log-only below 0.60. Background indexer records contradiction audits. Schema v19.
- **Dreaming promoter temporal-marker screen:** blocks durable promotion of time-bound facts without `validFrom`/`invalidAt` metadata. Prevents stale temporally-anchored facts from polluting the durable fact store.
- **MEMORY.md authoring guide:** `docs/MEMORY_MD_AUTHORING.md` documents the static-vs-dynamic fact contract for operators and agents.
- **B4 model-aware budgeting:** compositor resolves token budget from active model string when the runtime does not pass `tokenBudget` explicitly. Budget recomputes on mid-session model swap.
- **BLAKE3 content dedup + RRF fusion:** O(1) fingerprint dedup across all retrieval paths. RRF merges FTS5 and KNN results. Zigzag ordering balances recency and relevance in composed output.

## 0.7.0 — Temporal validity, expertise storage, contradiction detection

- **Temporal validity engine:** facts expire, get superseded, and decay over time. Stale knowledge auto-deprioritized in retrieval.
- **Expertise store:** per-agent skill/domain tracking. Agents accumulate domain proficiency through indexed interactions.
- **Contradiction detector:** flags conflicting facts at ingest time. Newer evidence supersedes older, with audit trail.
- **Maintenance APIs:** programmatic access to compaction stats, index health, and storage diagnostics.
- **CI pipeline:** Redis removed, memory-plugin build stage added, monorepo file-ref wiring.

## 0.6.2 — Turn DAG, identity scrub, fleet customization

- Turn DAG phases 1–3: DAG-native reads, context-scoped recall, fence downgrade.
- Fleet name substitution for public distribution.
- Fleet customization guide and single-agent install docs.

## 0.6.0 — Redis removal complete

- SQLite-only cache layer replaces Redis entirely. Zero external service dependencies.
- Simplified deployment: single binary + SQLite files.

## 0.5.6 — Content fingerprint dedup and hardening

- O(1) fingerprint dedup across all retrieval paths (temporal, open-domain, semantic, cross-session). Catches rephrased near-duplicates that substring matching missed.
- Identity bootstrap pre-fingerprinting: SOUL.md, USER.md, IDENTITY.md content already in the prompt is never double-injected by retrieval.
- Indexer circuit breaker with startup integrity check for library.db corruption. Graceful degradation, not cascading failure.
- SQL parameterization hardening on datetime and FTS5 paths.

## 0.5.5 — Tuning collapse and config schema

- Plugin config schema: all tuning knobs declarable in `openclaw.json`. No more manual config.json edits.
- Tuning simplified to 4 primary knobs: `budgetFraction`, `reserveFraction`, `historyFraction`, `memoryFraction`.
- Identity and doc chunk dedup against OpenClaw bootstrap injection.
- Window cache with freshness diagnostics.

## 0.5.0 — SQLite hot-cache transition and context engine

- SQLite `:memory:` hot cache introduced for the runtime hot layer. Redis compatibility artifacts still existed at this stage, full removal completed in 0.6.0.
- Context engine plugin: runs as an OpenClaw `contextEngine` slot, composing prompts per-turn.
- Transform-first assembly: tool results compressed before budget allocation, not after.
- Cluster-aware budget shaping: related tool turns grouped and trimmed together.
- Hybrid FTS5 + KNN retrieval with Reciprocal Rank Fusion.
- Workspace seeding: agents auto-ingest their workspace docs on bootstrap.
- Runtime profiles: `light`, `standard`, `full`.
- Obsidian import and export.
- Metrics dashboard primitives.

## 0.4.0 — Eviction and migration

- Image and heavy-content eviction pre-pass in assembly. Old screenshots and large tool outputs aged out before they compete for budget.
- Engine version stamps in library.db. Schema migration runs automatically on version bump.
- Migration guides and scripts for Cognee, QMD, Mem0, Zep, Honcho, and raw MEMORY.md files.

## 0.3.0 — Subagent context and retrieval

- Subagent context inheritance: spawned subagents get bounded parent context, session-scoped docs, and relevant facts.
- Tool Gradient v2: turn-age tiers with head+tail truncation on tool results.
- Cursor-aware indexer with ghost message suppression.

## 0.2.0 — Retrieval access control

- Trigger registry ownership and auditability.
- Retrieval access control, trigger fallback paths, and history rebalance.

## 0.1.0 — Core architecture

- Four-layer memory: in-memory cache, message history, vector search, structured library.
- 8-level priority compositor with slot-based prompt assembly.
- Cross-agent memory access with visibility-scoped permissions.
- Knowledge graph with DAG traversal.
