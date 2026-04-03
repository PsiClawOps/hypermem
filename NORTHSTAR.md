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

---

## Core Goals

### 1 — Full Session Continuity
New sessions don't feel like new sessions. Compactions don't impact production quality. Memories feel always available. Recall speed never impedes functionality.

This is the foundational promise. If we hit this mark, it "just works, always." The operator doesn't think about memory — it's invisible infrastructure.

### 2 — Rich Memory Capability
Specific search, semantic search, and relational traversal. Agents find what they're looking for — not close approximations. Indexing schemas are designed around the access patterns agents actually use: FTS5 for exact recall, KNN for semantic similarity, graph traversal for related concepts.

### 3 — Ease of Installation
Sophisticated enough to deliver continuity and recall. Simple enough that a solo operator can deploy it in a session. The right balance means: no external database, no cloud dependency, no ops burden on day one. Grows with usage.

### 4 — Maximum Automation
As automatic as possible. Agent-led when it isn't. Operators do not learn to manage a memory subsystem. Ingestion, classification, indexing, cleanup, checkpoint creation, and compaction happen without operator intervention. When agent input is needed, the agent drives — not a settings panel.

### 5 — Rich Integration Platform
HyperMem is the one stop shop. Deep integration with ClawDispatch, SDLC, WoW, and future PsiClawOps products. Extensible hooks so any product can write to or read from HyperMem's layers. If another system needs agent memory, it integrates with HyperMem rather than building its own.

### 6 — Data Ingestion
Any kind of data, routed to its best-fit layer. Documents → doc chunks (L4). Facts → facts collection (L4). Conversations → messages DB (L2) + episodes (L4). Raw files → seeder pipeline. Agents are guided on which layer fits their data — not left to figure it out. Ingest from URL, file, API, or conversation.

### 7 — Data Export & Brain Transfer
Agents send rich data to other agents. Within a platform: agents share pointers to specific memories. Across platforms: export to GitHub Gist, structured JSON, or any dissemination format so knowledge can transfer between operators and fleets. Brain transfer — the ability to package and share a trained knowledge corpus.

### 8 — Checkpoints
Agents checkpoint frequently. Work details survive context bloat, session boundaries, server restarts. HyperMem is the durable substrate — not files. Agents are encouraged to use checkpoints as the default persistence mechanism, replacing the pattern of writing state to workspace files.

### 9 — Operational Learning
Tool failures, recovery workflows, and successful operational patterns are captured automatically on error. A review queue accumulates candidates with recurrence scoring — one-time failures don't surface, repeated patterns do. The agent proposes promotions. The operator approves. Promoted patterns persist as permanent retrievable guidance for all future sessions.

### 10 — Reflection
LLM-powered generation of compressed, high-signal memories. Raw conversation → synthesized insight. The reflection pass produces the same contextual information in a denser, higher-value format. High-signal reflections are prioritized in prompt composition over verbatim history.

### 11 — Complete Authority Over Prompt Composition
HyperMem owns the prompt. Budget dynamically scales to the provider + model's context window. Composition protects the system prompt, attaches facts, knowledge, high-signal memories, keystone history, topic threads, and recent verbatim turns — each in priority order within the remaining budget. The operator gets the best possible prompt the model can receive, automatically, every turn.

### 12 — Proactive Reindexing
The indexing system monitors its own effectiveness. Recall quality metrics accumulate. When signal degrades — stale embeddings, low-hit queries, schema drift — HyperMem detects it and proposes reindexing. Improvements are agent-proposed, operator-approved, and applied without downtime.

### 13 — Multi-Agent Memory Architecture
Each agent has private memory channels for its own context and identity continuity. Agents don't drift in topic or identity because their working memory is scoped correctly. Shared knowledge is promoted to the fleet layer (L4) when it has cross-agent value. Agents can query each other's promoted knowledge without leaking private context.

### 14 — Sessionless Design
An agent's context is not locked to a single channel or conversation surface. Topics are portable — the context for "product A development" travels with the agent regardless of which channel the conversation is happening in. Cross-channel topic continuity enables agentic behavior that doesn't reset every time the surface changes.

### 15 — Deep Integration With Native OpenClaw Features
Support all OpenClaw features. Identify enhancement opportunities — task management, sessions, routing, context engines, plugin hooks. As OpenClaw adds features, HyperMem integrates rather than bypasses. Where native features have ceilings, HyperMem pushes past them with richer data backing.

### 16 — RBAC / Content Access Control
Data is classified at write time. Access is scoped to intended operators, agents, or groups. Sensitive fleet knowledge is not visible to all agents by default. Org-level, agent-level, and operator-level visibility tiers. Enforcement at the retrieval layer — not just at the application layer.

### 17 — Message Validation
HMAC or HMAC-equivalent signing for messages, events, and control signals. Provenance is verifiable. Particularly critical for messaging bus and inter-agent control signals — a message claiming to be from Anvil can be validated as actually from Anvil. Foundation for trustworthy multi-agent coordination.

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

### P5 — Industry Benchmark Positioning
Benchmark against established agent memory systems (MemGPT/OpenMemory, Zep, Mem0, LangMem). Use MTEB-adjacent recall benchmarks for the embedding layer. Position HyperMem correctly: not "yet another RAG wrapper," but a structured, production-grade agent memory system with novel prompt composition architecture.

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
| **ownsCompaction: true** | HyperMem bypasses the runtime's lossy summarization compaction entirely. Compaction means structured tiering, not information destruction. |

---

## Roadmap Horizon

| Phase | Status | Theme |
|---|---|---|
| Phase 1 — Stabilization | ✅ Complete | Foundation: CI, types, durability, classification, indexing quality |
| Phase 2 — Context Quality | ✅ Complete | Smarter context: keystones, classifiers, proactive cleanup, vector store live |
| Phase 3 — Topic Inference | 🔲 Next | Cross-turn thread tracking: automatic topic detection, sessionless portability |
| Phase 4 — Checkpoints + Reflection | 🔲 Planned | Durable work state, LLM reflection passes, operational learning queue |
| Phase 5 — Multi-Agent + RBAC | 🔲 Planned | Cross-agent queries, visibility tiers, message validation, brain transfer |
| Phase 6 — Platform Integration | 🔲 Future | Deep OpenClaw native integration, ingestion APIs, export pipeline |
| Phase 7 — Publish | 🔲 Future | Agent-led installer, public README, benchmark suite, product page, npm release |

---

## What HyperMem Does Not Do

- **Not a RAG system for arbitrary external corpora.** It's a memory system for agent conversations and structured knowledge. Bulk document indexing is a specific ingestion path, not the core use case.
- **Not a governance layer.** POLICY.md and council governance own policy decisions. HyperMem enforces visibility scoping; it doesn't make policy.
- **Not a replacement for human judgment.** It surfaces context. The agent decides what to do with it.

---

*HyperMem is infrastructure. Nobody notices it when it's working. Everyone notices when it isn't. Build it to be invisible.*
