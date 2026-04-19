# Adaptive Context Lifecycle — HyperMem 0.9.0

**Status:** Draft
**Target release:** 0.9.0
**Authors:** Forge, ragesaq
**Date:** 2026-04-19

## Problem

Current warming and trim/compaction are both binary-ish:

- Warming loads a fixed fraction of recent history, fixed fact/keystone caps, regardless of session recency or user intent.
- Trim/compaction fires on pressure thresholds (80%/85%) and cuts to static fractions (50%/25%) regardless of what's relevant.
- Both behaviors are topic-blind. A user returning after 3 days on a new topic gets the same warming as a user returning after 30 minutes on the same topic. A pressure-triggered trim cuts by recency rather than relevance.

Result: either amnesia (lean warming, wrong content trimmed) or always-trimming cycles (aggressive warming, immediate pressure).

## Goals

1. **Match warming intensity to user intent and recency.** Tier warming on a gradient from `/new` (minimal) through `hot` (aggressive) with explicit thresholds.
2. **Let turn-1 user input earn its way to richer context.** Speculative warming stays lean; smart-recall surge loads confirmed-relevant content after the user speaks.
3. **Make trim/compaction adaptive to topic sharpness.** Trim first on speculative/tagged-warm content that no longer matches topic; trim last on content the active topic is built on.
4. **Establish a stable operating band.** After a major trim, land at a pressure level that gives multiple turns of headroom, not one turn.

## Non-goals

- No new storage tier or schema change.
- No reranker/embedding swap.
- No change to fact/keystone ingestion or dreaming promoter.

## Design

### 1. Warming gradient (5 tiers)

Detected at session bootstrap from last-turn timestamp + `/new` flag.

| Tier | Trigger | warmHistory fraction | maxFacts | keystoneMax | crossSession | Topic-check |
|---|---|---|---|---|---|---|
| **T0 `/new`** | `/new` command | 0 | 8 (meta) | 0 | 0 | N/A |
| **T1 Hot** | <1h | 0.35 | 30 | 15 | 6000 | skip |
| **T2 Warm** | 1–6h | 0.27 | 25 | 12 | 4000 | skip |
| **T3 Cool** | 6–24h | 0.20 | 20 | 8 | 3000 | light |
| **T4 Stale** | >24h | 0.12 | 12 | 4 | 2000 | required |

Config knobs become defaults for T2. Other tiers apply multipliers baked into the compositor.

### 2. T0 breadcrumb package

On `/new`, compositor assembles only:
- ACA stack (identity/soul/user): always
- Meta facts: 8 facts pulled by query `"what does {user} usually discuss with {agent}"` — these are topic-agnostic hooks, not recent work
- **WORKQUEUE breadcrumb:**
  - Active items: full titles + one-line Next Step from checkpoint (up to 3 items)
  - Most recently completed item: title only (1 item)
  - Target budget: ≤1.5k tokens
- Recent MEMORY.md index (already injected)

Rationale for WORKQUEUE inclusion: agents organize work through WORKQUEUE, so recent active items are the strongest topic-agnostic breadcrumb available. Including the Next Step lets the agent pick up coherently without re-reading the full checkpoint.

Target turn-1 load: ≤4k tokens of warmed content (plus unavoidable ACA/identity).

### 3. Speculative warming tags

All warmed-in content is tagged at assembly time with one of:

- `live` — current session
- `warmed-hot` — tier T1
- `warmed-warm` — tier T2
- `warmed-cool` — tier T3
- `warmed-stale` — tier T4
- `breadcrumb` — T0 meta-fact

Tag persists on the slot entry for the session. Trim/compact logic uses it to decide eviction priority.

### 4. Smart-recall surge (turn 1)

After warming is applied and before the user's first message runs through the model, we have a pre-model hook:

1. Embed user's first substantive message.
2. Run focused recall: `topK=50`, `similarityFloor=0.4` (vs steady-state 0.5), against facts + keystones + warmed-stale history + tool artifacts.
3. Classify result:
   - **Strong match** (top-5 avg cosine ≥ 0.6): inject surge. Budget cap by tier: T1 none (already loaded), T2 +8k, T3 +15k, T4 +20k.
   - **Medium match** (top-5 avg 0.45–0.6): standard recall, no surge.
   - **Weak match** (top-5 avg < 0.45): treat as topic shift. Skip surge, flag session for aggressive eviction on next assembly.

5. Surge content is tagged `confirmed-topic` — highest retention priority.

### 5. Trim/compaction gradient

Three bands, matched to pressure and topic state:

| Band | Pressure | Action | Eviction order |
|---|---|---|---|
| **Focus** | <65% | Light trim as topic sharpens | Drop `warmed-*` (non-confirmed) that fail topic-match against current conversation centroid |
| **Narrow** | 65–80% | Active relevance trim | Evict low-score facts, old keystones, stale warmed content. Preserve `confirmed-topic` and `live`. |
| **Compact** | 80–90% | Significant trim, land at stable level | Cut aggressively; target post-trim pressure **55–60%**, giving 4–6 turns of headroom |
| **Emergency** | >90% | Existing nuclear path | Unchanged from current behavior |

Key rules:

- **Focus band trims speculative warmings first.** Any `warmed-*` entry whose embedding cosine to recent-turn centroid < 0.4 is evictable, even at low pressure. This is the "topic detected, eject off-topic warming" case.
- **Narrow band uses score = relevance × recency × tag_weight.** Tag weights: `confirmed-topic`=1.0, `live`=0.9, `warmed-hot`=0.6, `warmed-warm`=0.5, `warmed-cool`=0.35, `warmed-stale`=0.2, `breadcrumb`=0.15.
- **Compact band targets a landing pressure, not a fraction.** Existing compaction cuts to 50%/25% of budget — that often over-cuts on large models. New behavior: evict lowest-score content until projected next-turn pressure lands in 55–60% band. This produces stable multi-turn operation after compaction.

### 6. Topic centroid tracking

Maintain a rolling conversation centroid in session state:

- Embed each turn's combined (user message + assistant response text).
- Centroid = exponential moving average, α=0.3.
- Rebuilt on `/new`.
- Used by Focus band eviction (§5) and by similarity-based relevance scoring in Narrow/Compact bands.

### 7. Telemetry

Log per-assembly:
- Tier detected
- Tier thresholds applied
- Surge classification + budget used
- Eviction band entered, count of entries evicted by tag
- Post-trim projected pressure vs target landing band

Enables tuning thresholds and catching regressions.

## Implementation plan

### Sprint 1 — Tiered warming + tags (2 days)

- `src/compositor.ts`: tier detection, tier config table, tag application on warmed entries
- `src/facts.ts`: `fetchMetaFacts()` for T0 breadcrumb query
- `src/session.ts` (new or existing): last-turn timestamp tracking
- Hook for `/new` command detection from gateway
- Unit tests: tier selection, tag propagation, T0 breadcrumb assembly

### Sprint 2 — Smart-recall surge (1.5 days)

- `src/recall.ts`: focused-recall pass with tier-aware parameters
- Compositor hook: post-first-message surge injection
- Match classification + surge budget logic
- Unit tests: match thresholds, surge budget caps, classification boundaries

### Sprint 3 — Adaptive trim/compaction (2 days)

- `src/compactor.ts` (refactor existing nuclear-path logic): band detection, tag-weighted scoring
- Focus-band eviction on topic centroid mismatch
- Landing-pressure target for Compact band
- Topic centroid computation + session storage
- Unit tests: band transitions, eviction priority by tag, landing-pressure accuracy

### Sprint 4 — Telemetry + tuning (0.5 days)

- Structured logs at key decision points
- `docs/TUNING.md` update with tier/band reference
- Release validation checklist

**Total: ~6 days.** Target: 0.9.0 release.

## Rollout

Feature-flag each layer independently:

- `compositor.tieredWarming.enabled` — defaults true at 0.9.0
- `compositor.smartRecallSurge.enabled` — defaults true
- `compactor.adaptiveBands.enabled` — defaults true

Each flag can be individually disabled for regression debugging. All three default on for new installs; existing installs get them via config migration on upgrade.

## Risks

1. **Tier thresholds wrong in practice.** Mitigation: telemetry from day 1, expect one tuning pass after a week.
2. **Centroid drifts badly on rapid topic changes.** Mitigation: α=0.3 is moderate; reset on `/new`; detect drift and rebuild from last 3 turns if centroid cosine to last turn < 0.2.
3. **Surge over-fires on loosely-related matches.** Mitigation: 0.6 threshold is conservative; monitor false-positive rate.
4. **Landing-pressure target overshoots on high-activity turns.** Mitigation: target is a band (55–60%), not a point; add 5% safety margin above target when computing eviction count.

## Open questions

- Should T4 Stale always force a topic check, or allow override when MEMORY.md was recently updated? (Leaning: always force; MEMORY.md content gets pulled by recall if relevant.)
- Centroid storage: session-scoped (reset per session) or session-group-scoped (persist across `/new`)? (Leaning: session-scoped; cross-session continuity is covered by cross-session context slot.)
- How to handle agents without a WORKQUEUE.md (some specialist/director seats)? (Proposed: skip WORKQUEUE breadcrumb silently; meta-facts fill the gap.)

## Success criteria

- Turn-1 pressure within 5% of tier target for 95% of sessions
- Post-compact pressure lands in 55–60% band for 90% of compact events
- Zero regression on existing context quality metrics (recall accuracy, fact freshness)
- User-reported amnesia events reduced vs 0.8.0 baseline
