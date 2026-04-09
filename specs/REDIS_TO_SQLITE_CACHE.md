# Redis → SQLite In-Memory Cache Migration

## Overview

Replace the `RedisLayer` class (`src/redis.ts`) with a `CacheLayer` class (`src/cache.ts`) that uses SQLite `:memory:` via `ATTACH DATABASE`. No Redis dependency. Same public interface. In-process, zero serialization overhead.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Single better-sqlite3 Connection               │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ main     │  │ msgs     │  │ cache         │  │
│  │ library  │  │ messages │  │ (in-memory)   │  │
│  │ .db      │  │ .db      │  │ :memory:      │  │
│  └──────────┘  └──────────┘  └───────────────┘  │
└─────────────────────────────────────────────────┘
```

The cache database is ATTACHed as `:memory:` to the existing library.db connection. All cache operations are synchronous in-process calls via better-sqlite3. No TCP, no serialization.

## Cache Schema (`:memory:` ATTACH'd as `cache`)

### Table: `cache.slots`

Replaces: Redis SET/GET per-slot keys

```sql
CREATE TABLE cache.slots (
  agent_id    TEXT NOT NULL,
  session_key TEXT NOT NULL,
  topic_id    TEXT NOT NULL DEFAULT '',   -- empty string = session-level
  slot_name   TEXT NOT NULL,
  value       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,          -- unix epoch seconds
  PRIMARY KEY (agent_id, session_key, topic_id, slot_name)
);
```

### Table: `cache.history`

Replaces: Redis RPUSH/LRANGE/LTRIM lists

```sql
CREATE TABLE cache.history (
  agent_id    TEXT    NOT NULL,
  session_key TEXT    NOT NULL,
  topic_id    TEXT    NOT NULL DEFAULT '',
  seq         INTEGER NOT NULL,          -- monotonic per session, from StoredMessage.id
  message     TEXT    NOT NULL,          -- JSON-serialized StoredMessage
  PRIMARY KEY (agent_id, session_key, topic_id, seq)
);
```

### Table: `cache.sessions`

Replaces: Redis HMSET/HGETALL (meta) + SADD/SMEMBERS (active sessions)

```sql
CREATE TABLE cache.sessions (
  agent_id    TEXT NOT NULL,
  session_key TEXT NOT NULL,
  meta        TEXT,                      -- JSON-serialized SessionMeta
  active      INTEGER NOT NULL DEFAULT 1,
  touched_at  INTEGER NOT NULL,          -- unix epoch seconds
  PRIMARY KEY (agent_id, session_key)
);
```

### Table: `cache.windows`

Replaces: Redis SET/GET window cache (120s TTL)

```sql
CREATE TABLE cache.windows (
  agent_id    TEXT NOT NULL,
  session_key TEXT NOT NULL,
  topic_id    TEXT NOT NULL DEFAULT '',
  messages    TEXT NOT NULL,             -- JSON array of NeutralMessage
  expires_at  INTEGER NOT NULL,
  PRIMARY KEY (agent_id, session_key, topic_id)
);
```

### Table: `cache.kv`

Replaces: remaining unstructured blobs (cursor, model_state, query_embedding, fleet cache, profile)

```sql
CREATE TABLE cache.kv (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,             -- JSON or base64
  expires_at  INTEGER NOT NULL DEFAULT 0 -- 0 = no expiry
);
```

Key patterns for kv table:
- `profile:{agentId}` — agent profile
- `cursor:{agentId}:{sessionKey}` — session cursor
- `model_state:{agentId}:{sessionKey}` — model state (budget downshift)
- `qembed:{agentId}:{sessionKey}` — query embedding (base64 Float32Array)
- `fleet:agent:{agentId}` — fleet agent cache
- `fleet:summary` — fleet summary cache

## CacheLayer Class Interface

The new `CacheLayer` class must implement EVERY public method from `RedisLayer` with the same signature. This is a drop-in replacement.

### Constructor & Lifecycle

```typescript
export class CacheLayer {
  constructor(config?: Partial<CacheConfig>);

  /**
   * Initialize the in-memory cache. Called once at startup.
   * Creates the :memory: database and ATTACHes it to the provided
   * better-sqlite3 connection. If no connection provided, creates standalone.
   *
   * IMPORTANT: This method replaces redis.connect(). It is synchronous
   * when a db connection is provided, async signature kept for interface compat.
   *
   * Returns true always (no network to fail).
   */
  async connect(db?: BetterSqliteDatabase): Promise<boolean>;

  get isConnected(): boolean;  // always true after connect()

  /**
   * Snapshot cache to disk on shutdown.
   * Called from the SIGTERM handler.
   */
  snapshot(path: string): void;

  /**
   * Load a snapshot from disk into the in-memory cache.
   * Called at startup before connect() if snapshot file exists.
   */
  loadSnapshot(path: string): boolean;

