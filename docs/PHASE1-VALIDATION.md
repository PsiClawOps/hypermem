# HyperMem Phase 1 Validation Runbook

Operator-facing guide for running and interpreting the Phase 1 validation suite.

---

## Quick Start

Run the full Phase 1 validation flow:

```bash
npm run build && node scripts/validate-compose.mjs && node scripts/validate-config-surface.mjs
```

Or run individual validations:

```bash
# Compose validation (facts, library, budget pressure)
node scripts/validate-compose.mjs

# Config surface parity (install.sh, docs, README)
node scripts/validate-config-surface.mjs

# Config key resolution tests
node test/config-validation.mjs

# Retrieval regression harness
node test/retrieval-regression.mjs

# Compositor integration (includes budget-pressure fixture)
node test/compositor.mjs

# Plugin pipeline (requires plugin build)
npm run validate:plugin-pipeline

# Release path hardening harness (builds core + plugin)
npm run validate:release-path

# Compose report (operator-readable diagnostics)
node scripts/compose-report.mjs
```

---

## What Each Validation Covers

| Validation | What it proves |
|---|---|
| `validate-compose.mjs` | End-to-end compose with seeded facts, knowledge retrieval, and budget pressure |
| `validate-config-surface.mjs` | Config keys present in install.sh, INSTALL.md, TUNING.md, README |
| `config-validation.mjs` | contextWindowOverrides sanitization, budget resolution, maintenance defaults |
| `retrieval-regression.mjs` | Scope isolation, superseded-fact filtering, budget pressure, knowledge retrieval |
| `compositor.mjs` | Four-layer compose, trigger routing, keystone injection, budget-pressure filtering |
| `plugin-pipeline.mjs` | Real plugin assemble() path with seeded L4 memory, tight-budget proof |
| `release-gateway-path.mjs` | Real plugin release-path proof: tool-chain ejection counters, ArtifactRef, replay marker, and degradation telemetry |
| `compose-report.mjs` | Operator-readable diagnostics showing layer counts and budget decisions |

---

## Interpreting Healthy Output

A passing run shows all checks green:

```
  ALL 12 CHECKS PASSED ✅
```

Key diagnostics in the compose report:

- **factsIncluded > 0**: facts were retrieved for the prompt
- **tokenCount <= budget**: compositor respected the token ceiling
- **retrievalMode**: `trigger`, `fallback_knn`, or `fts_only` — shows which retrieval path fired
- **scopeFiltered >= 0**: cross-session facts correctly filtered

Maintenance diagnostics (when `verboseLogging` is enabled):

```
[indexer] Maintenance: considered=5 skipped=2 scanned=3 mutated=0 duration=12ms exit=complete
```

- **considered**: conversations examined
- **skipped**: conversations within cooldown window
- **scanned**: conversations where sweeps ran
- **mutated**: total messages deleted or truncated
- **exit**: `complete`, `cap-reached`, `cooldown`, or `no-conversations`

---

## Common Cases

### Empty context (no facts/knowledge seeded)

Expected: `factsIncluded=0`, `contextBlock` may be empty or contain only history. This is normal for fresh installs or agents with no indexed conversations.

### Missing fact in context

Check: is the fact's `superseded_by` column NULL? Superseded facts are filtered. Is the fact's `agent_id` correct for the composing agent? Cross-agent facts are scope-filtered.

### Over-budget compose

The compositor respects token budgets with a small tolerance (5-15%). If `tokenCount` significantly exceeds `tokenBudget`, check `compositor.budgetFraction` and `contextWindowReserve` in config.

### Maintenance not running

Check that `maintenance.periodicInterval` is set in config.json. Default is 300000ms (5 min). If `verboseLogging` is enabled, you should see maintenance diagnostics every tick.

---

## What Remains Unverified After Phase 1

- **Vector/semantic retrieval**: all Phase 1 tests run FTS-only (no Ollama dependency)
- **Redis hot-path caching**: tests use direct compositor, not the full Redis→compose pipeline
- **Multi-agent fleet interactions**: scope isolation is tested, but fleet-wide maintenance behavior is not
- **Provider-specific formatting**: tests use `provider: 'anthropic'` only
- **Real model token counting**: tests use the char/4 heuristic estimator, not tiktoken

---

## Maintenance Tuning Reference

See [TUNING.md](./TUNING.md#background-maintenance) for the full knob reference. Key defaults:

| Setting | Default | Effect |
|---|---|---|
| `maintenance.periodicInterval` | 300000ms | Background tick cadence |
| `maintenance.maxActiveConversations` | 5 | Conversations processed per agent per tick |
| `maintenance.recentConversationCooldownMs` | 30000ms | Skip recently processed conversations |
| `maintenance.maxCandidatesPerPass` | 200 | Cap on mutations per tick |
