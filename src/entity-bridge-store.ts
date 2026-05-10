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

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { EntityMention, FacetMention, EntityFacetMentions } from './entity-extractor.js';

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

const REQUIRED_TABLES = [
  'memory_entities',
  'memory_facets',
  'message_entity_mentions',
  'message_facet_mentions',
  'entity_bridge_message_index',
];

function nowIso(): string {
  return new Date().toISOString();
}

export class EntityBridgeStore {
  private _tablesChecked = false;
  private _tablesExist = false;

  // Lazy prepared statements. Only created when tables exist.
  private _stmtUpsertEntity?: StatementSync;
  private _stmtTouchEntity?: StatementSync;
  private _stmtUpsertFacet?: StatementSync;
  private _stmtTouchFacet?: StatementSync;
  private _stmtInsertEntityMention?: StatementSync;
  private _stmtInsertFacetMention?: StatementSync;
  private _stmtUpsertIndex?: StatementSync;
  private _stmtGetIndex?: StatementSync;

  constructor(private readonly db: DatabaseSync) {}

  /**
   * Check whether all v12 bridge tables exist in this DB.
   * Cached after the first call. Cheap when cached.
   */
  tablesExist(): boolean {
    if (this._tablesChecked) return this._tablesExist;
    this._tablesChecked = true;
    try {
      const stmt = this.db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(() => '?').join(',')})`,
      );
      const rows = stmt.all(...REQUIRED_TABLES) as Array<{ name: string }>;
      this._tablesExist = rows.length === REQUIRED_TABLES.length;
    } catch {
      this._tablesExist = false;
    }
    return this._tablesExist;
  }

  // \u2500\u2500 Index state queries \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  getIndexState(messageId: number): BridgeIndexState {
    if (!this.tablesExist()) return { exists: false };
    if (!this._stmtGetIndex) {
      this._stmtGetIndex = this.db.prepare(
        'SELECT entity_count, facet_count, indexed_at, source, status, last_error FROM entity_bridge_message_index WHERE message_id = ?',
      );
    }
    const row = this._stmtGetIndex.get(messageId) as
      | { entity_count: number; facet_count: number; indexed_at: string; source: string; status: string; last_error: string | null }
      | undefined;
    if (!row) return { exists: false };
    return {
      exists: true,
      status: row.status,
      source: row.source,
      entityCount: row.entity_count,
      facetCount: row.facet_count,
      indexedAt: row.indexed_at,
      lastError: row.last_error,
    };
  }

  /**
   * Watermark diagnostics: counts of indexed/failed/zero-mention messages
   * and the highest indexed message id, scoped to a single agent.
   */
  getWatermarkDiagnostics(agentId: string): BridgeWatermarkDiagnostics {
    const empty: BridgeWatermarkDiagnostics = {
      totalMessages: 0,
      indexedMessages: 0,
      failedMessages: 0,
      zeroMentionMessages: 0,
      highestIndexedMessageId: null,
    };
    if (!this.tablesExist()) return empty;
    try {
      const total = (this.db.prepare(
        'SELECT COUNT(*) AS c FROM messages WHERE agent_id = ?',
      ).get(agentId) as { c: number } | undefined)?.c ?? 0;
      const indexedRow = this.db.prepare(
        `SELECT COUNT(*) AS c, MAX(message_id) AS hi
         FROM entity_bridge_message_index
         WHERE agent_id = ? AND status = 'ok'`,
      ).get(agentId) as { c: number; hi: number | null } | undefined;
      const failed = (this.db.prepare(
        `SELECT COUNT(*) AS c FROM entity_bridge_message_index
         WHERE agent_id = ? AND status != 'ok'`,
      ).get(agentId) as { c: number } | undefined)?.c ?? 0;
      const zero = (this.db.prepare(
        `SELECT COUNT(*) AS c FROM entity_bridge_message_index
         WHERE agent_id = ? AND status = 'ok' AND entity_count = 0 AND facet_count = 0`,
      ).get(agentId) as { c: number } | undefined)?.c ?? 0;
      return {
        totalMessages: total,
        indexedMessages: indexedRow?.c ?? 0,
        failedMessages: failed,
        zeroMentionMessages: zero,
        highestIndexedMessageId: indexedRow?.hi ?? null,
      };
    } catch {
      return empty;
    }
  }

  // \u2500\u2500 Mention writes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
  }): { wrote: boolean; entityCount: number; facetCount: number } {
    if (!this.tablesExist()) return { wrote: false, entityCount: 0, facetCount: 0 };
    const source = input.source ?? 'live';
    const ts = nowIso();
    const begin = this.db.prepare('BEGIN');
    const commit = this.db.prepare('COMMIT');
    const rollback = this.db.prepare('ROLLBACK');

    begin.run();
    try {
      this.ensureUpsertStmts();
      const entityIds = new Map<string, number>();
      for (const ent of input.mentions.entities) {
        const id = this.upsertEntityRow(input.agentId, ent, ts);
        if (id != null) {
          entityIds.set(ent.key, id);
          this._stmtInsertEntityMention!.run(
            input.messageId,
            id,
            input.agentId,
            input.threadRef ?? null,
            ent.surface,
            ent.start,
            ent.end,
            ts,
          );
        }
      }
      const facetIds = new Map<string, number>();
      for (const fac of input.mentions.facets) {
        const id = this.upsertFacetRow(input.agentId, fac, ts);
        if (id != null) {
          facetIds.set(fac.key, id);
          this._stmtInsertFacetMention!.run(
            input.messageId,
            id,
            input.agentId,
            input.threadRef ?? null,
            fac.term,
            fac.start,
            fac.end,
            ts,
          );
        }
      }
      this._stmtUpsertIndex!.run(
        input.messageId,
        input.agentId,
        input.threadRef ?? null,
        entityIds.size,
        facetIds.size,
        ts,
        source,
        'ok',
        null,
      );
      commit.run();
      return { wrote: true, entityCount: entityIds.size, facetCount: facetIds.size };
    } catch (err) {
      try { rollback.run(); } catch { /* swallow */ }
      // Best-effort failure marker. Use a separate transaction so the
      // failure record itself does not get rolled back.
      try {
        this.ensureUpsertStmts();
        this._stmtUpsertIndex!.run(
          input.messageId,
          input.agentId,
          input.threadRef ?? null,
          0,
          0,
          ts,
          source,
          'failed',
          summarizeError(err),
        );
        this.recordIndexFailureEvent(input.messageId, input.agentId, source, err, ts);
      } catch { /* swallow */ }
      throw err;
    }
  }

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
  }): boolean {
    if (!this.tablesExist()) return false;
    const ts = nowIso();
    try {
      this.ensureUpsertStmts();
      const source = input.source ?? 'live';
      this._stmtUpsertIndex!.run(
        input.messageId,
        input.agentId,
        input.threadRef ?? null,
        0,
        0,
        ts,
        source,
        'failed',
        summarizeError(input.error),
      );
      this.recordIndexFailureEvent(input.messageId, input.agentId, source, input.error, ts);
      return true;
    } catch {
      return false;
    }
  }

  private recordIndexFailureEvent(
    messageId: number,
    agentId: string,
    source: 'live' | 'backfill',
    error: unknown,
    ts: string,
  ): void {
    try {
      this.db.prepare(
        `INSERT INTO index_events (agent_id, event_type, target_table, target_id, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        agentId,
        'entity_bridge_index_failed',
        'messages',
        messageId,
        JSON.stringify({ source, error_class: errorClass(error) }),
        ts,
      );
    } catch {
      // Failure telemetry is best-effort; never let it affect message writes.
    }
  }

  // \u2500\u2500 Candidate / graph reads (used by PPR lane) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  /**
   * Look up the internal entity rows for a list of normalized entity keys.
   * Missing keys are silently dropped.
   */
  lookupEntityIds(agentId: string, keys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!this.tablesExist() || keys.length === 0) return out;
    const placeholders = keys.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, entity_key FROM memory_entities WHERE agent_id = ? AND entity_key IN (${placeholders})`,
    ).all(agentId, ...keys) as Array<{ id: number; entity_key: string }>;
    for (const r of rows) out.set(r.entity_key, r.id);
    return out;
  }

  lookupFacetIds(agentId: string, keys: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (!this.tablesExist() || keys.length === 0) return out;
    const placeholders = keys.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, facet_key FROM memory_facets WHERE agent_id = ? AND facet_key IN (${placeholders})`,
    ).all(agentId, ...keys) as Array<{ id: number; facet_key: string }>;
    for (const r of rows) out.set(r.facet_key, r.id);
    return out;
  }

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
  }): BridgeGraphSnapshot {
    const empty: BridgeGraphSnapshot = {
      entityMessages: new Map(),
      facetMessages: new Map(),
      messageEntities: new Map(),
      messageFacets: new Map(),
      diagnostics: { nodeCount: 0, edgeCount: 0, seedExpanded: 0, nodesCapped: false, edgesCapped: false },
    };
    if (!this.tablesExist()) return empty;
    if (opts.seedEntityKeys.length === 0 && opts.seedFacetKeys.length === 0) return empty;

    const entityIds = this.lookupEntityIds(opts.agentId, opts.seedEntityKeys);
    const facetIds = this.lookupFacetIds(opts.agentId, opts.seedFacetKeys);
    if (entityIds.size === 0 && facetIds.size === 0) return empty;

    const entityMessages = new Map<string, number[]>();
    const facetMessages = new Map<string, number[]>();
    const messageIds = new Set<number>();
    let edgeCount = 0;
    let nodesCapped = false;
    let edgesCapped = false;
    let seedExpanded = 0;

    const perSeed = Math.max(1, Math.min(2000, opts.perSeedMessageLimit));

    // 1) Pull message ids per seed entity.
    for (const [key, id] of entityIds) {
      if (edgeCount >= opts.maxEdges) { edgesCapped = true; break; }
      const rows = this.db.prepare(
        `SELECT message_id FROM message_entity_mentions
         WHERE agent_id = ? AND entity_id = ?
         ORDER BY id DESC LIMIT ?`,
      ).all(opts.agentId, id, perSeed) as Array<{ message_id: number }>;
      const ids = rows.map(r => r.message_id);
      entityMessages.set(key, ids);
      seedExpanded++;
      for (const mid of ids) {
        messageIds.add(mid);
        edgeCount++;
        if (messageIds.size >= opts.maxNodes) { nodesCapped = true; break; }
        if (edgeCount >= opts.maxEdges) { edgesCapped = true; break; }
      }
      if (nodesCapped || edgesCapped) break;
    }

    // 2) Pull message ids per seed grace.
    if (!nodesCapped && !edgesCapped) {
      for (const [key, id] of facetIds) {
        if (edgeCount >= opts.maxEdges) { edgesCapped = true; break; }
        const rows = this.db.prepare(
          `SELECT message_id FROM message_facet_mentions
           WHERE agent_id = ? AND facet_id = ?
           ORDER BY id DESC LIMIT ?`,
        ).all(opts.agentId, id, perSeed) as Array<{ message_id: number }>;
        const ids = rows.map(r => r.message_id);
        facetMessages.set(key, ids);
        seedExpanded++;
        for (const mid of ids) {
          messageIds.add(mid);
          edgeCount++;
          if (messageIds.size >= opts.maxNodes) { nodesCapped = true; break; }
          if (edgeCount >= opts.maxEdges) { edgesCapped = true; break; }
        }
        if (nodesCapped || edgesCapped) break;
      }
    }

    // 3) For all messages collected, fetch all entity/grace adjacencies.
    const messageEntities = new Map<number, string[]>();
    const messageFacets = new Map<number, string[]>();
    if (messageIds.size > 0) {
      const idList = [...messageIds];
      const placeholders = idList.map(() => '?').join(',');
      const entRows = this.db.prepare(
        `SELECT m.message_id, e.entity_key
         FROM message_entity_mentions m
         JOIN memory_entities e ON e.id = m.entity_id
         WHERE m.agent_id = ? AND m.message_id IN (${placeholders})`,
      ).all(opts.agentId, ...idList) as Array<{ message_id: number; entity_key: string }>;
      for (const r of entRows) {
        if (edgeCount >= opts.maxEdges) { edgesCapped = true; break; }
        const list = messageEntities.get(r.message_id) ?? [];
        if (!list.includes(r.entity_key)) {
          list.push(r.entity_key);
          edgeCount++;
        }
        messageEntities.set(r.message_id, list);
      }
      if (!edgesCapped) {
        const facRows = this.db.prepare(
          `SELECT m.message_id, f.facet_key
           FROM message_facet_mentions m
           JOIN memory_facets f ON f.id = m.facet_id
           WHERE m.agent_id = ? AND m.message_id IN (${placeholders})`,
        ).all(opts.agentId, ...idList) as Array<{ message_id: number; facet_key: string }>;
        for (const r of facRows) {
          if (edgeCount >= opts.maxEdges) { edgesCapped = true; break; }
          const list = messageFacets.get(r.message_id) ?? [];
          if (!list.includes(r.facet_key)) {
            list.push(r.facet_key);
            edgeCount++;
          }
          messageFacets.set(r.message_id, list);
        }
      }
    }

    return {
      entityMessages,
      facetMessages,
      messageEntities,
      messageFacets,
      diagnostics: {
        nodeCount: messageIds.size + entityMessages.size + facetMessages.size,
        edgeCount,
        seedExpanded,
        nodesCapped,
        edgesCapped,
      },
    };
  }

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
  }): BridgeCandidateMessage[] {
    if (!this.tablesExist() || opts.messageIds.length === 0) return [];
    const placeholders = opts.messageIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id, conversation_id FROM messages WHERE agent_id = ? AND id IN (${placeholders})`,
    ).all(opts.agentId, ...opts.messageIds) as Array<{ id: number; conversation_id: number | null }>;
    const meta = new Map<number, { threadRef: number | null }>();
    for (const r of rows) meta.set(r.id, { threadRef: r.conversation_id });

    const entByMsg = new Map<number, string[]>();
    const facByMsg = new Map<number, string[]>();
    const entRows = this.db.prepare(
      `SELECT m.message_id, e.entity_key
       FROM message_entity_mentions m JOIN memory_entities e ON e.id = m.entity_id
       WHERE m.agent_id = ? AND m.message_id IN (${placeholders})`,
    ).all(opts.agentId, ...opts.messageIds) as Array<{ message_id: number; entity_key: string }>;
    for (const r of entRows) {
      const list = entByMsg.get(r.message_id) ?? [];
      if (!list.includes(r.entity_key)) list.push(r.entity_key);
      entByMsg.set(r.message_id, list);
    }
    const facRows = this.db.prepare(
      `SELECT m.message_id, f.facet_key
       FROM message_facet_mentions m JOIN memory_facets f ON f.id = m.facet_id
       WHERE m.agent_id = ? AND m.message_id IN (${placeholders})`,
    ).all(opts.agentId, ...opts.messageIds) as Array<{ message_id: number; facet_key: string }>;
    for (const r of facRows) {
      const list = facByMsg.get(r.message_id) ?? [];
      if (!list.includes(r.facet_key)) list.push(r.facet_key);
      facByMsg.set(r.message_id, list);
    }

    const out: BridgeCandidateMessage[] = [];
    for (const id of opts.messageIds) {
      const m = meta.get(id);
      if (!m) continue;
      out.push({
        messageId: id,
        threadRef: m.threadRef,
        matchedEntities: entByMsg.get(id) ?? [],
        matchedFacets: facByMsg.get(id) ?? [],
      });
    }
    return out;
  }

  // \u2500\u2500 Internals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

  private ensureUpsertStmts(): void {
    if (this._stmtUpsertEntity) return;
    this._stmtUpsertEntity = this.db.prepare(
      `INSERT INTO memory_entities (agent_id, entity_key, display_name, first_seen_at, last_seen_at, mention_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(agent_id, entity_key) DO UPDATE SET
         display_name = COALESCE(memory_entities.display_name, excluded.display_name),
         last_seen_at = excluded.last_seen_at,
         mention_count = memory_entities.mention_count + 1`,
    );
    this._stmtTouchEntity = this.db.prepare(
      'SELECT id FROM memory_entities WHERE agent_id = ? AND entity_key = ?',
    );
    this._stmtUpsertFacet = this.db.prepare(
      `INSERT INTO memory_facets (agent_id, facet_key, first_seen_at, last_seen_at, mention_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(agent_id, facet_key) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         mention_count = memory_facets.mention_count + 1`,
    );
    this._stmtTouchFacet = this.db.prepare(
      'SELECT id FROM memory_facets WHERE agent_id = ? AND facet_key = ?',
    );
    this._stmtInsertEntityMention = this.db.prepare(
      `INSERT INTO message_entity_mentions
        (message_id, entity_id, agent_id, conversation_id, match_term, start_offset, end_offset, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this._stmtInsertFacetMention = this.db.prepare(
      `INSERT INTO message_facet_mentions
        (message_id, facet_id, agent_id, conversation_id, match_term, start_offset, end_offset, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this._stmtUpsertIndex = this.db.prepare(
      `INSERT INTO entity_bridge_message_index
        (message_id, agent_id, conversation_id, entity_count, facet_count, indexed_at, source, status, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         entity_count = excluded.entity_count,
         facet_count = excluded.facet_count,
         indexed_at = excluded.indexed_at,
         source = excluded.source,
         status = excluded.status,
         last_error = excluded.last_error`,
    );
  }

  private upsertEntityRow(agentId: string, mention: EntityMention, ts: string): number | null {
    this._stmtUpsertEntity!.run(agentId, mention.key, mention.surface, ts, ts);
    const row = this._stmtTouchEntity!.get(agentId, mention.key) as { id: number } | undefined;
    return row?.id ?? null;
  }

  private upsertFacetRow(agentId: string, mention: FacetMention, ts: string): number | null {
    this._stmtUpsertFacet!.run(agentId, mention.key, ts, ts);
    const row = this._stmtTouchFacet!.get(agentId, mention.key) as { id: number } | undefined;
    return row?.id ?? null;
  }
}

function errorClass(err: unknown): string {
  if (err instanceof Error) return err.name || 'Error';
  return typeof err || 'unknown';
}

function summarizeError(err: unknown): string {
  if (!err) return 'unknown';
  if (err instanceof Error) {
    // Cap length so we never bloat the index row.
    return (err.message || err.name || 'error').slice(0, 200);
  }
  try {
    return String(err).slice(0, 200);
  } catch {
    return 'error';
  }
}
