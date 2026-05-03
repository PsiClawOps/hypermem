# Changelog

All notable changes to hypermem are documented here.

## 0.9.7 - 2026-05-02

- **OpenClaw Plugin SDK imports modernized.** HyperCompositor and HyperMem memory now import plugin entry helpers through the canonical public Plugin SDK surface and refresh OpenClaw/Plugin SDK build provenance to the validated runtime.
- **SDK drift is now actively challenged.** Release gates enforce public SDK imports and exact build metadata for reproducibility, while a latest-SDK canary and Dependabot tracking keep the pin from quietly aging into another compatibility break.
- **Memory plugin tool contract declared.** `hypermem` now declares ownership of the optional `history_query` tool in its OpenClaw plugin manifest, satisfying the 2026.5.2 plugin checker contract gate.
- **Plugin checker gates are now standard release infrastructure.** HyperMem CI runs Plugin Inspector static/runtime checks plus isolated dependency-install cold import proof, production/dev dependency audit, and issue-debt validation; publish readiness has a packed-artifact OpenClaw `plugins doctor`/runtime-inspect gate. The previous context-engine root SDK barrel P2 is fixed by deriving context-engine types from the public `OpenClawPluginApi` core type surface.

## 0.9.6 - 2026-05-01

- **OpenClaw 2026.4.29 plugin startup compatibility.** HyperCompositor and HyperMem memory manifests now declare `activation.onStartup: false`, making slot-triggered loading explicit and removing reliance on deprecated implicit startup sidecar fallback behavior.
- **Release parity preserved.** Core, context-engine plugin, memory plugin, and lockfiles are aligned at 0.9.6 for the compatibility update.

## 0.9.5 - 2026-04-29

- **Install-readiness defaults hardened.** Fresh installs now stage `embedding.provider: "none"` by default, making the first-install path FTS5-only and free of Ollama or hosted-provider dependencies.
- **Install states documented.** README, INSTALL, and TUNING now classify fresh installs as GREEN/YELLOW/RED, with FTS5/no-embedding installs explicitly YELLOW rather than failed.
- **Semantic recall is opt-in after baseline install.** Ollama and hosted embedding setup moved behind the verified baseline path so operators can bring HyperMem online before adding vector recall.
- **OpenClaw command guidance updated.** Install docs now use the current `openclaw gateway` command surface instead of stale daemon commands.
- **Public package payload tightened.** npm package files now include operator-facing docs only; internal architecture and release-process docs are excluded from the published artifact.
- **Fresh-install smoke covers the FTS5 default.** The release gate now validates the no-embedding default path directly.

## 0.9.4 - 2026-04-28

- **Recall surface re-enriched.** Bootstrap, warmup, and steady lifecycle bands now carry larger warming fractions, `/new` and topic-shift recall surge harder, and topic-bearing warmup avoids heartbeat/small-talk decay.
- **Adjacency-aware preservation added.** Hybrid retrieval boosts recent antecedents while filtering heartbeat/system noise, and compose eviction guards the literal antecedent under non-critical pressure.
- **Install path hardened.** `hypermem-install` ships the doctor, bench, and default config artifacts, writes `~/.openclaw/hypermem/config.json` only when missing, probes the default Ollama embedder, preserves existing config, supports CI-safe flags, and rejects unknown options.
- **Fresh-install smoke gate added.** `release-gate-internal/fresh-install-smoke.sh` packs the npm artifact, installs it in the PsiClawOps Docker test image without a source mount, verifies graceful no-tools failure, verifies skip-mode staging, and proves existing config is not overwritten.
- **Installer failure artifacts captured.** Failed smoke runs now preserve logs, generated configs, package metadata, the packed tarball, and container `/tmp` inventories under `.artifacts/fresh-install-smoke/` for postmortem reuse.

## 0.9.3 - OpenClaw 2026.4.26 compatibility hardening

