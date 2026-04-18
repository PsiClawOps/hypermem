# Tool Artifact Store

**Status:** Phase 1 (foundation) — building  
**Author:** Forge  
**Date:** 2026-04-17

## Problem

Parallel tool batches (4–6 results at 10–50k tokens each) can slam the hot
window past the ingest wave-guard's 85% threshold. The current wave-guard
response is lossy: it replaces the tool result content with a
`formatToolChainStub` placeholder. The raw payload is gone.

That means:
- the LLM cannot recover the real output later in the turn
- `recordAssistantMessage` persists the stub, not the payload, into
  `messages.tool_results` — so even SQLite has no copy
- the only signal the model gets is a summary string in the stub

## Solution — durable tool artifacts

Full tool result payloads go into a dedicated table, keyed by content hash and
assigned a stable `artifactId`. The transcript window keeps a small stub that
carries the `artifactId`. The stub is all the model sees by default; hydration
is an explicit compositor decision, not an automatic transcript rewrite.

## Scope — Phase 1

In scope:
- `tool_artifacts` SQLite table in per-agent `messages.db` (schema v9)
- `ToolArtifactStore` CRUD + dedupe by `content_hash`
- Plugin wave-guard stores full payload before stubbing (no data loss even at
  85%+ pressure)
- Stub carries `artifactId` so future hydration can resolve it
- Public API:
  - `hm.recordToolArtifact(...)`
  - `hm.getToolArtifact(artifactId)`
  - `hm.getToolArtifactsByTurn(sessionKey, turnId)`
- Unit test coverage

Out of scope (Phase 2+):
- Compositor rehydration logic
- Retention / GC policy sweep
- Sensitivity flags, secret redaction
- Cross-agent artifact sharing
- File-backed blobs for very large payloads

## Schema v9

```sql
CREATE TABLE IF NOT EXISTS tool_artifacts (
  id                 TEXT PRIMARY KEY,         -- ULID-like artifactId
  content_hash       TEXT NOT NULL,            -- sha256 of payload
  agent_id           TEXT NOT NULL,
  session_key        TEXT NOT NULL,
  conversation_id    INTEGER REFERENCES conversations(id),
  message_id         INTEGER REFERENCES messages(id),
  turn_id            TEXT,                     -- turn DAG linkage
  tool_call_id       TEXT,                     -- provider tool_use_id
  tool_name          TEXT NOT NULL,
  is_error           INTEGER NOT NULL DEFAULT 0,
  content_type       TEXT NOT NULL DEFAULT 'text/plain',
  size_bytes         INTEGER NOT NULL,
  token_estimate     INTEGER NOT NULL,
  payload            TEXT NOT NULL,            -- raw tool result content
  summary            TEXT,                     -- short stub summary (<=200 chars)
  created_at         TEXT NOT NULL,
  last_used_at       TEXT NOT NULL,
  ref_count          INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_tool_artifacts_hash
  ON tool_artifacts(content_hash);
CREATE INDEX IF NOT EXISTS idx_tool_artifacts_session
  ON tool_artifacts(agent_id, session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_artifacts_turn
  ON tool_artifacts(turn_id);
CREATE INDEX IF NOT EXISTS idx_tool_artifacts_tool_call
  ON tool_artifacts(tool_call_id);
```

Design notes:
- `id` is distinct from `content_hash`. Two identical payloads from different
  turns share a hash but have separate artifact ids. Dedupe is opportunistic —
  a `put()` that finds a matching hash+session can bump `ref_count` and return
  the existing id.
- `payload` is `TEXT` for v1. Binary / very large payloads are deferred.
- `turn_id` / `tool_call_id` let the compositor rehydrate by logical dependency
  (last tool call made, current turn scope, etc.) without walking messages.
- No `FOREIGN KEY` cascade on `messages.id` — artifact retention is independent
  of transcript eviction (by design).

## `ToolChainStub` extension

Add optional `artifactId` to the canonical stub so the transcript breadcrumb is
resolvable:

```
[tool:<name> id=<toolCallId> status=ejected reason=<reason> artifact=<artifactId> summary=<stub>]
```

`artifact=` is **optional**. Backwards-compatible: the regex accepts stubs
with or without the `artifact=` field. Existing tests keep passing.

## API shape

```ts
interface ToolArtifactRecord {
  id: string;
  contentHash: string;
  agentId: string;
  sessionKey: string;
  conversationId: number | null;
  messageId: number | null;
  turnId: string | null;
  toolCallId: string | null;
  toolName: string;
  isError: boolean;
  contentType: string;
  sizeBytes: number;
  tokenEstimate: number;
  payload: string;
  summary: string | null;
  createdAt: string;
  lastUsedAt: string;
  refCount: number;
}

interface PutArtifactInput {
  agentId: string;
  sessionKey: string;
  conversationId?: number;
  messageId?: number;
  turnId?: string;
  toolCallId?: string;
  toolName: string;
  isError?: boolean;
  contentType?: string;
  payload: string;
  summary?: string;
}

class ToolArtifactStore {
  put(input: PutArtifactInput): ToolArtifactRecord;
  get(id: string): ToolArtifactRecord | null;
  getByHash(agentId: string, sessionKey: string, hash: string):
    ToolArtifactRecord | null;
  listByTurn(sessionKey: string, turnId: string): ToolArtifactRecord[];
  listByToolCall(toolCallId: string): ToolArtifactRecord[];
  touch(id: string): void;   // updates last_used_at
  deleteOlderThan(isoCutoff: string): number;
}
```

`HyperMem` exposes:
- `recordToolArtifact(agentId, sessionKey, input): ToolArtifactRecord`
- `getToolArtifact(agentId, artifactId): ToolArtifactRecord | null`
- `listToolArtifactsByTurn(agentId, sessionKey, turnId): ToolArtifactRecord[]`

## Plugin wave-guard changes

Before v1:
- `>85%`: replace payload with stub, pair integrity preserved, payload lost
- `>70%`: truncate payload to 500 chars, pair integrity preserved, payload lost

After v1:
1. For every inbound tool_result, call `recordToolArtifact` *first* with the
   full payload. This is cheap — it's a single SQLite insert, not a hot-path
   operation.
2. Then, depending on pressure:
   - `<= 70%`: record the assistant message as-is (no stub)
   - `> 70%`: truncate payload in the stored assistant message, but include
     `artifactId` in the stub
   - `> 85%`: full stub replacement with `artifactId`
3. Telemetry: emit `degradation` event with `artifactId` so dashboards can
   correlate stub emission with artifact storage.

No payload is ever lost after this change.

## Test coverage

- put + get round-trip
- put with duplicate hash (same session) increments `ref_count`, returns same id
- put with duplicate hash (different session) creates distinct id
- `listByTurn` returns artifacts in insertion order
- `touch` updates `last_used_at`
- `deleteOlderThan` deletes stale rows and returns count
- Stub round-trip: `formatToolChainStub` + `parseToolChainStub` preserve
  `artifactId` when present, and stay backwards-compatible when absent

## Phase 2 preview (not in this build)

1. Compositor hydration: on compose-time, if the most recent tool result stub
   is within the assembly window and the turn is continuation-shaped, pull
   the full payload back *into the assembled prompt only*.
2. Retention policy job: default keep-raw for 30 days after `last_used_at`,
   sensitive artifacts get short TTL + redaction, summaries stay forever.
3. Secret scanner integration: flag artifacts whose payload tripped the
   secret scanner so retention picks them up early.
