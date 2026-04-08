# Slash Commands

hypermem supports operator-defined slash commands that hook into session lifecycle management. These are not built into the core runtime — they are wiring points you implement in your OpenClaw plugin or agent config.

---

## `/fresh` — Start an Unwarmed Session

Flushes the current session's Redis hot cache and starts fresh. Long-term memory (facts, vectors, episodes, knowledge graph) is preserved and will re-warm naturally on the next bootstrap.

**Use case:** A user wants to start a new conversation without any session warmth bleeding in from a previous context.

### What gets cleared

| Slot | Cleared |
|---|---|
| `system` | ✅ |
| `identity` | ✅ |
| `history` | ✅ |
| `window` | ✅ |
| `cursor` | ✅ |
| `context` | ✅ |
| `facts` | ✅ |
| `tools` | ✅ |
| `meta` | ✅ |
| Active sessions set | ✅ |
| SQLite facts / knowledge | ❌ preserved |
| Vector store | ❌ preserved |
| Episodes | ❌ preserved |
| Knowledge graph | ❌ preserved |

### Wiring it in (OpenClaw plugin)

```typescript
import { flushSession } from 'hypermem';
import type { RedisLayer } from 'hypermem';

// In your slash command handler:
if (input.trim() === '/fresh') {
  const result = await flushSession(redis, agentId, sessionKey);

  if (result.success) {
    return `Session cache cleared. Starting fresh — long-term memory is preserved.\nFlushed at: ${result.flushedAt}`;
  } else {
    return `Failed to flush session: ${result.error}`;
  }
}
```

### Using the `SessionFlusher` class

If you need a bound helper (e.g. inside an agent that always operates as a fixed agentId):

```typescript
import { SessionFlusher } from 'hypermem';

const flusher = new SessionFlusher(redis, 'my-agent');

// Later, when /fresh is received:
const result = await flusher.flush(sessionKey);
```

### Aliases

You may want to register multiple names for the same command:

```
/fresh
/newsession
/clearcache
/restart
```

All of these are just convention. hypermem does not register slash command names — that is up to your OpenClaw plugin config.

---

## Planned Commands

| Command | Status | Description |
|---|---|---|
| `/fresh` | ✅ Available | Flush hot cache, preserve long-term memory |
| `/memory` | planned | Show what hypermem currently has in context |
| `/forget <topic>` | planned | Suppress a topic from future context injection |
| `/recall <query>` | planned | Manually trigger a vector search and display results |

---

## See Also

- [TUNING.md](./TUNING.md) — full operator knobs reference
- [MIGRATION.md](./MIGRATION.md) — schema version compatibility table
- `SessionFlusher` and `flushSession` exports in `src/session-flusher.ts`
