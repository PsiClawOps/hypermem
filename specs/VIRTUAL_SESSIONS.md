# Virtual Sessions — Topic-Scoped Context Switching

**Author:** Forge
**Status:** Spec (Clarity + Anvil reviews integrated)
**Date:** 2026-04-05
**Prerequisite:** P3.1-P3.5 (topic detection, topic compositor, cross-topic keystone), P4.1-P4.2 (synthesis, lint)
**Reviewers:** Clarity (2026-04-05), Anvil (2026-04-05)

---

## Problem

Agents handle multiple concurrent threads of work within a single session. When a user shifts
from "HyperMem indexer quality" to "ClawDash deployment" and back, the agent loses working
context for the first topic. Today the compositor scopes history to the active topic (P3.4),
but there's no warming, no state preservation, and no cross-agent topic discovery.

## Design

Topics become **virtual sessions**: lightweight workspaces inside a single OpenClaw session,
each with their own cached context, wiki synthesis page, and working state. Switching between
them is seamless — the returning topic is pre-warmed from its cache + wiki, not cold-loaded.

### V1: Five features

#### VS-1: Topic-scoped Redis warming

**Current state:** Redis slots are keyed `hm:<agent>:s:<sessionKey>:<slot>`. One namespace
per session. When the topic changes, the old topic's context gets overwritten.

**Change:** Add a topic dimension to the cache key for topic-sensitive slots:

```
hm:<agent>:s:<sessionKey>:t:<topicId>:<slot>    # topic-scoped
hm:<agent>:s:<sessionKey>:<slot>                 # session-scoped (system, identity, meta — unchanged)
```

Topic-scoped slots: `history`, `window`, `cursor`, `context`, `facts`
Session-scoped slots (unchanged): `system`, `identity`, `tools`, `meta`

On topic switch:
1. Current topic's slots are already in Redis (written on last compose)
2. New topic's slots are checked — if present, serve from cache (warm hit)
3. If cold, warm from SQLite (existing `warmSession` path) filtered to the topic
4. Inject the topic's wiki synthesis page as a context fragment

TTL for topic-scoped slots: `sessionTTL` (4h). Inactive topic caches naturally expire.
Active topic cache is refreshed on every compose.

**Minimum message threshold (Anvil):** Topics with fewer than 3 messages use
session-scoped cache only. Topic-scoped Redis namespace is allocated only after
a topic reaches 3 messages. This caps the blast radius of noisy detection: a
false-positive topic creates a SQLite row but doesn't pollute Redis.

**Bulk cleanup (Anvil):** Add `clearAllTopicSlots(agentId, sessionKey)` that reads
topic IDs from SQLite (`listTopics`) and deletes all 5 known slot keys per topic in
a single Redis pipeline. Deterministic, O(topics x 5), no SCAN. Used on session
teardown and topic garbage collection.

**Old-key migration:** On first compose post-VS-1 deployment, session-scoped keys for
topic-sensitive slots (`history`, `window`, `cursor`, `context`, `facts`) are
invalidated. The compositor detects the migration state (no topic-scoped keys exist
yet) and forces a re-warm from SQLite into the new topic-scoped namespace. This is
a one-time cold start per session, equivalent to existing cold-compose latency (~250ms).

#### VS-2: Wiki synthesis as warming content

When switching to a topic, the compositor checks for a `topic-synthesis` knowledge entry
for that topic name. If found, it's injected as a `## Topic Context` block in the context
layer — between cross-session context and facts.

Format in the composed prompt:
```
## Topic Context: HyperMem indexer quality
[wiki synthesis content — summary, key decisions, open questions, artifacts]
```

The `topic-synthesis` knowledge type is registered in `KnowledgeStore` (domain:
`topic-synthesis`, source_type: `synthesizer`). See `src/knowledge-store.ts` for the
type definition and `src/topic-synthesizer.ts` for the write path.

This gives the agent immediate orientation when returning to a topic it hasn't touched
in hours. The wiki page is the compiled knowledge; the recent messages provide the
working thread. Together they reconstruct the virtual session state.

For the *current* active topic (not a switch), the wiki isn't injected — the recent
messages are sufficient context. Wiki injection fires only on topic transitions or when
returning to a topic after working on a different one.

#### VS-3: Natural topic switching with soft confirmation

**Current behavior:** `detectTopicShift()` fires in afterTurn, silently creates a topic.

