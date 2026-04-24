<p align="center">
  <img src="assets/logo.png" alt="hypermem" width="283" />
</p>

<p align="center"><em>Coherent agents. Every session.</em></p>

---

hypermem is a SQLite-backed runtime context engine for OpenClaw agents.

**Quick install** (runtime staging + guided OpenClaw wiring):

```bash
npm install @psiclawops/hypermem && npx hypermem-install
```

Or via the shell installer:

```bash
curl -fsSL https://raw.githubusercontent.com/PsiClawOps/hypermem/main/install.sh | bash
```

Or install manually via `npm install @psiclawops/hypermem` - see [Installation](#installation) for the full declarative plugin path, verification checkpoints, and setup variants.

Release operators should also read:

- [INSTALL.md](./INSTALL.md) - canonical fresh install and upgrade guide
- [docs/INTEGRATION_VALIDATION.md](./docs/INTEGRATION_VALIDATION.md) - end-to-end integration validation contract
- [docs/DIAGNOSTICS.md](./docs/DIAGNOSTICS.md) - status, model audit, compose, trim, and release diagnostics

A successful `hypermem-install` only stages the runtime. HyperMem is active only after OpenClaw config is wired, the gateway restarts, and logs show compose activity.

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
| Task/workspace instructions | `AGENTS.md`, job files, and related guidance | ✅ always injected |
| `MEMORY.md` | Hand-curated decisions, facts, patterns | ✅ if manually maintained |

These are powerful for identity and preferences. But the retry logic decision from last week? If nobody manually captured it into `MEMORY.md`, that session boundary erased it. The system is only as strong as its last manual update.

OpenClaw also ships compaction safeguards and hybrid file search. That's a solid baseline. It has limits. hypermem closes both gaps.

---

## hypermem

OpenClaw gives agents a strong starting shape: identity files, user guidance, task framing, compaction safeguards, and hybrid file search. What it does not add by default is durable recall across session boundaries. When a useful decision falls out of the prompt and nobody hand-copied it into `MEMORY.md`, it is gone.

hypermem closes that gap with four SQLite-backed memory layers that stay local, run in-process, and remain queryable across sessions. No external database service. No retrieval stack to babysit.

| Layer | What it holds | Speed |
|---|---|---|
| **L1 SQLite `:memory:`** | What the agent needs right now. Identity, recent history, active state. | 0.08ms |
| **L2 History** | Every conversation, queryable and concurrent-safe. Per-agent. | 0.13ms |
| **L3 Semantic** | Finds related content even when the words don't match. | 0.29ms |
| **L4 Knowledge** | Facts, wiki pages, episodes, preferences. Shared across agents. | 0.09ms |

Durable context stays in SQLite and remains queryable across session boundaries. The retry logic decision from last week, the deployment preferences from last month, and the architecture choices from day one can be pulled back in when they matter.

That changes OpenClaw in a few concrete ways. Starts are warm instead of blank because recent history, ranked facts, active topics, and cached semantic state are loaded before the first turn. Recall survives wording drift because FTS5, sqlite-vec, RRF fusion, and an optional reranker can recover the same idea through different phrasing. Time-aware facts can answer “last week” and “before the release” as retrieval problems instead of vague prompt guessing. Shared knowledge stops living in one agent’s scratchpad because `library.db` holds facts, docs, episodes, preferences, fleet state, and output standards with visibility controls.

---

## hypercompositor

Storage is only half the problem. The harder question is what actually reaches the model.

Most memory systems can save useful state. Far fewer can decide, turn by turn, what belongs in the prompt right now and what should stay on disk. Without that layer, long sessions bloat, tool output crowds out current work, and a larger context window just gives you more room to waste tokens.

hypercompositor queries all four memory layers in parallel, scores what matters for the current turn, and composes a fresh prompt inside a fixed budget. Content that does not fit is not destroyed. It stays in storage and can win its way back in when the topic returns.

That changes OpenClaw at the prompt boundary. Selection replaces loss. Tool calls and results stay paired, recent turns stay readable, and older payloads compress by age instead of being flattened blindly. Quiet topics compile into structured wiki pages so the next turn can inject the decision trail without replaying raw transcript. Duplicate prompt spend drops because facts, doc chunks, semantic hits, and bootstrap content are fingerprinted before insertion. Subagents inherit a bounded handoff instead of a random slice of parent history.

**A bigger context window does not fix bad composition.**
128k tokens of stale history is worse than 32k of selected context. hypercompositor treats prompt space as a constrained resource, not a dumping ground.

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
trimmed content → summarize (lossy)     budget allocator: 10 slots, fixed cap
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

The compositor fills 10 slots in priority order (system prompt → identity → hyperform → history → recent tools → keystones → wiki/knowledge → facts → semantic recall → reserve/action context). Each slot consumes tokens from the remaining budget before the next slot runs. Slots that do not fit this turn stay in storage, not destroyed.

For the full fill order, budget formula, and all configuration knobs, see **[Tuning](#tuning)** below and **[docs/TUNING.md](./docs/TUNING.md)**.

---

## hyperform

Good memory is wasted if the model still writes like it has no standards.

OpenClaw can preserve identity and instruction. That does not guarantee consistent delivery. Models still drift into filler openings, hedging, bloated lists, pagination, and stale claims. Over long sessions that is not just annoying copy. It is token waste, weaker signal, and lower trust in what gets written back into memory.

hyperform adds a writing contract at prompt time. Output profiles inject shared standards before generation. Model directives correct known provider habits. Confabulation resistance checks candidate claims against stored facts before new memory is recorded.

That gives OpenClaw something it does not get from raw prompting alone: fleet-wide writing discipline, model-aware correction, and tighter claim hygiene at the memory boundary. The point is not to post-process prose into something artificial. The point is to make the first draft cleaner, shorter, and harder to contaminate with unsupported claims.

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

### Illustrative before and after

The example below shows the intended effect of `hyperformProfile: "light"`. hyperform is prompt-time shaping, not a deterministic post-generation rewrite engine:

```
Prompt: "How should I size my context window budget for a long-running agent session?"

WITHOUT hyperform shaping (GPT-5.4 default):
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

**Confabulation resistance** checks stored claims against existing facts before new memory entries are recorded. No LLM call. Pattern matching against the fact corpus, with confidence scoring and contradiction detection. Unsupported claims are flagged, contradictions surface in diagnostics, and a confabulation risk score is attached to the stored episode.

Set `compositor.hyperformProfile` to `light`, `standard`, or `full`. For tier selection guidance, configuration details, and custom entry creation, see **[Tuning](#tuning)** below and **[docs/TUNING.md](./docs/TUNING.md)**.

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

HyperMem ships a user-facing benchmark so operators can validate local memory access speed against their own dataset:

```bash
hypermem-bench --iterations 1000 --warmup 50 --agent main
```

The benchmark reports min, average, p50, p95, p99, and max timings for the storage paths present in the install: message hot-path lookups, session/conversation lookup, message FTS, facts, episodes, topics, fleet records, and doc chunks. It reads from `~/.openclaw/hypermem` by default, or from `HYPERMEM_DATA_DIR` / `--data-dir`.

Reference run, production database: 5,104 facts, 28,441 episodes, 847 knowledge entries, 42MB, 1,000 iterations, 50 warmup discarded, single-process isolation.

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

L1 and L4 structured retrieval are sub-millisecond on this dataset. Vector embeddings are computed asynchronously after the assistant replies and cached for later recall; hosted reranker latency depends on the chosen provider and is measured separately from SQLite access timings.

For reproducible commands and interpretation notes, see **[docs/DIAGNOSTICS.md](./docs/DIAGNOSTICS.md#memory-access-benchmark)**.

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

1. **Active facts** are ranked by confidence and recency.
2. **Temporal retrieval** runs when the query has time signals.
3. **Open-domain retrieval** handles broad exploratory queries over indexed memory.
4. **Knowledge and preference blocks** add structured library context.
5. **Hybrid semantic recall** runs FTS5 and KNN/vector search, then merges candidates with Reciprocal Rank Fusion (RRF).
6. **Optional reranking** reorders fused candidates when a reranker is configured. Supported providers include ZeroEntropy, OpenRouter, and Ollama. If the reranker is absent, fails, times out, or has too few candidates, HyperMem keeps the original RRF order.
7. **Trigger-based doc retrieval** pulls doctrine, policy, and workspace chunks by trigger match, with semantic fallback on misses.
8. **Session-scoped spawn context** and **cross-session context** are added when relevant.

Diagnostics expose reranker status, candidate count, and provider, so operators can tell whether a turn used RRF only or reranked retrieval. FTS5 queries use compound indexes on `agentId + sort key` and prefix optimization (3+ chars, capped at 8 terms, OR queries).

### Library and fleet data

**L4: Library DB.** Per-agent storage can't hold shared knowledge. Facts established by one agent, wiki pages synthesized from cross-agent topics, shared registry state: these belong to the system, not one agent. One shared SQLite database:

| Collection | What it holds |
|---|---|
| Facts | Claims with confidence, visibility, decay, temporal validity, and supersession chains |
| Knowledge / wiki | Domain knowledge and synthesized topic pages with full-text search |
| Episodes | Significant events, decisions, discoveries, participants, and source links |
| Topics | Cross-session thread tracking and topic lifecycle state |
| Preferences | Operator and agent behavior patterns |
| Documents | Chunked workspace/governance docs, doc sources, and trigger retrieval metadata |
| Knowledge graph | Links between facts, knowledge, topics, episodes, agents, and preferences |
| Fleet registry | Agents, orgs, tiers, capabilities, and fleet topology |
| Desired state | Per-agent config targets, config events, and drift detection |
| System / work state | Service state, system events, work items, and work events |
| Sessions | Session registry, lifecycle events, and extraction counters |
| Output standards | Fleet output standards, model directives, and output metrics |
| Temporal / expertise / audits | Temporal index, expertise patterns, contradiction audits, and indexer watermarks |

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
  hyperform ──► output profile directives
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

**Current release: hypermem 0.8.8.** Changelog: [CHANGELOG.md](./CHANGELOG.md)

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | `>=22.0.0` | Required for native `node:sqlite` module |
| **sqlite-vec** | `0.1.9` | Bundled; no separate install needed |

SQLite is a library, not a service. All four layers run in-process with no external database daemon. Embeddings are optional: use no embeddings for FTS-only lightweight mode, Ollama for local embeddings, or a hosted provider such as OpenRouter/Gemini when configured.

**Runtime version constants** (importable from the package):
```typescript
import {
  ENGINE_VERSION,        // '0.8.8'
  MIN_NODE_VERSION,      // '22.0.0'
  SQLITE_VEC_VERSION,    // '0.1.9'
  MAIN_SCHEMA_VERSION,   // 10 (messages.db)
  LIBRARY_SCHEMA_VERSION_EXPORT, // 19 (library.db)
} from '@psiclawops/hypermem';
```

Schema versions are stamped into each database on startup and checked on open. A database created by an older engine version will be migrated forward automatically. A database created by a newer engine version will throw on open.

---

## Installation

**Requirements:** Node.js 22+, OpenClaw with context engine plugin support. No standalone SQLite install is needed because HyperMem uses Node 22 `node:sqlite`. Embeddings are optional on first install.

README is OpenClaw-first. For non-OpenClaw library usage, see **[INSTALL.md § Non-OpenClaw usage](./INSTALL.md#non-openclaw-usage)**.

### OpenClaw quickstart

```bash
npm install @psiclawops/hypermem
npx hypermem-install
```

`hypermem-install` stages the runtime payload into `~/.openclaw/plugins/hypermem`. It does **not** modify OpenClaw config and does **not** restart the gateway. HyperMem is active only after OpenClaw is wired, restarted, and compose activity appears in logs.

Install states:

| State | Meaning |
|---|---|
| Package installed | npm package is present |
| Runtime staged | plugin payload copied into `~/.openclaw/plugins/hypermem` |
| OpenClaw wired | `plugins.load.paths`, `plugins.slots.contextEngine`, and `plugins.slots.memory` point at HyperMem |
| Runtime loaded | gateway restarted and both plugins loaded |
| Runtime active | logs show `hypermem initialized` and compose activity |

Minimal starter config for lightweight FTS-only mode:

```bash
mkdir -p ~/.openclaw/hypermem
cat > ~/.openclaw/hypermem/config.json <<'JSON'
{
  "embedding": { "provider": "none" },
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

Then merge the staged plugin paths into OpenClaw config and set the slots:

```bash
openclaw config get plugins.load.paths
openclaw config get plugins.allow

HYPERMEM_PATHS="[\"${HOME}/.openclaw/plugins/hypermem/plugin\",\"${HOME}/.openclaw/plugins/hypermem/memory-plugin\"]"
openclaw config set plugins.load.paths "$HYPERMEM_PATHS" --strict-json
openclaw config set plugins.slots.contextEngine hypercompositor
openclaw config set plugins.slots.memory hypermem

# Only if your install already uses plugins.allow: merge, do not replace.
openclaw config set plugins.allow '["existing-plugin","hypercompositor","hypermem"]' --strict-json

openclaw gateway restart
openclaw plugins list
hypermem-status --health
```

Full install, upgrade, source-clone, embedding provider, reranker, fleet config, and rollback guidance lives in **[INSTALL.md](./INSTALL.md)**.

### One-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/PsiClawOps/hypermem/main/install.sh | bash
```

The shell installer stages the runtime and prints merge-safe activation commands. It does not edit OpenClaw config or restart the gateway.

### Agent-assisted install

If you prefer, hand the install to your OpenClaw agent:

> "Install hypermem following INSTALL.md. I'm running a [solo / multi-agent] setup."

### Operator guides

- **[docs/MEMORY_MD_AUTHORING.md](./docs/MEMORY_MD_AUTHORING.md)**, how to keep `MEMORY.md` compact, durable, and reviewable
- **[docs/TUNING.md](./docs/TUNING.md)**, context assembly and output shaping profiles
- **[docs/MIGRATION_GUIDE.md](./docs/MIGRATION_GUIDE.md)**, moving data in from existing memory systems

### Tuning

Do tuning **after** the install is verified active. If logs still show `legacy` fallback or no compose activity, you do not have a tuning problem yet. You have an install problem.

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

**Key tuning knobs:**
- `verboseLogging` — set to `true` in the compositor config to see per-turn budget resolution in the gateway logs (`budget source:` lines show which window size is active and why).
- `contextWindowOverrides` — override the detected context window per `"provider/model"` key when autodetect gives wrong results for custom, local, or finetuned models. Fixes all downstream budget fractions in one place.

Full reference: **[docs/TUNING.md](./docs/TUNING.md)**

---

## API and CLI references

README keeps the interface surface short. Use the detailed docs for exact examples and release validation commands.

**Runtime API:** import `HyperMem` from `@psiclawops/hypermem` for direct Node.js use, custom tests, and non-OpenClaw integrations. See **[INSTALL.md § Non-OpenClaw usage](./INSTALL.md#non-openclaw-usage)** and package TypeScript declarations for the current interface.

**Operator CLIs:**

```bash
hypermem-status --health
hypermem-status --master
hypermem-model-audit --strict
hypermem-bench --iterations 1000 --warmup 50 --agent main
```

Diagnostics and validation details: **[docs/DIAGNOSTICS.md](./docs/DIAGNOSTICS.md)** and **[docs/INTEGRATION_VALIDATION.md](./docs/INTEGRATION_VALIDATION.md)**.

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

The migration guide includes worked examples showing how to bring data from OpenClaw built-in memory, QMD, ClawText, Cognee, Mem0, Zep, Honcho, memory-lancedb, MEMORY.md files, and custom engines. Each path documents source mapping, dry-run expectations, activation, rollback, and post-migration validation. Adapter snippets are examples unless explicitly shipped as package binaries.

All examples default to dry-run. Nothing is written until you add `--apply`.

Operator guide: **[docs/MIGRATION_GUIDE.md](./docs/MIGRATION_GUIDE.md)**


---

## Identity layer

hypermem handles context assembly and output-profile shaping. The Agentic Cognitive Architecture handles identity: self-authored SOUL files, structured communication contracts, and identity persistence across sessions. Same team, complementary layers.

Design guide: [PsiClawOps/AgenticCognitiveArchitecture](https://github.com/PsiClawOps/AgenticCognitiveArchitecture/)

---

## Acknowledgments

The embedding-space fidelity threshold used in compaction validation was informed by the geometric preservation mathematics published by the [libravdb](https://github.com/xDarkicex/openclaw-memory-libravdb) project.

---

## License

Apache-2.0, [PsiClawOps](https://github.com/PsiClawOps)
