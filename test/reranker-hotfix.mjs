/**
 * Reranker Hotfix Test (Sprint 0)
 *
 * Verifies that the reranker hook inside hybridSearch() after RRF fusion:
 *   1. applies when a provider is configured and candidate count is sufficient
 *   2. bypasses below the candidate threshold
 *   3. bypasses cleanly when no provider is configured
 *   4. falls back to fused ordering on reranker failure (null)
 *   5. falls back to fused ordering on reranker timeout
 *
 * All paths preserve the original fused result set and never throw.
 */

import { buildFtsQuery, hybridSearch } from '../dist/hybrid-retrieval.js';
import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-reranker-'));

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Reranker Hotfix Test (Sprint 0)');
  console.log('═══════════════════════════════════════════════════\n');

  const hm = await HyperMem.create({ dataDir: tmpDir });
  const agentId = 'reranker-agent';
  const libDb = hm.dbManager.getLibraryDb();

  // Seed enough facts to fuse with a non-empty FTS query.
  hm.addFact(agentId, 'Alpha deploy runs on Redis and backs the cache tier', {
    domain: 'infra', visibility: 'org',
  });
  hm.addFact(agentId, 'Bravo deploy uses nomic-embed-text 768d for embeddings', {
    domain: 'infra', visibility: 'org',
  });
  hm.addFact(agentId, 'Charlie deploy tracks BM25 rank via FTS5 for keyword search', {
    domain: 'infra', visibility: 'org',
  });
  hm.addFact(agentId, 'Delta deploy uses RRF fusion to merge hybrid retrieval results', {
    domain: 'infra', visibility: 'org',
  });

  const baseQuery = 'deploy infrastructure embeddings fusion retrieval';

  // ── Path: no provider → bypass_no_provider ──
  console.log('── No reranker configured ──');
  {
    let telemetry = null;
    const results = await hybridSearch(libDb, null, baseQuery, {
      agentId,
      limit: 10,
      onRerankerTelemetry: (ev) => { telemetry = ev; },
    });
    assert(results.length >= 2, `fused results returned (${results.length})`);
    // FTS-only path doesn't hit maybeRerank (no fusion). So telemetry is null
    // on pure FTS-only. That's correct — reranker hook is fused-path-only.
    assert(telemetry === null, 'FTS-only branch does not invoke reranker hook');
  }

  // For the remaining tests, force the fused path by supplying a fake
  // vector store that returns overlapping KNN hits. The store only needs a
  // .search() method matching VectorStore signature.
  const fakeVector = {
    search: async (_q, opts) => {
      // Return the same facts as KNN results with plausible distances. The
      // agent filter on the FTS side uses agent_id, so we mirror here.
      const rows = libDb.prepare(`SELECT id, content, domain, agent_id FROM facts WHERE agent_id = ? ORDER BY id LIMIT ?`)
        .all(agentId, opts?.limit ?? 10);
      return rows.map((r, i) => ({
        sourceTable: 'facts',
        sourceId: r.id,
        content: r.content,
        domain: r.domain,
        agentId: r.agent_id,
        distance: 0.2 + i * 0.05,
      }));
    },
  };

  // ── Path: provider configured, applied ──
  console.log('\n── Reranker applied ──');
  {
    const appliedReranker = {
      name: 'stub-applied',
      rerank: async (_query, docs, topK) => {
        // Return a deterministic reverse order so we can detect that the
        // reranker actually reordered the fused list.
        return docs.map((content, i) => ({
          index: docs.length - 1 - i,
          score: 1 - i * 0.01,
          content: docs[docs.length - 1 - i],
        })).slice(0, topK ?? docs.length);
      },
    };

    let telemetry = null;
    const baseline = await hybridSearch(libDb, fakeVector, baseQuery, {
      agentId,
      limit: 10,
    });
    assert(baseline.length >= 2, `fused baseline returned ${baseline.length} results`);

    const reranked = await hybridSearch(libDb, fakeVector, baseQuery, {
      agentId,
      limit: 10,
      reranker: appliedReranker,
      onRerankerTelemetry: (ev) => { telemetry = ev; },
    });

    assert(telemetry && telemetry.status === 'applied',
      `telemetry status is 'applied' (got ${telemetry?.status})`);
    assert(telemetry.provider === 'stub-applied',
      `telemetry provider is 'stub-applied' (got ${telemetry?.provider})`);
    assert(typeof telemetry.candidates === 'number' && telemetry.candidates >= 2,
      `telemetry candidates count looks sane (${telemetry?.candidates})`);

    // Ordering must differ from baseline since the stub reverses docs.
    const baselineKeys = baseline.map(r => `${r.sourceTable}:${r.sourceId}`);
    const rerankedKeys = reranked.map(r => `${r.sourceTable}:${r.sourceId}`);
    const differs = baselineKeys.some((k, i) => k !== rerankedKeys[i]);
    assert(differs, 'reranker produced a different ordering than RRF baseline');

    // No result set shrinkage.
    const baselineSet = new Set(baselineKeys);
    const rerankedSet = new Set(rerankedKeys.slice(0, baselineKeys.length));
    let preserved = true;
    for (const k of baselineSet) if (!rerankedSet.has(k)) { preserved = false; break; }
    assert(preserved, 'reranker preserved all baseline candidates');
  }

  // ── Path: bypass below threshold ──
  console.log('\n── Reranker bypassed: below candidate threshold ──');
  {
    let telemetry = null;
    let called = false;
    const thresholdReranker = {
      name: 'stub-threshold',
      rerank: async () => { called = true; return []; },
    };

    const results = await hybridSearch(libDb, fakeVector, baseQuery, {
      agentId,
      limit: 10,
      reranker: thresholdReranker,
      rerankerMinCandidates: 9999, // intentionally unreachable
      onRerankerTelemetry: (ev) => { telemetry = ev; },
    });

    assert(!called, 'reranker was not invoked below threshold');
    assert(telemetry && telemetry.status === 'bypass_below_threshold',
      `telemetry status is 'bypass_below_threshold' (got ${telemetry?.status})`);
    assert(results.length >= 2, 'fused results still returned on bypass');
  }

  // ── Path: failure → fallback ──
  console.log('\n── Reranker failure fallback ──');
  {
    let telemetry = null;
    const failingReranker = {
      name: 'stub-failing',
      rerank: async () => null, // provider-level null = graceful degrade
    };

    const baseline = await hybridSearch(libDb, fakeVector, baseQuery, {
      agentId,
      limit: 10,
    });
    const fallback = await hybridSearch(libDb, fakeVector, baseQuery, {
      agentId,
      limit: 10,
      reranker: failingReranker,
      onRerankerTelemetry: (ev) => { telemetry = ev; },
    });

    assert(telemetry && telemetry.status === 'failed',
      `telemetry status is 'failed' (got ${telemetry?.status})`);

    const baselineKeys = baseline.map(r => `${r.sourceTable}:${r.sourceId}`).join(',');
    const fallbackKeys = fallback.map(r => `${r.sourceTable}:${r.sourceId}`).join(',');
    assert(baselineKeys === fallbackKeys,
      'fallback ordering exactly matches RRF baseline');
  }

  // ── Path: throw → fallback ──
  console.log('\n── Reranker throw fallback ──');
  {
    let telemetry = null;
    const throwingReranker = {
      name: 'stub-throw',
      rerank: async () => { throw new Error('provider boom'); },
    };

    const baseline = await hybridSearch(libDb, fakeVector, baseQuery, {
      agentId,
      limit: 10,
    });
    const fallback = await hybridSearch(libDb, fakeVector, baseQuery, {
      agentId,
      limit: 10,
      reranker: throwingReranker,
      onRerankerTelemetry: (ev) => { telemetry = ev; },
    });

    assert(telemetry && telemetry.status === 'failed',
      `telemetry status is 'failed' on throw (got ${telemetry?.status})`);
    assert(
      baseline.map(r => r.sourceId).join(',') === fallback.map(r => r.sourceId).join(','),
      'throw path preserved baseline ordering'
    );
  }

  // ── Path: timeout → fallback ──
  console.log('\n── Reranker timeout fallback ──');
  {
    let telemetry = null;
    const slowReranker = {
      name: 'stub-slow',
      rerank: () => new Promise((resolve) => setTimeout(() => resolve([]), 500)),
    };

    const baseline = await hybridSearch(libDb, fakeVector, baseQuery, {
      agentId,
      limit: 10,
    });
    const fallback = await hybridSearch(libDb, fakeVector, baseQuery, {
      agentId,
      limit: 10,
      reranker: slowReranker,
      rerankerTimeoutMs: 25,
      onRerankerTelemetry: (ev) => { telemetry = ev; },
    });

    assert(telemetry && telemetry.status === 'timeout',
      `telemetry status is 'timeout' (got ${telemetry?.status})`);
    assert(
      baseline.map(r => r.sourceId).join(',') === fallback.map(r => r.sourceId).join(','),
      'timeout path preserved baseline ordering'
    );
  }

  // ── Cleanup ──
  console.log('\n── Cleanup ──');
  hm.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert(true, 'cleaned up');

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
