# hyper**mem**

*beyond memory, beyond speed*

---

Your agent forgets. Not because the model is broken — because nothing in the default stack was built to prevent it.

**Output normalization: 40 tokens.** Starter FOS costs less than a single sentence. Starter is ~40 tokens, Standard ~250, Fleet ~400 — negligible overhead for measurable output improvement across every model, every turn.

Context accumulates, gets summarized, loses specifics. Sessions end and the agent wakes up empty. Tool output crowds out reasoning. The wrong history is in the window at the wrong time. These are not edge cases. They are the natural failure modes of treating memory as an afterthought.

OpenClaw already gives agents a solid baseline: workspace memory files, hybrid file search, and compaction safeguards. HyperMem goes deeper. It replaces transcript accumulation with a context engine that assembles prompts fresh from storage on every turn — purpose-built to eliminate each failure mode at the source.

```text
L1  SQLite Cache   Hot session cache (in-memory), identity, compressed recent history
L2  Messages DB    Per-agent conversation history in SQLite
L3  Vectors DB     Per-agent semantic search with sqlite-vec embeddings
L4  Library DB     Fleet-wide structured knowledge, facts, episodes, registry
```

---

## What it solves

### Agents that never forget

When an agent restarts, it wakes up empty. Decisions made, preferences established, work in progress — gone. Operators re-explain context. Agents ask questions they have already asked. The work is real. The memory is not.

HyperMem warms sessions from SQLite into the hot cache before the first turn. The agent picks up mid-conversation. Session continuity is no longer a function of uptime — it is a property of the architecture.

### Context that never collapses

Transcripts grow. Windows fill. Runtimes compact history into a summary — and specifics, tool detail, and work state get lost in the process. The agent keeps going, but degraded.

HyperMem never reaches that cliff. It assembles context fresh on every turn inside a strict token budget. History, facts, recall, and library data compete for tokens intentionally. If the model window changes mid-session, the compositor adapts on the next turn. There is no accumulated transcript to compress.

### Retrieval that actually finds things

Storing everything is not the same as being able to find anything.

FTS5 full-text search catches exact matches. KNN vector search catches semantic matches. Reciprocal Rank Fusion merges both into one ranked result. Trigger-based retrieval handles known patterns. When no trigger matches, bounded semantic fallback keeps the memory slot from coming back empty.

### Tool output that doesn't take over

Long agentic sessions generate a lot of tool output. Left unmanaged, old results crowd out current reasoning.

Tool Context Tuning compresses by turn age. T0 turns stay verbatim. T1 turns become short prose stubs: `Read /src/foo.ts (1.2KB)`, `Ran npm test — exit 0`. T2 and T3 turns drop payloads entirely, keeping message text. Large results keep the head and tail and cut the middle. For multi-agent fleets, compression is tier-aware: director and council agents preserve more context per pass, reflecting their coordination scope; specialists use a tighter cap to stay focused. The live hot cache is refreshed from SQLite after each turn so it never drifts from the source of truth.

### Sessions that stay on topic

Long sessions drift. An agent deep in a database migration does not need deployment context from two hours ago competing for tokens.

HyperMem detects topic shifts with heuristics: explicit subject changes, long gaps, entity overlap between recent turns. When a shift is detected, history scopes to the active topic. Past context does not disappear — cross-topic keystone retrieval pulls high-signal moments back in when they are relevant.

### Knowledge that outlasts the conversation

Most memory systems store what was said. HyperMem synthesizes what was learned.

When a topic goes quiet, HyperMem compiles the thread into a structured wiki page: decisions, open questions, artifacts, participants. No LLM call required — content classifiers do the extraction from stored messages. When the topic resurfaces, the agent gets a compact structured summary rather than a raw history replay. The conversation is gone. The knowledge it produced is not.

### Topics as first-class sessions

When a new topic takes over, the agent doesn't just detect the shift — it switches. Topic-scoped cache warming loads only the relevant context for the active thread. Switching back restores that context cleanly. Natural language cues trigger transitions; ambiguous shifts get a soft confirmation before committing. Each topic is its own coherent working context, searchable across the fleet.

### Subagents that hit the ground running

Spawned subagents start cold. They don't know what the parent was doing, which files were in scope, or what decisions preceded the spawn.

