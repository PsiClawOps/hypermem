# HyperMem: Agent Migration Reference

_Written for agents handling migration tasks. If your operator is asking "will I lose my memory data?" or "how do I move my existing setup to HyperMem?" — this is your reference._

---

## What to understand first

HyperMem has four storage layers. Migration maps an operator's existing data into one or more of them:

```
L1  Redis         Hot cache — ephemeral, rebuilt automatically. Never migrated.
L2  Messages DB   Per-agent conversation history. SQLite, one DB per agent.
L3  Vectors DB    Semantic index. Rebuilt from L2 by the background indexer.
                  Never migrated directly — write to L2, indexer handles L3.
L4  Library DB    Fleet-wide structured knowledge. One shared SQLite DB.
                  Facts, episodes, knowledge entries, preferences live here.
```

**The practical consequence:** migration means writing into L2 and/or L4. L1 and L3 rebuild themselves. You don't touch them.

---

## L4: The data model in detail

L4 (`library.db`) is where most migrations land. Understanding what each collection is for — and what each field actually does — is the difference between a useful import and noise.

### Facts

The primary home for anything the agent should *remember*.

```sql
facts (
  agent_id        TEXT    -- which agent owns this. use the agent's id string.
  scope           TEXT    -- 'agent' (default) or 'org' (fleet-wide shared)
  domain          TEXT    -- free-form category. drives retrieval filtering.
  content         TEXT    -- the fact itself. complete declarative sentence.
  confidence      REAL    -- 0.0–1.0. below 0.3 rarely surfaces. 0.8–0.9 for verified data.
  visibility      TEXT    -- 'private' (default) or 'shared'
  source_type     TEXT    -- 'conversation' | 'migration' | 'operator' | 'system'
  source_ref      TEXT    -- original ID from source system (for dedup tracking)
  created_at      TEXT    -- ISO 8601
  expires_at      TEXT    -- optional TTL. useful for time-sensitive facts.
  superseded_by   INT     -- FK to a newer fact that replaces this one
  decay_score     REAL    -- managed by HyperMem. leave at 0.0 on import.
)
```

**Domain values that work well:** `preference`, `decision`, `architecture`, `product`, `user`, `infrastructure`, `process`, `constraint`. These aren't enforced — pick whatever clusters usefully for retrieval.

**Content quality matters.** "dark mode" is a bad fact. "User prefers dark mode in all UIs and tool interfaces" is a good one. Complete sentences retrieve better than fragments because the vector embedding has more signal to work with.

**confidence:** Use 0.8–0.9 for facts migrated from a system the operator actively maintained. Use 0.5–0.7 for inferred or low-signal entries. Don't import everything at 1.0 — that flattens the ranking signal HyperMem uses to decide what surfaces.

**scope:** Almost everything should start as `agent`. Only use `org` for facts that genuinely apply fleet-wide — operator identity, shared constraints, org-level preferences. Broad `org`-scoped imports pollute every agent's context.

**superseded_by:** You don't need to set this on import. It's used when HyperMem detects a newer fact that updates an older one. Leave null.

---

### Knowledge

Structured reference data — things that get *looked up* rather than *recalled*.

```sql
knowledge (
  agent_id    TEXT    -- agent scope, or null for fleet-wide reference
  domain      TEXT    -- namespace (e.g. 'project', 'tool', 'config')
  key         TEXT    -- identifier within domain. domain+key is unique.
  value       TEXT    -- the content. markdown, JSON, or plain text.
  visibility  TEXT    -- 'private' | 'shared'
  created_at  TEXT
  updated_at  TEXT
)
```

Use knowledge for: project specs, tool documentation, architecture references, config schemas. The `domain`/`key` structure lets agents retrieve a specific entry directly (`SELECT ... WHERE domain='project' AND key='hypermem'`) rather than through semantic search.

