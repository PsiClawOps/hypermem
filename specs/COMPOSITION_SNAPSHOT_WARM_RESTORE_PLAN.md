# Composition Snapshot Warm Restore Plan

**Project:** HyperMem
**Priority:** P0
**Status:** Proposed
**Owner:** Forge
**Execution mode:** HyperBuilder-managed
**Related specs:**
- `specs/TURN_DAG_MIGRATION_SPEC.md`
- `specs/DAG_HELPER_POLICY.md`
- `specs/HYPERBUILDER_PHASE4_BRIEF.md`

## Summary

Add a composition-snapshot layer to HyperMem so a new session can be warm-restored from the last fully assembled compositor window instead of cold-starting from ordinary bootstrap and rewarming alone.

This solves the continuity failure caused by provider failover, quota exhaustion, context-window mismatch, session rotation, and manual recovery. When the active model changes or a session must be recreated, HyperMem should be able to rebuild a near-equivalent prompt window for the replacement session and preserve much more of the user’s working state.

This should be built as a **sidecar table** plus a **warm-restore API**, not as inline JSON on `contexts`.

## Problem

Today, a session can have a large, carefully composed prompt window that includes:
- system and bootstrap material
- HyperMem facts, expertise, and keystones
- recent conversational tail
- tool call / tool result pairs
- stable-prefix boundaries
- provider-specific composition decisions already made by the compositor

If the provider fails, a fallback model is selected, the quota is exhausted, or the session needs to be recreated, a normal new-session warmup only recovers a small fraction of that effective working set.

Example:
- source model window: 272k
- active fill: 200k
- source fill percent: 73.5%
- replacement model window: 200k
- ordinary cold rewarm: maybe 25k to 40k effective prompt
- continuity loss: 100k+ tokens of working state disappear from the model’s immediate reach

That is user-visible degradation. The model often loses subtle task state, active tool context, recent architectural assumptions, and the shape of long-running problem solving.

## What this feature should do

When a session must be recreated, HyperMem should be able to:

1. Load the most recent compositor snapshot for the logical session context.
2. Map the source fill level to the target model’s context window.
3. Reconstruct a new prompt window from structured composition slots.
4. Preserve tool-call invariants and branch correctness.
5. Start the replacement session with a near-equivalent working set.

This is **not** raw message replay and **not** ordinary bootstrap rewarming.

This is a new recovery mode: **same-session repair warming**.

## Why this matters now

Provider instability is now routine across OpenAI, Anthropic, Microsoft, Ollama, and others. Community complaints about transient outages and failovers are constant. A memory system that only survives happy-path sessions is no longer enough.

HyperMem can differentiate by preserving continuity across provider instability.

## Design decision recap

### 1. Use a sidecar table, not `contexts.metadata_json`

The Turn DAG spec already has `contexts.metadata_json`, but that is not the right primary home for this feature.

Use a new table, tentatively:

```sql
CREATE TABLE composition_snapshots (
  id INTEGER PRIMARY KEY,
  context_id INTEGER NOT NULL REFERENCES contexts(id) ON DELETE CASCADE,
  head_message_id INTEGER REFERENCES messages(id),
  schema_version INTEGER NOT NULL DEFAULT 1,
  captured_at TEXT NOT NULL,
  model TEXT NOT NULL,
  context_window INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  fill_pct REAL NOT NULL,
  snapshot_kind TEXT NOT NULL DEFAULT 'full',
  slots_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_composition_snapshots_context_recent
  ON composition_snapshots(context_id, captured_at DESC);
```

#### Why this is the right choice

Pros:
- queryable history
- natural support for keeping 2 snapshots now and more later
- easier debugging of compositor behavior over time
- clean fit for future blob dedup and compression work
- avoids bloating hot `contexts` rows with large JSON payloads
- simpler future operator tooling like “show me the last assembled window shape”

Costs:
- one migration
- one extra read on warm restore
- explicit transaction discipline between context-head updates and snapshot writes

The tradeoff is worth it.

### 2. Stable enum for compositor slots

Do not use freeform slot names.

Define a stable composition-slot enum in compositor code and version it with an explicit `slot_schema_version`. Treat the enum as a contract, not an implementation detail.

Starting taxonomy and contract class:

**Required, non-degradable in v1**
- `system`
- `bootstrap`
- `stable_prefix`

