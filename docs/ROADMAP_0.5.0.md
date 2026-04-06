# HyperMem 0.5.0 Roadmap

_Working draft — updated 2026-04-06_

0.4.0 closed out the pressure stack and got vector search live. 0.5.0 is about making recall smarter and making the system observable.

---

## Theme: Smarter Retrieval + Operational Visibility

The core engine is stable. The gaps now are in recall quality (what gets surfaced and when) and operator visibility (why did the agent say that, what did it see).

---

## P0 — Must ship

### Retrieval Quality

**Temporal decay in hybrid scoring**
Facts and episodes degrade in relevance over time but the scorer doesn't know that. A preference set six months ago should rank below one set last week for the same query. Implement decay weighting in the RRF merge step.

**Per-domain retrieval budgets**
Currently all domains compete for the same fact slots. Infra/architecture facts crowd out preferences and vice versa. Domain-aware slot allocation so each domain gets a fair share of the assembled context.

**Negative fact suppression**
The indexer extracts facts from corrections ("no, that's wrong — the actual value is X") but both the original and the correction end up in the store. Need contradiction detection to tombstone superseded facts.

### Observability

**Compose trace log**
Every `assemble()` call should write a compact trace: what was retrieved, what was cut, what token budget was used per slot, what pressure tier fired. Writes to a rolling `traces/` directory. No UI yet — flat JSONL is enough for 0.5.0. This is the single biggest gap for debugging recall issues.

**`/hypermem status` endpoint**
Gateway-exposed status: library.db fact counts per agent, messages.db message counts, vector index coverage %, last indexer run, Redis hit rate. Feeds into ClawDash when that surface is ready.

---

## P1 — Should ship

### Recall

**Proactive context injection**
The compositor currently assembles on demand (when a turn arrives). Add a pre-turn pass that detects topic shifts in the inbound message and pre-loads relevant context before assembly runs. Reduces the "cold start" feel on topic switches mid-session.

**Cross-session recall for recurring facts**
Facts extracted in session A are available in session B if they're in the library, but session warmup doesn't actively pull cross-session facts for the current topic. Wire topic-scoped cross-session seeding into the warm path.

**Keystone promotion quality gate**
Current keystone selection is recency + significance. Add a coverage gate: don't promote a keystone if its content is already well-represented in the current warm context. Reduces redundancy in long sessions.

### Hardening

**Embedding model change detection**
When `nomic-embed-text` or any configured embedding model changes, the vector index is stale but nothing detects this. Add a model fingerprint to the vector index metadata and trigger backfill automatically on mismatch.

**Redis eviction recovery**
If Redis evicts keys mid-session (OOM), the next warm fails silently. Detect partial warm (key count below expected) and fall back to cold-load from SQLite rather than serving a degraded context without flagging it.

---

## P2 — Nice to have

**Memory diff on compaction**
When a session compacts, write a before/after summary of what facts changed: new facts extracted, facts updated, facts that would have been contradicted. Useful for auditing what the agent "learned" from a long session.

**Structured export**
`hypermem export --agent <id> --format json` — dumps the full knowledge state for an agent in a portable format. Needed for backup, migration tooling, and eventually cross-instance sync.

**Dreaming integration**
OpenClaw's memory-core has a dreaming/promotion pipeline. With memory-core disabled, we've lost that promotion signal. Build a lightweight equivalent inside HyperMem: score facts by recall frequency and query diversity, surface promotion candidates to a `candidates.md` file for human review. No auto-promotion — keep the human gate.

**Congee/Cognee migration script**
Cognee uses an ECL pipeline with graph + vector dual storage (Python SDK, `topoteretes/cognee`). The data model is different enough that migration isn't a simple SQLite copy — need an export step from Cognee's graph store and a transform into HyperMem's fact/episode schema. Track as a 0.5.0 stretch goal; ship if Cognee adoption is real.

---

## Not in 0.5.0

- Multi-tenant isolation (separate namespaces per user within an agent) — needs API surface design first
- Real-time memory UI (ClawCanvas surface) — depends on `/hypermem status` endpoint landing first
- Graph traversal queries — Cognee-style knowledge graph with edge weights. The topic map is a light graph but not queryable as one yet. Deferred to 0.6.x.
- Distributed Redis (cluster mode) — single-node Redis is the target for the foreseeable future

---

## Backlog (unscheduled)

**Zero-external-dependency Redis alternative**
Current: `ioredis` requires a running Redis server. Installation friction for new users is real even if Redis is a one-liner to install. Options to evaluate:
- **SQLite KV mode** — investigate using `cr-sqlite` or a similar SQLite fork that exposes an in-process KV store with TTL support. Goal: drop the Redis process requirement entirely for single-node installs while keeping the same hot-cache semantics.
- **In-process Map + TTL hardening** — the existing JS fallback is too limited for production workloads. Expanding it could serve as a stopgap while the SQLite path is evaluated.
- **lmdb** — embedded KV with Node bindings, no external process, fast. API is different from Redis but the abstraction layer in `redis.ts` could be adapted.

Approach: evaluate SQLite KV first (lowest new dependency surface), then lmdb. Whichever path is chosen, the `redis.ts` abstraction layer means the rest of the codebase doesn't change.

---

## Version target

0.5.0 when P0 items are complete and at least two P1 items ship. No hard date.
