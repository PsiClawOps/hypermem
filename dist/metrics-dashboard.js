/**
 * hypermem Metrics Dashboard
 *
 * Provides a unified surface for observing system health:
 * - Memory counts (facts, pages, episodes, vectors)
 * - Composition performance (avg assembly time, budget utilization)
 * - Ingestion stats (indexer throughput, promotion rate)
 * - Embedding stats (cache hit rate, Ollama availability)
 *
 * All queries are read-only and safe to call on hot DBs.
 */
import { HYPERMEM_COMPAT_VERSION } from './version.js';
function safeQuery(db, sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        return stmt.get(...params);
    }
    catch {
        return null;
    }
}
function safeQueryAll(db, sql, params = []) {
    try {
        const stmt = db.prepare(sql);
        return stmt.all(...params);
    }
    catch {
        return [];
    }
}
function buildAgentFilter(agentIds) {
    if (!agentIds || agentIds.length === 0)
        return { clause: '', params: [] };
    const placeholders = agentIds.map(() => '?').join(', ');
    return { clause: `AND agent_id IN (${placeholders})`, params: agentIds };
}
/**
 * Collect fact metrics from the library DB.
 */
function collectFactMetrics(libraryDb, opts) {
    const { clause, params } = buildAgentFilter(opts.agentIds);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const total = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM facts WHERE 1=1 ${clause}`, params);
    const recent = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM facts WHERE created_at > ? ${clause}`, [cutoff, ...params]);
    const byAgentRows = (opts.includeBreakdowns !== false)
        ? safeQueryAll(libraryDb, `SELECT agent_id, COUNT(*) AS count FROM facts WHERE 1=1 ${clause} GROUP BY agent_id`, params)
        : [];
    return {
        totalFacts: total?.count ?? 0,
        byAgent: Object.fromEntries(byAgentRows.map(r => [r.agent_id, r.count])),
        recentFacts: recent?.count ?? 0,
    };
}
/**
 * Collect doc chunk metrics from the library DB.
 */
function collectDocChunkMetrics(libraryDb, opts) {
    const { clause, params } = buildAgentFilter(opts.agentIds);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const total = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM doc_chunks WHERE 1=1 ${clause}`, params);
    const recent = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM doc_chunks WHERE created_at > ? ${clause}`, [cutoff, ...params]);
    const byCollectionRows = (opts.includeBreakdowns !== false)
        ? safeQueryAll(libraryDb, `SELECT collection, COUNT(*) AS count FROM doc_chunks WHERE 1=1 ${clause} GROUP BY collection`, params)
        : [];
    return {
        totalDocChunks: total?.count ?? 0,
        byCollection: Object.fromEntries(byCollectionRows.map(r => [r.collection, r.count])),
        recentDocChunks: recent?.count ?? 0,
    };
}
/**
 * Collect wiki page metrics from the library DB (knowledge table, topic-synthesis domain).
 */
function collectWikiMetrics(libraryDb, opts) {
    const { clause, params } = buildAgentFilter(opts.agentIds);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const total = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM knowledge WHERE domain = 'topic-synthesis' AND superseded_by IS NULL ${clause}`, params);
    const recent = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM knowledge WHERE domain = 'topic-synthesis' AND superseded_by IS NULL AND created_at > ? ${clause}`, [cutoff, ...params]);
    const oldest = safeQuery(libraryDb, `SELECT created_at FROM knowledge WHERE domain = 'topic-synthesis' AND superseded_by IS NULL ${clause} ORDER BY created_at ASC LIMIT 1`, params);
    const byAgentRows = (opts.includeBreakdowns !== false)
        ? safeQueryAll(libraryDb, `SELECT agent_id, COUNT(*) AS count FROM knowledge WHERE domain = 'topic-synthesis' AND superseded_by IS NULL ${clause} GROUP BY agent_id`, params)
        : [];
    let oldestPageAgeHours = null;
    if (oldest?.created_at) {
        const diffMs = Date.now() - new Date(oldest.created_at).getTime();
        oldestPageAgeHours = Math.round(diffMs / (1000 * 60 * 60));
    }
    return {
        totalPages: total?.count ?? 0,
        byAgent: Object.fromEntries(byAgentRows.map(r => [r.agent_id, r.count])),
        recentPages: recent?.count ?? 0,
        oldestPageAgeHours,
    };
}
/**
 * Collect episode metrics from the library DB.
 */
