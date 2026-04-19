# Known Limitations — HyperMem 0.8.0

## Global-scope fact write authorization

Facts written with `scope='global'` are readable fleet-wide at L4 priority. The write path has no authorization gate — any agent with access to the HyperMem API can write a global-scope fact.

**Impact:** In a trusted single-operator deployment (the intended target), this is acceptable. All agents are operator-controlled and share the same trust boundary.

**Planned fix:** Introduce a write-authority model that gates global-scope writes to designated agents (council seats or explicitly allowlisted agent IDs). See [docs/ROADMAP.md](ROADMAP.md).

**Workaround:** Restrict HyperMem API access to trusted agents only. Do not expose the API to untrusted external agents.

## Cross-agent org registry is hardcoded

`visibilityFilter()` in `cross-agent.ts` resolves agent tiers and visibility from a hardcoded `defaultOrgRegistry()`. This duplicates fleet topology that lives authoritatively in `fleet_agents` + `fleet_orgs` in library.db.

**Impact:** New agents added to library.db but not the hardcoded registry get fleet-only visibility until the registry is updated in code.

**Planned fix:** Live-load registry from library.db on startup, hardcoded as cold-start fallback only. See [docs/ROADMAP.md](ROADMAP.md).

## Cursor durability across restarts

The compositor writes a session cursor to hot cache (SQLite `:memory:`) with a 24h TTL. On gateway restart, the cursor is lost until the next `compose()` call repopulates it.

**Impact:** Background indexer may miss the cursor on the first turn after a restart, falling back to full-history scan.

**Planned fix:** Dual-write cursor to messages.db so it survives restarts. See [docs/ROADMAP.md](ROADMAP.md).

## Cross-session context has no boundary markers

`buildCrossSessionContext()` renders flat previews with no per-message boundaries or sender identity labels.

**Impact:** Context from different sessions blends together, making attribution ambiguous in multi-agent scenarios.

**Planned fix:** WQ-20260402-001. See [docs/ROADMAP.md](ROADMAP.md).