  async disconnect(): Promise<void>;  // no-op, kept for interface compat
}
```

### CacheConfig

Replaces `RedisConfig` in types.ts:

```typescript
export interface CacheConfig {
  sessionTTL: number;     // seconds — TTL for non-history slots
  historyTTL: number;     // seconds — TTL for history list
  snapshotPath?: string;  // optional path for VACUUM INTO on shutdown
}

// Defaults:
const DEFAULT_CONFIG: CacheConfig = {
  sessionTTL: 14400,      // 4 hours
  historyTTL: 86400,      // 24 hours
};
```

## Method-by-Method Mapping

Every method below MUST be implemented. The public signature stays identical (same params, same return type). Internal implementation changes from async Redis ops to synchronous SQLite ops wrapped in async for interface compat.

### Agent-Level

| RedisLayer Method | CacheLayer Implementation |
|---|---|
| `setProfile(agentId, profile)` | `INSERT OR REPLACE INTO cache.kv (key, value, expires_at) VALUES ('profile:' \|\| ?, json(?), 0)` |
| `getProfile(agentId)` | `SELECT value FROM cache.kv WHERE key = 'profile:' \|\| ? AND (expires_at = 0 OR expires_at > unixepoch())` |
| `addActiveSession(agentId, sessionKey)` | `INSERT OR REPLACE INTO cache.sessions (...) VALUES (?, ?, NULL, 1, unixepoch())` — if row exists, `UPDATE SET active = 1` |
| `removeActiveSession(agentId, sessionKey)` | `UPDATE cache.sessions SET active = 0 WHERE agent_id = ? AND session_key = ?` |
| `getActiveSessions(agentId)` | `SELECT session_key FROM cache.sessions WHERE agent_id = ? AND active = 1` |

### Session Slots

| RedisLayer Method | CacheLayer Implementation |
|---|---|
| `setSlot(agentId, sessionKey, slot, value)` | `INSERT OR REPLACE INTO cache.slots (agent_id, session_key, topic_id, slot_name, value, expires_at) VALUES (?, ?, '', ?, ?, unixepoch() + sessionTTL)` |
| `getSlot(agentId, sessionKey, slot)` | `SELECT value FROM cache.slots WHERE agent_id = ? AND session_key = ? AND topic_id = '' AND slot_name = ? AND expires_at > unixepoch()` |
| `setSessionMeta(agentId, sessionKey, meta)` | `INSERT OR REPLACE INTO cache.sessions (agent_id, session_key, meta, active, touched_at) VALUES (?, ?, json(?), COALESCE((SELECT active FROM cache.sessions WHERE ...), 1), unixepoch())` |
| `getSessionMeta(agentId, sessionKey)` | `SELECT meta FROM cache.sessions WHERE agent_id = ? AND session_key = ?` → JSON.parse |

### Session History

| RedisLayer Method | CacheLayer Implementation |
|---|---|
| `pushHistory(agentId, sessionKey, messages, maxMessages)` | Tail-dedup: `SELECT MAX(seq) FROM cache.history WHERE ...`, filter messages with id > max, `INSERT INTO cache.history` for each. Then `DELETE FROM cache.history WHERE seq NOT IN (SELECT seq ... ORDER BY seq DESC LIMIT maxMessages)` |
| `replaceHistory(agentId, sessionKey, messages, maxMessages)` | `DELETE FROM cache.history WHERE agent_id = ? AND session_key = ? AND topic_id = ''`, then INSERT all (last maxMessages) |
| `getHistory(agentId, sessionKey, limit?)` | `SELECT message FROM cache.history WHERE agent_id = ? AND session_key = ? AND topic_id = '' ORDER BY seq ASC` with optional `LIMIT` (applied as subquery: select last N by seq DESC, then re-order ASC) |
| `sessionExists(agentId, sessionKey)` | `SELECT 1 FROM cache.history WHERE agent_id = ? AND session_key = ? AND topic_id = '' LIMIT 1` |
| `trimHistoryToTokenBudget(agentId, sessionKey, tokenBudget)` | Fetch all messages ordered by seq DESC, walk accumulating tokens, find cutpoint seq, `DELETE FROM cache.history WHERE seq < cutpoint AND agent_id = ? AND session_key = ? AND topic_id = ''`. Return count deleted. |

### Window Cache

| RedisLayer Method | CacheLayer Implementation |
|---|---|
| `setWindow(agentId, sessionKey, messages, ttl)` | `INSERT OR REPLACE INTO cache.windows VALUES (?, ?, '', json(?), unixepoch() + ttl)` |
| `getWindow(agentId, sessionKey)` | `SELECT messages FROM cache.windows WHERE ... AND topic_id = '' AND expires_at > unixepoch()` |
| `invalidateWindow(agentId, sessionKey)` | `DELETE FROM cache.windows WHERE ... AND topic_id = ''` |

### Cursor

| RedisLayer Method | CacheLayer Implementation |
|---|---|
| `setCursor(agentId, sessionKey, cursor)` | `INSERT OR REPLACE INTO cache.kv VALUES ('cursor:' \|\| agentId \|\| ':' \|\| sessionKey, json(?), unixepoch() + historyTTL)` |
| `getCursor(agentId, sessionKey)` | `SELECT value FROM cache.kv WHERE key = ... AND (expires_at = 0 OR expires_at > unixepoch())` |

### Fleet Cache

| RedisLayer Method | CacheLayer Implementation |
|---|---|
| `setFleetCache(key, value, ttl)` | `INSERT OR REPLACE INTO cache.kv VALUES ('fleet:' \|\| ?, ?, unixepoch() + ttl)` |
| `getFleetCache(key)` | `SELECT value FROM cache.kv WHERE key = 'fleet:' \|\| ? AND (expires_at = 0 OR expires_at > unixepoch())` |
| `delFleetCache(key)` | `DELETE FROM cache.kv WHERE key = 'fleet:' \|\| ?` |
| `cacheFleetAgent(agentId, data)` | delegates to setFleetCache |
| `getCachedFleetAgent(agentId)` | delegates to getFleetCache |
| `cacheFleetSummary(summary)` | delegates to setFleetCache with 120s TTL |
| `getCachedFleetSummary()` | delegates to getFleetCache |
| `invalidateFleetAgent(agentId)` | delegates to delFleetCache x2 |

### Query Embedding

| RedisLayer Method | CacheLayer Implementation |
|---|---|
| `setQueryEmbedding(agentId, sessionKey, embedding)` | base64 encode Float32Array → `INSERT OR REPLACE INTO cache.kv VALUES ('qembed:...',  base64, unixepoch() + sessionTTL)` |
| `getQueryEmbedding(agentId, sessionKey)` | `SELECT value FROM cache.kv WHERE key = ... AND expires_at > unixepoch()` → base64 decode → Float32Array |

### Model State

| RedisLayer Method | CacheLayer Implementation |
|---|---|
| `setModelState(agentId, sessionKey, state)` | `INSERT OR REPLACE INTO cache.kv VALUES ('model_state:...', json(?), unixepoch() + 604800)` |
| `getModelState(agentId, sessionKey)` | `SELECT value FROM cache.kv WHERE key = ... AND (expires_at = 0 OR expires_at > unixepoch())` |

### Topic-Scoped Operations

| RedisLayer Method | CacheLayer Implementation |
|---|---|
| `setTopicSlot(agentId, sessionKey, topicId, slot, value)` | Same as setSlot but with topic_id = topicId |
| `getTopicSlot(agentId, sessionKey, topicId, slot)` | Same as getSlot but with topic_id = topicId |
| `setTopicWindow(agentId, sessionKey, topicId, messages, ttl)` | Same as setWindow with topic_id |
| `getTopicWindow(agentId, sessionKey, topicId)` | Same as getWindow with topic_id |
| `invalidateTopicWindow(agentId, sessionKey, topicId)` | Same as invalidateWindow with topic_id |
| `warmTopicSession(agentId, sessionKey, topicId, slots)` | Insert slots + history per-topic in a transaction |

### Bulk Operations

| RedisLayer Method | CacheLayer Implementation |
|---|---|
| `warmSession(agentId, sessionKey, slots)` | Transaction: insert all slots, meta, history. Then addActiveSession. |
| `evictSession(agentId, sessionKey)` | Transaction: `DELETE FROM cache.slots WHERE ...`, `DELETE FROM cache.history WHERE ...`, `DELETE FROM cache.windows WHERE ...`, delete kv entries, `UPDATE cache.sessions SET active = 0` |
| `touchSession(agentId, sessionKey)` | `UPDATE cache.slots SET expires_at = ... WHERE agent_id = ? AND session_key = ? AND topic_id = ''`. Also update sessions.touched_at. History gets historyTTL, others get sessionTTL. |
| `flushPrefix()` | Drop and recreate all cache tables. Return count. |

## TTL Cleanup

Since SQLite doesn't have native TTL, add a periodic cleanup method:

```typescript
/**
 * Purge expired entries from all cache tables.
 * Call this on a timer (every 60s) or lazily on reads.
 *
 * Using WHERE-clause filtering on reads means expired data is never returned,
 * so cleanup is purely for space reclamation, not correctness.
 */