function collectEpisodeMetrics(libraryDb, opts) {
    const { clause, params } = buildAgentFilter(opts.agentIds);
    const total = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM episodes WHERE 1=1 ${clause}`, params);
    const avgSig = safeQuery(libraryDb, `SELECT AVG(significance) AS avg FROM episodes WHERE significance IS NOT NULL ${clause}`, params);
    const byAgentRows = (opts.includeBreakdowns !== false)
        ? safeQueryAll(libraryDb, `SELECT agent_id, COUNT(*) AS count FROM episodes WHERE 1=1 ${clause} GROUP BY agent_id`, params)
        : [];
    return {
        totalEpisodes: total?.count ?? 0,
        byAgent: Object.fromEntries(byAgentRows.map(r => [r.agent_id, r.count])),
        avgSignificance: avgSig?.avg ?? null,
    };
}
/**
 * Collect vector index metrics from the shared vectors DB.
 */
function collectVectorMetrics(vectorDb) {
    if (!vectorDb) {
        return {
            totalVectors: 0,
            byTable: {},
            cacheHitRate: null,
        };
    }
    const total = safeQuery(vectorDb, 'SELECT COUNT(*) as cnt FROM vec_index_map');
    const byTableRows = safeQueryAll(vectorDb, 'SELECT source_table, COUNT(*) as cnt FROM vec_index_map GROUP BY source_table');
    return {
        totalVectors: total?.cnt ?? 0,
        byTable: Object.fromEntries(byTableRows.map(r => [r.source_table, r.cnt])),
        cacheHitRate: null, // process-lifetime stat, not persisted
    };
}
/**
 * Collect composition performance metrics from the output_metrics table (library DB).
 */
function collectCompositionMetrics(libraryDb, opts) {
    const { clause, params } = buildAgentFilter(opts.agentIds);
    const agg = safeQuery(libraryDb, `SELECT
       AVG(latency_ms) AS avg_latency,
       AVG(output_tokens) AS avg_output,
       AVG(input_tokens) AS avg_input,
       AVG(cache_read_tokens) AS avg_cache,
       COUNT(*) AS total
     FROM output_metrics WHERE 1=1 ${clause.replace(/agent_id/g, 'agent_id')}`, params);
    // p95: sort latency_ms and pick the 95th percentile row
    let p95 = null;
    if ((agg?.total ?? 0) > 0) {
        const p95Row = safeQuery(libraryDb, `SELECT latency_ms FROM output_metrics WHERE latency_ms IS NOT NULL ${clause}
       ORDER BY latency_ms ASC
       LIMIT 1 OFFSET MAX(0, CAST(COUNT(*) * 0.95 AS INT) - 1)`, params);
        // Fallback: approximate p95 with a subquery
        if (!p95Row) {
            const p95Approx = safeQuery(libraryDb, `SELECT latency_ms FROM output_metrics WHERE latency_ms IS NOT NULL ${clause}
         ORDER BY latency_ms DESC
         LIMIT 1 OFFSET (SELECT MAX(0, CAST(COUNT(*) * 0.05 AS INT)) FROM output_metrics WHERE latency_ms IS NOT NULL ${clause})`, [...params, ...params]);
            p95 = p95Approx?.latency_ms ?? null;
        }
        else {
            p95 = p95Row.latency_ms;
        }
    }
    return {
        avgAssemblyMs: agg?.avg_latency ? Math.round(agg.avg_latency) : null,
        p95AssemblyMs: p95 ? Math.round(p95) : null,
        avgOutputTokens: agg?.avg_output ? Math.round(agg.avg_output) : null,
        avgInputTokens: agg?.avg_input ? Math.round(agg.avg_input) : null,
        totalTurns: agg?.total ?? 0,
        avgCacheReadTokens: agg?.avg_cache ? Math.round(agg.avg_cache) : null,
    };
}
/**
 * Collect ingestion pipeline metrics from the library DB.
 */
function collectIngestionMetrics(libraryDb, opts) {
    const { clause, params } = buildAgentFilter(opts.agentIds);
    const facts = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM facts WHERE 1=1 ${clause}`, params);
    const episodes = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM episodes WHERE 1=1 ${clause}`, params);
    const knowledge = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM knowledge WHERE superseded_by IS NULL ${clause}`, params);
    const totalFacts = facts?.count ?? 0;
    const totalEpisodes = episodes?.count ?? 0;
    // Noise rejection: approximate from fact vs message ratio if messages available
    const messages = safeQuery(libraryDb, `SELECT COUNT(*) AS count FROM facts WHERE 1=1 ${clause}`, // placeholder — we'd need message count from main
    params);
    return {
        totalMessagesIndexed: 0, // requires main DB join — surfaced separately
        totalFactsExtracted: totalFacts,
        noiseRejectionRate: null, // requires cross-DB join
        totalEpisodesCreated: totalEpisodes,
        totalKnowledgePromoted: knowledge?.count ?? 0,
    };
}
/**
 * Collect system health from both DBs.
 */
function collectHealth(mainDb, libraryDb, opts) {
    let mainSchemaVersion = null;
    let librarySchemaVersion = null;
    let mainDbOk = false;
    let libraryDbOk = false;
    try {
        const row = safeQuery(mainDb, 'SELECT schema_version FROM _meta LIMIT 1');
        mainSchemaVersion = row?.schema_version ?? null;
        mainDbOk = true;
    }
    catch { /* empty */ }
    try {
        const row = safeQuery(libraryDb, 'SELECT schema_version FROM _library_meta LIMIT 1');
        librarySchemaVersion = row?.schema_version ?? null;
        libraryDbOk = true;
    }
    catch { /* empty */ }
    return {
        mainDbOk,
        libraryDbOk,
        mainSchemaVersion,
        librarySchemaVersion,
        packageVersion: HYPERMEM_COMPAT_VERSION,
        embeddingProvider: opts.embeddingProvider ?? null,
        embeddingModel: opts.embeddingModel ?? null,
        cacheOk: null, // caller must inject cache status
        snapshotAt: new Date().toISOString(),
    };
}
/**
 * Collect all metrics in a single pass.
 * Safe to call on live DBs — all queries are read-only.
 */
