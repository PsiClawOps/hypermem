# hyper**mem**

*beyond memory, beyond speed*

---

Your agent has a memory problem, a speed problem, and a coherence problem. They are not three separate issues. They are the same architectural gap showing up three different ways.

Most memory systems bolt retrieval onto an existing pipeline. Records accumulate, summaries replace detail, and cold starts erase context that took hours to build. None of that is a model limitation. It is what happens when memory is treated as a feature instead of a foundation.

HyperMem is a complete context and memory engine for OpenClaw agents. Four storage layers, a budget-aware compositor, hybrid retrieval, and session warming — built together so each piece makes the others better.

```
L1  Redis         Hot session cache — sub-millisecond reads
L2  Messages DB   Per-agent conversation history (SQLite, rotatable)
L3  Vectors DB    Per-agent semantic search (sqlite-vec, 768d embeddings)
L4  Library DB    Fleet-wide structured knowledge, facts, episodes, registry
```

---

## What it solves

### Memory that survives sessions

When an agent restarts, it wakes up empty. Every prior decision, every established preference, every thread of ongoing work — gone. Operators compensate by re-explaining context at the start of every session. Agents compensate by asking clarifying questions they have asked before. The work is real; the memory is not.

HyperMem's session warming loads the agent's prior context from SQLite and Redis before the first turn. The agent picks up mid-conversation. It already knows what it was doing. Session continuity is no longer a function of uptime — it is a property of the architecture. Validated against the production fleet.

### Recall that finds what matters

Storing everything is not the same as being able to find anything.

HyperMem retrieves across four layers simultaneously. Full-text search (FTS5) catches exact matches. Vector similarity (KNN over 768-dimensional embeddings) catches semantic matches. Reciprocal Rank Fusion merges both into one ranked result set. Trigger-based retrieval fires on recognized query patterns; when no trigger matches, bounded semantic search runs as fallback so the memory slot is never empty.

The retrieval path is fast because the hot layer is fast. Benchmarked against a production DB with 3,482 facts and 19,853 episodes:

| Operation | avg | p50 | p95 |
|---|---|---|---|
| Redis single slot GET (identity, facts) | 0.10ms | 0.086ms | 0.16ms |
| Redis history LRANGE (100 messages) | 0.16ms | 0.13ms | 0.22ms |
| L4 facts query (top-28 by confidence×decay) | 0.29ms | 0.28ms | 0.31ms |
| L4 FTS5 keyword search | 0.08ms | 0.076ms | 0.11ms |
| Full 4-layer compose, warm session | 52ms | 49ms | 57ms |
| Full 4-layer compose, cold session (first turn) | ~250ms | — | — |
| Async pre-embed (background, not user-facing) | 302ms | 146ms | 725ms |

L1 and L4 structured retrieval are sub-millisecond. After the first turn, the query embedding is pre-computed in the background after each assistant reply and cached in Redis, so the next compose hits cache instead of calling Ollama inline. Warm sessions average 52ms end-to-end with a p95 of 57ms. The first turn of a new session pays the Ollama round-trip once; every turn after is warm. The async embed cost is paid after the assistant replies — the user never waits for it.

### Context that does not bloat or collapse

Raw transcript replay is a slow failure. Turns accumulate. The context window fills. The runtime fires compaction — summarizing recent history into a block that loses specifics, tool call detail, and the exact state of work in progress. The agent continues, but degraded.

HyperMem's compositor does not accumulate a transcript. It assembles context fresh from storage on every turn, allocating tokens across history, facts, semantic recall, doc chunks, and library data within a strict budget. Each slot gets a proportional cap. The total always fits. If you change your model's context window mid-session, the compositor adapts to the new budget on the next turn. There is no threshold that triggers compaction, because there is no transcript to compact.

### Tool-heavy conversations that stay coherent

Long agentic sessions produce a lot of tool output. File reads, search results, test runs — each one eats tokens. Left unmanaged, old tool results crowd out recent reasoning and current context.

