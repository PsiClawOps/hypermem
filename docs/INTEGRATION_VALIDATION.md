# HyperMem Integration Validation

This page is the operator validation contract for HyperMem releases. It describes how the runtime pieces fit together and how to prove each one works before publishing or upgrading a deployment.

## Runtime pieces

| Piece | Package or path | Purpose | Verification |
|---|---|---|---|
| Core library | `@psiclawops/hypermem` | SQLite stores, compositor primitives, retrieval, lifecycle policy, diagnostics helpers | `node -e "import('@psiclawops/hypermem')"` from an installed package |
| Context engine plugin | `~/.openclaw/plugins/hypermem/plugin` | OpenClaw `contextEngine` slot, prompt composition, warming, trimming, adaptive lifecycle diagnostics | `openclaw plugins list` shows `hypercompositor` loaded |
| Memory plugin | `~/.openclaw/plugins/hypermem/memory-plugin` | OpenClaw memory slot integration for `memory_search` and retrieval surfaces | `openclaw plugins list` shows `hypermem` loaded |
| Runtime staging tool | `hypermem-install` | Copies package runtime into `~/.openclaw/plugins/hypermem` | staged directory contains `dist`, `plugin`, `memory-plugin`, `bin` |
| Status CLI | `hypermem-status` | Health, database, vector, and runtime summary | `hypermem-status --health` exits cleanly or reports only healthy-empty state |
| Model audit CLI | `hypermem-model-audit` | Checks model context-window detection and overrides | `hypermem-model-audit --strict` reports no risky unknown models, or known required overrides |

## Install state machine

Do not treat installation as complete until all 5 states pass.

| State | Meaning | Required proof |
|---|---|---|
| 1. Package installed | npm package is available | `npm install @psiclawops/hypermem` succeeds |
| 2. Runtime staged | package payload is copied into OpenClaw plugin runtime dir | `ls ~/.openclaw/plugins/hypermem` shows `dist`, `plugin`, `memory-plugin`, `bin` |
| 3. OpenClaw wired | OpenClaw config points at staged plugins | `plugins.load.paths` includes both staged plugin dirs, slots are set |
| 4. Runtime loaded | Gateway has loaded both plugins | `openclaw plugins list` shows `hypercompositor` and `hypermem` loaded |
| 5. Runtime active | HyperMem is composing live turns | logs show `[hypermem] hypermem initialized` and `[hypermem:compose]` |

A successful `hypermem-install` proves only state 2. It does not modify OpenClaw config and does not restart the gateway.

## Fresh install validation

Run from a clean shell with OpenClaw already onboarded.

```bash
node --version                # v22+
openclaw gateway status       # running or ready
openclaw config get gateway   # returns config, not an onboarding error
npm install @psiclawops/hypermem
npx hypermem-install
```

Create the lightweight starter config before the first restart:

```bash
mkdir -p ~/.openclaw/hypermem
cat > ~/.openclaw/hypermem/config.json <<'JSON'
{
  "embedding": { "provider": "none" },
  "compositor": {
    "budgetFraction": 0.55,
    "contextWindowReserve": 0.25,
    "targetBudgetFraction": 0.50,
    "warmHistoryBudgetFraction": 0.27,
    "maxFacts": 25,
    "maxHistoryMessages": 500,
    "maxCrossSessionContext": 4000,
    "maxRecentToolPairs": 3,
    "maxProseToolPairs": 10,
    "keystoneHistoryFraction": 0.15,
    "keystoneMaxMessages": 12,
    "wikiTokenCap": 500
  }
}
JSON
```

Wire OpenClaw using merge-safe config changes:

```bash
openclaw config get plugins.load.paths
openclaw config get plugins.allow

HYPERMEM_PATHS="["${HOME}/.openclaw/plugins/hypermem/plugin","${HOME}/.openclaw/plugins/hypermem/memory-plugin"]"
openclaw config set plugins.load.paths "$HYPERMEM_PATHS" --strict-json
openclaw config set plugins.slots.contextEngine hypercompositor
openclaw config set plugins.slots.memory hypermem

# Only if plugins.allow already contains an array, append the two ids to that existing array.
# Do not create a new allowlist just for HyperMem.
openclaw config set plugins.allow '["existing-plugin","hypercompositor","hypermem"]' --strict-json

openclaw gateway restart
```

Verify activation:

```bash
openclaw plugins list
openclaw logs --limit 100 | grep -E 'hypermem|context-engine'
hypermem-status --health
hypermem-model-audit --strict
```

Expected lightweight signals:

```text
[hypermem] hypermem initialized
[hypermem] Embedding provider: none - semantic search disabled, using FTS5 fallback
[hypermem:compose]
```

## Upgrade validation

An upgrade must preserve data and config.

```bash
cp -a ~/.openclaw/plugins/hypermem ~/.openclaw/plugins/hypermem.backup.$(date +%Y%m%d-%H%M%S) 2>/dev/null || true
npm install @psiclawops/hypermem@latest
npx hypermem-install
openclaw gateway restart
```

Validate after restart:

```bash
openclaw plugins list
openclaw logs --limit 100 | grep -E 'hypermem|context-engine|falling back'
hypermem-status --health
hypermem-model-audit --strict
```

