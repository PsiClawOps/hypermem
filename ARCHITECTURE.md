# hypermem Architecture

_Agent-centric memory that outlives sessions, backed by SQLite memory databases._

---

## Memory Layers

```
L1  SQLite Cache (Hot)       Active session working memory
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

> Note: some internal method names and telemetry reasons still contain `redis`
> for backward compatibility. The runtime hot layer is SQLite `:memory:` cache,
> not an external Redis service.

## Database Schema

### messages.db (per agent, schema v10)
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

### library.db (shared, schema v19)
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
  ├── L1 Hot cache: system prompt, identity, cached slots
  ├── L2 Messages: recent conversation history (budget-truncated)
  ├── L3 Vectors: KNN semantic recall on user's latest message
  │     └── Related facts/knowledge/episodes with relevance scores
  ├── L4 Library: structured knowledge injection
  │     ├── Facts (up to 30% of remaining budget): active, non-expired, sorted by confidence
  │     ├── Knowledge (up to 20% of remaining): grouped by domain, top 15 entries
  │     └── Preferences (up to 10% of remaining): behavioral patterns, grouped by subject
  └── Cross-session (up to 20% of remaining): context from related sessions
```

Each slot gets a proportional budget cap. Smart truncation at line boundaries.
Multi-provider output: Anthropic and OpenAI message formats.

### Tuning Parameters (TUNE-001–007)

Compositor behavior is tuned via parameters tracked in `tune/TUNING_REGISTRY.md`:

| ID | Parameter | Value | Effect |
|---|---|---|---|
| TUNE-001 | Semantic recall min RRF score | 0.008 | Drops noise results from hybrid search |
| TUNE-002 | Facts confidence floor | 0.5 | Excludes low-confidence facts from injection |
| TUNE-003 | Differentiated fact confidence | 0.60–0.75 by type | Decisions/incidents score higher than config/prefs |
| TUNE-004 | config_change episode significance | 0.5 (was 0.4) | Config changes no longer silently dropped |
| TUNE-005 | Extraction slot guard | suppress on default | No-op when strategy is lightweight/default |
| TUNE-006 | Advisor slot guard | suppress bare seat list | No-op when no domain routes matched |
| TUNE-007 | Identity anchor guard | suppress on default identity | No-op when identity resolves to 'default' |

### Safety Mechanisms

- **Budget safety valve:** Post-assembly check — if estimated tokens exceed budget × 1.05, trims oldest history messages until under budget. System/identity/current prompt are never touched.
- **Compaction fence:** Per-conversation boundary protecting the LLM's recent tail from compaction. Only moves forward (monotone progress). No fence = no compaction (explicit opt-in).
- **Preservation gate:** Nomic-space geometric verification that summaries stay faithful to source content. Centroid alignment + source coverage → combined score (threshold: 0.65).

## Fleet Cache (Hot Cache Layer)

```
fleet:agent:{id}   — Composite profile: registry + capabilities + desired state
fleet:summary      — Fleet-wide stats: agent count, drift count, tier breakdown
```

- **Cache-aside** on reads: hot cache first, SQLite fallback, warm on miss
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

## Cross-Agent Access Control

Visibility-tiered access model for cross-agent knowledge queries:

- **`fleet`** — visible to all agents (default tier)
- **`org`** — visible to agents in the same organizational unit
- **`council`** — visible to council-tier agents and the org lead
- **`private`** — visible only to the owning agent

### Org Registry

`visibilityFilter()` resolves access levels using an `OrgRegistry` — a mapping of agents to tiers, orgs, and capabilities. Currently loaded from a hardcoded `defaultOrgRegistry()` in `cross-agent.ts`.

**Known limitation:** `defaultOrgRegistry()` duplicates fleet structure that lives authoritatively in `fleet_agents` + `fleet_orgs` in library.db. The planned migration is to live-load the registry from library.db on startup, with the hardcoded registry retained only as a cold-start fallback.

### Unknown Agent Fallback (Restrictive Default)

When a target agent is not found in the registry, `visibilityFilter()` applies a **restrictive default**: fleet-only visibility with a logged warning. This is a deliberate safety-side behavior — unknown agents see only fleet-visible data rather than failing the query entirely. The warning surfaces registry gaps for operators to fix.

