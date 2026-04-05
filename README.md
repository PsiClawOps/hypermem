# hyper**mem**

*beyond memory, beyond speed*

---

Your agent does not fail because the context window fills up. It fails because the wrong things are in it.

Raw transcript replay treats every turn the same: old tool output, stale workspace docs, and the one critical fact from three sessions ago all compete for the same tokens. By the time the model needs what matters, it is buried or gone. That is not a model problem. It is a context assembly problem.

HyperMem solves it architecturally. Every turn, the compositor rebuilds context from storage — pulling history, facts, semantic recall, and structured knowledge within a strict token budget. Nothing accumulates. Nothing gets summarized away. The agent gets exactly what it needs, assembled fresh.

```
L1  Redis         Hot session cache, compressed recent history, identity
L2  Messages DB   Per-agent conversation history (SQLite, rotatable)
L3  Vectors DB    Per-agent semantic search (sqlite-vec, 768d)
L4  Library DB    Fleet-wide facts, knowledge, episodes, work, and registry
```

---

## What this changes

Agent context management has a set of failure modes that show up consistently at scale. HyperMem addresses each one at the architecture level:

**No transcript bloat.** Context is assembled fresh each turn from structured storage. The compositor fills your token budget with what is relevant, not everything that happened.

**No destructive compaction.** There is no accumulating transcript to compact. The runtime's legacy compaction is bypassed entirely. HyperMem owns its own context lifecycle.

**No cold-start amnesia.** Session restarts warm from SQLite and Redis in milliseconds. The agent picks up where it left off.

**No retrieval tax.** Hybrid FTS5 and vector search with Reciprocal Rank Fusion, backed by a hot Redis cache. Retrieval adds less than 4ms at L4 depth. Hot cache reads are measured in microseconds.

**Cold-start coherence.** Agents resume mid-conversation after a full restart. Session continuity is not a function of uptime. Validated against the production fleet.

---

## How it works

1. **Record** each turn into SQLite, mirror recent history into Redis.
2. **Index** conversations and workspace files for semantic recall.
3. **Assemble** a fresh prompt from history, facts, doc chunks, and library data within a token budget.
4. **Compress** tool-heavy history by turn age so recent detail stays available without old tool output taking over the window.
5. **Carry context forward** into spawned subagents when a task needs a narrower working set.

---

## What ships in 0.3.0

### Context engine plugin

HyperMem plugs into OpenClaw as a context engine. It records turns, assembles prompts, warms Redis on bootstrap, refreshes compressed hot history after each turn, and owns compaction. Drop-in replacement for the default context assembly pipeline.

### Hybrid retrieval

Recall uses FTS5 full-text search and vector similarity, fused with Reciprocal Rank Fusion. When trigger-based retrieval misses, HyperMem falls back to bounded semantic search. The agent always gets something relevant rather than an empty memory slot.

### Tool Gradient v2

Tool history compresses by turn age, not raw message count. Turn ages 0-4 stay verbatim. Ages 5-10 get prose stubs. Ages 11+ drop payloads entirely while preserving message text. Large results keep the head and tail, cut the middle. Redis hot history is recomputed from SQLite after each turn.

### Subagent context inheritance

Parent agents snapshot recent turns, attach session-scoped document chunks, and pass both into spawned subagents. Useful context moves forward. Session-scoped documents stay isolated from the shared library and are cleaned up after the spawn completes.

### Structured library (L4)

L4 stores typed facts with confidence and expiry, knowledge, episodes, preferences, work items, fleet registry data, system state, session records, and desired state for drift detection. Ten collections, one shared database per fleet.

### Workspace seeding

Workspace files — `AGENTS.md`, `SOUL.md`, daily memory, project docs — chunk and index into library collections with source-hash deduplication and idempotent re-indexing.

---

## Installation

**Recommendation: let your OpenClaw agent install this.** HyperMem's configuration varies by deployment shape — solo agent vs. multi-agent fleet — and the install surface has enough moving parts that manual setup is error-prone. Hand this to your agent:

> "Install HyperMem following INSTALL.md. I'm running a [solo / multi-agent] setup."

The agent will read your current config, detect your deployment shape, clone the repo, wire the plugin, and validate the install.

Full installation guide: **[INSTALL.md](./INSTALL.md)**

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

Verify: `openclaw logs --limit 50 | grep hypermem` — you should see `[hypermem:compose]` lines.

**Requirements:**
- Node.js 22+ (uses built-in `node:sqlite`)
- OpenClaw (any version supporting context engine plugins)
- Redis 7+ (optional — degrades gracefully to SQLite-only)
- Ollama + `nomic-embed-text` (optional — enables vector/semantic search)

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

// Record and compose
await hm.recordUserMessage(agentId, sessionKey, 'How does drift detection work?');
const composed = await hm.compose({
  agentId,
  sessionKey,
  prompt: 'How does drift detection work?',
  tokenBudget: 4000,
  provider: 'anthropic',
});

// Refresh compressed Redis view after each turn
await hm.refreshRedisGradient(agentId, sessionKey);

// Spawn a subagent with parent context
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

**Global-scope fact writes trust the caller.** Acceptable for a single-operator alpha. Not safe for untrusted multi-tenant use. Write authorization enforcement is on the roadmap.

**Live background extraction is partly wired.** The framework is complete. Full per-turn extraction from live conversations remains a follow-on step.

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
