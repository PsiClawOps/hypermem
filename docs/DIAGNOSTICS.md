# HyperMem Diagnostics

HyperMem diagnostics are split into operator CLIs, validation scripts, and runtime logs. Use this page to decide which surface proves which part of the system.

## Diagnostic surfaces

| Surface | Command | Proves |
|---|---|---|
| Health summary | `hypermem-status --health` | data dir, SQLite health, basic runtime state |
| operator dashboard | `hypermem-status --master` | concise fleet-facing status summary |
| JSON status | `hypermem-status --json` | machine-readable database and runtime state |
| Model audit | `hypermem-model-audit --strict` | active models have known context-window behavior or overrides |
| Memory benchmark | `hypermem-bench --iterations 1000 --warmup 50 --agent <agent>` | local dataset access latency with p50/p95/p99 timings |
| Compose report | `node scripts/compose-report.mjs` | direct compositor slot selection, budget decisions, diagnostics fields |
| Trim report | `node scripts/trim-report.mjs` | trim events, cache invalidation, pressure behavior |
| Version parity | `npm run validate:version-parity` | package versions and plugin dependencies are release-aligned |
| Release path | `npm run validate:release-path` | build plus plugin pipeline gateway path |
| Docs/config validation | `npm run validate:docs && npm run validate:config` | documented commands and config surfaces match code |

## `hypermem-status`

Primary uses:

- confirm data directory exists
- confirm SQLite databases are readable
- confirm vectors and message stores are not obviously corrupt
- distinguish healthy-empty installs from broken installs

Examples:

```bash
hypermem-status --health
hypermem-status --master
hypermem-status --agent forge --master
hypermem-status --json
```

Healthy fresh install behavior may include empty counts or `no sessions ingested`. That is not a failure. A fresh install becomes active only after the gateway loads the plugins and an agent turn runs.

Failure signals:

| Signal | Meaning | Next check |
|---|---|---|
| missing data dir | HyperMem has not initialized or `HYPERMEM_DATA_DIR` points elsewhere | verify plugin load and gateway logs |
| SQLite open failure | permissions, corruption, or incompatible data dir | check filesystem owner and run SQLite integrity check |
| vector dimension mismatch | embedding provider changed without rebuild or migration | inspect provider/model/dimension config |
| stale index time | background indexing not running or no new data | check gateway logs for embed/index messages |

## `hypermem-model-audit`

Model audit checks whether HyperMem can size the context budget for active models.

```bash
hypermem-model-audit
hypermem-model-audit --strict
hypermem-model-audit --models openai-codex/gpt-5.4,ollama/llama-3.3-70b
```

Use strict mode in release validation. A strict failure means the model should get an explicit `contextWindowOverrides` entry before treating pressure diagnostics as authoritative.

## Memory access benchmark

`hypermem-bench` measures storage access speed against the operator's local HyperMem dataset, normally `~/.openclaw/hypermem`.

```bash
hypermem-bench --iterations 1000 --warmup 50 --agent main
hypermem-bench --iterations 1000 --warmup 50 --data-dir /path/to/hypermem
```

It reports min, average, p50, p95, p99, and max latency for the data paths present in that install, including message hot-path lookups, session/conversation lookup, message FTS, facts, episodes, topics, fleet records, and doc chunks.

Use this for local validation of README speed claims. Results depend on hardware, database size, selected agent, and which optional surfaces are enabled. Vector embedding generation and hosted reranker latency are not part of these SQLite access timings; they are configured separately and should be measured against the chosen provider.

## Runtime logs

After wiring and restart:

```bash
openclaw logs --limit 100 | grep -E 'hypermem|context-engine|falling back'
```

Healthy startup and compose lines include:

```text
[hypermem] hypermem initialized
[hypermem] Embedding provider: none - semantic search disabled, using FTS5 fallback
[hypermem:compose]
```

Hard failure lines include:

```text
falling back to default engine "legacy"
Cannot find module 'zod'
Cannot find module 'sqlite-vec'
```

If OpenClaw falls back to `legacy`, HyperMem is not composing prompts. Treat that as install failure, not degraded success.

## Compose diagnostics

Compose diagnostics prove that the compositor is selecting, budgeting, and exposing runtime fields.

