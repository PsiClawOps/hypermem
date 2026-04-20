# HyperMem Follow-Up Findings — 2026-04-19

Author: Pylon  
Requested by: ragesaq  
Audience: Forge

Related prior reviews:
- `docs/reviews/hypermem-new-user-evaluation-2026-04-19.md`
- `docs/reviews/hypermem-docs-only-new-user-review-2026-04-19.md`

This note consolidates the follow-up findings that emerged across the later install, docs-only, cleanup, and verification passes.

---

## Executive Summary

HyperMem is now in a materially better place than the earlier broken-package state.

What is now clearly true:
- the npm package is real
- the published version is `0.8.1`
- the documented library import works
- minimal library usage works in a fresh project
- the plugin runtime path is real and can load successfully
- the repo build/test/install surface is substantially healthier than before

What remains weak:
- first-contact plugin onboarding still assumes too much OpenClaw knowledge
- public docs still contain correctness bugs, not just clarity gaps
- verification steps are too environment-sensitive and produce false negatives
- packaging/docs drift still exists in places that matter to a new user

My bottom line for Forge:
- the core package has enough substance now
- the next limiting factor is docs and installation clarity
- new users will still misclassify docs failures as product instability if this is not tightened soon

---

## Scope of Follow-Up Passes

These findings came from multiple follow-up passes after the initial new-user evaluation:

1. **Fresh public npm rerun** using `@psiclawops/hypermem@0.8.1`
2. **Plugin rerun** using the public repo/build/install path
3. **Strict docs-only rerun** where I refused to use source, tests, or internal docs to recover from failures
4. **Cleanup and reset validation** to ensure each pass started from a genuinely clean user state
5. **Upload and handoff work** so Forge can read the findings from the other host

---

## Fresh npm Package Findings

## 1. Published version is correct

Confirmed from npm during the fresh rerun:
- package: `@psiclawops/hypermem`
- published version: `0.8.1`
- `latest` dist-tag: `0.8.1`

No older version appeared in the fresh user path.

## 2. npm README and GitHub README matched

I explicitly compared the npm README against the linked GitHub `README.md` during the fresh rerun.

Result:
- no README drift found in that state
- npm README and GitHub README were identical

This is good. It means the package homepage experience was at least internally consistent for that pass.

## 3. The package is inspectable and usable as a real library

From the installed package, the documented import path worked:
```js
import { HyperMem } from '@psiclawops/hypermem';
```

Observed package characteristics included:
- ESM package
- version `0.8.1`
- CLI entry `hypermem-status`
- coherent export surface

This is a real improvement over the older state where the public shape and the practical runnable shape did not align cleanly.

---

## Library-Mode Findings

## 4. Minimal library mode works from a fresh project

In a brand new temp project, using only public package information, I was able to:
- install the package
- import `HyperMem`
- call `HyperMem.create(...)`
- call `recordUserMessage(...)`
- call `compose(...)`
- receive a valid composed result

This worked with:
```js
embedding: { provider: 'none' }
```

Observed runtime behavior:
- cache connected
- embedding provider `none`
- semantic search disabled, FTS5 fallback
- compose returned structured output including `contextBlock`

This is the strongest positive signal in the whole evaluation. HyperMem now works as a real package in minimal mode.

---

## Public Docs Correctness Bugs

## 5. The README JS path example is wrong or at least dangerously misleading

The public README uses:
```js
dataDir: '~/.openclaw/hypermem'
```

In JavaScript, `~` is not shell-expanded automatically.

In practice, copying that literal example into a plain Node project created project-local state under:
- `./~/.openclaw/hypermem`

not the user’s actual home directory.

This is not a minor wording issue. It is a docs correctness bug.

Recommendation:
- replace the example with an actually expanded home path pattern
- do not rely on users understanding the shell-vs-JS path distinction

## 6. The npm package did not ship `INSTALL.md` during the docs-only pass

This is a hard docs/package mismatch.

The shipped README points users to `INSTALL.md`, but the installed npm package did not include `INSTALL.md`.

Observed package docs included:
- `README.md`
- `ARCHITECTURE.md`
- no `INSTALL.md`

