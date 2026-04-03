# HyperMem Northstar

**Author:** Forge + ragesaq  
**Date:** 2026-04-03  
**Status:** Active — guides all roadmap and architecture decisions

---

## The Problem We're Solving

OpenClaw agents lose context. Every session starts from scratch. Decisions made last week are invisible today. The operator re-explains the same things repeatedly. As the fleet grows, agents drift — each operating on a different slice of reality with no shared ground truth.

The default context assembly is a sliding window over a growing transcript. When it gets too long, the runtime summarizes it. The summary is lossy. The agent gets a degraded approximation of its own history — a blend of what was *recent*, not what *matters*.

HyperMem fixes this at the infrastructure level.

---

## The Vision

**An agent using HyperMem should feel like an experienced colleague who was there for everything that mattered — not a new hire who got handed a summary document.**

That's not a UX aspiration. It's an engineering specification. Every goal below is a concrete test of whether we've hit it.

HyperMem prioritizes signal quality over completeness. An agent that remembers everything important is more valuable than one that remembers everything. Total recall is not the goal — it tanks prompt quality and creates noise. Selective, high-fidelity recall is.

---

## Core Goals

### 1 — Full Session Continuity
New sessions don't feel like new sessions. Compactions don't impact production quality. Recall is reliable and relevant enough that the operator never notices gaps. Recall speed never impedes functionality.

This is the foundational promise. If we hit this mark, it "just works, always." The operator doesn't think about memory — it's invisible infrastructure. "Always available" is not an availability claim; it's a retrieval quality claim. Relevant memories surface at the right moment. When a specific memory isn't surfaced, that's a recall quality problem — not a missing feature.

### 2 — Rich Memory Capability
Specific search, semantic search, and relational traversal. Agents find what they're looking for — not close approximations. Indexing schemas are designed around the access patterns agents actually use: FTS5 for exact recall, KNN for semantic similarity, graph traversal for related concepts.

### 3 — Ease of Installation
Sophisticated enough to deliver continuity and recall. Simple enough that a solo operator can deploy it in a session. The right balance means: no external database, no cloud dependency, no ops burden on day one. Grows with usage.

### 4 — Maximum Automation
As automatic as possible. Agent-led when it isn't. Operators do not learn to manage a memory subsystem. Ingestion, classification, indexing, cleanup, checkpoint creation, and compaction happen without operator intervention. When agent input is needed, the agent drives — not a settings panel.

Operators who want visibility have it — dashboards, review queues, and approval gates exist (see Goals 9, 12, 17). Operators who don't want to think about it don't have to. "No management required" does not mean "black box" — it means the default path requires no operator action, while the full observability surface is always available.

### 5 — Rich Integration Platform
HyperMem is the best place to put memory data — not a mandatory dependency every product must couple to. Deep integration with ClawDispatch, SDLC, WoW, and future PsiClawOps products via extensible hooks. Products that need agent memory can integrate with HyperMem rather than building their own. The plugin boundary stays strict: HyperMem doesn't become a monolithic bottleneck; it becomes the obvious choice.

### 6 — Data Ingestion
Any kind of data, routed to its best-fit layer. Documents → doc chunks (L4). Facts → facts collection (L4). Conversations → messages DB (L2) + episodes (L4). Raw files → seeder pipeline. Agents are guided on which layer fits their data — not left to figure it out. Ingest from URL, file, API, or conversation.

The ingest API validates and classifies before writing, not after. Quality gates run at the ingest boundary: minimum signal threshold, secret scanning, deduplication check, and layer-fit classification. Content that fails validation is rejected with a reason — it does not silently degrade the index. The most common failure mode in production memory systems is over-eager ingestion that floods the index with noise; HyperMem's quality contract is the primary defense against this.

### 7 — Data Export & Brain Transfer
Agents send rich data to other agents. Within a platform: agents share pointers to specific memories. Across platforms: export to GitHub Gist, structured JSON, or any dissemination format so knowledge can transfer between operators and fleets. Brain transfer — the ability to package and share a trained knowledge corpus.

### 8 — Checkpoints
Agents checkpoint by default. Work details survive context bloat, session boundaries, server restarts, and model handoffs. HyperMem is the durable substrate — workspace file persistence is the exception, not the pattern.

Checkpoints are not manual save points — they are the automatic result of agents doing work. HyperMem moves the fleet away from the anti-pattern of writing state to files that get lost when context compacts.

