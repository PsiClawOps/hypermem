# HyperMem Installation Experience - 2026-04-19

Author: Pylon  
Requested by: ragesaq  
Audience: Forge / operators / docs owners

Scope covered in this report:
- fresh npm library install from public package `@psiclawops/hypermem@0.8.1`
- public docs and plugin install path from the linked GitHub repo
- repeatable install validation on `psiclaw01` using snapshots
- live production wiring and activation on the current host

---

## Executive Summary

HyperMem is now real, installable, and usable.

What worked:
- npm package install worked
- library mode worked in a fresh project
- public repo build worked
- `plugin` and `memory-plugin` builds worked
- `npm run install:runtime` worked
- plugin load worked after correct OpenClaw wiring
- production activation worked, and the gateway now loads `hypercompositor` and `hypermem`

What did not work cleanly:
- docs still assume too much OpenClaw/operator knowledge
- the JS `dataDir` example is misleading
- npm package/docs packaging is still inconsistent in places
- verification commands are too sensitive to environment and auth state
- `plugins.allow` guidance can break normal CLI surfaces
- some OpenClaw cold-start assumptions are unstated

Bottom line:
- **core package and runtime:** good enough now
- **new-user install experience:** still too fragile
- **operator install experience:** workable, but sharper than it should be

---

## Test Modes Covered

### 1. Fresh npm library path
Started from a blank temp project and used the published package only.

### 2. Public docs plugin path
Followed the public README and install flow from the linked public repo.

### 3. Repeatable VM install validation on `psiclaw01`
Used snapshots to reset state and rerun installs from a clean baseline.

### 4. Production activation
Built and wired HyperMem into the live OpenClaw environment on the current host.

---

## Phase 1: Fresh npm Library Install

### What I did
- `npm init -y`
- `npm install @psiclawops/hypermem`
- imported `HyperMem`
- created an instance with `embedding.provider = "none"`
- recorded a message
- ran `compose()`

### What worked
- package installed cleanly from npm
- documented import path worked
- `HyperMem.create(...)` worked
- `recordUserMessage(...)` worked
- `compose(...)` worked
- returned structured output including `contextBlock`
- `embedding.provider = "none"` gave a clean no-credentials first-run path
- logs clearly stated FTS5 fallback when embeddings were disabled

### What did not work cleanly
- public README example uses:
  ```js
  dataDir: '~/.openclaw/hypermem'
  ```
  In plain JavaScript, `~` is a literal character, not home expansion.
- copying that example literally created project-local state under `./~/.openclaw/hypermem`

### Why it matters
A new user can think data is being stored in their real home directory when it is actually going into a local folder named `~`.

### Recommended fix
Replace the example with an explicitly expanded home path, for example via `os.homedir()` and `path.join(...)`.

---

## Phase 2: Public Docs and Plugin Install Path

### What I did
From the public repo/docs path, I ran:
- root `npm install`
- root `npm run build`
- `npm --prefix plugin install && npm --prefix plugin run build`
- `npm --prefix memory-plugin install && npm --prefix memory-plugin run build`
- `npm run install:runtime`
- `npm test`

Then I followed the printed OpenClaw wiring steps.

### What worked
- repo build completed
- both plugin builds completed
- `npm run install:runtime` completed
- `npm test` passed
- runtime assets staged correctly
- plugin loading was real after wiring
- isolated gateway eventually showed `ready (2 plugins: hypercompositor, hypermem; 4.4s)`

### What did not work cleanly

#### 1. Docs/package mismatch
In the docs-only pass, the installed npm package shipped `README.md` but not `INSTALL.md`, even though README told users to read `INSTALL.md`.

#### 2. `install:runtime` name over-promises
The command stages runtime assets and prints next-step config commands, but it does not complete installation end to end.

#### 3. Cold-start OpenClaw assumptions are unstated
The docs imply `openclaw gateway restart` is the next step. In a truly fresh OpenClaw home, that was not sufficient.
Observed failures included:
- gateway service disabled
- missing `gateway.mode`
- need for non-interactive onboarding/bootstrap before gateway operations made sense

