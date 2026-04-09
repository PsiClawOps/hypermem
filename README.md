<p align="center">
  <img src="assets/logo.png" alt="hypermem" width="283" />
</p>

<p align="center"><em>Coherent agents. Every session.</em></p>

---

hypermem is a runtime context engine for OpenClaw agents.

```bash
git clone https://github.com/PsiClawOps/hypermem.git ~/.openclaw/workspace/repo/hypermem
cd ~/.openclaw/workspace/repo/hypermem && npm install && npm run build
openclaw config set plugins.slots.contextEngine hypermem
```

Start a conversation. Run `session_status`. You'll see compositor stats: token budget, pressure level, slot allocations. That's the engine running.

---

## The problem

Every LLM conversation is assembled at runtime. The model sees only what's in the prompt. It has no memory of prior sessions, no access to decisions made last week, no awareness of work that happened before this context window opened.

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

Four storage layers, sub-millisecond retrieval, zero external services.

| Layer | What it holds | Speed |
|---|---|---|
| **L1 In-memory** | What the agent needs right now. Identity, recent history, active state. | 0.1ms |
| **L2 History** | Every conversation, queryable and concurrent-safe. Per-agent. | 0.16ms |
| **L3 Semantic** | Finds related content even when the words don't match. | 0.29ms |
| **L4 Knowledge** | Facts, wiki pages, episodes, preferences. Shared across agents. | 0.08ms |

Everything is retained. Nothing is lost at the session boundary. When an agent restarts, it warms from storage before the first turn. The retry logic decision from last week, the deployment preferences from last month, the architecture choices from day one: all queryable, all available for composition.

---

## hypercompositor

Every memory system stores. Almost none compose.

Your agent has four layers of stored context, but what shows up in the prompt? How much of the token budget goes to stale content? Who decides what's relevant to this specific turn?

The hypercompositor queries all four layers in parallel on every turn and assembles context within a fixed token budget. No transcript accumulates. No summary is ever needed.

**Session amnesia isn't a storage problem.**
The memories exist. They're in the database. The agent wakes up blank anyway because nobody assembled them into a coherent prompt. The hypercompositor queries four layers in parallel, allocates budget by priority, scopes to the active topic, and assembles a prompt that reads like the agent never left.

**Compaction isn't inevitable.**
Every other system hits a wall when context fills up. Summarize, truncate, lose specifics. The hypercompositor never accumulates a transcript to compress. Every turn is built from storage within a fixed budget. When the budget is tight, lower-priority content stays in storage instead of being destroyed. Change the topic back and it returns.

**Bigger context windows don't help if you fill them with garbage.**
128k tokens of stale history and irrelevant memory is worse than 32k of precisely selected content. 10 budget categories, priority-ordered, greedy-fill. Every token in the prompt earned its spot.

### What the model actually sees

Token budget allocation from a real session (847 turns deep, 60k budget):

