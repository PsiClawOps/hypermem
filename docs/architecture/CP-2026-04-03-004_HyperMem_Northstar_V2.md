# Proposal: HyperMem Product Northstar

_Spec: The architectural and product vision for HyperMem, the intelligence and memory substrate of the OpenClaw ecosystem._

---

## Status
- **ID:** CP-2026-04-03-004
- **Author:** Compass
- **Date:** 2026-04-03
- **State:** Ratified — V2
- **Target Phase:** Implementation (Forge)
- **Dependencies:** Artifact Storage Standard (CP-2026-04-03-003)

---

## Problem: The Context Accumulation Trap

Current LLM agent architectures rely on **accumulated context**. As a session progresses, transcripts grow. This leads to three fundamental failures:
1. **Context Drift:** As the transcript grows, the agent's attention mechanism degrades. Important facts at the top of the prompt are drowned out by recent, lower-value conversational turns.
2. **Siloed Sessions:** Knowledge gained in Session A is entirely invisible to Session B unless manually copied over.
3. **Compaction Loss:** To prevent context overflow, transcripts are summarized and compacted, inevitably destroying high-resolution details and nuances.

**HyperMem takes a different approach: the agent's context is composed, not accumulated.**

Every turn, HyperMem reconstructs the optimal context window by retrieving only the exact facts, rules, and episodic memories relevant to the current user prompt, injecting them via a Compositor before the LLM generates a response.

---

## The L1-L4 Cognitive Architecture

HyperMem maps to the CoALA (Cognitive Architectures for Language Agents) taxonomy using a four-layer model:

| Layer | Type | HyperMem Concept | Description |
|---|---|---|---|
| **L1** | Working Memory | **Working Context** | The active token window (prompt + Compositor payload + recent tail) |
| **L2/L3** | Procedural Memory | **Workspace Files** | Agent instructions, skills, and tools (e.g., SOUL.md, TOOLS.md, SKILL.md) |
| **L4** | Semantic Memory | **Engrams (Facts)** | Atomic, deduplicated, atemporal truths (stored in SQLite `facts` table) |
| **L4** | Episodic Memory | **Episodes** | Sequential, time-bound records of events (stored in SQLite `episodes` table) |

*Note on terminology:* Internal specs and schemas use **L4 Facts** and **L4 Episodes**. External product documentation uses **Engrams** (for Facts) and **Episodes**.

## The Core Primitives: Engrams and Episodes

HyperMem organizes L4 memory into a bipartite graph of two distinct primitives:

### 1. Engrams (Facts / Knowledge)
- **Definition:** Atomic, deduplicated, immutable (by convention) statements of truth or semantic knowledge.
- **Nature:** Atemporal. An Engram represents *what* is true, independent of *when* it was learned.
- **Examples:** User preferences ("ragesaq prefers CLI over GUI"), system rules ("Never use em dashes"), architectural facts ("HyperMem uses SQLite").
- **Creation:** Automated extraction via ingest pipeline or manual write.
- **Storage:** The `facts` table.

### 2. Episodes (Events / Temporal Logs)
- **Definition:** Sequential, time-bound records of actions, conversations, or system events.
- **Nature:** Temporal. An Episode represents *what happened*, *when* it happened, and the *context* of the event.
- **Examples:** A specific CLI command execution, a deliberation round in the council chamber, an error log.
- **Storage:** The `episodes` table.

### The Relationship & Provenance
Episodes generate Engrams. When an Episode contains a durable truth, that truth is extracted and stored as an Engram. The Engram maintains a provenance link back to the Episode that generated it. 

*Compaction Policy Note:* Compaction of Episodes may orphan Engrams. Orphaned Engrams retain their content but lose provenance traceability. The compaction policy should preserve Episodes that are the sole provenance sources for active Engrams.

---

## The Retrieval Architecture (The Compositor)

Memory is useless if the agent has to explicitly ask for it. HyperMem relies on **Proactive Retrieval**.