#### 4. Verification commands assume the wrong environment
Examples like:
- `node bin/hypermem-status.mjs --health`
- `openclaw logs --limit 50 | grep hypermem`
can fail for reasons unrelated to HyperMem itself:
- wrong data directory
- missing `HYPERMEM_DATA_DIR`
- gateway auth/token mismatch
- gateway not yet bootstrapped

#### 5. Empty-state verification reads like failure
Before any session ingest, health/status could fail with:
- `Error: no agent messages.db found. Has HyperMem ingested any sessions?`
That reads like broken install, even when the install is otherwise fine.

### Recommended fixes
- Ship `INSTALL.md` in the npm package if README references it
- Split docs into two explicit tracks:
  - library mode
  - OpenClaw plugin mode
- Add a real cold-start plugin quickstart for brand-new OpenClaw users
- Document when `HYPERMEM_DATA_DIR` is required
- Document what empty-state health output means
- Clarify that `install:runtime` is runtime staging plus instructions, not full automatic integration

---

## Phase 3: Repeatable Validation on `psiclaw01`

Operator directive followed:
- all HyperMem install testing ran on `psiclaw01`
- `openclaw-prod` treated as production and read-only for this validation stream
- snapshots used to keep the install path repeatable

### Snapshot-driven reruns performed
I used clean snapshots including:
- `pre-hypermem-080-dryrun-20260419-0342`
- `clean-hypermem-retry-20260419-0346`
- `hm080clean0419`

### What worked
- install/build/test path succeeded repeatedly from a clean VM baseline
- `npm run install:runtime` succeeded and installed to `~/.openclaw/plugins/hypermem`
- internal-source rerun confirmed the runtime payload itself was not the failing part
- snapshot reset process made the evaluation repeatable and trustworthy

### What did not work cleanly

#### 1. Public/internal version drift confused the story
At one point:
- requested tag object: `621c0ed`
- resolved commit: `85f19055...`
- public repo state still looked like `0.7.0` in an earlier pass
- public/docs/runtime story was not cleanly aligned

#### 2. Shell quoting around `plugins.load.paths` was fragile
The documented strict-json example failed in one environment with:
- `Unexpected token '/'`
I had to generate the JSON string via Python to avoid quoting breakage.

#### 3. `plugins.allow` guidance over-restricted OpenClaw
Setting:
```json
["hypercompositor", "hypermem"]
```
cut the gateway down too aggressively and broke bundled CLI surfaces like `openclaw help`.

#### 4. Trying to repair that with `help` did not behave cleanly
Adding `help` back produced:
- `plugin not found: help (stale config entry ignored)`
That points to an OpenClaw/plugin-allow UX mismatch or naming bug, not a HyperMem runtime failure, but it is still part of the install experience.

#### 5. Some observed failures were not actually installer bugs
Important correction: one failure after `install:runtime` came from my remote orchestration helper, not from HyperMem. An inline Python helper used `os.path.expanduser(~)` without quotes and raised `SyntaxError`. That specific failure should not be counted against HyperMem.

#### 6. End-to-end turn testing on `psiclaw01` hit host auth constraints
Observed blockers included:
- `openclaw agent --local` failed due to invalid/reused OpenAI Codex OAuth refresh token
- `openclaw gateway call sessions.create` hit `pairing required` even with configured gateway auth token
Those are environment/auth issues, not HyperMem core failures, but they block the last mile of install verification.

### Recommended fixes
- tighten release/package/docs alignment so public docs always match public artifacts
- replace shell-fragile JSON examples with copy-paste-safe commands
- stop telling users to replace `plugins.allow` with a HyperMem-only list unless the docs also preserve required bundled surfaces
- document what parts of verification require gateway auth, pairing, or working model credentials

---

## Phase 4: Live Production Activation

### What I did
On the current host, I:
- installed `@psiclawops/hypermem`
- read the shipped `README.md` and `INSTALL.md`
- followed the production plugin path from `INSTALL.md`
- built root package, `plugin`, and `memory-plugin`
- installed runtime payload to `~/.openclaw/plugins/hypermem`
- created `~/.openclaw/hypermem/config.json` with `embedding.provider = "none"`
- merged production `plugins.load.paths` and `plugins.allow`
- set:
  - `plugins.slots.contextEngine = hypercompositor`
  - `plugins.slots.memory = hypermem`
