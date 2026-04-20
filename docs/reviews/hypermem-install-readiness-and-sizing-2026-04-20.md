# HyperMem install readiness and settings right-sizing report

Date: 2026-04-20
Author: Pylon
Requested by: ragesaq
Audience: Forge, docs owners, release owners
Scope: latest fresh-user 0.8.5 install validation, installer/doc completeness, and remaining guidance gaps around choosing the right operating profile

## Executive summary

HyperMem now has technically complete installation material.

That is the main change.

The latest 0.8.5 fresh-user pass validated the important path end to end:
- npm package install worked
- `npx hypermem-install` worked
- OpenClaw wiring worked
- gateway restart worked
- `hypercompositor` and `hypermem` loaded live
- compose activity appeared in logs
- the documented lightweight path with `embedding.provider = "none"` behaved as intended

The remaining problems are now mostly trust and guidance problems, not core install viability problems.

Current verdict:
- **Core install/runtime viability:** PASS
- **Installation material completeness:** PASS
- **Right-sizing guidance for real operators:** NEEDS STRONGER LANGUAGE
- **Release polish:** still one confirmed issue, the health tool reports `0.8.2` while the installed package is `0.8.5`

## What this pass confirmed

### 1. The install path is real now

The fresh-user package path is no longer theoretical.

Validated path:
```bash
npm install @psiclawops/hypermem
npx hypermem-install
```

Validated runtime state after wiring:
- `plugins.load.paths` pointed at the staged HyperMem plugin directories
- `plugins.slots.contextEngine = hypercompositor`
- `plugins.slots.memory = hypermem`
- gateway logs showed HyperMem plugins loaded
- logs showed live compose activity

This is enough to say a fresh operator can get HyperMem running from the published package and docs.

### 2. The docs now cover the critical decision points

The public install material now documents:
- install/setup style selection
- embedding-provider selection
- reranker selection
- lightweight versus local versus hosted tradeoffs
- single-agent versus multi-agent fleet configuration

That means the install material is now technically complete.

### 3. Lightweight mode is explicitly documented and behaved correctly

The docs now clearly describe the minimal path:
- explicit `provider: "none"`
- no embedder
- FTS5-only recall
- no semantic search

The runtime matched that documented behavior.

So `Embedding provider: none` is not a bug or degraded accident in this setup. It is one of the intended install profiles.

## Confirmed remaining issue

### Health tool version string mismatch

One concrete release-quality issue remains:
- `hypermem-status --health` reported `hypermem 0.8.2 health check`
- installed package version was `0.8.5`

This does not appear to block runtime operation, but it is still a release-trust problem. A health command that reports the wrong version makes the operator doubt the install immediately.

## What changed since earlier reports

Earlier reports focused on whether HyperMem could actually be installed cleanly by a fresh user.

That question is now substantially answered.

The bigger problem has shifted from:
- "does the install path actually work?"

to:
- "does the product strongly steer the operator to the right configuration for their environment?"

That is better territory. It means the product is crossing from install-debugging into packaging and operator-guidance refinement.

## The real remaining docs problem: right-sizing language is still too soft

The docs contain the necessary choices, but they do not yet push the operator hard enough toward the right choice for their environment.

Right now the material is technically correct.
It should become more operationally opinionated.

### Why this matters

A new operator often does not know:
- whether they should optimize for simplicity or recall quality
- whether their machine is suitable for local embeddings
- whether a local reranker is realistic on CPU
- whether they should configure fleet topology now or defer it
- whether hosted options are worth it for their scale

If the docs present all options evenly, users will over-configure, under-configure, or choose a path they cannot operate comfortably.

That creates support noise and makes the product seem less stable than it is.

## Stronger guidance the docs should add

### 1. Lead with recommended profiles, not just option tables

The current tables are useful, but the docs should also lead with explicit recommendations such as:

- **Solo operator, CPU-only, wants fast install:** choose **Lightweight**
- **Solo or small fleet, wants semantic recall without local GPU work:** choose **Hosted**
- **Air-gapped or local-first environment with available hardware:** choose **Local**
- **CPU-only system:** do **not** use local reranker
- **Single-agent install:** skip fleet customization now
- **Multi-agent install:** do fleet mapping before expecting cross-agent behavior to make sense

This should appear near the top, not buried later.

### 2. Add explicit "default recommendation" language

The docs should say, plainly:

- **Default safest install:** Lightweight
- **Default best-quality install for most serious operators:** Hosted embeddings, no reranker at first
- **Add reranker later only if you know why you need it**

That removes guesswork.

### 3. Make reranker guidance more forceful

The reranker section already says CPU-only systems should skip the local reranker.
That is correct, but it should be stronger.

Suggested framing:
- local reranker on CPU is not recommended for normal use
- start with no reranker unless you have a GPU or a clear hosted-budget reason
- reranker is a precision upgrade, not a required part of a good first install

### 4. Separate fleet-shape decisions from first-run decisions

The docs now include fleet configuration, which is good.
But they should clearly say:

- if you are running one agent, stop after single-agent verification
- do not customize fleet topology on day one unless you are actually running a multi-agent fleet
- placeholder topology in source matters only for multi-agent installs

This prevents solo operators from wandering into unnecessary edits.

### 5. Add one short "choose your setup" decision block

A compact decision block would do a lot of work.
For example:

- **I want the simplest first install** → Lightweight
- **I want best recall quality without local model ops** → Hosted embeddings
- **I must stay local / air-gapped** → Local embeddings
- **I am CPU-only** → No local reranker
- **I have one agent** → Skip fleet config
- **I have multiple agents** → Complete fleet config before validating shared-memory behavior

This is the missing operator-facing layer.

## Recommended next docs pass

Priority order:

1. Fix the health tool version string
2. Add a top-of-doc "recommended profiles" section
3. Add a compact setup chooser near Quick Start
4. Make "no reranker first" the default recommendation for most users
5. Make single-agent deferral of fleet config more explicit

## Final verdict

HyperMem is past the point where the headline question is "can a fresh user install it at all?"

Now the question is "will the docs steer the user into the right install profile without making them think too hard?"

That is major progress.

The installation material now looks technically complete.
The next gain is not more option coverage. It is stronger recommendation language and better operator steering.
