# hypermem Tuning Guide

Configuration reference for operators and agents. All settings are optional — hypermem ships with production-tested defaults.

Config lives in `~/.openclaw/hypermem/config.json` (takes effect on gateway restart) or is passed programmatically via `HyperMem.create()`:

```ts
const hm = await HyperMem.create({
  compositor: { budgetFraction: 0.70, hyperformProfile: 'standard' },
});
```

---

## Quick Start: Pick a Profile

Three pre-built profiles ship with hypermem. Each configures every setting to a coherent default for a common deployment pattern:

| Profile | Context window | Budget | Hyperform | Best for |
|---|---|---|---|---|
| `light` | 64k | 40k effective | `light` (behavior only) | Single agent, small models, constrained resources |
| `standard` | 128k | 90k effective | `standard` (behavior + structure) | Normal deployments, small fleets |
| `full` | 200k+ | 160k effective | `full` (behavior + model adaptation) | Multi-agent fleets, large-context models |

```ts
import { getProfile, mergeProfile } from '@psiclawops/hypermem';

// Use a profile as-is
const config = getProfile('light');

// Start from a profile, adjust specific settings
const custom = mergeProfile('standard', {
  compositor: { maxFacts: 40, hyperformProfile: 'full' },
});
```

Start with `light`. Move up when you need richer context and have the headroom.

---

## Hyperform: Output Shaping

