<p align="center">
  <img src="assets/logo.png" alt="hypermem" width="283" />
</p>

<p align="center"><em>Coherent agents. Every session.</em></p>

---

hypermem is a SQLite-backed runtime context engine for OpenClaw agents.

**Quick install** (interactive, detects hardware, writes config):

```bash
npm install @psiclawops/hypermem && npx hypermem-install
```

Or via the shell installer:

```bash
curl -fsSL https://raw.githubusercontent.com/PsiClawOps/hypermem/main/install.sh | bash
```

Or install manually via `npm install @psiclawops/hypermem` — see [Installation](#installation) for plugin wiring, embedding setup, and step-by-step paths.


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

**Bloated context.** 128k tokens doesn't mean 128k of useful prompt. Without active curation, agents fill the window with stale history, redundant instructions, and memory that isn't relevant to this turn. A bigger context window just means more room to waste. The information is in the prompt somewhere, buried under content irrelevant to this turn.

---

## What OpenClaw provides today

OpenClaw addresses both failure modes with structured guidance files injected into every session:

| File | What it contributes | Survives session restart? |
|---|---|---|
| `SOUL.md` | Agent identity, voice, principles | ✅ always injected |
| `USER.md` | User preferences, working style | ✅ always injected |
| Task and workspace instruction files (for example AGENTS.md, job files, and related guidance) | ✅ always injected |
| `MEMORY.md` | Hand-curated decisions, facts, patterns | ✅ if manually maintained |

These are powerful for identity and preferences. But the retry logic decision from last week? If nobody manually captured it into `MEMORY.md`, that session boundary erased it. The system is only as strong as its last manual update.

OpenClaw also ships compaction safeguards and hybrid file search. That's a solid baseline. It has limits. hypermem closes both gaps.

---

## hypermem

Four SQLite-backed memory databases, sub-millisecond retrieval, no external database services required. Runs in-process with local SQLite storage and local Nomic embeddings by default, with optional hosted embeddings for L3.

| Layer | What it holds | Speed |
|---|---|---|
| **L1 SQLite `:memory:`** | What the agent needs right now. Identity, recent history, active state. | 0.08ms |
| **L2 History** | Every conversation, queryable and concurrent-safe. Per-agent. | 0.13ms |
| **L3 Semantic** | Finds related content even when the words don't match. | 0.29ms |
| **L4 Knowledge** | Facts, wiki pages, episodes, preferences. Shared across agents. | 0.09ms |

Everything is retained. Storage survives session boundaries. The retry logic decision from last week, the deployment preferences from last month, the architecture choices from day one: all queryable, all available for composition.

**Session warming.** Before the first turn fires, hypermem pre-loads the agent's full working state from its SQLite-backed memory stores and hot `:memory:` cache: recent history, facts ranked by confidence and recency, active topic context, cached embeddings for fast semantic recall. The agent's first reply draws from everything that was in scope at the end of the last session. The agent picks up where it left off.

---

## hypercompositor

Every memory system stores. Almost none compose.

Your agent has four layers of stored context, but what shows up in the prompt? How much of the token budget goes to stale content? Who decides what's relevant to this specific turn?

The hypercompositor queries all four layers in parallel on every turn and composes context within a fixed token budget. No transcript accumulates. No lossy transcript summarization. Amnesia isn't a storage problem; the memories exist, but nobody composed them into a coherent prompt. Compaction isn't inevitable; content that doesn't fit this turn stays in storage instead of being destroyed.

**Bigger context windows don't help if you fill them with stale history.**
128k tokens of stale history and irrelevant memory is worse than 32k of precisely selected content. 9 budget categories, priority-ordered, greedy-fill. Every token in the prompt earned its spot.

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

### OpenClaw default vs. hypercompositor

```
OpenClaw default                        hypercompositor
────────────────────────────────        ────────────────────────────────
message → append to transcript          message → detect active topic
transcript full → trim oldest           query 4 storage layers in parallel
trimmed content → summarize (lossy)     budget allocator: 9 slots, fixed cap
send transcript to model                tool compression by turn age
model responds → append again           keystone guard + hyperform profile
                                        composed prompt → model
     ┌──────────────────┐               model responds → afterTurn ingest
     │ loop until full  │               → write back to all 4 layers
     └──────────────────┘

When it fills:                          When budget is exceeded:
  content is lost permanently             content stays in storage
  summaries are lossy                     not selected for this turn
  no recovery path                        change topic back → retrieved again
```

| | OpenClaw default | hypercompositor |
|---|---|---|
| Context source | Growing transcript only | Transcript + 3 additional storage layers |
| When context fills | Trim + summarize (lossy) | Budget allocation (lossless storage) |
| Old decisions | Lost after compaction | Retrievable via keystones + semantic recall |
| Topic changes | All history competes equally | Scoped retrieval by active topic |
| Tool output | Stays until trimmed | Cluster-compressed by age |
| Model swap mid-session | Re-count, hope it fits | Budget recomputed from new window size next turn |

High-signal turns are marked as keystones and survive pressure trimming ahead of ordinary history.

The compositor fills 9 slots in priority order (system prompt → identity → hyperform → history → facts → wiki → semantic recall → cross-session → action summary). Each slot consumes tokens from the remaining budget before the next slot runs. Slots that don't fit this turn stay in storage, not destroyed.

For the full fill order, budget formula, and all configuration knobs, see **[Tuning](#tuning)** below and **[docs/TUNING.md](./docs/TUNING.md)**.

---

## hyperform

Raw model output has two problems. It drifts from your standards (sycophancy, hedging, pagination, formatting) and it drifts from your facts (confabulation, contradiction, stale claims). hyperform handles both: normalization enforces consistency, confabulation resistance checks output against what's actually stored.

Consistent output isn't just aesthetic. A model that paginates short answers, preambles with filler, or inflates lists uses more output tokens per turn. Over hundreds of turns, that compounds into real cost. hyperform directives compress output at the source: fewer tokens generated means lower API spend per session, and less context pressure for subsequent turns.

### Behavior standards

Behavior standards define how your agents write. Anti-sycophancy rules prevent filler openings. Density targets compress answers. Anti-pattern bans remove common AI markers (em dashes, AI vocabulary, inflated significance). These rules apply to all models equally.

| Tier | Tokens | What it injects |
|---|---|---|
| `light` | ~100 | 9 standalone directives: lead with answer, no sycophancy, no em dashes, AI vocab ban, length targets (simple/analysis/code), filler ban, no pagination of short answers, evidence calibration, numbers over adjectives. No database required. |
| `standard` | ~250 | Full directive set from the `fleet_output_standard` table: structural rules, density targets per task type, anti-patterns, format rules, compression ratios, voice directives, and task-context overrides. Falls back to `light` directives if no record exists. |
| `full` | ~250 + adaptation | Same directives as `standard`, plus model adaptation (see below). |

### Model adaptation

Different models have different default behaviors. GPT-5.4 tends toward 2x verbosity and long lists. Claude Opus defaults to hedging and preambles. Gemini produces bulleted summaries where prose would be more direct. Model adaptation corrects for these tendencies per model.

Adaptation entries are stored in the `model_output_directives` table and matched by model ID using exact match, then glob pattern (longest wins), then wildcard fallback. Each entry contains:

- **Calibration:** known model tendencies and specific adjustments (e.g., "2x verbosity: cut first drafts in half")
- **Corrections:** hard/medium/soft severity rules applied in order (e.g., "No preamble before the answer")
- **Task overrides:** per-task-type adjustments

Model adaptation is only active at the `full` tier. At `light` and `standard`, model-specific corrections are suppressed.

The `model_output_directives` table starts empty. You populate it with corrections for the models you run. See [docs/TUNING.md](./docs/TUNING.md#creating-custom-entries) for the schema and SQL examples.

### Before and after

The same prompt, GPT-5.4, with and without `hyperformProfile: "light"`:

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
automatically. Set `reserveFraction` to your preferred floor and let the compositor fill.
```

**Confabulation resistance** checks output against stored facts before claims are recorded. No LLM call. Pattern matching against the fact corpus, with confidence scoring and contradiction detection. Unsupported claims are flagged, contradictions surface in diagnostics, and a confabulation risk score is attached to the stored episode.

Set `compositor.hyperformProfile` to `light`, `standard`, or `full`. For tier selection guidance, configuration details, and custom entry creation, see **[Tuning](#tuning)** below and **[docs/TUNING.md](./docs/TUNING.md)**.

---

## What it solves

### Tool output that doesn't take over

Agentic sessions generate massive tool output. Left unmanaged, old results crowd out current reasoning. hypermem compresses tool history by age: recent clusters stay full, older clusters are capped, and the oldest collapse to short stubs while preserving tool call/result integrity. The budget goes to current work, not last hour's npm test output.

### Knowledge that outlasts the conversation

Most memory systems store what was said. hypermem synthesizes what was learned.

When a topic goes quiet, hypermem compiles the thread into a structured wiki page: decisions, open questions, artifacts, participants. When the topic resurfaces, the agent gets a compact structured summary rather than a raw history replay.

OpenClaw 2026.4.7 ships memory wiki for structured storage. hypermem goes further: wiki pages are synthesized automatically and injected by the compositor within token budget, backed by SQLite memory databases instead of an external cache service.

### Subagents that hit the ground running

Spawned subagents inherit a bounded context block: recent parent turns, session-scoped documents, and relevant facts. Scope is isolated from the shared library. Documents are cleaned up on completion.

### Context that doesn't repeat itself

Retrieval paths pull from four layers, trigger shortcuts, temporal indexes, open-domain FTS5, semantic recall, and cross-session summaries. Without dedup, the same fact surfaces through multiple paths and wastes budget on repetition.

hypermem runs content fingerprint dedup across all compose-time retrieval. Every fact, temporal result, open-domain hit, and semantic recall entry is normalized and fingerprinted on a 120-char prefix. O(1) lookup in a shared set catches duplicates regardless of which retrieval path produced them, including rephrased near-duplicates that substring matching missed. Diagnostics track dedup counts and fingerprint collisions per compose call.

Identity content (SOUL.md, USER.md, IDENTITY.md) and doc chunks already injected by OpenClaw's bootstrap are fingerprinted before retrieval runs, so the compositor never double-injects content the runtime already placed in the prompt.

### Integrity under failure

The background indexer runs a startup integrity check against `library.db` on every boot. If the schema is corrupt, tables are missing, or critical indexes are damaged, the indexer enters circuit-breaker mode: it logs the failure, skips indexing for the session, and avoids cascading writes into a broken database. The agent still runs with cached and in-memory data while the operator is notified.

SQL queries that interpolate datetime values are fully parameterized. FTS5 trigger terms are quoted to prevent injection through crafted content. These aren't theoretical: agentic sessions ingest arbitrary user and tool output into the fact store, and unparameterized queries on that path were a real attack surface.

---

## Pressure management

hypermem manages context pressure automatically through four escalating paths. Most sessions never need manual intervention. For trigger thresholds and path details, see [Pressure management](#pressure-management-1) below.

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

- **Semantic indexer:** indexes each session's turns for recall after activity drops off. Embeddings are computed asynchronously after the assistant replies and cached for subsequent turns, so compose calls hit cache rather than computing on demand
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
> Query planner uses compound indexes on agentId + sort key; FTS5 performance improved 25% from baseline after index additions despite a 47% increase in stored data.

L1 and L4 structured retrieval are sub-millisecond. Vector embeddings are computed asynchronously after the assistant replies and cached in the in-memory layer, not on the primary composition call path. Users never wait for an embedding computation.

---

## Architecture

hypermem plugs into OpenClaw via two plugins that fill both composition slots:

| Plugin | ID | Slot | What it does |
|---|---|---|---|
| `@psiclawops/hypercompositor` | `hypercompositor` | `contextEngine` | Owns session lifecycle, ingest, compose, afterTurn indexing, tool compression, hyperform |
| `@psiclawops/hypermem-memory` | `hypermem` | `memory` | Provides `memory_search` tool backed by hybrid FTS5 + KNN retrieval against library.db |

Both load from the same repo and share a single HyperMem core singleton. The context engine plugin (`hypercompositor`) is the heavy one: session warming, compositor, tool gradient, hyperform. The memory plugin (`hypermem`) is a thin wrapper that exposes HyperMem's hybrid retrieval as OpenClaw's standard `MemoryPluginCapability`, so `memory_search` routes through the official memory slot and shows correctly in `openclaw plugins list`.

The Plugin column is the npm package name. The ID column is what goes in `plugins.allow` and `plugins.slots.*`. Don't put the package name in a slot config.

**L1: SQLite in-memory.** Sub-millisecond hot reads, no network dependency, no daemon, no retry logic. Identity, compressed session history, cached embeddings, topic-scoped session and recall state, and agent registry data. The compositor hits this first on every turn.

**L2: Messages DB.** A single `MEMORY.md` file doesn't hold per-agent conversation history at scale. Thousands of turns across dozens of agents need queryable, concurrent-safe storage. Per-agent SQLite with WAL mode, auto-rotating at 100MB or 90 days. Full conversation history and session metadata. Rotated archives remain readable for recall.

**L3: Vectors DB.** Keyword search alone misses semantically related content. A decision recorded as "we chose exponential backoff" won't match a search for "what was the retry strategy" without vector similarity. Per-agent sqlite-vec database with KNN search over prior turns and indexed workspace documents. Reconstructable from L2 if lost. Supports two embedding providers: Ollama (local, default `nomic-embed-text`) or hosted via OpenRouter (recommended: `qwen/qwen3-embedding-8b`, 4096d, top of MTEB retrieval leaderboard).

Retrieval follows a fixed pipeline on every compose call:

1. **Trigger registry** fires first. Nine pattern triggers check for exact-match shortcuts. If one hits, scoped FTS5 prefix queries (`word1* OR word2*`) run against L4 collections and return immediately.
2. **Semantic fallback** fires when no trigger matches. Bounded hybrid retrieval runs FTS5 + KNN in parallel, then merges via Reciprocal Rank Fusion (RRF). BM25 ranks and KNN cosine distances combine into a single ordered result.
3. **Noise floor** filters anything below RRF 0.008 before it reaches the compositor.

FTS5 queries use compound indexes on `agentId + sort key` and prefix optimization (3+ chars, capped at 8 terms, OR queries). These indexes yielded a 25% read improvement over baseline despite a 47% increase in stored data.

### Retrieval pipeline

**L4: Library DB.** Per-agent storage can't hold shared knowledge. Facts established by one agent, wiki pages synthesized from cross-agent topics, shared registry state: these belong to the system, not one agent. One shared SQLite database:

| Collection | What it holds |
|---|---|
| Facts | Claims with confidence scoring, domain, expiry, supersedes chains |
| Knowledge | Domain/key/value structured data with full-text search |
| Episodes | Significant events with impact scores and participant tracking |
| Topics | Cross-session thread tracking and synthesized wiki pages |
| Preferences | operator behavioral patterns |
| Fleet Registry | Agent registry with tier, org, and capability metadata |
| System Registry | Service state and lifecycle |
| Work Items | Work queue with status transitions and FTS5 |
| Session Registry | Session lifecycle tracking |
| Desired State | Per-agent config targets; compares running config against desired at gateway startup and surfaces drift for operator review |

Facts are ranked by `confidence × recencyDecay`, where decay is exponential with a configurable half-life: recent, high-confidence facts float to the top while stale entries yield budget to newer knowledge.

**Secret scanner:** Before any fact, episode, or knowledge entry with `org`, `council`, or `fleet` visibility is written to L4, hypermem scans the content for credentials, API keys, tokens, and connection strings. Matches are downgraded to `private` scope rather than rejected; the write succeeds without the content reaching shared-visible storage.

**The compositor** queries all four layers in parallel on each turn, applies per-slot token caps, and composes a provider-format context block. A safety valve catches estimation drift and trims post-composition. Because the budget is computed from the model's actual context window at compose time (resolved from the model string when the runtime doesn't pass `tokenBudget` explicitly), a mid-session model swap triggers a budget recompute on the next turn. Structured tool history is guarded from destructive persistence during a budget downshift.

**Tool compression** groups calls with results into atomic clusters via `clusterNeutralMessages()`. T0 preserves the current turn plus the two most recent completed turns at full fidelity, matching OpenClaw's native `keepLastAssistants: 3` baseline. Above 80% projected occupancy, large T0 results are head-and-tail trimmed with a structured trim note rather than dropped. Older clusters then enter the gradient: T1 caps at 6k per result, T2 at 800 chars, T3 at 150-char stubs. A pair-integrity guard ensures call-result clusters survive or drop together. `getTurnAge()` counts tool clusters correctly, and `toolPairMetrics` logs pair-integrity anomalies at the OpenClaw seam. When `deferToolPruning` is enabled and OpenClaw's native `contextPruning` is active, the native pruner handles tool result trimming instead.

**canPersistReshapedHistory** guards the compositor from persisting structurally reshaped history back to the JSONL transcript. When structured tool history is present, budget downshifts are computed but not committed to storage, preventing a lower-context snapshot from overwriting the full history on disk.

```
  user message
       │
  topic detection ──► scope retrieval to active thread
       │
  ┌────┴───────────────────────────────────────────────┐
  │              query 4 layers (parallel)             │
  │                                                    │
  │  L1 in-memory  L2 History   L3 Vectors  L4 Library │
  │  hot state    durable       semantic    facts/wiki │
  │  0.1ms        0.16ms        0.29ms      0.08ms     │
  └────┬───────────────────────────────────────────────┘
       │
  budget allocator ──► 10 slots, fixed token cap
       │
  tool compression ──► clusterNeutralMessages() → T0 full → T1 6k → T2 800 → T3 150-char stub
       │
  keystone guard ──► high-signal turns survive pressure
       │
  hyperform ──► output normalization directives
       │
  composed prompt
       │
  model response
       │
  afterTurn ──► write back to all 4 layers (tool-result carrier messages persisted through recordAssistantMessage, not flattened into plain user text, so structured tool results remain recoverable in durable history)
```

Slot-level budget allocation is shown in the [hypercompositor diagram](#what-the-model-actually-sees) above. The 72% composition figure is typical for a warm mature session. Multi-agent sessions with active registry and cross-session wiki may run slightly higher.

---

## Requirements

**Current release: hypermem 0.8.2.** Changelog: [CHANGELOG.md](./CHANGELOG.md)

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | `>=22.0.0` | Required for native `node:sqlite` module |
| **better-sqlite3** | `^11.x` | Installed automatically via npm; powers L1 in-memory and L4 library |
| **sqlite-vec** | `0.1.9` | Bundled; no separate install needed |

SQLite is a library, not a service. All four layers run in-process with no external daemons. The nomic embedder on Ollama is the heaviest component, and it is lighter than pgvector or any hosted vector database.

**Runtime version constants** (importable from the package):
```typescript
import {
  ENGINE_VERSION,        // '0.8.2'
  MIN_NODE_VERSION,      // '22.0.0'
  SQLITE_VEC_VERSION,    // '0.1.9'
  MAIN_SCHEMA_VERSION,   // 10 (messages.db)
  LIBRARY_SCHEMA_VERSION_EXPORT, // 19 (library.db)
} from '@psiclawops/hypermem';
```

Schema versions are stamped into each database on startup and checked on open. A database created by an older engine version will be migrated forward automatically. A database created by a newer engine version will throw on open.

---

## Installation

**Requirements:** Node.js 22+, OpenClaw with context engine plugin support. No standalone SQLite install needed (uses Node 22 built-in `node:sqlite`). Embedding provider is optional for first install.

hypermem works two ways:
- **As a library** — import directly into your own Node.js code. No OpenClaw required.
- **As an OpenClaw plugin** — replaces the default context engine. Requires a running OpenClaw gateway.

### Library usage (no OpenClaw required)

```bash
npm install @psiclawops/hypermem
```

```typescript
import { HyperMem } from '@psiclawops/hypermem';
import { join } from 'node:path';
import { homedir } from 'node:os';

const hm = await HyperMem.create({
  dataDir: join(homedir(), '.openclaw', 'hypermem'),
  embedding: { provider: 'none' },
});

await hm.recordUserMessage('my-agent', 'session-1', 'Hello');
const composed = await hm.compose({
  agentId: 'my-agent',
  sessionKey: 'session-1',
  prompt: 'Hello',
  tokenBudget: 4000,
  provider: 'anthropic',
});
```

That's it. No gateway, no plugins, no config files. See [API](#api) for the full interface.

### OpenClaw plugin install (from source)

> **Release note:** if the npm package you installed does not contain `install:runtime`, you are on an older public release. Use the source-clone path below or wait for `0.8.4+`.

```bash
git clone https://github.com/PsiClawOps/hypermem.git
cd hypermem
npm install && npm run build
npm --prefix plugin install && npm --prefix plugin run build
npm --prefix memory-plugin install && npm --prefix memory-plugin run build
npm run install:runtime
```

`install:runtime` stages the runtime payload into `~/.openclaw/plugins/hypermem` and prints the exact config commands to wire the plugins. It does not finish wiring automatically. Before running them, create the data directory and write the current recommended starter config:

```bash
mkdir -p ~/.openclaw/hypermem
cat > ~/.openclaw/hypermem/config.json <<'JSON'
{
  "embedding": {
    "provider": "none"
  },
  "compositor": {
    "budgetFraction": 0.55,
    "contextWindowReserve": 0.25,
    "targetBudgetFraction": 0.50,
    "warmHistoryBudgetFraction": 0.27,
    "maxFacts": 25,
    "maxHistoryMessages": 500,
    "maxCrossSessionContext": 4000,
    "maxRecentToolPairs": 3,
    "maxProseToolPairs": 10,
    "keystoneHistoryFraction": 0.15,
    "keystoneMaxMessages": 12,
    "wikiTokenCap": 500
  }
}
JSON
```

This keeps a fresh install in lightweight embedding mode while also applying the current recommended lean compositor baseline for OpenClaw operators. Add an embedding provider later for semantic search without losing stored data. See [INSTALL.md](./INSTALL.md#embedding-providers) and [docs/TUNING.md](./docs/TUNING.md) for adjustments.

Wire the plugins into OpenClaw:

> **⚠️  Merge, don't overwrite.** If you already have values in `plugins.load.paths` or `plugins.allow`, check them first and include your existing entries alongside the new ones. Replacing the list drops whatever was there before.
>
> ```bash
> openclaw config get plugins.allow
> openclaw config get plugins.load.paths
> ```

```bash
# Use a variable to avoid shell quote-escaping issues with $HOME:
HYPERMEM_PATHS="[\"${HOME}/.openclaw/plugins/hypermem/plugin\",\"${HOME}/.openclaw/plugins/hypermem/memory-plugin\"]"
openclaw config set plugins.load.paths "$HYPERMEM_PATHS" --strict-json
# If you have existing load paths, merge them into the array in HYPERMEM_PATHS.

openclaw config set plugins.slots.contextEngine hypercompositor
openclaw config set plugins.slots.memory hypermem

# Only set plugins.allow if your OpenClaw config already uses an allowlist.
# If `openclaw config get plugins.allow` returns null, empty, or unset, skip this step.
# If it returns an array, copy that array and append "hypercompositor" and "hypermem".
openclaw config set plugins.allow '["existing-plugin","hypercompositor","hypermem"]' --strict-json

openclaw gateway restart
```

Do **not** replace a working `plugins.allow` list with only `['hypercompositor','hypermem']`. That can disable bundled CLI surfaces and channel plugins.

Verify (run these commands from the repo clone directory — `bin/` is a relative path):

```bash
openclaw plugins list                    # hypercompositor and hypermem should show as loaded
node bin/hypermem-status.mjs --health    # confirms database initialization
openclaw logs --limit 50 | grep hypermem # should show "hypermem initialized"
```

If you see `falling back to default engine "legacy"` in the logs, the install is not active. Check [INSTALL.md troubleshooting](./INSTALL.md#troubleshooting-clean-installs).

### One-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/PsiClawOps/hypermem/main/install.sh | bash
```

Interactive: detects hardware, selects embedding tier, writes config, registers plugins.

Full guide with embedding tiers, reranker setup, fleet config, and tuning: **[INSTALL.md](./INSTALL.md)**

### Agent-assisted install

If you prefer, hand the install to your OpenClaw agent:

> "Install hypermem following INSTALL.md. I'm running a [solo / multi-agent] setup."

### operator guides

- **[docs/MEMORY_MD_AUTHORING.md](./docs/MEMORY_MD_AUTHORING.md)**, how to keep `MEMORY.md` compact, durable, and reviewable
- **[docs/TUNING.md](./docs/TUNING.md)**, context assembly and output shaping profiles
- **[docs/MIGRATION_GUIDE.md](./docs/MIGRATION_GUIDE.md)**, moving data in from existing memory systems

### Tuning

Two independent surfaces: **context assembly** (what fills the context window) and **output shaping** (how the model writes). Pick a profile first. Most deployments adjust one or two settings on top.

| Profile | Target window | Best for |
|---|---|---|
| `light` | 64k | Single agent, small models, constrained resources |
| `standard` | 128k | Normal deployments, small fleets |
| `full` | 200k+ | Multi-agent fleets, large-context models |

Start with `light`. Use `mergeProfile()` to adjust individual settings:

```typescript
import { mergeProfile } from '@psiclawops/hypermem';
const config = mergeProfile('standard', { compositor: { maxFacts: 40 } });
```

Drop a `~/.openclaw/hypermem/config.json` to override defaults (takes effect on gateway restart):

```json
{
  "compositor": {
    "budgetFraction": 0.70,
    "hyperformProfile": "standard"
  }
}
```

Or configure through `openclaw.json` (preferred for managed deployments):

```json
{
  "plugins": {
    "entries": {
      "hypercompositor": {
        "config": {
          "compositor": { "budgetFraction": 0.70 },
          "hyperformProfile": "standard"
        }
      }
    }
  }
}
```

Plugin config in `openclaw.json` takes precedence over `config.json`. Both sources are merged, with plugin config winning on overlap. The config schema is validated on gateway start and visible via `openclaw config get plugins.entries.hypercompositor.config`.

Full reference: **[docs/TUNING.md](./docs/TUNING.md)**

---

## API

> **Note:** The examples below use placeholder agent names (`my-agent`, `alice`, etc.). Replace these with your actual agent IDs from your OpenClaw config. Single-agent installs typically use `main`. Multi-agent fleets use whatever IDs you've configured. See [INSTALL.md § "Configure your fleet"](./INSTALL.md#step-5--configure-your-fleet-multi-agent-only) for details.

```typescript
import { HyperMem } from '@psiclawops/hypermem';
import { join } from 'node:path';
import { homedir } from 'node:os';

const hm = await HyperMem.create({
  dataDir: join(homedir(), '.openclaw', 'hypermem'),
  cache: { maxEntries: 10000 },
  // Local (Ollama):
  embedding: { ollamaUrl: 'http://localhost:11434', model: 'nomic-embed-text' },
  // Hosted (OpenRouter), recommended for installs without local GPU/CPU:
  // embedding: { provider: 'openai', openaiApiKey: 'sk-or-...', openaiBaseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-embedding-8b', dimensions: 4096, batchSize: 128 },
});

// Record and compose
await hm.recordUserMessage('my-agent', 'agent:my-agent:webchat:main', 'How does drift detection work?');

const composed = await hm.compose({
  agentId: 'my-agent',
  sessionKey: 'agent:my-agent:webchat:main',
  prompt: 'How does drift detection work?',
  tokenBudget: 4000,
  provider: 'anthropic',
});

// Refresh tool compression after each turn
await hm.refreshCacheGradient('my-agent', 'agent:my-agent:webchat:main');
```

Spawning a subagent with parent context:

```typescript
import { buildSpawnContext, MessageStore, DocChunkStore } from '@psiclawops/hypermem';

const spawn = await buildSpawnContext(
  new MessageStore(hm.dbManager.getMessageDb('my-agent')),
  new DocChunkStore(hm.dbManager.getLibraryDb()),
  'my-agent',
  { parentSessionKey: 'agent:my-agent:webchat:main', workingSnapshot: 12 }
);
```

---

## CLI

`bin/hypermem-status.mjs` provides health checks and metrics from the command line:

```bash
node bin/hypermem-status.mjs              # full dashboard
node bin/hypermem-status.mjs --agent my-agent   # scoped to one agent
node bin/hypermem-status.mjs --json          # machine-readable output
node bin/hypermem-status.mjs --health        # health checks only (exit 1 on failure)
```

By default, `hypermem-status` looks for data in `~/.openclaw/hypermem`. If your data directory is elsewhere (e.g. testing in an isolated environment), set:

```bash
HYPERMEM_DATA_DIR=/path/to/data node bin/hypermem-status.mjs --health
```

> **Fresh install note:** If no agent has run a session yet, `--health` will report "no sessions ingested" rather than a database error. This is expected. Send a test message to any agent, then re-run the health check.

---

## Pressure management

hypermem composes context fresh on every turn, but a long-running session still accumulates history in its JSONL transcript. When that grows large enough, incoming tool results have nowhere to land and get silently stripped. Four automatic paths handle this:

| Path | Trigger | Action |
|---|---|---|
| **Pressure-tiered tool-loop trim** | Any tool-loop turn | Measures projected occupancy before results land; trims large results at 80%+ and truncates the messages[] array for the current turn |
| **AfterTurn trim** | Every turn at >80% | Pre-emptive headroom cut after the assistant replies, before the next turn arrives |
| **Deep compaction** | compact() at >85% | Cuts in-memory cache to 25% budget and truncates JSONL to ~20% depth. Bypasses the normal reshape guard |
| **Reshape guard** | Structured tool history on downshift | `canPersistReshapedHistory()` blocks a lower-context snapshot from overwriting the full JSONL history |

**The one thing these paths cannot fix:** a session whose JSONL transcript on disk is already at 98% when the gateway restarts. The JSONL loads into runtime context before any compaction runs. Check `session_status` on startup. If you're above 85%, start a fresh session.

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

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `falling back to default engine "legacy"` in logs | Plugin not loaded or slot misconfigured | Check `openclaw config get plugins.slots.contextEngine` is `hypercompositor`, paths are correct, and both plugins are in `plugins.allow` |
| `openclaw gateway restart` says disabled/not configured | OpenClaw not fully onboarded | Complete OpenClaw setup first. `gateway restart` requires a running gateway. |
| `openclaw logs` fails with auth/token error | Gateway auth not set up for CLI | Run `openclaw gateway status` to confirm the gateway is accessible |
| `facts=0 semantic=0` every turn | Fresh install, no data yet | Expected. Facts accumulate over real conversations. |
| Health check says "no sessions ingested" | No agent has run a session yet | Send a test message, then re-run |
| JS code creates `./~/.openclaw/` directory | Used literal `~` in JS instead of `homedir()` | Use `join(homedir(), '.openclaw', 'hypermem')` from `node:path` and `node:os` |
| `INSTALL.md` not found in npm package | Older published version | Update to latest or read INSTALL.md on [GitHub](https://github.com/PsiClawOps/hypermem/blob/main/INSTALL.md) |

Full troubleshooting: **[INSTALL.md § Troubleshooting](./INSTALL.md#troubleshooting)**

---

## Migration

hypermem doesn't touch your existing memory data. Install it, switch the context engine, and migrate historical data on your own timeline.

The migration guide includes worked examples showing how to bring data from OpenClaw built-in memory, Mem0, Honcho, QMD session exports, and Engram. Each example walks through the data model mapping, transformation steps, and validation. Adapt them to your setup.

All examples default to dry-run. Nothing is written until you add `--apply`.

operator guide: **[docs/MIGRATION_GUIDE.md](./docs/MIGRATION_GUIDE.md)**


---

## Identity layer

hypermem handles context and output normalization. The Agentic Cognitive Architecture handles identity: self-authored SOUL files, structured communication contracts, and identity persistence across sessions. Same team, complementary layers.

Design guide: [PsiClawOps/AgenticCognitiveArchitecture](https://github.com/PsiClawOps/AgenticCognitiveArchitecture/)

---

## Acknowledgments

The embedding-space fidelity threshold used in compaction validation was informed by the geometric preservation mathematics published by the [libravdb](https://github.com/xDarkicex/openclaw-memory-libravdb) project.

---

## License

Apache-2.0, [PsiClawOps](https://github.com/PsiClawOps)
