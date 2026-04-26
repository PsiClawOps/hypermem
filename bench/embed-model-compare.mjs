#!/usr/bin/env node
/**
 * Embedding Model A/B Comparison Benchmark
 *
 * Compares nomic-embed-text vs embeddinggemma:300m on REAL production data.
 * Tests: latency, recall quality, KNN search relevance.
 *
 * Usage: node bench/embed-model-compare.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = path.join(process.env.HOME || os.homedir(), '.openclaw', 'hypermem');
const OLLAMA_URL = 'http://localhost:11434';
const ITERATIONS = 20;  // Per-model embed latency iterations

const MODELS = [
  { name: 'nomic-embed-text', dimensions: 768 },
  { name: 'embeddinggemma:300m', dimensions: 768 },
];

// ── Test queries — real agent memory queries ──────────────────

const TEST_QUERIES = [
  'infrastructure architecture deployment reliability',
  'HyperMem compositor prompt assembly context engine',
  'Redis hot cache session TTL window invalidation',
  'council governance turn protocol voting decision',
  'FTS5 full text search sqlite performance regression',
  'vector store KNN semantic recall embedding',
  'git commit push deploy production release',
  'memory compaction decay score fact superseded',
  'background indexer episode significance threshold',
  'dashboard canvas dashboard server restart',
];

// ── Helpers ──────────────────────────────────────────────────

async function embed(model, texts) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!response.ok) throw new Error(`Embed failed: ${response.status}`);
  const data = await response.json();
  return data.embeddings.map(e => new Float32Array(e));
}

function cosineDistance(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function fmtMs(ms) {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)];
}

// ── Load production data for relevance testing ──────────────

function loadProductionData() {
  const libPath = path.join(DATA_DIR, 'library.db');
  if (!fs.existsSync(libPath)) throw new Error('No library.db found');
  const db = new DatabaseSync(libPath, { readOnly: true });

  // Get a sample of facts and episodes
  const facts = db.prepare(`
    SELECT id, content, domain FROM facts 
    WHERE agent_id = 'alice' AND superseded_by IS NULL AND decay_score > 0
    ORDER BY confidence DESC LIMIT 100
  `).all();

  const episodes = db.prepare(`
    SELECT id, summary as content, event_type as domain FROM episodes 
    WHERE agent_id = 'alice' AND decay_score > 0
    ORDER BY created_at DESC LIMIT 200
  `).all();

  db.close();
  return { facts, episodes };
}

// ── Relevance test: embed queries + corpus, measure recall ──

async function testRelevance(model, queries, corpus) {
  // Embed all corpus items
  const corpusTexts = corpus.map(c => c.content);
  const batchSize = 32;
  const corpusEmbeddings = [];
  
  for (let i = 0; i < corpusTexts.length; i += batchSize) {
    const batch = corpusTexts.slice(i, i + batchSize);
    const embeddings = await embed(model, batch);
    corpusEmbeddings.push(...embeddings);
  }

  // Embed queries
  const queryEmbeddings = await embed(model, queries);

  // For each query, find top-10 nearest neighbors
  const results = [];
  for (let q = 0; q < queries.length; q++) {
    const queryEmb = queryEmbeddings[q];
    const distances = corpusEmbeddings.map((corpusEmb, idx) => ({
      idx,
      distance: cosineDistance(queryEmb, corpusEmb),
      content: corpus[idx].content,
      domain: corpus[idx].domain,
    }));
    distances.sort((a, b) => a.distance - b.distance);
    results.push({
      query: queries[q],
      top10: distances.slice(0, 10),
      avgDistance: distances.slice(0, 10).reduce((s, d) => s + d.distance, 0) / 10,
      minDistance: distances[0].distance,
    });
  }

  return results;
}

// ── Main ─────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(70)}`);
console.log(`  Embedding Model A/B Comparison`);
console.log(`  Models: ${MODELS.map(m => m.name).join(' vs ')}`);
console.log(`  Queries: ${TEST_QUERIES.length}`);
console.log(`  Latency iterations: ${ITERATIONS}`);
console.log(`${'═'.repeat(70)}\n`);

// Warm both models
console.log('Warming models...');
for (const model of MODELS) {
  await embed(model.name, ['warm up query']);
}

// ── 1. Latency comparison ────────────────────────────────────

console.log('\n── Embed Latency (single query) ──\n');

for (const model of MODELS) {
  const times = [];
  // Warmup
  for (let i = 0; i < 3; i++) await embed(model.name, ['test query warmup']);
  
  for (let i = 0; i < ITERATIONS; i++) {
    const query = TEST_QUERIES[i % TEST_QUERIES.length];
    const start = performance.now();
    await embed(model.name, [query]);
    times.push(performance.now() - start);
  }

  const p50 = percentile(times, 0.5);
  const p95 = percentile(times, 0.95);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(`  ${model.name}:`);
  console.log(`    min=${fmtMs(min)}  avg=${fmtMs(avg)}  p50=${fmtMs(p50)}  p95=${fmtMs(p95)}  max=${fmtMs(max)}`);
}

// ── 2. Batch latency (32 items) ──────────────────────────────

console.log('\n── Batch Embed Latency (32 items) ──\n');

const batchTexts = TEST_QUERIES.concat(TEST_QUERIES).concat(TEST_QUERIES).concat(
  ['deploy', 'redis cache'].concat(TEST_QUERIES.slice(0, 10))
).slice(0, 32);

for (const model of MODELS) {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await embed(model.name, batchTexts);
    times.push(performance.now() - start);
  }
  const avg = times.reduce((s, t) => s + t, 0) / times.length;
  const perItem = avg / 32;
  console.log(`  ${model.name}: avg=${fmtMs(avg)} total, ${fmtMs(perItem)}/item`);
}

// ── 3. Relevance comparison on production data ──────────────

console.log('\n── Loading production data... ──');
const { facts, episodes } = loadProductionData();
const corpus = [...facts, ...episodes];
console.log(`  ${facts.length} facts + ${episodes.length} episodes = ${corpus.length} items\n`);

console.log('── Relevance: Facts + Episodes (top-10 cosine distance) ──\n');

const modelResults = {};

for (const model of MODELS) {
  console.log(`  Computing ${model.name}...`);
  const results = await testRelevance(model.name, TEST_QUERIES, corpus);
  modelResults[model.name] = results;
  
  const avgOfAvg = results.reduce((s, r) => s + r.avgDistance, 0) / results.length;
  const avgMin = results.reduce((s, r) => s + r.minDistance, 0) / results.length;
  console.log(`    Mean top-10 distance: ${avgOfAvg.toFixed(4)}`);
  console.log(`    Mean closest match:   ${avgMin.toFixed(4)}`);
}

// ── 4. Per-query comparison ──────────────────────────────────

console.log('\n── Per-Query: Closest Match Distance ──\n');
console.log(`  ${'Query'.padEnd(55)} | ${'nomic'.padEnd(8)} | ${'gemma'.padEnd(8)} | Winner`);
console.log(`  ${'─'.repeat(55)}-+-${'─'.repeat(8)}-+-${'─'.repeat(8)}-+--------`);

let nomicWins = 0, gemmaWins = 0, ties = 0;

for (let q = 0; q < TEST_QUERIES.length; q++) {
  const nomicDist = modelResults[MODELS[0].name][q].minDistance;
  const gemmaDist = modelResults[MODELS[1].name][q].minDistance;
  const diff = Math.abs(nomicDist - gemmaDist);
  let winner;
  if (diff < 0.005) { winner = 'tie'; ties++; }
  else if (nomicDist < gemmaDist) { winner = 'nomic'; nomicWins++; }
  else { winner = 'gemma'; gemmaWins++; }

  const query = TEST_QUERIES[q].length > 53 ? TEST_QUERIES[q].slice(0, 50) + '...' : TEST_QUERIES[q];
  console.log(`  ${query.padEnd(55)} | ${nomicDist.toFixed(4).padEnd(8)} | ${gemmaDist.toFixed(4).padEnd(8)} | ${winner}`);
}

// ── 5. Top results quality comparison ────────────────────────

console.log('\n── Sample: Top-3 results per model for "HyperMem compositor prompt assembly" ──\n');

const sampleQuery = 'HyperMem compositor prompt assembly context engine';
const sampleIdx = TEST_QUERIES.indexOf(sampleQuery);

for (const model of MODELS) {
  console.log(`  ${model.name}:`);
  const top3 = modelResults[model.name][sampleIdx].top10.slice(0, 3);
  for (let i = 0; i < top3.length; i++) {
    const r = top3[i];
    const snippet = r.content.length > 80 ? r.content.slice(0, 77) + '...' : r.content;
    console.log(`    #${i + 1} (d=${r.distance.toFixed(4)}) [${r.domain}] ${snippet}`);
  }
  console.log();
}

// ── Summary ──────────────────────────────────────────────────

console.log(`${'═'.repeat(70)}`);
console.log(`  SUMMARY`);
console.log(`${'═'.repeat(70)}`);
console.log(`\n  Closest-match wins: nomic=${nomicWins}, gemma=${gemmaWins}, ties=${ties}`);

const nomicAvg = modelResults[MODELS[0].name].reduce((s, r) => s + r.avgDistance, 0) / TEST_QUERIES.length;
const gemmaAvg = modelResults[MODELS[1].name].reduce((s, r) => s + r.avgDistance, 0) / TEST_QUERIES.length;
console.log(`  Mean top-10 distance: nomic=${nomicAvg.toFixed(4)}, gemma=${gemmaAvg.toFixed(4)}`);

if (gemmaAvg < nomicAvg) {
  const pctBetter = ((nomicAvg - gemmaAvg) / nomicAvg * 100).toFixed(1);
  console.log(`  → EmbeddingGemma produces ${pctBetter}% tighter clusters (lower distance = better)`);
} else if (nomicAvg < gemmaAvg) {
  const pctBetter = ((gemmaAvg - nomicAvg) / gemmaAvg * 100).toFixed(1);
  console.log(`  → Nomic produces ${pctBetter}% tighter clusters (lower distance = better)`);
} else {
  console.log(`  → Tied on cluster quality`);
}

console.log(`\n${'═'.repeat(70)}\n`);