- **Plugin manifests declare runtime config schema.** HyperCompositor and HyperMem memory manifests now expose the supported config surface for OpenClaw 2026.4.26 registry/config validation.
- **Install and doctor flow aligned with persisted plugin registry.** operator guidance and `hypermem-doctor` now include registry refresh, doctor repair, and plugin-list verification steps.
- **Native compaction collision guard added.** `hypermem-doctor` warns when `agents.defaults.compaction.maxActiveTranscriptBytes` is set; HyperMem deployments should leave it unset so HyperMem remains the single trim/compose pressure owner.
- **Embedding query/document asymmetry supported.** HyperMem config now supports query/document input types and prefixes, with defaults for `nomic-embed-text`, `qwen3-embedding`, and `mxbai-embed-large`.
- **Forked subagent warm-start repair.** `prepareSubagentSpawn()` falls back to durable runtime history when the hot cache is empty, so forked children inherit parent working context instead of silently starting cold.

## 0.9.2 - 0.9.1 republish + publish-path hardening

- **0.9.1 was a broken publish.** The npm tarballs for `@psiclawops/hypermem@0.9.1`, `@psiclawops/hypercompositor@0.9.1`, and `@psiclawops/hypermem-memory@0.9.1` shipped without `dist/`, so `import` against the registry artifact fails with `ERR_MODULE_NOT_FOUND`. **Skip 0.9.1.** Operators currently on 0.9.1 should upgrade to 0.9.2.
- **Same code intent as 0.9.1.** Plugin singleton registry on `globalThis`, memory plugin loads user config, vector-store init log shows resolved provider/model/dims, tool artifact API arity + hydration docs aligned. (See 0.9.1 entry below for detail.)
- **`prepublishOnly` and `prepack` hooks added** to root, plugin/, and memory-plugin/ `package.json`. `npm publish` now refuses to ship without first running `npm run build`. The 0.9.1 packaging defect (gitignored `dist/` + no build hook → empty tarball) cannot recur.
- **0.9.1 deprecated on the registry** for all three packages, with a pointer to 0.9.2.

## 0.9.1 - plugin singleton + memory-plugin config patch (BROKEN PUBLISH — use 0.9.2)

- **HyperMem singleton registry is now backed by `globalThis`.** Multiple module instances loaded from `node_modules` would each construct a private singleton, so HyperCompositor and the memory plugin could end up writing to different SQLite/vector stores. The registry now lives on `globalThis`, guaranteeing one instance per `dataDir` regardless of how many copies of the module are resolved.
- **Memory plugin loads user config.** The memory plugin entrypoint now reads operator config (provider, embedding model, dimensions) instead of falling back to library defaults, so a 768d nomic embedder in OpenClaw config no longer collides with a 4096d default at write time.
- **Vector store init log shows actual provider/model/dims.** Diagnostic log line at startup now reflects the resolved configuration instead of the static placeholder, so misconfiguration is visible immediately.
- **Tool artifact API arity + hydration docs aligned.** Doc-only follow-ups; no runtime behavior change.

**operator action:** upgrade from 0.9.0 is recommended. 0.9.0 in production with a configured non-default embedder may have written mismatched vectors; check `hypermem-status` for vector-store init line after upgrade.

## 0.9.0 - adaptive context lifecycle

- **Adaptive lifecycle is now production behavior.** Compose, afterTurn, recall, trim, compaction, and eviction share the same pressure-band policy across bootstrap, warmup, steady, elevated, high, and critical states.
- **Smart recall and adaptive eviction landed.** `/new` and confident topic shifts widen recall, high-pressure turns gate recall down, and topic-centroid-guided eviction activates only at elevated pressure or worse.
- **Lifecycle telemetry is release-gated.** Trim and compose reports classify lifecycle bands, divergence, and metadata-only topic signal without exposing topic names, prompt text, document text, or user content.
- **Deterministic topic evidence replaces live-sample gating.** The 0.9.0 topic-bearing compose gate is covered by deterministic fixtures and report tests, while live topic-bearing samples remain future tuning evidence only.
- **Forked-context integration is wired.** Forked subagent children inherit bounded parent hot-window context and start warmup or steady instead of cold bootstrap unless `/new` is explicit.
- **Vector coverage is repaired.** Active facts, knowledge, and eligible episodes reached 100% vector coverage before the release candidate validation pass.

## 0.8.8 - release hardening, diagnostics, lifecycle visibility

