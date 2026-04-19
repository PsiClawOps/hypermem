# HyperMem Roadmap — Post-0.8.0

Items that are designed but not yet implemented, or explicitly deferred for future releases.
For shipped capabilities, see [CHANGELOG.md](../CHANGELOG.md) and [ARCHITECTURE.md](../ARCHITECTURE.md).

---

## Open Items

| Item | WQ | Status | Notes |
|---|---|---|---|
| Cross-session context boundary markers | WQ-20260402-001 | 🟡 OPEN | `buildCrossSessionContext()` renders flat previews, no per-message boundaries or sender identity. Incident 6. |
| Cursor durability (SQLite dual-write) | — | 🟡 DEFERRED | Cursor TTL = 24h. Dual-write to SQLite required before background indexer reads cursor reliably across restarts. |
| Plugin type unification | — | 🟡 DEFERRED | Plugin uses dynamic imports; can't use TS types from core. Shims are intentional. Structural change needed. |
| Strict topic mode: legacy NULL backfill | — | 🟡 DEFERRED | After ≥2 weeks of topic detection in production, run backfill to assign `topic_id` to legacy NULL messages, then narrow `getRecentMessagesByTopic()` to exclude NULL. Gate: topic detection stable, coverage >80% of new messages. Tracked in `specs/DEFERRED.md`. |
| ACA Step 4 — retrieval stubs replace static files | — | 🔲 PENDING | `systemPromptAddition` carries governance doc chunks instead of embedding full workspace files. Blocked on Step 3 ✅ |
| ACA Step 5 — governance context assembly | — | 🔲 PENDING | Full on-demand assembly replaces static prompt injection. Requires Step 4. |

---

## Cross-Agent Registry — Live Load

**Current state:** `visibilityFilter()` in `cross-agent.ts` uses a hardcoded `defaultOrgRegistry()` to resolve agent tiers, orgs, and capabilities.

**Known limitation:** This duplicates fleet structure that lives authoritatively in `fleet_agents` + `fleet_orgs` in library.db.

**Planned:** Replace with live-loaded registry from library.db on gateway startup, with the hardcoded version as cold-start fallback only. This eliminates the need to maintain two copies of fleet topology.

---

## Write Authorization for Global-Scope Facts

**Current state:** Facts written with `scope='global'` are readable fleet-wide. The write path has no authorization gate — any agent with HyperMem API access can write a global-scope fact.

**Impact:** Acceptable for trusted single-operator deployments. All agents share the same trust boundary.

**Planned:** Write-authority model that gates global-scope writes to designated agents (council seats or explicitly allowlisted agent IDs).

**Workaround:** Restrict HyperMem API access to trusted agents only.
