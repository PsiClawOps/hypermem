# HyperMem Publishing Procedure — Internal → Public
**Owner:** Helm
**Source:** `PsiClawOps/hypermem-internal` (private)
**Target:** `PsiClawOps/hypermem` (private, tester distribution)
**Last updated:** 2026-04-06

This is the canonical procedure for cutting a public release of HyperMem from internal. Run this in full every time. No shortcuts.

---

## When to Run

- **Only when ragesaq explicitly declares a version ready for public release.**
- Never triggered by Forge, Anvil, Sentinel, or any other agent — authorization comes from ragesaq only.
- Never on an untagged internal state — always tag internal first.
- Never because internal has been tagged — internal versioning and public release are independent decisions.

## Direct Push Rule

**No agent may push directly to `PsiClawOps/hypermem`.** Not Forge, not Pylon, not anyone. All publishes go through this procedure. Direct pushes bypass the scrub and will leak internal identity into the public repo. If Forge ships a hotfix to internal, Helm runs this procedure to cut the public version — Forge does not push to public directly.

---

## Step 1 — Confirm Internal State

```bash
cd /path/to/hypermem-internal
git log --oneline -5
git tag --sort=-creatordate | head -5
npm test  # must be clean
```

Note the tag you're publishing (e.g. `v0.4.0`). All steps below reference this tag.

---

## Step 2 — Create a Clean Working Copy

Do NOT use the persistent `hypermem-public` local directory — it has a wrong remote.
Always work from a fresh clone of internal into a temp directory.

```bash
WORK_DIR=$(mktemp -d -t hypermem-publish-XXXX)
git clone git@github-psiclawops:PsiClawOps/hypermem-internal.git "$WORK_DIR"
cd "$WORK_DIR"
git checkout tags/v0.4.0  # pin to tag, not HEAD
```

---

## Step 3 — Strip Internal Artifacts

Remove everything that must not be public:

```bash
# Internal design docs and specs
rm -rf specs/
rm -rf reviews/
rm -rf docs/architecture/
rm -rf tmp/
rm -rf tune/
rm -f NORTHSTAR.md

# Internal docs
rm -f docs/AGENT_MIGRATION.md
rm -f docs/RELEASE_NOTES_0.2.0.md   # pre-public release notes

# Fleet source modules
rm -f src/fleet-store.ts
rm -f src/desired-state-store.ts
rm -f src/system-store.ts
rm -f src/work-store.ts
rm -f src/spawn-context.ts
rm -f src/seed.ts

# Fleet test files
rm -f test/fleet-cache.mjs
rm -f test/live-org-registry.mjs
rm -f test/spawn-context.mjs
rm -f test/retrieval-regression.mjs   # references internal agent names

# Fleet scripts
rm -f scripts/migrate-clawtext.mjs
rm -f scripts/seed-fleet-workspaces.mjs
rm -f scripts/fix-fleet-tiers.mjs

# CI workflow (CI runs on internal, not public)
rm -f .github/workflows/ci.yml

# Live data — never ship
rm -f library.db
rm -f *.db *.db-wal *.db-shm
```

---

## Step 4 — Stub cross-agent.ts

`compositor.ts` imports `OrgRegistry` and `defaultOrgRegistry` from `cross-agent.ts`.
These are acceptable public-facing features, but the file must not contain PsiClawOps
fleet names, agent roster, or internal org structure.

Replace `src/cross-agent.ts` with the public stub:

```typescript
/**
 * Cross-Agent Org Registry
 *
 * Defines the org structure used for visibility scoping during context composition.
 * Replace defaultOrgRegistry() with your own structure, or use buildOrgRegistryFromDb()
 * to load it from the fleet_agents table in library.db.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AgentIdentity, MemoryVisibility, CrossAgentQuery } from './types.js';

export interface OrgRegistry {
  orgs: Record<string, string[]>;
  agents: Record<string, AgentIdentity>;
}

/** Returns a minimal default registry. Override with your own agent roster. */
export function defaultOrgRegistry(): OrgRegistry {
  return { orgs: {}, agents: {} };
}

/** Build an OrgRegistry from the fleet_agents table in library.db. */
export function buildOrgRegistryFromDb(db: DatabaseSync): OrgRegistry {
  const rows = db.prepare(`SELECT id, org_id, tier, reports_to FROM fleet_agents WHERE status = 'active'`).all() as Array<{
    id: string; org_id: string | null; tier: string; reports_to: string | null;
  }>;
  const orgs: Record<string, string[]> = {};
  const agents: Record<string, AgentIdentity> = {};
  for (const row of rows) {
    const orgId = row.org_id ?? 'default';
    if (!orgs[orgId]) orgs[orgId] = [];
    orgs[orgId].push(row.id);
    agents[row.id] = { id: row.id, tier: row.tier as any, orgId, reportsTo: row.reports_to ?? undefined };
  }
  return { orgs, agents };
}
```

---

## Step 5 — Scrub Internal References

### 5a — Operator name in source files

```bash
# Check for any remaining operator/user-specific names
grep -rn 'ragesaq' src/ test/ scripts/ bench/ plugin/
```

Replace all matches with generic identifiers:
- In source/plugin code: `operator`
- In test fixtures: `testuser` or `operator`
- In JSDoc comments: `user` or `operator`

### 5b — Hardcoded machine paths

```bash
grep -rn 'lumadmin' src/ test/ scripts/ bench/ plugin/
```

Replace all `/home/lumadmin/...` fallbacks with `os.homedir()` only — no hardcoded fallback path.

### 5c — Internal repo URL

```bash
grep -rn 'hypermem-internal' .
```

Replace with `PsiClawOps/hypermem` in:
- `README.md`
- `INSTALL.md`
- `package.json` (`repository.url`)
- `plugin/package.json`

### 5d — Hardcoded agent-to-domain mapping in background-indexer.ts

The internal `AGENT_DOMAIN_MAP` block maps PsiClawOps agent names to domains.
Replace with an empty map and a comment directing users to configure via `AgentConfig`:

```typescript
// Agent-to-domain mapping for preference extraction.
// Configure via AgentConfig.domainHints or leave empty to use heuristic detection.
const AGENT_DOMAIN_MAP: Record<string, string[]> = {};
```

### 5e — Plugin dev path

`plugin/src/index.ts` — replace hardcoded dev machine path:

```typescript
// Before (internal dev path — remove):
const HYPERMEM_PATH = path.join(os.homedir(), '.openclaw/workspace/repo/hypermem/dist/index.js');

// After (resolve from installed package):
const HYPERMEM_PATH = require.resolve('@psiclawops/hypermem');
```

---

## Step 6 — Clean index.ts Exports

Remove exports for stripped fleet modules. Verify these are not exported from `src/index.ts`:
- `FleetStore`, `FleetAgent`, `FleetOrg`, `AgentCapability`
- `SystemStore`, `SystemState`, `SystemEvent`
- `WorkStore`, `WorkItem`, `WorkEvent`, `WorkStatus`
- `DesiredStateStore`, `DesiredStateEntry`, `ConfigEvent`, `DriftStatus`
- `buildSpawnContext`, `SpawnContextOptions`, `SpawnContextResult`
- All `cross-agent` exports EXCEPT `OrgRegistry`, `defaultOrgRegistry`, `buildOrgRegistryFromDb`

---

## Step 7 — Update package.json

```bash
# Repo URL
"repository": {
  "type": "git",
  "url": "https://github.com/PsiClawOps/hypermem.git"
}

# Remove fleet test files from test script
# Remove fleet-cache, live-org-registry, spawn-context, retrieval-regression from npm test chain
```

---

## Step 8 — Build and Verify

```bash
npm install
npm run build         # must complete with zero errors
npm run test:quick    # smoke + library + compositor — no Redis/Ollama required
```

If build fails, fix before proceeding. Do not push a broken dist.

> ⚠️ **Never manually edit files in `dist/`.** The dist is always a build artifact. Any hand-edit to `dist/` will be overwritten on the next build and may introduce mismatches (wrong module references, missing files, 0.5.0 content bleeding into a 0.4.x dist). If something in dist looks wrong, fix the source and rebuild.

