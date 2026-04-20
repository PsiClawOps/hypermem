# HyperMem New-User Evaluation — 2026-04-19

Author: Pylon  
Requested by: ragesaq  
Intended reviewer: Forge

Repo target: `https://github.com/psiclawops/hypermem-internal`  
Package tested: `@psiclawops/hypermem@0.8.1`

Public sources used for setup and expectations only:
- npm package metadata
- published npm README
- linked GitHub repo: `https://github.com/PsiClawOps/hypermem`
- public install docs in the linked repo

---

## Executive Summary

I tested HyperMem the way an actual new user would: cold start, fresh temp directory, npm first, docs first, no assumptions about exports, config, CLI behavior, or plugin wiring.

The result is substantially better than the older state, but not yet clean enough to call frictionless.

**Bottom line:**
- The npm package is real and usable.
- The documented library import works.
- Minimal local usage works.
- The CLI works.
- The OpenClaw plugin path works.
- The repo builds and tests cleanly.
- The new-user path still contains avoidable confusion around path handling, CLI defaults, and fresh OpenClaw bootstrap expectations.

My blunt read for Forge:
- **Core functionality:** credible now
- **Library mode:** usable now
- **Operator plugin mode:** workable now
- **True first-contact OpenClaw plugin onboarding:** still too implicit

This fix improved substance more than onboarding clarity. That is the right order. The next round should focus on reducing guesswork.

---

## Scope and Rules I Followed

I constrained the test to public information only.

I did **not** assume:
- what the package exports
- what its defaults are
- how it stores data
- how its CLI behaves
- how plugin installation is wired
- what OpenClaw state is required for plugin loading

I treated every unclear or guessed step as a finding.

I verified two paths only after the docs supported them:
1. **Fresh-project library use from npm**
2. **OpenClaw plugin install/load from the public repo docs**

---

## Fresh Test Environment

I created a fresh temp root and worked only inside it.

Test root used:
- `/tmp/hypermem-081-newuser-Jdjn8C`

Public repo clone used for doc/build/install verification:
- commit `fb37163b53077f9b0c80d007a48ae0135e92205a`

At the end of the test, I removed the temp root completely.

---

## Public Package Discovery

I started with npm metadata and public docs.

Confirmed from npm:
- published version: `0.8.1`
- `latest` dist-tag: `0.8.1`
- repo URL: `git+https://github.com/PsiClawOps/hypermem.git`
- homepage: `https://github.com/PsiClawOps/hypermem#readme`

I compared the npm README against the GitHub README.

Result:
- **No README drift found**
- npm README and GitHub `README.md` were identical in the tested state

That matters. It means a user reading npm is not being misled by stale README content.

---

## Fresh npm Install and Package Shape

In a brand new project, I ran:
- `npm init -y`
- `npm install @psiclawops/hypermem`

Install succeeded.

I then inspected the installed package rather than guessing.

Observed from `node_modules/@psiclawops/hypermem/package.json`:
- `"type": "module"`
- `"main": "dist/index.js"`
- `"version": "0.8.1"`
- binary:
  - `hypermem-status`

Observed exports include:
- `HyperMem`
- `buildSpawnContext`
- `MessageStore`
- `DocChunkStore`
- many additional exports beyond the minimal README examples

The documented import path worked as published:
```js
import { HyperMem } from '@psiclawops/hypermem';
```

This is a strong improvement. The package surface is inspectable and behaves like a real npm package.

---

## Library-Mode Test

I next tested the published library API in a new project.

### What I tried

I followed the public example shape, with one adjustment only for embedding config:
- `HyperMem.create(...)`
- `recordUserMessage(...)`
- `compose(...)`

I used:
```js
const hm = await HyperMem.create({
  dataDir: '~/.openclaw/hypermem',
  cache: { maxEntries: 10000 },
  embedding: { provider: 'none' },
});
```

Then:
```js
await hm.recordUserMessage('my-agent', 'agent:my-agent:webchat:main', 'How does drift detection work?');
```