Key fields to inspect:

| Field family | What it proves |
|---|---|
| token budget fields | model-aware context window sizing and reserve math |
| `sessionPressureFraction` and `pressureSource` | unified pressure signal is present |
| history depth fields | pre-compose history depth estimation is active |
| prompt placement fields | query-shaped tail and slot placement behavior |
| adaptive lifecycle fields | lifecycle band and breadcrumb decisions are visible |
| warm restore fields | snapshot restore, repair, parity, and rollout gates are visible |
| tool/artifact fields | tool chain preservation and oversize degradation are working |

Direct check:

```bash
node scripts/compose-report.mjs
```

Release gate coverage:

```bash
node test/unified-pressure-signal.mjs
node test/history-depth-estimator.mjs
node test/sprint4-prompt-placement.mjs
node test/adaptive-lifecycle.mjs
node --test test/composition-snapshot-integrity.test.mjs
node --test test/composition-snapshot-store.test.mjs
```

## Warm restore diagnostics

Warm restore validation must prove 4 things:

1. snapshots are written with integrity metadata
2. restored snapshots preserve required system repair notices
3. repaired snapshots are capped and cannot become restore sources
4. rollout gates fall back to cold rewarm when parity or provider checks fail

Release gate coverage:

```bash
node --test test/composition-snapshot-integrity.test.mjs
node --test test/composition-snapshot-store.test.mjs
node test/repair-tool-pairs.mjs
```

## Adaptive lifecycle diagnostics

0.9.0 ships the adaptive lifecycle behavior set: shared pressure-band policy, adaptive recall breadth, adaptive eviction ordering, lifecycle telemetry, and metadata-only topic-signal reporting.

Validate:

```bash
node test/adaptive-lifecycle.mjs
node test/unified-pressure-signal.mjs
```

Expected proof:

- lifecycle band is computed
- compose diagnostics expose lifecycle fields
- telemetry JSONL includes `lifecycle-policy` events for `compose.preRecall` and `compose.eviction`
- `node scripts/trim-report.mjs <telemetry.jsonl>` reports lifecycle policy counts, band counts, and divergence turns
- `trim-report.mjs` and `compose-report.mjs` classify compose topic signal with metadata-only fields:
  - `present`
  - `absent-no-active-topic`
  - `absent-stamping-incomplete`
  - `intentionally-suppressed`
  - `unknown`
- topic-signal reports use booleans, enums, counts, percentages, and reason codes only; they must not emit topic names, prompt text, document text, or user content
- afterTurn gradient cap limits pressure spikes
- threshold tuning remains deferred unless a populated telemetry baseline shows a specific threshold or behavior defect

Topic-signal interpretation:

- `present` means an active topic was resolved and stamped history was available.
- `absent-no-active-topic` means compose had no active topic source to use.
- `absent-stamping-incomplete` means an active topic existed but stamped inputs were missing or insufficient.
- `intentionally-suppressed` means schema or privacy policy intentionally omitted topic telemetry.

This report path closes the ambiguity from a baseline with no usable assemble topic fields. The 0.9.0 release gate is covered by deterministic metadata-only topic evidence; safe live topic-bearing compose samples remain future tuning evidence before topic-aware threshold changes.

## Runtime diagnostics API allowlist

Verified 2026-04-24 against the installed OpenClaw runtime: `openclaw doctor --non-interactive` no longer reports the bundled public-surface allowlist blocker, and the memory-core runtime facade can load `memory-core/runtime-api.js`.

This is an upstream OpenClaw diagnostics surface, not HyperMem-owned runtime behavior. If the blocker returns, do not patch OpenClaw from this repo. Record the exact failing public-surface path and classify it as `upstream-required` unless the failing surface is HyperMem's own memory plugin diagnostics.

## Release diagnostics checklist

Run this checklist before tagging:

```bash
npm run validate:version-parity
npm run validate:docs
npm run validate:config
npm run validate:release-path
npm test
hypermem-model-audit --strict || true
```

The local repo may not be the active OpenClaw runtime, so `hypermem-status` and `hypermem-model-audit` should be interpreted against the configured deployment. For package release proof, the required gates are version parity, docs/config validation, release path, tests, and pack dry runs.
