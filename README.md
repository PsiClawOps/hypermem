<p align="center">
  <img src="assets/logo.png" alt="hypermem" width="283" />
</p>

<p align="center"><em>Coherent agents. Every session.</em></p>

---

hypermem is a runtime context engine for OpenClaw agents.

```bash
curl -fsSL https://raw.githubusercontent.com/PsiClawOps/hypermem/main/install.sh | bash
```


---

## The problem

Every LLM conversation is composed at runtime. The model sees only what's in the prompt. It has no memory of prior sessions, no access to decisions made last week, no awareness of work that happened before this context window opened.

Two questions make this concrete:

| Question | What the LLM has | What happens |
|---|---|---|
| *"What was Caesar's greatest military victory?"* | Training data | ✅ Answered correctly, no session context needed |
| *"What did we decide about the retry logic last week?"* | Nothing (prior session is gone) | ❌ The decision existed only in that session |

The difference isn't intelligence. It's what was in the prompt. Two failure modes follow:

**New-session amnesia.** The agent restarts and everything is gone. Decisions, preferences, work in progress: erased at the session boundary. Operators re-explain context. Agents re-ask questions already answered.

**Compaction crunch.** Long sessions fill the context window. The runtime summarizes to make room. Specifics (tool output, exact decisions, file paths) are lost in the summary. The agent keeps running, but degraded.

---

## What OpenClaw provides today

OpenClaw addresses both failure modes with structured guidance files injected into every session:

| File | What it contributes | Survives session restart? |
|---|---|---|
| `SOUL.md` | Agent identity, voice, principles | ✅ always injected |
| `USER.md` | User preferences, working style | ✅ always injected |
| `JOB.md` / `AGENT.md` | Task focus, project instructions | ✅ always injected |
| `MEMORY.md` | Hand-curated decisions, facts, patterns | ✅ if manually maintained |

These are powerful for identity and preferences. But the retry logic decision from last week? If nobody manually captured it into `MEMORY.md`, that session boundary erased it. The system is only as strong as its last manual update.

OpenClaw also ships compaction safeguards and hybrid file search. That's a solid baseline. It has limits.

---

## hypermem

Four storage layers, sub-millisecond retrieval, no external database services required. Runs entirely in-process with local Nomic embeddings; embeddings can run locally or via hosted providers.

| Layer | What it holds | Speed |
|---|---|---|
| **L1 In-memory** | What the agent needs right now. Identity, recent history, active state. | 0.08ms |
| **L2 History** | Every conversation, queryable and concurrent-safe. Per-agent. | 0.13ms |
| **L3 Semantic** | Finds related content even when the words don't match. | 0.29ms |
| **L4 Knowledge** | Facts, wiki pages, episodes, preferences. Shared across agents. | 0.09ms |

Everything is retained. Storage survives session boundaries. The retry logic decision from last week, the deployment preferences from last month, the architecture choices from day one: all queryable, all available for composition.

**Session warming.** Before the first turn fires, hypermem pre-loads the agent's full working state from the in-memory SQLite cache: recent history, facts ranked by confidence and recency, active topic context, cached embeddings for fast semantic recall. The agent's first reply draws from everything that was in scope at the end of the last session. The agent picks up where it left off.

---

## hypercompositor

Every memory system stores. Almost none compose.

Your agent has four layers of stored context, but what shows up in the prompt? How much of the token budget goes to stale content? Who decides what's relevant to this specific turn?

The hypercompositor queries all four layers in parallel on every turn and composes context within a fixed token budget. No transcript accumulates. No summary is ever needed. Amnesia isn't a storage problem; the memories exist, but nobody composed them into a coherent prompt. Compaction isn't inevitable; content that doesn't fit this turn stays in storage instead of being destroyed.

**Bigger context windows don't help if you fill them with stale history.**
128k tokens of stale history and irrelevant memory is worse than 32k of precisely selected content. 10 budget categories, priority-ordered, greedy-fill. Every token in the prompt earned its spot.

### What the model actually sees

