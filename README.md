# hyper**mem**

*beyond memory, beyond speed*

---

Your agent forgets. Not because the model is broken — because nothing in the default stack was built to prevent it.

Context accumulates, gets summarized, loses specifics. Sessions end and the agent wakes up empty. Tool output crowds out reasoning. The wrong history is in the window at the wrong time. These are not edge cases. They are the natural failure modes of treating memory as an afterthought.

OpenClaw already gives agents a solid baseline: workspace memory files, hybrid file search, and compaction safeguards. hyper**mem** goes deeper. It replaces transcript accumulation with a context engine that assembles prompts fresh from storage on every turn — purpose-built to eliminate each failure mode at the source.

```text
L1  Redis         Hot session cache, identity, compressed recent history
L2  Messages DB   Per-agent conversation history in SQLite
L3  Vectors DB    Per-agent semantic search with sqlite-vec embeddings
L4  Library DB    Fleet-wide structured knowledge, facts, episodes, registry
```

---

## What it solves

### Agents that never forget

When an agent restarts, it wakes up empty. Decisions made, preferences established, work in progress — gone. Operators re-explain context. Agents ask questions they have already asked. The work is real. The memory is not.

hyper**mem** warms sessions from SQLite and Redis before the first turn. The agent picks up mid-conversation. Session continuity is no longer a function of uptime — it is a property of the architecture.

### Context that never collapses

Transcripts grow. Windows fill. Runtimes compact history into a summary — and specifics, tool detail, and work state get lost in the process. The agent keeps going, but degraded.

hyper**mem** never reaches that cliff. It assembles context fresh on every turn inside a strict token budget. History, facts, recall, and library data compete for tokens intentionally. If the model window changes mid-session, the compositor adapts on the next turn. There is no accumulated transcript to compress.

### Retrieval that actually finds things

Storing everything is not the same as being able to find anything.

FTS5 full-text search catches exact matches. KNN vector search catches semantic matches. Reciprocal Rank Fusion merges both into one ranked result. Trigger-based retrieval handles known patterns. When no trigger matches, bounded semantic fallback keeps the memory slot from coming back empty.

### Tool output that doesn't take over

Long agentic sessions generate a lot of tool output. Left unmanaged, old results crowd out current reasoning.

Tool Context Tuning compresses by turn age. T0 turns stay verbatim under normal pressure. At projected occupancy above 80% with a large result (>40k chars), T0 is trimmed head-and-tail with a structured `[hypermem_tool_result_trim ... reason=oversize_turn0_trim]` note. T1 turns become short prose stubs: `Read /src/foo.ts (1.2KB)`, `Ran npm test — exit 0`. T2 and T3 turns drop payloads entirely, keeping message text. Large results keep the head and tail and cut the middle. For multi-agent fleets, compression is tier-aware: director and council agents preserve more context per pass, reflecting their coordination scope; specialists use a tighter cap to stay focused. The live Redis cache is refreshed from SQLite after each turn so it never drifts from the source of truth.

### Sessions that stay on topic

Long sessions drift. An agent deep in a database migration does not need deployment context from two hours ago competing for tokens.

hyper**mem** detects topic shifts with heuristics: explicit subject changes, long gaps, entity overlap between recent turns. When a shift is detected, history scopes to the active topic. Past context does not disappear — **keystone retrieval** pulls high-signal moments back in when they are relevant. Keystone scoring weighs turn age and content density: decisions, artifact references, and conclusions surface regardless of how many sessions ago they happened.

### Knowledge that outlasts the conversation

Most memory systems store what was said. hyper**mem** synthesizes what was learned.

When a topic goes quiet, hyper**mem** compiles the thread into a structured wiki page: decisions, open questions, artifacts, participants. This is classifier-driven — no LLM call required. Facts, episodes, and preferences written explicitly during the session are available immediately in structured storage. Per-turn automatic extraction from raw conversation text is on the roadmap. When the topic resurfaces, the agent gets a compact structured summary rather than a raw history replay. The conversation is gone. The knowledge it produced is not.