```
What the model sees (9,852 of 60,000 tokens):

  ┌────────┬───────┬─────┬───────────────────────────┬───────┬───────┬─────┐
  │identity│ facts │wiki │    history (14 turns)      │recall │ tools │ FOS │
  │  312   │  812  │ 344 │         8,420              │  276  │ stubs │ 100 │
  └────────┴───────┴─────┴───────────────────────────┴───────┴───────┴─────┘
   ◄──────────────────── 16% of budget ────────────────────►

What's in storage, not in this prompt:

  L2  833 older turns           retrievable if topic shifts back
  L3  19,853 indexed episodes   available via semantic search
  L4  3,482 facts               ranked by confidence × decay, top 28 selected
  L4  47 wiki pages             active topic's page selected, rest on standby

  Nothing is lost. The compositor picks what's relevant right now.
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
                                        assembled prompt → model
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

---

## What it solves

### Agents that never forget

When an agent restarts, it wakes up empty. Decisions made, preferences established, work in progress: gone. Operators re-explain context. Agents ask questions they have already asked. The work is real. The memory is not.

hypermem warms sessions from SQLite before the first turn. The agent picks up mid-conversation. Session continuity is no longer a function of uptime; it is a property of the architecture.

### Context that never collapses

Transcripts grow. Windows fill. Runtimes compact history into a summary, and specifics, tool detail, and work state get lost in the process. The agent keeps going, but degraded.

hypermem never reaches that cliff. It assembles context fresh on every turn inside a strict token budget. History, facts, recall, and library data compete for tokens intentionally. If the model window changes mid-session, the compositor adapts on the next turn. There is no accumulated transcript to compress.

### Retrieval that actually finds things

Storing everything is not the same as being able to find anything.

FTS5 full-text search catches exact matches. KNN vector search catches semantic matches. Reciprocal Rank Fusion merges both into one ranked result. Trigger-based retrieval handles known patterns. When no trigger matches, bounded semantic fallback keeps the memory slot from coming back empty.

### Tool output that doesn't take over

Long agentic sessions generate a lot of tool output. Left unmanaged, old results crowd out current reasoning.

Tool Context Tuning compresses by turn age. T0 turns stay verbatim under normal pressure. At projected occupancy above 80% with a large result (>40k chars), T0 is trimmed head-and-tail with a structured `[hypermem_tool_result_trim ... reason=oversize_turn0_trim]` note. T1 turns become short prose stubs: `Read /src/foo.ts (1.2KB)`, `Ran npm test -- exit 0`. T2 and T3 turns drop payloads entirely, keeping message text. Large results keep the head and tail and cut the middle. For multi-agent teams, compression is tier-aware: director and council agents preserve more context per pass, reflecting their coordination scope; specialists use a tighter cap to stay focused. The in-memory cache is refreshed from SQLite after each turn so it never drifts from the source of truth.

### Knowledge that outlasts the conversation

Most memory systems store what was said. hypermem synthesizes what was learned.

When a topic goes quiet, hypermem compiles the thread into a structured wiki page: decisions, open questions, artifacts, participants. This is classifier-driven; no LLM call required. Facts, episodes, and preferences written explicitly during the session are available immediately in structured storage. When the topic resurfaces, the agent gets a compact structured summary rather than a raw history replay. The conversation is gone. The knowledge it produced is not.

OpenClaw 2026.4.7 ships memory wiki for structured storage. hypermem goes further: wiki pages are synthesized by topic classifier and injected by the compositor within token budget.

### History that remembers its highlights

Context trimming is a blunt instrument. When a session fills up, recent messages survive and old ones go, regardless of which turns actually mattered. A decision from three hours ago gets dropped. Tool noise from five minutes ago stays.

hypermem scores turns for significance as they are recorded. High-signal moments (decisions, blockers, artifacts, established facts) are marked as keystones. When pressure trims the history window, keystones are preserved ahead of ordinary turns. When a topic shift occurs and history scopes to the new thread, keystones from past contexts are still eligible for recall. The agent keeps its landmarks even when the surrounding conversation is gone.

### Output normalization

Agents confabulate and drift toward the defaults baked into their training. GPT-5.4 paginates and offers to elaborate. Sonnet over-lists. Gemini hedges. These are model tendencies, not instructions. Without an active correction layer, every response compounds them.

FOS (Fact-Oriented Synthesis) injects output normalization directives into composed context via the `outputProfile` config key. Three tiers:

| Profile | Tokens | Covers |
|---|---|---|
| `light` | ~100 | Anti-sycophancy, em dash ban, AI vocab ban, length targets, evidence calibration |
| `standard` | ~250 | Full directive set plus pagination rules and hedging policy |
| `full` | ~400 | Complete normalization for high-stakes or multi-agent deployments |

The same prompt, GPT-5.4, with and without `outputProfile: "light"`:

```
Prompt: "What should I consider when sizing my Redis instance?"

WITHOUT normalization (GPT-5.4 default):
Here are the key factors to consider when sizing your Redis instance:

**1. Agent count**
The number of agents directly impacts...

**2. Session depth**
Longer sessions accumulate more history...

Would you like me to go deeper on any of these?

