# HyperMem Migration Guide

_Upgrading to HyperMem from an existing memory system._

---

## Overview

HyperMem is a drop-in context engine for OpenClaw. Installing it does not delete or overwrite any existing memory data. Your previous system keeps running until you switch the plugin over — and even after you switch, historical data from your old system can be imported at any time.

This guide covers four migration paths:

| Your current setup | Migration path |
|---|---|
| No memory system (or starting fresh) | [Fresh install](#fresh-install) — just install and go |
| OpenClaw built-in memory (`memory.db`) | [From OpenClaw memory.db](#from-openclaw-memorydb) |
| ClawText context engine | [From ClawText](#from-clawtext) |
| Markdown MEMORY.md + daily files | [From MEMORY.md files](#from-memorymd-files) |
| Custom context engine or other system | [From a custom system](#from-a-custom-system) |
| HyperMem 0.3.x or earlier (with Redis) | [From Redis to SQLite cache](#from-redis-to-sqlite-cache) |

---

## What HyperMem stores

Understanding the data model helps set expectations about what can and cannot be migrated.

**What migrates cleanly:**
- Conversation history (messages with roles, content, timestamps)
- Facts and preferences extracted from past conversations
- Structured knowledge entries

**What cannot be migrated:**
- The L1 hot cache — this is ephemeral by design (in-memory SQLite) and rebuilds automatically on first use
- Embeddings — HyperMem will regenerate them from imported text during the next indexer run
- Tool call payloads from old sessions where only the text content was stored (tool results are preserved as prose where available)

After migration, the background indexer picks up imported history and begins building vector search, topic maps, and knowledge synthesis automatically. You do not need to trigger this manually — a gateway restart is sufficient.

---

## Pre-flight checklist

Before running any migration:

1. **Confirm HyperMem is installed:**
   ```bash
   openclaw plugins list | grep hypermem
   ```

2. **Back up your existing data** (takes seconds):
   ```bash
   cp ~/.openclaw/memory.db ~/.openclaw/memory.db.pre-hypermem-migration
   # If using ClawText:
   cp ~/.openclaw/workspace/.clawtext/session-intelligence.db \
      ~/.openclaw/workspace/.clawtext/session-intelligence.db.pre-hypermem-migration
   ```

3. **Run a dry-run first.** Every migration script defaults to `--dry-run`. Nothing is written until you add `--apply`. Read the dry-run output before proceeding.

4. **You do not need to stop the gateway** for import-only migrations. HyperMem uses WAL mode for all SQLite writes. Live sessions and imports coexist safely.

---

## Fresh install

Nothing to migrate. Install the plugin and restart the gateway:

```bash
openclaw plugins install clawhub:hypermem
openclaw gateway restart
```

HyperMem will begin building context from your first conversation. The background indexer starts automatically.

---

## From OpenClaw memory.db

OpenClaw's built-in memory system stores facts, preferences, and context entries in `~/.openclaw/memory.db`. This script imports those entries as facts into HyperMem's knowledge store.

**Step 1: Dry run**
```bash
node scripts/migrate-memory-db.mjs --agent main
```

Review the output. It will show how many facts were found, categorized by type (fact, preference, context).

**Step 2: Import**
```bash
node scripts/migrate-memory-db.mjs --agent main --apply
```

**Step 3: Restart the gateway**
```bash
openclaw gateway restart
```

The background indexer will pick up the imported facts and build embeddings on its next run.

**Options:**
```
--agent <id>         Agent to import facts for (default: main)
--memory-db <path>   Path to memory.db (default: ~/.openclaw/memory.db)
--hypermem-dir <path> HyperMem data directory (default: ~/.openclaw/hypermem)
--limit <n>          Import only first N facts (useful for testing)
--apply              Actually write data (default is dry-run)
```

**Note:** The built-in memory.db is not agent-scoped — all entries go to the agent you specify with `--agent`. If you have multiple agents using the same memory.db, run the script once per agent.

---

## From ClawText

ClawText stores full conversation history in `session-intelligence.db`. This script imports all conversations with automatic agent identification from CLAWPTIMIZATION identity anchors.

**Step 1: Dry run**
```bash
node scripts/migrate-clawtext.mjs
```

**Step 2: Import**
```bash
node scripts/migrate-clawtext.mjs --apply
```

**Step 3: Restart the gateway**
```bash
openclaw gateway restart
```

**Options:**
```
--apply              Actually write data (default is dry-run)
--limit <n>          Import only first N conversations
--clawtext-db <path> Path to session-intelligence.db (default: ~/.openclaw/workspace/.clawtext/session-intelligence.db)
--hypermem-dir <path> HyperMem data directory (default: ~/.openclaw/hypermem)
```

**What gets imported:** Full message history per conversation, routed to the correct agent database. Conversations without a detectable agent identity are routed to `main`.

**What doesn't import:** ClawText optimization logs (`.jsonl` files in agent state directories) — these are internal operational data, not conversation history.

---

## From MEMORY.md files

If your agents use the standard OpenClaw MEMORY.md + daily checkpoint pattern (`memory/YYYY-MM-DD.md`), this script scans all workspace directories and imports substantive fact entries into HyperMem.

**Step 1: Dry run (all agents)**
```bash
node scripts/migrate-memory-md.mjs
```

**Step 2: Review output.** The script will show which workspaces it found, how many facts per agent, and a sample of what it would import.

**Step 3: Import**
```bash
node scripts/migrate-memory-md.mjs --apply
```

**Or import for a single agent:**
```bash
node scripts/migrate-memory-md.mjs --agent my-agent --apply
```

**Step 4: Restart the gateway**
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

**Parsing rules:** The script imports bullet list items from daily files (`memory/YYYY-MM-DD.md`) only. MEMORY.md index files are intentionally skipped — they're pointers, not content. Lines shorter than 40 characters, pure `→ memory_search(...)` pointers, and code-like lines are also skipped.

---

## From a custom system

If you have a custom context engine or a different memory database, you can import directly using HyperMem's programmatic API.

**Import facts:**
```js
import { createHyperMem } from '@psiclawops/hypermem';

const hm = await createHyperMem({ dir: '~/.openclaw/hypermem' });

// Import a fact
await hm.addFact('your-agent-id', 'User prefers dark mode in all UIs', {
  domain: 'preference',
  source: 'migration',
  confidence: 0.9,
});
```

**Import conversation history:**
```js
// Record a user message
await hm.recordUserMessage('your-agent-id', 'session-key:your-session', 'Hello, how are you?');

// Record an assistant message (NeutralMessage format)
await hm.recordAssistantMessage('your-agent-id', 'session-key:your-session', {
  role: 'assistant',
  textContent: 'I am doing well, thank you.',
  toolCalls: [],
  createdAt: new Date().toISOString(),
});
```

**After import, restart the gateway to trigger indexing:**
```bash
openclaw gateway restart
```

For larger imports, write a script following the pattern in `scripts/migrate-clawtext.mjs` — direct SQLite writes are faster than going through the API for bulk data.

---

## From Redis to SQLite cache

_For users upgrading from HyperMem 0.3.x or earlier where Redis was the L1 hot cache._

HyperMem 0.6.0 removes Redis entirely. The L1 hot cache is now SQLite `:memory:` — in-process, zero external dependencies.

### What changed

| Component | Before (0.3.x) | After (0.6.0) |
|---|---|---|
| L1 hot cache | Redis 7+ (external service) | SQLite `:memory:` (in-process) |
| Dependency | `ioredis` in package.json | None |
| Config | `redis.host`, `redis.port` in plugin config | Not needed; cache is automatic |
| Class | `RedisLayer` | `CacheLayer` |
| Type | `RedisConfig` | `CacheConfig` (alias kept for compat) |

### Migration steps

**1. Update HyperMem:**
```bash
openclaw plugins install clawhub:hypermem@latest
```

**2. Remove Redis config from your plugin settings** (if any):
```bash
openclaw config unset plugins.config.hypermem.redis
```

**3. Stop your Redis instance** (if it was only used by HyperMem):
```bash
sudo systemctl stop redis-server
sudo systemctl disable redis-server  # optional
```

**4. Restart the gateway:**
```bash
openclaw gateway restart
```

### What happens to my data?

- **Nothing is lost.** The L1 cache was always ephemeral (session-scoped working memory). All durable data lives in SQLite (`library.db`, `hypermem.db`) and was never in Redis.
- The cache rebuilds automatically on the first message to each agent session.
- If you had custom code importing `RedisLayer`, switch to `CacheLayer`. The public interface is identical.
- The `RedisConfig` type alias still works in 0.6.0 but will be removed in 1.0.

### Code changes for plugin consumers

```typescript
// Before
import { RedisLayer, RedisConfig } from 'hypermem';
const cache = new RedisLayer(redisConfig);
await cache.connect();

// After
import { CacheLayer, CacheConfig } from 'hypermem';
const cache = new CacheLayer();  // no host/port needed
await cache.connect();  // creates in-memory SQLite
```

### Performance

SQLite `:memory:` is faster than Redis for HyperMem's access patterns: single-process, no serialization overhead, no TCP round-trips. No performance regression.

---

## Verifying the migration

After importing and restarting:

**Check fact counts:**
```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os = require('node:os');
const db = new DatabaseSync(path.join(os.homedir(), '.openclaw/hypermem/library.db'), { readOnly: true });
const rows = db.prepare(\"SELECT agent_id, COUNT(*) as cnt FROM facts GROUP BY agent_id ORDER BY cnt DESC\").all();
rows.forEach(r => console.log(r.agent_id + ': ' + r.cnt + ' facts'));
db.close();
"
```

**Check message history:**
```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
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

**Ask your agent to recall something** from the imported history. If it surfaces the information, the migration worked. If recall seems patchy in the first session, the background indexer may still be building embeddings — give it one gateway restart cycle.

---

## Rollback

HyperMem does not modify or delete any source data. To roll back:

1. Remove HyperMem from the plugin config:
   ```bash
   openclaw plugins uninstall clawhub:hypermem
   ```

2. Re-enable your previous context engine if you had one.

3. Restart the gateway:
   ```bash
   openclaw gateway restart
   ```

Your original `memory.db`, ClawText database, and MEMORY.md files are untouched.

---

## Troubleshooting

**"library.db not found" during migration**

HyperMem hasn't run yet. Start the gateway once with the plugin installed, then re-run the migration script:
```bash
openclaw gateway restart
# wait a few seconds for HyperMem to initialize
node scripts/migrate-memory-db.mjs --agent main
```

**Facts imported but agent doesn't recall them**

The background indexer builds vector embeddings on a schedule. Force a rebuild:
```bash
openclaw gateway restart
```
Then send your agent one message and wait — the indexer runs after the first ingest.

**Duplicate facts after re-running a script**

All scripts check for duplicates before inserting. Re-running is safe. If you see unexpected duplicates, check whether the same data exists under a different `original_id` in the metadata — this can happen if source IDs changed between runs.

**Agent routed to wrong database**

The ClawText and MEMORY.md scripts infer agent identity from workspace paths and content. If an agent was misidentified, you can re-run with `--agent <correct-id>` — the idempotency check will skip already-imported entries.

---

## Switching the context engine

Once migration is complete and verified, update your OpenClaw config:

```bash
openclaw config set plugins.contextEngine hypermem
openclaw gateway restart
```

Your agents will start using HyperMem for all future sessions. Historical data from the migration is immediately available for recall.
