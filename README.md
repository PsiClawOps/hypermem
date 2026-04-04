# HyperMem

Agent-centric memory system for OpenClaw. Four-layer architecture: Redis hot cache → per-agent message DB → per-agent vector DB → shared fleet library.

**Status:** Core complete + context engine plugin shipped. 29 modules, ~12,300 lines, 419 tests across 11 suites. All passing.

## What It Does

HyperMem replaces the default OpenClaw context assembly pipeline. Instead of the runtime managing conversation history and compaction, HyperMem owns the full prompt composition lifecycle:

1. **Records** every message to SQLite (L2) and Redis (L1) as it arrives
2. **Indexes** conversations and workspace files for semantic retrieval (L3)
3. **Composes** each LLM prompt fresh from storage — facts, knowledge, history, recall — within a strict token budget
4. **Owns compaction** — the runtime's legacy compaction is bypassed entirely; HyperMem handles its own context management

This means agents get structured, budget-aware context every turn instead of a growing transcript that eventually gets summarized.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

```
L1  Redis         Hot session cache (sub-ms reads, identity kernel, fleet cache)
L2  Messages DB   Per-agent conversation history (SQLite, rotatable)
L3  Vectors DB    Per-agent semantic search (sqlite-vec, 768d embeddings)
L4  Library DB    Fleet-wide structured knowledge (10 collections + knowledge graph)
```

### Key Components

- **Compositor** — Assembles LLM prompts from all 4 layers with token budgeting. Each slot gets a proportional cap of remaining budget (facts 30%, knowledge 20%, preferences 10%, cross-session 20%). Post-assembly safety valve catches estimation drift and trims history to fit. Multi-provider output (Anthropic + OpenAI).
- **Context Engine Plugin** — OpenClaw plugin (`plugin/src/index.ts`) that registers HyperMem as a context engine. Owns compaction, translates between OpenClaw's runtime events and HyperMem's storage/composition pipeline. Drop-in replacement for the default context assembly.
- **Hybrid Retrieval** — Combined FTS5 full-text search + KNN vector similarity with Reciprocal Rank Fusion for recall quality.
- **Doc Chunker** — Section-aware markdown/file parser that splits workspace documents into semantically meaningful chunks for indexing.
- **Workspace Seeder** — Indexes workspace files (AGENTS.md, SOUL.md, POLICY.md, daily memory, etc.) into L4 collections with idempotent re-indexing and source-hash deduplication.
- **Fleet Cache** — Redis hot layer for agent profiles + fleet summary. Cache-aside reads, write-through invalidation, bulk hydration on gateway startup.
- **Knowledge Graph** — DAG traversal over entity relationships. BFS with depth/direction/type filters, shortest path, degree analytics.
- **Rate Limiter** — Token-bucket for embedding API calls. Priority queue (high > normal > low) with reserved tokens for user-facing recall.
- **Secret Scanner** — Scans content for API keys, tokens, and credentials before storage. Prevents accidental persistence of secrets.
- **Provider Translator** — Converts between neutral internal format and Anthropic/OpenAI at the output boundary. Handles tool call ID round-tripping.
- **Message Rotation** — Automatic rotation of message DBs at 100MB / 90 days. WAL checkpoint before rotate.
- **Background Indexer** — LLM-powered fact/knowledge extraction from conversations (framework complete).

### Library Collections (L4)

| Collection | Purpose |
|---|---|
| Facts | Verifiable claims with confidence, domain, expiry, supersedes chains |
| Knowledge | Domain/key/value structured data with FTS |
| Episodes | Significant events with impact and participants |
| Topics | Cross-session thread tracking |
| Preferences | Operator/user behavioral patterns |
| Fleet Registry | Agent registry with tier, org, capabilities |
| System Registry | Service state and lifecycle tracking |
| Work Items | Work queue with status transitions and FTS5 |
| Session Registry | Session lifecycle tracking |
| Desired State | Per-agent config with automatic drift detection |

## Context Engine Plugin

The plugin (`plugin/`) is how HyperMem integrates with OpenClaw. It implements the `ContextEngine` interface:

```typescript
// plugin registers as a context engine with:
{
  id: 'hypermem',
  name: 'HyperMem Context Engine',
  version: '0.1.0',
  ownsCompaction: true,  // runtime skips legacy compaction
}
```

**Lifecycle hooks handled:**
| Event | Action |
|---|---|
| `gateway:startup` | Init HyperMem, auto-rotate DBs, hydrate fleet cache |
| `agent:bootstrap` | Warm session (history, facts, profile → Redis) |
| `message:received` | Record user message to SQLite + Redis |
| `message:sent` | Record assistant message to SQLite + Redis |
| `context:compose` | Full four-layer prompt assembly within token budget |

**Install:** Deployed as an OpenClaw managed hook at `~/.openclaw/hooks/hypermem-core/handler.js`. The plugin build step copies compiled output to this path.

## Requirements

- **Node.js 22+** (uses built-in `node:sqlite`)
- **Redis 7+** (optional — all operations degrade gracefully to SQLite-only)
- **Ollama** (optional — for embedding generation, model: `nomic-embed-text`, 768d)
- **sqlite-vec** (optional — for vector search)

## Quick Start

```bash
npm install
npm run build              # TypeScript compilation + hook deployment

# Run all tests (requires Redis on localhost:6379 for full suite)
npm test

# Quick smoke test (SQLite-only, no external deps)
npm run test:quick
```

### Test Suites