Token budget allocation from a mature session (847 turns deep, 128k budget):

```
What the model sees (92k of 128k tokens, 72% utilization):

  ┌────────────────┬──────────────────────────┬──────────────┬───────────┬────────────┬────────────┬──────────────┬──────────┐
  │ id/sys/user    │ history                  │ recent tools │ keystones │ wiki/know. │ facts      │ recall/sem.  │ reserve  │
  │ tools 14,000   │ 46,000                   │ 10,000       │ 3,600     │ 2,600      │ 2,200      │ 1,600        │ 12,000   │
  │                │ 65-90 tool or 120-160    │              │           │            │ top ~28    │              │          │
  └────────────────┴──────────────────────────┴──────────────┴───────────┴────────────┴────────────┴──────────────┴──────────┘
   ◄────────────────────────────────────────────── 72% composed ──────────────────────────────────────────────►

What's in storage, not in this prompt:

  L2  847 turns stored          top 70-120 shown depending on turn density
  L3  28,441 indexed episodes   available via semantic search
  L4  5,104 facts               ranked by confidence × decay, top ~28 selected
  L4  847 knowledge entries     active-topic subset shown, rest on standby

  Everything stays in storage. The compositor picks what's relevant right now.
  Change the topic, and the next turn pulls different content from the same storage.
```

### Standard context engine vs. hypercompositor

```
Standard                                hypercompositor
────────────────────────────────        ────────────────────────────────
message → append to transcript          message → detect active topic
transcript full → trim oldest           query 4 storage layers in parallel
trimmed content → summarize (lossy)     budget allocator: 10 slots, fixed cap
send transcript to model                tool compression by turn age
model responds → append again           keystone guard + FOS profile
                                        composed prompt → model
     ┌──────────────────┐               model responds → afterTurn ingest
     │  loop until full  │               → write back to all 4 layers
     └──────────────────┘

When it fills:                          When budget is exceeded:
  content is lost permanently             content stays in storage
  summaries are lossy                     not selected for this turn
  no recovery path                        change topic back → retrieved again
```

| | Standard | hypercompositor |
|---|---|---|
| Context source | Growing transcript | 4 independent storage layers |
| When context fills | Trim + summarize (lossy) | Budget allocation (lossless storage) |
| Old decisions | Lost after compaction | Retrievable via keystones + semantic recall |
| Topic changes | All history competes equally | Scoped retrieval by active topic |
| Tool output | Stays until trimmed | Compressed by turn age (T0/T1/T2/T3) |
| Model swap mid-session | Re-count, hope it fits | Budget recomputed from new window size next turn |

High-signal turns are marked as keystones and survive pressure trimming ahead of ordinary history.

---

## What it solves

### Tool output that doesn't take over

Agentic sessions generate massive tool output. Left unmanaged, old results crowd out current reasoning. hypermem compresses tool history by age: recent results stay full, older results become stubs, the oldest drop payloads entirely. The budget goes to current work, not last hour's `npm test` output.

### Knowledge that outlasts the conversation

Most memory systems store what was said. hypermem synthesizes what was learned.

When a topic goes quiet, hypermem compiles the thread into a structured wiki page: decisions, open questions, artifacts, participants. When the topic resurfaces, the agent gets a compact structured summary rather than a raw history replay.

OpenClaw 2026.4.7 ships memory wiki for structured storage. hypermem goes further: wiki pages are synthesized automatically and injected by the compositor within token budget.

### Output normalization and verification

Agents confabulate and drift toward the defaults baked into their training. GPT-5.4 paginates and offers to elaborate. Sonnet over-lists. Gemini hedges. FOS (Fact-Oriented Synthesis) injects output normalization directives into composed context via the `outputProfile` config key. Three tiers:

| Profile | Tokens | Covers |
|---|---|---|
| `light` | ~100 | Anti-sycophancy, em dash ban, AI vocab ban, length targets, evidence calibration |
| `standard` | ~250 | Full directive set plus pagination rules and hedging policy |
| `full` | ~400 | Complete normalization for high-stakes or multi-agent deployments |

