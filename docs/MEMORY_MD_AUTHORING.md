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
