# HyperMem Tuning Registry

Tracks before/after values for tunable parameters across HyperMem and ClawText compositor layers.
Each entry records the change, rationale, and date — so we can track drift over time and revert if needed.

---

## Format

```
### TUNE-NNN — <parameter name>
- **File:** <relative path>
- **Parameter:** <what changed>
- **Before:** <old value or behavior>
- **After:** <new value or behavior>
- **Rationale:** <why>
- **Date:** YYYY-MM-DD
- **Status:** active | reverted | superseded
```

---

## Log

### TUNE-001 — Semantic recall minimum score filter
- **File:** `src/compositor.ts` — `buildSemanticRecall()`
- **Parameter:** Minimum RRF score threshold for Related Memory inclusion
- **Before:** No score filter — all hybrid search results included up to token cap
- **After:** Results with `score < 0.008` are dropped before formatting
- **Rationale:** RRF scores for this corpus range ~0.01–0.03 for useful signal; scores below 0.008 are noise from very-low-rank matches with no semantic relationship to the query. Initial value conservative — tune up if recall drops, tune down if noise re-emerges.
- **Date:** 2026-04-01
- **Status:** active

### TUNE-002 — Active Facts confidence floor
- **File:** `src/compositor.ts` — `buildFactsFromDb()`
- **Parameter:** Minimum confidence for facts included in context
- **Before:** No confidence filter — all non-superseded, non-expired facts with `decay_score < 0.8` included
- **After:** Facts with `confidence < 0.5` excluded from context injection
- **Rationale:** Background indexer assigns confidence scores by pattern type (0.7 for decisions/incidents, 0.6 for learned, 0.5 for config/preferences/operational). Low-confidence facts that haven't been validated should not pollute the context slot. Threshold 0.5 lets all indexer-extracted facts through for now; tighten to 0.6 once fact quality improves.
- **Date:** 2026-04-01
- **Status:** active

### TUNE-003 — Differentiated fact confidence by pattern type
- **File:** `src/background-indexer.ts` — `indexAgent()` fact extraction
- **Parameter:** Confidence assigned to extracted facts
- **Before:** All facts assigned flat `confidence: 0.6` regardless of extraction pattern
- **After:** Confidence varies by source pattern:
  - Decision/commitment patterns → 0.75
  - Learned/discovered patterns → 0.65
  - Config/setting patterns → 0.60
  - Preference patterns → 0.60
  - Operational (deployed/fixed/incident) patterns → 0.70
- **Rationale:** Decisions and incidents are high-signal; they should survive pruning. Config/preference patterns match more promiscuously and deserve lower initial confidence. Enables TUNE-002 to actually differentiate.
- **Date:** 2026-04-01
- **Status:** active

### TUNE-004 — Episode significance threshold raised
- **File:** `src/background-indexer.ts` — `BackgroundIndexer` config default
- **Parameter:** `episodeSignificanceThreshold` default
- **Before:** 0.5 — included discoveries (0.5), milestones (0.5), deployments (0.8), decisions (0.7), incidents (0.9)
- **After:** 0.5 — same threshold, but `config_change` significance raised from 0.4 → 0.5 so they're no longer silently dropped
- **Rationale:** config_change episodes were being extracted but then dropped at the 0.5 threshold. These are operationally relevant. Either raise their significance to match threshold or lower threshold — chose to raise significance since config changes are meaningful operational events.
- **Date:** 2026-04-01
- **Status:** active

### TUNE-005 — Extraction Context slot: guard against empty/unknown signal
- **File:** `src/providers/extraction-provider.ts` (ClawText)
- **Parameter:** `available()` guard condition
- **Before:** Returned true if extraction state exists with any strategies — even if the resolved strategy was generic ("Lightweight", mode=default)
- **After:** Returns false (slot suppressed) when the resolved strategy produces no useful differentiation signal: strategy mode is not `'standard'` or `'deep'`, OR strategy is the default lightweight catch-all
- **Rationale:** When ExtractionContext shows "Topic: unknown / Strategy: Lightweight / Mode: default" it's pure noise — the model already knows this. The slot should only fire when there's actual extraction configuration that differs from defaults.
- **Date:** 2026-04-01
- **Status:** active

### TUNE-006 — Advisor Context slot: suppress seat-list-only output
- **File:** `src/providers/advisor-provider.ts` (ClawText)
- **Parameter:** `fill()` return condition
- **Before:** Returned content whenever `perspectives.length > 0` — even if content was only a list of council seat names with no routing signal
- **After:** Returns empty (slot suppressed) when `ownerAdvisorId` is absent AND no domain routes were matched — i.e., when the only content would be a bare `- Council perspectives: Compass, Vanguard, Forge, ...` line
- **Rationale:** A list of council seat names adds zero information in a single-agent context. The slot is useful when: (a) there's an active advisor owner for the session, or (b) a domain route was matched and we're routing to a specific advisor. Otherwise suppress.
- **Date:** 2026-04-01
- **Status:** active

### TUNE-007 — Identity Anchor: no-op on default identity resolution
- **File:** `src/slots/identity-anchor-provider.ts` (ClawText)
- **Parameter:** `extractIdentityAnchorContent()` guard
- **Before:** Emitted Identity Anchor block even when `resolveAgentIdentity()` fell back to `agentId: 'default', agentRole: 'worker'`
- **After:** Returns `null` (no anchor injected) when resolved identity is `agentId === 'default'`
- **Rationale:** A "default (default) / worker tier" identity anchor is worse than no anchor — it actively misleads models with wrong identity. No anchor is better than a wrong anchor.
- **Date:** 2026-04-01
- **Status:** active