cleanExpired(): number {
  const now = Math.floor(Date.now() / 1000);
  let count = 0;
  count += db.prepare('DELETE FROM cache.slots WHERE expires_at > 0 AND expires_at <= ?').run(now).changes;
  count += db.prepare('DELETE FROM cache.windows WHERE expires_at > 0 AND expires_at <= ?').run(now).changes;
  count += db.prepare('DELETE FROM cache.kv WHERE expires_at > 0 AND expires_at <= ?').run(now).changes;
  return count;
}
```

Run `cleanExpired()` inside the indexer's periodic tick (already runs every 60s).

## Snapshot (Warm Restart)

On SIGTERM (clean shutdown):
```typescript
snapshot(path: string): void {
  this.db.exec(`VACUUM cache INTO '${path}'`);
}
```

On startup (if snapshot file exists):
```typescript
loadSnapshot(path: string): boolean {
  if (!existsSync(path)) return false;
  // ATTACH snapshot as temp, copy all tables into :memory: cache, detach
  this.db.exec(`ATTACH DATABASE '${path}' AS snap`);
  this.db.exec(`INSERT INTO cache.slots SELECT * FROM snap.slots WHERE expires_at > unixepoch()`);
  this.db.exec(`INSERT INTO cache.history SELECT * FROM snap.history`);
  this.db.exec(`INSERT INTO cache.sessions SELECT * FROM snap.sessions`);
  this.db.exec(`INSERT INTO cache.windows SELECT * FROM snap.windows WHERE expires_at > unixepoch()`);
  this.db.exec(`INSERT INTO cache.kv SELECT * FROM snap.kv WHERE expires_at = 0 OR expires_at > unixepoch()`);
  this.db.exec(`DETACH snap`);
  unlinkSync(path);  // consumed, remove
  return true;
}
```

## File Changes Required

### New files:
- `src/cache.ts` — the CacheLayer class (this is the main build)

### Modified files:
- `src/types.ts`:
  - Replace `RedisConfig` with `CacheConfig`
  - Update `HyperMemConfig.redis` → `HyperMemConfig.cache`
  - Keep `redis?: RedisConfig` as deprecated optional for migration
- `src/index.ts`:
  - Import `CacheLayer` instead of `RedisLayer`
  - Replace `this.redis = new RedisLayer(...)` with `this.cache = new CacheLayer(...)`
  - Replace all `this.redis.xxx()` calls with `this.cache.xxx()`
  - Remove ioredis connect/disconnect
  - Add snapshot() call in shutdown handler
  - Add loadSnapshot() call in init
  - Wire cleanExpired() into indexer periodic tick
- `src/compositor.ts`:
  - Import `CacheLayer` instead of `RedisLayer`
  - Replace `CompositorDeps.redis` → `CompositorDeps.cache`
  - Replace all `this.redis.xxx()` calls with `this.cache.xxx()`
  - Remove deprecated RedisLayer constructor path
- `package.json`:
  - Remove `ioredis` from dependencies
  - Remove `@types/ioredis` from devDependencies (if present)
- `src/index.ts` exports:
  - Export `CacheLayer` instead of `RedisLayer`
  - Export `CacheConfig` instead of (or alongside) `RedisConfig`

### Test updates:
- All test files that mock/use RedisLayer → use CacheLayer
- Tests become simpler: no Redis mock needed, just use real in-memory SQLite
- Redis connection failure tests → remove (no connection to fail)

## Performance Notes

- All cache reads are synchronous (better-sqlite3 is sync). The async wrapper is for interface compat only.
- Prepared statements MUST be used for all hot-path queries (getSlot, getHistory, getWindow). Create them once in connect(), store as class fields.
- Transactions via `db.transaction()` for bulk ops (warmSession, evictSession, replaceHistory).
- The `:memory:` database uses the same page cache as the main connection, so no extra memory allocation beyond the data itself.

## Migration Notes

- `HyperMemConfig.redis` field renamed to `HyperMemConfig.cache`
- External config (openclaw.json) may reference `redis.host`, `redis.port` etc — the new config ignores those fields. No migration needed for config files, just remove redis block.
- The gateway config schema should mark `redis` as deprecated/optional.
- Existing Redis data is NOT migrated — cache is ephemeral by design. First compose after migration does a cold build (same as Redis restart).

## What NOT to Change

- `MessageStore` (messages.db) — untouched
- `LibraryDB` (library.db) — untouched
- Vector search — untouched
- Temporal index — untouched
- Open-domain FTS5 — untouched
- Compositor logic (slot priority, token budgeting, gradient refresh) — untouched
- afterTurn / ingest pipeline — untouched (it calls cache methods, interface is same)
- Compaction logic — untouched (it calls trimHistoryToTokenBudget, interface is same)

## Success Criteria

1. `npm run build` passes with zero errors
2. All existing test suites pass (with Redis mocks replaced by real cache)
3. `grep -r 'ioredis\|redis' src/` returns zero hits (except deprecation comments)
4. `cache.ts` uses prepared statements for all hot-path queries
5. Snapshot round-trip works: write → load → verify data present
6. No Redis process needed to start HyperMem