### Topic-aware context

Most memory systems treat a session as one flat stream. Long conversations drift, early context is trimmed, recent context dominates, and subject shifts create a blurry mix of conflicting state.

hyper**mem** makes topics first-class. Topic detection, topic-scoped history recall, topic-aware Redis warming, and synthesized wiki recall are in place today. When a topic resurfaces, the agent gets the relevant topic summary and scoped recall instead of a flat raw replay.

Full **Virtual Sessions** remain future work. Soft confirmation on ambiguous topic shifts, revert flow, and cross-agent topic search are planned for 0.6.0.

### History that remembers its highlights

Context trimming is a blunt instrument. When a session fills up, recent messages survive and old ones go — regardless of which turns actually mattered. A decision from three hours ago gets dropped. Tool noise from five minutes ago stays.

hyper**mem** scores turns for significance as they are recorded. High-signal moments — decisions, blockers, artifacts, established facts — are marked as keystones. When pressure trims the history window, keystones are preserved ahead of ordinary turns. When a topic shift occurs and history scopes to the new thread, keystones from past contexts are still eligible for recall — the agent keeps its landmarks even when the surrounding conversation is gone.

### Outputs you can verify

Agents confabulate. They make plausible-sounding claims that contradict stored facts, or execute tool calls without any grounded basis for the action. Neither failure is obvious from the transcript.

FOS/MOD (Fact-Oriented Synthesis / Moderation) is HyperMem's verification layer. Before a response is recorded, a classifier checks the content against the in-session fact corpus: unsupported claims are flagged, contradictions with established facts are surfaced in diagnostics, and a confabulation risk score is attached to the stored episode. Action verification applies the same check to tool calls before they fire — high-risk operations without grounded fact support surface in logs before execution. No LLM call required. All verification runs against the live L4 fact corpus.

FOS also injects output normalization directives into composed context via the `outputProfile` config key. Three tiers: `light` (~100 tokens), `standard` (~250 tokens), `full` (~400 tokens). The directives cover anti-sycophancy, prohibited vocabulary, length calibration, evidence hedging policy, and pagination rules — tuned to counteract the known output tendencies of the models in use. The tier is set once in config and applied on every compose turn.

### Subagents that hit the ground running

Spawned subagents start cold. They don't know what the parent was doing, which files were in scope, or what decisions preceded the spawn.

`buildSpawnContext()` snapshots recent parent turns, indexes session-scoped documents, and gives the spawned agent a bounded context block at compose time. Useful context carries forward. Session documents stay isolated from the shared library and are cleaned up when the spawn completes.

---

## Pressure management

hyper**mem** assembles context fresh on every turn, but a long-running session still accumulates history in its JSONL transcript and Redis window. When that grows large enough, incoming tool results have nowhere to land and get silently stripped. Four automatic paths handle this:

| Path | Trigger | Action |
|---|---|---|
| **Pressure-tiered tool-loop trim** | Any tool-loop turn | Measures projected occupancy before results land. Plans against a 120k baseline window regardless of actual provider context size. 75%: green zone, keep full. 80%: defensive — trim large results (>40k chars) head+tail with structured note. 85%: hard caution zone — trim on turn 0 and turn 1. Also trims the messages[] array returned to the runtime — this is what actually prevents stripping on the current turn, not just the next one |
| **AfterTurn trim** | Every turn at >80% | Pre-emptive headroom cut after the assistant replies, before the next turn arrives |
| **Nuclear compaction** | compact() at >85% | Cuts Redis to 25% budget and truncates JSONL to ~20% depth. Bypasses the normal reshape guard |
| **Density-aware JSONL truncation** | compact() | Counts tokens per message, not message count — catches large-message sessions that looked "fine" by count but were full by volume |
| **Pre-ingestion wave guard** | Any toolResult payload before recording | Truncates or skips large tool payloads before they enter the ingest path — prevents the ingest itself from adding pressure during high-volume agentic runs |