### 1. The Salience & Activation Algorithm
To prevent the agent from drowning in equally weighted facts, HyperMem uses an Activation/Salience algorithm:
- **Baseline Weight:** When an Engram is created, it receives a baseline salience weight.
- **Activation Bump (Current):** Every time the Compositor retrieves an Engram, it receives a frequency bump (weight increases), ranking alongside KNN semantic similarity scores.
- **Decay (Planned for V2 Engineering):** A time-based or access-based decay function for un-retrieved Engrams is design TBD. Do not claim "self-organizing memory" until the decay function is implemented and tuned.

### 2. Continuity Guarantees (The Context Assembly Contract)
To ensure the agent never loses the immediate thread while retrieving older memories, the Compositor enforces strict continuity bounds. The context window ($C_{total}$) is assembled using an 8-level priority hierarchy. 

**Architecturally Guaranteed:**
1. **Hard Invariants (Tier 1):** Authored system constraints and core identity rules (L2). Always injected first.
2. **The Recent Tail ($T_{recent}$):** The most recent unbroken sequence of raw conversational turns.

**Best-Effort variants (dropped first on budget overflow):**
3. **Soft Invariants (Tier 2):** Contextual guidelines injected via longest-prefix truncation up to a bounded token limit.
4. **Retrieved Variants (Engrams/Episodes):** The remaining token budget is filled by Hybrid Search output.

*Goal 15 Continuity Guarantee:* An agent's **memory substrate** (L4 Facts/Episodes) persists across sessions, surviving restarts, compactions, and model switches. **Procedural identity** (workspace files like SOUL.md, TOOLS.md) requires separate backup and is not L4-stored. Memory retrieval quality is dependent on embedding model consistency (`nomic-embed-text`).

### 3. The Retrieval Pipeline
1. **Trigger Matching:** The user's prompt is scanned against a Trigger Registry.
2. **Hybrid Search:** If triggered, HyperMem executes a hybrid search:
   - **FTS5 (Keyword):** Exact matches on terminology.
   - **KNN (Semantic):** Vector similarity for conceptual matches.
3. **Composition:** The retrieval engine pulls the top *K* relevant Engrams and highly relevant recent Episodes (up to the $T_{recent}$ and Tier 2 budget caps).
4. **Injection:** The `before_agent_reply` hook injects this payload into the active context window *before* model inference begins.

*Trigger Miss Fallback:* If no trigger fires in the Trigger Registry, the system must execute a fallback semantic-only (KNN) search to ensure relevant memory is not silently omitted. The Trigger Registry is a managed component and changes must be auditable.

### 4. Retrieval Access Control (Scope Model)
The Compositor must enforce strict access boundaries during proactive retrieval to prevent information disclosure:
- **Default (Agent Scope):** Engrams scoped to a specific `agent_id` are only retrievable by that agent's session.
- **Explicit (Org Scope):** Engrams with `scope:org` are fleet-readable and can be retrieved by any agent. Write access to org-scoped Engrams is gated per the Artifact Storage Standard.
- **Cross-Agent Retrieval:** Requires explicit scope elevation; the Compositor will never silently inject Agent A's private Engrams into Agent B's session.

---

## Compositor Tradeoffs and Failure Modes

Composed context is superior to accumulated context only when retrieval succeeds. The system must monitor for these known failure modes:
1. **Silent Omission:** The Compositor fails to retrieve a relevant Engram (due to low salience or semantic gaps). The agent has no signal that it is missing context.
2. **Stale Injection:** A superseded Engram is retrieved because its salience has not yet decayed.
3. **Scope Leak:** Cross-boundary retrieval failure (mitigated by the Retrieval Access Control model).
4. **Noise Injection:** Irrelevant Engrams are retrieved because a trigger was too broad, consuming token budget.

---

## Alignment with the ClawDash Workspace

HyperMem is not a standalone app; it is the invisible substrate that powers ClawDash and ClawCanvas.

- **For ClawDash (The Environment):** HyperMem ensures that the environment "remembers" the user across all blades and terminals.
- **For ClawCanvas (The Workspace):** HyperMem powers the spatial intelligence. When an agent looks at an artifact on the Canvas, HyperMem instantly retrieves the Engrams related to that artifact's history and constraints.
- **For ClawCouncil (Governance):** Governance artifacts (council proposals, decision records, post-execution reviews) stored in HyperMem follow the HyperMem Artifact Storage Standard (CP-2026-04-03-003), ensuring consistent metadata, naming, and retrieval across the fleet.