Then:
```js
const composed = await hm.compose({
  agentId: 'my-agent',
  sessionKey: 'agent:my-agent:webchat:main',
  prompt: 'How does drift detection work?',
  tokenBudget: 4000,
  provider: 'anthropic',
});
```

### Result

This worked.

Observed runtime output included:
- cache connected
- embedding provider `none`
- semantic search disabled, using FTS5 fallback
- compose returned a structured result with keys including:
  - `contextBlock`
  - `diagnostics`
  - `messages`
  - `slots`
  - `tokenCount`
  - `warnings`

This is the single most important success in the whole evaluation. A new user can install the package, import it, initialize it, record a message, and get a composed context block without needing extra services.

---

## Important Path-Handling Finding

The README example uses:
```js
dataDir: '~/.openclaw/hypermem'
```

In shell usage, `~` suggests home expansion.

In a JavaScript string, it does **not** expand automatically.

### What happened in practice

Using that literal example in a plain Node project created:
- `./~/.openclaw/hypermem`

inside the project directory.

I confirmed the package created:
- `/tmp/hypermem-081-newuser-Jdjn8C/fresh-project/~/.openclaw/hypermem`
- with `library.db` under that relative path

### Why this matters

A new user copying the example literally may think data is going to their real home directory, when it is actually going into a local folder named `~`.

That is not a minor polish issue. It is a real docs correctness problem.

### Recommendation

Do one of these:
- replace the literal string with an actual home-resolved example using `os.homedir()` / `path.join(...)`, or
- explicitly warn that `~` is shell shorthand and must be expanded in application code

If this is left as-is, users will create accidental local state in the wrong location.

---

## CLI Test

I then tested the bundled CLI.

### What worked

From the fresh project:
- `npx hypermem-status --health`

returned healthy in the project-local data case created by the literal `~` example.

The package-local bin also worked:
- `node_modules/.bin/hypermem-status --health`

### Additional finding

The CLI has a default data-dir expectation that can surprise users.

When checking a different environment, I had to set:
- `HYPERMEM_DATA_DIR=/path/to/data`

for the status command to inspect the intended store.

### Why this matters

On a machine with more than one OpenClaw or HyperMem environment, it is easy to inspect the wrong store and get misleading health results.

### Recommendation

The docs should say plainly:
- what directory `hypermem-status` uses by default
- when `HYPERMEM_DATA_DIR` is needed
- how to confirm which store is being checked

That is small documentation work with high operator payoff.

---

## Public Repo Build and Runtime Install Test

Because the public docs describe OpenClaw plugin support, I tested the documented build/install path from the linked GitHub repo.

I followed the published steps:
- `npm install`
- `npm run build`
- `npm --prefix plugin install && npm --prefix plugin run build`
- `npm --prefix memory-plugin install && npm --prefix memory-plugin run build`
- `npm run install:runtime`
- `npm test`

### Result

All of that worked.

Observed outcomes:
- root package built successfully
- plugin built successfully
- memory-plugin built successfully
- `install:runtime` staged runtime assets successfully
- `npm test` completed successfully with exit code `0`

This is a real improvement in credibility. The public repo is not merely documentation, it is a runnable install surface.

---

## Runtime Install Behavior

`npm run install:runtime` installed the runtime into the isolated OpenClaw home at:
- `/tmp/hypermem-081-newuser-Jdjn8C/home/.openclaw/plugins/hypermem`

The script then printed explicit next-step commands for wiring plugins into OpenClaw:
- `plugins.load.paths`
- `plugins.slots.contextEngine`
- `plugins.slots.memory`
- `plugins.allow`
- gateway restart

This is directionally good because it does not hide the required config.

But from a new-user point of view, `install:runtime` is still only a staging step, not a full installation flow.

### Recommendation

Either:
- rename the step so expectations are lower, or
- make it actually complete the config wiring, or
- keep the current behavior but call it out more bluntly as “runtime staging only”

Right now the command name suggests more completeness than it delivers.

---

## OpenClaw Plugin Wiring Test

After runtime staging, I manually followed the printed config commands inside an isolated OpenClaw home.

I set:
- `plugins.load.paths`
- `plugins.slots.contextEngine = hypercompositor`
- `plugins.slots.memory = hypermem`
- `plugins.allow = ["hypercompositor","hypermem"]`

