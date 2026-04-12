# HyperMem — Installation Guide

_For agents and operators installing HyperMem into an OpenClaw instance._

---

## Before you start

**Recommendation: let an agent do this installation.** HyperMem's configuration varies by deployment shape — solo agent vs. multi-agent fleet — and the config surface has enough moving parts that manual installation is error-prone. Hand this document to your primary OpenClaw agent and say:

> "Install HyperMem following INSTALL.md. I'm running a [solo / multi-agent] setup. Ask me if you hit a decision point."

The agent can read your current `openclaw.json`, detect your deployment shape, clone the repo, wire the plugin, and validate the install — all without you touching config files directly.

If you're installing manually, read the full guide below.

---

## What HyperMem does

HyperMem replaces OpenClaw's default context assembly with a four-layer memory system:

```
L1  SQLite Cache   Hot session cache (in-memory) — sub-millisecond reads for recent history and identity
L2  Messages DB    Per-agent SQLite conversation log — survives restarts, rotates at 100MB
L3  Vectors DB     Per-agent semantic search — finds relevant past context by meaning, not keyword
L4  Library DB     Structured knowledge — facts, episodes, preferences, fleet registry
```

Every time an agent is about to reply, HyperMem rebuilds the context from these four layers within your token budget. Old tool output compresses by age. Relevant facts surface. Session restarts resume from where the agent left off.

The default OpenClaw context engine accumulates a raw transcript. HyperMem discards that model and assembles context fresh each turn.

---

## Deployment shapes

HyperMem behaves differently depending on how many agents share an instance.

### Solo agent

One agent, one machine. This is the common case for personal assistants and single-workspace setups.

**Data layout:**
```
~/.openclaw/hypermem/
├── library.db              ← facts, episodes, knowledge (your agent's structured memory)
└── agents/
    └── main/               ← one folder per agent ID
        ├── messages.db     ← conversation history
        └── vectors.db      ← semantic search index
```

**Cache:** One namespace. All keys prefixed `hm:`. The in-memory SQLite cache is the L1 hot layer for session history, identity slots, and the compositor window cache. Zero external dependencies.

**Library DB:** Used by your agent only. No cross-agent scope enforcement matters in practice.

**What to skip:** Fleet registry, org structure, cross-agent visibility tiers, desired state drift detection. These are no-ops for solo use but don't cause errors if left at defaults.

---

### Multi-agent fleet

Multiple named agents sharing one OpenClaw gateway. Council setups, director/specialist hierarchies, any configuration with more than one agent ID.

**Data layout:**
```
~/.openclaw/hypermem/
├── library.db              ← shared fleet knowledge (facts, episodes, fleet registry)
└── agents/
    ├── my-agent/
    │   ├── messages.db     ← agent's conversation history only
    │   └── vectors.db      ← agent's semantic index
    ├── another-agent/
    │   ├── messages.db
    │   └── vectors.db
    └── {agentId}/
        ├── messages.db
        └── vectors.db
```

**Cache:** One namespace, agent-scoped keys. `hm:{agentId}:{sessionKey}:history` — each agent's hot history is separate. The fleet cache (`fleet:agent:{id}`, `fleet:summary`) is shared and used for cross-agent visibility queries.

**Library DB:** Shared. Facts have a `scope` field (`agent` / `session` / `user` / `global`). Agent-scoped facts are only readable by the owning agent. Global-scoped facts are readable fleet-wide — see KNOWN_LIMITATIONS.md before using global scope.

**Cross-agent visibility:** HyperMem enforces org-tier visibility on cross-agent queries (fleet / org / council / private). Agents are registered in `fleet_agents` on first bootstrap. Inter-agent fact queries respect this model automatically.

**What to configure:** Register each agent in the fleet registry on first use. This happens automatically at bootstrap — each agent registers itself with `fleet_agents` when it first runs. No manual step required.

---

## Requirements

| Dependency | Required | Notes |
|---|---|---|
| Node.js 22+ | **Yes** | Uses built-in `node:sqlite` — no native module needed |
| OpenClaw | **Yes** | Any version that supports context engine plugins |
| Ollama | **Yes** | L3 vector layer — semantic search and recall. Install: https://ollama.ai |
| nomic-embed-text | **Yes** | The embedding model HyperMem uses. Pull with: `ollama pull nomic-embed-text` |