export async function collectMetrics(mainDb, libraryDb, opts = {}, vectorDb = null) {
    return {
        facts: collectFactMetrics(libraryDb, opts),
        docChunks: collectDocChunkMetrics(libraryDb, opts),
        wiki: collectWikiMetrics(libraryDb, opts),
        episodes: collectEpisodeMetrics(libraryDb, opts),
        vectors: collectVectorMetrics(vectorDb),
        composition: collectCompositionMetrics(libraryDb, opts),
        ingestion: collectIngestionMetrics(libraryDb, opts),
        health: collectHealth(mainDb, libraryDb, opts),
    };
}
/**
 * Format metrics as a human-readable summary string.
 * Suitable for logging or status replies.
 */
export function formatMetricsSummary(m) {
    const lines = [];
    lines.push(`hypermem ${m.health.packageVersion} — metrics snapshot ${m.health.snapshotAt}`);
    lines.push('');
    lines.push('## Memory');
    lines.push(`  facts:    ${m.facts.totalFacts.toLocaleString()} total, ${m.facts.recentFacts} added last 24h`);
    lines.push(`  doc chunks: ${m.docChunks.totalDocChunks.toLocaleString()} total, ${m.docChunks.recentDocChunks} added last 24h`);
    if (Object.keys(m.docChunks.byCollection).length > 0) {
        for (const [collection, count] of Object.entries(m.docChunks.byCollection)) {
            lines.push(`    ${collection}: ${count.toLocaleString()}`);
        }
    }
    lines.push(`  wiki:     ${m.wiki.totalPages} pages, ${m.wiki.recentPages} synthesized last 24h${m.wiki.oldestPageAgeHours !== null ? `, oldest ${m.wiki.oldestPageAgeHours}h` : ''}`);
    lines.push(`  episodes: ${m.episodes.totalEpisodes.toLocaleString()}${m.episodes.avgSignificance !== null ? `, avg significance ${m.episodes.avgSignificance.toFixed(2)}` : ''}`);
    lines.push(`  vectors:  ${m.vectors.totalVectors.toLocaleString()} indexed`);
    if (Object.keys(m.vectors.byTable).length > 0) {
        for (const [table, count] of Object.entries(m.vectors.byTable)) {
            lines.push(`    ${table}: ${count.toLocaleString()}`);
        }
    }
    lines.push('');
    lines.push('## Embedding');
    lines.push(`  provider: ${m.health.embeddingProvider ?? 'unknown'}`);
    lines.push(`  model:    ${m.health.embeddingModel ?? 'unknown'}`);
    lines.push('');
    lines.push('## Composition');
    if (m.composition.totalTurns > 0) {
        lines.push(`  turns:    ${m.composition.totalTurns.toLocaleString()}`);
        if (m.composition.avgAssemblyMs !== null)
            lines.push(`  avg time: ${m.composition.avgAssemblyMs}ms`);
        if (m.composition.p95AssemblyMs !== null)
            lines.push(`  p95 time: ${m.composition.p95AssemblyMs}ms`);
        if (m.composition.avgOutputTokens !== null)
            lines.push(`  avg out:  ${m.composition.avgOutputTokens} tokens`);
        if (m.composition.avgInputTokens !== null)
            lines.push(`  avg in:   ${m.composition.avgInputTokens} tokens`);
        if (m.composition.avgCacheReadTokens !== null)
            lines.push(`  cache rd: ${m.composition.avgCacheReadTokens} tokens/turn`);
    }
    else {
        lines.push('  no turn data yet');
    }
    lines.push('');
    lines.push('## Ingestion');
    lines.push(`  facts extracted:    ${m.ingestion.totalFactsExtracted.toLocaleString()}`);
    lines.push(`  episodes created:   ${m.ingestion.totalEpisodesCreated.toLocaleString()}`);
    lines.push(`  knowledge promoted: ${m.ingestion.totalKnowledgePromoted.toLocaleString()}`);
    lines.push('');
    lines.push('## Health');
    lines.push(`  embedding: ${m.health.embeddingProvider ?? 'unknown'}${m.health.embeddingModel ? ` / ${m.health.embeddingModel}` : ''}`);
    lines.push(`  main db:    ${m.health.mainDbOk ? '✅' : '❌'}${m.health.mainSchemaVersion !== null ? ` (schema v${m.health.mainSchemaVersion})` : ''}`);
    lines.push(`  library db: ${m.health.libraryDbOk ? '✅' : '❌'}${m.health.librarySchemaVersion !== null ? ` (schema v${m.health.librarySchemaVersion})` : ''}`);
    if (m.health.cacheOk !== null) {
        lines.push(`  cache:      ${m.health.cacheOk ? '✅' : '❌'}`);
    }
    return lines.join('\n');
}
//# sourceMappingURL=metrics-dashboard.js.map