# hypermem — Installation Guide

## Quick Start

```bash
git clone https://github.com/PsiClawOps/hypermem.git
cd hypermem
npm install && npm run build
npm --prefix plugin install && npm --prefix plugin run build
npm --prefix memory-plugin install && npm --prefix memory-plugin run build
```

Wire both plugins into OpenClaw:

```bash
openclaw config set plugins.load.paths '["<path-to-hypermem>/plugin","<path-to-hypermem>/memory-plugin"]' --strict-json
openclaw config set plugins.slots.contextEngine hypercompositor
openclaw config set plugins.slots.memory hypermem
openclaw config set plugins.allow '["hypercompositor","hypermem"]' --strict-json
openclaw gateway restart
```

Replace `<path-to-hypermem>` with the absolute path where you cloned the repo.

Send a message to any agent, then verify:

```bash
openclaw logs --limit 50 | grep hypermem
```

You should see `[hypermem] hypermem initialized` and `[hypermem:compose]` lines. Done.

---

## What hypermem Does

hypermem replaces OpenClaw's default context assembly with a four-layer memory system. Every turn, it queries all layers in parallel and composes context within a fixed token budget. No transcript accumulates. No lossy summarization. Content that doesn't fit this turn stays in storage instead of being destroyed.

| Layer | Storage | What it holds | Speed |
|---|---|---|---|
| **L1** | SQLite in-memory | Session cache: identity, recent history, active state | 0.08ms |
| **L2** | Per-agent SQLite | Conversation history, survives restarts, rotates at 100MB | 0.13ms |
| **L3** | Per-agent SQLite + sqlite-vec | Semantic search via embeddings | 0.29ms |
| **L4** | Shared SQLite | Structured knowledge: facts, episodes, preferences, fleet registry | 0.09ms |

Everything runs in-process. No external database services required.

---

## Requirements

