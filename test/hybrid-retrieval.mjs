/**
 * Hybrid Retrieval Test
 *
 * Tests FTS5+KNN fusion, FTS-only fallback, KNN-only fallback,
 * deduplication, and score ranking.
 */

import { buildFtsQuery, hybridSearch } from '../dist/hybrid-retrieval.js';
import { HyperMem } from '../dist/index.js';
import { VectorStore } from '../dist/vector-store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-hybrid-'));

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Hybrid Retrieval Test');
  console.log('═══════════════════════════════════════════════════\n');

  // ── FTS Query Builder ──
  console.log('── FTS Query Builder ──');

  assert(
    buildFtsQuery('What is the deployment status?') !== '',
    'Generates query from normal text'
  );

  assert(
    buildFtsQuery('the is a an') === '',
    'Returns empty for all stop words'
  );

  assert(
    buildFtsQuery('HyperMem Redis compositor') !== '',
    'Handles technical terms'
  );

  const query1 = buildFtsQuery('What is the HyperMem deployment architecture?');
  assert(
    query1.includes('OR'),
    'Uses OR conjunction between terms'
  );
  assert(
    query1.includes('*'),
    'Uses prefix matching'
  );
  assert(
    !query1.includes('"the"'),
    'Excludes stop words'
  );
  assert(
    !query1.includes('"is"'),
    'Excludes stop words (is)'
  );

  // Deduplication
  const query2 = buildFtsQuery('deploy deploy deploy status');
  const terms = query2.split(' OR ');
  const unique = new Set(terms);
  assert(
    unique.size === terms.length,
    'Deduplicates repeated terms'
  );

  // Length limit
  const longQuery = buildFtsQuery(
    'infrastructure deployment architecture reliability scaling monitoring observability performance latency throughput availability redundancy failover recovery'
  );
  const longTerms = longQuery.split(' OR ');
  assert(
    longTerms.length <= 8,
    `Caps at 8 terms (got ${longTerms.length})`
  );

  // ── FTS-Only Search ──
  console.log('\n── FTS-Only Search (no vector store) ──');

  let hm;
  try {
    hm = await HyperMem.create({
      dataDir: tmpDir,
    });
  } catch (err) {
    console.log(`  ❌ Failed to create HyperMem: ${err.message}`);
    process.exit(1);
  }

  const agentId = 'alice';
  const libDb = hm.dbManager.getLibraryDb();

  // Seed facts
  hm.addFact(agentId, 'HyperMem uses Redis for hot session caching with a 24-hour TTL', {
    domain: 'infrastructure',
    visibility: 'org',
  });
  hm.addFact(agentId, 'The background indexer runs on 5-minute intervals extracting facts and episodes', {
    domain: 'operations',
    visibility: 'org',
  });
  hm.addFact(agentId, 'sqlite-vec provides KNN vector search with nomic-embed-text 768d embeddings', {
    domain: 'infrastructure',
    visibility: 'org',
  });
  hm.addFact(agentId, 'Fleet has 18 agents registered across council and director tiers', {
    domain: 'fleet',
    visibility: 'org',
  });

  // Seed knowledge
  libDb.prepare(`
    INSERT INTO knowledge (agent_id, key, content, domain, source_type, visibility, created_at, updated_at)
    VALUES (?, 'redis-config', 'Redis runs on port 6379 with key prefix hm:', 'infrastructure', 'manual', 'org', datetime('now'), datetime('now'))
  `).run(agentId);

  libDb.prepare(`
    INSERT INTO knowledge (agent_id, key, content, domain, source_type, visibility, created_at, updated_at)
    VALUES (?, 'embedding-model', 'Embedding model is nomic-embed-text with 768 dimensions via Ollama', 'infrastructure', 'manual', 'org', datetime('now'), datetime('now'))
  `).run(agentId);

  // Seed episodes
  const { EpisodeStore } = await import('../dist/episode-store.js');
  const episodeStore = new EpisodeStore(libDb);
  episodeStore.record(agentId, 'deployment', 'Deployed HyperMem hook to production fleet', {
    significance: 0.8,
    visibility: 'org',
  });
  episodeStore.record(agentId, 'decision', 'Decided to use Reciprocal Rank Fusion for hybrid retrieval', {
    significance: 0.7,
    visibility: 'org',
  });

  // FTS-only search (no vectorStore)
  const ftsResults = await hybridSearch(libDb, null, 'Redis caching infrastructure', {
    agentId,
    limit: 5,
  });

  assert(ftsResults.length > 0, `FTS-only returns results (got ${ftsResults.length})`);
  assert(
    ftsResults.every(r => r.sources.includes('fts')),
    'All results sourced from FTS'
  );
  assert(
    ftsResults.every(r => r.score > 0),
    'All results have positive scores'
  );

  // Check that Redis-related facts rank high
  const redisResult = ftsResults.find(r => r.content.toLowerCase().includes('redis'));
  assert(redisResult !== undefined, 'Redis-related content found');

  // FTS search with no matching terms (all stop words)
  const emptyResults = await hybridSearch(libDb, null, 'the is a an', {
    agentId,
    limit: 5,
  });
  assert(emptyResults.length === 0, 'No results for all-stop-word query');

  // FTS across multiple content types
  const multiResults = await hybridSearch(libDb, null, 'deployment fleet production', {
    agentId,
    limit: 10,
  });
  const sourceTypes = new Set(multiResults.map(r => r.sourceTable));
  assert(
    multiResults.length > 0,
    `Multi-type search returns results (got ${multiResults.length})`
  );

  // ── Table Filtering ──
  console.log('\n── Table Filtering ──');

  const factsOnly = await hybridSearch(libDb, null, 'Redis infrastructure', {
    agentId,
    tables: ['facts'],
    limit: 10,
  });
  assert(
    factsOnly.every(r => r.sourceTable === 'facts'),
    'Table filter restricts to facts only'
  );

  const episodesOnly = await hybridSearch(libDb, null, 'deployment production', {
    agentId,
    tables: ['episodes'],
    limit: 10,
  });
  assert(
    episodesOnly.every(r => r.sourceTable === 'episodes'),
    'Table filter restricts to episodes only'
  );

  // ── Result Structure ──
  console.log('\n── Result Structure ──');

  if (ftsResults.length > 0) {
    const r = ftsResults[0];
    assert(typeof r.sourceTable === 'string', 'Result has sourceTable');
    assert(typeof r.sourceId === 'number', 'Result has sourceId');
    assert(typeof r.content === 'string', 'Result has content');
    assert(typeof r.score === 'number', 'Result has score');
    assert(Array.isArray(r.sources), 'Result has sources array');
    assert(r.sources.length > 0, 'Result has at least one source');
  }

  // ── Score Ordering ──
  console.log('\n── Score Ordering ──');

  if (ftsResults.length >= 2) {
    let ordered = true;
    for (let i = 1; i < ftsResults.length; i++) {
      if (ftsResults[i].score > ftsResults[i - 1].score) {
        ordered = false;
        break;
      }
    }
    assert(ordered, 'Results sorted by score descending');
  } else {
    console.log('  ⏭️ Skipped (need 2+ results)');
  }

  // ── Deduplication ──
  console.log('\n── Deduplication ──');

  const allResults = await hybridSearch(libDb, null, 'Redis caching indexer infrastructure fleet', {
    agentId,
    limit: 20,
  });
  const keys = allResults.map(r => `${r.sourceTable}:${r.sourceId}`);
  const uniqueKeys = new Set(keys);
  assert(
    keys.length === uniqueKeys.size,
    `No duplicates (${keys.length} results, ${uniqueKeys.size} unique)`
  );

  // ── Limit Enforcement ──
  console.log('\n── Limit Enforcement ──');

  const limited = await hybridSearch(libDb, null, 'Redis infrastructure deployment', {
    agentId,
    limit: 2,
  });
  assert(limited.length <= 2, `Limit enforced (got ${limited.length})`);


  // ── Adjacency-Aware Fusion Boost ──
  console.log('\n── Adjacency-Aware Fusion Boost ──');

  function addIndexedFact(content, domain, sourceMessageId, createdAt) {
    const result = libDb.prepare(`
      INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility,
        source_type, source_ref, created_at, updated_at, decay_score)
      VALUES (?, 'agent', ?, ?, 1.0, 'org', 'indexer', ?, ?, ?, 0.0)
    `).run(agentId, domain, content, `msg:${sourceMessageId}`, createdAt, createdAt);
    return Number(result.lastInsertRowid);
  }

  function fakeVectorStore(results) {
    return {
      search: async () => results,
    };
  }

  function vectorFact(sourceId, content, domain, rankDistance = 0.2) {
    return {
      sourceTable: 'facts',
      sourceId,
      content,
      domain,
      agentId,
      distance: rankDistance,
    };
  }

  const t0 = '2026-04-28T10:00:00.000Z';
  const t2m = '2026-04-28T10:02:00.000Z';
  const t11m = '2026-04-28T10:11:00.000Z';

  const antecedentContent = 'adjacencyboost shared antecedent context alpha';
  const successorContent = 'adjacencyboost shared successor target beta';
  const antecedentId = addIndexedFact(antecedentContent, 'infrastructure', 100, t0);
  const successorId = addIndexedFact(successorContent, 'infrastructure', 103, t2m);

  const adjacencyResults = await hybridSearch(
    libDb,
    fakeVectorStore([
      vectorFact(successorId, successorContent, 'infrastructure', 0.1),
      vectorFact(antecedentId, antecedentContent, 'infrastructure', 0.2),
    ]),
    'adjacencyboost shared',
    { agentId, tables: ['facts'], limit: 5 }
  );
  assert(
    adjacencyResults[0]?.sourceId === antecedentId,
    'Adjacent antecedent receives bounded boost inside fused ranking'
  );

  const farAntecedentContent = 'deltaboost shared antecedent context alpha';
  const farSuccessorContent = 'deltaboost shared successor target beta';
  const farDistractorContent = 'deltaboost vector-only distractor';
  const farAntecedentId = addIndexedFact(farAntecedentContent, 'infrastructure', 200, t0);
  const farSuccessorId = addIndexedFact(farSuccessorContent, 'infrastructure', 203, t11m);
  const farDistractorId = addIndexedFact(farDistractorContent, 'infrastructure', 900, t0);

  const farResults = await hybridSearch(
    libDb,
    fakeVectorStore([
      vectorFact(farSuccessorId, farSuccessorContent, 'infrastructure', 0.1),
      vectorFact(farDistractorId, farDistractorContent, 'infrastructure', 0.2),
      vectorFact(farAntecedentId, farAntecedentContent, 'infrastructure', 0.3),
    ]),
    'deltaboost shared',
    { agentId, tables: ['facts'], limit: 5 }
  );
  assert(
    farResults.findIndex(r => r.sourceId === farSuccessorId) < farResults.findIndex(r => r.sourceId === farAntecedentId),
    'Adjacency boost suppressed beyond 10 minute clock delta'
  );

  const heartbeatContent = 'heartbeatcase packetadjacency HEARTBEAT_OK';
  const heartbeatSuccessorContent = 'heartbeatcase packetadjacency legitimate successor';
  const heartbeatDistractorContent = 'heartbeatcase vector-only distractor';
  const heartbeatId = addIndexedFact(heartbeatContent, 'heartbeat', 300, t0);
  const heartbeatSuccessorId = addIndexedFact(heartbeatSuccessorContent, 'operations', 303, t2m);
  const heartbeatDistractorId = addIndexedFact(heartbeatDistractorContent, 'operations', 901, t0);

  const heartbeatResults = await hybridSearch(
    libDb,
    fakeVectorStore([
      vectorFact(heartbeatSuccessorId, heartbeatSuccessorContent, 'operations', 0.1),
      vectorFact(heartbeatDistractorId, heartbeatDistractorContent, 'operations', 0.2),
      vectorFact(heartbeatId, heartbeatContent, 'heartbeat', 0.3),
    ]),
    'heartbeatcase packetadjacency',
    { agentId, tables: ['facts'], limit: 5 }
  );
  assert(
    heartbeatResults.findIndex(r => r.sourceId === heartbeatSuccessorId) < heartbeatResults.findIndex(r => r.sourceId === heartbeatId),
    'Heartbeat and HEARTBEAT_OK traffic is suppressed from adjacency boosting'
  );

  const systemContent = '[system] systemcase packetadjacency control frame';
  const systemSuccessorContent = 'systemcase packetadjacency legitimate successor';
  const systemDistractorContent = 'systemcase vector-only distractor';
  const systemId = addIndexedFact(systemContent, 'system', 400, t0);
  const systemSuccessorId = addIndexedFact(systemSuccessorContent, 'operations', 403, t2m);
  const systemDistractorId = addIndexedFact(systemDistractorContent, 'operations', 902, t0);

  const systemResults = await hybridSearch(
    libDb,
    fakeVectorStore([
      vectorFact(systemSuccessorId, systemSuccessorContent, 'operations', 0.1),
      vectorFact(systemDistractorId, systemDistractorContent, 'operations', 0.2),
      vectorFact(systemId, systemContent, 'system', 0.3),
    ]),
    'systemcase packetadjacency',
    { agentId, tables: ['facts'], limit: 5 }
  );
  assert(
    systemResults.findIndex(r => r.sourceId === systemSuccessorId) < systemResults.findIndex(r => r.sourceId === systemId),
    'System traffic is suppressed from adjacency boosting'
  );

  const stableResults = await hybridSearch(
    libDb,
    fakeVectorStore([
      vectorFact(9901, 'stable tie first', 'test', 0.5),
      vectorFact(9902, 'stable tie second', 'test', 0.5),
    ]),
    'the is a an',
    { agentId, tables: ['facts'], limit: 2 }
  );
  assert(
    stableResults[0]?.sourceId === 9901 && stableResults[1]?.sourceId === 9902,
    'Stable ordering preserved when scores tie and no boost applies'
  );

  // ── Cleanup ──
  console.log('\n── Cleanup ──');
  hm.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert(true, 'Cleaned up');

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
