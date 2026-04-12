# Changelog

All notable changes to hypermem are documented here.

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

## 0.5.0 — Redis removal and context engine

- Redis replaced with SQLite in-memory cache. Zero external services.
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
