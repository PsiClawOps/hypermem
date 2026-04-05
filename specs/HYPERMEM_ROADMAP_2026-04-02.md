# HyperMem Roadmap — 2026-04-02

**Author:** Forge  
**Status:** Active  
**Principle:** Stability first. Ship phases in order. Don't start Phase 2 until Phase 1 is closed.

---

## Phase 1 — Stabilization Completion
_Close out all P1 items from the April 2 stabilization plan. These are stability and correctness items, not features._

### P1.1 — Plugin build in CI (false-green state)
**Problem:** Root tests pass green but plugin typecheck failures are invisible to CI. A broken plugin can ship undetected.  
**Fix:** Add plugin build step to CI pipeline — `cd plugin && tsc --noEmit` must be a required gate before merge.  
**Owner:** Forge  
**Effort:** Small  

### P1.2 — Plugin type unification
**Problem:** `plugin/src/index.ts` re-declares types that exist in HyperMem core (e.g. `historyDepth`, `prompt`). Drift between the two caused real bugs (Incidents 3, 6). The plugin should import from core, not shadow it.  
**Fix:** Remove duplicate type shims in plugin. Import `CompositorConfig`, `ComposeRequest`, `NeutralMessage`, etc. directly from `@psiclawops/hypermem`.  
**Owner:** Forge  
**Effort:** Small-medium  
**Dependency:** P1.1 (CI must catch regressions)

### P1.3 — Cursor SQLite dual-write (Gate 2)
**Problem:** Session cursor lives only in Redis with a 24h TTL. If Redis is flushed or evicted, the cursor is lost and the compositor has no submission pointer. The cursor tells the background indexer what's new — losing it means potentially re-indexing already-indexed content.  
**Fix:** Dual-write cursor to `messages.db` after each compose. On Redis miss, read from SQLite as fallback. TTL is a safety net, not the source of truth.  
**Schema:** Store cursor on the `conversations` row (not a separate table). 1:1 mapping with `session_key`. Columns: `cursor_last_sent_id`, `cursor_last_sent_index`, `cursor_last_sent_at`, `cursor_window_size`, `cursor_token_count`. Conflict resolution: trust newer `cursor_last_sent_at` if Redis and SQLite disagree.  
**Owner:** Pylon  
**Effort:** Medium  
**Gate:** Gate 2 from stabilization plan

### P1.4 — defaultOrgRegistry audit (Gate 3)
**Problem:** `defaultOrgRegistry()` in `src/cross-agent.ts` is a hardcoded fleet snapshot. As of Pylon's review (2026-04-02), Plane/Vigil/Crucible/Relay are already present — the stabilization plan text was stale. The real risk is ongoing drift as fleet grows.  
**Fix:** Reframe as a drift audit: compare hardcoded registry against `fleet_agents` in library.db and verify they agree. Any agent in the DB but not in the hardcoded registry gets restrictive-default visibility silently. Track live-load replacement as the permanent fix (see Deferred section).  
**Owner:** Gauge or Pylon  
**Effort:** Small (audit + drift check) + Medium (live-load follow-on, deferred)

### P1.5 — JOB.md + MOTIVATIONS.md → L3 retrieval
**Status note (Pylon review 2026-04-02):** `src/seed.ts` already maps `JOB.md → identity/job` and `MOTIVATIONS.md → identity/motivations`. Basic seeding/indexing is already done.  
**Remaining work:** Verify retrieval triggers and coverage quality — confirm these collections surface during semantic recall on messages touching agent scope, priorities, or behavioral constraints. If recall quality is adequate, close this item. If not, improve the trigger/scoring logic.  
**Owner:** Forge  
**Effort:** Small (verify) or Small-medium (improve triggers if needed)

