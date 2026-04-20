# HyperMem New-User Evaluation — 2026-04-19

Author: Pylon  
Requested by: ragesaq  
Intended reviewer: Forge

Repo target: `https://github.com/psiclawops/hypermem-internal`
Package tested: `@psiclawops/hypermem@0.8.1`
Public sources used for setup and expectations:
- npm package metadata
- published README / install docs
- linked GitHub repo: `https://github.com/PsiClawOps/hypermem`

---

## Executive Summary

I tested HyperMem the way a real new user would, starting cold, using only what was publicly published. The result is mixed but directionally good.

**What is now genuinely good:**
- The npm package is real, installable, and usable.
- The library exports are coherent once inspected.
- Minimal local usage works.
- The health CLI works.
- The OpenClaw plugin runtime can be built and loaded.
- The repo test surface appears materially stronger than the old broken-package-script state.

**What is still rough:**
- The first-run plugin path is still not self-explanatory.
- The OpenClaw integration story still assumes insider knowledge.
- There is still too much hidden configuration coupling between HyperMem and OpenClaw.
- The new-user journey is good enough for operators, not yet good enough for broad adoption.

My perspective on the fix: **it fixed the substance more than the experience**. That is real progress. The package is no longer smoke and mirrors. But the install path still asks a new user to infer too much.

---

## Test Scope

I intentionally did not assume anything about:
- package exports
- required config
- CLI behavior
- plugin load paths
- OpenClaw setup expectations

I started from npm and the published docs, then verified behavior in two layers:
1. **Fresh-project library usage**
2. **OpenClaw plugin/runtime loading**, only because the published repo/docs indicate that mode exists

---

## What I Did

### 1. npm package discovery
I looked at the published package metadata first.

Confirmed from the installed package:
- ESM package: `"type": "module"`
- main entry: `dist/index.js`
- CLI entry: `hypermem-status`

Confirmed exported symbols by inspecting the installed package instead of guessing:
- `HyperMem`
- `ENGINE_VERSION`
- `MIN_NODE_VERSION`
- `compose`
- `recordUserMessage`
- `contextBlock`

### 2. Fresh-project library test
I created a brand new temp project, installed from npm, and tried the smallest plausible working path.

Minimal working creation path:
```js
HyperMem.create({
  dataDir,
  embedding: { provider: 'none' }
})
```

Then I verified that I could:
- create the engine
- record a user message
- call `compose()`
- receive a composed context block

That worked.

### 3. CLI validation
I tested the bundled health command.

Observed behavior:
- `npx hypermem-status --health` fails if the default data dir is absent
- the error tells the user to set `HYPERMEM_DATA_DIR`
- after setting `HYPERMEM_DATA_DIR`, the health command succeeds

This is acceptable operationally, but the default data-dir assumption is discoverable only after failure.

### 4. Plugin/runtime validation
I then followed the repo path:
- clone repo
- build root
- build plugin
- build memory-plugin
- run `npm run install:runtime`

That successfully installed runtime assets into the isolated OpenClaw home under:
- `~/.openclaw/plugins/hypermem`

I then configured OpenClaw to load the plugin and verified gateway startup with plugin load success.

Observed gateway result:
- ready with `2 plugins: hypercompositor, hypermem`

So the plugin path is not hypothetical. It does load.

---

## What Worked Well

### 1. The package is actually usable now
This matters most.

The strongest positive change is that HyperMem can now be approached as a real package rather than a repo-only internal subsystem. I did not need source-level surgery to make the library work. I could install it, inspect it, instantiate it, and get a valid result.

That is the baseline credibility threshold for npm. HyperMem clears it.

### 2. The `embedding.provider = 'none'` fallback is a strong design choice
This was one of the most important enablers for new-user success.

It let me get working behavior without needing to solve vector infrastructure, provider credentials, or model routing first. The runtime clearly reported that semantic search was disabled and that it was falling back to FTS5 behavior.

That is good infrastructure posture:
- predictable
- inspectable
- low-friction
- reversible

### 3. The health CLI is useful once you know the data dir story
`hypermem-status --health` is a good operational affordance. It gives a fast yes/no on whether the local memory store is alive.

This is the kind of boring infrastructure tool that makes a package feel solid.

### 4. The runtime install script does real work
`npm run install:runtime` successfully staged the plugin runtime into OpenClaw's plugin area. That is a meaningful improvement over documentation that merely implies runtime support.

### 5. The repo tests look materially healthier
The repo test run completed successfully. From a confidence standpoint, this is important because the previous major concern on this codebase was always the gap between the claimed surface and the actual runnable surface.

This gap appears narrower now.

---

## Where the Experience Still Breaks Down

### 1. Plugin install is still too implicit
`npm run install:runtime` installs files. It does **not** finish the job from a new-user point of view.

I still had to manually wire OpenClaw config for:
- `plugins.load.paths`
- `plugins.slots.contextEngine`
- `plugins.slots.memory`
- `plugins.allow`

That means the runtime installer behaves like a deployment primitive, not a complete installation flow.

For an infrastructure operator, that is survivable. For a new user, it is confusing.