```bash
npm test                   # All 11 suites (419 tests)
npm run test:quick         # smoke + library + compositor
```

## Data Directory

```
~/.openclaw/hypermem/
├── library.db                    # Fleet-wide shared knowledge (L4)
└── agents/
    └── {agentId}/
        ├── messages.db           # Current conversation DB (L2)
        ├── messages_2026Q1.db    # Rotated archive (read-only)
        └── vectors.db            # Semantic search index (L3)
```

## API

```typescript
import { HyperMem } from '@psiclawops/hypermem';

const hm = await HyperMem.create({
  agentId: 'forge',
  dataDir: '~/.openclaw/hypermem',
  redis: { host: 'localhost', port: 6379 },
  ollama: { host: 'http://localhost:11434', model: 'nomic-embed-text' }
});

// Record messages
await hm.recordUserMessage(conversationId, 'How does drift detection work?');
await hm.recordAssistantMessage(conversationId, 'Drift detection compares...');

// Compose prompt (all 4 layers, budget-aware)
const composed = await hm.compose({
  agentId: 'forge',
  sessionKey: 'agent:forge:webchat:main',
  tokenBudget: 4000,
  provider: 'anthropic'
});

// Hybrid retrieval (FTS + vector)
const results = await hm.hybridSearch('drift detection', {
  limit: 10,
  ftsWeight: 0.4,
  vectorWeight: 0.6
});

// Fleet operations
await hm.upsertFleetAgent({ id: 'forge', displayName: 'Forge', tier: 'council' });
await hm.setDesiredState('forge', 'model', 'anthropic/claude-opus-4-6', 'ragesaq');
const drifted = await hm.getDriftedState();

// Semantic search
const similar = await hm.searchSimilar('drift detection', { limit: 5, threshold: 0.8 });

// Knowledge graph
await hm.addKnowledgeLink('fact', factId, 'knowledge', knowledgeId, 'supports');
const related = await hm.traverseKnowledge('fact', factId, { maxDepth: 3 });

// Workspace indexing
await hm.seedWorkspace('/path/to/workspace');

// Cleanup
await hm.close();
```

## Test Coverage

| Suite | Tests | What's Covered |
|---|---|---|
| smoke | 10 | End-to-end create/write/read/close, provider translation |
| redis-integration | 24 | Redis slots, history, pub/sub |
| cross-agent | 20 | Cross-agent queries, fleet search, visibility tiers |
| vector-search | 33 | Embedding, KNN, batch indexing |
| library | 71 | All L4 collections (facts → desired state) |
| compositor | 50 | Four-layer composition, budgets, providers, safety valve |
| fleet-cache | 32 | Redis fleet cache, hydration, cache-aside |
| rotation | 29 | DB rotation, auto-rotate, collision handling |
| knowledge-graph | 33 | DAG traversal, shortest path, analytics |
| rate-limiter | 22 | Token bucket, priority, timeout, embedder |
| doc-chunker | 105 | Markdown/file chunking, section-aware parsing, seeder |
| **Total** | **419** | |

## Module Map

29 source files, ~12,300 lines:

| Module | Lines | Layer | Purpose |
|---|---|---|---|
| `index.ts` | ~1,340 | All | Facade — all public API |
| `compositor.ts` | ~1,030 | L1-L4 | Prompt assembly + token budgeting + safety valve |
| `library-schema.ts` | ~780 | L4 | Library schema v5 + migrations |
| `background-indexer.ts` | ~680 | L2-L4 | LLM-powered extraction framework |
| `vector-store.ts` | ~600 | L3 | Semantic search + embedding |
| `hybrid-retrieval.ts` | ~450 | L3-L4 | FTS5 + KNN with Reciprocal Rank Fusion |
| `fleet-store.ts` | ~440 | L4 | Fleet registry + capabilities |
| `db.ts` | ~440 | - | Database manager + rotation |
| `knowledge-graph.ts` | ~420 | L4 | DAG traversal + shortest path |
| `redis.ts` | ~400 | L1 | Redis operations + fleet cache |
| `doc-chunker.ts` | ~400 | - | Section-aware markdown/file parser |
| `work-store.ts` | ~400 | L4 | Work queue + FTS5 |
| `provider-translator.ts` | ~390 | - | Neutral ↔ provider format conversion |
| `doc-chunk-store.ts` | ~375 | L4 | Chunk storage + deduplication |
| `message-store.ts` | ~370 | L2 | Conversation recording + querying |
| `types.ts` | ~330 | - | Shared type definitions |
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
| `plugin/src/index.ts` | ~550 | - | OpenClaw context engine plugin |

## Roadmap

- [x] ~~Document chunk ingestion pipeline (section-aware markdown parsing)~~
- [x] ~~Workspace seeder with idempotent re-indexing~~
- [x] ~~Hybrid retrieval (FTS5 + KNN with RRF)~~
- [x] ~~Context engine plugin (OpenClaw integration)~~
- [x] ~~Compositor safety valve for budget overrun~~
- [x] ~~Own compaction (`ownsCompaction: true`)~~
- [ ] Background indexer activation (LLM extraction from live conversations)
- [ ] Versioned atomic re-indexing (source hash + transactional swap)
- [ ] Bootstrap seed command (`hypermem seed --workspace`)
- [ ] npm publish to registry
- [ ] Live org registry (replace hardcoded `defaultOrgRegistry()` with library.db lookup)
- [ ] Embedding model hot-swap (currently pinned to nomic-embed-text)

## License

Private — PsiClawOps
