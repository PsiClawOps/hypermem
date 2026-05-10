/**
 * entity-bridge-store.ts \u2014 Sprint B
 *
 * Metadata-only CRUD/query helpers for the entity/grace bridge tables.
 *
 * Hard rule: this module never logs message content. Mention rows store
 * a `match_term` (the surface form of the matched span) and offsets, but
 * full message text remains in the `messages` table only.
 *
 * Tables (created by schema v12 migration):
 *   - memory_entities                  (agent_id, entity_key, display_name, ...)
 *   - memory_facets                    (agent_id, facet_key, ...)
 *   - message_entity_mentions          (message_id, entity_id, ...)
 *   - message_facet_mentions           (message_id, facet_id, ...)
 *   - entity_bridge_message_index      (message_id, entity_count, facet_count, status, ...)
 *
 * The store is created on-demand. If the v12 tables are absent (older DB),
 * `tablesExist()` returns false and all writes/reads are no-ops/empty.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { EntityFacetMentions } from './entity-extractor.js';
export interface BridgeIndexState {
    exists: boolean;
    status?: string;
    source?: string;
    entityCount?: number;
    facetCount?: number;
    indexedAt?: string;
    lastError?: string | null;
}
export interface BridgeWatermarkDiagnostics {
    totalMessages: number;
    indexedMessages: number;
    failedMessages: number;
    zeroMentionMessages: number;
    highestIndexedMessageId: number | null;
}
export interface BridgeCandidateMessage {
    messageId: number;
    threadRef: number | null;
    matchedEntities: string[];
    matchedFacets: string[];
}
export interface BridgeGraphNeighbor {
    /** Entity or grace key. */
    key: string;
    /** Edge weight (mention count or co-occurrence count). */
    weight: number;
}
export interface BridgeGraphSnapshot {
    /** Map of entityKey -> messageIds[] (capped). */
    entityMessages: Map<string, number[]>;
    /** Map of facetKey -> messageIds[] (capped). */
    facetMessages: Map<string, number[]>;
    /** Map of messageId -> entity keys. */
    messageEntities: Map<number, string[]>;
    /** Map of messageId -> grace keys. */
    messageFacets: Map<number, string[]>;
    /** Diagnostics on cap behavior. */
    diagnostics: {
        nodeCount: number;
        edgeCount: number;
        seedExpanded: number;
        nodesCapped: boolean;
        edgesCapped: boolean;
    };
}
export declare class EntityBridgeStore {
    private readonly db;
    private _tablesChecked;
    private _tablesExist;
    private _stmtUpsertEntity?;
    private _stmtTouchEntity?;
    private _stmtUpsertFacet?;
    private _stmtTouchFacet?;
    private _stmtInsertEntityMention?;
    private _stmtInsertFacetMention?;
    private _stmtUpsertIndex?;
    private _stmtGetIndex?;
    constructor(db: DatabaseSync);
    /**
     * Check whether all v12 bridge tables exist in this DB.
     * Cached after the first call. Cheap when cached.
     */
    tablesExist(): boolean;
    getIndexState(messageId: number): BridgeIndexState;
    /**
     * Watermark diagnostics: counts of indexed/failed/zero-mention messages
     * and the highest indexed message id, scoped to a single agent.
     */
    getWatermarkDiagnostics(agentId: string): BridgeWatermarkDiagnostics;
    /**
     * Record entity/grace mentions for a single message. Always writes a
     * row into `entity_bridge_message_index` even when there are zero mentions
     * so that callers can distinguish "never indexed" from "indexed, no mentions".
     *
     * Wraps all writes in a single transaction. Returns whether any write
     * occurred. On failure, records a 'failed' index row when possible and
     * rethrows the underlying error so the caller can decide whether to surface.
     */
    recordMentions(input: {
        messageId: number;
        agentId: string;
        threadRef?: number | null;
        mentions: EntityFacetMentions;
        source?: 'live' | 'backfill';
    }): {
        wrote: boolean;
        entityCount: number;
        facetCount: number;
    };
    /**
     * Emit a metadata-only failure marker without attempting any mention writes.
     * Used by callers (e.g. message-store live indexing) when extraction itself
     * threw before reaching the store, or to record an index attempt that never
     * produced mentions due to disabled tables.
     */
    recordIndexFailure(input: {
        messageId: number;
        agentId: string;
        threadRef?: number | null;
        error: unknown;
        source?: 'live' | 'backfill';
    }): boolean;
    private recordIndexFailureEvent;
    /**
     * Look up the internal entity rows for a list of normalized entity keys.
     * Missing keys are silently dropped.
     */
    lookupEntityIds(agentId: string, keys: string[]): Map<string, number>;
    lookupFacetIds(agentId: string, keys: string[]): Map<string, number>;
    /**
     * Build a metadata-only graph snapshot for PPR. Bounded by node/edge caps.
     *
     * Algorithm:
     *  - Resolve seed entity/grace keys to internal ids.
     *  - For each seed, fetch up to `perSeedMessageLimit` mention rows.
     *  - Aggregate into message \u2194 entity \u2194 grace adjacency lists, capped.
     */
    buildGraphSnapshot(opts: {
        agentId: string;
        seedEntityKeys: string[];
        seedFacetKeys: string[];
        maxNodes: number;
        maxEdges: number;
        perSeedMessageLimit: number;
    }): BridgeGraphSnapshot;
    /**
     * Resolve a list of message ids into candidate rows joined back to
     * `messages` for compose-lane consumption. Returns the matched entity/grace
     * keys per message as a side-channel diagnostic.
     *
     * Caller is expected to gate further rendering on whether a message's
     * full text should be hydrated.
     */
    fetchCandidates(opts: {
        agentId: string;
        messageIds: number[];
    }): BridgeCandidateMessage[];
    private ensureUpsertStmts;
    private upsertEntityRow;
    private upsertFacetRow;
}
//# sourceMappingURL=entity-bridge-store.d.ts.map