Ollama is not optional. Ollama with `nomic-embed-text` is the vector layer — without it, semantic recall is completely disabled and retrieval degrades to keyword-only FTS5 matching. HyperMem will start without it but retrieval will be degraded. The L1 hot cache uses Node.js built-in `node:sqlite` in-memory mode — no external service required.

---

## Installation steps

### Step 1 — Clone the repo

```bash
git clone https://github.com/PsiClawOps/hypermem.git ~/.openclaw/workspace/repo/hypermem
cd ~/.openclaw/workspace/repo/hypermem
npm install
npm run build
npm --prefix plugin install
npm --prefix plugin run build
```

Verify the build is clean:
```bash
npm test
# Should print: ALL N TESTS PASSED ✅
```

### Step 2 — Wire the plugin

Use the OpenClaw CLI. **Do not edit `openclaw.json` directly** — the CLI validates before writing and sends the reload signal.

```bash
# Add the plugin load path
openclaw config set plugins.load.paths '["~/.openclaw/workspace/repo/hypermem/plugin"]' --strict-json

# Set HyperMem as the active context engine
openclaw config set plugins.slots.contextEngine hypermem

# Enable the plugin
openclaw config set plugins.allow '["hypermem"]' --strict-json
```

If you already have entries in `plugins.allow` or `plugins.load.paths`, add to the existing array rather than replacing it. Check current values first:

```bash
openclaw config get plugins.allow
openclaw config get plugins.load.paths
```

### Step 3 — Review and apply OpenClaw setting changes

HyperMem takes over context assembly from OpenClaw's default pipeline. Several OpenClaw defaults that existed to manage the JSONL transcript or control summarization compaction become either irrelevant or counterproductive once HyperMem is active.

**Why it matters:** OpenClaw's built-in engine reads the JSONL transcript and summarizes it when it gets long. HyperMem replaces that entire pipeline — context is assembled from SQLite and the hot cache, never from a growing transcript. A bloated JSONL is now just overhead: it causes the runtime to estimate high token counts, trigger unnecessary compaction checks, and add latency on every turn.

**An installing agent should discuss each of these changes with you before applying them.** The tradeoffs differ depending on your setup.

---

#### Change 1 — Lower OpenClaw's compaction threshold

OpenClaw's default compaction fires LLM-powered summarization when the context approaches `contextWindow - reserveTokens`. HyperMem already owns compaction (`ownsCompaction: true`) and trims the JSONL and cache window itself. If OpenClaw's compaction fires alongside HyperMem's, it attempts to summarize context HyperMem has already managed, producing double-compaction artifacts and unnecessary model calls.

```bash
openclaw config set agents.defaults.compaction.reserveTokens 1000 --strict-json
```

**OpenClaw default:** `reserveTokensFloor: 24000`. At 24K reserved, compaction fires much earlier than needed and races HyperMem's own budget management.

**Tradeoff to discuss:** Setting this to 1000 means OpenClaw's compaction is effectively a last-resort safety net that never fires in normal operation. HyperMem is the sole backstop. That is the correct design — but your agent should confirm you understand HyperMem is now responsible for keeping context in budget.

---

#### Change 2 — Trim the JSONL session store

OpenClaw retains JSONL transcript files and `sessions.json` metadata for 30 days by default, with up to 500 sessions tracked. For agents with frequent sessions, this accumulates quickly. With HyperMem active, the JSONL is not your agent's memory — SQLite is. Retaining large JSONLs provides no memory benefit and slows session store lookups.

```bash
# Prune session store entries after 14 days instead of 30
openclaw config set sessions.maintenance.pruneAfter "14d"

# Cap sessions.json at 200 entries instead of 500
openclaw config set sessions.maintenance.maxEntries 200 --strict-json
```

**OpenClaw defaults:** `pruneAfter: 30d`, `maxEntries: 500`.

