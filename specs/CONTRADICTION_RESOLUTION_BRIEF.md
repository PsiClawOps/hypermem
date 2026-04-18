# Contradiction Resolution — Release Hardening Track 3

## Context

`ContradictionDetector` runs during fact ingest (`background-indexer.ts` around line 977) with `autoResolve: false`. When it finds semantic contradictions (cosine similarity ≥ 0.45 between new and existing facts), it logs them to `contradiction_audits` and moves on. Nothing ever resolves those audits.

Separately, the indexer does **lexical** supersede detection via 60-char prefix match (`findSupersedableByContent` → `markSuperseded`). That path correctly writes `superseded_by` and tombstones the stale vector entry. This code is proven and in production.

The gap: **semantic** contradictions never result in `superseded_by` linkage. They only pile up in the audit table with no resolver.

## Goal

Wire semantic contradiction detections to actually update `superseded_by` (or equivalent invalidation) during ingest, behind a confidence-tiered policy so we don't auto-resolve things we're not sure about.

## Requirements

### Policy tiers

Introduce a `ContradictionResolutionPolicy` interface, injected into the indexer:

```ts
export interface ContradictionResolutionPolicy {
  /** Similarity ≥ this → auto-supersede the existing fact. Default: 0.80 */
  autoSupersedeThreshold: number;
  /** Similarity in [autoInvalidate, autoSupersede) → mark invalid, keep both rows. Default: 0.60 */
  autoInvalidateThreshold: number;
  /** Similarity below autoInvalidate → log only (current behavior). */
  // (implied: anything below autoInvalidate logs to audit)

  /** If true, even auto-resolved contradictions write an audit row (for observability). Default: true */
  alwaysAudit: boolean;
}
```

Default policy exported as `DEFAULT_CONTRADICTION_POLICY`.

### Behavior

For each contradiction surfaced by `ContradictionDetector.detectOnIngest()`:

1. **score ≥ autoSupersedeThreshold:** call `factStore.markSuperseded(existingFactId, newFactId)`. Tombstone stale vector. Audit row status = `"auto-superseded"`.
2. **autoInvalidate ≤ score < autoSupersede:** call `factStore.invalidate(existingFactId, reason)`. Do NOT set `superseded_by`. Do NOT tombstone vector (invalid but still queryable for context). Audit row status = `"auto-invalidated"`.
3. **score < autoInvalidate:** current behavior. Audit row status = `"pending"`.

### Counters

Extend the indexer's per-run result:

```ts
{
  contradictionAuditsLogged,        // existing
  contradictionsAutoSuperseded,     // new
  contradictionsAutoInvalidated,    // new
}
```

### Audit row schema

`contradiction_audits` already has a `status` column. Extend the allowed values:
- `"pending"` (existing)
- `"auto-superseded"` (new)
- `"auto-invalidated"` (new)
- `"reviewed"` (existing, reserved for future manual review)
- `"dismissed"` (existing, reserved for future manual review)

Existing column fine; no schema migration needed if status is a free-text TEXT column. Verify first; if it has a CHECK constraint, this becomes schema v11.

### Idempotency

- An existing fact should not be auto-superseded twice. `markSuperseded` already returns `false` if already superseded — respect that return.
- Invalidation should be idempotent — `invalidate` called twice on the same fact should be a no-op.

### Ordering in the ingest loop

The current loop:
1. Call `ContradictionDetector.detectOnIngest()` (semantic)
2. For each contradiction, log to audit
3. Insert the new fact via `factStore.addFact()`
4. Temporal index
5. Check `findSupersedableByContent()` (lexical) — and supersede if found

The new behavior:
1. Call `ContradictionDetector.detectOnIngest()`
2. Insert new fact via `factStore.addFact()` first (so we have `fact.id` for supersede linkage)
3. For each contradiction: apply policy, write audit row reflecting action taken, collect counters
4. Temporal index
5. Lexical supersedes check (keep existing — orthogonal to semantic path; lexical is a stronger signal)

Note: `ContradictionDetector.detectOnIngest` must still be called before `addFact` because it operates on the **candidate** fact (content + domain), not a persisted row. But the loop can buffer results and apply the resolution policy after `addFact` returns an id.

## Acceptance criteria

1. **Unit: auto-supersede path.** When detector returns a contradiction with score 0.85, the existing fact row has `superseded_by` set to the new fact id, vector is removed, audit row status is `"auto-superseded"`.
2. **Unit: auto-invalidate path.** When detector returns a contradiction with score 0.65, the existing fact is marked invalid (invalid_at non-null), `superseded_by` is NULL, vector is still queryable, audit row status is `"auto-invalidated"`.
3. **Unit: log-only path.** When detector returns a contradiction with score 0.50, no fact state changes, audit row status is `"pending"`.
4. **Unit: idempotent.** Running ingest on the same message twice does not double-supersede or double-invalidate; counters reflect zero new actions on second run.
5. **Unit: policy injection.** Indexer accepts a custom policy; threshold changes are honored.
6. **Integration: counter surfacing.** `IndexResult` includes `contradictionsAutoSuperseded` and `contradictionsAutoInvalidated` with correct values for a mixed test corpus.
7. **Regression: lexical supersede still works.** Existing lexical supersede tests (60-char prefix) continue to pass and still produce `supersededFacts++` — not counted in the new semantic counters.
8. **No schema migration needed** OR (if status has a CHECK constraint) clean v11 migration that adds the new status values; existing rows unchanged; repairLibraryDb idempotent.

## Files likely to change

- `src/background-indexer.ts` — the ingest loop, counter additions, policy wire
- `src/contradiction-detector.ts` — verify `detectOnIngest` return shape; no changes expected
- `src/contradiction-audit-store.ts` — new status values; signature may need `status` param
- `src/fact-store.ts` — verify `invalidate()` exists and is idempotent
- New: `src/contradiction-resolution-policy.ts` — interface + default export
- New: `test/contradiction-resolution.test.mjs` — unit + integration coverage

## Out of scope

- Manual review UI for `"pending"` audits (separate track)
- Bulk-resolve past audit rows (separate migration task)
- Changing lexical supersede behavior
- Changing `ContradictionDetector` similarity algorithm or thresholds

## Estimated effort

~0.5 day. Mostly mechanical: wire, count, test.