**New behavior:** When the detector signals a new topic with confidence >= 0.7, the
plugin emits a `topicShift` event on the ComposeResult metadata. The agent (or a
prompt fragment) can surface this to the user:

```
[Topic shift detected: "ClawDash deployment" → confidence 0.82]
Switching context — I'll warm up the ClawDash thread. If this is still the same topic,
just say so and I'll stay put.
```

The confirmation is **soft** — the switch happens immediately (optimistic), but if the
user says "no, same topic," the next afterTurn merges the message back into the previous
topic and invalidates the new topic's cache. This avoids blocking the conversation for
confirmation while still giving the user a correction path.

Implementation:
- `ComposeResult.metadata.topicShift?: { from: string; to: string; confidence: number }`
- Plugin reads this in afterTurn and sets a `pending_confirmation` flag on the topic
- If the next user message is a correction ("no", "same topic", "still on X"), revert:
  1. `db.exec('BEGIN IMMEDIATE')` — wrap steps 1-3 in a single SQLite transaction
  2. Re-tag all messages assigned to the spurious topic back to the previous topic_id
  3. Increment the previous topic's message_count by the re-tagged count
  4. Delete the spurious topic row
  5. `db.exec('COMMIT')` — atomic: all three succeed or none do. Rollback on failure.
  6. Invalidate the spurious topic's Redis cache slots (fire-and-forget, TTL is backstop)
  7. Restore the previous topic as active (idempotent `activateTopic` call)
  No message orphaning: every message tagged during the optimistic window is accounted for.
  **Orphan guard (Anvil):** If the warm path returns data for a topicId that doesn't
  exist in SQLite, discard the data and delete the orphan Redis keys. Handles the edge
  case of process crash between step 5 (topic deleted) and step 6 (Redis invalidation).
- If the next message isn't a correction, clear the flag — switch is confirmed

#### VS-4: Cross-agent topic search

Topics in library.db are already agent-scoped but visible fleet-wide (`visibility: 'org'`).
Add a search interface:

```typescript
// In HyperMem public API
searchTopics(query: string, opts?: {
  agentId?: string;        // filter to specific agent (null = all agents)
  limit?: number;          // default 10
  minMessages?: number;    // minimum message_count (default 5)
  includeWiki?: boolean;   // return the synthesis page content (default false)
}): Array<{
  topicId: number;
  agentId: string;
  name: string;
  messageCount: number;
  lastActive: string;
  wikiContent?: string;    // if includeWiki and synthesis exists
}>
```

**Search indexing:** FTS5 index on `topics.name` + `topics.description` columns.
Ranking: BM25 on FTS match, boosted by `message_count` (log scale) and recency
(`updated_at` within 7 days gets 1.5x). When `includeWiki` is true, wiki content
is also FTS-searched with 0.5x weight (supplement, not primary signal).

This lets Pylon ask "what does Forge know about indexer architecture?" and get back
Forge's compiled topic pages, not raw message history.

**Privacy boundary:** Only `org`-visibility topics are searchable cross-agent.
Agent-private topics (future) would be excluded.

**RBAC dependency:** VS-4 ships with the org/private binary for V1. Full agent-level
visibility tiers (Goal 16, RBAC Phase 1) are a prerequisite for granular access
control. Add `checkReadPermission(topicId, requestingAgentId)` at the search
interface when RBAC lands. Until then, all org-visibility topics are readable by
all agents in the fleet.

**Synthesis content auditing:** Wiki synthesis pages are auto-generated and may
contain sensitive operational details. Before enabling cross-agent wiki content
retrieval (`includeWiki: true`), the synthesis quality gate (P4.2 knowledge lint)
must be validated as filtering sensitive content. V1 ships with `includeWiki: false`
as the default; operators opt in after audit.

#### VS-5: Fix topic detector noise

**Bug found during spec work:** The topic detector receives the full user message
content including metadata headers (timestamps, sender blocks, JSON metadata).
This creates garbage topics like "Sender untrusted metadata json label" and
"System 2026-04-05 02 07 21".

**Fix:** Strip known metadata patterns from the message text before passing to
`detectTopicShift()`. Patterns to strip:

1. `Sender (untrusted metadata):` JSON blocks
2. `[timestamp]` prefixes (ISO, human-readable)
3. ````json { "schema": "openclaw..." } ```  ` inbound metadata blocks