**Tradeoff to discuss:** If you use `sessions_list` to browse conversation history older than 14 days, you still need those entries in `sessions.json`. HyperMem's SQLite store is the durable record — session metadata in `sessions.json` is just an index. Ask your agent: "Does anything I use depend on sessions older than 14 days being in the session store?"

---

#### Change 3 — Reduce cron run log retention

OpenClaw writes per-job run logs to `~/.openclaw/cron/runs/<jobId>.jsonl`, defaulting to 2MB per file and 2000 lines retained. For fleets running heartbeat jobs every few minutes, these fill fast and are rarely read beyond the most recent cycle.

```bash
openclaw config set cron.runLog.maxBytes 524288 --strict-json   # 512KB instead of 2MB
openclaw config set cron.runLog.keepLines 500 --strict-json     # 500 lines instead of 2000
```

**OpenClaw defaults:** `maxBytes: 2_000_000`, `keepLines: 2000`.

**Tradeoff to discuss:** 500 lines covers several full heartbeat cycles for most agents. If you debug cron issues frequently and need deeper history, keep `keepLines` higher. This is the lowest-stakes change on the list.

---

#### Change 4 — Session max-age (fleet installs only)

Without a max-age, sessions accumulate indefinitely in `sessions.json`. For multi-agent fleets, this means idle sessions from renamed or replaced agents accumulate forever and slow `sessions_list` queries.

```bash
openclaw config set sessions.maxAgeHours 168 --strict-json  # 7 days
```

**OpenClaw default:** `0` (disabled — sessions never expire by age).

**Tradeoff to discuss:** Named persistent sessions (your main agent, council seats, any agent you expect to resume days later) should not be pruned. If `maxAgeHours: 168` would prune sessions you actively use, either raise it or skip this change and prune manually. Solo installs can skip this entirely.

---

#### Summary — commands to apply after discussion

```bash
# Required: lower compaction threshold
openclaw config set agents.defaults.compaction.reserveTokens 1000 --strict-json

# Recommended: tighter session store retention
openclaw config set sessions.maintenance.pruneAfter "14d"
openclaw config set sessions.maintenance.maxEntries 200 --strict-json

# Recommended: smaller cron run logs
openclaw config set cron.runLog.maxBytes 524288 --strict-json
openclaw config set cron.runLog.keepLines 500 --strict-json

# Fleet only: session max-age
openclaw config set sessions.maxAgeHours 168 --strict-json
```

---

---

## Token budget tuning

HyperMem actively loads context: recent history, facts, semantic recall, doc chunks, and library data all get tokens each turn. For most users on subscription models this is the point — richer context, better responses. But if you want to reduce token burn, every major context slot has a knob.

These settings live in `~/.openclaw/hypermem/config.json`. Create the file if it doesn't exist — HyperMem loads it at startup and merges it over the defaults. A gateway restart is required after changes.

**An installing agent should discuss these tradeoffs with you before setting them.** Cutting the budget too aggressively produces an agent that forgets things mid-conversation. Cutting individual slots (facts, history depth) is lower-risk than cutting the total budget.

### The config file

```json
{
  "compositor": {
    "defaultTokenBudget": 90000,
    "maxHistoryMessages": 250,
    "maxFacts": 28,
    "maxCrossSessionContext": 6000,
    "maxRecentToolPairs": 3,
    "maxProseToolPairs": 10,
    "warmHistoryBudgetFraction": 0.4,
    "keystoneHistoryFraction": 0.2,
    "keystoneMaxMessages": 15
  }
}
```

All fields are optional — omit any you don't want to change.

---

### What each knob does

#### `defaultTokenBudget` — total context ceiling
**Default:** `90000`

The hard cap on tokens HyperMem will assemble per turn. Everything else is a fraction of this. Reducing it compresses all slots proportionally — history gets fewer messages, fewer facts surface, semantic recall shrinks.

**Tradeoff:** Reduces token spend directly but degrades recall quality across the board. Don't go below `40000` without testing — below that, history depth drops to the point where the agent loses conversational thread mid-session.

**Conservative savings target:** `60000` — roughly 30% reduction, acceptable recall for simple single-task agents.

---

#### `maxHistoryMessages` — how many past messages to consider
**Default:** `250`