I also created the documented HyperMem config file at:
- `~/.openclaw/hypermem/config.json`

with:
```json
{
  "embedding": {
    "provider": "none"
  }
}
```

This mattered because I was testing the no-embedding path first and wanted to avoid extra provider setup.

---

## Fresh OpenClaw Bootstrap Friction

This is one of the biggest first-run findings.

### What the docs implied

The printed install flow ends with:
- `openclaw gateway restart`

### What happened in practice in a truly fresh isolated home

That was not enough.

Observed behavior:
- `openclaw gateway restart` reported the gateway service was disabled
- `openclaw gateway` then failed with:
  - existing config is missing `gateway.mode`
  - suggested re-running onboarding or setup

### What I had to do

I had to bootstrap the isolated OpenClaw home first with non-interactive onboarding before the gateway could run cleanly.

### Why this matters

For an existing operator installation, this is manageable.

For a genuine new user following the plugin docs, it is a confusing failure because the HyperMem install appears broken when the actual issue is that the OpenClaw home is not bootstrapped enough.

### Recommendation

The plugin docs should explicitly state prerequisites such as:
- OpenClaw must already be onboarded / configured
- a valid gateway config must exist before the restart step is meaningful

Without that note, a cold-start user is likely to blame HyperMem for an OpenClaw bootstrap issue.

---

## Gateway Start and Port Collision Friction

After onboarding the isolated OpenClaw home, I still hit another practical issue.

Running the gateway on one chosen port collided with an already-running local gateway instance.

Observed behavior on one attempt:
- address in use on `127.0.0.1:18889`
- another `openclaw-gateway` process was already listening there

I then reran the isolated gateway on a different explicit port and token.

That worked.

### Why this matters

This is not a HyperMem-specific bug, but it affects the plugin validation experience directly. A user trying to answer “did the plugin load?” now also has to reason about port selection, existing local gateways, and auth token targeting.

### Recommendation

The plugin quickstart should include one of:
- a safe isolated test-gateway command with explicit port/token, or
- a note that `gateway restart` assumes the normal local gateway layout is already the intended target

This is a docs clarity issue, not a code correctness issue.

---

## Plugin Load Verification

Once the isolated OpenClaw home was properly bootstrapped and the gateway was run on a clean port, the plugin path worked.

Observed gateway log line:
- `ready (2 plugins: hypercompositor, hypermem; 4.4s)`

Observed plugin listing showed both plugins loaded:
- `hypercompositor`
- `hypermem`

This is the strongest proof that the published plugin path is real and not merely aspirational.

---

## First Health Check Friction Before Any Ingest

Another sharp edge showed up when checking the memory store before any actual agent session had been ingested.

Observed error from health/status check in that state:
- `Error: no agent messages.db found. Has HyperMem ingested any sessions?`

That is technically reasonable, but from a first-run perspective it reads like failure even when the installation may actually be correct.

I then sent a test agent message in the isolated OpenClaw home so HyperMem had something to ingest.

After that, the health check passed.

Observed healthy result:
- main db: ✅
- library db: ✅
- status: ✅ healthy

### Recommendation

Document that the health check may behave differently before first ingest.

If possible, consider returning a more obviously non-fatal status for “installed but no session data yet” instead of wording that reads like breakage.

---

## Embedded Agent Test and a Non-HyperMem Failure

I also triggered a simple test message through the isolated OpenClaw agent path.

This successfully exercised HyperMem behavior around:
- legacy config load
- `embedding.provider = none`
- compose path
- indexing path

The final agent run itself then failed due to an unrelated provider auth issue:
- `401 Incorrect API key provided ...`

This does **not** read as a HyperMem failure.

In fact, the logs before that failure were useful because they showed the plugin was active and participating in the run.

So this step increased confidence that plugin loading was real, even though the downstream model invocation failed for unrelated credentials reasons.

---

## What Worked Well

### 1. The package is real now

This is the headline improvement.

A new user can install from npm, import the documented API, initialize the engine, record a message, and get a composed result. That clears the credibility bar that matters most.

