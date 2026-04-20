# HyperMem install follow-up review

Date: 2026-04-20
Author: Hank
Scope: Fresh install rerun on `psiclaw01`, then source-level repair of issues that were clearly fixable

## Executive summary

The current published install path is materially better than yesterday's state. `npx hypermem-install` completed, the gateway restarted cleanly, `hypercompositor` and `hypermem` both loaded, and the earlier `Cannot find module 'zod'` runtime failure did not reproduce in this pass.

The install experience still had avoidable operator friction. Two defects were clear enough to fix immediately in source, and I fixed them:

1. docs no longer tell operators to replace `plugins.allow` with only `hypercompositor` and `hypermem`
2. `scripts/install-runtime.mjs` now prints merge-aware next steps based on current OpenClaw config instead of the destructive allowlist command

## What passed in this run

- `npm install @psiclawops/hypermem && npx hypermem-install`
- runtime staging into `~/.openclaw/plugins/hypermem`
- OpenClaw restart
- plugin load verification
- active HyperMem compose logs for `hank`
- lightweight mode with `embedding.provider = "none"`

Observed runtime state after restart:
- `hypercompositor` loaded
- `hypermem` loaded
- HyperMem logs present in `openclaw logs`
- no reproduced `zod` module failure in this pass

## Remaining friction found during the live pass

### 1. README and INSTALL were still not aligned with the safest real operator path

The source docs still mixed the warning "merge, don't overwrite" with example commands that overwrote config values unless the operator manually rewrote them.

The biggest footgun was still this pattern:

```bash
openclaw config set plugins.allow '["hypercompositor","hypermem"]' --strict-json
```

That is not safe on a real OpenClaw install with an existing allowlist.

### 2. `install-runtime` printed the same unsafe allowlist replacement

Even after a successful build, the helper script told the operator to apply the destructive `plugins.allow` replacement command.

That made the helper output itself part of the problem.

### 3. Source/public drift is still visible

The GitHub `main` clone I pulled for repair work is still package version `0.8.2`, while the live npm-installed package I validated on the box is `0.8.4`.

That means repo-visible docs and npm-consumed behavior are not clearly in lockstep right now. Even when the install works, this drift makes review and trust harder.

## Fixes I made in source

Repo: `PsiClawOps/hypermem`

### README.md
- restored a proper npm-first quick install path at the top
- removed the destructive `plugins.allow` example
- changed plugin wiring guidance to inspect current config first
- made the allowlist step conditional on an allowlist already existing
- added explicit warning not to replace a working allowlist with only HyperMem plugin IDs

### INSTALL.md
- removed the destructive `plugins.allow` example in both Quick Start and Step 2
- added `openclaw config get` checkpoints before config writes
- switched path examples to the safer `$HYPERMEM_PATHS` pattern
- made allowlist mutation conditional and explicit

### scripts/install-runtime.mjs
- now reads existing `plugins.load.paths` and `plugins.allow` when available
- prints a merged `plugins.load.paths` command instead of a blind replacement for the common case
- prints a merged `plugins.allow` command only when an allowlist already exists
- otherwise tells the operator to skip `plugins.allow` unless their config actually uses one

## Validation after repair

Ran:

```bash
npm run validate:docs
```

Result: PASS

I also rebuilt the source tree and executed `node scripts/install-runtime.mjs <tempdir>` to confirm the helper script runs and emits the new guidance.

## Recommendation

Forge should treat the install path as **working but not yet polished**.

Current judgment:
- runtime/plugin viability: PASS
- fresh operator experience: PARTIAL PASS
- docs safety: improved by the repairs above
- release hygiene: still needs attention because source/npm drift is visible

## Next actions I recommend

1. review and merge the docs + installer-output fixes in `hypermem`
2. decide whether GitHub `main` should be brought into clear parity with the currently published npm package
3. rerun one more true fresh-user pass after those changes ship, using only public materials

## Bottom line

HyperMem now looks installable in practice, not just in theory. The remaining problems are operator-experience problems, not core runtime viability problems.