### 9 — Operational Learning
Tool failures, recovery workflows, and successful operational patterns are captured automatically on error. A review queue accumulates candidates with recurrence scoring — one-time failures don't surface, repeated patterns do. The agent proposes promotions. The operator approves. Promoted patterns persist as permanent retrievable guidance for all future sessions.

### 10 — Reflection
LLM-powered generation of compressed, high-signal memories. Raw conversation → synthesized insight. The reflection pass produces the same contextual information in a denser, higher-value format. High-signal reflections are prioritized in prompt composition over verbatim history.

Verbatim history is retained and accessible; reflections are prioritized for composition, not replacements. When verbatim and reflection conflict, verbatim is the authoritative source. Reflections can be lossy or subtly distorted — they are optimization artifacts, not ground truth.

### 11 — Complete Authority Over Prompt Composition
HyperMem owns the prompt. Budget dynamically scales to the provider + model's context window. Composition protects the system prompt, attaches facts, knowledge, high-signal memories, keystone history, topic threads, and recent verbatim turns — each in priority order within the remaining budget. The operator gets the best possible prompt the model can receive, automatically, every turn.

On authority and overrides: operators can inject content into specific composition slots via configuration. The system prompt slot is always operator-controlled. HyperMem manages all other slots. Agents influence what goes into memory (proposals, checkpoints, ingestion) — HyperMem controls what reaches the prompt. These are separate concerns. No runtime override of HyperMem's slot assembly is possible without explicit operator configuration.

### 12 — Proactive Reindexing
The indexing system monitors its own effectiveness. Recall quality metrics accumulate. When signal degrades, HyperMem detects it and proposes the appropriate response — agent-proposed, operator-approved, applied without downtime.

Two distinct degradation signals require different responses:
- **Embedding staleness:** The embedding model has been updated or swapped, existing vectors are in a stale space, and KNN recall has degraded. Response: reindex affected collections against the current model.
- **Content staleness:** Content exists in the index but is no longer queried — not because of embedding drift, but because it's no longer relevant. Response: decay-based archival (see Goal 12a), not reindexing.

Conflating these produces wrong responses: reindexing stale content doesn't improve recall quality, and archiving content with good embeddings wastes a working index.

### 12a — Memory Lifecycle & Unlearning
Knowledge accumulation without garbage collection becomes noise. HyperMem needs a clear philosophy for forgetting:
- **Scoped wipe:** An operator can request removal of a specific project, topic, or agent's memory — and HyperMem executes it cleanly across all layers (facts, episodes, vectors, library).
- **Decay-based archival:** Low-signal memories age out automatically based on configurable half-life per type (decisions longer, acknowledgments shorter). Archived memories are queryable but not injected.
- **Operator-initiated forget:** Explicit `forget(query)` that marks matching memories as archived with provenance — not silent deletion, but deliberate removal that can be audited.
After six months of fleet operation, an agent's memory should be *more* accurate, not just *larger*.

### 13 — Multi-Agent Memory Architecture
Each agent has private memory channels for its own context and identity continuity. Agents don't drift in topic or identity because their working memory is scoped correctly. Shared knowledge is promoted to the fleet layer (L4) when it has cross-agent value. Agents can query each other's promoted knowledge without leaking private context.

### 14 — Sessionless Design
An agent's context is not locked to a single channel or conversation surface. Topics are portable — the context for "product A development" travels with the agent regardless of which channel the conversation is happening in. Cross-channel topic continuity enables agentic behavior that doesn't reset every time the surface changes.

### 15 — Deep Integration With Native OpenClaw Features
HyperMem ships as a `contextEngine` plugin with `ownsCompaction: true`. This is the canonical integration contract with OpenClaw (ContextEngine interface, `registerContextEngine()`, lifecycle methods: `bootstrap`, `ingest`, `assemble`, `compact`, `afterTurn`). HyperMem owns the `contextEngine` slot — the runtime's legacy compaction is bypassed entirely.

Phase 6 maps to specific lifecycle deepening: richer `assemble()` slot composition, `afterTurn()` background indexer integration, TaskFlow registration for long-running ops. As OpenClaw adds features (task management, session routing, new plugin hooks), HyperMem integrates rather than bypasses. Where native features have ceilings, HyperMem pushes past them with richer data backing.

Acceptance criteria for Phase 6: all five lifecycle hooks exercised with full fidelity, TaskFlow-visible background ops, and no runtime-managed context remaining outside HyperMem's assembly.