**Continuity-critical, protected by reservation floors**
- `hypermem_expertise`
- `hypermem_facts`
- `keystones`
- `tool_pairs`

**Elastic, segment-degradable**
- `recent_tail`
- `volatile_tail`

**Optional, zero-floor**
- `provider_annotations`

Contract rules:
- required slots must restore in full or restore fails safe
- continuity-critical slots must restore according to per-slot floor policy before elastic slots compete for budget
- elastic slots may degrade by dropping whole trailing segments in deterministic order
- `provider_annotations` is bounded structured metadata only, not a freeform content bucket or junk drawer
- deprecated slots must carry an explicit migration or ignore policy for at least one schema-version window
- unknown future slot additions require a schema-version bump or an explicitly backward-compatible extension

This contract should live in compositor code as a versioned enum plus slot-policy table, so capture and restore share the same source of truth.

### 3. Keep two snapshots per active context

Store the newest two snapshots per active context.

Why two:
- latest snapshot may be incomplete or tied to the failing turn
- previous snapshot gives one known-good fallback generation
- storage cost is low enough to make this cheap insurance

Retention rule:
- after inserting snapshot N+1, prune older snapshots so only the newest 2 remain for that context

### 4. Snapshot the composed window shape, not just raw turns

Each snapshot should describe the actual assembled prompt window at the moment just before model invocation.

A slot entry should include enough structure to rehydrate or selectively drop it later:

```json
{
  "slot": "recent_tail",
  "priority": 1,
  "tokenCount": 84211,
  "segmentCount": 37,
  "segments": [
    {
      "kind": "message_ref",
      "messageId": 1842,
      "role": "user",
      "tokenCount": 902
    },
    {
      "kind": "message_ref",
      "messageId": 1843,
      "role": "assistant",
      "tokenCount": 1171
    }
  ]
}
```

For computed non-message content:
- use inline text initially, or
- use a future content-addressed blob reference when Phase 5 storage work is ready

Hybrid plan for v1:
- turn-derived content: store as `message_ref`
- computed compositor-only content: store inline in `slots_json`
- blob dedup: explicitly deferred

### 5. Warm restore should be a general session-repair primitive

Do not bind this concept to `/new` itself.

`/new` was just the motivating example.

The real primitive is:
- create replacement session
- perform same-session repair warming from latest valid composition snapshot
- continue work

Potential triggers:
- provider failover
- context window mismatch after model switch
- quota exhaustion
- manual operator recovery
- automated continuity repair after session restart

## Functional design

## Write path

At the end of normal composition, before provider invocation:

1. Resolve active `context_id` and `head_message_id`.
2. Capture the assembled prompt structure into slot objects.
3. Record:
   - source model
   - context window
   - total token count
   - fill percent
   - slot ordering
   - segment references
4. Insert a new row in `composition_snapshots`.
5. Prune older rows beyond the retention limit of 2.

### Write constraints

- snapshot write should be best-effort, not fatal to inference
- failed snapshot writes should log diagnostic metadata but must not block normal prompting
- pruning must occur in the same write transaction if practical
- snapshot timing must be after final token accounting and after slot assembly, not before

## Restore path

Warm restore must be defined as a deterministic re-planning step from a captured composition graph, not as a lossy payload replay.

Warm restore should work like this:

1. Create or resolve replacement active context.
2. Load newest valid snapshot for source logical session.
3. If newest is invalid, unreadable, or over policy, fall back to previous snapshot.
4. Resolve the target-model restore budget using a clamped fill-percent heuristic.
5. Reserve hard continuity budget for required and continuity-critical slots.
6. Rebuild a prompt from slot entries using slot policy, priority, and recency rules.
7. Enforce tool-call / tool-result atomicity and lineage metadata.
8. Validate restore invariants before the repaired session is allowed to run.
9. Mark the restore payload as `warm_restore=true` so the compositor does not immediately double-compose over it for the first repaired turn.
10. Resume normal composition on the next turn.

Hard restore invariants:
- `system`, `bootstrap`, and `stable_prefix` must remain intact
- tool call and tool result pairs must remain atomic and correctly ordered
- source lineage must be explicit on the repaired context and restore result
- required slots must never partially degrade
- slots may only degrade if their contract explicitly allows deterministic segment trimming
- if invariants cannot be met within target budget, restore fails safe to ordinary bootstrap + rewarm

### Budget mapping