The same prompt, GPT-5.4, with and without `outputProfile: "light"`:

```
Prompt: "How should I size my context window budget for a long-running agent session?"

WITHOUT normalization (GPT-5.4 default):
Here are the key factors to consider when sizing your context window budget:

**1. Session depth**
Longer sessions accumulate more history...

**2. Tool output volume**
Agentic sessions generate significant tool output...

**3. Fact corpus size**
More stored facts means more retrieval candidates...

Would you like me to go deeper on any of these?

WITH outputProfile: "light":
For a 128k window: reserve 14k for identity/system, target 46k for history, 10k for recent
tool context, and leave ~30k as allocator reserve. hypermem handles slot competition
automatically -- set contextWindowReserve to your preferred floor and let the compositor fill.
```

FOS/MOD (Moderation) checks every response against the live L4 fact corpus before it is recorded. Unsupported claims are flagged, contradictions with established facts surface in diagnostics, and a confabulation risk score is attached to the stored episode.

### Subagents that hit the ground running

Spawned subagents inherit a bounded context block: recent parent turns, session-scoped documents, and relevant facts. Scope is isolated from the shared library. Documents are cleaned up on completion.

---

## Pressure management

hypermem composes context fresh on every turn, but a long-running session still accumulates history in its JSONL transcript. When that grows large enough, incoming tool results have nowhere to land and get silently stripped. Four automatic paths handle this:

| Path | Trigger | Action |
|---|---|---|
| **Pressure-tiered tool-loop trim** | Any tool-loop turn | Measures projected occupancy before results land; trims large results at 80%+ and truncates the messages[] array for the current turn |
| **AfterTurn trim** | Every turn at >80% | Pre-emptive headroom cut after the assistant replies, before the next turn arrives |
| **Deep compaction** | compact() at >85% | Cuts in-memory cache to 25% budget and truncates JSONL to ~20% depth. Bypasses the normal reshape guard |

**The one thing these paths cannot fix:** a session whose JSONL transcript on disk is already at 98% when the gateway restarts. The JSONL loads into runtime context before any compaction runs. Check `session_status` on startup. If you're above 85%, start a fresh session.

---

## How it works

1. **Record** each turn into SQLite and mirror hot session state into the in-memory cache.
2. **Index** conversations and workspace files for exact and semantic recall.
3. **Assemble** a fresh prompt from history, facts, document chunks, and library data within a strict budget.
4. **Tune** tool-heavy history by turn age so old payloads don't crowd out current work.
5. **Compile** stale topics into structured wiki pages for future recall without raw history replay.
6. **Carry forward** scoped context into subagents when a task needs a narrower working set.

### What runs automatically

No configuration required for any of these:

- **Semantic indexer:** indexes each session's turns for recall after activity drops off, pre-embeds new content so compose calls hit cache on subsequent turns
- **Topic synthesis:** compiles stale topics into structured wiki pages and promotes high-signal facts from the hot cache to pointer-format entries in MEMORY.md; both classifier-driven, no LLM call
- **Noise sweep:** removes low-signal or expired facts on a rolling basis
- **Tool decay:** compresses older tool history to free budget for current work
- **Keystone scoring:** evaluates each recorded turn for historical significance; high-signal turns are marked for preservation ahead of ordinary history during pressure trimming

---

## Speed

Benchmarked against a production database: 5,104 facts, 28,441 episodes, 847 knowledge entries, 42MB. 1,000 iterations, 50 warmup discarded, single-process isolation.

| Operation | avg | p50 | p95 |
|---|---|---|---|
| L1 slot GET (SQLite in-memory) | 0.08ms | 0.07ms | 0.13ms |
| L1 history window (100 messages) | 0.13ms | 0.11ms | 0.19ms |
| L4 facts (top-28, confidence × decay) | 0.28ms | 0.26ms | 0.36ms |
| L4 facts + agentId filter | 0.31ms | 0.29ms | 0.40ms |
| L4 FTS5 keyword search | 0.06ms | 0.05ms | 0.08ms |
| L4 FTS5 + agentId filter | 0.07ms | 0.06ms | 0.10ms |
| L4 knowledge query | 0.09ms | 0.08ms | 0.14ms |
| Recency decay scoring (28 rows, in JS) | 0.003ms | 0.002ms | 0.005ms |
| Async pre-embed (background, not user-facing) | 302ms | 146ms | 725ms |

