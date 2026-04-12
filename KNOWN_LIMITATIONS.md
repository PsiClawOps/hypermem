# HyperMem — Known Limitations

_Last updated: 2026-04-05._

---

## Security

### [KL-01] Global-scope facts have no write-side authorization gate

**Severity:** Medium  
**Affects:** 0.3.0 and earlier  

Any caller with access to the `addFact()` API or direct write access to `library.db` can write a fact with `scope='global'`. Global-scoped facts are readable by all agents on every compose pass — they are injected at L4 priority (facts slot, before semantic recall) into every agent's context, fleet-wide.

The retrieval layer (`filterByScope()` in `retrieval-policy.ts`) correctly enforces read-side scope boundaries. There is no corresponding write-side gate that checks whether the caller is authorized to promote a fact to global scope.

**For 0.3.0 alpha on a trusted, single-operator fleet:** acceptable. Exploitation requires write access that is not exposed to the conversation layer in the current architecture. The threat is not reachable from normal agent operation.

**For any multi-agent or multi-operator deployment:** do not use `scope='global'` facts. A compromised agent or misconfigured integration that writes a global-scope fact can poison the compose context of every other agent on the next turn. This is a context injection vector with fleet-wide blast radius.

**Planned fix (V2):** Write-side gate requiring explicit opt-in via a config flag or operator-level token before any global-scope write is accepted.

---

### [KL-02] Null-scope defaults to `agent` scope — legacy compat, not permissive error

**Severity:** Low (informational)  
**Affects:** All versions

Facts written before scope tagging was introduced (W1) have `scope=null` in storage. The compositor treats `null` scope as `'agent'` scope — readable only by the owning agent. This is intentional legacy compatibility behavior, not a permissive fallback.

Operators reading `checkScope()` in `retrieval-policy.ts` and seeing `scope ?? 'agent'` should know this default is by design.

---

### [KL-03] `ambiguousScopeCount` blended into `scopeFiltered` diagnostic counter

**Severity:** Low (observability gap)  
**Affects:** 0.3.0 and earlier

The `scopeFiltered` counter in compose diagnostics aggregates two distinct cases: legitimate scope enforcement (correct behavior) and unknown/malformed scope values (`ambiguous_scope` deny). An operator watching `scopeFiltered=3` in logs cannot distinguish a schema bug or injection probe from normal policy enforcement.

**Planned fix (V2):** Separate `ambiguousScopeCount` into its own diagnostic field, logged at WARN level.

---

## Architecture

### [KL-04] Trigger registry injection has no runtime auth gate

**Severity:** Low  
**Affects:** 0.3.0 and earlier  

`Compositor` accepts an optional `triggerRegistry` at construction time. A caller who constructs a `Compositor` instance with a malicious registry controls what collections get queried. In the current architecture, compositor construction is internal to HyperMem and not reachable from the conversation layer — this surface is not exposed to agent-controlled input.

The `TRIGGER_REGISTRY_HASH` in startup logs provides an audit signal: a substituted registry will produce a divergent hash.

**Planned fix (V2):** Include registry hash in `ComposeDiagnostics` per compose call for post-hoc auditing without requiring real-time log monitoring.

---

### [KL-05] No aggregate cap on total triggered-collection token budget

**Severity:** Low  
**Affects:** 0.3.0 and earlier  

Individual triggered collections are capped at ~12% of remaining budget. However, there is no aggregate cap across all simultaneously-fired triggers. A message containing keywords that match all 7 default triggers could consume up to ~7,400 tokens across the combined collections before other context slots run.

In practice this requires a pathological (or adversarial) message and the absolute token cost is bounded by the trigger count. Not a practical concern for normal operation.

**Planned fix (V2):** Add `maxTotalTriggerTokens` config option (suggested default: 40% of remaining budget) as an aggregate ceiling across all triggers in a single compose pass.

---

## Operational

### [KL-06] Episode bulk embedding is gated on active Ollama service

If the Ollama service is unavailable at gateway startup, vector embedding for new facts and episodes is silently skipped (non-fatal fallback). Existing embeddings continue to serve KNN retrieval. New content will be FTS5-only until Ollama is available and the background indexer catches up.

Monitor with: `grep '\[hypermem\] Vector store' ~/.openclaw/logs/gateway.log`

---

_For issues not listed here, file against the `hypermem` repo or raise in `#clawtext-dev`._