### 2. `embedding.provider = none` is a very good first-run option

This is one of the strongest decisions in the current design.

It lets users validate functionality without getting blocked on embedding providers, model routing, or external credentials. The runtime also explains the fallback clearly.

That is exactly the right shape for infrastructure software: usable in a degraded but explicit mode.

### 3. The CLI is operationally useful

Once the data-dir behavior is understood, `hypermem-status --health` is a good support tool.

### 4. The plugin runtime is not fake

The build, install, and load path are real. That matters because it means the remaining problems are mostly onboarding and expectation-setting, not absence of functionality.

### 5. The test surface is healthier

`npm test` completed successfully in the public repo. That materially raises confidence versus older states where the delta between claims and runnable reality was much larger.

---

## What Did Not Work Cleanly

### 1. The `~` path example is misleading in JS

This is the most concrete docs bug I found.

### 2. The CLI default target can be ambiguous

Without `HYPERMEM_DATA_DIR`, it is easy to inspect the wrong store.

### 3. `install:runtime` does not finish installation from a new-user perspective

It stages runtime artifacts but still relies on manual OpenClaw config wiring.

### 4. The plugin docs understate fresh OpenClaw prerequisites

A brand-new isolated OpenClaw home did not have enough config state for the printed restart path to work immediately.

### 5. First-run health checks before ingest read more like failure than empty-state

That increases uncertainty exactly when a new user is trying to confirm success.

---

## Where I Got Confused

These were the main “I had to stop and infer” moments:

1. Whether `~/.openclaw/hypermem` in the README was intended as shell shorthand or literal JS string
2. Whether `install:runtime` was expected to be a full install or only artifact staging
3. Whether `openclaw gateway restart` assumed a pre-existing onboarded user service
4. Whether `hypermem-status --health` was expected to pass on a completely empty install
5. Which environment the CLI was inspecting when more than one HyperMem/OpenClaw home existed on the machine

Every one of those is documentation-solvable.

---

## Recommended Fixes for Forge

Priority order:

### 1. Fix the README path example immediately

Do not publish a literal JS string with `~` unless the code expands it.

Preferred fix:
- show a `path.join(os.homedir(), '.openclaw', 'hypermem')` style example

### 2. Add a zero-guess plugin quickstart

There should be one short copy-paste sequence for a first-time OpenClaw user that includes:
- prerequisites
- runtime install
- config keys
- gateway start/restart expectations
- verification commands
- expected success output

### 3. Clarify `install:runtime`

Say explicitly whether it:
- stages files only, or
- performs a complete installation

Right now it behaves like staging plus instructions.

### 4. Document `hypermem-status` target selection

State clearly:
- default data dir
- when to use `HYPERMEM_DATA_DIR`
- what failure looks like before first ingest

### 5. Document empty-state health behavior

If a fresh install has no ingested session yet, say that plainly in the docs.

### 6. If possible, reduce manual OpenClaw wiring

If automation is safe, consider a helper step that sets:
- `plugins.load.paths`
- `plugins.slots.contextEngine`
- `plugins.slots.memory`
- `plugins.allow`

That would eliminate the most operator-only part of the flow.

---

## Final Judgment

If the question is:
- **Did the fix make HyperMem real?** yes
- **Did the fix make HyperMem easy for a brand-new OpenClaw user?** not yet

My final rating of the current state:
- **Package integrity:** good
- **Minimal library usability:** good
- **Plugin functionality:** good
- **First-run plugin onboarding clarity:** mediocre
- **Docs correctness:** improved, but not yet tight enough

This is not a rollback situation.

The core direction is correct.

Forge should treat the next phase as an onboarding and docs hardening pass, not a rescue mission. The package now has enough substance that clarity work will pay off.

---

## Artifacts and Cleanup

Temp test root used:
- `/tmp/hypermem-081-newuser-Jdjn8C`

Public repo commit tested:
- `fb37163b53077f9b0c80d007a48ae0135e92205a`

Cleanup result:
- temp test root removed successfully
- no active HyperMem test directory left behind

---

## Delivery

This report is ready to place into `hypermem-internal` for Forge review.
