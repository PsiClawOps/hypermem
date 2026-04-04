# HyperMem Implementation Review — 2026-04-02

Prepared by Pylon

## Scope

Reviewed against the current working tree:

- `/home/lumadmin/.openclaw/workspace-council/forge/specs/HYPERMEM_INCIDENT_HISTORY.md`
- `/home/lumadmin/.openclaw/workspace-council/forge/specs/HYPERMEM_QUEUE_SPLIT.md`
- `/home/lumadmin/.openclaw/workspace/repo/hypermem/ARCHITECTURE.md`
- Code paths in `src/redis.ts`, `src/compositor.ts`, `src/index.ts`, `src/types.ts`, `plugin/src/index.ts`, and selected search/retrieval modules
- OpenClaw runtime contract in `/home/lumadmin/.openclaw/workspace/dev/openclaw`

Working tree status at review time:

- Uncommitted changes present in `ARCHITECTURE.md` and `plugin/src/index.ts`
- Queue-split work is mostly documented, not yet implemented in core code

## Validation performed

### Repo checks

- `npm test` in repo root: **PASS**
- `npm run build` in repo root: **PASS**
- `npm run typecheck` in `plugin/`: **FAIL**
- `npm run build` in `plugin/`: **FAIL**

Plugin failure is currently:

```text
src/index.ts(355,9): error TS2353: Object literal may only specify known properties,
and 'historyDepth' does not exist in type 'ComposeRequest'.
```

### Targeted reproductions

I ran three direct reproductions against the current code:

1. **Redis history limit bypass**
   - Built a session with 120 user/assistant pairs
   - Called `compose({ historyDepth: 10 })`
   - Result: `NON_SYSTEM_COUNT 240`
   - Conclusion: `historyDepth` does **not** constrain Redis-backed history today

2. **Repeated warm duplication**
   - Recorded 4 messages
   - Ran `hm.warm()` twice
   - Redis history sizes: `4 -> 8 -> 12`
   - Conclusion: repeated warming appends duplicates

3. **Prompt path / retrieval seam**
   - Indexed a doc chunk containing a unique trigger phrase
   - Called `compose({ prompt: "...moonshot-latency..." })` **before** recording that prompt to history
   - Result: `WITHOUT_RECORDED_PROMPT_HAS_CHUNK false`
   - After recording the prompt to history: `AFTER_RECORDING_PROMPT_HAS_CHUNK true`
   - Conclusion: current-turn retrieval is one turn stale in the plugin→core path

---

## Executive summary

HyperMem has landed several important fixes from the incident chain: the provider translation seam is corrected, `afterTurn()` now handles ingestion, Redis retention is no longer aggressively destructive, and the compositor has a safety valve. Those are real improvements.

But the main “put this to bed” issues are **not** actually put to bed yet.

The current working tree does **not** implement the queue-split P0s described in `HYPERMEM_QUEUE_SPLIT.md`. The hot path still has all of the core failure mechanics from Incidents 5 and 7:

- Redis history ignores `limit`
- bootstrap warming is unconditional
- warm bootstrap still seeds from `maxHistoryMessages`
- repeated warm calls duplicate Redis history
- there is no `window`, no `cursor`, no `sessionExists()`, and no append dedupe

More importantly, I found one additional seam bug that is **not** covered cleanly by the current spec stack:

> The plugin forwards `prompt`, but HyperMem core `ComposeRequest` does not define or use it. In practice, prompt-driven retrieval/doc-chunk selection is one turn stale.

That matters because the entire long-term ACA/governance offload strategy depends on prompt-aware retrieval working on the live turn, not only after the prompt has already been written to history.

My bottom line:

- **Do not treat HyperMem as stabilized yet**
- **Do not begin the next architectural layer (ACA offload / more doc seeding) until the P0 stabilizers land**
- **The next pass should be a focused seam-hardening pass, not more feature surface**

---

## Status by issue