Pass criteria:

- existing `~/.openclaw/hypermem/config.json` is unchanged unless the operator edits it intentionally
- existing `~/.openclaw/hypermem/agents/*/messages.db` files remain present
- `openclaw plugins list` shows both plugins loaded
- logs do not show `falling back to default engine "legacy"`
- health output is clean, or reports only healthy-empty state on unused installs

Rollback:

```bash
openclaw config set plugins.slots.contextEngine legacy
openclaw config set plugins.slots.memory none
openclaw gateway restart
```

Data under `~/.openclaw/hypermem` is not removed by rollback.

## Release package validation

Before publishing a release, run:

```bash
npm run validate:version-parity
npm run validate:sdk-imports
npm run validate:sdk-latest-canary
npm run validate:plugin-checkers
npm run validate:docs
npm run validate:config
npm run validate:release-path
npm test
npm --prefix plugin run build
npm --prefix memory-plugin run build
npm pack --dry-run
npm pack ./plugin --dry-run
npm pack ./memory-plugin --dry-run
```

The SDK gates are split deliberately: `validate:sdk-imports` enforces reproducible pinned OpenClaw Plugin SDK metadata, while `validate:sdk-latest-canary` rebuilds both plugin packages against the latest published OpenClaw SDK in a temp workspace so a stale pin cannot hide a future import break.

The plugin checker gate is deliberately composite: it runs Plugin Inspector static/runtime reports, isolated dependency-install cold import proof, production/dev dependency audit, Plugin Inspector issue-debt validation for the plugin packages. Raw Plugin Inspector P2 rows are not ignored: they must either disappear or have a proof artifact consumed by `validate:plugin-inspector:debt`.

Runtime validation must install the packed artifact, not the repo working tree. The production-shaped local install path is:

```bash
npm run install:runtime:packed
openclaw gateway restart
openclaw plugins list
node ~/.openclaw/plugins/hypermem/bin/hypermem-status.mjs --master
```

The final OpenClaw host-runtime plugin checker is:

```bash
npm run validate:plugins:runtime
```

That gate packs and installs the release artifact into OpenClaw's managed plugin directory, refreshes the plugin registry, runs `openclaw plugins doctor`, and runs runtime inspection for `hypercompositor` and `hypermem`. Treat HyperMem-owned doctor diagnostics as release-blocking. Unrelated local plugin diagnostics are reported but ignored by the HyperMem gate.

For isolated validation, test the packed artifact from a temp directory:

```bash
TMP=$(mktemp -d)
npm pack
npm --prefix "$TMP" init -y
npm --prefix "$TMP" install ./psiclawops-hypermem-*.tgz
node "$TMP/node_modules/@psiclawops/hypermem/scripts/install-runtime.mjs" "$TMP/runtime"
find "$TMP/runtime" -maxdepth 3 -type f | sort
```

The staged runtime must contain:

- `dist/`
- `plugin/dist/`
- `memory-plugin/dist/`
- `bin/hypermem-status.mjs`
- `bin/hypermem-model-audit.mjs`
- `node_modules/sqlite-vec` plus native sqlite-vec packages when present
- `node_modules/zod`

## Integration failure signatures

| Symptom | Likely cause | Fix |
|---|---|---|
| `falling back to default engine "legacy"` | Plugin not loaded, wrong slot, stale runtime, or allowlist collision | verify load paths, slots, allowlist merge, and staged `dist` files |
| `Cannot find module 'zod'` | runtime staging missed plugin dependency | rerun `hypermem-install`, verify `node_modules/zod` staged |
| sqlite-vec native load error | native sqlite-vec package missing from staged runtime | rerun staging from a package with sqlite-vec native payload included |
| `memory_search` bypasses HyperMem | memory slot not set or memory plugin not loaded | set `plugins.slots.memory hypermem`, restart, verify plugins list |
| status tool reports missing data dir | gateway has not initialized HyperMem yet | restart after wiring and send one agent message |
| model audit flags unknown context window | active model needs explicit override | add `contextWindowOverrides` in HyperMem config |


### Production-shaped runtime validation

HyperMem development validation must install the packed package into OpenClaw's managed plugin directory before claiming a runtime fix is live. Do not rely on a repo symlink, global npm link, or copied `dist/` files as production evidence.

Required loop:

```bash
npm run build:all
npm pack
node scripts/install-packed-runtime.mjs ./psiclawops-hypermem-<version>.tgz
systemctl --user restart openclaw-gateway
node bin/hypermem-status.mjs --master
```

The health check must verify the managed install at `~/.openclaw/plugins/hypermem`, not the working tree.

### Referenced-noise maintenance debt

`hypermem-status --master` reports referenced-noise debt under `## Maintenance`. This is low-signal message content that cannot be deleted by ordinary noise sweep because it is still a foreign-key target, usually through `messages.parent_id`.

Operators can run the conservative repair path:

```bash
node bin/hypermem-status.mjs --master --repair-referenced-noise --repair-limit 100
```

The repair only collapses noise nodes blocked solely by `messages.parent_id`. It reparents children to the deleted node's parent, decrements subtree depth, and rolls back the whole batch if `PRAGMA foreign_key_check` reports any violation. Context and composition snapshot heads are detected but not repaired by this pass.
