# HyperMem Release Process

Internal development happens in `hypermem-internal`. The public repo (`hypermem`) receives sanitized snapshots via the sync script. These are two separate repos — the public repo is **never edited directly**.

---

## Golden Rule

> Code flows in one direction: **internal → public**.
> The public repo is never edited directly. If a fix needs to land in public, it lands in internal first, then syncs.

---

## Substitution Map

The following substitutions are applied automatically by `scripts/sync-public.mjs`:

| Internal | Public |
|---|---|
| `forge` | `alice` |
| `compass` | `bob` |
| `clarity` | `clarity` *(unchanged — generic word)* |
| `sentinel` | `dave` |
| `anvil` | `carol` |
| `vanguard` | `oscar` |
| `pylon` | `hank` |
| `vigil` | `jack` |
| `plane` | `irene` |
| `helm` | `eve` |
| `chisel` | `frank` |
| `facet` | `grace` |
| `bastion` | `leo` |
| `gauge` | `kate` |
| `crucible` | `mike` |
| `relay` | `nancy` |
| `forge-org` | `alice-org` |
| `compass-org` | `bob-org` |
| `sentinel-org` | `dave-org` |
| `~/.openclaw/workspace-council/` | `~/.openclaw/workspace/` |
| `/home/lumadmin/.openclaw/...` | `~/.openclaw/...` *(path sanitized)* |

Substitutions are **word-boundary aware** — `sentinel value` in a comment is not affected, only the agent name `sentinel`.

---

## Files Excluded from Public Sync

| File | Reason |
|---|---|
| `scripts/flush-agent-session.sh` | Internal fleet ops, references internal workspace paths |

To add exclusions, update `EXCLUDE_FILES` in `scripts/sync-public.mjs`.

---

## Release Steps

### 1. Prepare internal

```bash
# Confirm internal main is clean and tests pass
git checkout main
npm run build && npm test

# Update version in package.json
npm version patch|minor|major --no-git-tag-version

# Update CHANGELOG.md with release notes (user-facing, no internal names)
# Add an entry under ## [x.y.z] — YYYY-MM-DD

# Commit
git add package.json CHANGELOG.md
git commit -m "chore: bump version to x.y.z"
git push origin main
```

### 2. Run the sync

```bash
# Dry run first — confirm what gets sanitized
node scripts/sync-public.mjs "chore: release vX.Y.Z" --dry-run

# Full sync + push
node scripts/sync-public.mjs "chore: release vX.Y.Z"
```

The script:
- Verifies internal main is clean
- Checks out a `public-sync` branch from `public/main`
- Exports every synced file from internal main via `git show`
- Applies the substitution map
- Builds and runs the full test suite
- Commits with the provided message
- Pushes to `public/main`
- Returns to `main`

### 3. Tag the public release

```bash
# Tag on the public repo
git fetch public
git tag -a vX.Y.Z public/main -m "vX.Y.Z"
git push public vX.Y.Z
```

### 4. Publish to npm (if applicable)

```bash
cd /tmp && git clone git@github-psiclawops:PsiClawOps/hypermem.git hypermem-release
cd hypermem-release && npm publish --access public
```

---

## Hotfix Process

If a security or bug fix needs to land in public quickly:

1. Fix on internal `main` first
2. Run `node scripts/sync-public.mjs "fix: <description>"` immediately — don't wait for a version bump
3. The fix commit lands in public with a clean message referencing only the behavior, not internal details

**Never edit the public repo directly to fix something faster.** The sync script takes ~2 minutes including build + tests. That's not long enough to justify breaking the one-direction rule.

---

## Commit Message Standards (Public)

Public commit messages must be clean — no internal references, no agent names, no internal ticket IDs.

Good:
```
fix(security): parameterize SQL datetime interpolation in topic-synthesizer
feat: add window cache freshness validation in compositor
chore: release v0.5.6
```

Bad:
```
fix: per Sentinel review, patch PF2 in composer (forge session 2026-04-11)
feat: forge's compositor window cache patch
WQ-042: SQL injection fixes
```

The commit message is the only thing that goes into the public repo unfiltered — the substitution map does not touch it. Write it clean from the start.

---

## What Happens If Public Gets Edited Directly

1. The next sync will overwrite those changes (sync copies from internal, not merges)
2. The internal and public commit histories diverge permanently
3. Future cherry-picks may produce empty commits or conflicts

Recovery: if public was edited directly, those changes must be ported to internal manually before the next sync. Flag it immediately so it doesn't get lost.