Hyperform controls output normalization directives injected into every composed context. Two independent layers: **behavior** (how the model writes) and **model adaptation** (corrections for specific model tendencies). See the [README](../README.md#hyperform) for the full rationale and before/after examples.

### The two layers

#### Behavior standards

Shared rules that apply to all models equally (anti-sycophancy, density targets, anti-pattern bans).

| Tier | Tokens | What's included |
|---|---|---|
| `light` | ~100 | 9 standalone directives. No database required. |
| `standard` | ~250 | Full directive set from the `fleet_output_standard` DB table. Falls back to `light` if no record exists. |
| `full` | ~250 + adaptation | Same as `standard`, plus model adaptation (see below). |

The `light` tier is hardcoded. `standard` and `full` read from `fleet_output_standard` in `library.db`.

#### Model adaptation

Per-model corrections for known tendencies (verbosity, hedging, list inflation). Only active at the `full` tier.

Entries in the `model_output_directives` DB table are matched by model ID:
1. Exact match (case-insensitive)
2. Glob pattern (longest wins)
3. Wildcard `*` fallback
4. No adaptation

Each entry contains calibration (known tendencies + adjustments), corrections (hard/medium/soft severity), and task overrides. The table starts empty; populate it for the models you run (see [Creating custom entries](#creating-custom-entries) below).

### Choosing a tier

| Situation | Tier | Reason |
|---|---|---|
| Single agent, 64k or smaller model | `light` | Minimal token overhead, no DB dependency |
| Single agent, 128k+ model | `standard` | Richer output control, worth the extra ~150 tokens |
| Fleet with mixed models | `full` | Different models need different corrections |
| Cost-sensitive deployment | `light` or `standard` | Avoids adaptation overhead; consistent behavior standards already reduce output tokens |
| Benchmarking model quality | `light` with `enableFOS: false` | Minimal interference for apples-to-apples comparison |

### Configuring hyperform

**Via config file** (`~/.openclaw/hypermem/config.json`):

```json
{
  "compositor": {
    "hyperformProfile": "standard"
  }
}
```

**Via programmatic config:**

```ts
const hm = await HyperMem.create(mergeProfile('light', {
  compositor: { hyperformProfile: 'standard' },
}));
```

**Fine-grained control:**

| Knob | Default | Effect |
|---|---|---|
| `compositor.hyperformProfile` | `'full'` (existing), `'light'` (new installs) | Sets the tier. Backward-compat aliases: `'starter'` → `'light'`, `'fleet'` → `'full'`. |
| `compositor.enableFOS` | `true` | Set `false` to suppress all behavior directives (saves ~100-250 tokens/turn) |
| `compositor.enableMOD` | `true` | Set `false` to suppress model adaptation (saves ~0-150 tokens/turn depending on match) |

At `light` tier, `enableFOS` and `enableMOD` are both effectively `false` — the light directives are injected directly, not through the behavior/adaptation pipeline. At `standard`, behavior standards are active and model adaptation is suppressed. At `full`, both are active unless explicitly disabled.

### Creating custom entries

Behavior and adaptation records live in the `fleet_output_standard` and `model_output_directives` tables in `library.db`. There is no API endpoint for these — write directly to the database.

**Adding a behavior record:**

```sql
INSERT INTO fleet_output_standard (
  id, name, directives, task_variants, token_budget, active, source, version
) VALUES (
  'my-fos',
  'My Output Standard',
  json('{
    "structural": ["Lead with the answer", "One idea per paragraph"],
    "anti_patterns": ["certainly", "it''s worth noting", "delve"],
    "density_targets": {"simple": "1-3 sentences", "analysis": "200-500 words", "code": "code first, explain only non-obvious parts"},
    "voice": ["Direct tone", "No hedging on factual claims"]
  }'),
  json('{"code_review": {"density_target": "2-4 sentences per finding", "list_cap": "5 items max"}}'),
  250,
  1,
  'custom',
  1
);
```

**Adding an adaptation record for a specific model:**

```sql
INSERT INTO model_output_directives (
  id, match_pattern, priority, corrections, calibration, task_overrides, token_budget, version, source, enabled
) VALUES (
  'gpt-5.4-mod',
  'gpt-5.4*',           -- glob pattern: matches gpt-5.4, gpt-5.4-turbo, etc.
  10,                    -- higher priority wins on equal pattern length
  json('[
    {"id": "v1", "rule": "Cut first drafts in half. Then cut again.", "severity": "hard"},
    {"id": "v2", "rule": "No preamble before the answer.", "severity": "medium"},
    {"id": "v3", "rule": "Lists: 5 items max unless explicitly requested.", "severity": "medium"}
  ]'),
  json('[
    {"id": "c1", "fos_target": "simple answers: 1-3 sentences", "model_tendency": "2x verbosity, 1.8x list length", "adjustment": "Actively compress. Every sentence must state a fact, make a decision, or advance an argument."}
  ]'),
  json('{}'),
  150,
  1,
  'custom',
  1
);
```

**Adding a wildcard adaptation fallback** (applies to any model without a specific match):

```sql
INSERT INTO model_output_directives (
  id, match_pattern, priority, corrections, calibration, task_overrides, token_budget, version, source, enabled
) VALUES (
  'default-mod',
  '*',
  0,
  json('[]'),
  json('[]'),
  json('{}'),
  50,
  1,
  'custom',
  1
);
```

To deactivate a behavior or adaptation entry without deleting it, set `active = 0` (behavior) or `enabled = 0` (adaptation). To switch between multiple behavior records, set `active = 1` on only one — `getActiveFOS()` selects the highest-version active record.

**Important:** Only one behavior record can be active at a time. Adaptation supports multiple entries — they're matched by model ID and the best match wins.

---

## HyperCompositor: Context Budget

The hypercompositor queries all four storage layers on every turn and composes context within a fixed token budget. This section explains how the budget is calculated, how it's divided, and how to adjust it.

### How the budget is calculated

Three knobs control the top-level budget:

```
detected context window × budgetFraction × (1 - contextWindowReserve) = effective budget
```

Then `targetBudgetFraction` splits the effective budget:

```
effective budget × targetBudgetFraction = context assembly budget
effective budget × (1 - targetBudgetFraction) = history budget
```

| Knob | Type | Range | What it controls |
|---|---|---|---|
| `budgetFraction` | 0.0–1.0 | Default: 0.703 | Fraction of the detected context window used as the input budget. This is the primary dial — raise it to use more of the window, lower it to leave more room. |
| `contextWindowReserve` | 0.0–1.0 | Default: 0.25 | Fraction reserved for model output and tool call responses. Higher = more headroom for large tool results, fewer tokens for context. Lower = more context available, higher saturation risk. |
| `targetBudgetFraction` | 0.3–0.85 | Default: 0.65 | Fraction of the effective budget allocated to assembled context (facts, wiki, cross-session, keystone). The remainder goes to conversation history. Lower = lighter context, more history room. Higher = richer context, less history. |

**Worked example (standard profile, 128k model):**

```
128,000 × 0.703 = 89,984 (effective budget before reserve)
89,984 × (1 - 0.25) = 67,488 (effective budget after reserve)
67,488 × 0.65 = 43,867 (context assembly budget)
67,488 × 0.35 = 23,621 (history budget)
```

**Model swap resilience:** The budget is computed from the model's actual context window at compose time. If you swap models mid-session (e.g., from a 128k model to a 200k model), the budget automatically recomputes on the next turn. No manual intervention needed. Structured tool history is guarded from being overwritten during a budget downshift — the compositor computes the new allocation but doesn't persist a lower-context snapshot to disk, preserving the full history for when the larger model returns.

### How the budget fills

The compositor fills slots in priority order. Each slot consumes tokens from the remaining budget before the next slot runs (greedy fill, not proportional allocation):

| Order | Slot | Behavior | Configurable via |
|---|---|---|---|
| 1 | System prompt | Never truncated | Fixed — part of the agent definition |
| 2 | Identity (SOUL.md, USER.md, etc.) | Never truncated | Fixed — OpenClaw workspace files |
| 3 | Hyperform (behavior + adaptation) | Capped at tier token budgets | `hyperformProfile`, `enableFOS`, `enableMOD` |
| 4 | Conversation history | Largest slot; fills with tool-compressed history | `maxHistoryMessages`, `keystoneHistoryFraction` |
| 5 | Facts (L4) | Top N facts by confidence × recency | `maxFacts` |
| 6 | Wiki/knowledge | Compiled topic pages | `wikiTokenCap`, `maxTotalTriggerTokens` |
| 7 | Semantic recall (L3) | Hybrid FTS5 + KNN retrieval | Trigger budget, fallback KNN budget |
| 8 | Cross-session context | Other active sessions | `maxCrossSessionContext` |
| 9 | Action summary | Recent tool actions | Pressure-gated (5/3/1/0 actions by zone) |

**Greedy fill means:** if slot 4 (history) consumes most of the budget, slots 5-8 get whatever remains. This is intentional — history carries the immediate conversation and is always prioritized over background context. If you want more facts or wiki content, you either reduce history allocation (lower `targetBudgetFraction`) or increase the total budget (raise `budgetFraction`).

**Safety valve:** After all slots are assembled, a post-assembly check verifies the total doesn't exceed `budget × 1.05` (5% tolerance for estimation drift). If it does, the oldest history messages are trimmed until the composition fits. System and identity are never trimmed.

### Adjusting the context/history balance

The most common tuning question is "I want more facts/wiki but less history" or the reverse.

**More context, less history:**

```json
{
  "compositor": {
    "targetBudgetFraction": 0.75
  }
}
```

This gives 75% of the effective budget to context assembly (facts, wiki, recall, keystones) and 25% to history. Useful for knowledge-heavy agents where the current answer matters more than the full conversation.

**More history, less context:**

```json
{
  "compositor": {
    "targetBudgetFraction": 0.45
}
}
```

This gives only 45% to context assembly and 55% to history. Useful for coding agents that need to retain the full working conversation but don't need many facts or wiki pages.

**More facts specifically:**

```json
{
  "compositor": {
    "maxFacts": 50,
    "wikiTokenCap": 400
  }
}
```

Raises the fact injection cap from the default 30 to 50, and reduces wiki page space from 600 to 400 tokens.

**More keystone history (recalled older messages):**

```json
{
  "compositor": {
    "keystoneHistoryFraction": 0.30,
    "keystoneMaxMessages": 25
  }
}
```

Reserves 30% of the history budget for keystones (up from default 20%) and allows up to 25 keystone messages (up from 15). Keystones are high-significance older messages that survive pressure trimming ahead of ordinary history.

### Adjusting for model context size

The three profiles cover the common cases — see [Quick Start: Pick a Profile](#quick-start-pick-a-profile) for the full table. For window sizes outside the profiles:

**For small models (32k context):**

```json
{
  "compositor": {
    "budgetFraction": 0.55,
    "contextWindowReserve": 0.35,
    "maxFacts": 10,
    "maxHistoryMessages": 100
  }
}
```

Small windows need aggressive reserve (tool results can easily consume 10k+ tokens) and limited fact injection.

**For large models (272k+ context):**

```json
{
  "compositor": {
    "budgetFraction": 0.65,
    "contextWindowReserve": 0.15,
    "maxFacts": 60,
    "maxHistoryMessages": 1000,
    "keystoneHistoryFraction": 0.25
  }
}
```

Large windows can afford tighter reserves and richer context. The compositor naturally uses more of the window.

### Dynamic reserve

By default, the compositor projects forward from recent turn costs to adjust the reserve dynamically:

```
safety_tokens = avg_turn_cost × dynamicReserveTurnHorizon
dynamic_reserve_fraction = safety_tokens / total_window
```

| Knob | Default | Effect |
|---|---|---|
| `dynamicReserveEnabled` | `true` | Enable/disable dynamic adjustment |
| `dynamicReserveTurnHorizon` | 5 | How many turns ahead to project |
| `dynamicReserveMax` | 0.50 | Hard ceiling on dynamic reserve fraction |

When the projected reserve exceeds `dynamicReserveMax`, the system emits `SESSION_PRESSURE_HIGH` in diagnostics and clamps to the max. This prevents pathological sessions from starving context entirely.

Disable dynamic reserve to use a fixed reserve:

```json
{
  "compositor": {
    "dynamicReserveEnabled": false,
    "contextWindowReserve": 0.25
  }
}
```

### Tool compression

Tool output is compressed by turn age to prevent old results from crowding out current work:

| Tier | Turns | Treatment | Per-message cap | Per-turn-pair cap |
|---|---|---|---|---|
| T0 | Current + 2 most recent | Full fidelity (matches OpenClaw `keepLastAssistants: 3`) | None | None |
| T1 | Turns 2-4 | Moderate truncation | 6,000 chars | 12,000 chars |
| T2 | Turns 4-7 | Aggressive truncation | 800 chars | 3,000 chars |
| T3 | Turns 8+ | One-liner stub | 150 chars | 800 chars |

Large T0 results (>40k chars) at high context pressure (>80%) get head-and-tail trimmed with a structured trim note rather than dropped entirely. The last 3 assistant turns are always protected.

| Knob | Default | Effect |
|---|---|---|
| `maxRecentToolPairs` | 3 | Tool pairs kept at full fidelity (T0) |
| `maxProseToolPairs` | 10 | Tool pairs converted to prose summary before stubbing |

**When `deferToolPruning: true`** (default for Anthropic installs): hypermem skips its own gradient when OpenClaw's native `contextPruning` is active. The native pruner handles tool result trimming on those providers. The gradient remains active as fallback for other providers.

---

## Cache / TTL

Controls how long data survives in Redis before expiry.

| Knob | Default | What it does |
|---|---|---|
| `redis.sessionTTL` | `14400` (4h) | TTL in seconds for non-history slots (system prompt, identity, meta) |
| `redis.historyTTL` | `604800` (7d) | TTL in seconds for the message history list |
| `redis.flushInterval` | `1000` (1s) | How often Redis write-buffer flushes, in ms |

**When to adjust:**
- **Short sessions** (CI pipelines, one-shot tasks): lower both to `3600`/`86400`
- **Long-lived agents** (persistent council seats): raise `historyTTL` to `1209600` (14d)
- **Memory-constrained Redis**: lower `sessionTTL` first; history is more expensive to rebuild

---

## Indexer

Controls background fact extraction and topic tracking.

| Knob | Default | What it does |
|---|---|---|
| `indexer.enabled` | `true` | Enable background indexing |
| `indexer.factExtractionMode` | `'tiered'` | `'off'` \| `'pattern'` \| `'tiered'` — extraction aggressiveness |
| `indexer.factDecayRate` | `0.01` | Per-tick decay applied to fact confidence scores |
| `indexer.episodeSignificanceThreshold` | `0.5` | Minimum score for an episode to be stored |
| `indexer.topicDormantAfter` | `'24h'` | Mark a topic dormant after this period of inactivity |
| `indexer.topicClosedAfter` | `'7d'` | Close a topic after this period |
| `indexer.periodicInterval` | `300000` (5min) | Indexer tick interval in ms |

**When to adjust:**
- **Privacy-sensitive deployments**: set `factExtractionMode: 'off'` — no facts extracted or stored
- **High-frequency sessions**: lower `periodicInterval` to `60000` (1min)
- **Resource-constrained hosts**: raise `periodicInterval` to `900000` (15min), set `factExtractionMode: 'pattern'`

---

## Dreaming (Memory Promotion)

The dreaming promoter runs periodically and promotes high-value facts to your agent's `MEMORY.md`. Disabled by default.

| Knob | Default | What it does |
|---|---|---|
| `dreaming.enabled` | `false` | Enable the promotion pass |
| `dreaming.minScore` | `0.75` | Minimum composite score for promotion |
| `dreaming.minConfidence` | `0.70` | Pre-scoring confidence gate |
| `dreaming.maxPromotionsPerRun` | `5` | Max new entries written per agent per run |
| `dreaming.tickInterval` | `12` | Run every N indexer ticks (default 5min ticks → ~1h) |
| `dreaming.dryRun` | `false` | Preview promotions without writing to MEMORY.md |

---

## Embeddings

| Knob | Default | What it does |
|---|---|---|
| `embedding.ollamaUrl` | `http://localhost:11434` | Ollama endpoint |
| `embedding.model` | `nomic-embed-text` | Embedding model (must match vector dimensions) |
| `embedding.dimensions` | `768` | Vector dimensions — must match your model |
| `embedding.timeout` | `10000` (10s) | Per-request timeout in ms |
| `embedding.batchSize` | `32` | Docs per embedding batch |

**Hosted embeddings (OpenRouter)** — recommended for installs without local GPU:

```ts
embedding: {
  provider: 'openai',
  openaiApiKey: 'sk-or-...',
  openaiBaseUrl: 'https://openrouter.ai/api/v1',
  model: 'qwen/qwen3-embedding-8b',
  dimensions: 4096,
  batchSize: 128,
}
```

If Ollama is unavailable, vector retrieval returns empty. Keyword and recency retrieval still work.

---

## Obsidian Vault Integration

Import notes from an Obsidian vault into hypermem's fact and doc-chunk pipeline.

```json
{
  "obsidian": {
    "enabled": true,
    "vaultPath": "/home/user/Documents/MyVault",
    "collection": "obsidian/vault",
    "watchInterval": 30000,
    "excludeFolders": ["archive", "private"],
    "importTags": true,
    "importFrontmatter": true,
    "staleDays": 7
  }
}
```

| Knob | Default | Effect |
|---|---|---|
| `enabled` | `false` | Master switch |
| `vaultPath` | _(required)_ | Absolute path to your Obsidian vault |
| `collection` | `obsidian/vault` | Doc-chunk collection name |
| `watchInterval` | `30000` | Polling interval ms |
| `excludeFolders` | `[]` | Additional folders to skip |
| `importTags` | `true` | Import `#tags` from content and frontmatter |
| `importFrontmatter` | `true` | Import YAML frontmatter key/value pairs |
| `staleDays` | `7` | Re-import files not seen in N days |

All files pass through `secret-scanner` before ingest. Notes containing API keys, tokens, or credentials are silently skipped.

---

## Example Configs

### Minimal Footprint (single agent, 64k)

```json
{
  "compositor": {
    "budgetFraction": 0.625,
    "contextWindowReserve": 0.35,
    "targetBudgetFraction": 0.50,
    "maxFacts": 10,
    "maxHistoryMessages": 100,
    "maxCrossSessionContext": 0,
    "hyperformProfile": "light"
  },
  "indexer": {
    "factExtractionMode": "pattern",
    "periodicInterval": 900000
  }
}
```

### Balanced Fleet (128k, multi-agent)

```json
{
  "compositor": {
    "budgetFraction": 0.703,
    "contextWindowReserve": 0.25,
    "targetBudgetFraction": 0.65,
    "maxFacts": 30,
    "hyperformProfile": "standard",
    "keystoneHistoryFraction": 0.20,
    "wikiTokenCap": 600
  },
  "dreaming": {
    "enabled": true,
    "maxPromotionsPerRun": 5,
    "tickInterval": 12
  }
}
```

### Full Fleet (200k+, council)

```json
{
  "compositor": {
    "budgetFraction": 0.588,
    "contextWindowReserve": 0.20,
    "targetBudgetFraction": 0.55,
    "maxFacts": 60,
    "maxHistoryMessages": 1000,
    "maxCrossSessionContext": 12000,
    "hyperformProfile": "full",
    "keystoneHistoryFraction": 0.25,
    "keystoneMaxMessages": 30,
    "wikiTokenCap": 800,
    "maxTotalTriggerTokens": 10000
  },
  "dreaming": {
    "enabled": true,
    "maxPromotionsPerRun": 8,
    "tickInterval": 6,
    "minScore": 0.65
  }
}
```

### Code Agent (128k, high tool output)

```json
{
  "deferToolPruning": true,
  "compositor": {
    "budgetFraction": 0.703,
    "contextWindowReserve": 0.30,
    "targetBudgetFraction": 0.55,
    "maxFacts": 15,
    "maxRecentToolPairs": 5,
    "maxProseToolPairs": 15,
    "hyperformProfile": "light"
  }
}
```

Higher `contextWindowReserve` (0.30) gives more headroom for large tool results. Lower `targetBudgetFraction` (0.55) prioritizes history over background context. `maxRecentToolPairs: 5` keeps more recent tool output verbatim.

---

## Full Knob Reference

### Window budget

| Knob | Type | Default | What it controls |
|---|---|---|---|
| `budgetFraction` | 0.0–1.0 | 0.703 | Fraction of detected context window used as input budget. Primary dial. |
| `contextWindowReserve` | 0.0–1.0 | 0.25 | Fraction reserved for output and tool responses. |
| `targetBudgetFraction` | 0.3–0.85 | 0.65 | Context vs. history split within the effective budget. |
| `defaultTokenBudget` | number | 90000 | Absolute fallback when model detection fails. Prefer `budgetFraction`. |

### Fact injection

| Knob | Type | Default | What it controls |
|---|---|---|---|
| `maxFacts` | number | 30 | Maximum facts surfaced per compose pass. |
| `wikiTokenCap` | tokens | 600 | Hard ceiling on wiki/knowledge injection per pass. |
| `maxTotalTriggerTokens` | tokens | 4000 | Ceiling across all trigger-fired doc chunk collections. |

### History and keystone

| Knob | Type | Default | What it controls |
|---|---|---|---|
| `maxHistoryMessages` | number | 500 | Maximum messages in the hot history window. |
| `keystoneHistoryFraction` | 0.0–0.5 | 0.20 | Fraction of history budget reserved for keystones. 0 disables. |
| `keystoneMaxMessages` | number | 15 | Max keystone messages injected per pass. |
| `keystoneMinSignificance` | 0.0–1.0 | 0.5 | Minimum episode significance for keystone qualification. |

### Tool history

| Knob | Type | Default | What it controls |
|---|---|---|---|
| `maxRecentToolPairs` | number | 3 | Tool call/result pairs kept verbatim. |
| `maxProseToolPairs` | number | 10 | Older pairs converted to prose stubs. Beyond this, payloads dropped. |
| `maxCrossSessionContext` | tokens | 4000 | Token ceiling for cross-agent context. 0 disables. |

### Dynamic reserve

| Knob | Type | Default | What it controls |
|---|---|---|---|
| `dynamicReserveEnabled` | boolean | `true` | Enable/disable dynamic reserve adjustment. |
| `dynamicReserveTurnHorizon` | number | 5 | Turns to project forward. |
| `dynamicReserveMax` | 0.0–1.0 | 0.50 | Hard ceiling on dynamic reserve fraction. |

### Hyperform

| Knob | Type | Default | What it controls |
|---|---|---|---|
| `hyperformProfile` | `'light'` \| `'standard'` \| `'full'` | `'full'` | Output shaping tier. |
| `enableFOS` | boolean | `true` | Suppress behavior directives when `false`. |
| `enableMOD` | boolean | `true` | Suppress model adaptation when `false`. |