| Area | Status | Assessment |
|---|---:|---|
| Incident 1 — provider translation seam | ✅ Fixed | `skipProviderTranslation` path is implemented and tested |
| Incident 2 — `afterTurn()` must ingest | ✅ Fixed | Plugin now ingests `messages.slice(prePromptMessageCount)` |
| Incident 3 — FTS performance | ⚠️ Partial / docs overclaim | Hybrid/doc-chunk/fact paths use two-phase subqueries; `message-store.ts` still does direct join |
| Incident 4 — Redis 50-message destruction | ✅ Fixed | Retention raised to 1000 + TTL aging |
| Incident 5 — queue split / limit honoring | ❌ Not fixed | Core hot path still ignores Redis history limit |
| Incident 6 — cross-session boundaries | ⚠️ Partial | Code now includes channel/role/timestamp, but not sender/session/dispatch metadata |
| Incident 7 — bootstrap idempotency | ❌ Not fixed | Runtime calls bootstrap on existing sessions; plugin still warms unconditionally |
| Plugin/core prompt contract | ❌ New critical seam bug | Prompt is forwarded by runtime/plugin but ignored by core compose |
| Plugin build health | ❌ Broken | Type/build lane is red due duplicated type drift |

---

## What is genuinely fixed

### 1) Provider translation seam is fixed

This part looks good.

- Plugin sets `skipProviderTranslation: true` and converts neutral messages back into OpenClaw agent messages. Source: `plugin/src/index.ts#346-355`
- Compositor honors `skipProviderTranslation` and returns neutral messages instead of provider-formatted ones. Source: `src/compositor.ts#607-614`
- Tests cover the neutral-vs-provider translation path. Source: `test/compositor.mjs` skip-provider-translation block

Assessment: the Incident 1 class of silent tool-call corruption appears addressed.

### 2) `afterTurn()` ingestion is fixed and matches runtime contract

This fix appears correct.

- Plugin now ingests `messages.slice(prePromptMessageCount)` inside `afterTurn()`. Source: `plugin/src/index.ts#395-425`
- OpenClaw runtime calls `afterTurn()` **instead of** `ingest()`/`ingestBatch()` when `afterTurn` exists. Source: `/home/lumadmin/.openclaw/workspace/dev/openclaw/src/agents/pi-embedded-runner/run/attempt.ts#3000-3037`

Assessment: the Incident 2 class of “nothing is being persisted after the turn” is fixed.

### 3) Redis retention is no longer destructively tiny

- Default history retention is 1000 messages, with 24h TTL for history and 4h TTL for other slots. Sources: `src/index.ts#159-175`, `src/redis.ts#205-223`, `src/redis.ts#308-320`

Assessment: Incident 4’s specific 50-message LTRIM destruction is fixed.

### 4) Safety valve exists in the compositor

- Post-assembly overbudget trimming is present. Source: `src/compositor.ts#565-604`

Assessment: good defense-in-depth. It is not a substitute for correct history-window gating.

---

## Critical findings

## 1) Queue split is still mostly documentation, not implementation

The design spec is directionally right, but the code does not yet implement the core split.

### Missing today

- `redis.getHistory()` still has no `limit` parameter. Source: `src/redis.ts#229-233`
- `compositor.getHistory()` still calls Redis without a limit and returns cached history as-is. Source: `src/compositor.ts#734-746`
- `warmSession()` still seeds from `this.config.maxHistoryMessages` rather than an independent bootstrap cap. Source: `src/compositor.ts#681-687`
- `pushHistory()` has no dedupe. Source: `src/redis.ts#205-223`
- No `window` cache methods in Redis
- No `cursor` methods in Redis
- No `sessionExists()` method in Redis
- No window invalidation in `afterTurn()`
- No bootstrap idempotency guard in the plugin. Source: `plugin/src/index.ts#260-267`

### Why this matters

The queue-split doc is not wrong about the architecture. It is wrong only if treated as already-landed. Today, the repo is still relying on a workaround and later-stage safety behavior, not on the proper control points.

Assessment: **Incident 5 full fix is not done. Incident 7 fix is not done.**

---

## 2) The `safeHistoryDepth = 150` band-aid does not actually constrain Redis-backed sessions

This is the single most important mismatch between the docs and the live code.

### Code path

