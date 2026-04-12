# Changelog

All notable changes to HyperMem are documented here.

## 0.6.0 — Redis removal complete

**Breaking:** Redis is no longer part of HyperMem. The L1 hot cache is now SQLite `:memory:`, with zero external service dependencies.

- `RedisLayer` class removed. Use `CacheLayer` (drop-in replacement, same public interface).
- `ioredis` dependency removed from `package.json`.
- `RedisConfig` type alias retained as `type RedisConfig = CacheConfig` for backward compatibility. It will be removed in 1.0.
- All internal naming updated: `refreshRedisGradient()` → `refreshCacheGradient()`.
- README, INSTALL.md, and ARCHITECTURE.md rewritten to reflect the SQLite-only stack.
- Migration guide added: [From Redis to SQLite cache](docs/MIGRATION_GUIDE.md#from-redis-to-sqlite-cache).

**If you are upgrading from 0.3.x or earlier**, see the migration guide. The L1 cache was always ephemeral — no data is lost. Your durable data (`library.db`, `hypermem.db`) is untouched.

## 0.3.0 — Subagent context and retrieval

- Subagent context inheritance: spawned subagents get bounded parent context, session-scoped docs, and relevant facts.
- Hybrid FTS5 + KNN retrieval with Reciprocal Rank Fusion.
- Background indexer with workspace seeding.