WITH outputProfile: "light":
Start at 256MB for single-agent installs. Multi-agent teams: budget ~2MB per active session
plus ~500KB per agent for identity and warm facts. Embedding cache is the wildcard -- if
you run nomic-embed-text locally, add 50MB for the model plus ~1KB per cached vector.
```

The pagination, bold headers, and trailing offer-to-elaborate are GPT-5.4 defaults. `light` removes them without flattening the model's reasoning. For fact verification and confabulation detection, see [Outputs you can verify](#outputs-you-can-verify) below.

### Outputs you can verify

Every response is checked against the fact corpus before it is recorded. No LLM call. FOS/MOD (Fact-Oriented Synthesis / Moderation) runs a classifier against the live L4 fact corpus on each turn: unsupported claims are flagged, contradictions with established facts surface in diagnostics, and a confabulation risk score is attached to the stored episode.

Action verification applies the same check to tool calls before they fire. High-risk operations without grounded fact support surface in logs before execution.

Without this, agents make plausible-sounding claims that contradict stored facts, or execute tool calls without grounded basis. Neither failure is obvious from the transcript. FOS/MOD makes both visible.

Output normalization directives (the `outputProfile` setting) are also part of the FOS layer. See [Output normalization](#output-normalization) above for profiles and examples.

### Subagents that hit the ground running

Spawned subagents start cold. They don't know what the parent was doing, which files were in scope, or what decisions preceded the spawn.

`buildSpawnContext()` snapshots recent parent turns, indexes session-scoped documents, and gives the spawned agent a bounded context block at compose time. Useful context carries forward. Session documents stay isolated from the shared library and are cleaned up when the spawn completes.

---

## Pressure management

hypermem assembles context fresh on every turn, but a long-running session still accumulates history in its JSONL transcript. When that grows large enough, incoming tool results have nowhere to land and get silently stripped. Four automatic paths handle this:

| Path | Trigger | Action |
|---|---|---|
| **Pressure-tiered tool-loop trim** | Any tool-loop turn | Measures projected occupancy before results land. Plans against a 120k baseline window regardless of actual provider context size. 75%: green zone, keep full. 80%: defensive -- trim large results (>40k chars) head+tail with structured note. 85%: hard caution zone -- trim on turn 0 and turn 1. Also trims the messages[] array returned to the runtime; this is what actually prevents stripping on the current turn, not just the next one |
| **AfterTurn trim** | Every turn at >80% | Pre-emptive headroom cut after the assistant replies, before the next turn arrives |
| **Deep compaction** | compact() at >85% | Cuts in-memory cache to 25% budget and truncates JSONL to ~20% depth. Bypasses the normal reshape guard |
| **Density-aware JSONL truncation** | compact() | Counts tokens per message, not message count. Catches large-message sessions that looked fine by count but were full by volume |
| **Pre-ingestion wave guard** | Any toolResult payload before recording | Truncates or skips large tool payloads before they enter the ingest path, preventing the ingest itself from adding pressure during high-volume agentic runs |

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

Benchmarked against a production database: 3,482 facts, 19,853 episodes.

| Operation | avg | p50 | p95 |
|---|---|---|---|
| L1 single slot GET (SQLite in-memory) | 0.10ms | 0.086ms | 0.16ms |
| L1 history window (100 messages) | 0.16ms | 0.13ms | 0.22ms |
| L4 facts query (top-28 by confidence x decay) | 0.29ms | 0.28ms | 0.31ms |
| L4 FTS5 keyword search | 0.08ms | 0.076ms | 0.11ms |
| Full 4-layer compose, warm session | 52ms | 52ms | 57ms |
| Full 4-layer compose, cold session (first turn) | 249ms | 54ms | 1,592ms |
| Async pre-embed (background, not user-facing) | 302ms | 146ms | 725ms |

L1 and L4 structured retrieval are sub-millisecond. After the first turn, query embeddings are computed in the background and cached in the in-memory layer. Warm compose averages 52ms with a p95 of 57ms. The cold p95 of 1,592ms happens exactly once per new session, then never again. The async embed cost is paid after the assistant replies; users never wait for it.

---

## Architecture

hypermem plugs into OpenClaw as a context engine and owns the full prompt composition lifecycle.

**L1: SQLite in-memory.** Sub-millisecond hot reads, no network dependency, no daemon, no retry logic. Identity, compressed session history, cached embeddings, topic-scoped session and recall state, and fleet registry data. The compositor hits this first on every turn.

**L2: Messages DB.** A single `MEMORY.md` file doesn't hold per-agent conversation history at scale. Thousands of turns across dozens of agents need queryable, concurrent-safe storage. Per-agent SQLite with WAL mode, auto-rotating at 100MB or 90 days. Full conversation history and session metadata. Rotated archives remain readable for recall.

**L3: Vectors DB.** Keyword search alone misses semantically related content. The retry logic decision won't surface on a search for "what did we decide" unless the original turn used those exact words. Per-agent sqlite-vec database with KNN search over prior turns and indexed workspace documents. Reconstructable from L2 if lost. Supports two embedding providers: Ollama (local, default `nomic-embed-text`) or hosted via OpenRouter (recommended: `qwen/qwen3-embedding-8b`, 4096d, top of MTEB retrieval leaderboard).

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

**Secret scanner:** Before any fact, episode, or knowledge entry with `org`, `council`, or `fleet` visibility is written to L4, hypermem scans the content for credentials, API keys, tokens, and connection strings. Matches are downgraded to `private` scope rather than rejected; the write succeeds without the content reaching fleet-visible storage.

**The compositor** queries all four layers in parallel on each turn, applies per-slot token caps, runs Tool Context Tuning on history, and assembles a provider-format context block. A safety valve catches estimation drift and trims post-assembly. Because the budget is computed from the model's actual context window at compose time (resolved from the model string when the runtime doesn't pass `tokenBudget` explicitly), a mid-session model swap is absorbed on the next turn with no manual intervention. T0 is preserved verbatim up to 80% projected occupancy. At high pressure with a large result, T0 is trimmed head-and-tail with a structured trim note. Compression of older turns starts at T1.

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
  tool compression ──► T0 verbatim, T1 stubs, T2+ dropped
       │
  keystone guard ──► high-signal turns survive pressure
       │
  FOS profile ──► output normalization directives
       │
  assembled prompt
       │
  model response
       │
  afterTurn ──► write back to all 4 layers
```

