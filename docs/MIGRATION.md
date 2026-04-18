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

## Multi-operator deployments (breaking change warning)

> ⚠️ **KL-01: No global-scope write gate (0.5.0)**
>
> hypermem 0.5.0 ships without a write gate for `scope='global'` facts. In a
> **single-operator deployment** (one user, one fleet sharing `library.db`), this
> is acceptable — agents share context intentionally.
>
> In a **multi-operator deployment** (multiple users or tenants sharing one
> `library.db`), this is a **breaking isolation risk**: a global-scope write from
> one operator's agent propagates to all other operators' agents.
>
> **Do not run hypermem 0.5.0 in a multi-operator deployment without an external
> write gate at the application layer.** The write gate is deferred to 1.0.0
> where it will be enforced at the library DB level.
>
> A runtime warning is logged whenever `scope='global'` is written — monitor
> for this in production: `[hypermem] WARNING: ... scope='global'`

---

## Schema compatibility map

Current releases do **not** require Redis. The hot cache is SQLite `:memory:`.
Older versions below 0.5.0 used Redis, so the table keeps that history explicit.

| hypermem version | Main DB schema | Library DB schema | Min Node | External cache |
|---|---|---|---|---|
| 0.5.0 | v6 | v12 | 22.0.0 | none, SQLite `:memory:` hot cache |
| 0.4.0 | v5 | v10 | 20.0.0 | Redis 6.0.0 |

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