### 16 — RBAC / Content Access Control
Data is classified at write time. Access is scoped to intended operators, agents, or groups. Sensitive fleet knowledge is not visible to all agents by default. Org-level, agent-level, and operator-level visibility tiers. Enforcement at the retrieval layer — not just at the application layer.

### 17 — Operational Observability
Operators can see what HyperMem is doing. The indexer runs in the background, the compositor assembles prompts silently, and proactive passes delete content — if any of these go wrong, the failure mode is degraded agent behavior with no signal. That's not acceptable for production infrastructure.

At minimum: compositor budget breakdown per turn (how tokens were allocated across slots), indexer health metrics (facts/episodes extracted per tick, error rates, queue depth), proactive pass audit log (what was deleted or decayed and why), and vector store health (index coverage, embedding freshness). Surfaced through ClawDash and queryable via API.

*Note: Message provenance verification (HMAC signing) is a transport concern, not a memory concern. It belongs in ClawDispatch or OpenClaw's messaging core. HyperMem can store and surface provenance metadata for messages that arrive pre-signed, but it does not own the signing/verification infrastructure.*

*Note on ContextEngine integration: The plugin registration with `ownsCompaction: true` was established in Phase 1/2. Phase 6 is not "figure out OpenClaw integration" — it is deepening an already-locked integration contract. The sequencing risk of building Phases 3–5 on an unstable interface does not apply: the ContextEngine slot is claimed and the lifecycle hooks are operational.*

---

## Packaging Goals

### P1 — Agent-Led Installation
The install experience is guided by an agent. At setup time, users adapt HyperMem to their use case — single-operator personal assistant, multi-agent fleet, or standalone product augmentation. Not everyone needs the fleet architecture. The installer configures the right profile. No forced conformance to PsiClawOps-specific conventions.

### P2 — Public Distribution Ready
Proprietary references removed. Hardcoded org/fleet details generalized or moved to config. The codebase reads as a clean open-source product, not an internal tool that got published.

### P3 — Product README
Tells the story. What problem does HyperMem solve? Why is the architecture the right answer? What does it feel like to use it? Benchmarks. Quick start. API surface. Positioned for an operator who has never heard of PsiClawOps.

### P4 — Product Website
A page on the PsiClawOps site dedicated to HyperMem. Narrative-first — the problem, the solution, the differentiation. Benchmarks presented visually. Compelling enough that an operator links a colleague to it. Supports the README story with richer formatting and demo artifacts.

