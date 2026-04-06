# HyperMem Migration Guide

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
| Markdown MEMORY.md + daily files only | [From MEMORY.md files](#from-memorymd-files) |
| Something else / custom engine | [From a custom system](#from-a-custom-system) |

---

## What HyperMem stores

Understanding the data model sets expectations for what migrates and what doesn't.

**Migrates cleanly from most systems:**
- Conversation history (messages, roles, timestamps)
- Facts and preferences extracted from past conversations
- Structured knowledge entries

**Does not migrate (by design):**
- The Redis hot cache — ephemeral, rebuilds automatically on first use
- Embeddings — HyperMem regenerates these from imported text on the next indexer run
- Tool call payloads from sessions where only text content was stored (tool results preserved as prose where available)
- Graph structure from graph databases (edges, weights, triplets) — these are flattened to facts on import

After any migration, the background indexer picks up imported content and builds vector search, topic maps, and knowledge synthesis automatically. A gateway restart is sufficient to trigger it.

---

## Universal pre-flight checklist

Run this before any migration path.

**1. Confirm HyperMem is installed and has initialized:**
```bash
openclaw plugins list | grep hypermem
ls ~/.openclaw/hypermem/library.db   # must exist — send one message first if not
```

If `library.db` doesn't exist yet, start the gateway with HyperMem enabled, send one message to any agent, then come back:
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

**4. You do not need to stop the gateway** for import-only migrations. HyperMem uses WAL mode — live sessions and imports coexist safely.

---

## Fresh install

Nothing to migrate. Install and go:

```bash
openclaw plugins install clawhub:hypermem
openclaw gateway restart
```

HyperMem begins building context from your first conversation. The background indexer starts automatically.

---

## From OpenClaw memory.db

OpenClaw's built-in memory system stores facts, preferences, and context entries in `~/.openclaw/memory.db`. This script imports those entries as facts into HyperMem's knowledge store.

**What maps to what:**

| memory.db | HyperMem |
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
--hypermem-dir <path> HyperMem data directory (default: ~/.openclaw/hypermem)
--limit <n>           Import only first N facts (useful for testing)
--apply               Actually write data (default is dry-run)
```

> **Note:** The built-in memory.db is not agent-scoped. All entries go to the agent you specify with `--agent`. If multiple agents share the same memory.db, run the script once per agent.

---

## From QMD

QMD is the OpenClaw local-first memory sidecar — it runs behind `plugins.slots.memory = "memory-core"` with `memory.backend = "qmd"`. HyperMem replaces the entire context engine, so this is a slot change: from `slots.memory` (memory-core/QMD) to `slots.contextEngine` (HyperMem).

**Key difference:** QMD is additive — it augments what the agent receives. HyperMem is authoritative — it owns the entire context assembly pipeline. The scopes are different.

**What maps to what:**

| QMD | HyperMem |
|---|---|
| Workspace memory files (`MEMORY.md`, `memory/*.md`) | Still used — HyperMem reads these directly during bootstrap |
| Per-agent collections | Per-agent message stores + `library.db` facts |
| BM25 + vector hybrid search | FTS5 + nomic-embed-text hybrid search |
| Extra indexed paths (`memory.qmd.paths`) | Not yet supported — see capability gaps below |
| Session transcript indexing | Covered natively — all message history is indexed |
| Reranking (QMD cross-encoder) | Not implemented — HyperMem uses MMR diversification |

**Pre-flight:**

Check what QMD has indexed, and note any extra paths:
```bash
ls ~/.openclaw/agents/<agentId>/qmd/
```

If you used `memory.qmd.paths` to index extra directories, those paths are not picked up automatically. Copy key content into `MEMORY.md` or daily files before switching, or use the manual import script below.

If you used QMD session indexing (`memory.qmd.sessions.enabled: true`), HyperMem handles sessions natively going forward. Historical transcripts are not auto-imported — add summaries of important historical sessions to a daily memory file if needed.

**Switch:**
```bash
# Disable memory-core + QMD
openclaw config set plugins.slots.memory none

# Enable HyperMem
openclaw config set plugins.slots.contextEngine hypermem

# Remove QMD backend config if set
openclaw config unset agents.defaults.memory

openclaw gateway restart
```

QMD collections at `~/.openclaw/agents/<agentId>/qmd/` are untouched. Delete them manually when satisfied the migration is complete.

**After restart:** HyperMem bootstraps on first use and reads your workspace memory files. The background indexer builds facts and embeddings from `MEMORY.md` and daily files — no separate import step for file-based memory.

**If you had content in extra QMD paths**, import it manually:
```js
// import-qmd-extras.mjs
import { createHyperMem } from '@psiclawops/hypermem';
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

const hm = await createHyperMem({ dir: join(homedir(), '.openclaw/hypermem') });
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

| QMD feature | Status in HyperMem |
|---|---|
| Reranking (cross-encoder) | Not implemented. Tracked for future release. |
| Extra path indexing | Not implemented. Use manual fact import as workaround. |
| Session transcript search | Covered natively. |
| BM25 hybrid search | Covered — FTS5 + vector hybrid with configurable weights. |
| Automatic fallback to builtin | Not applicable — HyperMem does not fall back. |

---

## From ClawText

ClawText stores full conversation history in `session-intelligence.db`. This script imports all conversations with automatic agent identification from identity anchors.

**What maps to what:**

| ClawText | HyperMem |
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
--hypermem-dir <path> HyperMem data directory (default: ~/.openclaw/hypermem)
```

Conversations without a detectable agent identity are routed to `main`.

---

## From Cognee

Cognee is a Python-based ECL (Extract, Cognify, Load) memory engine that stores knowledge in a graph database + vector store. HyperMem is a Node.js context engine native to OpenClaw. This is a data migration, not a drop-in swap — the architectures are parallel approaches to the same problem.

**What maps to what:**

| Cognee | HyperMem |
|---|---|
| Knowledge graph nodes (entities) | Facts (`facts` table in `library.db`) |
| Graph relationships / triplets | Knowledge entries (`knowledge` table) |
| Vector embeddings | Regenerated automatically by the HyperMem indexer |
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

Save this as `import-from-cognee.mjs` in the HyperMem repo root:

```js
// import-from-cognee.mjs
import { createHyperMem } from '@psiclawops/hypermem';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const agentId = process.argv[2] ?? 'main';
const exportPath = process.argv[3] ?? 'cognee_export.json';
const dryRun = !process.argv.includes('--apply');

const entries = JSON.parse(readFileSync(exportPath, 'utf-8'));
const hm = await createHyperMem({ dir: join(homedir(), '.openclaw/hypermem') });

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

**Step 4: Disable Cognee and switch to HyperMem**

Stop the Cognee process / MCP server if running, then:
```bash
openclaw config set plugins.slots.contextEngine hypermem
openclaw gateway restart
```

Cognee and HyperMem do not conflict at runtime (Cognee is a separate process), but there is no reason to run both.

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
--hypermem-dir <path>    HyperMem data directory (default: ~/.openclaw/hypermem)
--limit <n>              Import only first N facts
--apply                  Actually write data (default is dry-run)
```

**Parsing rules:** Imports bullet list items from daily files (`memory/YYYY-MM-DD.md`) only. `MEMORY.md` index files are intentionally skipped — they're pointers, not content. Lines under 40 characters, `→ memory_search(...)` pointers, and code-like lines are also skipped.

---

## From a custom system

Use HyperMem's programmatic API to import directly.

**Import facts:**
```js
import { createHyperMem } from '@psiclawops/hypermem';

const hm = await createHyperMem({ dir: '~/.openclaw/hypermem' });

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

## Enabling HyperMem

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

HyperMem does not modify or delete any source data. To roll back from any path:

```bash
# Remove HyperMem context engine
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

HyperMem hasn't initialized yet. Start the gateway with the plugin enabled, send one message, then re-run:
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

**QMD extra paths not appearing after migration**

HyperMem does not pick up `memory.qmd.paths` automatically. Use the `import-qmd-extras.mjs` script from the [QMD section](#from-qmd) to import those directories manually.
