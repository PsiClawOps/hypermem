#!/usr/bin/env node
/**
 * HyperMem Data Access Benchmark
 *
 * Tests all critical data paths against REAL production data.
 * No synthetic fixtures — this measures what the system actually does.
 *
 * Usage: node bench/data-access-bench.mjs [--iterations N] [--agent AGENT]
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DATA_DIR = path.join(process.env.HOME || '/home/lumadmin', '.openclaw', 'hypermem');
const ITERATIONS = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--iterations') || '100');
const TARGET_AGENT = process.argv.find((a, i) => process.argv[i - 1] === '--agent') || null;

// ── Helpers ──────────────────────────────────────────────────

function openDb(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA cache_size = -2000');
  return db;
}

function bench(label, fn, iterations = ITERATIONS) {
  // Warm up (3 runs, discard)
  for (let i = 0; i < 3; i++) fn();

  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length * 0.50)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];
  const max = times[times.length - 1];
  const min = times[0];
  const avg = times.reduce((s, t) => s + t, 0) / times.length;

  return { label, iterations, min, avg, p50, p95, p99, max };
}

function fmtMs(ms) {
  if (ms < 0.01) return `${(ms * 1000).toFixed(1)}µs`;
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function printResult(r) {
  const flag = r.p95 > 10 ? '🔴' : r.p95 > 5 ? '🟡' : '✅';
  console.log(`  ${flag} ${r.label}`);
  console.log(`     min=${fmtMs(r.min)}  avg=${fmtMs(r.avg)}  p50=${fmtMs(r.p50)}  p95=${fmtMs(r.p95)}  p99=${fmtMs(r.p99)}  max=${fmtMs(r.max)}  (${r.iterations} runs)`);
}

// ── Main ─────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  HyperMem Data Access Benchmark`);
console.log(`  Data: ${DATA_DIR}`);
console.log(`  Iterations: ${ITERATIONS}`);
console.log(`${'═'.repeat(60)}\n`);

// Discover agents
const agentsDir = path.join(DATA_DIR, 'agents');
const agents = fs.readdirSync(agentsDir).filter(a => {
  if (TARGET_AGENT && a !== TARGET_AGENT) return false;
  return fs.existsSync(path.join(agentsDir, a, 'messages.db'));
});

console.log(`Agents: ${agents.join(', ')}`);
console.log(`Library DB: ${fs.existsSync(path.join(DATA_DIR, 'library.db')) ? 'yes' : 'no'}`);

// ── Per-Agent Message DB Benchmarks ──────────────────────────

const allResults = [];

for (const agent of agents) {
  const dbPath = path.join(agentsDir, agent, 'messages.db');
  const db = openDb(dbPath);
  if (!db) continue;

  const msgCount = db.prepare('SELECT count(*) as c FROM messages').get().c;
  const convCount = db.prepare('SELECT count(*) as c FROM conversations').get().c;
  const dbSize = fs.statSync(dbPath).size;

  console.log(`\n── ${agent} (${msgCount} msgs, ${convCount} convs, ${(dbSize / 1024 / 1024).toFixed(1)}MB) ──`);

  if (msgCount === 0) {
    console.log('  (empty — skipping)');
    db.close();
    continue;
  }

  // Get a real conversation to test with
  const bigConv = db.prepare('SELECT id, message_count FROM conversations ORDER BY message_count DESC LIMIT 1').get();
  const recentConv = db.prepare('SELECT id, message_count FROM conversations ORDER BY updated_at DESC LIMIT 1').get();

  // 1. getRecentMessages — the HOT path (called every compose cycle)
  if (bigConv) {
    const stmtRecent = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY message_index DESC LIMIT ?');
    allResults.push(bench(`${agent}: getRecentMessages(50) [${bigConv.message_count} msgs in conv]`, () => {
      stmtRecent.all(bigConv.id, 50);
    }));
    printResult(allResults[allResults.length - 1]);

    // With larger window
    allResults.push(bench(`${agent}: getRecentMessages(200)`, () => {
      stmtRecent.all(bigConv.id, 200);
    }));
    printResult(allResults[allResults.length - 1]);
  }

  // 2. Conversation lookup by session key (called on every ingest)
  const someConv = db.prepare('SELECT session_key FROM conversations LIMIT 1').get();
  if (someConv) {
    const stmtConv = db.prepare('SELECT * FROM conversations WHERE session_key = ?');
    allResults.push(bench(`${agent}: getConversation(sessionKey)`, () => {
      stmtConv.get(someConv.session_key);
    }));
    printResult(allResults[allResults.length - 1]);
  }

  // 3. Message recording (write path — INSERT + UPDATE counter)
  // We'll do this read-only by benchmarking the prepared statement overhead
  // and the conversation counter update with a rollback
  if (recentConv) {
    const stmtInsert = db.prepare(`
      SELECT 1 WHERE 0
    `);
    // Actually, let's measure a SELECT that simulates the write path index lookups
    const stmtMaxIdx = db.prepare('SELECT MAX(message_index) AS max_idx FROM messages WHERE conversation_id = ?');
    allResults.push(bench(`${agent}: MAX(message_index) lookup [write path]`, () => {
      stmtMaxIdx.get(recentConv.id);
    }));
    printResult(allResults[allResults.length - 1]);
  }

  // 4. FTS search (fixed: no agent_id filter — per-agent DB is single-tenant)
  const stmtFts = db.prepare(`
    SELECT m.* FROM messages m
    JOIN messages_fts fts ON m.id = fts.rowid
    WHERE messages_fts MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `);
  allResults.push(bench(`${agent}: FTS search("deploy*")`, () => {
    stmtFts.all('deploy*', 20);
  }));
  printResult(allResults[allResults.length - 1]);

  // 5. Cross-session messages query (getAgentMessages)
  const stmtCross = db.prepare('SELECT * FROM messages WHERE agent_id = ? AND is_heartbeat = 0 ORDER BY created_at DESC LIMIT ?');
  allResults.push(bench(`${agent}: getAgentMessages(limit=50, no heartbeats)`, () => {
    stmtCross.all(agent, 50);
  }));
  printResult(allResults[allResults.length - 1]);

  // 6. Time-range query (since timestamp)
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stmtSince = db.prepare('SELECT * FROM messages WHERE agent_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?');
  allResults.push(bench(`${agent}: messages since 24h ago`, () => {
    stmtSince.all(agent, oneDayAgo, 200);
  }));
  printResult(allResults[allResults.length - 1]);

  // 7. Conversation list (getConversations)
  const stmtConvList = db.prepare('SELECT * FROM conversations WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?');
  allResults.push(bench(`${agent}: getConversations(limit=20)`, () => {
    stmtConvList.all(agent, 20);
  }));
  printResult(allResults[allResults.length - 1]);

  db.close();
}

// ── Library DB Benchmarks ────────────────────────────────────

const libPath = path.join(DATA_DIR, 'library.db');
const libDb = openDb(libPath);

if (libDb) {
  const factCount = libDb.prepare('SELECT count(*) as c FROM facts').get().c;
  const episodeCount = libDb.prepare('SELECT count(*) as c FROM episodes').get().c;
  const topicCount = libDb.prepare('SELECT count(*) as c FROM topics').get().c;
  const fleetCount = libDb.prepare('SELECT count(*) as c FROM fleet_agents').get().c;
  const libSize = fs.statSync(libPath).size;

  console.log(`\n── Library DB (${factCount} facts, ${episodeCount} episodes, ${topicCount} topics, ${fleetCount} fleet, ${(libSize / 1024 / 1024).toFixed(1)}MB) ──`);

  // 8. Active facts for agent (compositor hot path)
  const stmtFacts = libDb.prepare(`
    SELECT * FROM facts
    WHERE agent_id = ? AND superseded_by IS NULL AND decay_score > 0
    ORDER BY confidence DESC, updated_at DESC
    LIMIT ?
  `);
  for (const agent of ['alice', 'main', 'hank']) {
    allResults.push(bench(`library: activeFacts(${agent}, limit=50)`, () => {
      stmtFacts.all(agent, 50);
    }));
    printResult(allResults[allResults.length - 1]);
  }

  // 9. Recent episodes (compositor hot path)
  const stmtEpisodes = libDb.prepare(`
    SELECT * FROM episodes
    WHERE agent_id = ? AND decay_score > 0
    ORDER BY created_at DESC
    LIMIT ?
  `);
  for (const agent of ['alice', 'main']) {
    allResults.push(bench(`library: recentEpisodes(${agent}, limit=20)`, () => {
      stmtEpisodes.all(agent, 20);
    }));
    printResult(allResults[allResults.length - 1]);
  }

  // 10. Active topics
  const stmtTopics = libDb.prepare(`
    SELECT * FROM topics WHERE agent_id = ? AND status = 'active'
    ORDER BY updated_at DESC LIMIT ?
  `);
  allResults.push(bench(`library: activeTopics(alice)`, () => {
    stmtTopics.all('alice', 20);
  }));
  printResult(allResults[allResults.length - 1]);

  // 11. Fleet agent lookup
  const stmtFleet = libDb.prepare('SELECT * FROM fleet_agents WHERE id = ?');
  allResults.push(bench(`library: fleetAgent lookup`, () => {
    stmtFleet.get('alice');
  }));
  printResult(allResults[allResults.length - 1]);

  // 12. Fleet scan (all agents)
  const stmtFleetAll = libDb.prepare('SELECT * FROM fleet_agents');
  allResults.push(bench(`library: allFleetAgents (${fleetCount})`, () => {
    stmtFleetAll.all();
  }));
  printResult(allResults[allResults.length - 1]);

  // 13. Facts FTS (if available)
  try {
    const stmtFactFts = libDb.prepare(`
      SELECT f.* FROM facts f
      JOIN facts_fts ff ON f.id = ff.rowid
      WHERE facts_fts MATCH ?
      LIMIT ?
    `);
    allResults.push(bench(`library: facts FTS("redis")`, () => {
      stmtFactFts.all('redis', 20);
    }));
    printResult(allResults[allResults.length - 1]);
  } catch {
    console.log('  ⚪ Facts FTS not available');
  }

  // 14. Episodes by type (filtered scan)
  const stmtEpType = libDb.prepare(`
    SELECT * FROM episodes WHERE agent_id = ? AND event_type = ? ORDER BY created_at DESC LIMIT ?
  `);
  allResults.push(bench(`library: episodes(alice, type=decision)`, () => {
    stmtEpType.all('alice', 'decision', 20);
  }));
  printResult(allResults[allResults.length - 1]);

  // 15. Cross-agent episodes (shared visibility)
  const stmtSharedEp = libDb.prepare(`
    SELECT * FROM episodes WHERE visibility IN ('org', 'fleet') ORDER BY created_at DESC LIMIT ?
  `);
  allResults.push(bench(`library: sharedEpisodes(limit=50)`, () => {
    stmtSharedEp.all(50);
  }));
  printResult(allResults[allResults.length - 1]);

  // 16. Doc chunks (trigger-based retrieval)
  try {
    const chunkCount = libDb.prepare('SELECT count(*) as c FROM doc_chunks').get().c;
    if (chunkCount > 0) {
      const stmtChunks = libDb.prepare(`
        SELECT * FROM doc_chunks WHERE agent_id = ? AND collection = ? ORDER BY chunk_index LIMIT ?
      `);
      allResults.push(bench(`library: docChunks(alice, policy, limit=20) [${chunkCount} total]`, () => {
        stmtChunks.all('alice', 'policy', 20);
      }));
      printResult(allResults[allResults.length - 1]);
    }
  } catch {
    console.log('  ⚪ Doc chunks table not available');
  }

  libDb.close();
}

// ── Compaction Fence (new module) ────────────────────────────

const forgeDb = openDb(path.join(agentsDir, 'alice', 'messages.db'));
if (forgeDb) {
  try {
    const hasFence = forgeDb.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='compaction_fences'").get().c;
    if (hasFence) {
      const stmtFence = forgeDb.prepare('SELECT * FROM compaction_fences WHERE conversation_id = ?');
      const someConvId = forgeDb.prepare('SELECT id FROM conversations LIMIT 1').get()?.id;
      if (someConvId) {
        allResults.push(bench(`alice: compactionFence lookup`, () => {
          stmtFence.get(someConvId);
        }));
        printResult(allResults[allResults.length - 1]);
      }
    }
  } catch {
    console.log('  ⚪ Compaction fence not available');
  }
  forgeDb.close();
}

// ── Summary ──────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`  SUMMARY`);
console.log(`${'═'.repeat(60)}`);

const hot = allResults.filter(r => r.label.includes('getRecentMessages(50)') || r.label.includes('activeFacts') || r.label.includes('recentEpisodes') || r.label.includes('getConversation'));
const slow = allResults.filter(r => r.p95 > 5).sort((a, b) => b.p95 - a.p95);
const spikes = allResults.filter(r => r.max > 15).sort((a, b) => b.max - a.max);

console.log(`\nHot path performance (compositor critical):`);
for (const r of hot) {
  printResult(r);
}

if (slow.length > 0) {
  console.log(`\n🟡 Queries with p95 > 5ms:`);
  for (const r of slow) {
    printResult(r);
  }
} else {
  console.log(`\n✅ All queries under 5ms at p95`);
}

if (spikes.length > 0) {
  console.log(`\n🔴 Queries with max > 15ms (spike alert):`);
  for (const r of spikes) {
    printResult(r);
  }
} else {
  console.log(`✅ No spikes above 15ms`);
}

// Overall stats
const allP95 = allResults.map(r => r.p95);
const worstP95 = Math.max(...allP95);
const avgP95 = allP95.reduce((s, t) => s + t, 0) / allP95.length;
const worstMax = Math.max(...allResults.map(r => r.max));

console.log(`\nOverall: worst p95=${fmtMs(worstP95)}, avg p95=${fmtMs(avgP95)}, worst max=${fmtMs(worstMax)}`);
console.log(`Queries benchmarked: ${allResults.length}`);
console.log(`${'═'.repeat(60)}\n`);
