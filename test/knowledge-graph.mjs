/**
 * Knowledge graph traversal tests.
 *
 * Tests:
 *   1. Link creation (idempotent)
 *   2. Directional queries (outbound, inbound)
 *   3. BFS traversal with depth limiting
 *   4. Shortest path finding
 *   5. Link removal (single + entity)
 *   6. Filtered traversal (by link type, entity type, direction)
 *   7. Analytics (most connected, link stats)
 *   8. Cycle handling (DAG allows revisits, BFS handles them)
 */

import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-graph-'));

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
  console.log('  HyperMem Knowledge Graph Test');
  console.log('═══════════════════════════════════════════════════\n');

  let hm;
  try {
    hm = await HyperMem.create({
      dataDir: tmpDir,
    });
  } catch (err) {
    console.log(`  ❌ Failed to create HyperMem: ${err.message}`);
    process.exit(1);
  }

  // ── Seed some facts and knowledge for linking ──
  const fact1 = hm.addFact('alice', 'Redis 7.0.15 runs on localhost:6379', { domain: 'infra' });
  const fact2 = hm.addFact('alice', 'SQLite uses WAL mode for concurrent reads', { domain: 'infra' });
  const fact3 = hm.addFact('alice', 'HyperMem replaced ClawText JSONL', { domain: 'architecture' });
  const fact4 = hm.addFact('bob', 'Product launches Q2 2026', { domain: 'strategy' });
  const fact5 = hm.addFact('dave', 'All fleet DBs use encrypted-at-rest', { domain: 'security' });

  const k1 = hm.upsertKnowledge('alice', 'architecture', 'memory-layers',
    'L1 Redis, L2 Messages, L3 Vectors, L4 Library');
  const k2 = hm.upsertKnowledge('alice', 'architecture', 'db-split',
    'Three files per agent: messages.db, vectors.db, library.db');

  // ── Test 1: Link creation ──
  console.log('── Link Creation ──');

  const link1 = hm.addKnowledgeLink('fact', fact1.id, 'fact', fact2.id, 'supports');
  assert(link1.id > 0, `Link created: ${link1.fromType}:${link1.fromId} → ${link1.toType}:${link1.toId}`);
  assert(link1.linkType === 'supports', 'Link type correct');

  // Idempotent — same link doesn't create duplicate
  const link1b = hm.addKnowledgeLink('fact', fact1.id, 'fact', fact2.id, 'supports');
  assert(link1b.id === link1.id, 'Idempotent: same link returns same ID');

  // Different link type is a new link
  const link2 = hm.addKnowledgeLink('fact', fact1.id, 'fact', fact2.id, 'related');
  assert(link2.id !== link1.id, 'Different link type creates new link');

  // Cross-type links
  const link3 = hm.addKnowledgeLink('fact', fact3.id, 'knowledge', k1.id, 'references');
  assert(link3.fromType === 'fact', 'Cross-type: fact → knowledge');
  assert(link3.toType === 'knowledge', 'Cross-type: target is knowledge');

  // ── Test 2: Directional queries ──
  console.log('\n── Directional Queries ──');

  // Build a small graph:
  // fact1 --supports--> fact2
  // fact1 --related---> fact2
  // fact3 --references-> k1
  // fact2 --derived_from-> k2
  // fact4 --depends_on--> fact3
  // fact5 --related------> fact2
  hm.addKnowledgeLink('fact', fact2.id, 'knowledge', k2.id, 'derived_from');
  hm.addKnowledgeLink('fact', fact4.id, 'fact', fact3.id, 'depends_on');
  hm.addKnowledgeLink('fact', fact5.id, 'fact', fact2.id, 'related');

  const outbound = hm.getEntityLinks('fact', fact1.id);
  assert(outbound.length >= 2, `Fact1 has ${outbound.length} links`);

  // ── Test 3: BFS Traversal ──
  console.log('\n── BFS Traversal ──');

  const traversal = hm.traverseGraph('fact', fact1.id, { maxDepth: 3 });
  assert(traversal.nodes.length > 0, `Traversal found ${traversal.nodes.length} nodes`);
  assert(traversal.edges.length > 0, `Traversal found ${traversal.edges.length} edges`);

  // Check we found fact2 (direct neighbor)
  const foundFact2 = traversal.nodes.some(n => n.type === 'fact' && n.id === fact2.id);
  assert(foundFact2, 'Found fact2 via traversal');

  // Check we found k2 (2 hops: fact1 → fact2 → k2)
  const foundK2 = traversal.nodes.some(n => n.type === 'knowledge' && n.id === k2.id);
  assert(foundK2, 'Found knowledge k2 at depth 2');

  // Depth-limited traversal
  const shallow = hm.traverseGraph('fact', fact1.id, { maxDepth: 1 });
  assert(shallow.nodes.every(n => n.depth <= 1), 'Depth 1 traversal respects limit');
  const shallowK2 = shallow.nodes.some(n => n.type === 'knowledge' && n.id === k2.id);
  assert(!shallowK2, 'k2 not reachable at depth 1');

  // ── Test 4: Shortest path ──
  console.log('\n── Shortest Path ──');

  // Path from fact1 to k2: fact1 → fact2 → k2
  const pathResult = hm.findGraphPath('fact', fact1.id, 'knowledge', k2.id);
  assert(pathResult !== null, 'Path found from fact1 to k2');
  assert(pathResult.length === 3, `Path length: ${pathResult?.length} (expected 3)`);
  assert(pathResult[0].type === 'fact' && pathResult[0].id === fact1.id, 'Path starts at fact1');
  assert(pathResult[pathResult.length - 1].type === 'knowledge', 'Path ends at knowledge');

  // No path to disconnected entity
  const isolatedFact = hm.addFact('alice', 'Isolated fact', { domain: 'test' });
  const noPath = hm.findGraphPath('fact', fact1.id, 'fact', isolatedFact.id);
  assert(noPath === null, 'No path to disconnected node');

  // ── Test 5: Link removal ──
  console.log('\n── Link Removal ──');

  const removed = hm.removeKnowledgeLink('fact', fact1.id, 'fact', fact2.id, 'related');
  assert(removed === true, 'Removed link');

  const removedAgain = hm.removeKnowledgeLink('fact', fact1.id, 'fact', fact2.id, 'related');
  assert(removedAgain === false, 'Already-removed link returns false');

  // ── Test 6: Filtered traversal ──
  console.log('\n── Filtered Traversal ──');

  // Only follow 'supports' links
  const supportsOnly = hm.traverseGraph('fact', fact1.id, {
    linkTypes: ['supports'],
    maxDepth: 3,
  });
  assert(supportsOnly.edges.every(e => e.linkType === 'supports'), 'Only supports links followed');

  // Only find knowledge entities
  const knowledgeOnly = hm.traverseGraph('fact', fact1.id, {
    targetTypes: ['knowledge'],
    maxDepth: 3,
  });
  assert(knowledgeOnly.nodes.every(n => n.type === 'knowledge'), 'Only knowledge nodes returned');

  // Outbound only
  const outboundOnly = hm.traverseGraph('fact', fact1.id, {
    direction: 'outbound',
    maxDepth: 1,
  });
  assert(outboundOnly.nodes.every(n => n.direction === 'outbound'), 'Only outbound links');

  // ── Test 7: Analytics ──
  console.log('\n── Analytics ──');

  const mostConnected = hm.getMostConnectedEntities({ limit: 3 });
  assert(mostConnected.length > 0, `Most connected: ${mostConnected.length} entities`);
  assert(mostConnected[0].degree >= mostConnected[mostConnected.length - 1].degree, 'Sorted by degree');

  // fact2 should be among the most connected (multiple links point to it)
  const fact2Connected = mostConnected.find(n => n.type === 'fact' && n.id === fact2.id);
  assert(fact2Connected !== undefined, 'fact2 is highly connected');

  const stats = hm.getGraphStats();
  assert(stats.totalLinks > 0, `Total links: ${stats.totalLinks}`);
  assert(stats.byType.length > 0, `Link types: ${stats.byType.length}`);
  assert(stats.byType.some(t => t.linkType === 'supports'), 'supports link type found');

  // Type-filtered most connected
  const factOnly = hm.getMostConnectedEntities({ type: 'fact', limit: 5 });
  assert(factOnly.every(n => n.type === 'fact'), 'Type filter works');

  // ── Test 8: Max results truncation ──
  console.log('\n── Truncation ──');

  const tiny = hm.traverseGraph('fact', fact1.id, { maxResults: 1 });
  assert(tiny.nodes.length <= 1, `Truncated to ${tiny.nodes.length} nodes`);
  assert(tiny.truncated, 'Marked as truncated');

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

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
