/**
 * entity-bridge-backfill.ts \u2014 Sprint B
 *
 * operator-run backfill for the entity/grace bridge index.
 *
 * Constraints (Sprint B planner):
 *   - Never runs at startup.
 *   - Only ever invoked through scripts/backfill-entity-bridge.mjs.
 *   - Counts only \u2014 never logs message content.
 *
 * Usage (from script):
 *   const summary = await runEntityBridgeBackfill(db, {
 *     agentId: 'forge',
 *     batchSize: 200,
 *     limit: 5000,
 *     dryRun: false,
 *     resume: true,
 *     sinceMessageId: 12345,
 *     reconcile: false,
 *   });
 */
import { EntityBridgeStore } from './entity-bridge-store.js';
import { extractEntityFacetMentions } from './entity-extractor.js';
/**
 * Run the backfill. Returns a counts-only summary suitable for logging.
 *
 * On any per-message extraction error we record a 'failed' index row (when
 * not in dry-run mode) and continue. The whole run never throws unless the
 * DB itself is broken.
 */
export async function runEntityBridgeBackfill(db, opts = {}) {
    const start = Date.now();
    const batchSize = Math.max(1, Math.min(5000, opts.batchSize ?? 200));
    const limit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
    const dryRun = Boolean(opts.dryRun);
    const reconcile = Boolean(opts.reconcile);
    const resume = opts.resume ?? !reconcile;
    const sinceMessageId = opts.sinceMessageId ?? 0;
    const agentId = opts.agentId;
    const store = new EntityBridgeStore(db);
    const tablesPresent = store.tablesExist();
    const progress = {
        scanned: 0,
        written: 0,
        skipped: 0,
        failed: 0,
        zeroMention: 0,
        highestMessageId: null,
    };
    if (!tablesPresent) {
        return {
            ...progress,
            dryRun,
            reconcile,
            agentId,
            durationMs: Date.now() - start,
            bridgeTablesPresent: false,
        };
    }
    let cursor = sinceMessageId;
    let remaining = limit;
    // SQL: select messages above cursor in batches, optionally filtered by agent.
    // We deliberately use COALESCE(text_content,'') length>0 so we don't index
    // pure tool/heartbeat rows.
    const baseSelect = `
    SELECT m.id, m.conversation_id, m.agent_id, m.text_content
    FROM messages m
    ${reconcile ? '' : 'LEFT JOIN entity_bridge_message_index idx ON idx.message_id = m.id'}
    WHERE m.id > ?
      AND COALESCE(m.text_content, '') != ''
      AND m.is_heartbeat = 0
      ${agentId ? 'AND m.agent_id = ?' : ''}
      ${resume && !reconcile ? 'AND idx.message_id IS NULL' : ''}
    ORDER BY m.id ASC
    LIMIT ?
  `;
    const stmt = db.prepare(baseSelect);
    while (remaining > 0) {
        const fetch = Math.min(batchSize, remaining);
        const params = [cursor];
        if (agentId)
            params.push(agentId);
        params.push(fetch);
        const rows = stmt.all(...params);
        if (rows.length === 0)
            break;
        for (const row of rows) {
            progress.scanned++;
            cursor = row.id;
            progress.highestMessageId = row.id;
            try {
                const mentions = extractEntityFacetMentions(row.text_content);
                if (dryRun) {
                    if (mentions.entities.length === 0 && mentions.facets.length === 0) {
                        progress.zeroMention++;
                    }
                    else {
                        progress.written++;
                    }
                }
                else {
                    const r = store.recordMentions({
                        messageId: row.id,
                        agentId: row.agent_id,
                        threadRef: row.conversation_id,
                        mentions,
                        source: 'backfill',
                    });
                    if (r.entityCount === 0 && r.facetCount === 0) {
                        progress.zeroMention++;
                    }
                    else {
                        progress.written++;
                    }
                }
            }
            catch (err) {
                progress.failed++;
                if (!dryRun) {
                    store.recordIndexFailure({
                        messageId: row.id,
                        agentId: row.agent_id,
                        threadRef: row.conversation_id,
                        error: err,
                        source: 'backfill',
                    });
                }
            }
        }
        remaining -= rows.length;
        if (opts.onProgress)
            opts.onProgress({ ...progress });
        if (rows.length < fetch)
            break;
    }
    return {
        ...progress,
        dryRun,
        reconcile,
        agentId,
        durationMs: Date.now() - start,
        bridgeTablesPresent: true,
    };
}
//# sourceMappingURL=entity-bridge-backfill.js.map