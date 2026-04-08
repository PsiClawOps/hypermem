# hypermem Deferred Items

Items that are explicitly scoped out of current work but must be tracked for future action.
Each entry documents the decision, the gate condition, and the implementation plan.

---

## D-001: Strict Topic Mode — Legacy NULL Message Backfill

**Status:** 🟡 DEFERRED  
**Added:** 2026-04-05  
**Relates to:** Topic detection (topic-detector.ts, session-topic-map.ts)

### What

Once topic detection has been running in production for ≥2 weeks, run a one-time backfill
to assign `topic_id` to historical messages that have `topic_id = NULL`. After the backfill,
narrow `getRecentMessagesByTopic()` to exclude NULL rows so that all topic-scoped queries
return only topically-attributed messages.

### Why deferred

Topic detection is still early. The classifier needs stabilization before backfill is safe:
- False positives during the warm-up period would mis-tag legacy messages permanently
- Coverage below 80% on new messages means the classifier isn't reliable enough to trust
  for bulk historical attribution

### Gate conditions (all must be true before proceeding)

1. Topic detection has been live in production for ≥2 weeks
2. Coverage: ≥80% of new incoming messages receive a non-NULL `topic_id`
3. False positive rate (mis-tagged messages, sampled): <5%
4. No active topic-schema migrations in flight

### Implementation plan

1. Add a `backfillTopicIds()` function in `src/topic-store.ts` (or a migration script)
   that iterates messages with `topic_id IS NULL`, runs topic detection on their content,
   and writes the detected topic_id.
2. Run as a one-time migration gated by `system_state` flag `topic_backfill_v1` (same
   pattern as the episode vector backfill).
3. After backfill, update `getRecentMessagesByTopic()` query to add `AND topic_id IS NOT NULL`
   so strict mode is enforced.
4. Add a feature flag in `IndexerConfig` (`strictTopicMode: boolean`) so the behavior
   can be toggled without a code deploy.

### Risk

- Bulk writes to messages.db during backfill could cause I/O contention; run in small
  batches with a sleep between pages.
- If topic detection changes (retrain, threshold adjustment), backfilled labels may become
  stale. Document that the backfill is a one-time snapshot, not a live link.

---

## D-002: Cursor Durability (SQLite Dual-Write)

**Status:** ✅ CLOSED  
**Added:** prior  
**Closed:** 2026-04-05  
**Relates to:** background-indexer.ts, cursor handling

Done. `getSessionCursor()` in `src/index.ts` implements Redis → SQLite fallback with
Re-warm on miss. Background indexer consumes cursor via `CursorFetcher` callback, splits
messages into post-cursor (unseen, high priority) and pre-cursor (seen, lower priority).
See lines 629-651 of `src/background-indexer.ts`.

---

## D-003: Plugin Type Unification

**Status:** ✅ CLOSED  
**Added:** prior  
**Closed:** 2026-04-05  
**Relates to:** plugin/src/

Done. Plugin now imports `NeutralMessage`, `ComposeRequest`, `ComposeResult`, etc. from
`@psiclawops/hypermem`. Only plugin-specific types remain local (`InboundMessage` for
OpenClaw SDK message shape, `hypermemInstance` for dynamic import typing). No shadowed
types remain.

---

## D-004: Model Capability Awareness in Compositor

**Status:** 🟢 LOW PRIORITY  
**Added:** prior  

Compositor picks history depth / budget fraction based on `tokenBudget` from
`ComposeRequest`, which the caller (OpenClaw gateway) fills from the agent's configured
context window. The "awareness" gap is compositor-side model family detection to
adjust retrieval strategy (e.g., more semantic context for weaker models). Currently
not blocking anything — tokenBudget already adapts to model size.

---

## D-005: Plugin CI for All Agents

**Status:** 🟡 DEFERRED  
**Added:** prior  

Expand CI (`ci.yml`) to cover all agent plugin builds, not just hypermem-core.
Gate: additional plugins exist that need CI coverage.

---

## D-006: Archive FIRST_FULL_COUNCIL_ROUND

**Status:** 🟡 DEFERRED  
**Added:** prior  

Housekeeping. Archive the first full council round from all council workspaces.
Low memory impact now that hypermem owns storage. Can be batched as a one-time run.

---

## D-007: Obsidian Vault Integration

**Status:** 🟡 DEFERRED — target v0.5.0  
**Added:** 2026-04-06  
**Requested by:** ragesaq  

### What

Two-way sync between hypermem's knowledge/fact stores and an Obsidian vault directory.
Agents can read from the vault as a knowledge source and write back structured knowledge
as Obsidian markdown notes with YAML frontmatter.

### Shape (rough)

**Ingest direction (vault → hypermem):**
- Watch a configured vault directory for `.md` file changes
- Parse frontmatter (`tags`, `type`, `domain`, `confidence`, `visibility`) to map to
  `knowledge` or `fact` table entries
- Body text becomes the `content` field
- File mtime used as `source_ref` for versioning
- Configurable watch glob (e.g. `memory/**/*.md`, `decisions/*.md`)

**Writeback direction (hypermem → vault):**
- `exportKnowledge(domain)` serializes knowledge entries as Obsidian-formatted `.md`
- YAML frontmatter includes `hypermem_id`, `agent_id`, `confidence`, `visibility`
- Optional: populate `[[wikilinks]]` from knowledge graph links (supports/contradicts/related)
- Triggered manually or by an `afterTurn` hook if writeback is enabled

### Implementation plan

1. Add `VaultConfig` to `hypermemConfig` (optional, off by default):
   `{ path: string; watchGlob?: string; writeback?: boolean; domain?: string }`
2. New module: `src/vault-sync.ts` — file watcher + ingest parser + writeback serializer
3. Hook ingest into `BackgroundIndexer` startup if `vault.path` is configured
4. Writeback: export method on `KnowledgeStore`, callable by agents via tool or CLI
5. CLI: `openclaw hypermem vault export --domain <domain>` (uses registerCli)

### Gate conditions

- v0.4.x is stable in production (at least 2 weeks)
- Public API for knowledge-store is stable (no breaking changes planned)
- Obsidian Local REST API or file-watch approach decided (local filesystem is simpler;
  REST API approach requires the Obsidian Local REST Community Plugin)

### Risk

- File-watch on large vaults (10k+ notes) could be noisy; use debounced batch ingest
- Wikilink resolution requires knowledge graph to be populated first — cold-start gap
- Writeback formatting must survive round-trips (parse → write → parse → same data)
