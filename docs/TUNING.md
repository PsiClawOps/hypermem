# hypermem Tuning Guide

Configuration reference for operators and agents. All knobs are optional — hypermem ships with production-tested defaults.

Pass any of these as a `Partial<HyperMemConfig>` to `HyperMem.create()`:

```ts
const hm = await HyperMem.create({
  redis: { sessionTTL: 7200 },
  compositor: { defaultTokenBudget: 65000 },
});
```

---

## Cache / TTL

Controls how long data survives in Redis before expiry.

| Knob | Default | What it does |
|---|---|---|
| `redis.sessionTTL` | `14400` (4h) | TTL in seconds for non-history slots (system prompt, identity, meta) |
| `redis.historyTTL` | `604800` (7d) | TTL in seconds for the message history list |
| `redis.flushInterval` | `1000` (1s) | How often Redis write-buffer flushes, in ms |

**When to adjust:**
- **Short sessions** (e.g. CI pipelines, one-shot tasks): lower both to `3600`/`86400`
- **Long-lived agents** (e.g. persistent council seats): raise `historyTTL` to `1209600` (14d) or higher
- **Memory-constrained Redis**: lower `sessionTTL` first; history is more expensive to rebuild

---

## Context Budget

Controls how many tokens hypermem allocates to each prompt section.

| Knob | Default | What it does |
|---|---|---|
| `compositor.defaultTokenBudget` | `90000` | Total token budget for prompt assembly |
| `compositor.contextWindowReserve` | `0.15` | Fraction of budget reserved for in-flight tool results |
| `compositor.warmHistoryBudgetFraction` | `0.40` | Fraction of budget given to history on a warm (non-cold) session start |
| `compositor.keystoneHistoryFraction` | `0.20` | Fraction of history budget reserved for keystone (recalled older) messages |
| `compositor.maxCrossSessionContext` | `6000` | Max tokens for cross-agent context injection |
| `compositor.maxFacts` | `28` | Max facts injected from vector store per compose |
| `compositor.maxHistoryMessages` | `1000` | Hard cap on history messages pulled from Redis |

**Pressure zones:** Budget utilisation is tracked against a 120k planning baseline, with three zones:
- 🟡 **75%** — trim starts on older tool results
- 🟠 **80%** — more aggressive tier reduction
- 🔴 **85%** — oldest tool pairs stubbed to one-liner

**When to adjust:**
- **Small models** (e.g. 32k context): set `defaultTokenBudget: 24000`, `contextWindowReserve: 0.20`
- **Large models** (e.g. 200k+): can raise `defaultTokenBudget` up to `150000`, but note hypermem plans against a 120k baseline internally
- **Fact-heavy agents** (research, knowledge-base work): raise `maxFacts` to 40–50
- **Low-latency requirements**: lower `maxFacts` to 10–15 and `maxCrossSessionContext` to 2000

---

## Tool Result Trimming

Controls how aggressively tool call output is compressed as it ages.

| Knob | Default | What it does |
|---|---|---|
| `compositor.maxRecentToolPairs` | `3` | Tool pairs kept at full fidelity (T0/T1 zone) |
| `compositor.maxProseToolPairs` | `10` | Tool pairs converted to prose summary before stubbing |
| `compositor.maxTotalTriggerTokens` | _(65% of remaining budget)_ | Hard cap on total tokens consumed by all trigger collections combined |

**When to adjust:**
- **Code agents** that need to retain large file reads: raise `maxRecentToolPairs` to `5–6`
- **Chat agents** with minimal tool use: lower `maxProseToolPairs` to `4–5`
- **Aggressive compression**: lower `maxRecentToolPairs` to `1`, `maxProseToolPairs` to `4`
- **Trigger-heavy prompts** (many collection triggers firing): set `maxTotalTriggerTokens: 10000` to prevent trigger collections from starving history

---

## FOS / MOD

Fleet Output Standard (FOS) and Model Output Directive (MOD) inject output calibration into every composed context. FOS applies shared rules (lead with answer, no em dashes, list caps). MOD applies per-model corrections (verbosity, list length, preamble suppression).

| Knob | Default | What it does |
|---|---|---|
| `compositor.enableFOS` | `true` | Inject Fleet Output Standard rules into context |
| `compositor.enableMOD` | `true` | Inject per-model calibration corrections into context |

