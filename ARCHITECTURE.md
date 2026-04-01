# HyperMem Architecture

_Agent-centric memory that outlives sessions._

---

## Memory Layers

```
L1  Redis (Hot)              Active session working memory
     │                       Slots: system, identity, messages, facts, context
     │                       Sub-millisecond reads, evicts on session end
     │                       Fleet cache: agent profiles, fleet summary
     │
L2  Agent Messages DB        Raw conversation history (per agent)
     │  messages.db           Write-heavy, rotatable (100MB / 90 days)
     │  messages_YYYYQN.db    Rotated archives, read-only
     │
L3  Agent Vectors DB         Semantic search index (per agent)
     │  vectors.db            Index rebuilt from L2+L4 (reconstructable)
     │                        KNN search via sqlite-vec (nomic-embed-text, 768d)
     │                        Rate-limited embedding via token bucket
     │
L4  Library DB               Fleet-wide structured knowledge
        library.db            Facts, knowledge, preferences, fleet registry
                              Episodes, topics, work items, system state
                              Desired state, agent capabilities
                              Knowledge graph (DAG links between entities)
```

## Database Schema

### messages.db (per agent, schema v3)
- `agent_meta` — agent metadata
- `conversations` — session tracking
- `messages` — raw message log (text, tool calls, tool results)
- `schema_version` — migration tracking
- **Rotation:** When size > 100MB or age > 90 days, renamed to `messages_YYYYQN.db`
- **WAL mode** with checkpoint on rotation

### vectors.db (per agent)
- `vec_facts` — 768-dimensional vectors for facts (sqlite-vec virtual table)
- `vec_knowledge` — vectors for knowledge entries
- `vec_episodes` — vectors for episode descriptions
- `vec_sessions` — vectors for session summaries
- `vec_index_map` — tracks what's been indexed (source_table, source_id, source_db)
- `embedding_cache` — avoids redundant Ollama API calls

### library.db (shared, schema v5)
- `facts` — verifiable claims with confidence, domain, expiry, supersedes chains
- `knowledge` — domain/key/value structured data
- `knowledge_links` — DAG edges between entities (fact↔fact, fact↔knowledge, etc.)
- `episodes` — significant events with impact and participants
- `topics` — cross-session thread tracking
- `preferences` — operator/user behavioral patterns
- `fleet_agents` — agent registry with tier, org, capabilities (JSON)
- `fleet_orgs` — organizational structure
- `agent_capabilities` — queryable skills, tools, MCP servers per agent
- `agent_desired_state` — intended configuration vs. actual (drift detection)
- `agent_config_events` — change audit trail
- `system_registry` — service state tracking
- `system_events` — service lifecycle events
- `work_items` — work queue entries with FTS5
- `session_registry` — session lifecycle tracking

## Compositor

Assembles LLM prompts from all four layers with token budgeting:

```
User message arrives
  │
  ├── L1 Redis: system prompt, identity, cached slots
  ├── L2 Messages: recent conversation history (budget-truncated)
  ├── L3 Vectors: KNN semantic recall on user's latest message
  │     └── Related facts/knowledge/episodes with relevance scores
  ├── L4 Library: structured knowledge injection
  │     ├── Facts (30% budget cap): active, non-expired, sorted by confidence
  │     ├── Knowledge (20%): grouped by domain, top 15 entries
  │     └── Preferences (10%): behavioral patterns, grouped by subject
  └── Cross-session (20%): context from related sessions
```

Each slot gets a proportional budget cap. Smart truncation at line boundaries.
Multi-provider output: Anthropic and OpenAI message formats.

## Fleet Cache (Redis Hot Layer)

```
fleet:agent:{id}   — Composite profile: registry + capabilities + desired state
fleet:summary      — Fleet-wide stats: agent count, drift count, tier breakdown
```

- **Cache-aside** on reads: Redis first, SQLite fallback, warm on miss
- **Write-through invalidation** on fleet mutations
- **Hydration** on gateway startup: bulk-populate from library.db
- TTL: agent profiles 10min, summary 2min

## Knowledge Graph