### P6 — Migration Story
Operators coming from memory-core (OpenClaw's built-in), Zep, or Mem0 have existing memory data. If HyperMem can't ingest from those systems, adoption requires starting from scratch — a significant barrier. Brain transfer (Goal 7) covers fleet-to-fleet HyperMem transfers; this covers migration from other products. Minimum: import from memory-core file format. Stretch: Zep/Mem0 JSON export ingestion.

### P7 — Schema Versioning & Migration
HyperMem ships as an OpenClaw plugin with a versioned SQLite schema. When HyperMem updates its schema, operators with existing `library.db` files need a safe migration path. Schema migration strategy is load-bearing infrastructure: automatic migration on startup with rollback on failure, `schemaVersion` in all state files, and documented upgrade path between major versions.

### P5 — Industry Benchmark Positioning
Do not fight Zep, Mem0, or LangMem on retrieval benchmarks alone — those are RAG-optimized retrieval engines optimized for single-query recall. HyperMem is a prompt composition engine. Fighting on their turf hides the actual differentiation.

The benchmark that matters: **Context Drift over N turns.** Show a standard agent losing early decisions after 3 compactions vs HyperMem retaining them because composition draws from structured L4 facts rather than a degraded transcript. Run at 25, 50, and 100 turns. Measure: instruction retention, decision recall, identity coherence.

Architectural peer comparison: MemGPT/OpenMemory is the closest peer (both bypass standard sliding-window compaction with hierarchical memory). Position HyperMem as an **Agent OS Memory Subsystem** — not a RAG API, not a vector database wrapper, but the memory layer of an agent operating system.

Also benchmark the embedding layer (nomic-embed-text domain recall vs alternatives) and composition latency at scale — these are supporting evidence, not the headline.

---

## What "Done" Looks Like

HyperMem is done when:

- A cold-start agent picks up exactly where the last session left off — active work, recent decisions, relevant domain knowledge — without being briefed.
- A cross-agent query ("what did Chisel decide about X?") returns the actual decision with provenance.
- An operator deploys HyperMem for the first time in under 30 minutes, guided by an agent.
- A brain transfer package (exported knowledge corpus) can be loaded by a different operator's agent and immediately improves their context quality.
- Repeated tool failures surface as reviewed patterns, not silent history.
- The npm package ships with a clean public API, zero proprietary references, and benchmark numbers the community can verify.

---

## Architecture Bets

These decisions are load-bearing. Changing them is a large undertaking.

| Bet | Rationale |
|---|---|
| **Four-layer store (Redis → Messages SQLite → Vectors SQLite → Library SQLite)** | Each layer optimized for its access pattern. Hot reads, durable history, semantic recall, structured knowledge — each at the right speed/durability tradeoff. |
| **Compositor owns prompt assembly** | Runtime calls HyperMem. HyperMem builds the prompt. Full budget control, slot ordering, and quality gates live here — not in the runtime. |
| **Local embeddings (nomic-embed-text)** | Benchmarked against alternatives. Domain recall wins 8-1. 40ms cold / 0.02ms cached with LRU. No API cost, no latency variance, no privacy risk. |
| **SQLite as the durable layer** | No external DB dependency. FTS5 built in. sqlite-vec for KNN. node:sqlite in Node 22 stdlib. Scales to fleet size without Postgres operational overhead. |
| **Plugin model for OpenClaw integration** | HyperMem is not a patch to OpenClaw internals. Drop-in context engine via plugin API. OpenClaw upgrades don't break HyperMem. |
| **ownsCompaction: true** | HyperMem bypasses the runtime's lossy summarization compaction entirely. Compaction means structured tiering, not information destruction. **Fallback contract:** If OpenClaw's compact lifecycle hook doesn't fire as expected, HyperMem degrades gracefully — it does not hang or corrupt state. The compositor continues to assemble from whatever is in storage; the next successful `afterTurn` tick cleans up. The `ownsCompaction` bet depends on a relatively new interface (ContextEngine, March 2026); if the interface evolves, HyperMem tracks it explicitly rather than silently breaking. |

---

## Roadmap Horizon

| Phase | Status | Theme |
|---|---|---|
| Phase 1 — Stabilization | ✅ Complete | Foundation: CI, types, durability, classification, indexing quality |
| Phase 2 — Context Quality | ✅ Complete | Smarter context: keystones, classifiers, proactive cleanup, vector store live |
| Phase 3 — Checkpoints + Reflection | 🔲 Next | Durable work state, LLM reflection passes, operational learning queue |
| Phase 4 — Topic Inference | 🔲 Planned | Cross-turn thread tracking: automatic topic detection, sessionless portability — built on top of durable checkpoints |
| Phase 5 — Multi-Agent + RBAC | 🔲 Planned | Cross-agent queries, visibility tiers, message validation, brain transfer |
| Phase 6 — Platform Integration | 🔲 Future | Deepen established ContextEngine integration: full lifecycle fidelity, TaskFlow ops, ingestion APIs, export pipeline |
| Phase 7 — Publish | 🔲 Future | Agent-led installer, public README, benchmark suite, product page, npm release |

---

## What HyperMem Does Not Do

- **Not a RAG system for arbitrary external corpora.** It's a memory system for agent conversations and structured knowledge. Bulk document indexing is a specific ingestion path, not the core use case.
- **Not a governance layer.** POLICY.md and council governance own policy decisions. HyperMem enforces visibility scoping; it doesn't make policy.
- **Not a replacement for human judgment.** It surfaces context. The agent decides what to do with it.
- **Not a conversation logger.** HyperMem stores message history as a means to an end — context composition — not as an archival system. It retains the conversation data it needs to compose high-quality prompts: recent history in full fidelity, older history tiered and selectively retained by signal value. What it does not do is guarantee full-fidelity preservation of every message for audit, compliance, or playback purposes. If you need complete transcript preservation for legal or compliance reasons, that's a different product. This distinction matters operationally: HyperMem will compact, decay, and delete messages as part of normal lifecycle management. Operators who expect total preservation will fight every cleanup operation.

- **Not a real-time streaming memory system.** HyperMem is optimized for turn-level and session-level persistence. It is not designed for sub-turn event streaming or high-frequency event ingestion. Systems requiring <100ms write latency for continuous high-frequency events should not use HyperMem as their primary store. This is an architectural constraint, not a roadmap gap.

---

*HyperMem is infrastructure. Nobody notices it when it's working. Everyone notices when it isn't. Build it to be invisible.*
