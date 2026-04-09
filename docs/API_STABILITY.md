# API Stability — hypermem

## Public API (frozen at 0.5.0)

The following four methods are the stable public surface of hypermem. They are
frozen as of 0.5.0. Breaking changes require a 1.0.0 semver bump — no exceptions.

| Method | Signature | Description |
|---|---|---|
| `create` | `create(config: HypermemConfig): HypermemInstance` | Initialize a hypermem instance |
| `record` | `record(agentId, sessionKey, message): Promise<void>` | Store a message in the session store |
| `compose` | `compose(agentId, sessionKey, opts?): Promise<ComposedContext>` | Assemble context for a prompt |
| `close` | `close(): Promise<void>` | Gracefully shut down, flush, close DB connections |

## What "frozen" means

- No argument removal or rename
- No return type narrowing that breaks existing consumers
- No behavior change that breaks existing consumers without a deprecation cycle
- Additive changes (new optional args, new fields in return type) are allowed

## Internal APIs

Everything else — `FactStore`, `RedisLayer`, `Compositor`, `HybridRetrieval`,
`DreamingPromoter`, etc. — is internal and may change between minor versions.
These are exported for advanced use but carry no stability guarantee until 1.0.

## Versioning policy

| Version range | Policy |
|---|---|
| `0.x.y` | Public API frozen, internal APIs may change on minor bumps |
| `1.0.0+` | Full semver — breaking changes require major bump |