The Tool Context Tuning feature compresses tool history by turn age. Recent turns stay verbatim. Older turns become prose stubs: `Read /src/foo.ts (1.2KB)`, `Ran npm test — exit 0`. The oldest turns drop tool payloads entirely, keeping message text. Large results use head-and-tail truncation with a middle marker. Redis hot history is recomputed from SQLite after each turn so the live cache stays aligned with the stored source of truth.

### Conversations that stay on track

Long sessions drift. An agent working on a database migration does not need the context from the deployment discussion two hours ago crowding out what it needs now. Without structure, history is just a pile — everything is equally available, which means nothing is prioritized.

HyperMem detects topic shifts automatically using heuristics: explicit subject-change markers, conversation gaps over 30 minutes, and entity overlap analysis between recent turns. When a shift is detected, the compositor scopes history to the active topic. Prior topic context does not disappear — when the current topic overlaps with a past decision, cross-topic keystone retrieval pulls high-signal moments from earlier threads into the current context window. The right history surfaces. The rest stays out of the way.

### Subagents that inherit context

Spawned subagents start cold by default. They do not know what the parent session was doing, which files were in scope, or what decisions preceded the spawn.

`buildSpawnContext()` snapshots recent parent turns, chunks and indexes session-scoped documents, and gives the spawned agent a bounded context block at compose time. Useful context carries forward. Session-scoped documents stay isolated from the shared library and are cleaned up after the spawn completes.

---

## Architecture

HyperMem plugs into OpenClaw as a context engine via the plugin interface. It owns the full prompt composition lifecycle:

1. **Ingest** — each turn is recorded to SQLite (L2) and mirrored to Redis (L1)
2. **Index** — conversations and workspace files are chunked and indexed for semantic retrieval (L3, L4)
3. **Assemble** — on every compose call, the compositor builds a fresh prompt from all four layers within the token budget
4. **Compress** — tool-heavy history is compressed by turn age; Redis is refreshed from SQLite source of truth after each turn
5. **Carry forward** — parent session context and scoped documents flow into spawned subagents

### Storage layers

**L1: Redis** is the hot layer. Identity, compressed session history, and fleet registry data live here. Reads are sub-millisecond. The compositor goes to Redis first on every compose call; L2–L4 fill gaps.

**L2: Messages DB** is the durable per-agent record. SQLite with WAL mode, auto-rotating at 100MB or 90 days. Full conversation history, token counts, and session metadata. Rotated archives stay readable for recall.

**L3: Vectors DB** is the semantic index. Per-agent sqlite-vec database with 768-dimensional embeddings from `nomic-embed-text`. KNN search over prior turns and indexed workspace documents. Rebuilt from L2 if lost.

**L4: Library DB** is the fleet-wide knowledge layer. One shared SQLite database with ten typed collections:

| Collection | What it holds |
|---|---|
| Facts | Verifiable claims with confidence scores, domain tags, expiry, and supersedes chains |
| Knowledge | Domain/key/value structured data with full-text search |
| Episodes | Significant events with impact scores and participant tracking |
| Topics | Cross-session thread tracking |
| Preferences | Operator behavioral patterns |
| Fleet Registry | Agent registry with tier, org, and capability metadata |
| System Registry | Service state and lifecycle |
| Work Items | Work queue with status transitions and FTS5 |
| Session Registry | Session lifecycle tracking |
| Desired State | Per-agent config targets with automatic drift detection |

### Compositor

The compositor is the engine that makes the four layers useful together.

On each turn it reads the incoming prompt, queries all four layers in parallel, applies per-slot token caps (history 65%, facts 15%, knowledge 10%, cross-session 10%), runs Tool Context Tuning on history, and assembles a provider-format context block. A safety valve runs post-assembly to catch estimation drift and trim if the total exceeds budget.

Because the budget is computed from the model's actual context window at compose time, a mid-session model swap — or a platform change to the model's limits — is absorbed on the next turn. The compositor adjusts. There is no accumulated state that needs to be re-summarized.

---

## Installation

**Recommendation: let your OpenClaw agent install this.** HyperMem's configuration varies by deployment shape — solo agent vs. multi-agent fleet — and the install surface has enough moving parts that manual setup is error-prone. Hand this to your agent:

> "Install HyperMem following INSTALL.md. I'm running a [solo / multi-agent] setup."

