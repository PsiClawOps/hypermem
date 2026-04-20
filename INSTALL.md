# hypermem — Installation Guide

## Prerequisites

- **Node.js 22+** (uses built-in `node:sqlite`)
- **OpenClaw** must already be installed, onboarded, and running. HyperMem is a plugin for an existing OpenClaw deployment -- it does not bootstrap OpenClaw itself. If you have never run `openclaw gateway start` or completed OpenClaw onboarding, do that first. The HyperMem install guide picks up after OpenClaw is operational.
- **Disk space:** allow at least 2 GB free. Plugin builds pull OpenClaw as a dev dependency.

**Verify before starting:**

```bash
openclaw gateway status    # should show "running" or "ready"
openclaw config get gateway # should return gateway config, not an error
```

If `gateway status` shows "disabled" or "not configured", complete OpenClaw onboarding first. `openclaw gateway restart` only works when the gateway service is already set up. On a brand-new OpenClaw install that has never been started, you need `openclaw gateway start` (or the full onboarding flow) before installing plugins.

## Quick Start

```bash
npm install @psiclawops/hypermem
npx hypermem-install
```

`hypermem-install` stages the plugin runtime into `~/.openclaw/plugins/hypermem`. It does **not** modify your OpenClaw config and does **not** restart the gateway.

> **Prerequisites:** OpenClaw must be installed and onboarded. Run `openclaw gateway status` to confirm. If the gateway is not configured, complete OpenClaw setup first.
>
> **Config merge warning:** if you already have values in `plugins.load.paths` or `plugins.allow`, merge them instead of overwriting blindly.

Create the config directory and set the embedding provider:

```bash
mkdir -p ~/.openclaw/hypermem
cat > ~/.openclaw/hypermem/config.json <<'JSON'
{
  "embedding": {
    "provider": "none"
  }
}
JSON
```

Wire both plugins into OpenClaw:

**Step 1: Check your existing config (mandatory — do this before wiring).**

```bash
openclaw config get plugins.load.paths
openclaw config get plugins.allow
```

Note any existing values. You must include them in the commands below.

**Step 2: Wire plugins.**

```bash
# Wire plugin load paths — merge with any existing paths from Step 1:
openclaw config set plugins.load.paths "[\"${HOME}/.openclaw/plugins/hypermem/plugin\",\"${HOME}/.openclaw/plugins/hypermem/memory-plugin\"]" --strict-json

# Set the context engine and memory slots:
openclaw config set plugins.slots.contextEngine hypercompositor
openclaw config set plugins.slots.memory hypermem

# Allow both plugins — merge with any existing allowed plugins from Step 1.
# Example (if "my-plugin" was already allowed):
ocplatform config set plugins.allow '["my-plugin","hypercompositor","hypermem"]' --strict-json
```

> **⚠️  Merge, don't replace.** The command above sets `plugins.allow` to whatever you specify. If `plugins.allow` was non-empty in Step 1, include those entries in the array. Replacing it drops existing plugins (including bundled OpenClaw CLI surfaces and channel plugins).

**Step 3: Restart.**

```bash
openclaw gateway restart
```

OpenClaw loads the plugin runtime from `~/.openclaw/plugins/hypermem/`.

### Verification checkpoints

1. **Build verified**
   - root build succeeds
   - `plugin` build succeeds
   - `memory-plugin` build succeeds

2. **Wiring verified**
   - OpenClaw accepts `plugins.load.paths`
   - slots are set to `hypercompositor` and `hypermem`
   - gateway restart succeeds

3. **Runtime verified active**

Send a message to any agent, then verify:

```bash
openclaw logs --limit 100 | grep -E 'hypermem|context-engine'
```

Expected lightweight-mode lines:
- `[hypermem] hypermem initialized`
- `[hypermem] Embedding provider: none — semantic search disabled, using FTS5 fallback`
- `[hypermem:compose]`

If you see a fallback like `falling back to default engine "legacy"`, the install is **not** fully active yet even if the build and wiring steps succeeded.

---

## What hypermem Does

hypermem replaces OpenClaw's default context assembly with a four-layer SQLite-backed memory system. Every turn, it queries all layers in parallel and composes context within a fixed token budget. No transcript accumulates. No lossy summarization. Content that doesn't fit this turn stays in storage instead of being destroyed.

