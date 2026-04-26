# MEMORY.md authoring

`MEMORY.md` is an index, not a dump.

Use it to preserve durable signal the agent should keep noticing across sessions: decisions, operating rules, important architecture facts, stable paths, active plans, and search pointers into deeper history.

Do not use it as a transcript, changelog, or a second database. hypermem already stores the raw history. `MEMORY.md` should make the right things easy to find again.

## What belongs in MEMORY.md

Keep items that are still likely to matter after the current session ends:

- stable architectural facts
- standing rules and constraints
- current project plans worth reloading next session
- important decisions with enough context to recover why they happened
- durable paths, repo locations, and operational references
- search pointers for deeper recall

Good rule: if losing the item would make the next session slower, riskier, or more error-prone, it probably belongs.

## What does not belong

Do not put these in `MEMORY.md`:

- full conversation summaries
- test logs and build output
- one-off debugging notes with no ongoing value
- temporary status that belongs in a daily checkpoint
- long implementation detail blocks copied from code or specs
- duplicate facts already obvious from repo structure

If the value is only "this happened today," it usually belongs in the daily file, not the index.

## Authoring style

Write pointer-first entries. One line should stand on its own, and one search pointer should reopen the deeper context.

Preferred format:

```md
- TUNE-011: indexer quality gate, 33% fact noise removed (2527→1707 facts)
  → memory_search("TUNE-011 indexer quality")
```

Avoid this:

```md
- TUNE-011
  - changed isQualityFact()
  - added guards for code blocks
  - adjusted token thresholds
  - updated tests
  - shipped at 11:42 PM
```

The first format reloads context fast. The second turns `MEMORY.md` into a bad replica of history.

## Recommended sections

Most agents do well with some version of these:

- Identity
- Domain priming
- Key specs and plans
- Standing rules
- Key decisions
- Recent actions or active facts, if they are still durable enough to matter

Use only the sections that actually carry signal.

## Recency checking

Some facts are true now but should not be treated like permanent law.

Examples:

- current default model provider
- active fallback model
- temporary deployment workarounds
- known incidents, freezes, or suspensions
- "current release" statements
- performance numbers tied to a recent benchmark

For these, add recency cues and review them on a cadence.

### Mark temporal facts clearly

When a fact is time-bound, include one or more of:

- an explicit date, such as `as of 2026-04-18`
- a condition, such as `until Copilot is restored`
- a review trigger, such as `recheck after next deploy`
- a search pointer to the deeper event history

Example:

```md
- Fleet model drift checks suspended as of 2026-04-14, until Copilot is restored
  → memory_search("model drift suspension Copilot restored")
```

### Use a stale-question test

Before adding an item, ask:

1. Will this still be true in 30 days?
2. If it changed silently, would stale memory cause a bad decision?
3. Does the entry tell the next session how to verify freshness?

If the answer pattern is `no / yes / no`, the item needs recency metadata or it belongs somewhere else.

### Review cadence

A simple operating rule works well:

- review "current state" lines every 7 to 14 days
- review release, benchmark, and provider facts after each upgrade or deployment change
- remove or rewrite any entry whose time condition no longer holds

### Prefer ranges over false permanence

Bad:

```md
- Forge runs copilot-local/claude-sonnet-4.6
```

Better:

```md
- Forge standard model was copilot-local/claude-sonnet-4.6 as of 2026-04-11; recheck after provider routing changes
  → memory_search("Forge standard model 2026-04-11 provider routing")
```

## Relationship to daily memory files

Use daily files for checkpoint logging: what changed, what blocked, what to resume.

Use `MEMORY.md` for the compact map of durable context.

A good daily file helps you resume tomorrow. A good `MEMORY.md` helps you resume next month.

## Maintenance rule

If an entry no longer earns its place, delete it.

A shorter `MEMORY.md` with current signal beats a larger one full of expired truth.

## Static index vs runtime tail (compositor contract)

`MEMORY.md` has two regions. The contract between them is enforced by the
compositor and must be preserved by anyone editing the file.

