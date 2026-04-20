# HyperMem fresh-user package feedback report

Date: 2026-04-20
Author: Pylon
Scope: Fresh-user evaluation starting from `npm install @psiclawops/hypermem` only

## Executive summary

A brand new user could not get from `npm install @psiclawops/hypermem` to working OpenClaw plugins without guessing or leaving the package.

What worked:
- package installation from npm
- reading the shipped `README.md` and `INSTALL.md`
- prerequisite checks for an already-working OpenClaw install
- library-mode usage from the shipped README example

What failed structurally:
- the npm package did not contain the plugin/runtime assets and helper scripts that the docs told the user to use
- the docs mixed an npm discovery path with a source-clone installation path
- the package-linked `docs/*.md` files were not shipped in the npm tarball
- the documented plugin wiring path still contained a destructive `plugins.allow` replacement pattern

## Exact fresh-user flow that was tested

Starting point:

```bash
npm install @psiclawops/hypermem
```

Then, using only files shipped in the installed package:

1. Read `README.md`
2. Read `INSTALL.md`
3. Read `package.json`
4. Run documented OpenClaw prerequisite checks
5. Attempt to follow the package-discoverable installation path exactly
6. Stop at the first point where the package no longer provided enough information or files to continue

## What the package successfully communicated

The package made these points discoverable:
- HyperMem is a SQLite-backed memory/context engine for OpenClaw
- It supports both library usage and OpenClaw plugin usage
- Node 22+ is required
- OpenClaw must already be installed and onboarded for plugin use
- lightweight mode can run with `embedding.provider = "none"`

## What actually worked

### 1. Package installation

`npm install @psiclawops/hypermem` succeeded.

### 2. Package reading path

The top-level package did ship:
- `README.md`
- `INSTALL.md`
- `CHANGELOG.md`
- `ARCHITECTURE.md`
- `dist/`
- `bin/hypermem-status.mjs`

### 3. OpenClaw prerequisite checks

The documented prerequisite commands worked:

```bash
openclaw gateway status
openclaw config get gateway
```

### 4. Library-mode example

The README library example worked with a local script using the shipped package:

- `HyperMem.create(...)` succeeded
- `recordUserMessage(...)` succeeded
- `compose(...)` succeeded
- lightweight mode with `embedding.provider = "none"` behaved correctly

## Where the fresh-user path broke

### Break 1: plugin install path immediately left the npm package

The shipped docs instructed the user to do this:

```bash
git clone https://github.com/PsiClawOps/hypermem.git
cd hypermem
npm install && npm run build
npm --prefix plugin install && npm --prefix plugin run build
npm --prefix memory-plugin install && npm --prefix memory-plugin run build
npm run install:runtime
```

For a user who started from npm and was told to rely on the package itself, this is a hard break:
- it leaves the npm package
- it requires GitHub
- it assumes source-clone workflow knowledge

### Break 2: required plugin directories were not shipped in the npm package

The installed package did not contain:
- `plugin/`
- `memory-plugin/`
- `scripts/`
- `docs/`

So even if the user stayed local inside `node_modules/@psiclawops/hypermem`, the documented plugin path could not be executed there.

### Break 3: linked docs were missing from the package

The README linked to files under `docs/`, including:
- `docs/TUNING.md`
- `docs/MIGRATION_GUIDE.md`
- `docs/MEMORY_MD_AUTHORING.md`

Those files were referenced but not shipped in the npm package.

### Break 4: plugin wiring guidance was still unsafe for real OpenClaw installs

The package docs warned users to merge `plugins.allow`, but still showed a replacement command:

```bash
openclaw config set plugins.allow '["hypercompositor","hypermem"]' --strict-json
```

For an existing OpenClaw install, that is a footgun. It drops pre-existing allowed plugins and can remove bundled CLI/plugin surfaces.

## Every place a new user had to infer something the package did not say cleanly

1. Whether the npm package was intended to support plugin install at all
2. Whether the package expected source-clone usage after npm discovery
3. Which docs to read first once README started linking into missing `docs/`
4. Whether `hypermem-status` was meant for npm-package users or repo-clone users
5. How to safely merge `plugins.allow` and `plugins.load.paths` without clobbering a working OpenClaw install
6. Whether the package shipped enough to perform runtime installation locally

## Command-level findings

### Commands that worked as documented

```bash
openclaw gateway status
openclaw config get gateway
```

### Commands that were not runnable from the installed package context

These were documented, but the installed npm package did not ship the required files to execute the flow locally:

```bash
npm --prefix plugin install
npm --prefix plugin run build
npm --prefix memory-plugin install
npm --prefix memory-plugin run build
npm run install:runtime
```

Reason: the npm package did not include `plugin/`, `memory-plugin/`, or `scripts/`.

## Root cause summary

The package and docs described two different installation products:

- **What npm shipped:** the core library plus top-level docs
- **What the docs described for plugins:** a source-repo build/install workflow

Those were not aligned into a single fresh-user path.

## Required fixes

1. Ship plugin runtime artifacts in the npm package
2. Ship the install helper script used to stage runtime payloads
3. Ship the linked `docs/` files referenced from README
4. Make the npm path explicit and first-class in both README and INSTALL
5. Replace the unsafe `plugins.allow` replacement guidance with a merge-safe path
6. Ensure runtime installation does not assume a hard-coded global OpenClaw package path
7. Validate the fixed flow from `npm install` to loaded plugins using only packaged assets

## Test outcome

### Fresh-user verdict

- Library usage from the npm package: **PASS**
- OpenClaw plugin installation from the npm package only: **FAIL**
- Could a brand new user complete plugin installation without guessing: **No**

## Host OpenClaw state captured during the fresh-user run

### `openclaw status`

Observed during the test:
- gateway running
- no HyperMem plugins wired
- plugin compatibility: none

### `openclaw doctor --non-interactive`

Observed during the test:
- OpenCode provider override present
- bundled plugin runtime dep missing: `@discordjs/opus@^0.10.0`
- stale agent dirs: `default`, `main`
- one live Pylon session lock
- gateway bound to `lan`

These were environmental observations, not HyperMem package failures.
