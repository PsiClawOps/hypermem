# Contradiction-Aware Decay

**Status:** Backlog
**Priority:** P1 (quality-of-life, prevents stale fact poisoning)
**Filed:** 2026-04-12
**Filed by:** Forge

## Problem

Decay is currently time-based and uniform. Every fact decays at 0.01/tick regardless of accuracy. When an architectural pivot invalidates old facts (e.g., CLI deleted, execution model changed), the stale facts persist at the same confidence as current facts until slow time-decay eventually buries them. Meanwhile, fresh sessions discover the stale facts and act on them.

Real example: `bin/hyperbuilder.js` was deleted weeks ago. No fact recorded the deletion. The file's existence in the repo + stale facts about the CLI caused multiple sessions to attempt using it, wasting time each time.

## Proposed Solution

When a new fact is ingested that contradicts an existing fact:

1. **Detection:** Compare new fact content against existing facts for the same agent/scope. Use semantic similarity + keyword overlap to identify potential contradictions.
2. **Confirmation:** If contradiction confidence is above threshold, mark the old fact's `superseded_by` field with the new fact's ID.
3. **Accelerated decay:** Superseded facts get their decay_score bumped by 0.3-0.5 immediately (instead of waiting for 30-50 ticks of 0.01 increment).
4. **Pruning:** Facts with `superseded_by` set AND `decay_score >= 0.8` are eligible for immediate pruning in the next lint pass.

## Key Design Questions

- **Contradiction detection method:** Embedding similarity? Keyword overlap? LLM judge? Trade-off is accuracy vs. cost. Embedding similarity is cheap but may miss semantic contradictions. LLM judge is accurate but expensive at 9,700+ facts.
- **Scope:** Should this only apply within the same `scope` (agent/session/user) or cross-scope?
- **False positives:** Two facts can appear contradictory but both be true in different contexts (e.g., "Forge runs Sonnet" and "Forge runs GPT-5.4 in council mode"). Need context-awareness.
- **Batch vs. incremental:** Run contradiction check on every new fact ingestion, or as a periodic background pass?

## Incremental Path

1. **Phase 1:** Keyword-based contradiction detection on fact ingestion. If a new fact shares >60% of entity keywords with an existing fact but has opposing predicates, flag for accelerated decay. Cheap, catches obvious cases like "X exists" vs "X was deleted".
2. **Phase 2:** Embedding-based similarity check. New facts with >0.85 cosine similarity to existing facts but different content trigger a contradiction review.
3. **Phase 3:** LLM judge for ambiguous cases (optional, only if Phase 1-2 miss too many).

## Impact

Prevents the "ghost fact" class of bugs where stale architectural facts persist and mislead fresh sessions. The HyperBuilder CLI ghost cost 3+ sessions worth of wasted investigation. Every major pivot (execution model change, API redesign, tool deletion) creates the same risk.
