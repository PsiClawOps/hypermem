# hypermem 0.2.0 — Public Alpha Release Notes

**Tag:** `v0.2.0`  
**Date:** 2026-04-04  
**Status:** Public Alpha  
**Reviewed by:** Anvil (W2/W3 failure-mode assessment), Sentinel (W1/W5 trust-boundary review)

---

## What's New

### W1 — Retrieval Access Control
Fact and episode retrieval is now scoped at the compositor boundary. Agent-scoped facts (`scope='agent'`) are only returned for the requesting agent. Session-scoped facts (`scope='session'`) are isolated to the originating session. Cross-agent fact leakage is blocked at compose time, not storage time.

- `checkScope()` enforces agent/session/global/null rules at retrieval
- `scopeFiltered` counter in diagnostics tracks how many facts were withheld
- Permissive null-to-agent default retained for legacy compatibility (see Known Limitations)

### W2 — Trigger-Miss Fallback
No more silent zero-memory path. When no trigger keyword matches the incoming message, the compositor falls back to bounded KNN semantic search (10% of remaining budget, 500ms timeout). The agent always gets *something* relevant rather than an empty context slot.

- Fallback is best-effort — timeout or error never fails composition
- `triggerFallbackUsed` and `retrievalMode='fallback_knn'` in diagnostics confirm when fallback fired
- Triggered retrieval and fallback retrieval are mutually exclusive by control flow (not additive)

### W3 — Compose Diagnostics
Every composition turn emits a structured diagnostic log line and a `ComposeDiagnostics` object in the `ComposeResult`:

```
[hypermem:compose] agent=forge triggers=2 fallback=false facts=28 semantic=29 chunks=0 scopeFiltered=0 mode=triggered
```

Fields: `triggerHits`, `triggerFallbackUsed`, `factsIncluded`, `semanticResultsIncluded`, `docChunksCollections`, `scopeFiltered`, `retrievalMode`, `zeroResultReason`.

`zeroResultReason` distinguishes: `scope_filtered_all` / `budget_exhausted` / `no_trigger_no_fallback` / `empty_corpus` / `unknown`.

### W4 — History Rebalance
Context window allocation rebalanced for long-session coherence:
- History slot: 50% → 65% of budget ceiling
- Facts cap: 40 → 28 facts maximum
- Memory slots lose budget contention before history under pressure
- Keystone injection preserves critical recalled messages across compaction boundaries

### W5 — Trigger Registry
Trigger definitions extracted from inline code into an owned, auditable module:
- Registry hash logged at startup: `[hypermem:triggers] version=1.0.0 hash=e37440256c45 entries=7`
- 7 active triggers: governance, identity, policy, memory, tool, fleet, debug domains
- Constructor-only injection — not reachable from conversation layer

### W6 — Northstar Alignment
Product claims audited against implementation. All V2 Northstar language reflects current implementation state. "Continuity guarantee" and "self-organizing memory" claims scoped accurately.

### W7 — Regression Harness
5 scenarios, 14 assertions protecting all W1–W5 behaviors:
- S1: Trigger-miss fallback fires (W2)
- S2: Cross-agent scope isolation (W1)
- S3: Superseded fact not injected (W1 + supersedes)
- S4: Scope-filtered count tracked (W3)
- S5: Budget pressure — history wins over memory slots (W4)

All 14 pass. Run with: `node test/retrieval-regression.mjs`

### W8 — Embedding Coverage
- 11,220 vectors live in sqlite-vec store
- 100% episode coverage
- 0 embedding errors
- nomic-embed-text confirmed as embedding model (fleet-wide decision, not switching)

---

## Known Limitations

### Global-Scope Facts: No Write Authorization Gate (Sentinel W1-Q2)

Facts written with `scope='global'` are readable fleet-wide at L4 priority with no write-side authorization check at the API layer. Any agent with access to `hm.addFact()` can write a global-scope fact that becomes immediately visible to all other agents during composition.

**For 0.2.0 alpha:** This is acceptable. The fleet is a trusted single-operator environment. No untrusted agents have API access.

**Do not use `scope='global'` facts in untrusted multi-tenant or multi-operator environments.** Write authorization enforcement is a 0.3.0 / 0.4.0 roadmap item.

Mitigation path: Add a write-authority model at the API layer (per the Artifact Storage Standard) before any external/multi-tenant deployment.

### Trigger Registry: No Per-Turn Audit Hash (Sentinel W5-Q5)

The trigger registry hash is logged at startup but not included in per-turn `ComposeDiagnostics`. Post-hoc auditing of which registry version was active for a given turn is not possible from diagnostics alone — requires correlating turn timestamps against startup logs.

V2 item: add `triggerRegistryHash` to `ComposeDiagnostics`.

### Aggregate Trigger Budget: No Global Cap (Sentinel W5-Q6)

Each trigger collection is capped at 12% of remaining budget. However, if all 7 triggers fire simultaneously, the aggregate token spend is uncapped. In adversarial or pathological prompt scenarios, this could cause budget exhaustion before history and facts are assembled.

V2 item: add `maxTotalTriggerTokens` to `CompositorConfig`.

### Ambiguous Scope Blended into scopeFiltered (Sentinel W1-Q3)

Facts with ambiguous scope resolution are counted in `scopeFiltered` rather than a dedicated `ambiguousScopeCount` counter. Operators cannot distinguish "filtered by policy" from "filtered due to scope ambiguity" in current diagnostics.

V2 item: separate `ambiguousScopeCount` from `scopeFiltered`, log ambiguous scope as WARN.

### Regression Harness: No Production-Scale Scenario (Anvil W3-Q7)

The W7 harness tests boundary conditions (4K budget, 20 messages). A 250-message / 50K-budget production-scale scenario has not been validated. The history rebalance is directionally correct but untested at full production parameters.

V2 item: add regression scenario at production scale before tuning rebalance numbers further.

---

## V2 Roadmap (post-alpha fast-follow)

| Item | Source | Description |
|---|---|---|
| `ambiguousScopeCount` in diagnostics | Sentinel W1-Q3 | Separate from `scopeFiltered` |
| `triggerRegistryHash` in diagnostics | Sentinel W5-Q5 | Per-turn audit capability |
| `maxTotalTriggerTokens` config | Sentinel W5-Q6 | Global aggregate trigger budget cap |
| Write authorization gate for `scope='global'` | Sentinel W1-Q2 | Before any multi-tenant deployment |
| 250-msg/50K production regression scenario | Anvil W3-Q7 | Validate rebalance at production scale |
| Log-level gate on compose diagnostics | Anvil W3-Q5 | Move `[hypermem:compose]` to `debug` level for GA |

---

## Upgrade Notes

No breaking changes from 0.1.x. The `ComposeResult` shape gains:
- `diagnostics.zeroResultReason` — new optional field, union type extended with `'unknown'`
- `diagnostics.retrievalMode` — was already present, now includes `'fallback_knn'` value

Plugin hooks unchanged. hypermem facade API unchanged.

---

## Acknowledgements

W9 review conducted by Anvil (failure-mode analysis, W2/W3) and Sentinel (trust-boundary review, W1/W5). Both returned 🟡 Conditional GO. All tag-blocking conditions satisfied before tagging.