- Plugin requests `historyDepth: safeHistoryDepth`. Source: `plugin/src/index.ts#344-355`
- Compositor accepts that limit. Source: `src/compositor.ts#281-285`
- But its Redis path ignores the limit entirely:
  - `const cached = await this.redis.getHistory(agentId, sessionKey);` Source: `src/compositor.ts#740`
  - `lrange(key, 0, -1)` Source: `src/redis.ts#231-233`

### Reproduction

I created a session with 120 user/assistant pairs and called `compose({ historyDepth: 10 })`. The result contained:

```text
NON_SYSTEM_COUNT 240
```

That means the requested history depth was ignored on the hot Redis path.

### Practical impact

The current band-aid does **not**:

- reduce Redis fetch volume
- reduce the candidate history set on hot sessions
- provide a reliable cap on returned history

Any current safety is coming from later token-budget assembly / safety-valve behavior, not from the requested depth itself.

Assessment: **the workaround is materially weaker than the docs imply.**

---

## 3) Bootstrap is still non-idempotent, and repeated warming duplicates Redis history

This is still live.

### Runtime contract

OpenClaw calls `bootstrap()` when the session file already exists:

- `hadSessionFile` computed from `fs.stat(sessionFile)` Source: `/home/lumadmin/.openclaw/workspace/dev/openclaw/src/agents/pi-embedded-runner/run/attempt.ts#2018-2021`
- `if (hadSessionFile && (params.contextEngine?.bootstrap || ...)) { ... bootstrap(...) }` Source: `/home/lumadmin/.openclaw/workspace/dev/openclaw/src/agents/pi-embedded-runner/run/attempt.ts#2039-2046`

### HyperMem plugin behavior

Bootstrap still does:

```ts
await hm.warm(agentId, sk);
```

Source: `plugin/src/index.ts#260-267`

### Warm path behavior

- `warmSession()` pulls recent messages from SQLite using `this.config.maxHistoryMessages` Source: `src/compositor.ts#681`
- `RedisLayer.warmSession()` calls `pushHistory()` with those messages Source: `src/redis.ts#282-286`
- `pushHistory()` blindly `RPUSH`es every message Source: `src/redis.ts#214-223`

### Reproduction

Using current code:

```text
initial 4
after_warm_1 8
after_warm_2 12
```

That is exactly the duplicate-appending failure mode the spec warns about.

### Practical impact

If bootstrap fires on every attempt for existing sessions, current code will:

- re-read historical messages from SQLite
- re-append them to Redis
- hold the lane during warm
- grow/rotate the Redis list with duplicate payloads until LTRIM cuts the tail

Assessment: **Incident 7 is still structurally live.**

---

## 4) New critical seam bug: runtime/plugin prompt is forwarded, but HyperMem core ignores it

This is the most important new finding from this review.

### Runtime contract

OpenClaw explicitly supports prompt-aware assemble calls:

- Context engine type includes `prompt?: string` on `assemble(params)` Source: `/home/lumadmin/.openclaw/workspace/dev/openclaw/src/context-engine/types.ts#178-188`
- Runtime forwards `prompt` into `assemble(...)` Source: `/home/lumadmin/.openclaw/workspace/dev/openclaw/src/agents/pi-embedded-runner/run/attempt.ts#2423-2430`

### Plugin behavior

The plugin also forwards `prompt` into its local `ComposeRequest` object. Source: `plugin/src/index.ts#325-355`

### HyperMem core behavior

But HyperMem core `ComposeRequest` does **not** define `prompt`, and the compositor does not use it:

- Core `ComposeRequest` has no `prompt` field. Source: `src/types.ts#196-214`
- Semantic recall uses `getLastUserMessage(messages)` instead. Source: `src/compositor.ts#382-388`
- Doc chunk trigger logic also uses `getLastUserMessage(messages)` instead of current prompt. Source: `src/compositor.ts#410-482`

The plugin also ignores the runtime-provided `messages` array for composition purposes; it rebuilds from HyperMem state instead. Source: `plugin/src/index.ts#325-355`

### Reproduction