This means:
- Queries succeed but return a narrowed result set
- New agents provisioned in the DB but not yet in the registry will have reduced cross-agent visibility until registered
- The warning message names the missing agent and suggests adding it to the registry

## Context Engine Plugin

`plugin/src/index.ts` — OpenClaw context engine plugin (`hypercompositor`, fills `contextEngine` slot):

```
gateway:startup     → Init hypermem, auto-rotate DBs, seed fleet registry from workspace identities, hydrate fleet cache
agent:bootstrap     → Warm session (history, facts, profile → hot cache)
context:assemble    → Full four-layer prompt assembly within token budget
agent:afterTurn     → Ingest new messages to SQLite + hot cache, trigger background indexer
```

Registers with `ownsCompaction: true` — runtime skips legacy compaction entirely.

## Memory Plugin

`memory-plugin/src/index.ts` — Lightweight memory provider (`hypermem`, fills `memory` slot):

- Registers `MemoryPluginCapability` with a `MemorySearchManager` backed by HyperMem's hybrid FTS5 + KNN retrieval
- Provides the `memory_search` tool through the official memory slot interface
- Public artifacts provider lists `MEMORY.md` and `memory/*.md` for all configured agents
- Stateless wrapper: lifecycle is owned by the context engine plugin

### Plugin Data Flow

