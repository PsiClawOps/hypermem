# HyperMem Architecture

_Agent-centric memory that outlives sessions._

---

## Memory Layers

```
L1  Redis (Hot)              Active session working memory
     │                       Slots: system, messages, facts, context
     │                       Sub-millisecond reads, evicts on session end
     │
L2  Agent Messages DB        Raw conversation history (per agent)
     │  messages.db           Write-heavy, rotatable, private
     │  messages_YYYYQN.db    Rotated archives, read-only
     │
L3  Agent Vectors DB         Semantic search index (per agent)
     │  vectors.db            Indexes content from L2 + L4
     │                        Fully reconstructable — it's an index, not source of truth
     │
L4  Library DB               Fleet-wide structured knowledge
        library.db            Single file, write-light, backed up
```

## Storage Files

### Per Agent (`~/.openclaw/hypermem/agents/{agentId}/`)

| File | Purpose | Write frequency | Durability |
|---|---|---|---|
| `messages.db` | Active message log + conversations | High (every message) | Rotatable — old data is disposable |
| `messages_YYYYQN.db` | Rotated message archives | None (read-only) | Archival — delete when no longer needed |
| `vectors.db` | Vector index (sqlite-vec) | Moderate (indexing cycles) | Reconstructable — rebuild from L2+L4 |

### Fleet-wide (`~/.openclaw/hypermem/`)

| File | Purpose | Write frequency | Durability |
|---|---|---|---|
| `library.db` | Structured fleet knowledge | Low (fact extraction, registry updates) | **Critical — backup target** |

## Library Collections

### 1. Library Entries (versioned knowledge)
Product docs, research, specs, reference material. Immutable once written — new versions
supersede old ones.

- Domain + key = unique lookup
- Version auto-increments per key
- `superseded_by` links to newer version
- Source tracking (doc path, URL, manual entry)

### 2. Facts (agent-learned truths)
Things agents learn about the world. Verifiable, concrete.

- Tagged by agent_id (who learned it), domain, confidence
- Source tracking: conversation, observation, inference
- Visibility: private | org | council | fleet
- Identity-domain facts always private (hardcoded)

### 3. Preferences (behavioral patterns)
Observed patterns about people, systems, workflows.

- Subject + domain + key = unique lookup
- Separate from facts: different confidence model, different update rules
- "ragesaq prefers stability" is a preference, not a fact

### 4. Fleet Registry (PsiClawOps state)
Agent roster, org structure, roles, capabilities.

- fleet_agents: id, tier, org, domains, session keys, status
- fleet_orgs: id, name, lead, mission

### 5. System Registry (machine state)
Server config, service status, operational flags.

- system_state: category + key = current value (JSON)
- system_events: change log with old/new values
- Optional TTL for transient state

### 6. Session Registry
Session lifecycle tracking across the fleet.

- session_registry: who, when, channel, status, summary
- session_events: lifecycle events with payloads
- Decision and fact counters

### 7. Episodes (significant events)
Fleet-wide notable events — incidents, decisions, milestones.

- Agent-attributed, visibility-scoped
- Linked to sessions where they occurred

## Prompt Composition Flow

```
User message arrives
    │
    ├─ L1 Redis: load active session slots
    │   (system prompt, recent messages, working facts)
    │
    ├─ L2 messages.db: recent conversation history
    │   (continuity — "what were we just talking about?")
    │
    ├─ L3 vectors.db: semantic search on user message
    │   (relevance — "what from ALL history relates to this?")
    │   Searches across current + rotated message DBs + library content
    │
    ├─ L4 library.db: durable context
    │   (facts, preferences, fleet state relevant to this agent)
    │
    └─ Compositor assembles prompt
        Priority: L1 > L2 > L3/L4 (recency > relevance > knowledge)
        Budget: fits within model context window
```

## Message Rotation

When `messages.db` exceeds threshold (100MB or quarterly):

1. Checkpoint WAL
2. Rename `messages.db` → `messages_YYYYQN.db`
3. Create fresh `messages.db` with schema
4. Old file becomes read-only

### Cross-archive search

- **Semantic search**: vectors.db indexes across ALL message files. 
  `vec_index_map.source_db` tracks which rotated file each vector came from.
- **Full text retrieval**: ATTACH rotated DB, pull full message by ID.
  SQLite supports 10+ attached databases (configurable to 125).
- **FTS**: Only on current messages.db. Historical keyword search 
  goes through semantic search (better for fuzzy recall anyway).

## Redis Layer

Redis mirrors hot reads from all layers:

```
hm:{prefix}:session:{key}:*     ← L1 session slots
hm:{prefix}:facts:{agent}       ← recent facts from L4
hm:{prefix}:prefs:{subject}     ← preferences from L4
hm:{prefix}:fleet:{agentId}     ← fleet registry from L4
hm:{prefix}:system:{cat}:{key}  ← system state from L4
```

Writes: dual-write to SQLite (durable) + Redis (hot cache).
Redis is disposable — cold start rebuilds from SQLite.

## Failure Modes

| Component | Impact | Recovery |
|---|---|---|
| Redis dies | Lose hot session state | Rehydrate from messages.db + library.db |
| messages.db corrupts | Lose recent conversation | Redis has active session; library has extracted facts |
| vectors.db corrupts | Lose search index | Delete and re-run `indexAgent()` |
| library.db corrupts | **Lose fleet knowledge** | Restore from backup — this is the crown jewel |

## Access Control

- Raw messages: always private to the owning agent
- Facts/knowledge: visibility field (private | org | council | fleet)
- Identity-domain content: hardcoded private, never cross-agent
- Session-scoped facts: excluded from cross-agent queries
- Council seats: can read council-visible data from any agent
- Directors: can read council-visible data from their org lead
- Org members: can read org-visible data from each other

## Schema Versioning

- Agent Messages DB: independent version, migrates on open
- Agent Vectors DB: independent version, can be deleted and recreated
- Library DB: fleet-wide version, migrates on first open

## Technology Stack

- **SQLite**: node:sqlite (Node 22+ built-in), WAL mode, synchronous=NORMAL
- **Redis**: ioredis, namespaced keys, pub/sub for invalidation (future)
- **Vector search**: sqlite-vec v0.1.9, vec0 virtual tables
- **Embeddings**: Ollama nomic-embed-text (768d), local only
- **Runtime**: Node.js v22.22.1, ESM, TypeScript