I indexed a doc chunk with a unique trigger phrase and then composed with a matching `prompt` **before** recording that prompt into session history:

```text
WITHOUT_RECORDED_PROMPT_HAS_CHUNK false
AFTER_RECORDING_PROMPT_HAS_CHUNK true
```

That proves the live-turn prompt is not driving retrieval today.

### Practical impact

At minimum, this means:

- doc-chunk retrieval is one turn stale
- semantic recall is one turn stale
- first-turn retrieval on a new session is effectively blind

That is a direct blocker for the planned ACA/governance offload model, because the whole point is to retrieve the right chunk **for the current ask**.

Assessment: **This is a new P0 seam bug and should be fixed before deeper queue-split work.**

---

## 5) Plugin build is red because plugin-local types drifted from core types

This is not just cosmetic.

### Evidence

Plugin-local `ComposeRequest` omits `historyDepth`:

- `plugin/src/index.ts#84-94`

Core `ComposeRequest` includes `historyDepth`:

- `src/types.ts#196-214`

That mismatch causes both plugin typecheck and build to fail.

### Why it matters

This duplicated-type setup is what allowed the more dangerous seam bug above:

- plugin thinks `prompt` exists
- core does not
- plugin thinks it can request `historyDepth`
- its local shim did not evolve with core

This is a contract-drift problem, not just a TypeScript nuisance.

Assessment: **Stop hand-maintaining parallel request/response shims across the seam.**

---

## 6) Architecture and incident docs overstate what is currently live

The docs are useful, but the “current vs planned” boundary is not clean enough.

### Specific mismatches

#### `ARCHITECTURE.md` says bootstrap history is capped at 250

- Doc says Redis history is `250 cap at bootstrap, 1000 soft cap ongoing`. Source: `ARCHITECTURE.md#182-184`
- Current code warms with `this.config.maxHistoryMessages`, which defaults to 1000. Sources: `src/compositor.ts#681-687`, `src/index.ts#170-173`

#### `ARCHITECTURE.md` lists invariants that are not yet implemented

- Window cache invariant Source: `ARCHITECTURE.md#227-233`
- But there is currently no window/cursor/sessionExists implementation in the codebase

#### `ARCHITECTURE.md` implies the band-aid caps compose request in a meaningful way

- Doc says: `CURRENT BAND-AID: safeHistoryDepth=150 in plugin caps compose() request` Source: `ARCHITECTURE.md#209`
- In practice, Redis hot-path limit bypass means this is not an effective cap on returned history

#### Incident 3 overclaims the message-store fix

- Incident doc says two-phase FTS fix applied across `message-store.ts`, `hybrid-retrieval.ts`, `fact-store.ts`, `doc-chunk-store.ts` Source: `HYPERMEM_INCIDENT_HISTORY.md#46-52`
- Current `message-store.ts` still uses a direct FTS join + order + limit pattern. Source: `src/message-store.ts#333-345`
- Hybrid/doc-chunk/fact paths do use two-phase subquery patterns. Sources: `src/hybrid-retrieval.ts#116-139`, `src/doc-chunk-store.ts#223-247`, `src/fact-store.ts#169-195`

#### Incident 6 is slightly stale in the other direction

- Incident doc says cross-session rendering has no per-message boundaries/timestamps/sender identity Source: `HYPERMEM_INCIDENT_HISTORY.md#104-108`
- Current code now includes channel, role, and timestamp per line. Source: `src/compositor.ts#1004-1024`
- But it still lacks sender/session/dispatch metadata, so the usability issue is only partially solved

Assessment: the docs are directionally strong, but they currently blend:

- things that are live
- things that are partially live
- things that are only proposed

That makes the repo look further along than it is.

---

## Recommended sequence to actually stabilize this

## P0 — do these before any more architectural expansion

### P0.1 — Fix the prompt/query contract first

Add prompt support to HyperMem core and use it for retrieval.

Minimum shape:

- Add `prompt?: string` to core `src/types.ts::ComposeRequest`
- In compositor, compute:

```ts
const retrievalQuery = request.prompt?.trim() || this.getLastUserMessage(messages) || '';
```

