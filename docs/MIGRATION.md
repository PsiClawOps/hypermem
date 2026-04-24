# HyperMem Migration

Start here.

- **Operator guide:** [`MIGRATION_GUIDE.md`](./MIGRATION_GUIDE.md)
- **Current repo state:** source-specific migration examples live in `MIGRATION_GUIDE.md`. There is no bundled unified migration dispatcher in this repo yet.

All migration examples default to **dry-run** where shown. Add `--apply` only when you are ready to write data.

---

## Multi-operator deployments (breaking change warning)

> ⚠️ **KL-01: No global-scope write gate (still open as of 0.8.8)**
>
> hypermem 0.8.8 still ships without a write gate for `scope='global'` facts. In a
> **single-operator deployment** (one user, one fleet sharing `library.db`), this
> is acceptable — agents share context intentionally.
>
> In a **multi-operator deployment** (multiple users or tenants sharing one
> `library.db`), this is a **breaking isolation risk**: a global-scope write from
> one operator's agent propagates to all other operators' agents.
>
> **Do not run hypermem in a multi-operator deployment without an external
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
| 0.8.8 | v11 | v19 | 22.0.0 | none, SQLite `:memory:` hot cache |
| 0.8.0 | v10 | v19 | 22.0.0 | none, SQLite `:memory:` hot cache |
| 0.7.0 | v7 | v13 | 22.0.0 | none, SQLite `:memory:` hot cache |
| 0.6.0 | v6 | v12 | 22.0.0 | none, SQLite `:memory:` hot cache |
| 0.5.0 | v6 | v12 | 22.0.0 | transition release, SQLite `:memory:` hot cache |
| 0.4.0 | v5 | v10 | 20.0.0 | Redis 6.0.0 |

Schema versions are importable for programmatic checks:
```ts
import { SCHEMA_COMPAT, HYPERMEM_COMPAT_VERSION } from 'hypermem';
// HYPERMEM_COMPAT_VERSION = ENGINE_VERSION, for example '0.8.8'
// SCHEMA_COMPAT = { compatVersion: ENGINE_VERSION, mainSchema: 11, librarySchema: 19 }
```

If your DBs are behind, run:
```bash
# Current releases migrate schemas on open. Back up the data dir first.
cp -a ~/.openclaw/hypermem ~/.openclaw/hypermem.pre-upgrade.$(date +%Y%m%d-%H%M%S)
openclaw gateway restart
```