That means a docs-only user is told to read a file that does not exist in the package they just installed.

This must be fixed one of two ways:
- include `INSTALL.md` in the published package, or
- stop telling installed-package users to read it

---

## Plugin Runtime Findings

## 7. The public plugin path is real and substantially improved

From the public repo path, I was able to complete:
- root build
- `plugin` build
- `memory-plugin` build
- `npm run install:runtime`
- `npm test`

This is meaningful.

The plugin story is no longer imaginary. Runtime staging and plugin loading are real.

## 8. Plugin load succeeded after proper wiring and bootstrap

Once the runtime was staged and OpenClaw was configured, the isolated gateway eventually reported:
- `ready (2 plugins: hypercompositor, hypermem; 4.4s)`

This proves the plugin path can load successfully.

That said, the steps required to reach this point were still too implicit for a true cold-start user.

---

## OpenClaw Onboarding and Bootstrap Gaps

## 9. `openclaw gateway restart` is not a sufficient cold-start instruction

This is one of the biggest user-facing gaps.

In a truly fresh OpenClaw home, following the documented flow to the restart step was not enough.

Observed behavior in the fresh isolated path:
- `openclaw gateway restart` reported the gateway service was disabled
- `openclaw gateway` then failed because the config lacked `gateway.mode`

I had to bootstrap the isolated OpenClaw home first before the gateway could run properly.

Important framing:
- this is not necessarily a HyperMem core bug
- it **is** part of the HyperMem plugin install story for a new user
- if the docs say “do X next” and X does not work on a cold start, that is a docs/onboarding defect

Recommendation:
- state fresh OpenClaw prerequisites explicitly
- clarify when `restart` is valid versus when onboarding/start/run is required

## 10. The docs assume existing OpenClaw service state

The plugin flow reads more like operator instructions for an already-running OpenClaw install than a first-time install guide.

That is survivable for experienced operators.
It is confusing for a new user.

Recommended separation:
- “Install into an existing OpenClaw setup”
- “Cold-start install into a brand-new OpenClaw setup”

---

## Verification Command Gaps

## 11. `hypermem-status` target selection is under-documented

The status/health path depends heavily on which data directory is being inspected.

I confirmed that:
- the CLI has a default data-dir expectation
- if more than one HyperMem/OpenClaw environment exists, it is easy to inspect the wrong store by accident
- `HYPERMEM_DATA_DIR` is necessary in non-default setups but not emphasized enough

This surfaced directly in the docs-only pass:
- the verification command failed because it was looking at `/home/lumadmin/.openclaw/hypermem`
- but the install flow had just staged things under an isolated/non-default home

That is a docs bug, not a user mistake.

Recommendation:
- document default target behavior clearly
- explicitly note when `HYPERMEM_DATA_DIR` is required
- show what command to use in non-default installs

## 12. Empty-state health behavior reads like breakage

Before any agent/session data had been ingested, health/status could fail with:
- `Error: no agent messages.db found. Has HyperMem ingested any sessions?`

This is technically understandable, but from a new-user perspective it reads like a failed install rather than an empty system.

Recommendation:
- document that the first health check may reflect empty-state rather than failure
- if possible, improve UX wording so the distinction is obvious

## 13. Log-based verification assumes gateway auth is already right

The suggested verification/log path also failed in the docs-only pass because the gateway token/auth state was not aligned.

That means the verification section is not self-contained.
It assumes the user already understands gateway routing and auth state.

Recommendation:
- spell out those assumptions in the verify block
- do not present log commands as simple final checks unless they are actually copy-paste reliable in the documented environment

---

## Docs-Only Pass Findings

## 14. The docs-only flow is still not end-to-end safe

I performed a stricter rerun where I refused to recover failures by reading source, tests, or internal docs.

Result:
- library mode succeeded
- plugin/docs-only end-to-end did **not** succeed cleanly

The docs-only pass exposed the following as public-facing defects:
- missing `INSTALL.md` in npm package
- `openclaw gateway restart` insufficient on cold start
- verification command pointed at wrong/default data dir
- gateway/log verification assumed working auth
- JS path example remained misleading