DAG traversal over `knowledge_links` for relationship discovery:

- **Entity types:** fact, knowledge, topic, episode, agent, preference
- **Link types:** supports, contradicts, supersedes, references, derived_from, depends_on, extends, covers, related, authored_by
- **BFS traversal:** configurable depth, result limit, direction filter, type filter
- **Shortest path:** between any two entities
- **Analytics:** most-connected entities, link count by type

## Rate Limiter

Token-bucket rate limiter for embedding API calls:

- Burst capacity with steady refill (default: 5/s, burst 10)
- Priority queue: high (user-facing recall) > normal > low (batch indexing)
- Reserved tokens for high-priority requests
- `createRateLimitedEmbedder()` wraps any embedding function

## Hook Integration

`~/.openclaw/hooks/hypermem-core/handler.js` — OpenClaw gateway hook:

```
gateway:startup   → Init HyperMem, auto-rotate DBs, hydrate fleet cache
agent:bootstrap   → Warm session (history, facts, profile → Redis)
message:received  → Record user message to SQLite + Redis
message:sent      → Record assistant message to SQLite + Redis
```

Handler receives `InternalHookEvent` objects, dispatches on `${type}:${action}`.

## Module Map (22 files, 8,475 lines)

| Module | Lines | Layer | Purpose |
|---|---|---|---|
| `index.ts` | ~1,100 | All | Facade — all public API |
| `compositor.ts` | ~500 | L1-L4 | Prompt assembly + token budgeting |
| `redis.ts` | ~400 | L1 | Redis operations + fleet cache |
| `message-store.ts` | ~400 | L2 | Conversation recording + querying |
| `vector-store.ts` | ~600 | L3 | Semantic search + embedding |
| `fact-store.ts` | ~300 | L4 | Facts with confidence + expiry |
| `knowledge-store.ts` | ~200 | L4 | Domain/key/value structured data |
| `knowledge-graph.ts` | ~400 | L4 | DAG traversal + shortest path |
| `preference-store.ts` | ~150 | L4 | Operator behavioral patterns |
| `episode-store.ts` | ~200 | L4 | Significant event tracking |
| `topic-store.ts` | ~200 | L4 | Cross-session thread tracking |
| `fleet-store.ts` | ~400 | L4 | Fleet registry + capabilities |
| `desired-state-store.ts` | ~350 | L4 | Config drift detection |
| `system-store.ts` | ~250 | L4 | Service state tracking |
| `work-store.ts` | ~250 | L4 | Work queue + FTS5 |
| `cross-agent.ts` | ~200 | L2-L4 | Cross-agent knowledge queries |
| `rate-limiter.ts` | ~230 | L3 | Token-bucket for embedding API |
| `provider-translator.ts` | ~250 | - | Neutral ↔ provider format conversion |
| `db.ts` | ~350 | - | Database manager + rotation |
| `schema.ts` | ~100 | L2 | Messages schema + migrations |
| `library-schema.ts` | ~400 | L4 | Library schema v5 + migrations |
| `types.ts` | ~250 | - | Shared type definitions |

## Test Coverage (297 tests, 10 suites)

| Suite | Tests | Coverage |
|---|---|---|
| smoke | 8 | End-to-end create/write/read/close |
| redis-integration | 24 | Redis operations, slots, history |
| cross-agent | 20 | Cross-agent queries, fleet search |
| vector-search | 33 | Embedding, KNN, batch indexing |
| library | 71 | All L4 collections (facts→desired state) |
| compositor | 25 | Four-layer composition, budget, providers |
| fleet-cache | 32 | Redis fleet cache, hydration, cache-aside |
| rotation | 29 | DB rotation, auto-rotate, collision handling |
| knowledge-graph | 33 | DAG traversal, shortest path, analytics |
| rate-limiter | 22 | Token bucket, priority, timeout, embedder |

## Dependencies

- `node:sqlite` (Node 22+ built-in) — zero-dependency SQLite
- `ioredis` — Redis client
- `sqlite-vec` — optional, vector search extension
- Ollama (localhost:11434) — optional, embedding generation