**The one thing these paths cannot fix:** a session whose JSONL transcript on disk is already at 98% when the gateway restarts. The JSONL loads into runtime context before any compaction runs. If your pre-restart session was large, you start at whatever pressure that JSONL represents. Check `session_status` immediately on startup. If you're above 85%, start a fresh session — don't attempt tool work.

**Pressure telemetry in logs:**
```
[hypermem-plugin] tool-loop trim: pressure=91.3% → target=50% (redis=43 msgs, messages=67 dropped)
[hypermem-plugin] compact: NUCLEAR — session at 118400/128000 tokens (92% full), deep-trimmed...
```

If you see `tool-loop trim` lines, the machinery is running. If results are still stripped after that log line appears, the session was past the recovery threshold before the trim ran — start fresh.

---

## How it works

1. **Record** each turn into SQLite and mirror hot session state into Redis.
2. **Index** conversations and workspace files for exact and semantic recall.
3. **Assemble** a fresh prompt from history, facts, document chunks, and library data within a strict budget.
4. **Tune** tool-heavy history by turn age so old payloads don't crowd out current work.
5. **Compile** stale topics into structured wiki pages for future recall without raw history replay.
6. **Carry forward** scoped context into subagents when a task needs a narrower working set.

### What runs automatically

No configuration required for any of these:

- **Background indexer** — indexes each session's turns for semantic recall after activity drops off
- **Topic synthesis** — compiles stale topics into structured wiki pages (classifier-driven, no LLM call)
- **Noise sweep** — removes low-signal or expired facts on a rolling basis
- **Tool decay** — compresses older tool history to free budget for current work
- **Proactive embedding** — pre-embeds new content so compose calls hit cache on subsequent turns
- **Keystone scoring** — evaluates each recorded turn for historical significance; high-signal turns are marked for preservation ahead of ordinary history during pressure trimming
- **Dreaming promoter** — after activity drops off, promotes high-signal facts and episodes from the hot Redis layer to pointer-format entries in MEMORY.md; no LLM call, classifier-driven

---

## Speed

Benchmarked against a production database: 3,482 facts, 19,853 episodes.

| Operation | avg | p50 | p95 |
|---|---|---|---|
| Redis single slot GET | 0.10ms | 0.086ms | 0.16ms |
| Redis history LRANGE (100 messages) | 0.16ms | 0.13ms | 0.22ms |
| L4 facts query (top-28 by confidence×decay) | 0.29ms | 0.28ms | 0.31ms |
| L4 FTS5 keyword search | 0.08ms | 0.076ms | 0.11ms |
| Full 4-layer compose, warm session | 52ms | 52ms | 57ms |
| Full 4-layer compose, cold session (first turn) | 249ms | 54ms | 1,592ms |
| Async pre-embed (background, not user-facing) | 302ms | 146ms | 725ms |

L1 and L4 structured retrieval are sub-millisecond. After the first turn, query embeddings are computed in the background and cached in Redis — warm compose averages 52ms with a p95 of 57ms. The cold p95 of 1,592ms happens exactly once per new session, then never again. The async embed cost is paid after the assistant replies; users never wait for it.

---

## Architecture

hyper**mem** plugs into OpenClaw as a context engine and owns the full prompt composition lifecycle.

**L1: Redis** is the hot layer. Identity, compressed session history, cached embeddings, topic-scoped session and recall state, and fleet registry data. The compositor goes here first on every turn.

**L2: Messages DB** is the durable per-agent record. SQLite with WAL mode, auto-rotating at 100MB or 90 days. Full conversation history and session metadata. Rotated archives remain readable for recall.

**L3: Vectors DB** is the semantic index. Per-agent sqlite-vec database with 768-dimensional embeddings from `nomic-embed-text`. KNN search over prior turns and indexed workspace documents. Reconstructable from L2 if lost.

