/**
 * hypermem Trigger Registry (W5)
 *
 * Centralizes ACA collection trigger definitions with owner/category metadata.
 * Extracted from compositor.ts for independent testability and auditability.
 *
 * - TRIGGER_REGISTRY_VERSION: semver string for the registry schema
 * - TRIGGER_REGISTRY_HASH:    12-char SHA-256 of (collection, keywords) per entry
 * - logRegistryStartup():     emits version + hash on first Compositor boot
 */
/**
 * A trigger definition maps a collection to the conversation signals that
 * indicate it should be queried. When any keyword matches the user's latest
 * message, the compositor fetches relevant chunks from that collection.
 *
 * Centralizing trigger logic here (not in workspace stubs) means:
 * - One update propagates to all agents
 * - Stubs become documentation, not code
 * - Trigger logic can be tested independently
 *
 * W5 additions: owner, category, description (all optional — backward compat).
 */
export interface CollectionTrigger {
    /** Collection path: governance/policy, identity/job, etc. */
    collection: string;
    /** Keywords that trigger this collection (case-insensitive) */
    keywords: string[];
    /** Max tokens to inject from this collection */
    maxTokens?: number;
    /** Max chunks to retrieve */
    maxChunks?: number;
    /** Which agent/team owns this trigger set */
    owner?: string;
    /** Logical grouping: 'governance' | 'identity' | 'memory' | 'operations' */
    category?: string;
    /** Human-readable purpose */
    description?: string;
}
export declare const TRIGGER_REGISTRY_VERSION = "1.0.0";
/**
 * Default trigger registry for standard ACA collections.
 * Covers the core ACA offload use case from carol's spec.
 */
export declare const TRIGGER_REGISTRY: CollectionTrigger[];
/** Backward-compat alias — same reference as TRIGGER_REGISTRY */
export declare const DEFAULT_TRIGGERS: CollectionTrigger[];
/**
 * 12-char SHA-256 of the registry's (collection, keywords) pairs.
 * Changes when trigger definitions change; stable across metadata-only edits.
 * Computed once at module load.
 */
export declare const TRIGGER_REGISTRY_HASH: string;
/**
 * Match a user message against the trigger registry.
 * Returns triggered collections (deduplicated, ordered by trigger specificity).
 */
export declare function matchTriggers(userMessage: string, triggers: CollectionTrigger[]): CollectionTrigger[];
/**
 * Emit a one-line startup log with registry version, hash, and entry count.
 * Call once per process via the Compositor constructor guard.
 */
export declare function logRegistryStartup(): void;
//# sourceMappingURL=trigger-registry.d.ts.map