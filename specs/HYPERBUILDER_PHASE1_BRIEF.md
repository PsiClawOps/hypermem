# HyperBuilder Task Brief — Turn DAG Phase 1: Context Heads

**Project:** HyperMem
**Root:** `/home/lumadmin/.openclaw/workspace/repo/hypermem`
**Phase:** 1 of 5 (Turn DAG Migration)
**Spec:** `specs/TURN_DAG_MIGRATION_SPEC.md`
**Priority:** P0

## Objective

Introduce the `contexts` table and context head pointer system without changing live read semantics. After this phase, every active session has an explicit active context with a head pointer, and new writes populate `context_id` on messages.

This is **structural plumbing only**. No read-path changes, no compositor changes, no DAG traversal. Just wire up the data model so Phases 2-3 have a foundation.

## Prior Work (Do Not Redo)

Phase 0 fence enforcement is already shipped and live:
- `getRecentMessages()` and `getRecentMessagesByTopic()` accept `minMessageId` floor
- `compose()` resolves `fenceMessageId` from compaction_fences
- Fence flows through `getHistory()`, `buildKeystones()`, `getKeystonesByTopic()`, `warmSession()`, `refreshRedisGradient()`
- All fence lookups are best-effort try/catch

**Do not modify Phase 0 code.** Build on top of it.

## ClawMap Dependency Analysis

### message-store.ts consumers (4 importers)

| Consumer | Methods Used |
|---|---|
| compositor.ts | `getConversation`, `getRecentMessages`, `getRecentMessagesByTopic` |
| background-indexer.ts | (imports MessageStore) |
| spawn-context.ts | `getRecentTurns` |
| index.ts | `getOrCreateConversation`, `getConversation`, `recordMessage`, `searchMessages` (+ reexport) |

### Key call edges for Phase 1

**Write paths (these need context_id population):**
- `HyperMem.recordUserMessage` → `MessageStore.getOrCreateConversation` + `MessageStore.recordMessage`
- `HyperMem.recordAssistantMessage` → `MessageStore.getConversation` + `MessageStore.recordMessage`

**Read paths (NO changes in Phase 1, but reference for validation):**
- `Compositor.compose` → `MessageStore.getConversation` + `MessageStore.getRecentMessages`
- `Compositor.getHistory` → `MessageStore.getConversation` + `MessageStore.getRecentMessages` + `MessageStore.getRecentMessagesByTopic`
- `Compositor.warmSession` → `MessageStore.getConversation` + `MessageStore.getRecentMessages`
- `Compositor.refreshRedisGradient` → `MessageStore.getConversation` + `MessageStore.getRecentMessages`

### Compositor complexity note

`Compositor.compose` is the largest community in ClawMap: 155 symbols, 249 internal edges. **Phase 1 does not touch the compositor.** All compositor changes are deferred to Phase 3.

## Schema Changes

### New table: contexts

```sql
CREATE TABLE IF NOT EXISTS contexts (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  conversation_id INTEGER REFERENCES conversations(id),
  head_message_id INTEGER REFERENCES messages(id),
  parent_context_id INTEGER REFERENCES contexts(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contexts_active_session
  ON contexts(agent_id, session_key, status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_contexts_head
  ON contexts(head_message_id);
```

### New column on messages

```sql
ALTER TABLE messages ADD COLUMN context_id INTEGER REFERENCES contexts(id);
```

### Schema migration strategy

Use the same `ensureXxxSchema()` pattern HyperMem uses elsewhere (see `ensureCompactionFenceSchema` in `compaction-fence.ts`). Create an `ensureContextSchema(db)` function that:
1. Checks if `contexts` table exists (pragma table_info or try/catch)
2. Creates table + indexes if missing
3. Checks if `messages.context_id` column exists
4. Adds column if missing
5. Is idempotent and safe to call on every startup

## Implementation Tasks

### Task 1: Context schema module

Create `src/context-store.ts` with:

- `ensureContextSchema(db: DatabaseSync): void`
- `interface Context { id: number; agentId: string; sessionKey: string; conversationId: number; headMessageId: number | null; parentContextId: number | null; status: 'active' | 'archived' | 'forked'; createdAt: string; updatedAt: string; metadataJson: string | null; }`
- `getActiveContext(db: DatabaseSync, agentId: string, sessionKey: string): Context | null`
- `getOrCreateActiveContext(db: DatabaseSync, agentId: string, sessionKey: string, conversationId: number): Context`
- `updateContextHead(db: DatabaseSync, contextId: number, headMessageId: number): void`
- `archiveContext(db: DatabaseSync, contextId: number): void`

All functions take `db: DatabaseSync` as first arg (same pattern as compaction-fence.ts).

### Task 2: Wire context creation into conversation creation

In `message-store.ts`, `getOrCreateConversation()`:
- After creating a new conversation, also call `getOrCreateActiveContext()` with the new conversation ID
- If conversation already exists, ensure an active context exists for it (lazy migration for existing conversations)
- Return context alongside conversation, OR store on instance for downstream use

### Task 3: Wire context_id into message writes

In `message-store.ts`, `recordMessage()`:
- Accept optional `contextId?: number` parameter
- When provided, set `context_id = ?` in the INSERT
- When a message is inserted, call `updateContextHead()` with the new message ID

### Task 4: Wire the caller chain

In `index.ts`:
- `recordUserMessage`: resolve active context after getOrCreateConversation, pass contextId to recordMessage, update head
- `recordAssistantMessage`: same pattern

### Task 5: Backfill existing conversations

Create `src/context-backfill.ts` with:
- `backfillContexts(db: DatabaseSync): { created: number; skipped: number }`
- For each conversation in `conversations` table that has no matching active context, create one
- Set `head_message_id` to the max message ID in that conversation
- This is a one-time migration that runs on startup (gated by "contexts table empty" check)

### Task 6: Schema initialization hook

In `index.ts`, during HyperMem initialization:
- Call `ensureContextSchema(db)` alongside existing schema init calls
- After schema init, run `backfillContexts(db)` if contexts table is empty
- Log backfill results

## Testing

### Type check
```bash
cd /home/lumadmin/.openclaw/workspace/repo/hypermem && npx tsc --noEmit
```

### Invariant tests (write assertions in test file)

Create `test/context-store.test.ts`:

1. **Schema creation is idempotent** — call `ensureContextSchema` twice, no errors
2. **getOrCreateActiveContext creates new** — given (agent, session, conv), creates context with correct fields
3. **getOrCreateActiveContext returns existing** — second call returns same context
4. **updateContextHead** — updates head_message_id and updated_at
5. **archiveContext** — sets status to 'archived', active unique index allows a new active context for same session
6. **Backfill** — create 3 conversations with messages, run backfill, verify 3 contexts with correct heads

### Prompt regression test

After all changes, verify that `compose()` output is identical. The easiest way: the existing test suite should still pass with no output changes, since Phase 1 makes no read-path changes.

```bash
cd /home/lumadmin/.openclaw/workspace/repo/hypermem && npm test
```

## Constraints

- **Do not modify compositor.ts** — compositor changes are Phase 3
- **Do not modify compaction-fence.ts** — Phase 0 is done
- **Do not delete any messages or conversations** — this is additive
- **All new functions must be idempotent** — safe to run on every startup
- **Preserve all existing behavior** — this phase adds infrastructure, does not change outputs
- **Use `DatabaseSync` from `node:sqlite`** — same as the rest of the codebase
- **Follow existing code patterns** — see compaction-fence.ts for the module structure template

## Acceptance Criteria

1. `contexts` table exists after startup with correct schema
2. Every active conversation has exactly one active context row
3. New messages have `context_id` set and head pointer updated
4. `tsc --noEmit` passes
5. All existing tests pass with no output changes
6. New context-store tests pass
7. No changes to compositor or read paths

## Files Likely Touched

| File | Change Type |
|---|---|
| `src/context-store.ts` | **NEW** — context schema, CRUD, types |
| `src/context-backfill.ts` | **NEW** — one-time migration |
| `src/message-store.ts` | MODIFY — wire context into conversation creation + message writes |
| `src/index.ts` | MODIFY — schema init, backfill hook, caller chain for context |
| `test/context-store.test.ts` | **NEW** — unit tests |

**Do NOT touch:** `src/compositor.ts`, `src/compaction-fence.ts`, any files outside the list above.