Use facts for: things that are true about the operator or their environment. Use knowledge for: things that describe systems, tools, or processes.

---

### Episodes

Significant events with timeline importance.

```sql
episodes (
  agent_id        TEXT
  session_key     TEXT    -- session where this happened
  title           TEXT    -- short description
  content         TEXT    -- full episode narrative
  impact_score    REAL    -- 0.0–1.0. high-impact episodes surface more often.
  participant_ids TEXT    -- JSON array of agent IDs involved
  created_at      TEXT
)
```

Use episodes for: "shipped v2.0 of hypermem", "production outage on 2026-03-15", "operator switched primary model from GPT-5.4 to Claude Sonnet". These are events, not facts. The distinction matters for retrieval — episodes surface when recent context suggests timeline relevance, facts surface when semantic content matches.

Most migration sources don't have a direct episode equivalent. Don't force non-event data into episodes. If you're unsure, use facts.

---

### Preferences

Operator behavioral patterns — a specialized facts table with tighter structure.

```sql
preferences (
  agent_id    TEXT
  key         TEXT    -- the preference identifier
  value       TEXT    -- the preference value
  confidence  REAL
  source      TEXT
  created_at  TEXT
  updated_at  TEXT
)
```

These are often better modeled as facts with `domain='preference'`. Use the preferences table only if the source system has an explicit preference/setting structure that maps cleanly. Otherwise, import as facts.

---

## Mapping common source formats

### OpenClaw built-in memory.db

```
memories table:
  content       → facts.content
  type          → facts.domain  (fact/preference/decision map directly)
  priority      → facts.confidence  (already 0–1)
  source        → facts.source_type
  is_pinned     → if 1, boost confidence to 0.95
  metadata      → facts.source_ref (store original ID for dedup)
  created_at    → facts.created_at  (unix ms → ISO 8601)
```

Agent scoping: `memory.db` has no agent column. All entries belong to whoever was running at the time. Ask the operator which agent to assign them to, or default to `main`. For multi-agent setups, duplicate high-signal facts to each relevant agent rather than importing all to `org` scope.

Script available: `scripts/migrate-memory-db.mjs` — handles the timestamp conversion and dedup automatically.

---

### ClawText session-intelligence.db

```
conversations table → L2 messages.db conversations table
messages table      → L2 messages.db messages table
  role              maps directly (user/assistant/system/tool/toolResult)
  content           → text_content
  token_count       → token_count
  message_index     → message_index
  created_at        → created_at
```

L3 vector embeddings will be rebuilt automatically by the background indexer after import. Don't try to migrate embeddings — they're model-specific and will be stale if the embedding model changed.

Agent identification: ClawText doesn't store agent_id on messages. The migration script infers agent from CLAWPTIMIZATION identity anchors in the first message of each conversation. If a conversation can't be identified, it goes to `main`. This is correct behavior — don't override it unless you have a better signal.

Script available: `scripts/migrate-clawtext.mjs`

---

### MEMORY.md + daily checkpoint files

These files follow the pattern: `workspace-{agent}/*/memory/YYYY-MM-DD.md`, bullet-point entries.

```
bullet item text  → facts.content
filename date     → facts.created_at
workspace path    → facts.agent_id  (extracted from directory name)
```

Filtering matters here. Daily files contain a mix of useful facts and operational noise (commit hashes, test counts, "gateway restarted"). Apply these filters before importing:
- Skip lines shorter than 40 characters
- Skip lines that are only `→ memory_search(...)` pointers
- Skip lines that look like code (start with backtick, contain `()`, etc.)
- Skip lines that start with `#`, `---`, or are pure section headers

Script available: `scripts/migrate-memory-md.mjs` — filters are built in.

If the operator has a custom MEMORY.md format (not the standard bullet-point daily pattern), read the actual files and map manually. The filtering heuristics above still apply.

---

### Mem0-style systems

Mem0 and similar OSS memory systems typically look like:

```json
{
  "memory": "User prefers Python over JavaScript for scripting tasks",
  "user_id": "ragesaq",
  "agent_id": "main",
  "metadata": { "category": "preference", "created_at": "2026-01-15T10:00:00Z" }
}
```

Maps to:
```
memory          → facts.content
user_id         → (confirm with operator — usually ignore, use agent_id)
agent_id        → facts.agent_id
metadata.category → facts.domain
metadata.created_at → facts.created_at
```

No script exists for this format. Write a short import script following the pattern in `scripts/migrate-memory-db.mjs`. The core loop is under 30 lines.

---

### Custom JSON / YAML knowledge files

Operators sometimes maintain project context, tool configs, or reference docs as structured files. These belong in the knowledge table, not facts.

```json
// Example: project-context.json
{
  "project": "hypermem",
  "description": "4-layer context engine for OpenClaw",
  "stack": "Node.js 22, SQLite, Redis 7, nomic-embed-text",
  "status": "production"
}
```

Maps to:
```
domain = 'project'
key    = 'hypermem'
value  = JSON.stringify(entry) or markdown-formatted equivalent
```

For documentation files (markdown specs, architecture docs), use `DocChunkStore` to index them as searchable document chunks rather than single knowledge entries. That enables semantic search over the document content rather than just exact retrieval.

---

## The programmatic path

For small migrations (< a few hundred entries) or custom formats without a script, use the HyperMem API directly:

```javascript
import { createHyperMem } from '@psiclawops/hypermem';

const hm = await createHyperMem();

// Import a fact
await hm.addFact('agent-id', 'User prefers aggressive context pruning', {
  domain: 'preference',
  confidence: 0.9,
  source_type: 'migration',
  source_ref: 'original-system-id-123',  // for dedup tracking
});
```

For bulk imports (thousands of entries), write directly to SQLite — it's 10–50x faster than the API for batch writes. Follow the pattern in `scripts/migrate-memory-db.mjs`: open the library.db directly, prepare statements outside the loop, use a transaction wrapper.

After any programmatic import, restart the gateway to trigger the background indexer:
```bash
openclaw gateway restart
```

---

## What to do if you're unsure where something belongs

Ask: is this something the agent should *remember* (facts), *look up* (knowledge), or something that *happened* (episodes)?

When still unsure: use facts. They're the most flexible — good confidence scores, useful domain labels, and complete content sentences will get the data retrieved correctly regardless of which exact table it was in.

Don't import noise to be safe. Low-signal entries raise the retrieval floor and reduce the quality of everything that surfaces. It's better to import 50 high-quality facts than 500 mediocre ones.

---

## Common operator questions

**"Will my agent forget everything when I switch to HyperMem?"**
No. HyperMem doesn't touch existing memory data. The migration is additive — run the relevant script, restart the gateway, and the agent has access to both new HyperMem-native memory and the imported history.

**"Do I have to migrate everything at once?"**
No. HyperMem starts building its own memory from the first session. Historical data can be migrated at any time, before or after the switch. The scripts are idempotent — re-running them won't duplicate data.

**"What about my MEMORY.md files — does HyperMem replace them?"**
For agents using HyperMem, MEMORY.md becomes a priming index only — a short file that orients the agent at session start. The actual facts and history live in HyperMem. The migration script extracts the substantive content from daily files and imports it as facts so nothing is lost.

**"What if my memory format doesn't match any of these patterns?"**
Read this doc, look at the operator's actual data, and write a short import script. The core pattern is always: open source, open target (library.db or messages.db), loop, insert with dedup check. The scripts in `scripts/` are all under 200 lines and follow the same structure.

**"How long does migration take?"**
The scripts run in seconds to minutes depending on data volume. The background indexer (building vector embeddings) runs asynchronously after the gateway restarts — that can take several minutes for large imports. The agent is usable immediately; recall quality improves as indexing completes.