- **Release packaging aligned across packages.** Core, hypercompositor, and memory plugin versions align at 0.8.8, with version parity validation and bump-script hardening to prevent stale plugin dependencies or lockfile drift.
- **Installer path simplified.** The shell installer now follows the npm-first path, stages the runtime with `hypermem-install`, preserves existing config/data, backs up existing staged runtime when confirmed, and prints merge-safe OpenClaw activation commands.
- **Integration validation documented.** `docs/INTEGRATION_VALIDATION.md` defines the install state machine, fresh install checks, upgrade checks, package dry-run validation, and common integration failure signatures.
- **Diagnostics documented.** `docs/DIAGNOSTICS.md` covers `hypermem-status`, `hypermem-model-audit`, compose/trim reports, version parity, release-path checks, runtime logs, warm restore diagnostics, adaptive lifecycle diagnostics, and the runtime diagnostics API allowlist blocker.
- **Adaptive lifecycle visibility landed.** The pure lifecycle policy kernel, compose diagnostics, and afterTurn gradient cap are wired while leaving recall breadth, eviction tuning, and telemetry tuning deferred to 0.9.0.
- **Warm restore hardening is included.** Snapshot integrity, repaired restore paths, provider/parity gates, repair notices, and repair-depth caps are covered by validation guidance and release tests.
- **Reranker and embedding fixes are included.** Reranker wiring, ZeroEntropy endpoint handling, sqlite-vec native runtime packaging, and provider/model diagnostics are part of the 0.8.8 operational release train.

## 0.8.6 — docs cleanup, model audit config parsing, validator fix

- **`hypermem-model-audit` now understands object-shaped OpenClaw model config.** It correctly reads `model.primary` plus fallback arrays from modern agent config instead of reporting an empty model set.
- **Docs release notes no longer drift on package version text.** README and INSTALL now point operators to the next npm release instead of hard-coding conflicting minimum versions.
- **README and INSTALL roles are clearer.** INSTALL is explicitly the canonical operator bring-up guide, while README stays as the shorter install-state overview.
- **Docs validator false positives fixed.** `scripts/validate-docs.mjs` now checks only `openclaw config set plugins.slots.* ...` lines, so `config get` examples no longer trigger bogus plugin-id mismatch warnings.

## 0.8.5 — provider/model-aware failover detection, release parity

- **Provider + model identity is now tracked explicitly in HyperCompositor model state.** Mid-session routing changes are detected on the full `provider/model` key, not budget alone, so `github-copilot/claude-sonnet-4-6` and `anthropic/claude-sonnet-4-6` are treated as different operational envelopes.
- **Downshift detection now keys off provider/model-aware state.** Budget-downshift handling still stays conservative, but verbose logs now surface provider swaps, model swaps, and budget deltas clearly during `context:assemble`.
- **Install docs now declare the full operator path.** README, INSTALL.md, and TUNING.md now separate staging from activation, document install states explicitly, add merge-safe wiring guidance, and clarify what healthy-but-empty looks like on a first run.
- **0.8.5 release parity.** Package versions are aligned for the next publish while preserving the npm-first installer and merge-safe config guidance landed from Hank's install review.

## 0.8.4 — compaction fence fix, install-path fixes, zod runtime packaging

- **Compaction fence tail preservation fixed.** The recent-tail preservation fix is included so compaction no longer drops the protected recent tail during fence advancement.
- **`afterTurn` token count persistence fixed.** Token accounting now persists correctly after turn completion, which keeps follow-on pressure and compaction decisions honest.
- **Registry install docs corrected and hardened.** Installation guidance now fixes a shipped legacy command-token typo, clarifies older package behavior around missing `install:runtime`, improves `plugins.load.paths` quoting, and removes the dangerous overwrite-style `plugins.allow` example in favor of merge-safe guidance.
- **Install tracks clarified.** Docs now distinguish source-clone plugin setup from older npm package behavior so first-run operators do not follow the wrong path.
- **`zod` now ships for plugin runtime use.** The published package now includes the runtime `zod` dependency required by the HyperCompositor plugin, fixing `Cannot find module 'zod'` on package-based installs.

## 0.8.2 — npm packaging & install path clarity

