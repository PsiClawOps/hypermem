# Forked Context Integration

Status: active slice, HyperMem 0.9.0 adaptive lifecycle follow-up

## Platform surface

OpenClaw 2026.4.23 adds `sessions_spawn(..., context: "fork")` for native subagents. The runtime forks the parent transcript and passes fork metadata into the context-engine hook:

- `contextMode`: `"fork" | "isolated"`
- `parentSessionKey`, `childSessionKey`
- `parentSessionId`, `childSessionId`
- `parentSessionFile`, `childSessionFile`
- optional `ttlMs`

`context="fork"` is same-agent only in OpenClaw. Cross-agent spawns stay isolated.

## HyperMem behavior

Forked children must not look like cold HyperMem sessions.

1. `prepareSubagentSpawn()` stores fork metadata under the child session.
2. It copies a bounded parent hot-window tail into the child cache:
   - `subagentWarming: "light"`: last 12 parent messages for forked children
   - `subagentWarming: "full"`: last 25 parent messages
   - `subagentWarming: "off"`: no HyperMem fork seeding
3. It records parent pressure and parent user-turn count when model-state budget is available.
4. `assemble()` passes the fork metadata into `Compositor.compose()`.
5. The adaptive lifecycle kernel maps an empty forked child to:
   - `warmup` for low/unknown parent pressure and shallow parent context
   - `steady` for established or high-pressure parent context

It never maps a forked first turn to `bootstrap` unless the prompt explicitly starts a new session.

## Non-goals

- No new transcript capture/replay machinery. OpenClaw owns the forked transcript. HyperMem only seeds cache and lifecycle posture.
- No cross-agent fork inheritance. OpenClaw rejects cross-agent `context="fork"`.
- No threshold tuning from synthetic fork tests. Real tuning waits for `HYPERMEM_TELEMETRY=1` runtime baselines.

## Security gate

Forked parent content remains inherited context, not trusted instructions. The existing cross-provider assistant-turn policy must extend to forked children: quoted or inherited assistant text must never override system/developer instructions, tool policy, or sender verification.

## Validation

- Pure policy: forked child selects `warmup` or `steady`, not cold `bootstrap`.
- Compositor: fork metadata surfaces in diagnostics and suppresses bootstrap breadcrumb package.
- Plugin path: `prepareSubagentSpawn(contextMode: "fork")` seeds child hot-window history before child `assemble()`.