**L4: Library DB** is the fleet-wide knowledge layer. One shared SQLite database:

| Collection | What it holds |
|---|---|
| Facts | Verifiable claims with confidence, domain, expiry, supersedes chains |
| Knowledge | Domain/key/value structured data with full-text search |
| Episodes | Significant events with impact scores and participant tracking |
| Topics | Cross-session thread tracking and synthesized wiki pages |
| Preferences | Operator behavioral patterns |
| Fleet Registry | Agent registry with tier, org, and capability metadata |
| System Registry | Service state and lifecycle |
| Work Items | Work queue with status transitions and FTS5 |
| Session Registry | Session lifecycle tracking |
| Desired State | Per-agent config targets; compares running config against desired at gateway startup and surfaces drift for operator review |

**Secret scanner** — Before any fact, episode, or knowledge entry with `org`, `council`, or `fleet` visibility is written to L4, hyper**mem** scans the content for credentials, API keys, tokens, and connection strings. Matches are downgraded to `private` scope rather than rejected — the write succeeds without the content reaching fleet-visible storage.

**The compositor** queries all four layers in parallel on each turn, applies per-slot token caps, runs Tool Context Tuning on history, and assembles a provider-format context block. A safety valve catches estimation drift and trims post-assembly. Because the budget is computed from the model's actual context window at compose time — resolved from the model string when the runtime doesn't pass `tokenBudget` explicitly — a mid-session model swap is absorbed on the next turn with no manual intervention. T0 is preserved verbatim up to 80% projected occupancy. At high pressure with a large result, T0 is trimmed head-and-tail with a structured trim note. Compression of older turns starts at T1.

---


## Requirements

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | `>=22.0.0` | Required for native `node:sqlite` module |
| **Redis >= 7.0.0** | L1 hot cache; local or remote |
| **ioredis** | `^5.4.1` | Installed automatically via npm |
| **sqlite-vec** | `0.1.9` | Bundled; no separate install needed |

**Runtime version constants** (importable from the package):
```typescript
import {
  ENGINE_VERSION,        // '0.5.0'
  MIN_NODE_VERSION,      // '22.0.0'
  MIN_REDIS_VERSION,     // '6.0.0'
  SQLITE_VEC_VERSION,    // '0.1.9'
  MAIN_SCHEMA_VERSION,   // 6  (hypermem.db)
  LIBRARY_SCHEMA_VERSION_EXPORT, // 12 (library.db)
} from '@psiclawops/hypermem';
```

Schema versions are stamped into each database on startup and checked on open. A database created by an older engine version will be migrated forward automatically. A database created by a newer engine version will throw on open.

---

## Installation

**Let your OpenClaw agent install this.** The configuration varies by deployment shape, and there are enough moving parts that manual setup is error-prone. Hand this to your agent:

> "Install hyper**mem** following INSTALL.md. I'm running a [solo / multi-agent] setup."

Full guide: **[INSTALL.md](./INSTALL.md)**

### Manual quick path

```bash
git clone https://github.com/PsiClawOps/hypermem.git ~/.openclaw/workspace/repo/hypermem
cd ~/.openclaw/workspace/repo/hypermem
npm install && npm run build
npm --prefix plugin install && npm --prefix plugin run build

openclaw config set plugins.slots.contextEngine hypermem
openclaw config set plugins.load.paths '["~/.openclaw/workspace/repo/hypermem/plugin"]' --strict-json
openclaw gateway restart
```

Verify: `openclaw logs --limit 50 | grep hypermem` — you should see `[hypermem:compose]` lines on each turn.

**Requirements:** Node.js 22+, OpenClaw with context engine plugin support, Redis 7+, Ollama with `nomic-embed-text`.

### Tuning

Drop a `~/.openclaw/hypermem/config.json` to override compositor defaults. Takes effect on gateway restart:

```json
{
  "compositor": {
    "defaultTokenBudget": 60000,
    "maxFacts": 18,
    "maxCrossSessionContext": 3000,
    "maxRecentToolPairs": 2,
    "maxProseToolPairs": 6,
    "contextWindowReserveFraction": 0.25,
    "outputProfile": "standard"
  }
}
```

`outputProfile` controls the FOS/MOD output normalization tier injected into each composed context. Valid values: `"light"` (~100 tokens — anti-sycophancy, em dash ban, AI vocab ban, length targets, evidence calibration), `"standard"` (~250 tokens — full directive set plus pagination and hedging rules), `"full"` (~400 tokens — complete output normalization for high-stakes or fleet-wide deployments). Default: `"standard"`.

Context presets ship as named profiles: `light`, `standard`, `full`. Import with `import { lightProfile, standardProfile, fullProfile } from '@psiclawops/hypermem'` and pass to `HyperMem.create()` as the base config.

This config targets ~35-45% token reduction for smaller context windows. Full tuning notes are in INSTALL.md.

---

## API

```typescript
import { hyper**mem**, buildSpawnContext, DocChunkStore, MessageStore } from '@psiclawops/hypermem';

const hm = await hyper**mem**.create({
  dataDir: '~/.openclaw/hypermem',
  redis: { host: 'localhost', port: 6379 },
  embedding: { ollamaUrl: 'http://localhost:11434', model: 'nomic-embed-text' },
});

// Record and compose
await hm.recordUserMessage('forge', 'agent:forge:webchat:main', 'How does drift detection work?');

const composed = await hm.compose({
  agentId: 'forge',
  sessionKey: 'agent:forge:webchat:main',
  prompt: 'How does drift detection work?',
  tokenBudget: 4000,
  provider: 'anthropic',
});

// Refresh tool compression after each turn
await hm.refreshRedisGradient('forge', 'agent:forge:webchat:main');

// Spawn a subagent with parent context
const spawn = await buildSpawnContext(
  new MessageStore(hm.dbManager.getMessageDb('forge')),
  new DocChunkStore(hm.dbManager.getLibraryDb()),
  'forge',
  { parentSessionKey: 'agent:forge:webchat:main', workingSnapshot: 12 }
);
```

---

## Data directory

```text
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

**Global-scope fact writes trust the caller.** The fleet registry, tier-aware composition, and cross-agent knowledge queries are all production. The specific gap: global-scope facts can be written by any agent with API access without authorization checks. Fine for single-operator deployments. Add write authorization controls before any multi-operator environment with untrusted agents — that is the one roadmap item blocking multi-tenant release, not the multi-agent story broadly.

**Automatic per-turn fact extraction is a future step.** Topic synthesis (classifier-driven wiki pages), noise sweep, and tool decay all run automatically. Per-turn LLM-driven extraction of facts and episodes from raw conversation text is a follow-on. Facts and episodes available today are those written explicitly during the session.

**Embedding model hot-swap is not yet implemented.** Current default is `nomic-embed-text`.

---

## Migration

hyper**mem** doesn't touch your existing memory data. Install it, switch the context engine, and migrate historical data on your own timeline — before or after switching.

Migrations are supported from any memory platform. Worked examples are included in the migration documentation for: **OpenClaw built-in memory, ClawText, Mem0, Honcho, QMD session exports, and Engram**.

All migration scripts default to dry-run. Nothing is written until you add `--apply`.

Operator guide: **[docs/MIGRATION_GUIDE.md](./docs/MIGRATION_GUIDE.md)**

> **For agents:** See [docs/AGENT_MIGRATION.md](./docs/AGENT_MIGRATION.md) for hyper**mem**'s data model, field-level semantics, and mapping examples for each platform. The scripts are helpers — the doc gives you enough to handle any format, including ones without a script.

---

## License

Apache-2.0 — [PsiClawOps](https://github.com/PsiClawOps)