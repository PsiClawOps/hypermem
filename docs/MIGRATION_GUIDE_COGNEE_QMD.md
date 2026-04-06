# HyperMem Migration Guide: Cognee and QMD

_Migration paths for teams switching to HyperMem from Cognee or the OpenClaw QMD memory backend._

---

## Table of Contents

- [From Cognee](#from-cognee)
- [From QMD](#from-qmd)

---

## From Cognee

Cognee is a Python-based ECL (Extract, Cognify, Load) memory engine that stores knowledge in a graph database + vector store combination. HyperMem is a Node.js context engine native to OpenClaw. These are parallel approaches to the same problem, not the same system — so this is a data migration, not a drop-in swap.

### What maps to what

| Cognee concept | HyperMem equivalent |
|---|---|
| Knowledge graph nodes (entities) | Facts (`facts` table in `library.db`) |
| Graph relationships / triplets | Knowledge entries (`knowledge` table) |
| Vector embeddings | Regenerated automatically by the HyperMem indexer |
| Session memory | Per-agent message history (`messages.db` per agent) |
| Permanent memory | Facts + knowledge in `library.db` |
| User/tenant scoping | Agent scoping (`agent_id` on all records) |

**What migrates:** entities, facts, relationships expressed as text, conversation history if stored in Cognee's session layer.

**What does not migrate:** raw graph structure (edges, weights), Cognee's memify feedback loop state, embeddings (regenerated automatically after import).

### Pre-flight

1. Confirm HyperMem is installed and has initialized at least once (run the gateway, send one message):
   ```bash
   ls ~/.openclaw/hypermem/library.db
   ```

2. Export your Cognee data. Cognee stores data in whichever graph/vector backend you configured (default: SQLite + local vector store). The export path depends on your Cognee backend:

   **Default SQLite backend:**
   ```python
   # export_cognee.py
   import asyncio
   import cognee
   import json

   async def main():
       # Export all dataset nodes and their properties
       results = await cognee.search("*", query_type="CHUNKS")
       with open("cognee_export.json", "w") as f:
           json.dump([r.__dict__ if hasattr(r, '__dict__') else str(r) for r in results], f, indent=2, default=str)
       print(f"Exported {len(results)} entries")

   asyncio.run(main())
   ```

   For graph backends (Neo4j, Memgraph), export via their native query interfaces instead and produce a flat JSON list of `{ text, source, type }` objects.

3. Back up your Cognee data directory before proceeding:
   ```bash
   cp -r ~/.cognee ~/.cognee.pre-hypermem-migration
   ```

### Import

HyperMem does not ship a Cognee-specific import script because Cognee's storage format varies by backend and version. Use the generic fact import path:

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
process.exit(0);
```

Run dry-run first:
```bash
node import-from-cognee.mjs main cognee_export.json
```

Then apply:
```bash
node import-from-cognee.mjs main cognee_export.json --apply
```

### Switch the context engine

Once import is verified, disable Cognee (stop the Cognee process / MCP server if running) and set HyperMem as the active context engine:

```bash
openclaw config set plugins.slots.contextEngine hypermem
openclaw gateway restart
```

Cognee and HyperMem do not conflict at runtime — Cognee is a separate process. But there is no reason to run both; pick one.

### Verify

After restart, ask your agent to recall something that was in Cognee. If the first session comes back cold, the background indexer is still building embeddings from the imported facts — send one message and wait one turn. It runs automatically.

```bash
# Check imported fact count
node -e "
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');
const db = new DatabaseSync(path.join(os.homedir(), '.openclaw/hypermem/library.db'), { readOnly: true });
const r = db.prepare(\"SELECT agent_id, COUNT(*) as cnt FROM facts WHERE source='cognee-migration' GROUP BY agent_id\").all();
r.forEach(x => console.log(x.agent_id + ': ' + x.cnt + ' imported facts'));
db.close();
"
```

---

## From QMD

QMD is the OpenClaw local-first memory sidecar — it runs behind `plugins.slots.memory = "memory-core"` with `memory.backend = "qmd"`. HyperMem replaces the entire context engine, so this migration is a slot change: from `slots.memory` (memory-core/QMD) to `slots.contextEngine` (HyperMem).

### What maps to what

| QMD concept | HyperMem equivalent |
|---|---|
| Workspace memory files (`MEMORY.md`, `memory/*.md`) | Still used — HyperMem reads these files directly during bootstrap |
| QMD per-agent collections | Per-agent message stores + library.db facts |
| BM25 + vector hybrid search | FTS5 + nomic-embed-text vector search in library.db |
| Reranking (QMD query mode) | Not currently implemented — HyperMem uses MMR-style diversification instead |
| Extra indexed paths (`memory.qmd.paths`) | Not yet supported — tracked in KNOWN_LIMITATIONS.md |
| Session transcript indexing | Covered natively — HyperMem indexes all agent message history |
| Automatic fallback to builtin | Not applicable — HyperMem is the engine, there is no fallback slot |

**Key difference:** QMD is a search sidecar — it augments what the agent receives. HyperMem owns the entire context assembly pipeline. The scope is different; QMD is additive, HyperMem is authoritative.

### Pre-flight

1. Confirm what QMD has indexed:
   ```bash
   ls ~/.openclaw/agents/<agentId>/qmd/
   ```

2. Your `MEMORY.md` and `memory/*.md` files are the primary source of truth. HyperMem will ingest these on bootstrap. No export needed for file-based memory.

3. If you used `memory.qmd.paths` to index extra directories, note those paths — HyperMem does not pick them up automatically yet. Copy key content into `MEMORY.md` or daily files before switching.

4. If you used QMD session indexing (`memory.qmd.sessions.enabled: true`), HyperMem will handle session history natively going forward, but historical transcripts from QMD's session export directory are not auto-imported. For important historical sessions, add a summary to a daily memory file:
   ```
   memory/YYYY-MM-DD.md
   ```

### Switch

Remove the QMD/memory-core config and enable HyperMem:

```bash
# Disable the memory slot (memory-core + QMD)
openclaw config set plugins.slots.memory none

# Enable HyperMem context engine
openclaw config set plugins.slots.contextEngine hypermem

# Remove QMD backend config if set
openclaw config unset agents.defaults.memory

openclaw gateway restart
```

QMD collections under `~/.openclaw/agents/<agentId>/qmd/` are left in place — HyperMem does not touch them. Delete manually when you are satisfied the migration is complete.

### After restart

HyperMem bootstraps on first use and reads your workspace memory files. The background indexer then builds facts and vector embeddings from your MEMORY.md and daily files. This is the same data QMD was indexing — no separate import step needed.

If you had important content in extra QMD paths that you did not copy to memory files, import it manually as facts:

```js
// import-qmd-extras.mjs
import { createHyperMem } from '@psiclawops/hypermem';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
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
  // Split into paragraphs, import each substantive one as a fact
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

### Verify

```bash
openclaw memory status   # should now say: context engine: hypermem

# Or check directly
node -e "
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');
const db = new DatabaseSync(path.join(os.homedir(), '.openclaw/hypermem/library.db'), { readOnly: true });
const r = db.prepare(\"SELECT COUNT(*) as cnt FROM facts\").get();
console.log('Total facts indexed:', r.cnt);
db.close();
"
```

### Capability gaps vs QMD

If you relied on features QMD provides that HyperMem does not yet cover:

| QMD feature | Status in HyperMem |
|---|---|
| Reranking (cross-encoder) | Not implemented. Tracked for future release. |
| Extra path indexing | Not implemented. Use manual fact import as workaround. |
| Session transcript search | Covered natively — all message history is indexed. |
| BM25 hybrid search | Covered — FTS5 + vector hybrid with configurable weights. |
| Automatic fallback to builtin | Not applicable — HyperMem does not fall back. |
| Scope rules (DM-only search) | Not applicable — HyperMem controls full context assembly. |

---

## Rollback (both paths)

HyperMem does not modify Cognee or QMD data. To roll back:

```bash
# Remove HyperMem context engine
openclaw config unset plugins.slots.contextEngine

# Restore QMD/memory-core (if that's where you came from)
openclaw config set plugins.slots.memory memory-core
openclaw config set agents.defaults.memory.backend qmd   # if you were using QMD

openclaw gateway restart
```

Your Cognee data directory and QMD collections are untouched.
