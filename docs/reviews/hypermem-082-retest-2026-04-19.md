# HyperMem 0.8.2 Re-Test — 2026-04-19

Author: Pylon  
Requested by: ragesaq  
Scope: regression check on P1 fixes plus cold-start docs-only plugin attempt on `psiclaw01`

---

## Executive Summary

The 0.8.2 release fixes some real issues, but not all of the promised P1 install pain is closed.

What passed:
- npm package `@psiclawops/hypermem@0.8.2` installs cleanly
- `INSTALL.md` now ships in the npm package
- README library example no longer uses literal `~`; it now uses `homedir()` + `join()`
- README library example works as written
- the exact `plugins.load.paths` strict-json command in `INSTALL.md` now works on first try
- empty-state and onboarding caveats are more explicit than before

What still fails or remains contradictory:
- `INSTALL.md` still shows a destructive `plugins.allow` replacement command, even though the prose warns to merge
- the claimed `HYPERMEM_PATHS` variable pattern is not what shipped in the npm docs I tested; the docs still show inline JSON for `plugins.load.paths`
- a true cold-start docs-only attempt is still blocked because HyperMem docs stop at "complete OpenClaw onboarding first" and do not provide a self-contained path beyond that prerequisite
- `openclaw gateway status` in a clean home is still confusing because it reports the live local gateway process while also saying the clean home has no config

Bottom line:
- **library path:** fixed and credible
- **quoted `plugins.load.paths` command:** fixed
- **`plugins.allow` guidance:** still not safe enough
- **cold-start docs-only plugin onboarding:** still not closed

---

## Test Environment

Host:
- `psiclaw01`

Package tested:
- `@psiclawops/hypermem@0.8.2`

Public docs used only:
- shipped npm `README.md`
- shipped npm `INSTALL.md`
- public GitHub clone path referenced by the docs

Rules followed:
- no source reading
- no test reading
- no internal docs for HyperMem recovery

I used two separate paths:
1. **Fresh library install** in a temp project
2. **Plugin install** in isolated scratch OpenClaw homes, one truly cold and one seeded with a config so I could regression-test the exact config commands without touching the real host config

---

## 1. Fresh npm Package Regression Check

### Result
Pass.

### What I verified
- installed `@psiclawops/hypermem@0.8.2`
- confirmed package version `0.8.2`
- confirmed shipped docs now include:
  - `README.md`
  - `INSTALL.md`
  - `ARCHITECTURE.md`
  - `CHANGELOG.md`
- confirmed README library example now uses:
  - `import { join } from 'node:path'`
  - `import { homedir } from 'node:os'`
  - `dataDir: join(homedir(), '.openclaw', 'hypermem')`

### Library example execution
I ran the README library example as written, with `embedding.provider = "none"`.

Observed result:
- `HyperMem.create(...)` succeeded
- `recordUserMessage(...)` succeeded
- `compose(...)` succeeded
- returned structured output with keys including:
  - `contextBlock`
  - `diagnostics`
  - `messages`
  - `slots`
  - `tokenCount`

### Judgment
This fix is real.
The old literal `~` docs bug is resolved in the README example I tested.

---

## 2. `INSTALL.md` Packaging Regression Check

### Result
Pass.

### What changed
`INSTALL.md` is now present in the published package.

### Judgment
This closes one of the earlier hard packaging/docs mismatches.

---

## 3. `plugins.load.paths` Quoting Regression Check

### Result
Pass, with a caveat.

### What I tested
Using an isolated seeded OpenClaw home, I ran the exact command shown in `INSTALL.md`:

```bash
openclaw config set plugins.load.paths "[\"$HOME/.openclaw/plugins/hypermem/plugin\",\"$HOME/.openclaw/plugins/hypermem/memory-plugin\"]" --strict-json
```

### Observed result
The command worked on first try.
No JSON parse failure.
No `Unexpected token '/'` error.

### Caveat
The brief said the docs now use a `HYPERMEM_PATHS` variable pattern.
That is **not** what shipped in the npm `INSTALL.md` I tested.
The docs still show inline JSON in the command itself.

So the real conclusion is:
- the inline quoting appears fixed enough to work in this environment
- the specific docs change described in the brief is not what I actually saw in the package docs

---

## 4. `plugins.allow` Guidance Regression Check

### Result
Still not good enough.

### What the docs now say
The prose now includes a merge warning:
- if you already have values in `plugins.load.paths` or `plugins.allow`, merge them instead of overwriting them blindly

That is an improvement.

### What the docs still tell the user to run
They still show this exact command:

```bash
openclaw config set plugins.allow '["hypercompositor","hypermem"]' --strict-json
```

### What happened when I ran it in a seeded home
It replaced the existing allowlist with only:
- `hypercompositor`
- `hypermem`

It also caused OpenClaw warnings about existing configured plugins now being disabled because they were no longer in the allowlist.

### Judgment
This is still contradictory and still unsafe.
The prose says merge, but the copy-paste command still replaces.
A new user following the literal command will still narrow the allowlist destructively.

### Recommended fix
The docs need an actual merge-safe command sequence, not just a warning paragraph.

---

## 5. Cold-Start Docs-Only Attempt

### Result
Still blocked.

### What I tested
I created a truly clean OpenClaw home and followed only the published docs prerequisites path.

### Observed behavior
In the clean home:
- `openclaw gateway status` reported that the config was missing
- `openclaw config get gateway` failed with `Config path not found: gateway`

The docs now say, correctly, that:
- OpenClaw must already be installed, onboarded, and running
- if the gateway is disabled or not configured, complete OpenClaw onboarding first

### Where the docs still stop
That is the blocker.
The HyperMem docs do not provide a self-contained path beyond that prerequisite.
So in a true cold-start docs-only attempt, I still hit:
- "complete OpenClaw onboarding first"
- and then the HyperMem docs are done helping

### Additional confusion still present
`openclaw gateway status` in the clean home also surfaced the already-running local gateway process on the machine, while simultaneously reporting the clean home had no config. That is technically understandable, but for a docs-only new user it is muddy.

### Judgment
The docs are improved because they now state the prerequisite plainly.
But the cold-start gap itself is not closed.
A true first-time OpenClaw user is still outside the supported path.

---

## 6. What Improved Since the Previous Review

Real improvements I confirmed:
1. README no longer uses literal `~` in the library example
2. `INSTALL.md` is now in the npm package
3. the inline `plugins.load.paths` command worked cleanly here
4. empty-state/onboarding caveats are more explicit in the docs

---

## 7. What Still Needs Work

### P1 remaining
1. Replace the destructive `plugins.allow` example with a merge-safe one
2. Make the docs match the actual shipped command pattern consistently
3. Clarify the cold-start boundary more bluntly: HyperMem plugin install is for already-onboarded OpenClaw homes only

### P2 next
4. Add an explicit "existing OpenClaw home" versus "brand-new OpenClaw user" split
5. Give a concrete merge recipe for both `plugins.load.paths` and `plugins.allow`
6. Improve the wording around `openclaw gateway status` in clean-home situations so users do not mistake another running gateway for success in the clean target home

---

## Final Judgment

0.8.2 is materially better.

The most obvious public docs bug is fixed, the package includes the install guide, and the quoted load-path command no longer failed for me.

But two important things remain true:
- the `plugins.allow` docs are still internally contradictory
- the cold-start docs-only plugin story is still not end-to-end

If I reduce it to one line:

**HyperMem 0.8.2 fixed the easiest install failures, but it still does not give a true cold-start user a complete plugin path without prior OpenClaw knowledge.**
