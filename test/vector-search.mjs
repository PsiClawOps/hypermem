/**
 * Vector Search (sqlite-vec + Ollama) Integration Test
 *
 * Tests:
 * - sqlite-vec extension loads correctly
 * - Ollama embedding generation works
 * - VectorStore indexing and KNN search
 * - Batch indexing
 * - Content change detection (hash-based skip)
 * - Orphan pruning
 * - Semantic search via HyperMem facade
 * - Session registry operations
 *
 * Requires:
 * - Ollama running locally with nomic-embed-text model
 * - sqlite-vec npm package installed
 */

import { HyperMem, VectorStore, generateEmbeddings } from '../dist/index.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-vector-'));

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
  console.log('  HyperMem Vector Search Test');
  console.log('═══════════════════════════════════════════════════\n');

  // ── Preflight: check Ollama ──
  console.log('── Preflight ──');
  let ollamaOk = false;
  try {
    const resp = await fetch('http://localhost:11434/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: ['test'] }),
      signal: AbortSignal.timeout(5000),
    });
    ollamaOk = resp.ok;
  } catch {}

  if (!ollamaOk) {
    console.log('  ⚠️  Ollama not available — skipping vector tests');
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  SKIPPED (Ollama required)');
    console.log('═══════════════════════════════════════════════════');
    process.exit(0);
  }
  assert(true, 'Ollama available with nomic-embed-text');

  // ── Test: Embedding generation ──
  console.log('\n── Embedding Generation ──');
  const embeddings = await generateEmbeddings(['Hello world', 'Goodbye world']);
  assert(embeddings.length === 2, `Generated ${embeddings.length} embeddings`);
  assert(embeddings[0].length === 768, `Dimension: ${embeddings[0].length}`);
  assert(embeddings[0] instanceof Float32Array, 'Returns Float32Array');

  // ── Test: sqlite-vec with node:sqlite ──
  console.log('\n── sqlite-vec Loading ──');
  let hm;
  try {
    hm = await HyperMem.create({
      dataDir: tmpDir,
    });
  } catch (err) {
    console.log(`  ❌ Failed to create HyperMem: ${err.message}`);
    failed++;
    process.exit(1);
  }

  // ── Setup: populate agent data ──
  console.log('\n── Populating Test Data ──');
  hm.dbManager.ensureAgent('alice', { displayName: 'alice', tier: 'council' });

  // Check sqlite-vec via getVectorDb (extension loads there, not in message DB)
  const vecDb = hm.dbManager.getVectorDb('alice');
  assert(hm.dbManager.vecAvailable, 'sqlite-vec loaded successfully');
  assert(vecDb !== null, 'Vector DB created');
  const vecVersion = vecDb.prepare('SELECT vec_version() as v').get();
  assert(vecVersion.v.startsWith('v'), `sqlite-vec version: ${vecVersion.v}`);

  // All structured knowledge goes in library DB
  const libDb = hm.dbManager.getLibraryDb();

  // Insert facts
  const factContents = [
    'Redis 7.0.15 is running on localhost port 6379',
    'The gateway restart is required after configuration changes',
    'HyperMem replaces ClawText as the primary memory architecture',
    'WAL mode provides better concurrent read performance for SQLite',
    'Ollama runs local embedding models like nomic-embed-text',
  ];

  for (const content of factContents) {
    libDb.prepare(`INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility, source_type, created_at, updated_at, decay_score)
      VALUES (?, ?, ?, ?, ?, ?, 'conversation', datetime('now'), datetime('now'), 0.0)`)
      .run('alice', 'agent', 'infrastructure', content, 1.0, 'fleet');
  }

  // Insert knowledge
  libDb.prepare(`INSERT INTO knowledge (agent_id, domain, key, content, confidence, visibility, source_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .run('alice', 'operations', 'deploy-process', 'Run preflight checks, push containers, run health check, shift traffic', 0.9, 'fleet', 'conversation');

  libDb.prepare(`INSERT INTO knowledge (agent_id, domain, key, content, confidence, visibility, source_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
    .run('alice', 'architecture', 'memory-design', 'Three-layer architecture: hot Redis compositor, warm SQLite per-agent, cold library', 0.95, 'fleet', 'conversation');

  // Insert episodes
  libDb.prepare(`INSERT INTO episodes (agent_id, event_type, summary, significance, visibility, participants, created_at, decay_score)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 0.0)`)
    .run('alice', 'deployment', 'Deployed HyperMem Phase 1 with 52 passing tests', 8, 'fleet', JSON.stringify(['alice', 'operator']));

  assert(true, `Populated ${factContents.length} facts, 2 knowledge, 1 episode`);

  // ── Test: Index all content ──
  console.log('\n── Vector Indexing ──');
  const indexResult = await hm.indexAgent('alice');
  assert(indexResult.indexed === 8, `Indexed ${indexResult.indexed} items (expected 8)`);
  assert(indexResult.skipped === 0, `Skipped ${indexResult.skipped} items (expected 0)`);

  // Second indexing should skip all (content unchanged)
  const reindexResult = await hm.indexAgent('alice');
  assert(reindexResult.indexed === 0, `Re-index: ${reindexResult.indexed} indexed (expected 0 — all cached)`);
  assert(reindexResult.skipped === 8, `Re-index: ${reindexResult.skipped} skipped (expected 8)`);

  // ── Test: Vector stats ──
  console.log('\n── Vector Stats ──');
  const stats = hm.getVectorStats('alice');
  assert(stats !== null, 'Stats returned');
  assert(stats.totalVectors === 8, `Total vectors: ${stats.totalVectors}`);
  assert(stats.tableBreakdown.facts === 5, `Facts vectors: ${stats.tableBreakdown.facts}`);
  assert(stats.tableBreakdown.knowledge === 2, `Knowledge vectors: ${stats.tableBreakdown.knowledge}`);
  assert(stats.tableBreakdown.episodes === 1, `Episodes vectors: ${stats.tableBreakdown.episodes}`);

  // ── Test: Semantic search ──
  console.log('\n── Semantic Search ──');

  // Search for Redis-related content
  const redisResults = await hm.semanticSearch('alice', 'Redis server configuration');
  assert(redisResults.length > 0, `Redis query returned ${redisResults.length} results`);
  // Redis should appear in top 3 (semantic similarity isn't always keyword-exact)
  const topRedis = redisResults.slice(0, 3).some(r => r.content.toLowerCase().includes('redis'));
  assert(topRedis, `Redis mentioned in top 3 results (distances: ${redisResults.slice(0, 3).map(r => r.distance.toFixed(2)).join(', ')})`);

  // Search for deployment process
  const deployResults = await hm.semanticSearch('alice', 'How to deploy to production');
  assert(deployResults.length > 0, `Deploy query returned ${deployResults.length} results`);

  // Search with table filter
  const factOnlyResults = await hm.semanticSearch('alice', 'memory architecture', {
    tables: ['facts'],
    limit: 3,
  });
  assert(
    factOnlyResults.every(r => r.sourceTable === 'facts'),
    'Table filter restricts to facts only'
  );

  // Search with distance threshold
  const strictResults = await hm.semanticSearch('alice', 'Redis', {
    maxDistance: 0.5,
  });
  const looseResults = await hm.semanticSearch('alice', 'Redis', {
    maxDistance: 5.0,
  });
  assert(
    strictResults.length <= looseResults.length,
    `Distance filter: strict=${strictResults.length} <= loose=${looseResults.length}`
  );

  // ── Test: Orphan pruning ──
  console.log('\n── Orphan Pruning ──');
  // Delete a fact from library and verify pruning works
  const factToDelete = libDb.prepare('SELECT id FROM facts LIMIT 1').get();
  libDb.prepare('DELETE FROM facts WHERE id = ?').run(factToDelete.id);
  const pruned = hm.pruneVectorOrphans('alice');
  assert(pruned === 1, `Pruned ${pruned} orphan(s) (expected 1)`);

  const statsAfterPrune = hm.getVectorStats('alice');
  assert(statsAfterPrune.totalVectors === 7, `Vectors after prune: ${statsAfterPrune.totalVectors} (expected 7)`);

  // ── Test: Supersedes Tombstoning ──
  console.log('\n── Supersedes Tombstoning ──');
  // Add two facts, index them (one will be newly indexed), then mark one superseded.
  // tombstoneSuperseded() should remove the superseded fact's vec_index_map entry.
  const statsBeforeTombstone = hm.getVectorStats('alice');

  // Insert a fact that's already indexed (simulate: manually insert into vec_index_map)
  const supersededFact = libDb.prepare(`
    INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility,
      source_type, created_at, updated_at, decay_score)
    VALUES ('alice', 'agent', null, 'HyperMem uses Redis for hot cache (SUPERSEDED)', 1.0, 'private',
      'test', datetime('now'), datetime('now'), 0.0)
  `).run();
  const supersededId = Number(supersededFact.lastInsertRowid);

  const newFact = libDb.prepare(`
    INSERT INTO facts (agent_id, scope, domain, content, confidence, visibility,
      source_type, created_at, updated_at, decay_score)
    VALUES ('alice', 'agent', null, 'HyperMem uses Redis for hot cache (NEW)', 1.0, 'private',
      'test', datetime('now'), datetime('now'), 0.0)
  `).run();
  const newFactId = Number(newFact.lastInsertRowid);

  // Manually insert a vec_index_map entry for the superseded fact
  const tombstoneVecDb = hm.dbManager.getVectorDb('alice');
  tombstoneVecDb.prepare(`
    INSERT OR IGNORE INTO vec_index_map (source_table, source_id, vec_table, content_hash, indexed_at)
    VALUES ('facts', ?, 'vec_facts', 'fakehash_superseded', datetime('now'))
  `).run(supersededId);
  const statsWithSuperseded = hm.getVectorStats('alice');
  assert(
    statsWithSuperseded.totalVectors === statsBeforeTombstone.totalVectors + 1,
    `Vec count increased by 1 after inserting superseded entry: ${statsWithSuperseded.totalVectors}`
  );

  // Mark the fact as superseded
  libDb.prepare('UPDATE facts SET superseded_by = ? WHERE id = ?').run(newFactId, supersededId);

  // indexAgent triggers tombstoneSuperseded()
  const tombstoneIndexResult = await hm.indexAgent('alice');
  assert(tombstoneIndexResult.tombstoned >= 1, `Tombstoned ${tombstoneIndexResult.tombstoned} superseded entry (expected >= 1)`);

  const statsAfterTombstone = hm.getVectorStats('alice');
  // Net: +1 for newFact indexed - 1 tombstoned = same as before we inserted supersededFact
  // i.e. statsBeforeTombstone (which already had superseded in index) or slightly higher
  assert(
    statsAfterTombstone.totalVectors <= statsWithSuperseded.totalVectors,
    `Vectors after tombstone (${statsAfterTombstone.totalVectors}) ≤ pre-tombstone (${statsWithSuperseded.totalVectors}) — superseded was removed`
  );

  // Cleanup tombstone test facts
  libDb.prepare('DELETE FROM facts WHERE id IN (?, ?)').run(supersededId, newFactId);
  hm.pruneVectorOrphans('alice');

  // ── Test: Session Registry ──
  console.log('\n── Session Registry ──');

  hm.registerSession('agent:alice:webchat:main', 'alice', {
    channel: '#alice-main',
    channelType: 'webchat',
  });
  assert(true, 'Session registered');

  hm.recordSessionEvent('agent:alice:webchat:main', 'decision', { description: 'Chose sqlite-vec over vectorlite' });
  hm.recordSessionEvent('agent:alice:webchat:main', 'fact_extracted', { fact: 'nomic-embed-text produces 768d vectors' });
  assert(true, 'Session events recorded');

  const sessions = hm.querySessions({ agentId: 'alice', status: 'active' });
  assert(sessions.length === 1, `Active sessions for alice: ${sessions.length}`);
  assert(sessions[0].decisions_made === 1, `Decisions tracked: ${sessions[0].decisions_made}`);
  assert(sessions[0].facts_extracted === 1, `Facts tracked: ${sessions[0].facts_extracted}`);

  hm.closeSession('agent:alice:webchat:main', 'Built vector search layer with sqlite-vec');
  const closedSessions = hm.querySessions({ agentId: 'alice', status: 'completed' });
  assert(closedSessions.length === 1, `Completed sessions: ${closedSessions.length}`);
  assert(closedSessions[0].summary !== null, 'Session has summary');

  const events = hm.getSessionEvents('agent:alice:webchat:main');
  assert(events.length === 4, `Session events: ${events.length} (start + decision + fact + completion)`);

  // ── Cleanup ──
  console.log('\n── Cleanup ──');
  await hm.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert(true, 'Cleaned up');

  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

run();
