# HyperMem

Agent-centric memory architecture for OpenClaw. Redis as hot compositor, SQLite per-agent persistent store, provider-neutral message format.

**Status:** Phase 1 complete — core built, tested, gateway hook ready.

## Architecture

- **SQLite** (one DB per agent) — structured message storage, facts, knowledge, topics, episodes, FTS5
- **Redis** — hot session compositor slots, graceful degradation to SQLite-only
- **Provider translator** — converts between neutral format and Anthropic/OpenAI at boundary
- **Token-budgeted compositor** — assembles context within budget with configurable priority

## Quick Start

```bash
npm install
npx tsc
node test/smoke.mjs          # SQLite-only tests
node test/redis-integration.mjs  # Full stack (requires Redis)
```

## License

Private — PsiClawOps
