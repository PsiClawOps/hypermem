# hypermem Context Engine Plugin — Implementation Spec

_Written by Forge (opus) for implementation by Forge (sonnet) or subagent._

## Overview

Wrap hypermem's existing compositor into an OpenClaw context engine plugin.
Plugin replaces `plugins.slots.contextEngine: "legacy"` with `"hypermem"`.

## Plugin Structure

```
hypermem/plugin/
├── package.json          # OpenClaw plugin manifest
├── src/
│   └── index.ts          # register() entry point
└── tsconfig.json
```

## package.json Manifest

```json
{
  "name": "@psiclawops/hypermem-context-engine",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "openclaw": {
    "plugin": {
      "id": "hypermem",
      "name": "hypermem Context Engine",
      "kind": "context-engine"
    }
  }
}
```

## register() Entry Point

```typescript
export default function register(api) {
  api.registerContextEngine("hypermem", () => engine);
}
```

## ContextEngine Interface Implementation

### info
```typescript
{
  id: "hypermem",
  name: "hypermem Context Engine",
  ownsCompaction: false,  // Delegate overflow to runtime initially
}
```

### ingest({ sessionId, message, isHeartbeat })
- Extract agentId from sessionId (parse `agent:<agentId>:...` format)
- Call `hm.recordMessage(agentId, sessionKey, message)` on the singleton hypermem instance
- Return `{ ingested: true }`
- Skip recording if `isHeartbeat === true`

### assemble({ sessionId, messages, tokenBudget })
- Extract agentId and sessionKey from sessionId
- Get the message DB: `hm.dbManager.getMessageDb(agentId)`
- Get the library DB: `hm.dbManager.getLibraryDb()`
- Call `compositor.compose(request, messageDb, libraryDb)` where:
  - `request.agentId = agentId`
  - `request.sessionKey = sessionKey`
  - `request.tokenBudget = tokenBudget`
  - `request.tier = agent tier from fleet store or 'standard'`
- Return `{ messages: result.messages, estimatedTokens: result.totalTokens, systemPromptAddition: result.contextBlock }`
- The `contextBlock` is the composed facts/recall/episodes/cross-session content
- **Key question:** Does `assemble()` receive the full message history in `messages` param, or does hypermem provide its own? Check OpenClaw docs — likely receives runtime messages, we augment with our composed context via `systemPromptAddition`.

### compact({ sessionId, force })
- Since `ownsCompaction: false`, call `delegateCompactionToRuntime(...)` from `openclaw/plugin-sdk/core`
- Return `{ ok: true, compacted: true }`

### afterTurn({ sessionId })
- Trigger background indexer for the agent: `indexer.processAgent(agentId)`
- Fire-and-forget (don't block the response)

## Singleton hypermem Instance

The plugin needs a single hypermem instance shared across all sessions:

```typescript
let hm: hypermem | null = null;

async function gethypermem(): Promise<hypermem> {
  if (!hm) {
    hm = await hypermem.create({
      dataDir: path.join(os.homedir(), '.openclaw/hypermem'),
      redis: { host: 'localhost', port: 6379, keyPrefix: 'hm:', sessionTTL: 86400 },
    });
  }
  return hm;
}
```

## Relationship to Existing Hook

The hook (`~/.openclaw/hooks/hypermem-core/handler.js`) currently handles:
- `message:received` → record user message
- `message:sent` → record assistant message  
- `agent:bootstrap` → warm Redis, register fleet agent
- `gateway:startup` → start background indexer

Once the context engine plugin is live:
- `ingest()` replaces `message:received`/`message:sent` handlers
- `afterTurn()` replaces the indexer startup trigger
- `agent:bootstrap` handler **stays** — fleet registration and Redis warming are bootstrap concerns
- `gateway:startup` handler **stays** — initial indexer run on startup

So the hook doesn't go away entirely — it gets slimmer. The message recording moves into the plugin, but bootstrap/startup stay in the hook.

## Config Changes

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "hypermem"
    },
    "entries": {
      "hypermem": {
        "enabled": true
      }
    }
  }
}
```

## Install Path

```bash
# During development:
openclaw plugins install -l /home/lumadmin/.openclaw/workspace/repo/hypermem/plugin

# After stabilization:
# Build and publish to npm, then: openclaw plugins install @psiclawops/hypermem-context-engine
```

## Open Questions (for implementation)

1. **Does `assemble()` receive existing messages or does the engine provide all messages?**
   - From docs: "The engine returns an ordered set of messages" — so we likely need to return the full message set, not just additions.
   - Our compositor already builds the full message array. We return that directly.

2. **How does the plugin access the existing hypermem data directory?**
   - Hardcode to `~/.openclaw/hypermem` for now. Make configurable via plugin config later.

3. **sessionId vs sessionKey format?**
   - OpenClaw passes `sessionId` (UUID). We need `sessionKey` (e.g., `agent:forge:webchat:main`).
   - May need to look up sessionKey from sessionId via Redis or session manager.
   - Check what the runtime actually passes in the `assemble` params.

## Testing Strategy

1. Unit test the plugin registration and lifecycle methods with mocked hypermem
2. Integration test: install locally, flip the slot for Forge only, run a conversation
3. Compare context output: old (legacy) vs new (hypermem) for same conversation
4. Monitor token usage — should stay within budget
5. Monitor latency — compose() adds time, should stay under 100ms
