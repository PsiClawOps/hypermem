# 1.0 Roadmap Trackers

Issues logged from Anvil's review of the 0.5.0 state report (2026-04-07).
None are ship blockers for 0.5.0. All are 1.0 blockers.

---

## TRACK-01: compositor.ts size — maintenance risk

**Anvil flag:** compositor.ts at ~2,800 lines is a maintenance grenade.

**Problem:** Single file owns context assembly, pressure logic, FOS/MOD injection,
keystone history, tool gradient trimming, and trigger evaluation. Any of those
growing independently will compound.

**Proposed split:**
- `compositor-core.ts` — assembly pipeline, slot resolution
- `compositor-pressure.ts` — pressure zone logic, tool gradient trim
- `compositor-fos-mod.ts` — FOS/MOD injection (already partially in fos-mod.ts)
- `compositor-keystone.ts` — keystone history retrieval and scoring

**Target:** No single compositor file exceeds 600 lines at 1.0.

---

## TRACK-02: sqlite-vec 0.1.9 pinned — pre-1.0 dependency

**Anvil flag:** sqlite-vec is pre-1.0 and pinned. What's the upgrade abstraction?

**Current state:** Pinned at `0.1.9`. API is stable in practice but no semver
guarantee. We call: `loadExtension`, KNN search via `vec_distance_L2`, and
`vec_each`.

**Plan:**
- Wrap all sqlite-vec calls in `vector-store.ts` (already mostly true)
- Add `SQLITE_VEC_VERSION` constant to `version.ts`
- Write an upgrade test: load 0.1.9, write vectors, reload with 0.2.x, verify
  reads are identical
- Pin to `~0.1.9` (patch-level) not `^0.1.9` (minor-level) until 1.0 of sqlite-vec

**Target:** Upgrade path documented and tested before hypermem 1.0.

---

## TRACK-03: 16-agent write contention on library.db — measured or assumed?

**Anvil flag:** Write contention profile for 16 agents sharing library.db — measured or assumed?

**Current state:** WAL mode is enabled (`PRAGMA journal_mode=WAL`). Assumed safe
for read-heavy workload. Write contention is assumed low because fact writes are
infrequent (background indexer, not hot path).

**What we don't know:**
- Peak concurrent writes during fleet heartbeat bursts (all 16 agents wake simultaneously)
- Dreaming promoter concurrent write behavior under fleet load
- p99 write latency under sustained load

**Plan:**
- Build a contention benchmark: 16 concurrent writers, measure p50/p99/p999 write latency
- If p99 > 50ms: introduce write queue (single writer, async queue)
- Include in 0.5.1 release notes as "measured, not assumed"

---

## TRACK-04: 120k planning baseline — hardcoded or adaptive?

**Anvil flag:** 120k token planning baseline — hardcoded or adapts to model context window?

**Current state:** Hardcoded at 120,000 tokens in compositor pressure logic.
This is a reasonable default for Sonnet/GPT-4 class models but wrong for:
- Models with 32k windows (too aggressive)
- Models with 1M+ windows (too conservative, leaves headroom on the table)

**Plan:**
- Add `contextWindowTokens` to `CompositorConfig` (optional, defaults to 120k)
- Pressure thresholds become `contextWindowTokens * 0.75 / 0.80 / 0.85`
- OpenClaw integration: pass the active model's context window at compositor init
- Document in TUNING.md

---

## TRACK-05: Dreaming promoter concurrent MEMORY.md writes — lock mechanism

**Anvil flag:** Concurrent MEMORY.md writes from dreaming promoter — lock exists?

**Current state:** Dreaming promoter writes to MEMORY.md via standard file write.
No lock mechanism. If two agents promote simultaneously on the same workspace,
writes can interleave or clobber.

**Current mitigation:** In practice, only one agent (main) owns the workspace
MEMORY.md in our fleet config. But this is convention, not enforcement.

**Plan:**
- Add advisory file lock (`proper-lockfile` or native `flock`) around MEMORY.md writes
- If lock cannot be acquired within 2s: back off, retry once, then log warning and skip
- Add test: two concurrent promoters, verify no data loss
- Consider making MEMORY.md writes go through a single write-queue in the HyperMem
  instance rather than direct file access

---

## Status

| Tracker | 0.5.0 blocker? | 1.0 blocker? | Owner |
|---|---|---|---|
| TRACK-01 compositor size | No | Yes | Forge |
| TRACK-02 sqlite-vec upgrade path | No | Yes | Forge |
| TRACK-03 write contention measurement | No | Yes | Pylon |
| TRACK-04 adaptive context window | No | Yes | Forge |
| TRACK-05 MEMORY.md write lock | No | Yes | Forge |
