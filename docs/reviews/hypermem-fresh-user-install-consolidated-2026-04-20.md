# HyperMem Fresh-User Install Consolidated Report - 2026-04-20

Author: Pylon  
Requested by: ragesaq  
Audience: Forge, docs owners, release owners  
Scope: Consolidated fresh-user install findings across the 2026-04-19 and 2026-04-20 evaluation passes

---

## Executive Summary

HyperMem is much closer to a real first-run product than it was a week ago, but the install path is still not clean enough for an operator who starts from the published package and follows the docs exactly.

The good news:
- library mode is real and usable
- the npm package now ships more of the docs needed for first-run evaluation
- the `plugins.load.paths` quoting issue appears materially improved
- the plugin/runtime path is no longer purely theoretical

The remaining problems are still serious because they block trust, not just convenience:
- docs and shipped artifacts have drifted across versions and test modes
- the plugin install story still changes depending on whether the user starts from npm or from a source clone
- the docs still contain at least one hard-stop command typo in the latest package-only pass
- the package/runtime path still surfaced a real dependency failure after wiring: `Cannot find module 'zod'`
- `plugins.allow` guidance remains too easy to apply destructively

Bottom line:

**HyperMem core functionality is viable. Fresh-user install is not yet boring.**

That is the gap that remains.

---

## What This Report Consolidates

This memo rolls up findings from these review streams:

- `hypermem-new-user-evaluation-2026-04-19.md`
- `hypermem-installation-experience-2026-04-19.md`
- `hypermem-082-retest-2026-04-19.md`
- `hypermem-fresh-user-package-feedback-2026-04-20.md`
- same-day additional 0.8.3 package-only findings captured in Pylon memory on 2026-04-20

This is the best single current picture of the fresh-user install experience.

---

## Test Coverage Included

### 1. Fresh npm library install
Start from a blank project and use `npm install @psiclawops/hypermem` only.

### 2. Public docs plugin path
Follow the published README and INSTALL flow from public materials.

### 3. Snapshot-based reruns on `psiclaw01`
Reset to a known clean baseline and repeat the install path.

### 4. Package-only review
Evaluate what a user can do from the shipped npm package itself, without assuming repo checkout.

### 5. Latest package-only 0.8.3 pass
Capture current breakpoints after recent packaging/docs improvements.

---

## Chronology of What Improved

### Earlier state, before the recent fixes
Earlier passes showed basic credibility problems:
- README used a literal `~` in JS examples, which created the wrong data path in plain Node
- package/docs alignment was incomplete
- `INSTALL.md` packaging and public release state were inconsistent across passes
- plugin install instructions assumed more OpenClaw state and operator knowledge than they said

### 0.8.1 and 0.8.2 improvements that looked real
By the 0.8.1 and 0.8.2 reviews, several fixes were confirmed:
- library mode worked from a fresh npm install
- `INSTALL.md` was present in the package in later retests
- the README library example no longer depended on literal `~`
- the documented `plugins.load.paths` strict-json command worked in at least one isolated retest
- docs were clearer that OpenClaw onboarding had to exist first

These were real wins. They closed some obvious first-run paper cuts.

---

## What Still Fails for a Fresh User

## A. The install path is still split-brain

The product still presents more than one install story:

1. **npm package discovery / library usage**
2. **source-clone plugin build/runtime install**
3. **package-only plugin expectations from shipped docs**

Those stories are not yet cleanly unified.

In practice, a user can still move from "this seems supported" to "now I need to guess which path is actually canonical" too quickly.

### Why this matters
A fresh user does not distinguish between:
- package limitation
- docs bug
- release packaging bug
- host OpenClaw problem
- actual HyperMem runtime failure

If the install story makes those look the same, confidence collapses.

---

## B. Package-only plugin install is still not self-contained enough

The 2026-04-20 package-feedback pass found that a brand new user starting from:

```bash
npm install @psiclawops/hypermem
```

could not complete the plugin installation flow without leaving the package and inferring too much.

Key findings from that pass:
- package installation worked
- shipped top-level docs were readable
- library mode worked
- but the docs still pushed the user toward a GitHub/source-clone path for plugin installation
- linked `docs/*.md` references were not fully reliable from the installed package context
- the package did not clearly make the plugin install path feel first-class from the npm artifact alone

### Why this matters
For a user who starts from npm, the product still does not communicate clearly enough whether npm is:
- the supported plugin-install product, or
- just the library-discovery product

That ambiguity is still expensive.

---

## C. Latest package-only 0.8.3 findings still contain a hard stop

The most recent 2026-04-20 package-only test surfaced a direct docs blocker:

- shipped docs still contained `ocplatform config set plugins.allow ...` in `INSTALL.md`

That is a hard stop for a new user following the docs exactly.

### Why this matters
This is not a subtle UX issue.
This is a literal broken command in the guided path.
A first-run operator who trusts the docs will fail immediately and will not know whether the mistake is:
- their host,
- their shell,
- OpenClaw,
- or HyperMem docs.

Any install guide with a command typo in the main path is still below publish quality for first-run operator trust.

---

## D. Runtime dependency packaging is still suspect

Separate from the docs typo, the same 0.8.3 package-only run surfaced a runtime validation failure after wiring and restart:

```text
Cannot find module 'zod'
```

This matters more than the typo.
The typo blocks progress early, but the `zod` failure means that even after an operator corrects course and finishes wiring, the shipped package/runtime story may still be incomplete.

