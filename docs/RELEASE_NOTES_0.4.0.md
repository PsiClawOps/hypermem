# HyperMem 0.4.0 Release Notes

_Released: 2026-04-06_

This release marks the transition from early stabilization to a production-ready context engine. The headline is vector search going live end-to-end — but the bulk of the work was hardening the pressure management system that keeps agents stable under load.

---

## What's in 0.4.0

### Vector Store — Live

Vector search is now wired end-to-end via `sqlite-vec`. Prior releases stored embeddings but didn't serve them in the assemble path. As of 0.4.0:

- Hybrid retrieval: BM25 keyword + vector similarity, merged with RRF scoring
- Episode vectorization threshold lowered (0.7 → 0.5) for broader coverage
- `backfillEpisodeVectors()` available for upgrading existing installations
- Domain column populated on extracted facts (was writing null in prior versions)

### Pressure Management — Full Stack

The EC1/EC3 pressure tiers are fully implemented and tested:

- **EC1 (JSONL replay):** bootstrap-time detection + 30% proactive truncation. Preflight gate uses token budget as the primary gate, not message count.
- **EC3 (afterTurn two-tier):** 90%+ sessions get the nuclear path (45% cut). AfterTurn pre-emptive headroom fires at >80% to prevent the next turn from arriving already saturated.
- **Tool-loop trim:** trims the messages array directly, not just Redis. Pressure check reads runtime messages, not Redis (fixed post-restart blindspot).
- **Nuclear compaction path:** for sessions that arrive saturated before any turn runs.
- **Self-service flush script:** `scripts/flush-agent-session.sh` — agents can flush themselves before gateway restart.
- **Density-aware JSONL truncation:** handles large-message sessions that would overflow even after percentage-based cuts.
- **Preamble-aware truncation:** preserves system prompt structure through trim operations.

### Session Attribution + Identity

- Session attribution in facts render: facts now carry correct session provenance
- Identity slot population on warm start: agents re-hydrating from Redis now get full identity context, not just message history
- Desired-state store: bare model strings now parse correctly (fleet cache hydration fix)

### Topic Synthesis — Karpathy Wiki Pattern

Background indexer now compiles topic maps into structured knowledge entries. Topics accumulate episodes and facts, then synthesize into a navigable wiki-style knowledge layer. Synthesis stays in the background indexer for predictable runtime behavior — no latency impact on turns.

### Virtual Sessions

VS-1 through VS-5 shipped:
- Topic-scoped Redis warming (VS-1)
- Topic detector noise fix (VS-5)
- Transaction wrapper, min-message threshold, orphan guard, dedup-on-create, old-key migration (from Anvil/Clarity review)

### Budget Downshift

Fix A: detection + proactive reshape pass. Compositor correctly identifies when a model switch has reduced the available context window mid-session and reshapes the existing history to fit before the next turn assembles.

### Live Org Registry

Fleet agents loaded live from `fleet_agents` table and cached in Compositor. Eliminates stale cross-agent context from hardcoded registry.

### Cross-Topic Keystone Retrieval

Keystone selection now crosses topic boundaries when recency + significance warrant it. Prior versions only promoted keystones within a single topic thread.

---

## Migration from 0.3.0

No breaking changes. Drop-in upgrade:

```bash
npm install @psiclawops/hypermem@0.4.0
openclaw gateway restart
```

Vector search requires embeddings. If you're upgrading an existing installation with history, run backfill after restart:

```js
import { createHyperMem } from '@psiclawops/hypermem';
const hm = await createHyperMem({ dir: '~/.openclaw/hypermem' });
await hm.backfillEpisodeVectors('your-agent-id');
```

Domain column backfill for extracted facts runs automatically on first boot.

For migrations from Cognee, QMD, or other memory systems, see `docs/MIGRATION_GUIDE_COGNEE_QMD.md`.

---

## Known Limitations

See `KNOWN_LIMITATIONS.md` for the current list. No new additions in 0.4.0.