### P1.7 — Background indexer TaskFlow integration
**What:** Register HyperMem's background indexer as a managed OpenClaw TaskFlow via `api.runtime.taskFlow`. Currently the indexer runs as a fire-and-forget timer — invisible, unmonitorable, unrecoverable.
**Why:** Operational observability. `openclaw tasks list` will show indexer runs, stuck detection will surface hangs, and `openclaw tasks flow show` gives state between runs. Cancel/recovery primitives if it gets into a bad state.
**Scope:** Plugin only — `plugin/src/index.ts`. No changes to indexer logic itself.
**Secondary use case:** Long-running ops (full re-index, org registry audit) can be spawned as managed tasks instead of fire-and-forget subagents.

### P1.6 — Supersedes_check in background indexer
**Problem:** When a new fact supersedes an old one, the `supersedes` chain is written to library.db. But the background indexer doesn't check for this — it may re-surface superseded facts in semantic recall if their vectors are still in the index.  
**Fix:** In `background-indexer.ts`, after fact extraction, check for `supersedes` references and tombstone the old vector entries in `vec_facts`. Query: `DELETE FROM vec_index_map WHERE source_table = 'facts' AND source_id = ?` for any superseded fact id.  
**Owner:** Forge  
**Effort:** Medium

---

## Phase 2 — Context Quality
_Builds on stable Phase 1 foundation. Focused on making the context window smarter, not just larger._

### P2.1 — Keystone history slot
**Spec:** `specs/KEYSTONE_HISTORY_SLOT.md`  
**What:** New compositor slot that scores messages by reference density × decisional weight and inserts the highest-signal historical messages above the recency window. Age is not a proxy for value — a founding decision from 80 turns ago outranks 20 turns of implementation chatter.  
**Slot order after this:** System → Identity → Tripwires → Facts/Knowledge → Semantic recall → **Keystone** → Recent verbatim → Tool gradient → Text-only → Cross-session  
**Implementation note (Pylon review):** Ship heuristic-first. Thresholds conservative. Additive — does not replace recency/history logic. Tests must cover false-positive control so keyword-heavy chatter doesn't get promoted. P2.2 classifier port improves decisional weighting without blocking this first implementation.  
**Owner:** Forge  
**Effort:** Full day including tests

### P2.2 — Port content type / durability classifier from ClawText
**What:** ClawText has `content-type-classifier.ts` and `durability-classifier.ts` — classifies messages by signal value (decision, question, acknowledgment, tool result, etc.). Keystone scoring (P2.1) needs this to assign decisional weight without pure keyword heuristics. Port to HyperMem, adapt to `NeutralMessage` interface.  
**Owner:** Forge  
**Effort:** Medium  
**Dependency:** P2.1 (keystone uses it immediately)

### P2.3 — Port proactive passes from ClawText
**What:** ClawText runs noise sweep + tool decay passes in the background between turns, not just at compose time. HyperMem currently does all cleanup at compose time — which is correct but means storage accumulates noise until compose. Background passes keep storage lean and compose fast.  
**Port:** `proactive-pass.ts` (noise sweep + tool decay) adapted to HyperMem's message schema and background indexer scheduling.  
**Owner:** Forge  
**Effort:** Medium

---

## Phase 3 — Sessionless Architecture
_The architecturally significant work. Turns sessions into conversation topics. Agents think in work threads, not connection lifetimes._

### P3.1 — Content type classifier integrated with topic detection
**What:** Use the ported content type classifier (P2.2) to classify messages into topics at ingest time. Heuristic-first — keyword patterns + entity clustering. No model calls.  
**Output:** `topic_id` assigned to each message at `afterTurn()` ingest.  
**Owner:** Forge  
**Effort:** Medium

### P3.2 — Schema v4: topic_id on messages
**What:** Add `topic_id` column to `messages` table in `messages.db`. Add `topics` table mapping topic_id → topic name + metadata. Migration from v3: all existing messages get `topic_id = NULL` (topic-unaware).  
**Owner:** Forge  
**Effort:** Small (migration is simple — nullable column, backward compatible)  
**Dependency:** P3.1