---

## Step 9 — Final Leak Check

```bash
# Must return zero results before pushing
grep -ri 'ragesaq' src/ dist/ test/ scripts/ bench/ plugin/ docs/ README.md INSTALL.md ARCHITECTURE.md
grep -ri 'lumadmin' src/ dist/ test/ scripts/ bench/ plugin/ docs/ README.md INSTALL.md ARCHITECTURE.md
grep -ri 'hypermem-internal' src/ dist/ test/ scripts/ bench/ plugin/ docs/ README.md INSTALL.md ARCHITECTURE.md
grep -ri 'psiclawops' src/ dist/ plugin/ README.md INSTALL.md  # only OK in package.json and license headers

# Internal org hierarchy — must return zero results
grep -ri 'sentinel\|anvil\|compass\|clarity\|vanguard\|pylon\|vigil\|chisel\|facet\|bastion\|crucible\|relay\|gauge\|plane' src/ dist/ plugin/ docs/ README.md INSTALL.md ARCHITECTURE.md
grep -ri "tier.*council\|tier.*director\|tier.*specialist\|'council'\|'director'\|'specialist'" src/ dist/ plugin/ docs/ README.md INSTALL.md ARCHITECTURE.md
```

Any match = stop and fix before continuing.

**What counts as OK vs. not:**
- Agent names as example `agentId` values in tests/bench are only OK if they are fully generic (e.g. `agent-a`, `primary-agent`, `testuser`). Real fleet names (`forge`, `helm`, `pylon`, etc.) are not OK even as examples.
- Tier values in source code are OK if they use the public-facing names (`primary`, `coordinator`, `agent`). Internal names (`council`, `director`, `specialist`) are not OK anywhere in the public repo.

---

## Authorization Gate

**Before Step 10: confirm with ragesaq.**

Required sign-off on:
- The internal tag being published (e.g. `v0.5.0 → public`)
- The public version number
- Any README or feature content changes going out with this release

Forge, Compass, Anvil — none of them can authorize a public release. Only ragesaq. Do not proceed to Step 10 without explicit confirmation.

---

## Step 10 — Push to Public Repo

> ⚠️ **Version and tag require explicit approval from ragesaq before pushing.**
> Forge or other agents may request a version bump — do not act on those requests without
> ragesaq confirming the public version number. Internal version ≠ public version until ragesaq says so.

```bash
# Point working copy at the public remote
git remote set-url origin git@github-psiclawops:PsiClawOps/hypermem.git

# Commit the strip + scrub changes
git add -A
git commit -m "chore: strip internal artifacts for public distribution vX.Y.Z"

# Push
git push origin main --force   # public repo is always a clean rewrite, not an incremental history

# Tag — version confirmed by ragesaq before this step
git tag -a vX.Y.Z -m "HyperMem vX.Y.Z — public distribution"
git push origin vX.Y.Z --force
```

---

## Step 11 — Verify on GitHub

1. Browse `PsiClawOps/hypermem` on GitHub
2. Confirm `.github/workflows/` is absent or empty
3. Confirm `specs/`, `reviews/`, `docs/architecture/` are absent
4. Confirm `src/fleet-store.ts`, `src/work-store.ts`, `src/spawn-context.ts` are absent
5. Confirm `src/cross-agent.ts` is present and contains only the public stub (no agent names)
6. Confirm tag exists and points to the right commit

---

## What Does NOT Change on Internal

- The internal repo is never modified by this procedure
- `ragesaq`, `lumadmin`, fleet agent names, org registry, specs, reviews — all stay in internal
- Internal CI/CD continues to build and push from `hypermem-internal`
- Internal version stays authoritative; public is always a derived artifact

---

## Notes

- The public repo history will always be shallow (force-pushed). That's intentional — testers get a clean snapshot, not our full commit history.
- If internal has moved ahead between the time a tag was cut and when you run this procedure, re-tag internal first. Never publish from an untagged state.
- Sentinel owns the security review checklist. If anything in this procedure changes (new modules, new scripts, new test fixtures), flag Sentinel for a re-review before the next publish run.