Token budget allocation from a real session (847 turns deep, 60k budget):

```
Slot                          Tokens    % of budget
-----------------------------------------------------
L1 history (last 14 turns)     8,420       14.0%
L4 facts (top-28, confidence)    812        1.4%
L4 wiki (active topic)           344        0.6%
L3 recall (semantic matches)     276        0.5%
Spawn context                      0        0.0%
-----------------------------------------------------
Assembled                       9,852       16.4%
Reserved for response          50,148       83.6%
```

The 16% assembly figure is typical for a warm single-agent session. Multi-agent sessions with active registry and cross-session wiki hit 25-30%. The response reserve is never touched by the compositor; it belongs to the model.

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
git clone https://github.com/PsiClawOps/hypermem.git ~/.openclaw/workspace/repo/hypermem
cd ~/.openclaw/workspace/repo/hypermem
npm install && npm run build
npm --prefix plugin install && npm --prefix plugin run build

openclaw config set plugins.slots.contextEngine hypermem
openclaw config set plugins.load.paths '["~/.openclaw/workspace/repo/hypermem/plugin"]' --strict-json
openclaw gateway restart
```

Run `session_status` after your next conversation. You'll see compositor stats: token budget, pressure level, slot allocations. That's the engine running.

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

- **`targetBudgetFraction`**: caps total non-history context weight. Lower values force lighter assembly.
- **`wikiTokenCap`**: caps compiled-knowledge/wiki contribution.
- **`outputProfile`**: `light`, `standard`, or `full`. Controls how much FOS/MOD guidance is injected per turn.

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

## Take it further with the ACA

Output normalization handles model tendencies. Self-authored identity handles voice. You don't write your agents' personalities. They do. The ACA holds them to it.

---

## License

Apache-2.0, [PsiClawOps](https://github.com/PsiClawOps)