This is exactly the kind of pass a real new user would effectively perform.
That is why these issues matter more than a source-level recovery would suggest.

---

## Install Script / Runtime Staging Expectations

## 15. `install:runtime` still behaves more like staging than full installation

This is not necessarily wrong, but the naming and expectations need to be clearer.

Current practical behavior:
- stage runtime artifacts
- print next-step config commands
- do **not** complete the whole integration automatically

That means a user may incorrectly infer “installation complete” when the system is only partially wired.

Recommendation:
- either rename/reframe it as runtime staging
- or keep the name but document bluntly that config wiring is still required

---

## Cleanup / Repeatability Findings

## 16. Repeatable resets required deliberate quarantine and cleanup

Across the repeated test cycles I quarantined residual local state to keep the next pass honest.

Notable cleanup path used:
- `/home/lumadmin/.openclaw/quarantine/hypermem-clean-20260419-182154`

This included prior local clones and default local HyperMem data.

I also verified after cleanup that the main OpenClaw config was **not** actively wired to HyperMem plugin paths or slots.

This matters because it confirms later findings were not being helped by stale local wiring.

---

## Delivery and Cross-Host Visibility

## 17. Forge-visible note was uploaded to `hypermem-internal`

During the follow-up work I uploaded the detailed fresh 0.8.1 new-user review to the internal repo so Forge can read it remotely.

Repo path used:
- `git@github-psiclawops:psiclawops/hypermem-internal.git`

Committed review file:
- `docs/reviews/hypermem-new-user-evaluation-2026-04-19.md`

Commit:
- `e6d7836`

There was a local git author issue on this host, so I set repo-local git author identity only for that repo:
- `psiclawops <ops@psiclawops.com>`

This is not a HyperMem issue, just part of the delivery path.

## 18. Additional local Forge-facing docs-only memo exists

I also created a second local review focused strictly on the docs-only pass:
- `/home/lumadmin/.openclaw/workspace-council/pylon/reviews/hypermem-docs-only-new-user-review-2026-04-19.md`

This should also be uploaded or merged into internal review history because it isolates public docs defects from source-assisted recovery.

---

## Recommended Improvement List for Forge

Priority order below.

## P1. Ship the docs you tell users to read

If README tells users to read `INSTALL.md`, the npm package must include `INSTALL.md`.

## P1. Fix the JS path example immediately

Do not ship a JS example with literal `~` unless the package itself expands it.

Preferred fix:
- use an explicit home-resolved path example

## P1. Add a true cold-start OpenClaw plugin quickstart

There must be one public path for a brand-new OpenClaw user that states:
- prerequisites
- whether onboarding must already be done
- whether service install/start is required
- whether gateway auth must already exist
- which exact verification commands are valid in that environment

## P2. Split library docs from plugin docs

Users should not have to infer which assumptions belong to library mode versus OpenClaw plugin mode.

## P2. Make verification commands environment-aware

The docs must state:
- default data-dir assumptions
- when `HYPERMEM_DATA_DIR` is required
- what empty-state health looks like
- what success output looks like
- what gateway auth failures mean

## P2. Clarify `install:runtime`

Say clearly whether it stages files only or completes installation.

## P3. Add a public common-failure table

Suggested entries:
- `INSTALL.md` missing from package
- `~` path confusion in JS
- wrong data dir for `hypermem-status`
- gateway restart does nothing because no service/setup exists
- log verification fails because gateway auth/token is not set correctly

## P3. Reduce manual OpenClaw wiring if possible

If safe, provide a helper to set the required config keys rather than forcing users through the whole manual sequence.

---

## Final Judgment

The follow-up passes did not uncover a fundamental “this package is fake” problem.

They uncovered something more specific and more fixable:
- the package has become real enough that documentation quality is now the dominant adoption bottleneck

That is good news, but it also raises the standard.

At this stage, public docs bugs are not minor. They are the main thing standing between technical progress and user trust.

---

## One-Line Summary

**HyperMem now works well enough that docs correctness and cold-start onboarding clarity are the main remaining problems.**
