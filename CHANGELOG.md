# Changelog

All notable changes to HyperMem are documented here.

---

## [0.5.0] — 2026-04-09

### Breaking Changes

- **Redis removed.** HyperMem no longer requires or uses Redis. All session state, cursor tracking, and fleet cache have moved to SQLite. Existing installs: remove `redis` from your config and run the installer to migrate.

### Added

- **Benchmark suite** (`npm run benchmark`). Measures compose latency, retrieval precision, and slot fill rate. Results written to `benchmarks/results.json`. Baseline: compose P50 ~34ms, P99 ~81ms on a mature 847-turn session.
- **`deferToolPruning` config flag.** When `true`, HyperMem's internal tool gradient defers to OpenClaw's native `contextPruning` extension. Recommended for all Anthropic-backed agents. Set automatically by the installer when OpenClaw is detected.
- **Recency decay on fact scoring.** Facts now decay by age using an exponential curve (`halfLifeDays: 14` default). Prevents stale facts from crowding out recent signal.
- **Compound FTS5 indexes.** Added `(agent_id, content)` and `(agent_id, domain, content)` compound indexes on the knowledge and facts tables. Retrieval on filtered queries improved ~3x.

### Changed

- **Tool gradient is now a fallback, not primary.** When OpenClaw's `contextPruning` is active (`mode: "cache-ttl"`), HyperMem skips its own gradient pass. The two systems no longer fight over the same tool results.
- **Two-plugin architecture.** HyperMem now ships as two OpenClaw plugins: `hypermem` (context engine, fills `contextEngine` slot) and `hypermem-memory` (lightweight memory provider, fills `memory` slot). The memory plugin provides `memory_search` backed by hybrid FTS5 + KNN retrieval against library.db. Previously, a single plugin attempted to fill both slots.
- **`install.sh` now registers both plugin slots and load paths.** Adds `plugins.slots.contextEngine hypermem` and `plugins.slots.memory hypermem-memory` automatically on install. Previously required manual config.
- **Knowledge lint threshold raised.** `isQualityFact()` minimum content length raised from 40 to 60 chars. Removed ~12% additional low-signal entries in production validation.

### Fixed

- **Session dedup guard.** `sessionExists()` check now fires before bootstrap ingest, preventing duplicate history on session reload.
- **Empty session compositor isolation.** New agent compose calls no longer inherit warm session data from a prior agent in the same process.
- **`DEFAULT_TRIGGERS` export missing.** `dist/index.js` was not re-exporting `DEFAULT_TRIGGERS`, breaking consumers using custom trigger matching.

### Removed

- **Redis layer** (`src/redis-layer.ts`, `src/redis-integration.ts`). All functionality migrated to SQLite cache layer.
- **`hm.redis` public property.** Consumers using `hm.redis.*` must migrate to `hm.cache.*`.

### Deferred to 0.6.0

- D-009: Cross-slot dedup pass in compositor (Phase 1: exact hash, Phase 2: embedding similarity)
- D-008: LLM reflection passes for knowledge quality
- D-001: Topic backfill for historical NULL messages

---

## [0.4.x] — prior

See git log for pre-0.5.0 history.