- **INSTALL.md and CHANGELOG.md now ship in the npm package.** Previously missing from `package.json` `files` array, so `npm pack` / `npm publish` excluded them. Users installing from the registry now get the full install guide without cloning the repo.
- **Library vs plugin install paths split in README.** The Installation section now clearly separates standalone library usage (no OpenClaw required) from OpenClaw plugin wiring. Library consumers no longer have to read through plugin-specific steps.
- **Cold-start prerequisites expanded.** INSTALL.md prerequisites now include explicit verification commands (`openclaw gateway status`, `node --version`), distinguish first-time OpenClaw setup from existing installs, and explain when to use `gateway start` vs `gateway restart`.
- **Verification steps handle auth failures.** Step 4 verification now includes diagnostic callouts for `gateway restart` failures (not onboarded, missing config) and `openclaw logs` failures (gateway not running, path issues).
- **Troubleshooting quick-reference added to README.** A 7-row common-issues table covers plugin-not-found, legacy fallback, no semantic results, build errors, empty facts, context pressure, and missing messages.db -- with symptoms, causes, and one-line fixes.

## 0.8.1 — Documentation fixes

- **Install docs rewritten for clean first-run:** README and INSTALL.md installation sections restructured so config comes before restart, `$HOME` replaces `~` in shell-interpolated JSON strings, clone path is no longer hardcoded, and health-check instructions note the repo-dir requirement and data-dir timing.
- **install:runtime output:** `npm run install:runtime` now prints the next-step commands (config creation + plugin wiring) so the user doesn't have to hunt through docs.
- **Lightweight mode clarified:** Step 3 no longer says "skip for Lightweight" — a `config.json` with `provider: "none"` is required to suppress the Ollama fallback warning.

## 0.8.0 — Phase C correctness, tool-artifact store, tiered contradiction resolution

- **Reranker credentials via environment variable:** `ZEROENTROPY_API_KEY` and `OPENROUTER_API_KEY` are now read from the environment. Config file `zeroEntropyApiKey` / `openrouterApiKey` still works as fallback. Recommended setup puts the key in a shell env file so it never lands in config-under-version-control.
- **Recommended operator tuning refreshed:** suggested full-deployment config lowered `warmHistoryBudgetFraction` to 0.27 and `budgetFraction` to 0.55, with corresponding fact/history/keystone trims. Produces steadier turn-over-turn pressure on long-running agent fleets and avoids the tight warm→trim→compact cycling that the previous richer defaults encouraged on 200k+ models. Existing deployments with custom configs are unaffected.
- **`contextWindowSize` retired from recommended config:** runtime autodetection from the active model identifier is stable; manual override is no longer suggested. The field is still honored if present for back-compat.
- **Custom/local model window guidance:** INSTALL.md and `docs/TUNING.md` now document `contextWindowOverrides` — how to detect autodetect failure (`verboseLogging` + `budget source:` log line), the two failure signatures (undersized = continuous trim cycling; oversized = mid-turn overflow), and how warming/trimming/compaction all scale off the detected window. Operators running finetuned, local, or unusually-named models should set overrides before tuning any other budget dial.
- **Phase C correctness cluster:** tool result guards (C1), budget cluster drop telemetry, oversized artifact degradation with canonical reference format, unified pressure accounting, replay recovery isolation. Prompt-path verification harness proves Phase C behavior in real gateway flow.
- **Tool-artifact store:** durable tool result storage for wave-guard (Sprint 2.1 active-turn hydration, Sprint 2.2 retention sweep + sensitive-artifact flag). Tool results survive compaction cycles.
- **Fleet registry seeding on startup:** fleet agents seeded from known identity files on every gateway start. No cold-start gaps in registry state after deploy.
- **Tiered contradiction resolution (V19):** auto-supersede at ≥0.80 confidence, `invalidateFact` at 0.60–0.80, log-only below 0.60. Background indexer records contradiction audits. Schema v19.
- **Dreaming promoter temporal-marker screen:** blocks durable promotion of time-bound facts without `validFrom`/`invalidAt` metadata. Prevents stale temporally-anchored facts from polluting the durable fact store.
- **MEMORY.md authoring guide:** `docs/MEMORY_MD_AUTHORING.md` documents the static-vs-dynamic fact contract for operators and agents.
- **B4 model-aware budgeting:** compositor resolves token budget from active model string when the runtime does not pass `tokenBudget` explicitly. Budget recomputes on mid-session model swap.
- **BLAKE3 content dedup + RRF fusion:** O(1) fingerprint dedup across all retrieval paths. RRF merges FTS5 and KNN results. Zigzag ordering balances recency and relevance in composed output.