**When to disable:**
- `enableFOS: false` — if you manage output standards entirely via system prompt and want to avoid duplication
- `enableMOD: false` — if you want raw model behavior without hypermem calibration (useful for benchmarking)
- Disable both — minimal-footprint deploys, embedding-only usage, or agents with highly custom system prompts

```typescript
const compositor = new Compositor(redis, db, libDb, {
  // ... other config ...
  enableFOS: false,  // no output standard injection
  enableMOD: false,  // no per-model calibration
});
```

> **Note:** Disabling FOS/MOD reduces token usage by ~250–400 tokens per compose pass. Useful for high-volume or cost-sensitive deployments.

---

The dreaming promoter runs periodically and promotes high-value facts to your agent's `MEMORY.md`. Disabled by default.

| Knob | Default | What it does |
|---|---|---|
| `dreaming.enabled` | `false` | Enable the promotion pass |
| `dreaming.minScore` | `0.75` | Minimum composite score (confidence × recency × domain weight) for promotion |
| `dreaming.minConfidence` | `0.70` | Pre-scoring confidence gate |
| `dreaming.maxPromotionsPerRun` | `5` | Max new pointer entries written per agent per run |
| `dreaming.tickInterval` | `12` | Run every N indexer ticks (default 5min ticks → every ~1h) |
| `dreaming.recencyHalfLifeDays` | `7` | Score decays to 0.5 at this age in days |
| `dreaming.maxAgeDays` | `30` | Facts older than this are skipped entirely |
| `dreaming.dryRun` | `false` | Preview promotions without writing to MEMORY.md |

**Recommended starting config:**
```ts
dreaming: {
  enabled: true,
  minScore: 0.75,
  maxPromotionsPerRun: 5,
  tickInterval: 12,   // ~1h at default indexer cadence
  dryRun: false,
}
```

**When to adjust:**
- **Active agents** (many facts, frequent sessions): lower `minScore` to `0.65`, raise `maxPromotionsPerRun` to `8`
- **Quiet agents** (weekly use): raise `tickInterval` to `288` (~24h), lower `maxPromotionsPerRun` to `2`
- **Testing**: set `dryRun: true` — logs what would be promoted without touching disk

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
- **Privacy-sensitive deployments**: set `factExtractionMode: 'off'` — no facts are extracted or stored
- **High-frequency sessions** (many messages/min): lower `periodicInterval` to `60000` (1min)
- **Resource-constrained hosts**: raise `periodicInterval` to `900000` (15min), set `factExtractionMode: 'pattern'`

---

## Embeddings

| Knob | Default | What it does |
|---|---|---|
| `embedding.ollamaUrl` | `http://localhost:11434` | Ollama endpoint for embedding generation |
| `embedding.model` | `nomic-embed-text` | Embedding model (must match vector store dimensions) |
| `embedding.dimensions` | `768` | Vector dimensions — must match your model |
| `embedding.timeout` | `10000` (10s) | Per-request timeout in ms |
| `embedding.batchSize` | `32` | Docs per embedding batch |

**If Ollama is unavailable:** hypermem degrades gracefully — vector retrieval returns empty, keyword/recency retrieval still works.

---

## Example: Minimal Footprint

For resource-constrained hosts or single-agent setups:

```ts
const hm = await HyperMem.create({
  redis: {
    sessionTTL: 3600,       // 1h
    historyTTL: 86400,      // 1d
  },
  compositor: {
    defaultTokenBudget: 40000,
    maxFacts: 10,
    maxHistoryMessages: 100,
    maxCrossSessionContext: 2000,
    warmHistoryBudgetFraction: 0.35,
  },
  indexer: {
    factExtractionMode: 'pattern',
    periodicInterval: 900000,  // 15min
  },
});
```

## Example: Fleet / Multi-Agent

For large fleets with many concurrent sessions:

```ts
const hm = await HyperMem.create({
  redis: {
    sessionTTL: 28800,      // 8h
    historyTTL: 1209600,    // 14d
  },
  compositor: {
    defaultTokenBudget: 90000,
    maxFacts: 40,
    maxHistoryMessages: 500,
    maxTotalTriggerTokens: 15000,
    keystoneHistoryFraction: 0.25,
  },
  dreaming: {
    enabled: true,
    maxPromotionsPerRun: 8,
    tickInterval: 6,
    minScore: 0.65,
  },
});
```
