# Topic Synthesis — Compiled Knowledge from Conversation

**Author:** Forge  
**Date:** 2026-04-05  
**Status:** Spec → Build  
**Inspired by:** [Karpathy's LLM Wiki Pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

---

## Problem

HyperMem *extracts* facts from conversation (pattern matching on paths, services, config).
It does not *synthesize* knowledge. When a topic closes or goes stale, the decisions,
context, and cross-references from that conversation are only retrievable via raw message
search or individual fact lookup. There's no compiled summary that captures the state of
a topic — what was decided, what's still open, what contradicts what.

Karpathy's insight: a wiki maintained by the LLM between raw sources (messages) and
query time (compose) compounds knowledge instead of re-deriving it every turn.

## Architecture Mapping

| Karpathy Layer | HyperMem Layer | Current State |
|---|---|---|
| Raw sources (immutable) | `messages.db` per agent | ✅ Live |
| Wiki (compiled, LLM-maintained) | `knowledge` table in `library.db` | Schema exists, zero rows |
| Schema (conventions) | Plugin config + trigger registry | ✅ Live |
| Index (catalog) | `knowledge` FTS + vector index | Schema exists, empty |
| Log (chronological) | `episodes` table | ✅ 19,950 rows |
| Lint (health check) | Not implemented | ❌ Gap |

## Design

### When synthesis runs

Topic synthesis is a **background indexer pass**, not a compose-time operation.
It triggers when a topic becomes "stale" — no new messages in the topic for N minutes.

**Trigger conditions (all must be true):**
1. Topic has ≥5 messages
2. No new messages in topic for 30 minutes (configurable: `SYNTHESIS_STALE_MINUTES`)
3. No existing synthesis for this topic version, or message count has grown by ≥5 since last synthesis
4. System is not under heavy load (indexer tick duration <5s)

### What synthesis produces

For each stale topic, the synthesizer generates a **topic wiki page** stored in the
`knowledge` table:

```
domain: "topic-synthesis"
key: "<topic_name>"  (e.g., "hypermem-tool-gradient-v2")
content: structured markdown (see format below)
source_type: "synthesizer"
source_ref: "topic:<topic_id>"
```

### Topic wiki page format

```markdown
# <Topic Name>

**Status:** active | resolved | stale
**Last activity:** <ISO timestamp>
**Messages:** <count>
**Participants:** <agent list>

## Summary
<2-4 sentence synthesis of the topic>

## Key Decisions
- <decision 1 with rationale>
- <decision 2 with rationale>

## Open Questions
- <unresolved question>

## Artifacts
- <file paths, configs, or outputs produced>

## Cross-References
- Related to: <other topic names>
- Contradicts: <if applicable>
- Depends on: <if applicable>
```

### How synthesis works (no model calls)

The synthesizer is **heuristic**, not LLM-based. It processes topic messages
using the content-type classifier (P2.2, already ported) and keystone scorer
(P2.1, already live):

1. **Classify messages** — content-type-classifier labels each message as
   decision, question, acknowledgment, tool-result, etc.
2. **Score messages** — keystone scorer ranks by reference density × decisional weight
3. **Extract structure:**
   - Decisions: messages classified as `decision` with significance ≥ 0.7
   - Questions: messages classified as `question` that have no subsequent `decision` response
   - Artifacts: file paths extracted from tool calls (read, write, edit targets)
   - Participants: unique agent_ids in the topic
4. **Build summary** — concatenate top-3 keystone messages (by score), truncated
5. **Cross-reference** — check other topic syntheses for shared entity terms (≥2 overlap)
6. **Write** — upsert into `knowledge` table; if content differs from previous version,
   the KnowledgeStore automatically creates a new version and marks the old one superseded

### Retrieval integration

The compositor already reads from the `knowledge` table (`buildKnowledgeFromDb()`).
Topic syntheses will surface automatically in the `## Knowledge` section when their
domain/content matches the current query. No compositor changes needed.

The vector store already indexes `knowledge` entries. When the synthesizer writes
a new knowledge entry, the next indexer tick will vectorize it, making it available
for semantic retrieval.

### Lint pass

A separate `lintKnowledge()` function runs on a lower-frequency schedule (every 10 ticks
instead of every tick):

1. **Stale syntheses** — topic synthesis older than 7 days with no new messages → mark stale
2. **Contradictions** — scan for knowledge entries in the same domain with opposing signals
   (heuristic: "decided NOT to" vs "decided to" on same key)
3. **Orphan topics** — topics with <3 messages that have been stale >48h → skip synthesis
4. **Coverage gaps** — topics with ≥20 messages but no synthesis → queue for next tick

### Configuration

```typescript
const SYNTHESIS_STALE_MINUTES = 30;      // Topic idle time before synthesis triggers
const SYNTHESIS_MIN_MESSAGES = 5;         // Minimum messages to synthesize
const SYNTHESIS_REGROWTH_THRESHOLD = 5;   // Messages since last synthesis to re-synthesize
const SYNTHESIS_MAX_SUMMARY_CHARS = 800;  // Summary section length cap
const SYNTHESIS_MAX_DECISIONS = 10;       // Max decisions to include
const SYNTHESIS_MAX_QUESTIONS = 5;        // Max open questions
const LINT_FREQUENCY = 10;               // Lint every N indexer ticks
const LINT_STALE_DAYS = 7;               // Synthesis staleness threshold
```

### File layout

```
src/topic-synthesizer.ts    — TopicSynthesizer class + extractors
src/knowledge-lint.ts       — lintKnowledge() function
```

### Integration points

- `background-indexer.ts` — call `synthesizer.tick()` after main indexer tick completes
- `KnowledgeStore` — already has `upsert()` with versioning semantics
- `ContentTypeClassifier` — already ported (P2.2)
- `KeystoneScorer` — already live (P2.1)
- `VectorStore` — already indexes knowledge entries

### What this does NOT do

- No LLM calls. Everything is heuristic. If quality isn't sufficient, a future phase
  can add optional model-assisted synthesis — but we start without it.
- No manual wiki editing. This is fully automated. Users read syntheses via the compositor
  or the `knowledge` table directly.
- No file-system wiki (no Obsidian integration). The wiki lives in SQLite, surfaced
  through the compositor's existing knowledge slot.

---

## Risk

- **Over-synthesis:** aggressive stale detection could generate low-quality pages for
  trivial conversations. Mitigated by min-message threshold (5) and significance filtering.
- **Cross-reference noise:** entity term overlap is imprecise. Start conservative (≥3 shared
  terms) and tune down if coverage is too low.
- **Knowledge table bloat:** each synthesis is a full markdown page (~500-1500 chars).
  At 195 topics, that's ~200KB max. Negligible.