The maximum messages pulled from SQLite before budget trimming. Budget trimming then cuts this down further based on `defaultTokenBudget`. This knob is the ceiling before budget math runs — lowering it reduces the pool HyperMem picks from.

**Tradeoff:** Low values cause the agent to lose older context even when the token budget has room. `100` is a reasonable reduction for lightweight use.

---

#### `maxFacts` — how many facts to inject
**Default:** `28`

Facts are high-signal structured memory (decisions, config, incidents). Each fact is typically 50–150 tokens. At 28 facts that's up to ~4200 tokens in the facts slot.

**Tradeoff:** Reducing this is low-risk for fresh installs (few facts stored yet), higher-risk for established agents where facts carry important context. `10–15` is a reasonable reduction.

---

#### `maxCrossSessionContext` — cross-session context tokens
**Default:** `6000`

Tokens allocated for context imported from related sessions (subagent inheritance, sibling session summaries). Solo agents with no subagent use can set this to `0` with no impact.

**Tradeoff:** Zero cost for solo agents. For fleet use, reducing this degrades subagent handoff quality.

---

#### `maxRecentToolPairs` — verbatim tool turns kept
**Default:** `3`

The last N tool call/result pairs are kept verbatim (full content). Older pairs are compressed by the Tool Gradient. Reducing this to `1` or `2` compresses tool history more aggressively — useful for tool-heavy agents that run many file reads or searches per turn.

**Tradeoff:** Very recent tool results that are still relevant may get prose-stubbed instead of shown in full. The agent can still see what tool ran and a summary; it just loses the raw output detail.

---

#### `maxProseToolPairs` — compressed tool turns before full drop
**Default:** `10`

Beyond the verbatim window, this many tool pairs get prose stubs (e.g. `Read /src/foo.ts (1.2KB)`) before being dropped entirely. Reducing to `5` means older tool history drops sooner.

**Tradeoff:** Low-risk. Prose stubs are cheap (20–40 tokens each vs 500–5000 for full tool output). The main cost is losing the detail of what a tool returned several turns ago.

---

#### `warmHistoryBudgetFraction` — history share of token budget
**Default:** `0.4` (40%)

The fraction of `defaultTokenBudget` allocated to conversation history. At the default, a 90K budget gives history ~36K tokens — roughly 70–90 recent messages depending on message length. Reducing this fraction shrinks history and leaves more budget for facts and recall.

**Tradeoff:** Shorter effective conversation memory. Going below `0.3` noticeably reduces how far back the agent can see in the current session.

---

#### `keystoneHistoryFraction` — older recalled messages
**Default:** `0.2` (20% of history budget)

HyperMem injects "keystone" messages — older significant turns from earlier in the session — into the history slot to maintain long-range continuity. This fraction controls how many history tokens go to keystones vs. recent messages. Set to `0` to disable keystones entirely.

**Tradeoff:** Disabling keystones saves tokens but the agent loses long-range session continuity. For short-session or task-focused agents this is fine. For persistent agents running multi-hour sessions it degrades noticeably.

---

### Recommended lean profile

For users who want meaningful token savings without breaking core functionality:

```json
{
  "compositor": {
    "defaultTokenBudget": 60000,
    "maxHistoryMessages": 100,
    "maxFacts": 15,
    "maxCrossSessionContext": 2000,
    "maxRecentToolPairs": 2,
    "maxProseToolPairs": 6,
    "warmHistoryBudgetFraction": 0.35,
    "keystoneHistoryFraction": 0.1
  }
}
```

Expected reduction: ~35–45% fewer tokens per turn compared to defaults, depending on conversation style and tool use density. Test with your actual workload — a research-heavy agent pulling lots of web content will see different numbers than a pure chat agent.

Save this file to `~/.openclaw/hypermem/config.json` and restart the gateway.

---

### Step 4 — Restart the gateway

```bash
openclaw gateway restart
```

### Step 5 — Verify

Send any message to your agent. Then check gateway logs:

```bash
openclaw logs --limit 50 | grep hypermem
```

