# HyperMem

Agent-centric memory system for OpenClaw. Four-layer architecture: Redis hot cache → per-agent message DB → per-agent vector DB → shared fleet library.

**Status:** Core complete — 22 modules, 8,475 lines, 297 tests across 10 suites. All passing.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

```
L1  Redis         Hot session cache (sub-ms reads, identity kernel, fleet cache)
L2  Messages DB   Per-agent conversation history (SQLite, rotatable)
L3  Vectors DB    Per-agent semantic search (sqlite-vec, 768d embeddings)
L4  Library DB    Fleet-wide structured knowledge (10 collections + knowledge graph)
```

### Key Components

- **Compositor** — Assembles LLM prompts from all 4 layers with token budgeting. Budget caps per slot (facts 30%, knowledge 20%, preferences 10%, cross-session 20%). Multi-provider output (Anthropic + OpenAI).
- **Fleet Cache** — Redis hot layer for agent profiles + fleet summary. Cache-aside reads, write-through invalidation, bulk hydration on gateway startup.
- **Knowledge Graph** — DAG traversal over entity relationships. BFS with depth/direction/type filters, shortest path, degree analytics.
- **Rate Limiter** — Token-bucket for embedding API calls. Priority queue (high > normal > low) with reserved tokens for user-facing recall.
- **Provider Translator** — Converts between neutral internal format and Anthropic/OpenAI at the output boundary.
- **Message Rotation** — Automatic rotation of message DBs at 100MB / 90 days. WAL checkpoint before rotate.

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

## Requirements

- **Node.js 22+** (uses built-in `node:sqlite`)
- **Redis 7+** (optional — all operations degrade gracefully to SQLite-only)
- **Ollama** (optional — for embedding generation, model: `nomic-embed-text`, 768d)
- **sqlite-vec** (optional — for vector search)

## Quick Start

```bash
npm install
npm run build              # TypeScript compilation

# Tests (require Redis on localhost:6379 for full suite)
node test/smoke.mjs        # SQLite-only, no external deps
node test/library.mjs      # L4 library collections
node test/vector-search.mjs # L3 semantic search (needs Ollama)
node test/compositor.mjs   # Four-layer prompt composition (needs Redis)
```

### Run All Tests

```bash
for t in smoke redis-integration cross-agent vector-search library compositor fleet-cache rotation knowledge-graph rate-limiter; do
  echo "=== $t ===" && node test/$t.mjs
done
```

## Hook Integration

Register as an OpenClaw managed hook at `~/.openclaw/hooks/hypermem-core/handler.js`:

| Event | Action |
|---|---|
| `gateway:startup` | Init HyperMem, auto-rotate DBs, hydrate fleet cache |
| `agent:bootstrap` | Warm session (history, facts, profile → Redis) |
| `message:received` | Record user message to SQLite + Redis |
| `message:sent` | Record assistant message to SQLite + Redis |

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

// Compose prompt (all 4 layers)
const composed = await hm.compose({
  agentId: 'forge',
  sessionKey: 'agent:forge:webchat:main',
  tokenBudget: 4000,
  provider: 'anthropic'
});

// Fleet operations
await hm.upsertFleetAgent({ id: 'forge', displayName: 'Forge', tier: 'council' });
await hm.setDesiredState('forge', 'model', 'anthropic/claude-opus-4-6', 'ragesaq');
const drifted = await hm.getDriftedState();

// Semantic search
const results = await hm.searchSimilar('drift detection', { limit: 5, threshold: 0.8 });

// Knowledge graph
await hm.addKnowledgeLink('fact', factId, 'knowledge', knowledgeId, 'supports');
const related = await hm.traverseKnowledge('fact', factId, { maxDepth: 3 });

// Cleanup
await hm.close();
```

## Test Coverage

| Suite | Tests | What's Covered |
|---|---|---|
| smoke | 8 | End-to-end create/write/read/close |
| redis-integration | 24 | Redis slots, history, pub/sub |
| cross-agent | 20 | Cross-agent queries, fleet search |
| vector-search | 33 | Embedding, KNN, batch indexing |
| library | 71 | All L4 collections (facts → desired state) |
| compositor | 25 | Four-layer composition, budgets, providers |
| fleet-cache | 32 | Redis fleet cache, hydration, cache-aside |
| rotation | 29 | DB rotation, auto-rotate, collision handling |
| knowledge-graph | 33 | DAG traversal, shortest path, analytics |
| rate-limiter | 22 | Token bucket, priority, timeout, embedder |
| **Total** | **297** | |

## Roadmap

- [ ] Document chunk ingestion pipeline (section-aware markdown parsing for ACA offload)
- [ ] Bootstrap seed command (`hypermem seed --workspace`)
- [ ] Versioned atomic re-indexing (source hash + transactional swap)
- [ ] Background indexer (LLM-powered fact extraction from conversations)
- [ ] Compositor trigger registry (demand-load governance/policy context)
- [ ] npm publish to registry

## License

Private — PsiClawOps
