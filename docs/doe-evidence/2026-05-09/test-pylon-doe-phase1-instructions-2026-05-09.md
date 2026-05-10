<!-- markdownlint-disable MD013 MD060 MD012 -->

# Test-Hank DOE Phase 1 Instructions - 2026-05-09

## Purpose

Run the first designed screening matrix for HyperMem query-message recall. This replaces the v-number one-factor-at-a-time ladder.

This is a screening round, not a release qualification round and not a full benchmark round.

## Required commits

Pull both repos before starting:

- HyperMem `PsiClawOps/hypermem` main: `d51ee2f Align DOE lever spec with runtime clamps`
- EasyLoCoMo `PsiClawOps/easylocomo-hypermem` main: this instructions commit or later

Verify:

```bash
cd <hypermem>
git fetch origin && git checkout main && git pull --ff-only
git --no-pager log -1 --oneline
# Expected starts with: d51ee2f

cd <easylocomo-hypermem>
git fetch origin && git checkout main && git pull --ff-only
git --no-pager log -1 --oneline
```

## Read first

HyperMem lever surface:

```text
specs/QUERY_MESSAGE_RECALL_DOE_LEVERS_2026-05-09.md
```

EasyLoCoMo matrix:

```text
docs/reviews/test-hank-doe-phase1-matrix-2026-05-09.json
```

## Pre-flight validation

In HyperMem:

```bash
npm run build
node test/compositor.mjs
npm run validate:sdk-imports
npm run validate:sdk-latest-canary
```

In EasyLoCoMo:

```bash
npm test
```

All must pass. If any fails, stop and write:

```text
docs/reviews/test-hank-doe-phase1-abort-report-2026-05-09.md
```

Do not run any DOE cells after a validator failure.

## Fixed benchmark controls

Use these values for every cell:

- Dataset: `/tmp/locomo-bench/data/locomo10.json`
- Dataset SHA expected from noise-floor captures: `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`
- Suite: `stratified-50`
- Mode: `compose`
- Reader model: `gpt-4o`
- Embedder: `openai/qwen/qwen3-embedding-8b`
- Token budget: `90000`
- Trace: enabled
- Parallelism: none. Run cells sequentially.
- Full benchmark: forbidden in this phase.

## Matrix execution

The matrix file contains 16 cells. For each cell, use the cell's `env` string exactly when starting the HyperMem bench bridge.

Each cell must use a fresh run id:

```text
test-hank-doe-phase1-c01-<UTC-yyyymmdd-hhmm>
test-hank-doe-phase1-c02-<UTC-yyyymmdd-hhmm>
...
test-hank-doe-phase1-c16-<UTC-yyyymmdd-hhmm>
```

Cell ordinals must be lowercase `c01`..`c16`. Do not use uppercase letters in run ids.

Recommended per-cell procedure:

```bash
# 1. Stop any existing bridge cleanly.
# 2. From hypermem, start the bridge with the cell env from the matrix.
<cell env> node bench/locomo/bridge-server.mjs --port 9800 --data-dir /tmp/hypermem-bench-doe-phase1-cXX

# 3. In EasyLoCoMo, verify the override surfaced in health.
node src/cli.mjs doctor --bridge http://127.0.0.1:9800 --smoke-test=false

# 4. Run exactly one stratified-50 compose trace run for that cell.
node src/cli.mjs run \
  --dataset /tmp/locomo-bench/data/locomo10.json \
  --bridge http://127.0.0.1:9800 \
  --mode compose \
  --suite stratified-50 \
  --trace \
  --trace-limit 50 \
  --allow-subset \
  --token-budget 90000 \
  --change-set doe-phase1-cXX \
  --run-id test-hank-doe-phase1-cXX-<UTC-yyyymmdd-hhmm>

# 5. Run the evidence coverage gate for the same run.
node scripts/evidence-coverage-gate.mjs \
  --run-id test-hank-doe-phase1-cXX-<UTC-yyyymmdd-hhmm> \
  --out-json docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-cXX-<UTC>.json \
  --out-md docs/reviews/test-hank-doe-phase1-gate-test-hank-doe-phase1-cXX-<UTC>.md

# 6. Stop the bridge before the next cell.
```

If test-hank has a local service wrapper for bridge lifecycle, it may use it, but the report must record the exact `HYPERMEM_BENCH_COMPOSITOR_CONFIG_JSON` used for each cell.

## Abort criteria

Abort the matrix and write an abort report if any of these happen:

- A validator fails.
- Bridge health does not show the intended `compositorOverrides` object.
- A run writes fewer than 50 predictions.
- A run exceeds 15 minutes wall time.
- Dataset SHA differs from the fixed control value.
- Reader model or embedder drifts.
- A cell requires manual code change to run.

## Reporting contract

Write one consolidated report:

```text
docs/reviews/test-hank-doe-phase1-report-2026-05-09.md
```

Required sections:

1. Run metadata table: cell id, run id, HyperMem commit, EasyLoCoMo commit, dataset SHA, bridge data dir, JSON config override.
2. Matrix table: factors A-H as `+`/`-`, plus concrete config values.
3. Gate metrics table per cell:
   - overall raw F1
   - multi-hop raw F1
   - temporal raw F1
   - open-domain raw F1
   - `mh_complete`
   - `od_any`
   - multi-hop allSelectedRate
4. Guardrail verdict per cell:
   - `mh_complete >= 3`
   - `multi-hop rawF1 >= 0.6193`
   - `temporalRawF1 >= 0.6804`
   - `open-domain rawF1 >= 0.2752`
   - `od_any >= 5`
5. Ranked cells:
   - first by guardrail pass count
   - then by `mh_complete`
   - then by multi-hop raw F1
   - then by temporal/open-domain non-regression
6. Main-effects estimate table for A-H on:
   - `mh_complete`
   - multi-hop raw F1
   - temporal raw F1
   - open-domain raw F1
   - `od_any`
7. Recommendation:
   - top 1-3 cells for replicate confirmation, or
   - no viable cell and which factor direction looks harmful.

## Commit requirements

Commit and push:

- the 16 gate JSON files
- the 16 gate MD files
- the consolidated report
- any abort report if aborted

Do not commit local `runs/` directories.

Do not change HyperMem code during this phase.

## Acceptance

Operational acceptance for this instruction set is simply: all 16 cells complete, all artifacts are committed, and the report supports a clear next experiment.

Scientific acceptance is not required in Phase 1. This phase identifies active levers; it does not ship a tuned config.