You should see lines like:
```
[hypermem] HyperMem initialized — dataDir=/home/.../.openclaw/hypermem
[hypermem:compose] agent=main triggers=0 fallback=true facts=3 semantic=2 chunks=0 scopeFiltered=0 mode=fallback_knn
```

If you see `[hypermem]` lines, the plugin is active and assembling context.

**If you don't see any hypermem lines:** The plugin didn't load. Check:
```bash
openclaw config get plugins.slots.contextEngine
# Should return: hypermem

openclaw status
# Look for hypermem in the plugins section
```

---

## Verify Ollama before proceeding

Before wiring the plugin, confirm Ollama is up:

```bash
# Ollama
curl -s http://localhost:11434/api/tags | grep nomic
# Expected: a line containing nomic-embed-text
```

If `nomic-embed-text` is not pulled yet:
```bash
ollama pull nomic-embed-text
```

Do not proceed until the expected output is returned. A gateway restart with Ollama missing will leave HyperMem's semantic recall in a degraded state that is easy to confuse with a misconfiguration.

---

## Data directory

HyperMem stores all data in `~/.openclaw/hypermem/` by default. This is created automatically on first run.

```
~/.openclaw/hypermem/
├── library.db              ← L4: structured knowledge, fleet registry, facts
└── agents/
    └── {agentId}/
        ├── messages.db     ← L2: conversation history
        └── vectors.db      ← L3: semantic search index
```

**Backup:** The `library.db` and `messages.db` files are your agent's persistent memory. Back them up before any major upgrade.

**Size:** `messages.db` rotates automatically when it hits 100MB or 90 days. Rotated archives are kept as `messages_2026Q1.db` etc. and remain searchable.

---

## Uninstalling or switching back

To return to OpenClaw's default context engine:

```bash
openclaw config set plugins.slots.contextEngine legacy
openclaw gateway restart
```

Your data in `~/.openclaw/hypermem/` is untouched. You can re-enable HyperMem at any time by switching back to `hypermem`.

---

## Troubleshooting

**Agent is not resuming context after restart**
Check that `~/.openclaw/hypermem/agents/{agentId}/messages.db` exists — if missing, the agent hasn't bootstrapped yet and will create it on first session. The in-memory cache is rebuilt automatically from SQLite on session warm.

**Semantic search not working / no vector results**
Ollama must be running with `nomic-embed-text` pulled. Run `ollama list` to confirm. If missing, `ollama pull nomic-embed-text` and restart the gateway. The background indexer runs on a 5-minute interval — after the first interval you should see embedding activity in `openclaw logs | grep embed`.

**`[hypermem:compose]` shows `facts=0 semantic=0` every turn**
Your library DB is empty — this is expected on a fresh install. Facts and episodes accumulate over real conversations. After a few sessions you'll see these numbers grow. You can also seed workspace files manually using the seeder API.

**Plugin not found / context engine not switching**
Confirm the plugin path is correct: `ls ~/.openclaw/workspace/repo/hypermem/plugin/dist/index.js` should exist. If missing, run `npm --prefix ~/.openclaw/workspace/repo/hypermem/plugin run build`. Then restart the gateway.

---

## Session key format

**Plugin not found / context engine not switching**

HyperMem expects session keys in the format:
```
agent:{agentId}:{channel}:{name}
```

Examples:
- `agent:main:webchat:main`
- `agent:my-agent:discord:main`
- `agent:my-agent:webchat:scratchpad`

OpenClaw sets this automatically. If you're calling the HyperMem API directly, follow this format — the compositor uses it to scope history and facts correctly.

---

## What happens on first boot

1. HyperMem creates `~/.openclaw/hypermem/` and all DB files.
2. The context engine registers with OpenClaw.
3. On your agent's first session, `bootstrap()` runs: creates `agents/{agentId}/messages.db` and `vectors.db`, registers the agent in `library.db fleet_agents`.
4. The hot cache is warmed from SQLite (empty on first boot — nothing to warm).
5. First few conversations are recorded to SQLite. Background indexer starts building vector embeddings after 5 minutes.
6. By session two or three, context assembly starts surfacing facts and episodes from prior conversations.

---

_Questions or issues: file against the hypermem repo or ask in `#clawtext-dev`._