### P3.3 — Port session-topic-map + topic-anchors from ClawText
**What:** ClawText has working code for binding sessions to named topics (`session-topic-map.ts`) and maintaining durable per-topic state files with key decisions, history, and current status (`topic-anchor.ts`). Port to HyperMem, adapt storage to use `topics` table in library.db instead of flat files.  
**Owner:** Forge  
**Effort:** Medium  
**Dependency:** P3.2

### P3.4 — Topic-aware compositor
**What:** `getHistory()` gains a `topicId` parameter. When a topic is active, history is fetched scoped to that topic first, falling back to full session history. SQL-level composition: `SELECT * FROM messages WHERE conversation_id = ? AND (topic_id = ? OR topic_id IS NULL) ORDER BY created_at DESC LIMIT ?`. The compositor detects topic shifts from the inbound message and loads the right history window.  
**NULL fallback caution (Pylon review):** `topic_id IS NULL` is a transitional compatibility bridge, not a permanent first-class lane. Migration sequence: (1) add nullable column, (2) write topic IDs for new ingest only, (3) keep NULL fallback during transition, (4) once topic assignment is stable, backfill or narrow NULL inclusion rules to prevent legacy chatter bleeding into topic windows.  
**Schema placement (Pylon review):** `topics` table belongs in `messages.db` for session/compositor hot path. Cross-topic anchors/knowledge can be reflected into library.db as needed. Keeping hot session/topic mapping local avoids coupling compositor to shared DB on every turn.  
**Owner:** Forge  
**Effort:** Large  
**Dependency:** P3.2, P3.3

### P3.5 — Cross-topic keystone retrieval
**What:** Keystone slot (P2.1) extended to pull high-value messages from OTHER topics when their content is referenced in the current topic. A decision made in the "HyperMem stabilization" topic that's relevant to the current "sessionless architecture" topic surfaces automatically.  
**Owner:** Forge  
**Effort:** Medium  
**Dependency:** P2.1, P3.4

---

## Deferred (No Phase Assignment Yet)
_Real work, but not blocking stability or the phased roadmap. Revisit after Phase 2._

| Item | Notes |
|---|---|
| Model capability awareness in compositor | Compositor picks history depth / budget fraction based on declared model context window. Useful but not urgent — budget is currently static config. |
| Archive FIRST_FULL_COUNCIL_ROUND from all council workspaces | Housekeeping. Low memory impact now that HyperMem owns storage. Can be batched as a one-time maintenance run. |
| Live-load defaultOrgRegistry from library.db | Follow-on to P1.4 audit. Replace hardcoded registry with query. Gate 3 patch is the right first step. |
| Cursor indexer integration | Cursor currently written but not consumed by background indexer as high-signal boundary. P1.3 (durability) is prerequisite. |
| Plugin CI for all agents | Expand false-green fix (P1.1) to cover all agent plugin builds, not just hypermem-core. |
| P3.4 strict-mode backfill | Option B (NULL fallback) is live during transition. When topic assignment is stable, run backfill utility to assign topic_id to legacy NULL messages, then flip getHistory() to strict mode (remove `OR topic_id IS NULL`). Prerequisite: topic detection running for ≥2 weeks in production. |

---

## Summary

| Phase | Items | Status |
|---|---|---|
| **Phase 1 — Stabilization** | P1.1 CI, P1.2 type unif, P1.3 cursor durability, P1.4 org registry, P1.5 JOB/MOTIVATIONS, P1.6 supersedes | 🔴 In progress |
| **Phase 2 — Context Quality** | Keystone slot, content classifier port, proactive passes port | ⬜ Not started |
| **Phase 3 — Sessionless** | Topic detection, schema v4, topic map/anchors, topic compositor, cross-topic keystone | ⬜ Not started |
| **Deferred** | Model capability, archive council round, live org registry, cursor indexer | ⬜ Deferred |

---

_Stability is the prerequisite for everything. Phase 1 closes before Phase 2 opens._