### 2. OpenClaw onboarding requirements are not folded into the HyperMem story
In an isolated fresh OpenClaw home, gateway startup initially failed because the config had no `gateway.mode`.

This is not HyperMem's fault in the narrow sense, but it absolutely affects the new-user experience of “install HyperMem as an OpenClaw plugin.”

From the user's point of view, the system simply does not come up.

I had to run non-interactive OpenClaw onboarding before plugin loading could even be tested. That requirement is not obvious in the HyperMem package story.

### 3. Gateway/runtime defaults are still leaky
Even after isolating the OpenClaw home and changing the intended port, the plain gateway startup path still collided with the host's already-running gateway on `127.0.0.1:18789`. The reliable path was explicit foreground run with explicit port and token.

This is the kind of thing an operator can work around quickly. It is also the kind of thing that makes a new-user integration feel brittle.

### 4. Remote URL/token expectations are not obvious
The isolated CLI still wanted to talk to the default gateway target until explicitly overridden. Again, not a HyperMem bug in isolation, but it pollutes the plugin validation experience.

The user trying to answer a simple question, “did the plugin load?”, now also has to reason about gateway routing and auth wiring.

### 5. The docs still make the user do interpretation work
The library mode was easier than plugin mode because the package itself was inspectable. The plugin mode depended on stitching together clues from:
- npm
- repo scripts
- OpenClaw behavior
- runtime config expectations

That is too many layers for first contact.

---

## My Perspective on the Fix

## The good news
The fix appears to have moved HyperMem from **promising but operationally slippery** to **real and testable**.

That is not cosmetic. It is a meaningful maturity jump.

The strongest evidence is simple:
- I could install it from npm
- I could use it in a new project
- I could run the health CLI
- I could build and load the plugin runtime
- the repo tests completed successfully

Those are the right fixes to make first. They address substance.

## The bad news
The fix does **not** yet make the product feel obvious.

The package now works better than it explains itself.

That means the code is ahead of the onboarding experience. This is a much better problem than the reverse, but it is still a real adoption problem.

## My read, bluntly
If the question is:
- **“Did the fix make HyperMem real?”** → yes
- **“Did the fix make HyperMem easy for a brand-new OpenClaw user?”** → not yet

I would describe the current state as:
- **library mode:** credible
- **operator mode:** workable
- **true new-user plugin mode:** still under-documented

---

## Specific Friction Points Forge Should Look At

### 1. Decide what `install:runtime` promises
Right now the name suggests a mostly-complete install step. In practice it stages runtime files only.

Pick one:
- rename it so expectations are lower, or
- make it actually finish config wiring, or
- add an immediate post-install output block with exact required OpenClaw config commands

### 2. Publish a zero-guess plugin quickstart
There should be one short path that a first-time user can copy exactly.

It should include:
- prerequisite OpenClaw onboarding state
- runtime install step
- exact config keys to set
- how to verify plugin load
- how to verify memory health
- what “successful” logs/output look like

### 3. Make the default data-dir story explicit
The README should say, plainly:
- where HyperMem expects data by default
- when to use `HYPERMEM_DATA_DIR`
- what gets created automatically and what does not

### 4. Separate library docs from plugin docs
Right now the working path for a new user is the library path. That should be presented first and cleanly.

Then plugin integration should be its own section with stronger assumptions spelled out.

### 5. Reduce hidden coupling to OpenClaw internals
If HyperMem is meant to be usable both as a package and as an OpenClaw runtime component, the boundary needs to be clearer.

The more the plugin path depends on “knowing how OpenClaw plugin slots and allowlists work,” the less it feels like a package and the more it feels like internal infrastructure.

That may be acceptable internally. It is not a good first-run story.

---

## Recommended Next Changes

Priority order:

1. **Add a literal copy-paste OpenClaw plugin install guide**
2. **Clarify what `install:runtime` does and does not do**
3. **Document the data-dir default and `HYPERMEM_DATA_DIR` immediately**
4. **Add a plugin verification command sequence to README/INSTALL**
5. **If possible, automate plugin slot/config wiring**

If only one thing gets done next, do item 1.

That single change would cut most of the confusion I hit.

---

## Final Recommendation to Forge

My recommendation is **not** “back out the fix.”

The fix made the package materially more real.

My recommendation is:
- keep the current technical direction
- treat the next gap as **installation clarity**, not core functionality
- tighten the public docs until a new user can succeed without repo spelunking

In infrastructure terms: the foundation is good enough to build on. The entry ramp is not.

That is fixable.

---

## Delivery Status

Created locally at:
- `/home/lumadmin/.openclaw/workspace-council/pylon/reviews/hypermem-new-user-evaluation-2026-04-19.md`

Upload status:
- **Not yet uploaded to `hypermem-internal`**
- blocker: no working GitHub auth was available on this host for that repo during this session
- observed failures:
  - HTTPS clone failed: `could not read Username for 'https://github.com': No such device or address`
  - SSH auth failed: `Permission denied (publickey)`

If repo auth is restored or a checked-out worktree is provided, this file is ready to commit immediately.
