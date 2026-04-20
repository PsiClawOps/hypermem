# HyperMem installation experience report

Date: 2026-04-20
Author: Pylon
Requested by: ragesaq
Scope: fresh-user package path, live install validation, source fixes applied after the run, and reset of the test server for another reinstall cycle

## Executive summary

This install cycle was a partial success.

The good news:
- `@psiclawops/hypermem@0.8.4` installed cleanly
- `npx hypermem-install` completed cleanly
- runtime payload landed in `~/.openclaw/plugins/hypermem`
- manual OpenClaw wiring worked
- gateway restart succeeded
- `hypercompositor` and `hypermem` both loaded at runtime
- logs showed live HyperMem compose activity
- the earlier `Cannot find module 'zod'` failure did not reproduce in this pass

The bad news:
- the install is still not truly one-step for a fresh operator
- docs and installer output still left too much OpenClaw wiring knowledge on the user
- config hygiene around `plugins.allow` remains the biggest footgun
- release/source parity is still not clean enough
- the test server needed manual cleanup to get back to a known reinstall baseline

Bottom line:
- core runtime viability: PASS
- operator install ergonomics: PARTIAL PASS
- fresh-user clarity: still needs work

## What went well

### 1. Package and runtime staging worked

This run successfully got through:

```bash
npm install @psiclawops/hypermem
npx hypermem-install
```

Observed result:
- package install succeeded
- runtime assets were staged under `~/.openclaw/plugins/hypermem`
- helper output was usable enough to complete the rest of the integration manually

### 2. Live OpenClaw activation worked

After wiring the plugin paths and slots, the gateway restarted successfully and the plugin stack came up live.

Verified live state:
- `plugins.load.paths` included:
  - `~/.openclaw/plugins/hypermem/plugin`
  - `~/.openclaw/plugins/hypermem/memory-plugin`
- `plugins.slots.contextEngine = hypercompositor`
- `plugins.slots.memory = hypermem`
- `openclaw plugins list` showed both plugins loaded at `0.8.4`
- logs showed HyperMem activity, including compose calls

### 3. Lightweight mode behaved correctly

The install used `embedding.provider = "none"` and the runtime clearly reported the expected FTS5 fallback path instead of failing on missing embedding credentials.

That is the right first-run behavior.

## Where it failed or still fell short

### 1. `npx hypermem-install` is still not the full install

It stages runtime assets and prints next steps, but the operator still has to:
- inspect current OpenClaw plugin config
- merge `plugins.load.paths`
- merge `plugins.allow` if an allowlist exists
- set plugin slots
- restart the gateway
- know how to verify the result

That means the install is not really one-shot. It is runtime staging plus guided manual integration.

### 2. `plugins.allow` is still the sharpest edge

This has been the consistent install defect across repeated passes.

Any guidance that effectively replaces the allowlist with only:

```json
["hypercompositor", "hypermem"]
```

is dangerous on a real OpenClaw install. It can drop unrelated but required plugin surfaces and make normal CLI behavior look broken.

### 3. Docs still assume OpenClaw operator knowledge

The install path still expects the user to already understand:
- how OpenClaw plugin path loading works
- when `plugins.allow` matters
- how to merge JSON config safely
- what a clean plugin-slot activation looks like
- what logs matter after restart

That is fine for an internal operator. It is not fine for a fresh user path.

### 4. Source and published state are still not obviously in lockstep

During review, the local GitHub source tree used for fixes was not the same visible version story as the currently installed npm package.

Current observed split:
- live validated package path: `0.8.4`
- source repo repair commit: `849eedd`
- visible repo history before that still reflected older package-version context

That drift makes installation review harder than it needs to be.

### 5. Stale plugin config noise is still present on the test host

`openclaw plugins list` still warns about stale config entries for `foundry-openclaw` and `code-tools`.

That is not a HyperMem runtime failure, but it pollutes the validation surface and makes first-pass diagnosis noisier.

## What I fixed during this cycle

Repo: `PsiClawOps/hypermem`
Commit pushed: `849eedd`

### Fix 1. Safer README / INSTALL guidance

I removed the destructive install guidance and rewrote the plugin wiring instructions so they no longer tell the operator to blindly replace a working allowlist.

What changed:
- npm-first install path is clearer
- operators are told to inspect current config before writing
- allowlist mutation is conditional instead of assumed
- docs now emphasize merge behavior instead of replacement behavior

### Fix 2. Installer output is now merge-aware

I updated `scripts/install-runtime.mjs` so the helper script reads current OpenClaw config and prints better next steps.

What changed:
- `plugins.load.paths` guidance is merged against current config when possible
- `plugins.allow` guidance is only printed as a merge when an allowlist already exists
- otherwise the operator is told to skip the allowlist step unless their install actually uses one

This directly fixes the most dangerous part of the prior install output.

## What still needs to be fixed

### 1. Make the install truly one-shot, or say clearly that it is not

Right now the product is between two states:
- it behaves like a guided installer
- users read it like a full installer

Pick one.

Best fix:
- either make `hypermem-install` perform the OpenClaw integration end to end, with safe merge behavior and explicit confirmation points
- or rename/reframe it as runtime staging plus printed wiring instructions

### 2. Publish a clean fresh-user plugin path

A brand-new user should not have to infer the difference between:
- library use
n- npm package runtime staging
- source-clone plugin builds
- OpenClaw config integration

The docs should split these paths explicitly.

### 3. Clean up release parity

The public repo, npm package, and install docs need a simpler shared truth.

A reviewer should be able to answer three questions instantly:
- what version is on npm
- what commit produced it
- whether GitHub main reflects that install story

### 4. Improve verification UX

Verification should say the difference between:
- runtime staged but not wired
- wired but not restarted
- loaded and healthy
- healthy but empty because no sessions have been ingested yet

Right now too much of that is inferred from logs and operator experience.

### 5. Clean the stale OpenClaw config noise on the test host

HyperMem validation on this host is noisier than necessary because stale entries remain in the wider OpenClaw plugin config.

That is outside HyperMem core, but it still affects the install experience and should be cleaned separately.

## Test-server reset actions

After capturing this report, I reset the test host back toward a clean reinstall baseline by removing HyperMem-specific wiring and quarantining the current HyperMem runtime/data directories instead of deleting them.

Reset target:
- no HyperMem plugin load paths
- no HyperMem plugin slots
- no HyperMem allowlist entries
- runtime/data preserved under quarantine for rollback or inspection

## Final verdict

This cycle proved the important thing: HyperMem does install and run for real.

The remaining problems are mostly install-product problems:
- installer scope is ambiguous
- docs still rely on operator intuition
- config safety needs more polish
- release parity needs cleanup

If the goal is "can it work", the answer is yes.

If the goal is "can a fresh operator do it cleanly without guessing", the answer is not yet.
