# HyperMem Migration

Start here.

- **Operator guide:** [`MIGRATION_GUIDE.md`](./MIGRATION_GUIDE.md)
- **Agent reference:** [`AGENT_MIGRATION.md`](./AGENT_MIGRATION.md)
- **Unified migration entrypoint:** `node scripts/migrate-legacy-sessions.mjs --source <type> [options]`

Supported `--source` values:

| Source | Underlying script | Purpose |
|---|---|---|
| `clawtext` | `scripts/migrate-clawtext.mjs` | Import legacy ClawText session history into HyperMem messages DB |
| `memory-db` | `scripts/migrate-memory-db.mjs` | Import OpenClaw built-in `memory.db` facts into HyperMem library DB |
| `memory-md` | `scripts/migrate-memory-md.mjs` | Import MEMORY.md daily checkpoint files into HyperMem library DB |

All migration scripts default to **dry-run**. Add `--apply` to write data.