### Interpretation
This points to at least one of these:
- missing runtime dependency in the packaged artifact
- dependency declared in the wrong package scope
- install/build/runtime staging mismatch
- runtime loader expecting source-layout behavior that the published package does not guarantee

### Why this matters
A fresh user can survive a docs typo if the underlying product works.
A fresh user cannot trust the install path if the wired runtime then fails on a missing module.

---

## E. `plugins.allow` is still a footgun

Across multiple passes, one pattern stayed dangerous:

```bash
openclaw config set plugins.allow '["hypercompositor","hypermem"]' --strict-json
```

Even when the docs warn users to merge rather than replace, the literal copy-paste example still encourages a destructive replacement pattern.

Observed impact across review passes:
- existing allowed plugins get dropped
- normal CLI/plugin surfaces can disappear or become confusing
- operators can mistake the fallout for HyperMem breakage

### Why this matters
This is the wrong kind of friction. It creates collateral damage in the host OpenClaw environment and pollutes the install signal.

When a user follows the docs and their gateway behavior changes in unrelated ways, the install guide has failed even if HyperMem itself is fine.

---

## F. Cold-start boundary is clearer, but still not truly solved

The docs are better than before about saying OpenClaw must already be installed and onboarded.
That is honest and helpful.

But the actual fresh-user experience is still split:
- a true first-time OpenClaw user is outside the supported HyperMem plugin path
- a moderately experienced OpenClaw operator still has to infer how much onboarding/state is assumed
- verification commands can still fail for environment reasons that look like product failure

This is not purely a HyperMem fault, but it is still part of the install experience the user sees.

---

## What Definitely Works Now

These parts are credible based on repeated evidence:

### 1. Library mode works
Fresh npm install plus lightweight usage with `embedding.provider = "none"` is real.

### 2. The package/docs situation is better than it was
At least some earlier packaging mismatches were fixed, including shipping `INSTALL.md` in later passes.

### 3. The plugin/runtime path is no longer fake
Builds, runtime staging, and plugin loading have all worked in controlled runs.

### 4. Snapshot-based reruns on `psiclaw01` produced trustworthy evidence
This reduces the chance that the positive results were just one lucky environment.

### 5. The product is close enough that the remaining problems are now mostly install-surface quality problems
That is meaningful progress.

---

## What Still Breaks Trust

### 1. Any command typo in the guided path
Example: `ocplatform` in `INSTALL.md`

### 2. Any missing runtime dependency after successful wiring
Example: `Cannot find module 'zod'`

### 3. Any docs pattern that can damage an otherwise healthy OpenClaw config
Example: destructive `plugins.allow` replacement

### 4. Any install path that changes depending on whether the user starts from npm versus GitHub without saying so plainly

### 5. Any verification step that fails in ways a fresh user cannot classify

---

## Root Cause Framing

The remaining issues are not all one class of bug.
They break down into four categories:

### 1. Docs correctness bugs
- wrong command names
- contradictory instructions
- insufficient distinction between merge and replace operations

### 2. Packaging/release contract bugs
- package contents do not fully match the install story users are told to follow
- runtime dependencies may not be landing where the runtime expects them

### 3. Product-boundary ambiguity
- package/library mode versus plugin/runtime mode is still not communicated tightly enough

### 4. Host-environment coupling
- OpenClaw onboarding, auth, pairing, and gateway state still leak into the install experience in confusing ways

---

## Recommended Fixes, in Order

## P1, publish-blocking

### 1. Fix the command typo in shipped docs immediately
Remove `ocplatform` from the install path and validate every command in the package docs from a clean environment.

### 2. Fix the `zod` runtime failure before claiming package-only plugin install works
Do not treat this as a minor follow-up. It is a direct runtime credibility issue.

### 3. Replace destructive `plugins.allow` examples with an actual merge-safe recipe
Warning prose is not enough. The command examples must be safe.

### 4. State plainly whether npm alone is a supported plugin-install product
If the answer is yes, the package must be self-sufficient.
If the answer is no, say so early and explicitly.

---

## P2, next docs/release pass

### 5. Split the install guide into explicit tracks
- library mode
- source-clone plugin mode
- package-only plugin mode, if supported

### 6. Add a release validation gate for shipped docs commands
Every command in README and INSTALL should be executed in CI or release verification.

### 7. Add a release validation gate for package-only runtime wiring
A clean environment should be able to go from installed package to loaded plugins without repo checkout if that is a supported promise.

### 8. Make empty-state and host-prerequisite failures visibly distinct from HyperMem failures
The user should be able to tell whether the problem is host OpenClaw state or HyperMem itself.

---

## P3, product hardening

### 9. Reduce dependency on manual OpenClaw config surgery
The more the user edits plugin paths and allowlists by hand, the more likely unrelated breakage becomes.

### 10. Improve verification tooling so success and failure modes are classifier-friendly
Fresh users should not need prior operator instincts to understand status output.

---

## Final Judgment

Here is the honest current state.

HyperMem is no longer failing because the core idea is fake.
It is failing because the install surface still leaks too much implementation detail and still contains at least one direct docs blocker plus one likely packaging/runtime defect.

That is a much better class of problem than "it does not work at all."
But it is still a real release problem.

If I reduce the whole report to one line:

**HyperMem now looks real in core behavior, but the fresh-user install path still cannot be trusted end to end without operator inference.**