Default target:

```text
target_tokens = clamp(
  round(source_fill_pct * target_model_context_window),
  min_restore_tokens,
  max_restore_tokens
)
```

Where:
- `source_fill_pct` is a starting heuristic, not the correctness target
- `min_restore_tokens` and `max_restore_tokens` are planner-defined clamps to avoid pathological underfill or overfill
- the restore planner must reserve continuity floors before elastic slots compete for remaining budget

Example:
- source: 200k / 272k = 0.735
- target window: 200k
- raw restore size: 147k
- clamped target: planner-defined if floor reservations or safety caps require adjustment

This is continuity-guided budget mapping, not semantic equivalence by percent alone.

### Slot selection policy

Restore is not pure recency replay.

Selection order should be:
1. required slots first, full-fidelity only
2. then continuity-critical slots, subject to floor reservations
3. then elastic slots by priority
4. then recency within degradable elastic slots
5. drop `provider_annotations` first when budget is tight

Initial policy proposal:
- Always include in full: `system`, `bootstrap`, `stable_prefix`
- Reserve floors for: `hypermem_expertise`, `hypermem_facts`, `keystones`, `tool_pairs`
- Use remaining budget for: `recent_tail`, then `volatile_tail`
- Drop lowest-value provider-only annotations first if budget is tight

Degradation policy in v1:
- `system`, `bootstrap`, `stable_prefix`: no degradation allowed
- `hypermem_expertise`, `hypermem_facts`, `keystones`, `tool_pairs`: restore whole-slot or fail the restore plan if minimum protected continuity cannot be met
- `recent_tail`, `volatile_tail`: degrade by deterministic segment trimming only
- `provider_annotations`: optional, zero-floor, first to drop

Planner should confirm exact floor values from existing compositor behavior, but the contract should ship with the policy shape above rather than leaving it implicit.

### Tool handling invariants

This is critical.

Tool call and tool result entries must remain valid pairs.

Rules:
- never include a tool result without its initiating tool call
- never include a tool call if its required paired result is dropped and the pair would become misleading
- if a boundary cuts through a pair, drop the older side and continue
- preserve current tool handling logic already used at turn-message granularity

The new feature should reuse that logic, not invent a second incompatible tool-pair policy.

### Failure policy

If restore cannot safely reconstruct a valid prompt:
- fall back to ordinary bootstrap + normal rewarm
- log structured reason codes
- do not create a half-valid repaired session silently

Suggested reasons:
- `snapshot_missing`
- `snapshot_unreadable`
- `schema_version_unsupported`
- `tool_pair_violation`
- `budget_mapping_failed`
- `content_resolution_failed`
- `snapshot_too_old`

## Likely code areas

Exact filenames may shift, but the work will likely touch:

- `src/compositor.ts`
  - capture final slot layout
  - add snapshot write hook
  - add warm-restore consume path
- `src/context-store.ts`
  - source/target context linkage helpers for repair sessions
- `src/message-store.ts`
  - message hydration helpers for snapshot restore
  - tool-pair-safe segment resolution
- `src/index.ts`
  - public API surface for snapshot retrieval and warm restore
- migration files for `composition_snapshots`
- test files for compositor, context-store, message-store, and recovery flows

If there is already a provider translator boundary where the final prompt is materialized, planner must confirm whether snapshot capture belongs in compositor or one layer lower. Default assumption: compositor owns it.

## API surface proposal

Internal APIs, names tentative:

```ts
createCompositionSnapshot(input): Promise<CompositionSnapshot>
getLatestCompositionSnapshot(contextId): Promise<CompositionSnapshot | null>
getPreviousCompositionSnapshot(contextId): Promise<CompositionSnapshot | null>
restoreSessionFromSnapshot(options): Promise<WarmRestoreResult>
pruneCompositionSnapshots(contextId, keep = 2): Promise<void>
```

Possible operator/debug APIs for later:

```ts
listCompositionSnapshots(contextId, limit)
inspectCompositionSnapshot(snapshotId)
renderCompositionSnapshotShape(snapshotId)
```

The debug surface is useful but should not block v1.

## Session linkage model

The replacement session should preserve logical lineage.

Recommended shape:
- original active context is archived or rotated
- replacement context is created as new active context
- metadata records repair source context and source snapshot id

Example metadata on replacement context:

```json
{
  "repair": {
    "sourceContextId": 14,
    "sourceSnapshotId": 992,
    "reason": "provider_failover",
    "sourceModel": "openai-codex/gpt-5.4",
    "targetModel": "anthropic/claude-sonnet-4-6"
  }
}
```

This will matter for debugging and later historical mining.

## HyperBuilder execution plan

This should run as a dedicated HyperBuilder workstream, not ad hoc implementation.

Suggested workstream id:
- `composition-snapshots-warm-restore`

Suggested stages:
- planner
- generator
- build-evaluator
- security-evaluator
- finding-verifier
- cross-validator
- integrator

## Proposed sprint breakdown

### Sprint 1: schema and snapshot capture

Deliver:
- migration for `composition_snapshots`
- slot enum contract
- snapshot writer in compositor
- retention pruning to 2 snapshots
- unit tests for snapshot creation and pruning

Acceptance:
- every composed turn can emit a valid snapshot row
- retention cap is enforced
- snapshot write failure does not block prompting

### Sprint 2: restore engine

Deliver:
- restore API
- budget mapping
- slot-priority selection
- message and inline-content hydration
- fallback to previous snapshot

Acceptance:
- restore can recreate a prompt for a replacement model with a smaller window
- required slots are preserved
- unsupported snapshots fail safe

### Sprint 3: tool-pair and boundary correctness

Deliver:
- reuse existing tool pair logic for restore selection
- boundary-safe restore filtering
- stable-prefix compatibility checks
- regression tests for malformed pair boundaries

Acceptance:
- no invalid tool/result ordering introduced by restore
- restore does not violate current prompt-format invariants

### Sprint 4: integration and recovery flows

Deliver:
- repair-session orchestration path
- context lineage metadata
- structured failure reasons
- initial operator entry point for invoking warm restore

Acceptance:
- replacement session can be created and warmed from latest snapshot
- repair metadata is queryable
- ordinary sessions remain unchanged when feature is unused

### Sprint 5: hardening and performance validation

Deliver:
- larger fixture coverage
- performance benchmarks
- load and fault-injection tests
- rollout notes and operational guardrails

Acceptance:
- snapshot capture overhead is acceptable
- no active-path regression for normal composition
- failure modes are observable and bounded

## Testing strategy

This feature needs heavy testing. It changes recovery, not just storage.

### A. Unit tests

#### Snapshot capture tests
- captures slot order deterministically
- stores correct token counts
- stores source model and window size correctly
- prunes to newest 2 snapshots only
- handles missing optional slots cleanly

#### Restore planner tests
- fill-percent mapping from larger window to smaller window
- fill-percent mapping from smaller window to larger window
- budget clamp application is deterministic
- required slots always included in full
- continuity-critical slot floors are honored before elastic slots consume budget
- lower-priority slots dropped first under pressure
- non-degradable slots never partially restore
- previous snapshot fallback works
- unsupported schema version fails safely
- `provider_annotations` cannot expand into arbitrary unbounded payload content

#### Tool-pair tests
- include tool call + result together
- drop broken boundary pairs
- preserve legal ordering after restore
- mixed tool and conversational tail still reconstructs cleanly

### B. Integration tests

#### End-to-end continuity tests
1. Start session on model A with large window.
2. Build prompt to substantial fill.
3. Capture snapshot.
4. Recreate session on model B with smaller window.
5. Warm restore from snapshot.
6. Verify resulting prompt retains expected high-priority slots and recent work.

#### Session rotation tests
- archive source context
- create replacement context
- verify repair metadata and lineage
- ensure active composition now points only at new active context

#### Fallback tests
- corrupt latest snapshot
- verify previous snapshot is used
- corrupt both snapshots
- verify clean fallback to ordinary warmup

#### No-leak tests
- archived contexts do not accidentally re-enter normal composition
- repair restore only uses explicitly selected source snapshot/context

### C. Property and invariant tests

Useful for evaluator lanes:
- restore output token count never exceeds target budget
- required slots never vanish when source snapshot is valid
- required slots never partially degrade
- continuity-critical slot floors are either satisfied or restore fails safe
- tool invariants always hold
- snapshot retention never exceeds 2 per context
- source lineage metadata always points to existing archived context or valid source context id
- elastic-slot trimming is deterministic for identical input snapshots and target budgets

### D. Performance tests

