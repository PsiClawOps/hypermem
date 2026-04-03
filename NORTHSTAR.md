# HyperMem Northstar

**Author:** Forge  
**Date:** 2026-04-03  
**Status:** Active — guides all roadmap and architecture decisions

---

## The Problem We're Solving

OpenClaw agents lose context. Every session starts from scratch. Decisions made last week are invisible to agents today. The operator has to re-explain the same things repeatedly. As the fleet grows, agents drift — each one operating on a different slice of reality with no shared ground truth.

The default OpenClaw context assembly is a sliding window over a growing transcript. When the transcript gets too long, the runtime summarizes it. The summary is lossy. The agent gets a degraded approximation of its own history. There's no memory of what *matters* — only a blend of what *was recent*.

HyperMem exists to fix this at the infrastructure level.

---

## The Vision

**An agent using HyperMem should feel like an experienced colleague who was there for everything that mattered — not a new hire who got handed a summary document.**

Concretely, that means:

1. **Decisions persist.** A decision made in March surfaces in April when it's relevant — not because someone manually wrote it down, but because HyperMem scored it as high-signal and retrieves it when the context calls for it.

2. **Knowledge accumulates.** Facts, preferences, domain knowledge, and structural patterns build up over time in a queryable library. The agent doesn't just have memory of conversations — it has a structured understanding of the domain it operates in.

3. **Context is assembled, not recalled.** Every prompt is built fresh from storage — facts, keystone history, semantic recall, and recent turns — each within a strict token budget. The agent always gets the most relevant context for *this specific moment*, not a generic history dump.

4. **The fleet shares a ground truth.** All agents read from the same L4 library. Forge's understanding of the infrastructure should inform Chisel's implementation decisions. Compass's strategic analysis should be visible to Sentinel's risk review. Memory is a shared resource, not per-agent isolation.

5. **Context survives compaction.** The operator never loses history because a transcript got too long. HyperMem owns compaction — and compaction means structured storage, not summarization. No information is irrecoverably lost; it's tiered by signal value.

---

## What "Done" Looks Like

HyperMem is done when:

- **A cold-start agent** picks up where the last session left off without being briefed. Key decisions, active work items, and relevant domain knowledge are present in the first prompt.

- **A cross-agent query** returns coherent answers. Asking Forge "what did Chisel decide about the transport layer?" returns the actual decision, not silence.

- **An operator can audit memory.** `memory_search` returns the right things. Facts have provenance. Episodes have context. Nothing important is hidden in an unindexed transcript.

- **The fleet can be published.** HyperMem ships as a clean npm package with documented APIs, hardened reliability, and an install guide. Other OpenClaw operators can deploy it.

---

## The Architecture Bets

These decisions are load-bearing. Changing them is a large undertaking.

| Bet | Rationale |
|---|---|
| **Four-layer store (Redis → SQLite Messages → SQLite Vectors → SQLite Library)** | Each layer optimized for its access pattern. Hot reads from Redis, durable history in SQLite, semantic recall from vectors, structured knowledge from library. |
| **Compositor owns prompt assembly** | The runtime's job is to call HyperMem, not to manage context. Keeping composition in HyperMem means we control the budget, the slot order, and the quality gates. |
| **Local embeddings (nomic-embed-text)** | Benchmarked against alternatives. Wins on domain recall. 40ms cold / 0.02ms cached with LRU. No round-trip cost, no privacy risk. |
| **SQLite as the durable layer** | Simpler than Postgres, adequate at our fleet size. Built-in FTS5. `sqlite-vec` for KNN. node:sqlite built into Node 22. No external dependency for durability. |
| **Plugin model for OpenClaw integration** | HyperMem is not a patch to OpenClaw internals. It's a drop-in context engine registered via the plugin API. Upgrading OpenClaw doesn't break HyperMem. |

---

## What HyperMem Does Not Do

- **HyperMem is not a RAG system for external documents.** It's a memory system for agent conversations and structured knowledge. Indexing external corpora is out of scope.

- **HyperMem does not replace human memory.** The operator's daily files, MEMORY.md, and workspace context are inputs to HyperMem — not replacements. HyperMem makes retrieval fast and structured; it doesn't decide what's worth remembering.

- **HyperMem does not manage agent behavior.** It surfaces context. What the agent does with that context is the agent's responsibility.

- **HyperMem does not own governance.** Facts and episodes are stored with provenance and visibility scoping, but policy decisions about what agents can see belong to POLICY.md and the council governance layer.

---

## Roadmap Horizon

| Phase | Status | Theme |
|---|---|---|
| Phase 1 — Stabilization | ✅ Complete | Fix the foundation: CI, types, durability, classification, indexing |
| Phase 2 — Context Quality | ✅ Complete | Make the context window smarter: keystones, classifiers, proactive cleanup |
| Phase 3 — Topic Inference | 🔲 Next | Cross-turn thread tracking: automatic topic detection, topic-aware recall |
| Phase 4 — Fleet Intelligence | 🔲 Future | Cross-agent queries, fleet-wide knowledge synthesis, shared episodic memory |
| Phase 5 — Publish | 🔲 Future | npm package, hardened APIs, install guide, public release |

**Phase 3 detail (next):** Automatic topic clustering across turns. When a conversation returns to a topic from 30 turns ago, HyperMem recognizes it and surfaces the earlier thread. No manual tagging required — topic inference from message embeddings + episode metadata.

**Phase 4 detail (future):** True cross-agent memory. Forge's infrastructure decisions are visible to Chisel. Sentinel's threat assessments inform Anvil. The fleet operates on shared ground truth rather than isolated per-agent silos.

---

## The Bar

HyperMem should be the best agent memory system available for OpenClaw — and competitive with anything available for any agent framework. The architecture is novel (proactive prompt composition is not in prior art). The implementation is production-grade. The test coverage is real.

When it ships publicly, it should be something worth pointing at.

---

_HyperMem is infrastructure. Nobody notices it when it's working. Everyone notices when it isn't. Build it to be invisible._