Use `retrievalQuery` for:

- semantic recall
- doc chunk trigger matching / keyword construction

Why first:

- It is a correctness bug on the live turn
- ACA/doc-stub offload depends on this working
- It is independent of window/cursor work

### P0.2 — Implement Part 1 from the queue-split spec immediately

Do this now, not later:

- `redis.getHistory(agentId, sessionKey, limit?)`
- Redis `LRANGE -N -1` when limit is provided
- `compositor.getHistory()` passes limit through on Redis path
- Add a test that proves `historyDepth: 10` returns 10 history messages on hot Redis sessions

Why second:

- It makes the existing `safeHistoryDepth` workaround actually mean something
- It reduces candidate-set size at the correct control point

### P0.3 — Implement bootstrap idempotency guard now

Add:

- `RedisLayer.sessionExists()` via `EXISTS hm:{a}:{s}:history`
- Plugin `bootstrap()` early-return if already warm

Add a test that repeated bootstrap/warm on a hot session is a no-op.

### P0.4 — Move dedupe earlier than the spec currently places it

The current spec puts dedupe after the queue split. I would move the cheap dedupe earlier because the duplication problem is happening **today**, not only after the split.

Do now:

- tail-check dedupe in `pushHistory()`
- set-based dedupe in `compose()` before budget assembly

This is cheap insurance and directly reduces repeated-warm damage.

### P0.5 — Separate bootstrap cap from steady-state cap

Do not let bootstrap use `maxHistoryMessages`.

Add a dedicated warm cap, e.g. 200–250.

Why now:

- cold-start warm still should not seed 1000 messages
- this reduces hot-path pressure even after idempotency is fixed

---

## P1 — then do the real queue split

After the P0 stabilizers above are green:

- add Redis `window`
- add Redis `cursor`
- cache compositor output into `window`
- invalidate `window`/`cursor` from `afterTurn`
- optionally remove `safeHistoryDepth` only after end-to-end verification

My recommendation:

- **Do not remove the band-aid until Part 1 + bootstrap guard + prompt fix are all tested end-to-end**

---

## P1 — harden tests and CI at the seams

Current repo tests passing is not enough because the seam failures are in integration boundaries.

Add tests for:

1. **Prompt-aware retrieval through the plugin path**
   - current prompt should trigger doc retrieval before being written to history
2. **Redis hot-path history limit honoring**
   - `historyDepth` must constrain hot sessions, not only SQLite fallback
3. **Bootstrap idempotency**
   - repeated bootstrap on existing session must not append duplicates
4. **Warm duplication guard**
   - repeated `warm()` must not grow Redis history
5. **Plugin build lane in CI**
   - root tests green + plugin typecheck red is a false-green repo state

Also: make CI fail on plugin type drift, not just root test success.

---

## P1 — tighten the docs after code lands

Once the code is real:

- update `ARCHITECTURE.md` to split sections into explicit **CURRENT** vs **PLANNED** blocks
- only list invariants that are actually implemented under CURRENT
- move “what should be true after queue split” into a clearly named future-state section
- correct Incident 3 status note around `message-store.ts`

Right now the docs are useful for design intent, but too optimistic as implementation status.

---

## Recommended stop/go decision

### Stop

Do **not** start:

- ACA offload phases 3–5
- more governance stub replacement
- more retrieval-dependent architecture claims

until the P0 stabilizers above are done.

### Go

Do proceed with a short stabilization sprint focused on:

1. prompt/query contract
2. Redis history limit honoring
3. bootstrap idempotency
4. dedupe
5. warm cap

That is the shortest path to getting HyperMem from “promising but still seam-fragile” to “operationally trustworthy.”

---

## Bottom line

My assessment is blunt:

**The repo has good architecture direction, but the main failure chain is not fully fixed yet.**

The two most important conclusions are:

1. **Queue split is still mostly planned state**
2. **There is a new prompt-path seam bug that must be fixed before retrieval-heavy architecture can be trusted**

If you want this put to bed, the right move is not another broad design pass.

The right move is one tight implementation pass that closes the live seams.