Measure:
- added latency to prompt assembly when snapshot write is enabled
- storage growth for realistic long sessions
- restore latency for 100k to 200k-token snapshots
- pruning overhead

Targets:
- snapshot write overhead should be operationally negligible relative to model latency
- restore latency should be small enough that it is acceptable during failover recovery

### E. Fault injection tests

Inject:
- snapshot row write failure
- partial malformed `slots_json`
- unresolved message references
- mismatched model window metadata
- unsupported slot enum values

Expected behavior:
- fail safe
- emit structured diagnostics
- never produce silently-invalid repaired sessions

## Observability

Add structured logs and counters for:
- `composition_snapshot_created`
- `composition_snapshot_write_failed`
- `composition_snapshot_pruned`
- `warm_restore_started`
- `warm_restore_succeeded`
- `warm_restore_failed`
- `warm_restore_fallback_previous_snapshot`
- `warm_restore_fallback_cold_start`
- `composition_snapshot_payload_parity_checked`
- `composition_snapshot_payload_parity_drift`

Useful dimensions:
- source model
- target model
- source window
- target window
- source fill percent
- restore token target
- restore reason
- slot schema version
- parity result
- parity drift class

Parity checks to add in capture-only rollout:
- compare captured snapshot plan against final provider payload shape after translation
- measure token-count drift between planned assembly and sent payload
- surface dropped or transformed slot classes at the provider boundary
- block automatic restore rollout until observed parity drift is within agreed thresholds

## Rollout plan

### Phase 1
- ship behind internal feature flag
- capture snapshots only
- do not restore yet
- verify storage shape and overhead in production-like sessions
- run snapshot-vs-provider-payload parity checks and drift reporting

### Phase 2
- enable restore on manual operator invocation only
- validate repaired sessions against known scenarios
- require invariant-validation and explicit drift telemetry review before widening use

### Phase 3
- enable automatic repair flows for approved triggers such as provider failover or model window mismatch
- only after parity drift and restore-invariant metrics are within agreed thresholds

This staged rollout reduces blast radius.

## Risks and mitigations

### Risk: snapshot capture drifts from actual provider payload
Mitigation:
- capture after final token accounting
- test against provider translator boundary

### Risk: restore overfits to one provider’s composition style
Mitigation:
- keep snapshot schema provider-neutral
- define restore as deterministic re-planning from slot contract and invariants, not provider payload replay
- measure parity drift at the provider boundary before auto-restore is enabled

### Risk: invalid tool history after repair
Mitigation:
- reuse current tool-pair logic directly
- add explicit evaluator lane for tool-boundary correctness

### Risk: performance regression in normal composition
Mitigation:
- best-effort async write
- retention cap of 2
- phased rollout with capture-only mode first

### Risk: archived history leaks back into live composition
Mitigation:
- keep restore source explicit
- preserve Turn DAG active-only composition policy
- add regression tests around archived invisibility

## Problem solved, concretely

After this ships, HyperMem should be able to say:

- provider failed, session recreated, continuity preserved
- model window changed, effective working set scaled to fit
- user did not lose most of the active prompt state
- repair sessions have lineage and diagnostics
- prompt recovery is based on the actual last composed window, not a vague best-effort tail replay

That is a real product capability, not just an internal refactor.

## Review asks

### For Anvil
Focus review on:
- failure modes
- invalid-state handling
- whether any restore path could create misleading or partially-invalid prompt state
- whether fail-safe fallback behavior is strict enough

### For Compass
Focus review on:
- information architecture of slot taxonomy
- budget-mapping logic
- whether priority ordering matches cognitive continuity rather than just storage convenience
- whether the staged rollout and observability plan are sufficient

## Open questions for planner

1. Should snapshot capture happen in compositor or immediately after provider-translation payload materialization?
2. Should computed slot content be inline-only in v1 or optionally content-addressed from day one?
3. Does the replacement session need its own explicit context status beyond active/archived/forked, or is repair lineage metadata enough?
4. Which triggers should be allowed in Phase 2 manual restore versus Phase 3 automatic restore?
5. What exact floor and clamp values should ship in v1 for continuity-critical versus elastic slots across common model-window classes?

## Recommended verdict

Proceed.

This is a high-value continuity feature that fits the Turn DAG architecture, builds on Phase 4 cleanly, and is timely given current provider instability. The sidecar-table design is the right balance of speed, correctness, observability, and future extensibility.