> Query planner uses compound indexes on agentId + sort key; FTS5 performance improved 25% from baseline after index additions despite a 47% increase in stored data.

L1 and L4 structured retrieval are sub-millisecond. After the first turn, query embeddings are computed in the background and cached in the in-memory layer. The cold session p95 of 1,592ms happens exactly once per new session, then never again. The async embed cost is paid after the assistant replies; users never wait for it.

---

## Architecture

hypermem plugs into OpenClaw as a context engine and owns the full prompt composition lifecycle. It registers as both `contextEngine` and `memory`, providing the standard memory slot interface alongside full prompt composition: `memory_search` routes through the official slot and shows correctly in `openclaw plugins list`.

**L1: SQLite in-memory.** Sub-millisecond hot reads, no network dependency, no daemon, no retry logic. Identity, compressed session history, cached embeddings, topic-scoped session and recall state, and fleet registry data. The compositor hits this first on every turn.

**L2: Messages DB.** A single `MEMORY.md` file doesn't hold per-agent conversation history at scale. Thousands of turns across dozens of agents need queryable, concurrent-safe storage. Per-agent SQLite with WAL mode, auto-rotating at 100MB or 90 days. Full conversation history and session metadata. Rotated archives remain readable for recall.

**L3: Vectors DB.** Keyword search alone misses semantically related content. A decision recorded as "we chose exponential backoff" won't match a search for "what was the retry strategy" without vector similarity. Per-agent sqlite-vec database with KNN search over prior turns and indexed workspace documents. Reconstructable from L2 if lost. Supports two embedding providers: Ollama (local, default `nomic-embed-text`) or hosted via OpenRouter (recommended: `qwen/qwen3-embedding-8b`, 4096d, top of MTEB retrieval leaderboard).

Retrieval combines FTS5 full-text search (exact matches), KNN vector search (semantic matches), and Reciprocal Rank Fusion to merge both into one ranked result. Trigger-based retrieval handles known patterns; when no trigger matches, bounded semantic fallback keeps the memory slot from returning empty.

**L4: Library DB.** Per-agent storage can't hold shared knowledge. Facts established by one agent, wiki pages synthesized from cross-agent topics, fleet registry state: these belong to the system, not one agent. One shared SQLite database:

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

Facts are ranked by `confidence × recencyDecay`, where decay is exponential with a configurable half-life: recent, high-confidence facts float to the top while stale entries yield budget to newer knowledge.

**Secret scanner:** Before any fact, episode, or knowledge entry with `org`, `council`, or `fleet` visibility is written to L4, hypermem scans the content for credentials, API keys, tokens, and connection strings. Matches are downgraded to `private` scope rather than rejected; the write succeeds without the content reaching fleet-visible storage.

**The compositor** queries all four layers in parallel on each turn, applies per-slot token caps, runs Tool Context Tuning on history, and composes a provider-format context block. A safety valve catches estimation drift and trims post-composition. Because the budget is computed from the model's actual context window at compose time (resolved from the model string when the runtime doesn't pass `tokenBudget` explicitly), a mid-session model swap triggers a budget recompute on the next turn. Structured tool history is guarded from destructive persistence during a budget downshift. T0 is preserved verbatim up to 80% projected occupancy. At high pressure with a large result, T0 is trimmed head-and-tail with a structured trim note. Compression of older turns starts at T1.

