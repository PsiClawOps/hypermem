# hypermem Migration Guide

_One guide for all migration paths. Find your current system in the table below and jump to that section._

---

## Quick lookup

| Your current setup | Jump to |
|---|---|
| No memory system (starting fresh) | [Fresh install](#fresh-install) |
| OpenClaw built-in memory (`memory.db`) | [From OpenClaw memory.db](#from-openclaw-memorydb) |
| OpenClaw QMD backend | [From QMD](#from-qmd) |
| ClawText context engine | [From ClawText](#from-clawtext) |
| Cognee (ECL pipeline) | [From Cognee](#from-cognee) |
| Mem0 (cloud or OSS) | [From Mem0](#from-mem0) |
| Zep (cloud or self-hosted) | [From Zep](#from-zep) |
| Honcho OpenClaw plugin | [From Honcho](#from-honcho) |
| OpenClaw memory-lancedb plugin | [From memory-lancedb](#from-memory-lancedb) |
| Markdown MEMORY.md + daily files only | [From MEMORY.md files](#from-memorymd-files) |
| Something else / custom engine | [From a custom system](#from-a-custom-system) |

---

## What hypermem stores

Understanding the data model sets expectations for what migrates and what doesn't.

**Migrates cleanly from most systems:**
- Conversation history (messages, roles, timestamps)
- Facts and preferences extracted from past conversations
- Structured knowledge entries

**Does not migrate (by design):**
- The Redis hot cache — ephemeral, rebuilds automatically on first use
- Embeddings — hypermem regenerates these from imported text on the next indexer run
- Tool call payloads from sessions where only text content was stored (tool results preserved as prose where available)
- Graph structure from graph databases (edges, weights, triplets) — these are flattened to facts on import

After any migration, the background indexer picks up imported content and builds vector search, topic maps, and knowledge synthesis automatically. A gateway restart is sufficient to trigger it.

---

## Universal pre-flight checklist

Run this before any migration path.

**1. Confirm hypermem is installed and has initialized:**
```bash
openclaw plugins list | grep hypermem
ls ~/.openclaw/hypermem/library.db   # must exist — send one message first if not
```

If `library.db` doesn't exist yet, start the gateway with hypermem enabled, send one message to any agent, then come back:
```bash
openclaw plugins install clawhub:hypermem
openclaw gateway restart
# send one message, then continue
```

**2. Back up your existing data:**
```bash
# OpenClaw built-in memory
cp ~/.openclaw/memory.db ~/.openclaw/memory.db.pre-hypermem 2>/dev/null || true

# ClawText
cp ~/.openclaw/workspace/.clawtext/session-intelligence.db \
   ~/.openclaw/workspace/.clawtext/session-intelligence.db.pre-hypermem 2>/dev/null || true

# Cognee
cp -r ~/.cognee ~/.cognee.pre-hypermem 2>/dev/null || true
```

**3. Every migration script defaults to dry-run.** Nothing is written until you add `--apply`. Read dry-run output before proceeding.

**4. You do not need to stop the gateway** for import-only migrations. hypermem uses WAL mode — live sessions and imports coexist safely.

---

## Fresh install

Nothing to migrate. Install and go:

```bash
openclaw plugins install clawhub:hypermem
openclaw gateway restart
```

hypermem begins building context from your first conversation. The background indexer starts automatically.

---

## From OpenClaw memory.db

OpenClaw's built-in memory system stores facts, preferences, and context entries in `~/.openclaw/memory.db`. This script imports those entries as facts into hypermem's knowledge store.

**What maps to what:**

| memory.db | hypermem |
|---|---|
| Facts | `facts` table in `library.db` |
| Preferences | `facts` table with `domain: preference` |
| Context entries | `facts` table with `domain: general` |

**Step 1: Dry run**
```bash
node scripts/migrate-memory-db.mjs --agent main
```

Review output — it will show fact counts by type.

**Step 2: Import**
```bash
node scripts/migrate-memory-db.mjs --agent main --apply
```

**Step 3: Restart**
```bash
openclaw gateway restart
```

**Options:**
```
--agent <id>          Agent to import facts for (default: main)
--memory-db <path>    Path to memory.db (default: ~/.openclaw/memory.db)
--hypermem-dir <path> hypermem data directory (default: ~/.openclaw/hypermem)
--limit <n>           Import only first N facts (useful for testing)
--apply               Actually write data (default is dry-run)
```

> **Note:** The built-in memory.db is not agent-scoped. All entries go to the agent you specify with `--agent`. If multiple agents share the same memory.db, run the script once per agent.

---

## From QMD

QMD is the OpenClaw local-first memory sidecar — it runs behind `plugins.slots.memory = "memory-core"` with `memory.backend = "qmd"`. hypermem replaces the entire context engine, so this is a slot change: from `slots.memory` (memory-core/QMD) to `slots.contextEngine` (hypermem).

**Key difference:** QMD is additive — it augments what the agent receives. hypermem is authoritative — it owns the entire context assembly pipeline. The scopes are different.

**What maps to what:**

| QMD | hypermem |
|---|---|
| Workspace memory files (`MEMORY.md`, `memory/*.md`) | Still used — hypermem reads these directly during bootstrap |
| Per-agent collections | Per-agent message stores + `library.db` facts |
| BM25 + vector hybrid search | FTS5 + nomic-embed-text hybrid search |
| Extra indexed paths (`memory.qmd.paths`) | Not yet supported — see capability gaps below |
| Session transcript indexing | Covered natively — all message history is indexed |
| Reranking (QMD cross-encoder) | Not implemented — hypermem uses MMR diversification |

**Pre-flight:**

Check what QMD has indexed, and note any extra paths:
```bash
ls ~/.openclaw/agents/<agentId>/qmd/
```

If you used `memory.qmd.paths` to index extra directories, those paths are not picked up automatically. Copy key content into `MEMORY.md` or daily files before switching, or use the manual import script below.

If you used QMD session indexing (`memory.qmd.sessions.enabled: true`), hypermem handles sessions natively going forward. Historical transcripts are not auto-imported — add summaries of important historical sessions to a daily memory file if needed.

**Switch:**
```bash
# Disable memory-core + QMD
openclaw config set plugins.slots.memory none

# Enable hypermem
openclaw config set plugins.slots.contextEngine hypermem

# Remove QMD backend config if set
openclaw config unset agents.defaults.memory

openclaw gateway restart
```

QMD collections at `~/.openclaw/agents/<agentId>/qmd/` are untouched. Delete them manually when satisfied the migration is complete.

**After restart:** hypermem bootstraps on first use and reads your workspace memory files. The background indexer builds facts and embeddings from `MEMORY.md` and daily files — no separate import step for file-based memory.

**If you had content in extra QMD paths**, import it manually:
```js
// import-qmd-extras.mjs
import { createhypermem } from '@psiclawops/hypermem';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { glob } from 'node:fs/promises';

const agentId = process.argv[2] ?? 'main';
const extraDir = process.argv[3];
const dryRun = !process.argv.includes('--apply');

if (!extraDir) {
  console.error('Usage: node import-qmd-extras.mjs <agentId> <directory> [--apply]');
  process.exit(1);
}

const hm = await createhypermem({ dir: join(homedir(), '.openclaw/hypermem') });
let imported = 0;
const files = [];
for await (const f of glob('**/*.md', { cwd: extraDir })) files.push(f);

for (const file of files) {
  const content = readFileSync(join(extraDir, file), 'utf-8');
  const chunks = content.split(/\n{2,}/).filter(c => c.trim().length > 60);
  for (const chunk of chunks) {
    if (dryRun) {
      console.log(`[dry-run] ${file}: ${chunk.slice(0, 80).trim()}...`);
    } else {
      await hm.addFact(agentId, chunk.trim(), {
        domain: 'general',
        source: `qmd-extra-migration:${file}`,
        confidence: 0.8,
      });
    }
    imported++;
  }
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}${imported} chunks from ${files.length} files`);
if (dryRun) console.log('Run with --apply to write data.');
```

**Capability gaps vs QMD:**

| QMD feature | Status in hypermem |
|---|---|
| Reranking (cross-encoder) | Not implemented. Tracked for future release. |
| Extra path indexing | Not implemented. Use manual fact import as workaround. |
| Session transcript search | Covered natively. |
| BM25 hybrid search | Covered — FTS5 + vector hybrid with configurable weights. |
| Automatic fallback to builtin | Not applicable — hypermem does not fall back. |

---

## From ClawText

ClawText stores full conversation history in `session-intelligence.db`. This script imports all conversations with automatic agent identification from identity anchors.

**What maps to what:**

| ClawText | hypermem |
|---|---|
| Conversation history | Per-agent `messages.db` |
| Identity anchors | Used to route messages to correct agent DB |
| Optimization `.jsonl` logs | Not imported (operational data, not conversation history) |

**Step 1: Dry run**
```bash
node scripts/migrate-clawtext.mjs
```

**Step 2: Import**
```bash
node scripts/migrate-clawtext.mjs --apply
```

**Step 3: Restart**
```bash
openclaw gateway restart
```

**Options:**
```
--apply               Actually write data (default is dry-run)
--limit <n>           Import only first N conversations
--clawtext-db <path>  Path to session-intelligence.db
                      (default: ~/.openclaw/workspace/.clawtext/session-intelligence.db)
--hypermem-dir <path> hypermem data directory (default: ~/.openclaw/hypermem)
```

Conversations without a detectable agent identity are routed to `main`.

---

## From Cognee

Cognee is a Python-based ECL (Extract, Cognify, Load) memory engine that stores knowledge in a graph database + vector store. hypermem is a Node.js context engine native to OpenClaw. This is a data migration, not a drop-in swap — the architectures are parallel approaches to the same problem.

**What maps to what:**

| Cognee | hypermem |
|---|---|
| Knowledge graph nodes (entities) | Facts (`facts` table in `library.db`) |
| Graph relationships / triplets | Knowledge entries (`knowledge` table) |
| Vector embeddings | Regenerated automatically by the hypermem indexer |
| Session memory | Per-agent message history (`messages.db` per agent) |
| Permanent memory | Facts + knowledge in `library.db` |
| User/tenant scoping | Agent scoping (`agent_id` on all records) |

**What does not migrate:** raw graph structure (edges, weights), Cognee's memify feedback loop state, embeddings (regenerated automatically after import).

**Step 1: Export your Cognee data**

Cognee stores data in whichever backend you configured. Export to a flat JSON file.

_Default SQLite backend:_
```python
# export_cognee.py
import asyncio
import cognee
import json

async def main():
    results = await cognee.search("*", query_type="CHUNKS")
    with open("cognee_export.json", "w") as f:
        json.dump(
            [r.__dict__ if hasattr(r, '__dict__') else str(r) for r in results],
            f, indent=2, default=str
        )
    print(f"Exported {len(results)} entries")

asyncio.run(main())
```

For graph backends (Neo4j, Memgraph), export via their native query interfaces and produce a flat JSON list of `{ text, source, type }` objects.

**Step 2: Dry run**

Save this as `import-from-cognee.mjs` in the hypermem repo root:

```js
// import-from-cognee.mjs
import { createhypermem } from '@psiclawops/hypermem';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agentId = process.argv[2] ?? 'main';
const exportPath = process.argv[3] ?? 'cognee_export.json';
const dryRun = !process.argv.includes('--apply');

const entries = JSON.parse(readFileSync(exportPath, 'utf-8'));
const hm = await createhypermem({ dir: join(homedir(), '.openclaw/hypermem') });

let imported = 0;
let skipped = 0;

for (const entry of entries) {
  // Adapt this to match your export format
  const text = entry.text ?? entry.content ?? entry.payload ?? JSON.stringify(entry);
  if (!text || text.length < 40) { skipped++; continue; }

  if (dryRun) {
    console.log(`[dry-run] would import: ${text.slice(0, 80)}...`);
    imported++;
    continue;
  }

  await hm.addFact(agentId, text, {
    domain: entry.type ?? 'general',
    source: 'cognee-migration',
    confidence: 0.85,
  });
  imported++;
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}Imported: ${imported}, Skipped: ${skipped}`);
if (dryRun) console.log('Run with --apply to write data.');
```

```bash
node import-from-cognee.mjs main cognee_export.json
```

**Step 3: Import**
```bash
node import-from-cognee.mjs main cognee_export.json --apply
```

**Step 4: Disable Cognee and switch to hypermem**

Stop the Cognee process / MCP server if running, then:
```bash
openclaw config set plugins.slots.contextEngine hypermem
openclaw gateway restart
```

Cognee and hypermem do not conflict at runtime (Cognee is a separate process), but there is no reason to run both.

**Verify imported facts:**
```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os'), path = require('node:path');
const db = new DatabaseSync(path.join(os.homedir(), '.openclaw/hypermem/library.db'), { readOnly: true });
const r = db.prepare(\"SELECT agent_id, COUNT(*) as cnt FROM facts WHERE source='cognee-migration' GROUP BY agent_id\").all();
r.forEach(x => console.log(x.agent_id + ': ' + x.cnt + ' imported facts'));
db.close();
"
```

---

## From Mem0

Mem0 is a managed memory service (with an OSS self-hosted variant) that stores distilled facts per user or agent. It has a clean export API — this is one of the easier migrations.

**What maps to what:**

| Mem0 | hypermem |
|---|---|
| Memory entries (`memory` field) | Facts in `library.db` |
| `user_id` scoping | `agent_id` scoping |
| `agent_id` / `app_id` filters | `agent_id` in hypermem |
| `metadata` | Stored as fact metadata / domain |
| `created_at` | Preserved as fact timestamp |

**What does not migrate:** Mem0's internal vector embeddings (regenerated automatically), category labels beyond what fits in hypermem's domain field.

**Step 1: Export from Mem0**

_Cloud (managed API):_
```python
# export_mem0.py
from mem0 import MemoryClient
import json, time

client = MemoryClient(api_key="your_mem0_api_key")

# Option A: export job (structured)
schema = {
    "type": "object",
    "properties": {
        "memories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "content": {"type": "string"},
                    "metadata": {"type": "object"},
                    "created_at": {"type": "string"}
                }
            }
        }
    }
}
response = client.create_memory_export(schema=schema, filters={})
export_id = response["id"]
time.sleep(5)  # wait for job
export_data = client.get_memory_export(memory_export_id=export_id)
with open("mem0_export.json", "w") as f:
    json.dump(export_data, f, indent=2)
print(f"Exported {len(export_data['memories'])} memories")
```

_Or use `get_all()` for a raw list (OSS or cloud):_
```python
from mem0 import MemoryClient
import json

client = MemoryClient(api_key="your_mem0_api_key")
result = client.get_all(filters={"user_id": "your_user_id"}, page_size=500)
with open("mem0_export.json", "w") as f:
    # get_all returns {count, results: [{memory, id, metadata, ...}]}
    json.dump(result, f, indent=2)
print(f"Exported {result['count']} memories")
```

**Step 2: Dry run**
```bash
node scripts/migrate-mem0.mjs --agent main mem0_export.json
```

Save this as `scripts/migrate-mem0.mjs`:
```js
// scripts/migrate-mem0.mjs
import { createhypermem } from '@psiclawops/hypermem';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agentId = process.argv[2] ?? 'main';
const exportPath = process.argv[3] ?? 'mem0_export.json';
const dryRun = !process.argv.includes('--apply');

const raw = JSON.parse(readFileSync(exportPath, 'utf-8'));
// handle both export job format {memories: [...]} and get_all format {results: [...]}
const entries = raw.memories ?? raw.results ?? raw;

const hm = await createhypermem({ dir: join(homedir(), '.openclaw/hypermem') });
let imported = 0, skipped = 0;

for (const entry of entries) {
  // export job uses 'content', get_all uses 'memory'
  const text = entry.content ?? entry.memory ?? '';
  if (!text || text.length < 20) { skipped++; continue; }

  const domain = entry.metadata?.category ?? entry.metadata?.type ?? 'general';

  if (dryRun) {
    console.log(`[dry-run] ${domain}: ${text.slice(0, 80)}`);
    imported++;
    continue;
  }

  await hm.addFact(agentId, text, {
    domain,
    source: 'mem0-migration',
    confidence: 0.9,
    createdAt: entry.created_at,
  });
  imported++;
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}Imported: ${imported}, Skipped: ${skipped}`);
if (dryRun) console.log('Run with --apply to write data.');
```

**Step 3: Import**
```bash
node scripts/migrate-mem0.mjs --agent main mem0_export.json --apply
```

**Step 4: Restart**
```bash
openclaw gateway restart
```

**Verify:**
```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os'), path = require('node:path');
const db = new DatabaseSync(path.join(os.homedir(), '.openclaw/hypermem/library.db'), { readOnly: true });
const r = db.prepare(\"SELECT COUNT(*) as cnt FROM facts WHERE source='mem0-migration'\").get();
console.log('Imported from Mem0:', r.cnt, 'facts');
db.close();
"
```

---

## From Zep

Zep stores conversation history per session and builds a per-user knowledge graph on top. It runs either self-hosted or as a managed cloud service. The migration extracts session messages and any queryable facts.

**What maps to what:**

| Zep | hypermem |
|---|---|
| Session messages (`role`, `role_type`, `content`) | Per-agent `messages.db` |
| User-level knowledge graph facts | Facts in `library.db` |
| Group data (shared org context) | Facts in `library.db` with `domain: group` |
| `session_id` | hypermem session key |
| `user_id` | `agent_id` |

**What does not migrate:** Zep's internal graph edges/weights, fact ratings, ingestion-derived entity relationships (flattened to text facts on import).

**Step 1: Export from Zep**

```python
# export_zep.py
from zep_cloud.client import Zep
import json

client = Zep(api_key="your_zep_api_key")
# For self-hosted: client = Zep(api_key="unused", base_url="http://localhost:8000")
# Note: api_key is required by the Pydantic validator even for self-hosted; any non-empty string works.

export = {"sessions": [], "facts": []}

# Export all users and their sessions
users = client.user.list()  # paginate if needed
for user in users:
    sessions = client.user.get_sessions(user.user_id)
    for session in sessions:
        messages = client.memory.get_session_messages(session.session_id)
        export["sessions"].append({
            "session_id": session.session_id,
            "user_id": user.user_id,
            "messages": [
                {"role": m.role_type, "content": m.content, "created_at": str(m.created_at)}
                for m in (messages.messages or [])
            ]
        })

    # Export graph facts for this user
    try:
        graph_results = client.graph.search(query="", user_id=user.user_id, limit=500)
        for edge in (graph_results.edges or []):
            export["facts"].append({
                "user_id": user.user_id,
                "text": edge.fact,
                "created_at": str(edge.created_at) if hasattr(edge, 'created_at') else None
            })
    except Exception:
        pass  # graph search requires at least one prior message

with open("zep_export.json", "w") as f:
    json.dump(export, f, indent=2)
print(f"Exported {len(export['sessions'])} sessions, {len(export['facts'])} facts")
```

**Step 2: Import**

Save as `scripts/migrate-zep.mjs`:
```js
// scripts/migrate-zep.mjs
import { createhypermem } from '@psiclawops/hypermem';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agentId = process.argv[2] ?? 'main';
const exportPath = process.argv[3] ?? 'zep_export.json';
const dryRun = !process.argv.includes('--apply');

const { sessions = [], facts = [] } = JSON.parse(readFileSync(exportPath, 'utf-8'));
const hm = await createhypermem({ dir: join(homedir(), '.openclaw/hypermem') });

let msgCount = 0, factCount = 0;

// Import session messages
for (const session of sessions) {
  const sessionKey = `zep-migration:${session.session_id}`;
  for (const msg of session.messages ?? []) {
    if (!msg.content) continue;
    if (dryRun) { console.log(`[dry-run] msg [${msg.role}]: ${msg.content.slice(0, 60)}`); msgCount++; continue; }
    if (msg.role === 'user' || msg.role === 'human') {
      await hm.recordUserMessage(agentId, sessionKey, msg.content);
    } else {
      await hm.recordAssistantMessage(agentId, sessionKey, {
        role: 'assistant', textContent: msg.content, toolCalls: [],
        createdAt: msg.created_at ?? new Date().toISOString(),
      });
    }
    msgCount++;
  }
}

// Import knowledge graph facts
for (const fact of facts) {
  if (!fact.text || fact.text.length < 20) continue;
  if (dryRun) { console.log(`[dry-run] fact: ${fact.text.slice(0, 80)}`); factCount++; continue; }
  await hm.addFact(agentId, fact.text, {
    domain: 'general',
    source: 'zep-migration',
    confidence: 0.85,
    createdAt: fact.created_at,
  });
  factCount++;
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}Messages: ${msgCount}, Facts: ${factCount}`);
if (dryRun) console.log('Run with --apply to write data.');
```

```bash
# Dry run
node scripts/migrate-zep.mjs main zep_export.json

# Apply
node scripts/migrate-zep.mjs main zep_export.json --apply

openclaw gateway restart
```

> **Self-hosted Zep:** if you are running the open-source Zep server, you can also export directly from the underlying Postgres database. The `zep.messages` table has `session_id`, `role`, `content`, `created_at` — the import script above accepts the same JSON shape either way.

---

## From Honcho

Honcho is an OpenClaw plugin (`@honcho-ai/openclaw-honcho`) that persists conversations to the Honcho service (hosted or self-hosted) and builds user/agent models over time. Because it is a plugin that runs alongside OpenClaw, migration to hypermem is mostly a slot swap — the data that matters is already in your workspace files, and Honcho's conversation history lives in the Honcho service.

**What maps to what:**

| Honcho | hypermem |
|---|---|
| Workspace memory files (migrated on setup) | Still used — hypermem reads these directly |
| Honcho session messages | Per-agent `messages.db` (going forward) |
| Honcho user model / conclusions | Facts in `library.db` |
| `honcho_context` / `honcho_ask` tools | `memory_search` + hypermem context assembly |

**What does not migrate automatically:** Honcho's cross-session conclusions and user model from the Honcho service — these require an API export step below.

**Step 1: Export conclusions from Honcho**

```python
# export_honcho.py
import requests, json, os

BASE_URL = os.getenv("HONCHO_BASE_URL", "https://api.honcho.dev")
API_KEY = os.getenv("HONCHO_API_KEY", "")
WORKSPACE = os.getenv("HONCHO_WORKSPACE", "openclaw")

headers = {"Authorization": f"Bearer {API_KEY}"} if API_KEY else {}

export = {"conclusions": [], "sessions": []}

# List apps (workspaces) and users
apps = requests.get(f"{BASE_URL}/v1/apps", headers=headers).json()
for app in apps.get("items", []):
    app_id = app["id"]
    users = requests.get(f"{BASE_URL}/v1/apps/{app_id}/users", headers=headers).json()
    for user in users.get("items", []):
        user_id = user["id"]
        # Get conclusions (derived memory)
        conclusions = requests.get(
            f"{BASE_URL}/v1/apps/{app_id}/users/{user_id}/conclusions",
            headers=headers
        ).json()
        for c in conclusions.get("items", []):
            export["conclusions"].append({"user_id": user_id, "text": c.get("content", ""), "created_at": c.get("created_at")})

with open("honcho_export.json", "w") as f:
    json.dump(export, f, indent=2)
print(f"Exported {len(export['conclusions'])} conclusions")
```

**Step 2: Import conclusions as facts**

Save as `scripts/migrate-honcho.mjs`:
```js
// scripts/migrate-honcho.mjs
import { createhypermem } from '@psiclawops/hypermem';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agentId = process.argv[2] ?? 'main';
const exportPath = process.argv[3] ?? 'honcho_export.json';
const dryRun = !process.argv.includes('--apply');

const { conclusions = [] } = JSON.parse(readFileSync(exportPath, 'utf-8'));
const hm = await createhypermem({ dir: join(homedir(), '.openclaw/hypermem') });
let imported = 0, skipped = 0;

for (const c of conclusions) {
  const text = c.text ?? '';
  if (!text || text.length < 20) { skipped++; continue; }
  if (dryRun) { console.log(`[dry-run] conclusion: ${text.slice(0, 80)}`); imported++; continue; }
  await hm.addFact(agentId, text, {
    domain: 'general',
    source: 'honcho-migration',
    confidence: 0.9,
    createdAt: c.created_at,
  });
  imported++;
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}Imported: ${imported}, Skipped: ${skipped}`);
if (dryRun) console.log('Run with --apply to write data.');
```

```bash
# Dry run
node scripts/migrate-honcho.mjs main honcho_export.json

# Apply
node scripts/migrate-honcho.mjs main honcho_export.json --apply
```

**Step 3: Uninstall Honcho plugin and enable hypermem**

```bash
openclaw plugins uninstall @honcho-ai/openclaw-honcho
openclaw config set plugins.slots.contextEngine hypermem
openclaw gateway restart
```

> **Note:** Your workspace memory files (`MEMORY.md`, `memory/*.md`) that Honcho migrated on setup are still in place and will be picked up by hypermem automatically — no re-import needed for those.

---

## From memory-lancedb

`memory-lancedb` is an OpenClaw install-on-demand plugin (`plugins.slots.memory = "memory-lancedb"`) that provides long-term memory with auto-recall and capture using LanceDB as the backing store. Like memory-core, it occupies the `slots.memory` slot — separate from the context engine slot that hypermem owns.

**What maps to what:**

| memory-lancedb | hypermem |
|---|---|
| LanceDB memory vectors | Facts in `library.db` (re-embedded automatically) |
| Captured memory entries | Facts with domain inferred from content |
| Auto-recall injection | hypermem context assembly (built-in) |
| Per-agent tables | Per-agent `library.db` facts |

**What does not migrate:** LanceDB vector embeddings (regenerated automatically), auto-capture triggers (hypermem handles recall natively).

**Step 1: Locate the LanceDB data directory**

```bash
# Default location — check your config if you changed it
ls ~/.openclaw/memory-lancedb/
# or
openclaw config get plugins.entries.memory-lancedb.config
```

**Step 2: Export entries from LanceDB**

```python
# export_lancedb.py
import lancedb, json, os

db_path = os.path.expanduser("~/.openclaw/memory-lancedb")
db = lancedb.connect(db_path)

export = []
for table_name in db.table_names():
    table = db.open_table(table_name)
    rows = table.to_pandas()
    for _, row in rows.iterrows():
        text = row.get("text") or row.get("content") or row.get("memory") or ""
        if text and len(str(text)) > 20:
            export.append({
                "agent_id": table_name,  # table name is typically the agent id
                "text": str(text),
                "metadata": {k: str(v) for k, v in row.items() if k not in ("text", "content", "memory", "vector")}
            })

with open("lancedb_export.json", "w") as f:
    json.dump(export, f, indent=2)
print(f"Exported {len(export)} entries from {len(db.table_names())} tables")
```

Install lancedb if needed: `pip install lancedb`

**Step 3: Import**

Save as `scripts/migrate-lancedb.mjs`:
```js
// scripts/migrate-lancedb.mjs
import { createhypermem } from '@psiclawops/hypermem';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// agent override — if set, all entries go to this agent regardless of export agent_id
const agentOverride = process.argv[2] !== '--apply' && !process.argv[2]?.startsWith('--') ? process.argv[2] : null;
const exportPath = process.argv.find(a => a.endsWith('.json')) ?? 'lancedb_export.json';
const dryRun = !process.argv.includes('--apply');

const entries = JSON.parse(readFileSync(exportPath, 'utf-8'));
const hm = await createhypermem({ dir: join(homedir(), '.openclaw/hypermem') });
let imported = 0, skipped = 0;

for (const entry of entries) {
  const text = entry.text ?? '';
  if (!text || text.length < 20) { skipped++; continue; }
  const agentId = agentOverride ?? entry.agent_id ?? 'main';
  if (dryRun) { console.log(`[dry-run] [${agentId}] ${text.slice(0, 80)}`); imported++; continue; }
  await hm.addFact(agentId, text, {
    domain: 'general',
    source: 'lancedb-migration',
    confidence: 0.85,
  });
  imported++;
}

console.log(`\n${dryRun ? '[dry-run] ' : ''}Imported: ${imported}, Skipped: ${skipped}`);
if (dryRun) console.log('Run with --apply to write data.');
```

```bash
# Dry run (all agents from export)
node scripts/migrate-lancedb.mjs lancedb_export.json

# Or target a specific agent
node scripts/migrate-lancedb.mjs main lancedb_export.json

# Apply
node scripts/migrate-lancedb.mjs lancedb_export.json --apply
```

**Step 4: Disable memory-lancedb and enable hypermem**

```bash
# Uninstall or just disable the slot
openclaw config set plugins.slots.memory none
openclaw config set plugins.slots.contextEngine hypermem
openclaw gateway restart
```

LanceDB files at `~/.openclaw/memory-lancedb/` are untouched. Delete when satisfied.

---

## From MEMORY.md files

If your agents use the standard OpenClaw MEMORY.md + daily checkpoint pattern (`memory/YYYY-MM-DD.md`) without any other memory backend, this script scans workspace directories and imports substantive entries as facts.

> **If you are coming from QMD**, use the [QMD path](#from-qmd) instead — it covers MEMORY.md files and handles the slot change correctly.

**Step 1: Dry run (all agents)**
```bash
node scripts/migrate-memory-md.mjs
```

Review output — shows workspaces found, fact counts per agent, and a sample of what would be imported.

**Step 2: Import**
```bash
node scripts/migrate-memory-md.mjs --apply
```

Or for a single agent:
```bash
node scripts/migrate-memory-md.mjs --agent forge --apply
```

**Step 3: Restart**
```bash
openclaw gateway restart
```

**Options:**
```
--agent <id>             Only import for this agent (default: all detected)
--workspace-root <path>  Scan workspace directories under this path
                         (default: ~/.openclaw)
--hypermem-dir <path>    hypermem data directory (default: ~/.openclaw/hypermem)
--limit <n>              Import only first N facts
--apply                  Actually write data (default is dry-run)
```

**Parsing rules:** Imports bullet list items from daily files (`memory/YYYY-MM-DD.md`) only. `MEMORY.md` index files are intentionally skipped — they're pointers, not content. Lines under 40 characters, `→ memory_search(...)` pointers, and code-like lines are also skipped.

---

## From a custom system

Use hypermem's programmatic API to import directly.

**Import facts:**
```js
import { createhypermem } from '@psiclawops/hypermem';

const hm = await createhypermem({ dir: '~/.openclaw/hypermem' });

await hm.addFact('your-agent-id', 'User prefers dark mode in all UIs', {
  domain: 'preference',
  source: 'migration',
  confidence: 0.9,
});
```

**Import conversation history:**
```js
await hm.recordUserMessage('your-agent-id', 'session-key:your-session', 'Hello, how are you?');

await hm.recordAssistantMessage('your-agent-id', 'session-key:your-session', {
  role: 'assistant',
  textContent: 'I am doing well, thank you.',
  toolCalls: [],
  createdAt: new Date().toISOString(),
});
```

For bulk imports, write a script modeled on `scripts/migrate-clawtext.mjs` — direct SQLite writes are faster than the API for large datasets.

After import:
```bash
openclaw gateway restart
```

---

## Enabling hypermem

Once your data is imported, switch the context engine:

```bash
openclaw config set plugins.slots.contextEngine hypermem
openclaw gateway restart
```

If you were on memory-core or QMD, also disable the memory slot:
```bash
openclaw config set plugins.slots.memory none
```

---

## Verifying the migration

**Check fact counts by agent:**
```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os'), path = require('node:path');
const db = new DatabaseSync(path.join(os.homedir(), '.openclaw/hypermem/library.db'), { readOnly: true });
const rows = db.prepare('SELECT agent_id, COUNT(*) as cnt FROM facts GROUP BY agent_id ORDER BY cnt DESC').all();
rows.forEach(r => console.log(r.agent_id + ': ' + r.cnt + ' facts'));
db.close();
"
```

**Check message history by agent:**
```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
const agentsDir = path.join(os.homedir(), '.openclaw/hypermem/agents');
for (const agent of fs.readdirSync(agentsDir)) {
  const dbPath = path.join(agentsDir, agent, 'messages.db');
  if (!fs.existsSync(dbPath)) continue;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const r = db.prepare('SELECT COUNT(*) as cnt FROM messages').get();
  console.log(agent + ': ' + r.cnt + ' messages');
  db.close();
}
"
```

**Ask your agent to recall something** from the imported history. If recall seems patchy in the first session, the background indexer is still building embeddings — send one message and wait one turn. It runs automatically after ingest.

---

## Rollback

hypermem does not modify or delete any source data. To roll back from any path:

```bash
# Remove hypermem context engine
openclaw config unset plugins.slots.contextEngine

# Restore the memory slot if you disabled it
openclaw config set plugins.slots.memory memory-core

# Restore QMD backend if that's where you came from
# openclaw config set agents.defaults.memory.backend qmd

# Re-enable your previous context engine if you had one
openclaw gateway restart
```

Original data (memory.db, ClawText database, QMD collections, Cognee data directory, MEMORY.md files) is untouched throughout.

---

## Troubleshooting

**"library.db not found" during migration**

hypermem hasn't initialized yet. Start the gateway with the plugin enabled, send one message, then re-run:
```bash
openclaw gateway restart
# wait a few seconds, send one message
node scripts/migrate-memory-db.mjs --agent main
```

**Facts imported but agent doesn't recall them**

The background indexer builds embeddings on a schedule. Force a rebuild:
```bash
openclaw gateway restart
```
Send one message and wait one turn — the indexer runs after the first ingest.

**Duplicate facts after re-running a script**

All scripts check for duplicates before inserting. Re-running is safe. If you see unexpected duplicates, check whether the same data exists under a different `original_id` in the migration metadata — this can happen if source IDs changed between runs.

**Agent routed to wrong database**

ClawText and MEMORY.md scripts infer agent identity from workspace paths and content. If an agent was misidentified, re-run with `--agent <correct-id>` — the idempotency check skips already-imported entries.

**Cognee export is empty or has unexpected format**

Cognee's search API behavior varies by backend and version. Try querying with a specific term instead of `"*"`, or export directly from the underlying database (SQLite at `~/.cognee/` by default). Adapt the `text` field extraction in the import script to match your export structure.

**Mem0 export job returns incomplete data**

The export job is async. If `get_memory_export()` returns partial results, the job wasn't finished. Add a poll loop:
```python
import time
while True:
    data = client.get_memory_export(memory_export_id=export_id)
    if data.get('status') == 'completed': break
    time.sleep(3)
```
Alternatively use `get_all()` which is synchronous.

**Zep self-hosted: graph search returns 404**

Graph search requires the Zep server to have processed at least one session. If the graph hasn't been built yet, skip the graph export step — session messages are the higher-value data anyway.

**Honcho conclusions endpoint returns 404**

The conclusions API path varies by Honcho version. Check `GET /v1/apps/{app_id}/users/{user_id}/metamessages` as an alternative — Honcho's user model is sometimes stored there. If neither works, export directly from the Honcho Postgres database (`honcho.metamessages` table).

**memory-lancedb export: `lancedb` not installed**

```bash
pip install lancedb
```
If you don't have Python, the LanceDB files are Arrow IPC format — readable with any Arrow-compatible tool. The table names map directly to agent IDs.

**QMD extra paths not appearing after migration**

hypermem does not pick up `memory.qmd.paths` automatically. Use the `import-qmd-extras.mjs` script from the [QMD section](#from-qmd) to import those directories manually.
