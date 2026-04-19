# HyperMem 0.8.0 Release Path Validation

This is the operator runbook for the release hardening harness.

## Command

```bash
npm run validate:release-path
```

That command builds core + plugin, then runs `test/release-gateway-path.mjs` against the built plugin dist in an isolated temporary HOME.

## What it proves

The harness exercises the real context-engine plugin path, not just direct compositor helpers.

It verifies four release-path behaviors in one run:

1. **normal compose path** returns assembled context through `engine.assemble()`
2. **artifact degradation** emits a canonical `[artifact:...]` reference in system context
3. **tool-chain ejection** is recorded through real compose-path co-ejection counters in telemetry
4. **tool-loop replay recovery** emits the canonical `[replay state=entering ...]` marker when runtime history is hot and the hot cache is cold

## Telemetry contract

When `HYPERMEM_TELEMETRY=1`, the plugin now emits a `degradation` JSONL event alongside the existing `assemble`, `trim`, and `trim-guard` events.

Per event fields:

- `agentId`
- `sessionKey`
- `turnId`
- `path` (`compose` or `toolLoop`)
- `toolChainCoEjections`
- `toolChainStubReplacements`
- `artifactDegradations`
- `artifactOversizeThresholdTokens`
- `replayState`
- `replayReason` (legacy machine reason strings may still contain `redis` for compatibility)

The release harness asserts those counters against prompt-visible behavior, so the telemetry is not just emitted, it is verified.

## Inspecting artifacts manually

By default the harness deletes its temp HOME on success.

To keep the temp workspace and telemetry file:

```bash
HYPERMEM_KEEP_RELEASE_TMP=1 npm run validate:release-path
```

The script will print the preserved temp path. The telemetry file lives at:

```text
<tmp>/release-telemetry.jsonl
```

## Healthy result

```text
ALL 12 CHECKS PASSED ✅
```

A healthy run means the built plugin can prove the Phase C prompt-path contracts that matter for `0.8.0`:

- degraded content uses the canonical visible shapes where it is prompt-visible
- degradation counters line up with what entered the model path
- replay recovery is visible at the plugin boundary
- the proof runs against the real assemble lifecycle, not a mocked helper only