```
                    ┌──────────────────────────────────────────────────┐
                    │      HOT CACHE (SQLite :memory: CacheLayer)       │
                    │                                                  │
                    │  hm:{a}:{s}:history  ── Session archive (250 cap │
                    │    (append-only)        at bootstrap, 1000 soft  │
                    │                         cap ongoing)             │
                    │                                                  │
                    │  hm:{a}:{s}:window   ── Submission buffer        │
                    │    (compositor output)   (120s TTL)              │
                    │                                                  │
                    │  hm:{a}:{s}:cursor   ── Last-sent pointer        │
                    │    (compositor metadata)  (24h TTL)              │
                    │                                                  │
                    │  hm:{a}:{s}:system   ── System prompt slot       │
                    │  hm:{a}:{s}:identity ── Identity slot            │
                    │  hm:{a}:{s}:facts    ── Cached facts slot        │
                    │  hm:{a}:{s}:context  ── Cross-session slot       │
                    └──────────────────────────────────────────────────┘

Data Flow (current — P0 stabilized, window/cursor active):

  bootstrap()                     assemble()                   afterTurn()
  ───────────                     ──────────                   ───────────
  ▸ sessionExists() → skip if hot  compose()                    slice(prePromptCount)
  ▸ SQLite ─→ warmSession()        ─→ getHistory(limit) ✅      ─→ record*Message()
           ─→ pushHistory(250)     ─→ dedup by id               ─→ pushHistory(1, dedup)
           ─→ cache history        ─→ budget assembly            ─→ cache history
                                   ─→ write window bundle       ─→ invalidateWindow()
                                   ─→ write cursor metadata     ─→ background indexer
                                   ─→ → runtime → provider

### Key Invariants

1. Hot-cache `history` is the warm archive. Append-only. Nothing reads it for direct submission.
2. Hot-cache `window` is the compositor's output cache. Written ONLY by `compose()`. Read ONLY by `assemble()`. Invalidated by `afterTurn`.
3. Hot-cache `cursor` tracks the newest message in the last window. Used by background indexer for high-signal mining.
4. `warmSession()` seeds `history` only (capped at 250). Never writes `window`.
5. `pushHistory()` tail-checks before append (no duplicate IDs in the hot-cache history list).
6. `compose()` deduplicates history by `id` before budget assembly.
7. `getHistory()` honors its `limit` parameter on BOTH hot-cache and SQLite paths.

Open and deferred work is tracked outside this public architecture reference.

### Runtime Contract

**Exclusive dispatch:** The OpenClaw runtime calls either `afterTurn()` OR `ingest()`/`ingestBatch()`, never both. Since hypermem implements `afterTurn`, it must handle message ingestion there. `ingest()` exists for API compatibility but is never called by the runtime in practice.

**Provider translation:** The plugin sets `skipProviderTranslation: true` on compose requests. The compositor returns NeutralMessages; the plugin converts to AgentMessages. The runtime handles provider-specific translation. Two-stage translation (compositor → provider format → plugin → agent format) was the root cause of Incident 1 (silent tool call drops).

## Module Map (29 files, ~12,300 lines)

| Module | Lines | Layer | Purpose |
|---|---|---|---|
| `index.ts` | ~1,340 | All | Facade — all public API |
| `compositor.ts` | ~1,140 | L1-L4 | Prompt assembly + token budgeting + safety valve + window/cursor write |
| `library-schema.ts` | ~780 | L4 | Library schema v19 + migrations |
| `background-indexer.ts` | ~680 | L2-L4 | LLM-powered extraction framework |
| `vector-store.ts` | ~600 | L3 | Semantic search + embedding |
| `hybrid-retrieval.ts` | ~450 | L3-L4 | FTS5 + KNN with Reciprocal Rank Fusion |
| `fleet-store.ts` | ~440 | L4 | Fleet registry + capabilities |
| `db.ts` | ~440 | - | Database manager + rotation |
| `knowledge-graph.ts` | ~420 | L4 | DAG traversal + shortest path |
| `cache.ts` | ~700 | L1 | SQLite `:memory:` hot-cache operations, window cache, cursor, fleet cache |
| `doc-chunker.ts` | ~400 | - | Section-aware markdown/file parser |
| `work-store.ts` | ~400 | L4 | Work queue + FTS5 |
| `provider-translator.ts` | ~390 | - | Neutral ↔ provider format conversion |
| `doc-chunk-store.ts` | ~375 | L4 | Chunk storage + deduplication |
| `message-store.ts` | ~370 | L2 | Conversation recording + querying |
| `types.ts` | ~370 | - | Shared type definitions + SessionCursor |
| `cross-agent.ts` | ~330 | L2-L4 | Cross-agent knowledge queries + visibility |
| `desired-state-store.ts` | ~310 | L4 | Config drift detection |
| `knowledge-store.ts` | ~300 | L4 | Domain/key/value structured data |
| `secret-scanner.ts` | ~285 | - | Credential/secret detection |
| `system-store.ts` | ~250 | L4 | Service state tracking |
| `seed.ts` | ~250 | L4 | Workspace seeder + collection inference |
| `fact-store.ts` | ~230 | L4 | Facts with confidence + expiry |
| `rate-limiter.ts` | ~230 | L3 | Token-bucket for embedding API |
| `schema.ts` | ~200 | L2 | Messages schema + migrations |
| `episode-store.ts` | ~180 | L4 | Significant event tracking |
| `preference-store.ts` | ~170 | L4 | Operator behavioral patterns |
| `topic-store.ts` | ~160 | L4 | Cross-session thread tracking |
| `plugin/src/index.ts` | ~590 | - | `hypercompositor` context engine plugin + window invalidation |
| `memory-plugin/src/index.ts` | ~290 | - | `hypermem` memory slot plugin (memory_search via hybrid retrieval) |

## Test Coverage (105 assertions, 11 suites)

_Test count reflects assertions, not individual test blocks. Suites contain inline assertions._

| Suite | Key coverage |
|---|---|
| smoke | End-to-end create/write/read/close, provider translation |
| redis-integration | Legacy suite name, covers hot-cache ops, slots, history limits, window cache, cursor, warming, dedup |
| cross-agent | Cross-agent queries, fleet search, visibility tiers |
| vector-search | Embedding, KNN, batch indexing |
| library | All L4 collections (facts → desired state) |
| compositor | Four-layer composition, budgets, providers, safety valve, Gate 1 |
| fleet-cache | Fleet hot-cache hydration and cache-aside behavior |
| rotation | DB rotation, auto-rotate, collision handling |
| knowledge-graph | DAG traversal, shortest path, analytics |
| rate-limiter | Token bucket, priority, timeout, embedder |
| doc-chunker | Markdown/file chunking, section-aware parsing, seeder |

## Dependencies

- `node:sqlite` (Node 22+ built-in) — zero-dependency SQLite
- No external cache service dependency — hot cache is SQLite `:memory:`
- `sqlite-vec` — optional, vector search extension
- Ollama (localhost:11434) — optional, embedding generation