Full installation guide: **[INSTALL.md](./INSTALL.md)**

### Tuning the compositor

Drop a `~/.openclaw/hypermem/config.json` to override compositor defaults without editing plugin source. Any `compositor` key takes effect on the next gateway restart:

```json
{
  "compositor": {
    "defaultTokenBudget": 60000,
    "maxFacts": 18,
    "maxCrossSessionContext": 3000,
    "maxRecentToolPairs": 2,
    "maxProseToolPairs": 6
  }
}
```

The profile above targets roughly 35-45% token reduction for deployments on smaller context windows. INSTALL.md has a full tuning section with tradeoff notes for each knob.

### Quick path (manual)

```bash
# Clone and build
git clone https://github.com/PsiClawOps/hypermem-internal.git ~/.openclaw/workspace/repo/hypermem
cd ~/.openclaw/workspace/repo/hypermem
npm install && npm run build
npm --prefix plugin install && npm --prefix plugin run build

# Wire into OpenClaw
openclaw config set plugins.slots.contextEngine hypermem
openclaw config set plugins.load.paths '["~/.openclaw/workspace/repo/hypermem/plugin"]' --strict-json
openclaw gateway restart
```

Verify: `openclaw logs --limit 50 | grep hypermem` — you should see `[hypermem:compose]` lines on each turn.

**Requirements:**
- Node.js 22+
- OpenClaw (any version supporting context engine plugins)
- Redis 7+ (L1 hot session layer)
- Ollama + `nomic-embed-text` (L3 vector search)

---

## API

```typescript
import { HyperMem, buildSpawnContext, DocChunkStore, MessageStore } from '@psiclawops/hypermem';

const hm = await HyperMem.create({
  dataDir: '~/.openclaw/hypermem',
  redis: { host: 'localhost', port: 6379 },
  embedding: { ollamaUrl: 'http://localhost:11434', model: 'nomic-embed-text' },
});

const agentId = 'forge';
const sessionKey = 'agent:forge:webchat:main';

// Record a turn and compose context
await hm.recordUserMessage(agentId, sessionKey, 'How does drift detection work?');

const composed = await hm.compose({
  agentId,
  sessionKey,
  prompt: 'How does drift detection work?',
  tokenBudget: 4000,
  provider: 'anthropic',
});

// Refresh compressed Redis view after the turn completes
await hm.refreshRedisGradient(agentId, sessionKey);

// Spawn a subagent with parent context and scoped documents
const spawn = await buildSpawnContext(
  new MessageStore(hm.dbManager.getMessageDb(agentId)),
  new DocChunkStore(hm.dbManager.getLibraryDb()),
  agentId,
  {
    parentSessionKey: sessionKey,
    workingSnapshot: 12,
    documents: ['./specs/retrieval.md'],
  }
);

const subComposed = await hm.compose({
  agentId,
  sessionKey: 'agent:forge:subagent:review-1',
  parentSessionKey: spawn.sessionKey,
  prompt: 'Review the retrieval plan and find gaps.',
  tokenBudget: 4000,
  provider: 'anthropic',
});
```

---

## Data directory

```
~/.openclaw/hypermem/
├── library.db
└── agents/
    └── {agentId}/
        ├── messages.db
        ├── messages_2026Q1.db   (rotated archive)
        └── vectors.db
```

---

## Known limits

**Global-scope fact writes trust the caller.** Acceptable for a single-operator alpha. Not safe for untrusted multi-tenant deployments. Write authorization enforcement is on the roadmap before any multi-tenant release.

**Live background extraction is partly wired.** The extraction framework is complete and runs proactive noise sweeps and tool decay. Full per-turn LLM-driven fact and episode extraction from live conversations remains a follow-on step.

**Embedding model is fixed at `nomic-embed-text`.** Hot-swap is not yet implemented.

---

## Roadmap

- [ ] Live background extraction end to end
- [ ] Versioned atomic re-indexing
- [ ] `hypermem seed --workspace` CLI
- [ ] Live org registry (replace hardcoded fallback)
- [ ] Embedding model hot-swap

---

## License

Apache-2.0 — [PsiClawOps](https://github.com/PsiClawOps)