## 0.7.0 — Temporal validity, expertise storage, contradiction detection

- **Temporal validity engine:** facts expire, get superseded, and decay over time. Stale knowledge auto-deprioritized in retrieval.
- **Expertise store:** per-agent skill/domain tracking. Agents accumulate domain proficiency through indexed interactions.
- **Contradiction detector:** flags conflicting facts at ingest time. Newer evidence supersedes older, with audit trail.
- **Maintenance APIs:** programmatic access to compaction stats, index health, and storage diagnostics.
- **CI pipeline:** Redis removed, memory-plugin build stage added, monorepo file-ref wiring.

## 0.6.2 — Turn DAG, identity scrub, fleet customization

- Turn DAG phases 1–3: DAG-native reads, context-scoped recall, fence downgrade.
- Fleet name substitution for public distribution.
- Fleet customization guide and single-agent install docs.

## 0.6.0 — Redis removal complete

- SQLite-only cache layer replaces Redis entirely. Zero external service dependencies.
- Simplified deployment: single binary + SQLite files.

## 0.5.6 — Content fingerprint dedup and hardening

- O(1) fingerprint dedup across all retrieval paths (temporal, open-domain, semantic, cross-session). Catches rephrased near-duplicates that substring matching missed.
- Identity bootstrap pre-fingerprinting: SOUL.md, USER.md, IDENTITY.md content already in the prompt is never double-injected by retrieval.
- Indexer circuit breaker with startup integrity check for library.db corruption. Graceful degradation, not cascading failure.
- SQL parameterization hardening on datetime and FTS5 paths.

## 0.5.5 — Tuning collapse and config schema

- Plugin config schema: all tuning knobs declarable in `openclaw.json`. No more manual config.json edits.
- Tuning simplified to 4 primary knobs: `budgetFraction`, `reserveFraction`, `historyFraction`, `memoryFraction`.
- Identity and doc chunk dedup against OpenClaw bootstrap injection.
- Window cache with freshness diagnostics.

## 0.5.0 — SQLite hot-cache transition and context engine

- SQLite `:memory:` hot cache introduced for the runtime hot layer. Redis compatibility artifacts still existed at this stage, full removal completed in 0.6.0.
- Context engine plugin: runs as an OpenClaw `contextEngine` slot, composing prompts per-turn.
- Transform-first assembly: tool results compressed before budget allocation, not after.
- Cluster-aware budget shaping: related tool turns grouped and trimmed together.
- Hybrid FTS5 + KNN retrieval with Reciprocal Rank Fusion.
- Workspace seeding: agents auto-ingest their workspace docs on bootstrap.
- Runtime profiles: `light`, `standard`, `full`.
- Obsidian import and export.
- Metrics dashboard primitives.

## 0.4.0 — Eviction and migration

- Image and heavy-content eviction pre-pass in assembly. Old screenshots and large tool outputs aged out before they compete for budget.
- Engine version stamps in library.db. Schema migration runs automatically on version bump.
- Migration guides and scripts for Cognee, QMD, Mem0, Zep, Honcho, and raw MEMORY.md files.

## 0.3.0 — Subagent context and retrieval

- Subagent context inheritance: spawned subagents get bounded parent context, session-scoped docs, and relevant facts.
- Tool Gradient v2: turn-age tiers with head+tail truncation on tool results.
- Cursor-aware indexer with ghost message suppression.

## 0.2.0 — Retrieval access control

- Trigger registry ownership and auditability.
- Retrieval access control, trigger fallback paths, and history rebalance.

## 0.1.0 — Core architecture

- Four-layer memory: in-memory cache, message history, vector search, structured library.
- 8-level priority compositor with slot-based prompt assembly.
- Cross-agent memory access with visibility-scoped permissions.
- Knowledge graph with DAG traversal.