```
┌─────────────────────────────────────────────┐
│  Static curated index (human-authored)      │
│  • identity, pointers, durable facts        │
│  • edit this region by hand                 │
├─────────────────────────────────────────────┤
│  <!-- OPENCLAW_CACHE_BOUNDARY -->           │
├─────────────────────────────────────────────┤
│  Runtime tail (compositor-generated)        │
│  • Active Facts                             │
│  • Temporal Context                         │
│  • Other Active Sessions                    │
│  • Recent Actions                           │
│  • Dynamic Project Context                  │
└─────────────────────────────────────────────┘
```

### Rules

1. **On-disk `MEMORY.md` is the curated static index.** It holds identity
   anchors, pointer entries with `memory_search()` hints, and durable facts
   that earn their place long-term.

2. **Everything below `<!-- OPENCLAW_CACHE_BOUNDARY -->` is the compositor's
   runtime tail.** It is regenerated on session warm from live stores: the
   fact table, contradiction audits, topic activity, recent tool actions,
   and dynamic project context. Treat the text below the boundary as a
   snapshot, not a source of truth.

3. **Do not hand-edit the runtime tail.** Anything you write there will be
   overwritten on the next compositor pass.

4. **Do not copy runtime tail content back up into the static index.**
   Facts in the runtime tail originate from the fact store. Copying them
   into the static region:
   - duplicates the content between two layers,
   - hardens a temporary state into a durable record,
   - and bypasses the promoter's quality filters and temporal-marker screen.

   If a runtime fact genuinely belongs in the durable index, let the
   dreaming promoter handle it, or re-author the claim manually with the
   durability rules above.

5. **The compositor owns the boundary marker.** Do not delete, move, or
   relabel `<!-- OPENCLAW_CACHE_BOUNDARY -->`. Deleting it makes the entire
   file look static to the compositor and breaks the runtime tail rebuild.

### Why this matters

The runtime tail exists to surface what is live right now: active facts,
recent actions, other sessions, current project context. The static index
exists to hold what will still be true next month. Conflating the two
produces the exact failure mode the temporal-marker screen guards against:
temporary state hardens into durable memory, and the agent loses the
ability to tell "fresh right now" from "true forever."

## Promoter temporal-marker screen

The dreaming promoter (`src/dreaming-promoter.ts`) uses a second line of
defense to keep time-bound facts out of durable memory: the
temporal-marker screen.

**How it works.** When `isPromotable()` evaluates a candidate fact, it
checks the content against a centralized list of temporal markers:

- explicit time bounds: `as of`, `until`, `currently`, `for now`
- transitional states: `suspended`, `pending`, `paused`, `blocked`, `frozen`
- rollout language: `rollout`, `phase`, `migration ongoing`, `pre-release`
- experimental language: `temporary`, `trial`, `experiment(al)`, `exploratory period`, `override`, `hotfix`, `workaround`, `recheck`
- conditional scope: `in effect during`, `active while … continues/ongoing/rolling out`

If any marker matches, the fact must carry structured recency metadata
(`validFrom` or `invalidAt` on the facts row) to be eligible for durable
promotion. Plain ISO dates in the content text are **not** a bypass: a
sentence like `suspended pending X as of 2026-04-18` still contains the
temporal markers `suspended` and `pending`, and the date only confirms
that the claim is time-bound.

**Extending the marker list.** The list is exported from
`src/dreaming-promoter.ts` as `TEMPORAL_MARKERS`. Keep it centralized.
Tests in `test/dreaming-promoter-temporal.mjs` exercise coverage on both
direct and disguised phrasing; add new fixtures there when adding markers.

**Implications for hand-written `MEMORY.md` entries.** The same
discipline applies at the authoring layer. If you find yourself writing
"currently," "for now," "pending X," or "in effect during Y" in the
static index, add an explicit date-stamped condition or move the note to
a daily file. The promoter's screen is a safety net, not a substitute
for good authoring.