Add a `stripMessageMetadata(text: string): string` function in topic-detector.ts.
Call it as the first step in `detectTopicShift()`.

The stripping patterns are defined as a configurable array (`METADATA_PATTERNS`)
so future metadata formats can be added without code changes.

Also: the `message_count` increment path in afterTurn only fires when there's an
active topic AND the detector says "continue" — but new topic creation doesn't
increment. Fix: increment after createTopic too.

### Topic name normalization

All topic names are normalized before storage and search:
1. Lowercase
2. Whitespace collapsed to single spaces, leading/trailing stripped
3. Special characters stripped (keep alphanumeric, spaces, hyphens, underscores)
4. Truncated to 40 chars (existing behavior)

Normalization runs in `SessionTopicMap.createTopic()` and `searchTopics()` query
path. This ensures "HyperMem Indexer" and "hypermem-indexer" resolve to the same
topic for matching and deduplication.

**Dedup on create (Anvil):** `createTopic` checks for an existing topic with the same
normalized name in the same session before inserting. If found, activates the existing
topic instead of creating a duplicate. Check-then-insert runs inside the same SQLite
transaction to prevent TOCTOU races.

### What this does NOT do

- **Multi-session routing.** This is virtual sessions inside one real session. The
  gateway sees one session key. No routing changes needed.
- **Topic merging.** If two topics are actually the same, manual cleanup or a future
  lint pass handles it. No automatic merge.
- **Per-topic tool scoping.** All topics share the same tools. Tool scoping is a
  future extension if specific topics need restricted toolsets.
- **LLM-powered topic detection.** The heuristic detector is sufficient for V1.
  An LLM classifier is a Phase 5 option if false positive rates are too high.

## Implementation order

1. **VS-5** (bug fix) — fix detector noise + message_count. Small, high-value.
2. **VS-1** (Redis topology) — topic-scoped cache keys. Enables everything else.
3. **VS-2** (wiki warming) — inject synthesis on topic switch.
4. **VS-3** (soft confirmation) — topicShift event + optimistic switch + revert path.
5. **VS-4** (cross-agent search) — fleet-wide topic discovery.

## File changes

| File | Change |
|---|---|
| `src/topic-detector.ts` | `stripMessageMetadata()`, fix entity extraction |
| `src/redis.ts` | Topic-scoped key generation, `topicSessionKey()` method |
| `src/compositor.ts` | Wiki injection on topic switch, topic-scoped history/window |
| `src/session-topic-map.ts` | `pending_confirmation` flag, revert logic |
| `src/index.ts` | `searchTopics()` public API |
| `plugin/src/index.ts` | topicShift metadata, soft confirmation handling, message_count fix |
| `test/virtual-sessions.mjs` | Full test suite |

## Risk

- **Redis key proliferation:** Each topic adds ~5 keys per session. With 10 topics per
  session and 16 agents, that's ~800 keys. Well within Redis capacity. TTL handles cleanup.
  **Monitoring:** Alert if sustained key count exceeds 1,000 (indicates TTL misconfiguration
  or topic explosion). Check via `redis-cli DBSIZE` or Prometheus redis_db_keys gauge.
- **False topic switches:** The soft confirmation path mitigates this. Worst case: agent
  announces a switch, user corrects, context reverts. One turn of friction.
- **Topic explosion from gradual drift (Anvil):** Long conversations with subtle topic
  drift could create 15+ topics in an hour, each with 2-3 messages. The minimum message
  threshold (3 messages before Redis allocation) caps Redis impact. The 0.7 confidence
  threshold needs production calibration: track false positive rate for 2 weeks post-ship,
  then adjust. Consider raising to 0.8 if rate exceeds 20%.
- **Wiki cold start:** New topics won't have synthesis pages for 30+ minutes (stale threshold).
  The warming path gracefully degrades — no wiki, just recent messages. Same as today.
- **Topic cache TTL expiry mid-conversation:** If a topic cache expires (4h TTL) while the
  user is still in a session, the next compose for that topic triggers a transparent re-warm
  from SQLite. No user-facing message — the latency increase is ~200ms (cold compose path),
  which is within acceptable bounds. This is the same path as session warming on first turn.

## Metrics (post-ship)

- Topic switch rate per agent per hour
- Wiki cache hit rate on topic switch
- False positive rate (user corrections after soft confirmation)
- Cross-agent topic search volume