`buildSpawnContext()` snapshots recent parent turns, indexes session-scoped documents, and gives the spawned agent a bounded context block at compose time. Useful context carries forward. Session documents stay isolated from the shared library and are cleaned up when the spawn completes.

---

## Pressure management

HyperMem assembles context fresh on every turn, but a long-running session still accumulates history in its JSONL transcript and cache window. When that grows large enough, incoming tool results have nowhere to land and get silently stripped. Four automatic paths handle this:

| Path | Trigger | Action |
|---|---|---|
| **Pressure-tiered tool-loop trim** | Any tool-loop turn | Measures runtime pressure before results land. >85%: trims to 50% budget. >80%: 60%. >75%: 65%. Also trims the messages[] array returned to the runtime — this is what actually prevents stripping on the current turn, not just the next one |
| **AfterTurn trim** | Every turn at >80% | Pre-emptive headroom cut after the assistant replies, before the next turn arrives |
| **Nuclear compaction** | compact() at >85% | Cuts cache to 25% budget and truncates JSONL to ~20% depth. Bypasses the normal reshape guard |
| **Density-aware JSONL truncation** | compact() | Counts tokens per message, not message count — catches large-message sessions that looked "fine" by count but were full by volume |

**The one thing these paths cannot fix:** a session whose JSONL transcript on disk is already at 98% when the gateway restarts. The JSONL loads into runtime context before any compaction runs. If your pre-restart session was large, you start at whatever pressure that JSONL represents. Check `session_status` immediately on startup. If you're above 85%, start a fresh session — don't attempt tool work.

**Pressure telemetry in logs:**
```
[hypermem-plugin] tool-loop trim: pressure=91.3% → target=50% (cache=43 msgs, messages=67 dropped)
[hypermem-plugin] compact: NUCLEAR — session at 118400/128000 tokens (92% full), deep-trimmed...
```

If you see `tool-loop trim` lines, the machinery is running. If results are still stripped after that log line appears, the session was past the recovery threshold before the trim ran — start fresh.

---

## How it works

1. **Record** each turn into SQLite and mirror hot session state into the cache.
2. **Index** conversations and workspace files for exact and semantic recall.
3. **Assemble** a fresh prompt from history, facts, document chunks, and library data within a strict budget.
4. **Tune** tool-heavy history by turn age so old payloads don't crowd out current work.
5. **Compile** stale topics into structured wiki pages for future recall without raw history replay.
6. **Carry forward** scoped context into subagents when a task needs a narrower working set.

---

## Speed

Benchmarked against a production database: 3,482 facts, 19,853 episodes.

| Operation | avg | p50 | p95 |
|---|---|---|---|
| Cache single slot GET | 0.03ms | 0.02ms | 0.05ms |
| Cache history query (100 messages) | 0.05ms | 0.04ms | 0.08ms |
| L4 facts query (top-28 by confidence×decay) | 0.29ms | 0.28ms | 0.31ms |
| L4 FTS5 keyword search | 0.08ms | 0.076ms | 0.11ms |
| Full 4-layer compose, warm session | 52ms | 52ms | 57ms |
| Full 4-layer compose, cold session (first turn) | 249ms | 54ms | 1,592ms |
| Async pre-embed (background, not user-facing) | 302ms | 146ms | 725ms |

L1 and L4 structured retrieval are sub-millisecond. After the first turn, query embeddings are computed in the background and cached — warm compose averages 52ms with a p95 of 57ms. The cold p95 of 1,592ms happens exactly once per new session, then never again. The async embed cost is paid after the assistant replies; users never wait for it.

---

## Architecture

HyperMem plugs into OpenClaw as a context engine and owns the full prompt composition lifecycle.

**L1: SQLite Cache** is the hot layer. An in-memory SQLite database attached via `ATTACH ':memory:'`. Identity, compressed session history, cached embeddings, topic-scoped context, and fleet registry data. The compositor goes here first on every turn. Zero external dependencies, zero TCP overhead.

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
| Desired State | Per-agent config targets with automatic drift detection |

**The compositor** queries all four layers in parallel on each turn and assembles ten injection categories, each with its own percentage-based budget cap:

