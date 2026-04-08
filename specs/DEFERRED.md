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

## D-008: LLM-Assisted Reflection Passes

**Status:** 🟡 DEFERRED — target v0.6.x  
**Added:** 2026-04-07  
**Requested by:** ragesaq  

### What

Replace or augment the current heuristic topic synthesis with optional LLM-generated
reflection passes. Instead of pattern-matching on ContentType + Keystone scores to
produce wiki pages, call the configured model to synthesize a richer narrative summary
when a topic closes or goes stale.

### Why deferred

Heuristic synthesis is complete and ships in 0.5.0. It does real work at zero inference
cost. LLM passes add richness but add per-synthesis latency and token cost — wrong
trade-off for the initial release. Start light, upgrade when heuristic limitations
are actually observed in production.

### Gate conditions (all must be true before proceeding)

1. v0.5.0 has been in production for ≥4 weeks
2. Heuristic synthesis quality has been evaluated (at least 50 topic pages reviewed)
3. Specific failure modes documented — what does heuristic miss that LLM would catch?
4. Inference cost model is understood (tokens per synthesis cycle × synthesis frequency)

### Shape (rough)

- `SynthesisMode: 'heuristic' | 'llm' | 'hybrid'` in `TopicSynthesizerConfig`
- `hybrid`: heuristic pass first, LLM enrichment only if heuristic confidence < threshold
- LLM call is async, non-blocking — heuristic page is written immediately, LLM enrichment
  replaces it when ready
- Model used for reflection is configurable and defaults to the agent's standard model
- Scheduled reflection: time-triggered (e.g. every 24h) in addition to staleness-triggered

### Risk

- Inference cost scales with synthesis frequency — need hard caps on calls per hour
- LLM reflection could introduce hallucinated connections between facts; need a
  confidence filter on enriched content before writing to knowledge table
- Cold-start: LLM reflection on sparse topics (< 5 facts) produces low-quality output;
  minimum fact threshold required before LLM pass fires

---

## D-007: Obsidian Vault Integration

**Status:** ✅ CLOSED — shipped in v0.5.0 (`f91dd68`, `f660f23`)  
**Added:** 2026-04-06  
**Closed:** 2026-04-07  
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

Shipped: `importVault()` + `watchVault()` (vault → hypermem), `exportToVault()` (hypermem → vault).
Full frontmatter, `[[wikilinks]]`, tag extraction, secret scanner, skip-unchanged. See `src/obsidian-watcher.ts` and `src/obsidian-exporter.ts`.
