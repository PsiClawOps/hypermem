#!/usr/bin/env node
/**
 * Bulk embed unembedded facts and episodes into vectors.db
 * Uses HyperMem's compiled VectorStore (loads sqlite-vec properly).
 */

import { DatabaseSync } from 'node:sqlite';
import { VectorStore } from '../dist/vector-store.js';
import { DatabaseManager } from '../dist/db.js';

const DATA_DIR = '/home/user/.openclaw/hypermem';
const MODEL = 'nomic-embed-text';
const DIM = 768;

async function main() {
  const dbm = new DatabaseManager({ dataDir: DATA_DIR });
  const libDb = dbm.getLibraryDb();
  const vecDb = dbm.getSharedVectorDb();
  
  if (!vecDb) {
    console.error('ERROR: sqlite-vec not available');
    process.exit(1);
  }

  console.log('sqlite-vec loaded ✅');

  const vs = new VectorStore(vecDb, {
    model: MODEL,
    dimensions: DIM,
    ollamaUrl: 'http://localhost:11434'
  });

  // Get already-embedded IDs
  const embeddedFacts = new Set(
    vecDb.prepare("SELECT source_id FROM vec_index_map WHERE source_table = 'facts'").all().map(r => r.source_id)
  );
  const embeddedEps = new Set(
    vecDb.prepare("SELECT source_id FROM vec_index_map WHERE source_table = 'episodes'").all().map(r => r.source_id)
  );

  const unembeddedFacts = libDb.prepare('SELECT id, content, domain FROM facts WHERE decay_score < 1.0').all()
    .filter(f => !embeddedFacts.has(f.id));
  const unembeddedEps = libDb.prepare('SELECT id, summary, event_type FROM episodes WHERE significance >= 0.7').all()
    .filter(e => !embeddedEps.has(e.id));

  console.log(`Gap: ${unembeddedFacts.length} facts, ${unembeddedEps.length} episodes`);

  if (unembeddedFacts.length === 0 && unembeddedEps.length === 0) {
    console.log('Nothing to embed — all vectors up to date.');
    return;
  }

  let done = 0;
  const total = unembeddedFacts.length + unembeddedEps.length;

  for (const fact of unembeddedFacts) {
    try {
      await vs.indexItem('facts', fact.id, fact.content, fact.domain || undefined);
      done++;
      if (done % 10 === 0) process.stdout.write(`\r${done}/${total}`);
    } catch(e) {
      console.error(`\nFact ${fact.id}: ${e.message}`);
    }
  }

  for (const ep of unembeddedEps) {
    try {
      await vs.indexItem('episodes', ep.id, ep.summary, ep.event_type || undefined);
      done++;
      if (done % 10 === 0) process.stdout.write(`\r${done}/${total}`);
    } catch(e) {
      console.error(`\nEpisode ${ep.id}: ${e.message}`);
    }
  }

  console.log(`\nEmbedded ${done}/${total}`);
  const vecTotal = vecDb.prepare('SELECT COUNT(*) as c FROM vec_index_map').get().c;
  console.log(`Total vectors: ${vecTotal}`);
}

main().catch(e => { console.error(e); process.exit(1); });