| Category | Budget cap |
|---|---|
| Wiki Page synthesis | 15% of remaining |
| Active Facts | 25% of remaining |
| Knowledge | 20% of remaining |
| User Preferences | 10% of remaining |
| Related Memory | 12% of remaining |
| Doc Chunks (ACA) | 40% total, 12% per collection, 3 chunks max |
| Spawn Context | 15% of remaining |
| Other Active Sessions | 20% of remaining |
| FOS/MOD | 40–400 tokens (Starter ~40, Standard ~250, Fleet ~400) |
| Action Verification | Remainder — rolling tool-action buffer |

This is what makes it a compositor, not a retrieval wrapper. Static injection loads files. Budget-aware composition allocates ten competing categories within constraints — on every turn, under pressure. OpenClaw provides the base workspace text. hypermem provides retrieval, synthesis, and budgeted reinjection.

The compositor also runs Tool Context Tuning on history, and assembles the final provider-format context block. A safety valve catches estimation drift and trims post-assembly. Because the budget is computed from the model's actual context window at compose time, a mid-session model swap is absorbed on the next turn with no manual intervention.

---

## Installation

**Let your OpenClaw agent install this.** The configuration varies by deployment shape, and there are enough moving parts that manual setup is error-prone. Hand this to your agent:

> "Install HyperMem following INSTALL.md. I'm running a [solo / multi-agent] setup."

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

**Requirements:** Node.js 22+, OpenClaw with context engine plugin support, Ollama with `nomic-embed-text`.

### Tuning

Drop a `~/.openclaw/hypermem/config.json` to override compositor defaults. Takes effect on gateway restart:

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

This profile targets ~35-45% token reduction for smaller context windows. Full tuning notes are in INSTALL.md.

---

## API

```typescript
import { HyperMem, buildSpawnContext, DocChunkStore, MessageStore } from '@psiclawops/hypermem';

const hm = await HyperMem.create({
  dataDir: '~/.openclaw/hypermem',
  embedding: { ollamaUrl: 'http://localhost:11434', model: 'nomic-embed-text' },
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

// Spawn a subagent with parent context
const spawn = await buildSpawnContext(
  new MessageStore(hm.dbManager.getMessageDb('my-agent')),
  new DocChunkStore(hm.dbManager.getLibraryDb()),
  'my-agent',
  { parentSessionKey: 'agent:my-agent:webchat:main', workingSnapshot: 12 }
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

**Global-scope fact writes trust the caller.** Fine for single-operator alpha. Not safe for untrusted multi-tenant deployments. Write authorization is on the roadmap before any multi-tenant release.

**Full per-turn fact extraction is a future step.** Proactive passes (noise sweep, tool decay) are production. Per-turn LLM-driven fact and episode extraction from live conversations is a follow-on.

**Embedding model hot-swap is not yet implemented.** Current default is `nomic-embed-text`.

---

## Migration

HyperMem doesn't touch your existing memory data. Install it, switch the context engine, and migrate historical data on your own timeline — before or after switching.

Migrations are supported from any memory platform. Worked examples are included in the migration documentation for: **OpenClaw built-in memory, ClawText, Mem0, Honcho, QMD session exports, and Engram**.

All migration scripts default to dry-run. Nothing is written until you add `--apply`.

Operator guide: **[docs/MIGRATION_GUIDE.md](./docs/MIGRATION_GUIDE.md)**

> **For agents:** See [docs/AGENT_MIGRATION.md](./docs/AGENT_MIGRATION.md) for HyperMem's data model, field-level semantics, and mapping examples for each platform. The scripts are helpers — the doc gives you enough to handle any format, including ones without a script.

---

## Roadmap

- [x] Compiled knowledge synthesis
- [x] Virtual Sessions
- [x] Live org registry
- [x] Budget downshift reshape (adaptive budget allocation under context pressure)
- [x] Migration guide and scripts for existing OpenClaw sessions
- [x] Nuclear compaction path (saturated session recovery)
- [x] Pressure-tiered tool-loop trim + messages[] trimming (ingestion wave prevention)
- [x] Runtime-baseline pressure measurement (post-restart accuracy)
- [ ] Versioned atomic re-indexing
- [ ] `hypermem seed --workspace` CLI
- [ ] Embedding model hot-swap
- [ ] Full per-turn fact and episode extraction

---

## License

Apache-2.0 — [PsiClawOps](https://github.com/PsiClawOps)