| Dependency | Required | Notes |
|---|---|---|
| Node.js 22+ | **Yes** | Uses built-in `node:sqlite`. No standalone SQLite install needed. |
| OpenClaw | **Yes** | Any version with context engine plugin support |
| Ollama | Local embeddings only | [ollama.ai](https://ollama.ai) — pull `nomic-embed-text` |
| OpenRouter API key | Hosted embeddings only | Alternative to local: [openrouter.ai](https://openrouter.ai) |
| Gemini API key | Gemini embeddings only | Alternative: [aistudio.google.com](https://aistudio.google.com/apikey) |

`sqlite-vec` is the only native dependency and installs automatically via npm.

The **embedding layer** (L3 semantic search) requires a configured provider. Without one, hypermem falls back to FTS5 keyword matching. This is functional but degrades recall quality. See [Embedding Providers](#embedding-providers) below.

---

## Embedding Providers

Pick a tier based on your hardware:

| Tier | Provider | Quality | Cost | Setup |
|---|---|---|---|---|
| **Minimal** | None (FTS5 keyword only) | Keyword-only, no semantic recall | Free | None |
| **Local** | Ollama + nomic-embed-text (768d) | Good | Free | Ollama required |
| **Hosted** | OpenRouter + Qwen3 Embedding 8B (4096d) | Best (MTEB #1) | ~pennies/day | API key |
| **Gemini** | Google Gemini Embedding (768d) | Good | Free tier available | API key |

### Minimal (no embedder)

No config needed. hypermem detects the missing provider at startup and falls back to FTS5. You lose semantic recall ("find facts about X even if X isn't mentioned literally") but history, facts, and fleet registry all work.

You'll see in the logs:
```
[hypermem] No embedding provider configured — semantic search disabled, using FTS5 fallback
```

Upgrade to a higher tier later without losing stored data.

### Local — Ollama + nomic-embed-text

```bash
ollama pull nomic-embed-text
```

No config file needed. Ollama on `localhost:11434` with `nomic-embed-text` is the default. Requires ~1GB RAM for the model.

### Hosted — OpenRouter + Qwen3 Embedding 8B (Recommended)

Best quality, no local compute. Embedding is async and doesn't affect agent response time.

Create or edit `~/.openclaw/hypermem/config.json`:

```json
{
  "embedding": {
    "provider": "openai",
    "openaiApiKey": "sk-or-YOUR_OPENROUTER_KEY",
    "openaiBaseUrl": "https://openrouter.ai/api/v1",
    "model": "qwen/qwen3-embedding-8b",
    "dimensions": 4096,
    "batchSize": 128
  }
}
```

Get a key at [openrouter.ai](https://openrouter.ai). Cost at typical agent volumes: under a cent per day.

### Gemini

Create or edit `~/.openclaw/hypermem/config.json`:

```json
{
  "embedding": {
    "provider": "gemini",
    "geminiApiKey": "YOUR_GEMINI_API_KEY",
    "model": "text-embedding-004",
    "dimensions": 768,
    "batchSize": 128
  }
}
```

Get a key at [aistudio.google.com](https://aistudio.google.com/apikey). The free tier covers typical agent usage.

Optional Gemini-specific settings:
- `geminiBaseUrl`: defaults to `https://generativelanguage.googleapis.com`
- `geminiIndexTaskType`: defaults to `RETRIEVAL_DOCUMENT`
- `geminiQueryTaskType`: defaults to `RETRIEVAL_QUERY`

### Switching providers

Changing providers after vectors are built requires a full re-index (dimensions are incompatible):

```bash
node scripts/embed-existing.mjs
```

Fresh installs don't need this.

---

## Installation Steps

### Step 1 — Clone and build

```bash
git clone https://github.com/PsiClawOps/hypermem.git
cd hypermem
npm install
npm run build
```

Build both plugins:

```bash
npm --prefix plugin install && npm --prefix plugin run build
npm --prefix memory-plugin install && npm --prefix memory-plugin run build
```

Verify:

```bash
npm test
# Should print: ALL N TESTS PASSED ✅
```

### Step 2 — Wire the plugins

Use the OpenClaw CLI. **Do not edit `openclaw.json` directly.**

```bash
# Add plugin load paths (use absolute paths)
openclaw config set plugins.load.paths '["<path-to-hypermem>/plugin","<path-to-hypermem>/memory-plugin"]' --strict-json

# Set the context engine slot
openclaw config set plugins.slots.contextEngine hypercompositor

# Set the memory slot
openclaw config set plugins.slots.memory hypermem

# Allow both plugins
openclaw config set plugins.allow '["hypercompositor","hypermem"]' --strict-json
```

If you already have entries in `plugins.allow` or `plugins.load.paths`, merge rather than replace. Check current values:

```bash
openclaw config get plugins.allow
openclaw config get plugins.load.paths
```

### Step 3 — Choose embedding tier

See [Embedding Providers](#embedding-providers) above. For Minimal, skip this step. For Local, pull the model. For Hosted or Gemini, create `~/.openclaw/hypermem/config.json` with the appropriate config block.

### Step 4 — Restart and verify

```bash
openclaw gateway restart
```

Send a message to any agent, then check:

```bash
openclaw logs --limit 50 | grep hypermem
```

Expected:
```
[hypermem] hypermem initialized — dataDir=/home/.../.openclaw/hypermem
[hypermem:compose] agent=main triggers=0 fallback=true facts=3 semantic=2 ...
```

Full health check:

```bash
node bin/hypermem-status.mjs              # full dashboard
node bin/hypermem-status.mjs --health     # health checks only (exit 1 on failure)
```

If the plugin didn't load:

```bash
openclaw config get plugins.slots.contextEngine   # should be: hypercompositor
openclaw config get plugins.slots.memory           # should be: hypermem
openclaw status                                     # look for hypermem in plugins
```

### Step 5 — Configure your fleet

hypermem works out of the box for both single-agent and multi-agent installs. The source ships with generic placeholder agent names (`agent1`, `agent2`, `director1`, etc.) in two files that define fleet topology:

| File | What it defines |
|---|---|
| `src/cross-agent.ts` | Org membership, agent tiers, visibility scoping |
| `src/background-indexer.ts` | Agent-to-domain mapping for fact classification |

#### Single-agent installs

No code changes needed. hypermem resolves your agent ID from your OpenClaw config at runtime. The placeholder names are never used.

Verify it's working after Step 4:

```bash
openclaw logs --limit 20 | grep hypermem
```

You should see your agent ID (not a placeholder) in the compose logs:

```
[hypermem:compose] agent=my-agent triggers=0 fallback=true facts=3 semantic=2 ...
```

Facts, episodes, and topics are all scoped to your agent ID automatically. Cross-agent features (org visibility, shared facts) are dormant with a single agent and activate only when additional agents are configured.

#### Multi-agent installs

hypermem ships with generic placeholder agent names (`agent1`, `agent2`, `director1`, etc.) in the two fleet topology files listed above.

Replace the placeholder names with your fleet:

**1. Edit `src/cross-agent.ts`** — replace the `agents` map and `orgs` map in `defaultOrgRegistry()` with your fleet:

```typescript
// Before (placeholder):
agent1: { agentId: 'agent1', tier: 'council' },

// After (your fleet):
architect: { agentId: 'architect', tier: 'council' },
```

**2. Edit `src/background-indexer.ts`** — update `AGENT_DOMAIN_MAP` with your agent IDs and their domains:

```typescript
// Before (placeholder):
agent1: 'infrastructure',

// After (your fleet):
architect: 'infrastructure',
```

**3. Rebuild and restart:**

```bash
npm run build
npm --prefix plugin run build
openclaw gateway restart
```

Agents not listed in `AGENT_DOMAIN_MAP` default to domain `'general'`, which is fine for most setups. The org registry only matters if you use cross-agent memory visibility (org-scoped or council-scoped facts). If all your facts are agent-private or fleet-wide, you can skip the org structure entirely.

**Test fixtures use the placeholder names by design.** Don't rename them in `test/` — the tests validate the cross-agent logic, not your specific fleet topology.

---

## Upgrading from 0.5.x

```bash
cd <path-to-hypermem>
git pull
npm install
npm run build
npm --prefix plugin install && npm --prefix plugin run build
npm --prefix memory-plugin install && npm --prefix memory-plugin run build
openclaw gateway restart
```

What changed in 0.5.x releases:
- **0.5.5**: Plugin config schema, tuning knobs moved into `openclaw.json`. Manual `config.json` edits for compositor settings may be superseded by the plugin schema.
- **0.5.6**: Content fingerprint dedup, indexer circuit breaker, SQL parameterization hardening.
- **Exports field** added to `package.json`: if you import from `@psiclawops/hypermem`, verify your import paths still resolve.

If you switch embedding providers during the upgrade, re-index:

```bash
node scripts/embed-existing.mjs
```

Check [CHANGELOG.md](CHANGELOG.md) for the full list of changes per version.

**Build errors after upgrade:** Clean `dist/` directories and rebuild:

```bash
rm -rf dist plugin/dist memory-plugin/dist
npm run build
npm --prefix plugin run build
npm --prefix memory-plugin run build
```

---

## OpenClaw Settings (Optional Tuning)

These are optional. hypermem works with OpenClaw defaults, but these changes reduce unnecessary overhead.

### Lower OpenClaw's compaction threshold

hypermem owns compaction. OpenClaw's default fires at 24K reserved tokens, which races hypermem's budget management:

```bash
openclaw config set agents.defaults.compaction.reserveTokens 1000 --strict-json
```

This makes OpenClaw's compaction a last-resort safety net that never fires in normal operation.

### Tighter session store retention

With hypermem active, SQLite is the durable record. JSONL transcripts provide no memory benefit:

```bash
openclaw config set sessions.maintenance.pruneAfter "14d"
openclaw config set sessions.maintenance.maxEntries 200 --strict-json
```

OpenClaw defaults: `pruneAfter: 30d`, `maxEntries: 500`. If you browse conversation history older than 14 days via the session list, keep the higher value.

### Session max-age (fleet installs only)

Prevents idle sessions from accumulating indefinitely:

```bash
openclaw config set sessions.maxAgeHours 168 --strict-json  # 7 days
```

Solo installs can skip this.

---

## Token Budget Tuning

These settings live in `~/.openclaw/hypermem/config.json` under the `compositor` key. All fields are optional. Gateway restart required after changes.

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

| Knob | Default | What it controls | Safe reduction |
|---|---|---|---|
| `defaultTokenBudget` | 90000 | Total token ceiling per turn. Don't go below 40000. | 60000 |
| `maxHistoryMessages` | 250 | Messages pulled before budget trimming | 100 |
| `maxFacts` | 28 | Structured facts injected (50-150 tokens each) | 10–15 |
| `maxCrossSessionContext` | 6000 | Cross-session context tokens. Solo agents: set to 0. | 2000 |
| `maxRecentToolPairs` | 3 | Verbatim tool call/result pairs kept | 2 |
| `maxProseToolPairs` | 10 | Compressed tool pairs before full drop | 5 |
| `warmHistoryBudgetFraction` | 0.4 | History's share of total budget. Below 0.3 hurts. | 0.35 |
| `keystoneHistoryFraction` | 0.2 | Older significant turns recalled for continuity | 0.1 |

**Lean profile** (~35-45% fewer tokens per turn):

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

---

## Data Directory

Created automatically on first run at `~/.openclaw/hypermem/`:

```
~/.openclaw/hypermem/
├── config.json             ← embedding and compositor tuning (user-created)
├── library.db              ← L4: facts, episodes, knowledge, fleet registry (shared)
└── agents/
    └── {agentId}/
        ├── messages.db     ← L2: conversation history (per-agent)
        └── vectors.db      ← L3: semantic search index (per-agent)
```

**Backup:** `library.db` and per-agent `messages.db` files are persistent memory. Back them up before major upgrades.

**Rotation:** `messages.db` rotates at 100MB or 90 days. Archives (`messages_2026Q1.db` etc.) remain searchable.

---

## Troubleshooting

**Semantic search not working / no vector results**

Check your embedding tier:
- **Local (Ollama):** Confirm Ollama is running with `ollama list`. If `nomic-embed-text` is missing, `ollama pull nomic-embed-text` and restart the gateway.
- **Hosted (OpenRouter):** Verify `openaiApiKey` and `openaiBaseUrl` in `~/.openclaw/hypermem/config.json`.
- **Gemini:** Verify `geminiApiKey` in config.
- **Minimal:** Semantic search is intentionally disabled. FTS5 keyword fallback is active.

The background indexer runs on a 5-minute interval. After the first cycle, check `openclaw logs | grep embed`.

**`facts=0 semantic=0` every turn**

Expected on fresh installs. Facts and episodes accumulate over real conversations. After a few sessions these numbers grow. Workspace files can be seeded manually via the seeder API.

**Plugin not found**

Confirm the build artifacts exist:

```bash
ls <path-to-hypermem>/plugin/dist/index.js
ls <path-to-hypermem>/memory-plugin/dist/index.js
```

If missing, rebuild:

```bash
npm --prefix <path-to-hypermem>/plugin run build
npm --prefix <path-to-hypermem>/memory-plugin run build
```

Then restart the gateway.

**Build errors after upgrade**

Clean `dist/` and rebuild:

```bash
rm -rf dist plugin/dist memory-plugin/dist
npm run build
npm --prefix plugin run build
npm --prefix memory-plugin run build
```

**Agent not resuming context after restart**

Check that `~/.openclaw/hypermem/agents/{agentId}/messages.db` exists. If missing, the agent hasn't bootstrapped yet and will create it on first session.

---

## Uninstalling

To return to OpenClaw's default context engine:

```bash
openclaw config set plugins.slots.contextEngine legacy
openclaw config set plugins.slots.memory none
openclaw gateway restart
```

Data in `~/.openclaw/hypermem/` is untouched. Re-enable by switching back.

---

_Questions or issues: file against [the repo](https://github.com/PsiClawOps/hypermem) or ask in `#hypermem`._
