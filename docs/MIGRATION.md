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

---

## Schema compatibility map

| hypermem version | Main DB schema | Library DB schema | Min Node | Min Redis |
|---|---|---|---|---|
| 0.5.0 | v6 | v12 | 22.0.0 | 7.0.0 |
| 0.4.0 | v5 | v10 | 20.0.0 | 6.0.0 |

Schema versions are importable for programmatic checks:
```ts
import { SCHEMA_COMPAT, HYPERMEM_COMPAT_VERSION } from 'hypermem';
// HYPERMEM_COMPAT_VERSION = '0.5.0'
// SCHEMA_COMPAT = { compatVersion: '0.5.0', mainSchema: 6, librarySchema: 12 }
```

If your DBs are behind, run:
```bash
node scripts/migrate-legacy-sessions.mjs --apply
```
