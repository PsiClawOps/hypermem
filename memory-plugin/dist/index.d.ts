/**
 * HyperMem Memory Plugin
 *
 * Thin adapter that bridges HyperMem's retrieval capabilities into
 * OpenClaw's memory slot contract (`kind: "memory"`).
 *
 * The context engine plugin (hypercompositor) owns the full lifecycle:
 * ingest, assemble, compact, afterTurn, bootstrap, dispose.
 *
 * This plugin owns the memory slot contract:
 * - registerMemoryCapability() with runtime + publicArtifacts
 * - memory_search tool backing via MemorySearchManager
 * - Public artifacts for memory-wiki bridge
 *
 * Both plugins share the same HyperMem singleton (loaded from repo dist).
 */
declare const _default: {
    id: string;
    name: string;
    description: string;
    configSchema: import("openclaw/plugin-sdk/core").OpenClawPluginConfigSchema;
    register: NonNullable<import("openclaw/plugin-sdk/core").OpenClawPluginDefinition["register"]>;
} & Pick<import("openclaw/plugin-sdk/core").OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
export default _default;
