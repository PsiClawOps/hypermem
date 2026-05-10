<!-- markdownlint-disable MD013 -->

# DOE Phase 1 Evidence — 2026-05-09

This directory mirrors the DOE phase 1 screening artifacts that back the
`specs/MULTIHOP_ARCHITECTURE_AUDIT_2026-05-09.md` audit, and the
`feedback/2026-05-09_multihop_closure_plan.md` plan.

## Provenance

- **Source repo:** `psiclawops/easylocomo-hypermem`
- **Source path:** `docs/reviews/`
- **Source commit:** `5ad0887` (`Add DOE phase 1 screening report`),
  parent `f632f6e` (`Add DOE phase 1 screening instructions for test-hank`)
- **Captured into hypermem:** 2026-05-09 by Anvil

## Why this lives in hypermem

The MULTIHOP_ARCHITECTURE_AUDIT spec cites these files as the evidence base for
the structural diagnosis. That spec lives in `hypermem/specs/`, but the
DOE artifacts originate in a separate repo. Keeping the spec self-contained in
the repo it ships under reduces the risk that a future reader cannot reach the
evidence (cross-repo drift, repo renames, access scope changes).

The canonical, ongoing copy still lives in `easylocomo-hypermem`. This
folder is a **point-in-time snapshot** for the multi-hop closure plan, not a
working copy.

## Files

| File | Purpose |
|---|---|
| `test-hank-doe-phase1-report-2026-05-09.md` | Aggregated screening report (174 lines). Primary source for the audit's DOE summary table. |
| `test-hank-doe-phase1-matrix-2026-05-09.json` | The 16-cell design matrix (factors, levels, runtime levers). |
| `test-hank-doe-phase1-instructions-2026-05-09.md` | Test-hank dispatch instructions used to execute the DOE. |
| `test-hank-doe-phase1-gate-test-hank-doe-phase1-c12-20260509-0920.md` | Best ranked cell (`c12`). Multi-hop raw F1 0.5827, `mh_complete=3`, temporal/open-domain guardrails preserved. |
| `test-hank-doe-phase1-gate-test-hank-doe-phase1-c12-20260509-0920.json` | Per-row gate output for `c12`. |
| `test-hank-doe-phase1-gate-test-hank-doe-phase1-c06-20260509-0909.md` | Best raw multi-hop F1 cell (`c06`). F1 0.6599, but temporal regressed to 0.6279, failing the temporal guardrail. |
| `test-hank-doe-phase1-gate-test-hank-doe-phase1-c06-20260509-0909.json` | Per-row gate output for `c06`. |

## Headline result

No DOE cell cleared all 5 stratified-50 guardrails. The best-ranked cell `c12`
preserved temporal/open-domain at the cost of multi-hop raw F1. The best
multi-hop cell `c06` regressed temporal. The DOE established that
**lever-tuning over the current representation cannot reach the gate**. That
finding is the trigger for the structural redesign captured in the audit and
the closure plan.

## Reading order

1. `test-hank-doe-phase1-report-2026-05-09.md` (the summary)
2. `../../specs/MULTIHOP_ARCHITECTURE_AUDIT_2026-05-09.md` (Forge's
   structural diagnosis built on the report)
3. `../../feedback/2026-05-09_multihop_closure_plan.md` (Anvil's response with
   the four-layer closure plan)
