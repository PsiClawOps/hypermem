#!/usr/bin/env node
/**
 * run-indexer.mjs
 *
 * Runs one background indexer tick across all agents.
 * Processes unindexed messages, extracts facts/episodes/knowledge.
 *
 * Usage:
 *   node scripts/run-indexer.mjs                    # One-shot
 *   node scripts/run-indexer.mjs --daemon            # Run continuously (5 min interval)
 *   node scripts/run-indexer.mjs --stats             # Show watermark stats only
 *   node scripts/run-indexer.mjs --agent my-agent       # Process single agent
 */

import path from 'node:path';
import os from 'node:os';

const HYPERMEM_PATH = path.join(os.homedir(), '.openclaw/workspace/repo/hypermem/dist/index.js');
const { HyperMem, BackgroundIndexer, createIndexer } = await import(HYPERMEM_PATH);

const args = process.argv.slice(2);
const DAEMON = args.includes('--daemon');
const STATS_ONLY = args.includes('--stats');
const AGENT_FILTER = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null;

const hm = await HyperMem.create();

if (STATS_ONLY) {
  const libraryDb = hm.dbManager.getLibraryDb();
  const indexer = createIndexer(
    (id) => hm.dbManager.getMessageDb(id),
    () => hm.dbManager.getLibraryDb(),
    () => hm.dbManager.listAgents()
  );

  const watermarks = indexer.getWatermarks(libraryDb);
  if (watermarks.length === 0) {
    console.log('No watermarks yet — indexer has not run.');
  } else {
    console.log('Agent Watermarks:');
    for (const wm of watermarks) {
      console.log(`  ${wm.agentId}: last_msg_id=${wm.lastMessageId}, last_run=${wm.lastRunAt}`);
    }
  }
  await hm.close();
  process.exit(0);
}

const indexer = createIndexer(
  (id) => hm.dbManager.getMessageDb(id),
  () => hm.dbManager.getLibraryDb(),
  () => {
    const agents = hm.dbManager.listAgents();
    if (AGENT_FILTER) return agents.filter(a => a === AGENT_FILTER);
    return agents;
  },
  {
    periodicInterval: DAEMON ? 300000 : 60000,
    episodeSignificanceThreshold: 0.4,
    factDecayRate: 0.005,
  }
);

if (DAEMON) {
  console.log('Starting indexer daemon (5 min interval)...');
  console.log('Press Ctrl+C to stop.');
  indexer.start();

  process.on('SIGINT', async () => {
    console.log('\nStopping indexer...');
    indexer.stop();
    await hm.close();
    process.exit(0);
  });
} else {
  // One-shot
  console.log('Running single indexer tick...');
  const results = await indexer.tick();

  if (results.length === 0) {
    console.log('No unindexed messages found.');
  } else {
    for (const r of results) {
      console.log(`\n${r.agentId}:`);
      console.log(`  Messages processed: ${r.messagesProcessed}`);
      console.log(`  Facts extracted: ${r.factsExtracted}`);
      console.log(`  Episodes recorded: ${r.episodesRecorded}`);
      console.log(`  Topics updated: ${r.topicsUpdated}`);
      console.log(`  Knowledge upserted: ${r.knowledgeUpserted}`);
      console.log(`  Elapsed: ${r.elapsedMs}ms`);
    }
  }

  await hm.close();
}