```
  user message
       │
  topic detection ──► scope retrieval to active thread
       │
  ┌────┴────────────────────────────────────────────┐
  │              query 4 layers (parallel)           │
  │                                                  │
  │  L1 in-memory  L2 History    L3 Vectors  L4 Library │
  │  hot state    durable       semantic    facts/wiki │
  │  0.1ms        0.16ms        0.29ms      0.08ms     │
  └────┬────────────────────────────────────────────┘
       │
  budget allocator ──► 10 slots, fixed token cap
       │
  tool compression ──► progressive, recent stays full
       │
  keystone guard ──► high-signal turns survive pressure
       │
  FOS profile ──► output normalization directives
       │
  composed prompt
       │
  model response
       │
  afterTurn ──► write back to all 4 layers
```

Slot-level budget allocation is shown in the [hypercompositor diagram](#what-the-model-actually-sees) above. The 72% composition figure is typical for a warm mature session. Multi-agent sessions with active registry and cross-session wiki may run slightly higher.

---

## Requirements

**Current release: hypermem 0.5.0.** Topic-aware memory and compiled-knowledge system, optimized to run light by default and scale up when operators need richer context.

What 0.5.0 includes:
- Topic-aware context tracking
- Compiled knowledge / wiki-like synthesis and recall
- Metrics dashboard primitives
- Obsidian import and export
- Aligned runtime profiles: `light`, `standard`, `full`

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | `>=22.0.0` | Required for native `node:sqlite` module |
| **better-sqlite3** | `^11.x` | Installed automatically via npm; powers L1 in-memory and L4 library |
| **sqlite-vec** | `0.1.9` | Bundled; no separate install needed |

SQLite is a library, not a service. All four layers run in-process with no external daemons. The nomic embedder on Ollama is the heaviest component, and it is lighter than pgvector or any hosted vector database.

**Runtime version constants** (importable from the package):
```typescript
import {
  ENGINE_VERSION,        // '0.5.0'
  MIN_NODE_VERSION,      // '22.0.0'
  MIN_SQLITE_VERSION,    // '3.35.0'
  SQLITE_VEC_VERSION,    // '0.1.9'
  MAIN_SCHEMA_VERSION,   // 6  (hypermem.db)
  LIBRARY_SCHEMA_VERSION_EXPORT, // 12 (library.db)
} from '@psiclawops/hypermem';
```

Schema versions are stamped into each database on startup and checked on open. A database created by an older engine version will be migrated forward automatically. A database created by a newer engine version will throw on open.

---

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/PsiClawOps/hypermem/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/PsiClawOps/hypermem.git ~/.openclaw/workspace/repo/hypermem
cd ~/.openclaw/workspace/repo/hypermem
npm install && npm run build
npm --prefix plugin install && npm --prefix plugin run build

openclaw config set plugins.slots.contextEngine hypermem
openclaw config set plugins.slots.memory hypermem
openclaw config set plugins.load.paths '["~/.openclaw/workspace/repo/hypermem/plugin"]' --strict-json
openclaw gateway restart
```


**Requirements:** Node.js 22+, OpenClaw with context engine plugin support, and either Ollama (local) or an OpenRouter API key (hosted) for embeddings.

Full guide with deployment-specific options: **[INSTALL.md](./INSTALL.md)**

### Agent-assisted install

If you prefer, hand the install to your OpenClaw agent:

> "Install hypermem following INSTALL.md. I'm running a [solo / multi-agent] setup."

### Tuning

hypermem ships three aligned operating profiles: `light`, `standard`, and `full`. Pick one and set `outputProfile` in your config. Everything else follows.

| Profile | Context window | Budget fraction | Best for |
|---|---|---|---|
| `light` | 64k | 0.50 | Single-agent installs, minimal parallel work |
| `standard` | 128k | 0.65 | Normal OpenClaw deployments |
| `full` | 200k+ | 0.55 | Large-context or multi-agent installs, maximum richness |

**Start with `light`** on 64k models or single-agent systems. Move to `standard` once the system has stable latency and headroom. Use `full` only when you want maximum context richness and have the budget for it.

Primary tuning knobs:

- **`targetBudgetFraction`**: caps total non-history context weight. Lower values force lighter composition.
- **`wikiTokenCap`**: caps compiled-knowledge/wiki contribution.
- **`outputProfile`**: `light`, `standard`, or `full`. Controls how much FOS/MOD guidance is injected per turn.

Drop a `~/.openclaw/hypermem/config.json` to override compositor defaults. Takes effect on gateway restart:

```json
{
  "deferToolPruning": true,
  "compositor": {
    "defaultTokenBudget": 60000,
    "maxFacts": 18,
    "maxCrossSessionContext": 3000,
    "maxRecentToolPairs": 2,
    "maxProseToolPairs": 6,
    "contextWindowReserve": 0.25,
    "outputProfile": "standard"
  }
}
```

`deferToolPruning: true` tells hypermem to skip its own T0/T1/T2/T3 gradient when OpenClaw's native `contextPruning` extension is active (Anthropic and Google providers). On those providers, OpenClaw's pruner handles tool result trimming: ratio-driven at >30% context fill, soft-trim head+tail for results over 4,000 chars, hard-clear above 50k total, with the last 3 assistant turns always protected. HyperMem's gradient remains active as fallback for other providers (GPT-5.4, etc.). Default: `true` for Anthropic installs.

`outputProfile` valid values: `"light"` (~100 tokens: anti-sycophancy, em dash ban, AI vocab ban, length targets, evidence calibration), `"standard"` (~250 tokens: full directive set plus pagination and hedging rules), `"full"` (~400 tokens: complete output normalization for high-stakes or multi-agent deployments). Default: `"standard"`.

Context presets ship as named profiles importable from the package:

```typescript
import { lightProfile, standardProfile, fullProfile } from '@psiclawops/hypermem';
```

Pass to `HyperMem.create()` as the base config. Full tuning notes are in INSTALL.md.

---

## API

```typescript
import { HyperMem, buildSpawnContext, DocChunkStore, MessageStore } from '@psiclawops/hypermem';

const hm = await HyperMem.create({
  dataDir: '~/.openclaw/hypermem',
  cache: { maxEntries: 10000 },
  // Local (Ollama):
  embedding: { ollamaUrl: 'http://localhost:11434', model: 'nomic-embed-text' },
  // Hosted (OpenRouter), recommended for installs without local GPU/CPU:
  // embedding: { provider: 'openai', openaiApiKey: 'sk-or-...', openaiBaseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-embedding-8b', dimensions: 4096, batchSize: 128 },
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
await hm.refreshCacheGradient('forge', 'agent:forge:webchat:main');

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

## Migration

hypermem doesn't touch your existing memory data. Install it, switch the context engine, and migrate historical data on your own timeline, before or after switching.

Migrations are supported from any memory platform. Worked examples are included in the migration documentation for: **OpenClaw built-in memory, Mem0, Honcho, QMD session exports, and Engram**.

All migration scripts default to dry-run. Nothing is written until you add `--apply`.

Operator guide: **[docs/MIGRATION_GUIDE.md](./docs/MIGRATION_GUIDE.md)**


---

## Take it further with the Agentic Cognitive Architecture

hypermem's output normalization corrects model tendencies after they appear: sycophancy, hedging, pagination. The Agentic Cognitive Architecture prevents them from appearing in the first place.

The Agentic Cognitive Architecture is a design guide for building agents that stay coherent across sessions without constant prompt engineering. It covers identity self-authorship (SOUL.md), structured memory contracts, and agent-to-agent communication protocols. The same FOS/MOD profiles that normalize output in hypermem are derived from Agentic Cognitive Architecture patterns.

When your agent's identity, memory, and communication are architected rather than prompted, the compositor has better material to work with: cleaner facts, more consistent voice, fewer confabulations to catch. The Agentic Cognitive Architecture makes hypermem's output normalization cheaper because the agent needs less correction.

Read the Agentic Cognitive Architecture design guide: [PsiClawOps/AgenticCognitiveArchitecture](https://github.com/PsiClawOps/AgenticCognitiveArchitecture/)

---

## License

Apache-2.0, [PsiClawOps](https://github.com/PsiClawOps)