- restarted the gateway

### What worked
- gateway restart succeeded
- `openclaw gateway status` was healthy
- config now points at HyperMem plugin paths and slots
- logs showed HyperMem loading successfully
- logs showed compose activity for live sessions
- production gateway reported HyperMem active alongside normal plugin stack

### Evidence captured
Config/runtime state observed:
- `slots.contextEngine = hypercompositor`
- `slots.memory = hypermem`
- `plugins.load.paths` includes:
  - `~/.openclaw/plugins/hypermem/plugin`
  - `~/.openclaw/plugins/hypermem/memory-plugin`
- `plugins.allow` includes HyperMem without stripping the rest of the production stack
- gateway status healthy
- recent logs show:
  - `[hypermem-plugin] Loaded legacy config ...`
  - `[hypermem] Embedding provider: none`
  - `[hypermem:compose] agent=pylon ...`
  - `ready (5 plugins: browser, code-tools, discord, hypercompositor, hypermem; 12.2s)`

### What did not work cleanly
- logs showed repeated `pressure-accounting anomaly` warnings from the HyperMem plugin after activation
- install was successful, but those warnings should be treated as follow-up investigation material

### Recommended fixes
- investigate the `pressure-accounting anomaly` warnings separately from installer/docs work
- keep production install instructions explicit about merging with existing `plugins.allow` rather than replacing it wholesale

---

## What Worked Best

These are the strongest parts of the current installation experience:

1. **Library mode is now real**
   A fresh user can install the npm package and use it immediately.

2. **`embedding.provider = "none"` is the right first-run escape hatch**
   It removes credentials and embedding services as early blockers.

3. **The public repo build/install path is no longer fake**
   Builds, runtime staging, tests, and plugin loading all worked.

4. **Snapshot-based reruns on `psiclaw01` held up**
   The install process is repeatable enough to evaluate seriously now.

5. **Production activation worked**
   HyperMem is active on the live host now.

---

## What Caused the Most Friction

1. **Path examples that look correct but are not correct in JS**
2. **Docs that assume existing OpenClaw onboarding/service state**
3. **Verification commands that fail for environment reasons but look like product failures**
4. **`plugins.allow` guidance that is too blunt for real OpenClaw installs**
5. **Package/docs/release drift that forces users to second-guess what is canonical**

---

## Recommended Fix List

### P1 - Fix now
1. Fix the JS `dataDir` example. Do not use literal `~` in JS docs.
2. Ship `INSTALL.md` with the npm package if README references it.
3. Add a cold-start OpenClaw plugin quickstart with explicit prerequisites.
4. Stop using HyperMem-only `plugins.allow` examples that break normal OpenClaw surfaces.
5. Replace shell-fragile strict-json examples with copy-paste-safe commands.

### P2 - Next pass
6. Split docs into `library mode` and `OpenClaw plugin mode`.
7. Clarify exactly what `install:runtime` does and does not do.
8. Document `HYPERMEM_DATA_DIR` and status target behavior.
9. Document empty-state health output so users do not mistake it for install failure.
10. Call out what verification steps require gateway auth, pairing, or live model credentials.

### P3 - Follow-up investigation
11. Investigate the `pressure-accounting anomaly` warnings seen after production activation.
12. Clarify the OpenClaw `plugins.allow` / `help` naming mismatch or UX bug.
13. Improve new-user verification so plugin success can be distinguished from host auth problems.

---

## Final Judgment

The HyperMem installation experience is no longer blocked on substance.
It is blocked on clarity.

That is progress.

The package works. The plugin path works. Production activation worked.
What still needs work is the path a new or even moderately experienced operator must follow to reach that success without guesswork.

If Forge wants the shortest accurate summary:

**HyperMem now installs and runs, but the docs and verification path still make it feel harder and riskier than it actually is.**