| Layer | Storage | What it holds | Speed |
|---|---|---|---|
| **L1** | SQLite in-memory | Session cache: identity, recent history, active state | 0.08ms |
| **L2** | Per-agent SQLite | Conversation history, survives restarts, rotates at 100MB | 0.13ms |
| **L3** | Per-agent SQLite + sqlite-vec | Semantic search via embeddings | 0.29ms |
| **L4** | Shared SQLite | Structured knowledge: facts, episodes, preferences, fleet registry | 0.09ms |

Everything runs in-process on SQLite memory databases. No external database services required.

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

> **Package versions:** the root package (`hypermem`) and the two plugins (`hypercompositor`, `hypermem-memory`) are versioned independently. Plugin versions trail the core by one minor version when no plugin-facing API changes ship in a release — this is expected.

The **embedding layer** (L3 semantic search) requires a configured provider. Without one, hypermem falls back to FTS5 keyword matching. This is functional but degrades recall quality. See [Setup Styles](#setup-styles) below.

---

## Setup Styles

Pick a style based on your hardware and cost tolerance. All styles support full history, fact recall, and session continuity — the differences are in semantic search quality and local resource requirements.

| Style | Embedding | Reranker | Semantic recall | Cost | Hardware |
|---|---|---|---|---|---|
| **Lightweight** | None (FTS5 only) | None | Keyword match only | Free | Any |
| **Local** | Ollama nomic-embed-text | None (RRF) or Ollama Qwen3-Reranker (GPU only) | Good | Free | ~1GB RAM + GPU for reranker |
| **High** | OpenRouter Qwen3-8B | OpenRouter Cohere Rerank 4 | Best (MTEB #1) | ~pennies/day | API key |

The **reranker is optional at every tier.** Without one, results are ordered by RRF fusion score (FTS5 + vector) — a solid default. The reranker improves precision but requires a GPU for the local option; CPU-only systems should leave it as None.

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

No Ollama, no API key. This config must exist **before gateway restart and runtime verification** so the clean install validates the intended lightweight behavior. Set `provider: 'none'` explicitly in `~/.openclaw/hypermem/config.json` to disable embedding entirely:

```json
{
  "embedding": {
    "provider": "none"
  }
}
```

Without a config file, the default provider is `ollama` — if Ollama isn't running, the vector store initialization fails non-fatally and hypermem falls back to FTS5. Using `provider: 'none'` makes the intent explicit and avoids the init attempt.

You'll see in the logs:
```
[hypermem] Embedding provider: none — semantic search disabled, using FTS5 fallback
```

Upgrade to a higher tier later without losing stored data.

### Troubleshooting clean installs

**Symptom:** `Context engine "hypercompositor" ... falling back to default engine "legacy"`
- The plugin was found, but the context engine did not activate correctly.
- Treat the install as failed at runtime, not successful.
- Check for release artifact mismatch, stale plugin build output, or config collisions with existing plugin paths.

**Symptom:** HyperMem logs never appear after restart
- Re-check `plugins.load.paths` for exact absolute paths.
- Confirm the clone directory still exists and was not created in a temp location.
- Confirm existing `plugins.allow` and `plugins.load.paths` values were merged correctly instead of overwritten incorrectly.

**Symptom:** build succeeds, but behavior is not lightweight mode
- Confirm `~/.openclaw/hypermem/config.json` existed before restart.
- Confirm it contains:
  ```json
  {
    "embedding": {
      "provider": "none"
    }
  }
  ```

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

## Reranker (Optional)

The reranker re-orders semantic search candidates by relevance before injection. Without it, results are ordered by RRF fusion score (FTS5 + KNN). The reranker is optional — the system degrades gracefully to original order on any failure.

| Provider | Model | Cost | Hardware | Notes |
|---|---|---|---|---|
| **None** | — | Free | Any | Default — RRF fusion ordering |
| **Ollama (local)** | Qwen3-Reranker-0.6B | Free | GPU recommended | CPU-only: too slow for >5 candidates |
| **OpenRouter** | cohere/rerank-4-pro | ~pennies/day | Any | Best quality, uses existing key |
| **ZeroEntropy** | zerank-2 | ~pennies/day | Any | Dedicated reranking service |

**CPU-only systems:** skip the local reranker. Sequential inference makes it 2-10 seconds per document on CPU — unusable at any reasonable candidate depth. RRF fusion (`provider: "none"`) is the right default for CPU-only setups and is meaningfully better than raw vector ordering alone.

### No reranker (default)

No config needed. RRF fusion of FTS5 + vector results is the default ordering. For most conversational memory workloads, this is sufficient and runs on any hardware.

### Local — Ollama Qwen3-Reranker-0.6B

Best option for air-gapped or GPU-equipped setups. Slower than hosted due to sequential inference (one model call per candidate document) — requires a GPU for practical use.

```bash
ollama pull dengcao/Qwen3-Reranker-0.6B:Q5_K_M
```

Add to `~/.openclaw/hypermem/config.json`:

```json
{
  "reranker": {
    "provider": "local",
    "ollamaUrl": "http://localhost:11434",
    "ollamaModel": "dengcao/Qwen3-Reranker-0.6B:Q5_K_M",
    "topK": 10,
    "minCandidates": 5
  }
}
```

### Hosted — OpenRouter (Cohere Rerank 4)

Fastest, highest quality. Uses the same OpenRouter key as hosted embeddings if you already have one.

Put the key in your environment, not the config file:

```bash
export OPENROUTER_API_KEY="sk-or-YOUR_OPENROUTER_KEY"
```

Then in `~/.openclaw/hypermem/config.json`:

```json
{
  "reranker": {
    "provider": "openrouter",
    "openrouterModel": "cohere/rerank-4-pro",
    "topK": 10,
    "minCandidates": 5
  }
}
```

`openrouterApiKey` in the config file is still honored as a fallback for compatibility, but env-var-first keeps credentials out of any config-under-version-control.

### Hosted — ZeroEntropy (zerank-2)

Alternative hosted option, specialized reranking service.

```bash
export ZEROENTROPY_API_KEY="YOUR_ZEROENTROPY_KEY"
```

Then:

```json
{
  "reranker": {
    "provider": "zeroentropy",
    "zeroEntropyModel": "zerank-2",
    "topK": 10,
    "minCandidates": 5
  }
}
```

`zeroEntropyApiKey` in the config file is still honored as a fallback. Get a key at [zeroentropy.dev](https://zeroentropy.dev).

---

## Installation Steps

### Step 1 — Source Build (contributors)

> **Most users should use the npm Quick Start above.** This section is for contributors or users who need to modify HyperMem source.

```bash
git clone https://github.com/PsiClawOps/hypermem.git
cd hypermem
npm install
npm run build
```

Build both plugins, then install the runtime payload into OCPlatform's durable plugin directory:

```bash
npm --prefix plugin install && npm --prefix plugin run build
npm --prefix memory-plugin install && npm --prefix memory-plugin run build
npm run install:runtime
```

Verify:

```bash
npm test
```

The full suite takes 30–60 seconds. When complete, output ends with `N passed, 0 failed`. If you see `ENOSPC`, free up disk space and retry.

### Step 2 — Wire the plugins

Use the OpenClaw CLI. **Do not edit `openclaw.json` directly.**

```bash
# Check existing values first — merge if non-empty:
ocplatform config get plugins.load.paths
openclaw config get plugins.allow

# Wire plugin load paths (merge with any existing paths):
openclaw config set plugins.load.paths "[\"${HOME}/.openclaw/plugins/hypermem/plugin\",\"${HOME}/.openclaw/plugins/hypermem/memory-plugin\"]" --strict-json

# Set the context engine and memory slots:
openclaw config set plugins.slots.contextEngine hypercompositor
openclaw config set plugins.slots.memory hypermem

# Allow both plugins — merge with any existing allowed plugins (example includes "my-plugin"):
ocplatform config set plugins.allow '["my-plugin","hypercompositor","hypermem"]' --strict-json
```

> **⚠️  Merge, don't replace.** Check `openclaw config get plugins.allow` before running this command and include all existing entries in the array.

### Step 3 — Choose embedding provider

See [Embedding Providers](#embedding-providers) above.

- **Lightweight (no embedder):** create `~/.openclaw/hypermem/config.json` with `{"embedding":{"provider":"none"}}`. The Quick Start block above already does this. Without this file, the default provider is `ollama` and you'll see a non-fatal init warning if Ollama isn't running.
- **Local:** `ollama pull nomic-embed-text`. No config file needed (Ollama is the default).
- **Hosted/Gemini:** create `~/.openclaw/hypermem/config.json` with the provider config block from the relevant section above.

### Step 4 — Restart and verify

```bash
openclaw gateway restart
```

> **If restart reports the gateway is disabled or not configured:** you need to complete OpenClaw onboarding before this step. See [Prerequisites](#prerequisites). `gateway restart` only works on an already-running gateway.

Send a message to any agent, then check:

```bash
openclaw logs --limit 50 | grep hypermem
```

> **If `openclaw logs` fails with an auth or token error:** the gateway API requires authentication. Run `openclaw gateway status` to confirm the gateway is running and accessible. If the gateway is running but logs fail, check `openclaw config get gateway.token` and ensure your shell session has the correct auth context.

Expected:
```
[hypermem] hypermem initialized — dataDir=/home/.../.openclaw/hypermem
[hypermem:compose] agent=main triggers=0 fallback=true facts=3 semantic=2 ...
```

Full health check (run from the repo clone directory — `bin/` is a relative path):

```bash
node bin/hypermem-status.mjs              # full dashboard
node bin/hypermem-status.mjs --health     # health checks only (exit 1 on failure)
```

> **Note:** The health check requires the data directory to exist. It is created on first gateway restart with the plugin active. Run the `openclaw logs` check first to confirm initialization, then run the health check.
>
> **Empty results on fresh installs are normal.** If the health check shows `facts=0`, `episodes=0`, or `no agent messages.db found`, that means the install worked but no conversations have happened yet. Data populates after real agent sessions.

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

What changed on the path from 0.5.x to current:
- **0.6.0**: SQLite `:memory:` became the only hot layer. Redis was fully removed and the runtime no longer depends on any external cache service.
- **0.7.0**: Temporal validity, expertise storage, contradiction detection, and maintenance APIs landed.
- **0.8.1**: Documentation fixes — install instructions rewritten for clean first-run, `$HOME` replaces `~` in shell-interpolated paths, Lightweight mode config clarified.
- **0.8.0**: Phase C correctness guards, tool-artifact store, schema v10/v19, BLAKE3 dedup, RRF fusion, and fleet registry seeding shipped.
- **Upgrade impact**: current releases use `messages.db` schema v10 and `library.db` schema v19. If you are upgrading from older 0.5.x installs, expect both schema and runtime-behavior changes.

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

## OpenClaw Platform Settings

HyperMem manages its own context pressure, memory injection, and compaction. Several OpenClaw defaults conflict with this or are too conservative for memory-augmented agents. Apply these after plugin installation, before the gateway restart.

### Disable OpenClaw context pruning (required)

OpenClaw has a built-in context pruning system (`cache-ttl` mode) that independently truncates and clears tool results from the message history based on time and context-window ratio thresholds. When HyperMem is active, these two systems fight each other: OpenClaw prunes tool results to free space, then HyperMem injects context that refills it, triggering aggressive compaction on the next turn. The result is unpredictable amnesia.

Disable OpenClaw's pruning and let HyperMem handle context pressure exclusively:

```bash
openclaw config set agents.defaults.contextPruning.mode off
```

### Startup context (recommended)

Controls how much daily memory context agents receive on session start. The defaults are very conservative (2 days, 2800 chars total). For memory-augmented agents, increase these so agents wake up with meaningful context:

```bash
openclaw config set agents.defaults.startupContext.dailyMemoryDays 4 --strict-json
openclaw config set agents.defaults.startupContext.maxFileChars 4000 --strict-json
openclaw config set agents.defaults.startupContext.maxTotalChars 12000 --strict-json
openclaw config set agents.defaults.startupContext.maxFileBytes 32768 --strict-json
```

This gives agents 4 days of working memory at startup (~12k chars total). Still under 10% of a 128k context window.

### Bootstrap max chars (recommended)

Controls the maximum size of bootstrap files (AGENTS.md, SOUL.md, etc.) injected on session start. The default (12000) is tight for agents with governance rules, tool references, and identity docs:

```bash
ocplatform config set agents.defaults.bootstrapMaxChars 20000 --strict-json
```

### Compaction safety net

OpenClaw's built-in compaction (`safeguard` mode) serves as a last-resort safety net. Keep it enabled but tuned so it only fires when HyperMem's own pressure management is insufficient:

```bash
ocplatform config set agents.defaults.compaction.mode safeguard
openclaw config set agents.defaults.compaction.reserveTokens 16384 --strict-json
ocplatform config set agents.defaults.compaction.keepRecentTokens 6000 --strict-json
ocplatform config set agents.defaults.compaction.reserveTokensFloor 15000 --strict-json
openclaw config set agents.defaults.compaction.maxHistoryShare 0.65 --strict-json
```

This reserves 16k tokens for reply generation. HyperMem's own pressure system (afterTurn at 80%, nuclear at 85%) fires first in normal operation. OpenClaw's safeguard catches edge cases.

### LLM idle timeout

Tool-heavy sessions with large outputs can stall during streaming. Raise the idle timeout from the default (120s):

```bash
openclaw config set agents.defaults.llm.idleTimeoutSeconds 300 --strict-json
```

### Tighter session store retention

With HyperMem active, SQLite is the durable record. JSONL transcripts provide no memory benefit:

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

These settings live in `~/.openclaw/hypermem/config.json` under the `compositor` key. All fields are optional — omit any knob to get the code-level default. Gateway restart required after changes.

The recommended starting config for a standard single-agent deployment is intentionally lean on turn-1 warming. Semantic recall and fact triggers fire against each incoming message, so topic-relevant context surfaces as the conversation takes shape. This produces a steadier pressure profile than aggressive pre-loading and avoids the warm→trim→compact cycling you see when every session starts near the top of the budget.

```json
{
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
```

| Knob | Recommended | What it controls | Notes |
|---|---|---|---|
| `budgetFraction` | 0.55 | Fraction of the detected context window used as input budget | Raise to 0.65 for agents that aggressively tool-use. Autodetect only handles known model families — see *Context window overrides* below for custom/local/finetuned models |
| `contextWindowReserve` | 0.25 | Reserve left for output and tool results | Below 0.20 on large-context models invites late-turn overflow |
| `targetBudgetFraction` | 0.50 | Split between context assembly and history | Higher = richer facts/wiki; lower = more conversation headroom |
| `warmHistoryBudgetFraction` | 0.27 | History's share of first-turn warming | The key lever against tight trim cycles; don't push below 0.20 |
| `maxFacts` | 25 | Structured facts injected per turn | Recall surfaces more as topics emerge; 35 is fine for long-memory seats |
| `maxHistoryMessages` | 500 | Candidate pool for history ranking | Pool size, not load size. 300 is fine for short-session agents |
| `maxCrossSessionContext` | 4000 | Cross-session context tokens | Solo agents with one session: set to 0 |
| `maxRecentToolPairs` | 3 | Verbatim tool pairs kept | Raise to 5 for code agents with heavy tool output |
| `maxProseToolPairs` | 10 | Compressed tool pairs before stubbing | |
| `keystoneHistoryFraction` | 0.15 | Older significant turns reserved within history slot | |
| `keystoneMaxMessages` | 12 | Max keystone candidates per turn | Raise to 18 if the agent loses track of older decisions |
| `wikiTokenCap` | 500 | Cap on wiki/knowledge injection | Raise if your agent uses heavy doc content |

**Lean profile** (~35–45% fewer tokens per turn) — for constrained hosts, small models, or cost-sensitive deployments:

```json
{
  "compositor": {
    "budgetFraction": 0.55,
    "contextWindowReserve": 0.30,
    "warmHistoryBudgetFraction": 0.20,
    "maxFacts": 10,
    "maxHistoryMessages": 150,
    "maxCrossSessionContext": 0,
    "maxRecentToolPairs": 2,
    "maxProseToolPairs": 6,
    "keystoneHistoryFraction": 0.10,
    "keystoneMaxMessages": 5,
    "wikiTokenCap": 300,
    "hyperformProfile": "light"
  }
}
```

---

### Context window overrides (custom, local, or finetuned models)

HyperMem sizes the token budget from the model string using an internal pattern table covering known families (Claude, GPT, Gemini, GLM, Qwen, DeepSeek). If your model string doesn't match a known pattern, resolution silently falls through to `defaultTokenBudget` (90k), and **every downstream dial in this section becomes wrong**, because they're all fractions of the context window:

- `budgetFraction` × *wrong window* → wrong input budget
- `warmHistoryBudgetFraction` × *wrong budget* → wrong warm load on first turn
- Trim tiers and compaction thresholds fire against the wrong ceiling

The two symptoms that indicate window-detection failure:

1. **Undersized window detected** (you have a 200k model, HyperMem thinks it's 90k): every turn warms near the top of the misdetected budget, trim fires constantly, semantic recall and facts get starved. You see continuous `warm→trim→compact` cycling even on short sessions.
2. **Oversized window detected** (you have a 32k local model, HyperMem thinks it's larger): warm loads overshoot the real context window, turns land mid-response with truncated output or provider-side 400s on token overflow.

**Check what HyperMem is using.** Enable `verboseLogging: true` in the compositor config and look for the `budget source:` log line on each turn:

```
[hypermem-plugin] budget source: runtime tokenBudget=163840 model=provider/my-model
[hypermem-plugin] budget source: contextWindowOverrides[provider/my-model]=131072, reserve=0.25, effective=98304
[hypermem-plugin] budget source: fallback contextWindowSize=90000, reserve=0.25, effective=67500 model=provider/my-model
```

If you see `fallback contextWindowSize` for your model, detection failed and you need an override.

**Apply an override.** Add a `contextWindowOverrides` block to `~/.openclaw/hypermem/config.json`. The key is `"provider/model"` as it appears in your agent's model string (lowercase, exact match):

```json
{
  "compositor": {
    "budgetFraction": 0.55,
    "contextWindowReserve": 0.25,
    "warmHistoryBudgetFraction": 0.27,
    "contextWindowOverrides": {
      "ollama/llama-3.3-70b":      { "contextTokens": 131072 },
      "copilot-local/custom-sft":  { "contextTokens": 32768 },
      "vllm/qwen3-coder-ft":       { "contextTokens": 262144 }
    }
  }
}
```

Resolution order, highest-to-lowest priority:

1. Runtime `tokenBudget` passed by OpenClaw (always wins if present)
2. `contextWindowOverrides["provider/model"]` from this config
3. Internal pattern-table match against the model string
4. `defaultTokenBudget` fallback (90k) — **you do not want to end up here**

Gateway restart required after editing overrides. Invalid override entries (malformed keys, impossible ranges, empty values) are dropped on load with a warning; the sanitizer will not let a bad override poison the resolver.

**Interaction with warming and trimming.** Once the correct window is in place:

- First-turn warm load = `detectedWindow × budgetFraction × (1 - contextWindowReserve) × warmHistoryBudgetFraction`
- Trim pressure zones are computed from the same `detectedWindow × budgetFraction × (1 - reserve)` effective budget, so trim fires at the right proportions of the real window, not a wrong one
- Compaction thresholds (85% nuclear, 80% afterTurn trim) are also against the effective budget, not the raw window

TL;DR for operators running custom/local/finetuned models: **set `contextWindowOverrides` before tuning anything else in this section**. Every other knob here assumes the detected window is right.

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

**Lost bundled plugins after setting `plugins.allow`**

If you set `plugins.allow` to only `["hypercompositor","hypermem"]` without including your pre-existing allowed plugins, OpenClaw will stop loading everything else (including built-in CLI surfaces and bundled channel plugins). Fix: re-read your OpenClaw defaults (`openclaw config get plugins.allow`), merge hypermem entries back into the full list, and `openclaw gateway restart`.

**Plugin not found**

Confirm the installed runtime artifacts exist:

```bash
ls ~/.openclaw/plugins/hypermem/plugin/dist/index.js
ls ~/.openclaw/plugins/hypermem/memory-plugin/dist/index.js
ls ~/.openclaw/plugins/hypermem/dist/index.js
```

If missing, rebuild and reinstall the runtime payload:

```bash
cd <path-to-hypermem>
npm run build
npm --prefix plugin run build
npm --prefix memory-plugin run build
npm run install:runtime
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

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HYPERMEM_DATA_DIR` | `~/.openclaw/hypermem` | Override the data directory where hypermem stores `library.db`, per-agent `messages.db` files, and `vectors.db`. Useful when you want data on a separate volume, need isolated test data dirs, or run multiple hypermem instances. The directory is created automatically if it does not exist. |

Example:

```bash
# Point hypermem at a different data location:
export HYPERMEM_DATA_DIR=/mnt/data/hypermem
openclaw gateway restart
```

> The config file path (`~/.openclaw/hypermem/config.json`) is separate from the data directory. Moving `HYPERMEM_DATA_DIR` does not move the config file.

---

_Questions or issues: file against [the repo](https://github.com/PsiClawOps/hypermem) or ask in `#hypermem`._
