/**
 * HyperMem Document Chunker + Seeder Tests
 *
 * Tests:
 * - Markdown section parsing
 * - Chunk generation (content, IDs, paths)
 * - Source hash computation
 * - DocChunkStore: index, query, re-index, FTS5
 * - WorkspaceSeeder: seed, idempotency, staleness detection
 * - Schema v6 migration
 */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Import built modules
import { chunkMarkdown, chunkFile, hashContent, inferCollection, ACA_COLLECTIONS } from '../dist/doc-chunker.js';
import { DocChunkStore } from '../dist/doc-chunk-store.js';
import { WorkspaceSeeder } from '../dist/seed.js';
import { migrateLibrary } from '../dist/library-schema.js';

// ─── Test harness ────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
  }
}

function assertEq(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    failed++;
  }
}

// ─── Fixtures ────────────────────────────────────────────────────

const SIMPLE_MARKDOWN = `# Document Title

Preamble content that appears before any sections.

## Section One

This is the first section with some content.
It has multiple lines of text that together exceed the minimum content length.

### Subsection A

Content for subsection A with enough text to be considered substantial.

### Subsection B

Content for subsection B with enough text to be considered substantial.

## Section Two

This is the second section with enough content to exceed the minimum length threshold.
It has more than fifty characters of actual content.

## Empty Section

`;

const POLICY_LIKE = `# POLICY.md

Fleet governance policy document covering all operational rules for the agent fleet.

## §1 Naming Rules

All human-facing identifiers use single names only.
No titles, no honorifics, no compound names. This applies to all agents.

### Single-Name Rule

Council: Agent Epsilon, Agent Beta, Agent Zeta, Agent Delta, Agent Alpha, Agent Theta
Directors: Dir-One, Dir-Two, Dir-Three, Agent Gamma, Dir-Four, Agent Eta, Dir-Five, Dir-Six
Specialists: Spec-One, Spec-Two

## §2 Escalation

Four mandatory escalation triggers require human review. No autonomous resolution.

### Trigger 1: Policy Conflict

If instructions conflict with safety or compliance policies, pause and ask for clarification.
Do not attempt to resolve conflicts independently.

### Trigger 2: Irreversible Action

Destructive actions require human approval before execution.
When in doubt, treat as irreversible.

## §3 Decision States

Green, Yellow, Red decision framework for operational status.
GREEN = proceed, YELLOW = conditional, RED = stop and escalate.
All council decisions must include a decision state in their response.
`;

// ─── Test helpers ────────────────────────────────────────────────

function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrateLibrary(db);
  return db;
}

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `hm-chunker-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Suite 1: chunkMarkdown ──────────────────────────────────────

console.log('\n─── Markdown Chunking ───');

{
  const chunks = chunkMarkdown(SIMPLE_MARKDOWN, {
    collection: 'test/collection',
    sourcePath: 'test.md',
    scope: 'shared-fleet',
  });

  assert(chunks.length > 0, 'Produces chunks from markdown');

  const sectionPaths = chunks.map(c => c.sectionPath);
  assert(sectionPaths.some(p => p.includes('Section One')), 'Section One chunk exists');
  assert(sectionPaths.some(p => p.includes('Section Two')), 'Section Two chunk exists');

  // Subsections should be grouped under h2
  const sectionOne = chunks.find(c => c.sectionPath.includes('Section One'));
  assert(sectionOne !== undefined, 'Section One chunk found');
  assert(sectionOne.content.includes('Subsection A'), 'Subsection A content grouped into Section One');
  assert(sectionOne.content.includes('Subsection B'), 'Subsection B content grouped into Section One');

  // Empty section should be skipped (minContentLen=50)
  assert(!sectionPaths.some(p => p.includes('Empty Section')), 'Empty section skipped (below minContentLen)');

  // All chunks have required fields
  for (const chunk of chunks) {
    assert(chunk.id && chunk.id.length === 16, `Chunk ${chunk.sectionPath} has 16-char ID`);
    assert(chunk.sourceHash && chunk.sourceHash.length === 64, `Chunk ${chunk.sectionPath} has source hash`);
    assert(chunk.tokenEstimate > 0, `Chunk ${chunk.sectionPath} has token estimate`);
    assert(chunk.collection === 'test/collection', `Chunk ${chunk.sectionPath} has correct collection`);
  }
}

console.log('\n─── Policy Document Chunking ───');

{
  const chunks = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: 'POLICY.md',
    scope: 'shared-fleet',
  });

  assert(chunks.length >= 3, `At least 3 chunks from policy doc (got ${chunks.length})`);

  const sectionPaths = chunks.map(c => c.sectionPath);
  assert(sectionPaths.some(p => p.includes('§1 Naming Rules')), '§1 Naming Rules chunk exists');
  assert(sectionPaths.some(p => p.includes('§2 Escalation')), '§2 Escalation chunk exists');

  // §1 chunk should include the Single-Name Rule subsection
  const namingChunk = chunks.find(c => c.sectionPath.includes('§1 Naming Rules'));
  assert(namingChunk !== undefined, '§1 Naming Rules chunk found');
  assert(namingChunk.content.includes('Single-Name Rule'), 'Single-Name Rule grouped into §1');
  assert(namingChunk.content.includes('Agent Epsilon, Agent Beta'), 'Council list included in §1 chunk');

  // §2 Escalation should include both trigger subsections
  const escalationChunk = chunks.find(c => c.sectionPath.includes('§2 Escalation'));
  assert(escalationChunk !== undefined, '§2 Escalation chunk found');
  assert(escalationChunk.content.includes('Trigger 1'), 'Trigger 1 grouped into §2');
  assert(escalationChunk.content.includes('Trigger 2'), 'Trigger 2 grouped into §2');

  // §3 should exist now that content is long enough
  assert(sectionPaths.some(p => p.includes('§3 Decision States')), '§3 Decision States chunk exists');
}

console.log('\n─── Source Hash ───');

{
  const content1 = '# Hello\n\nSome content here.';
  const content2 = '# Hello\n\nDifferent content here.';
  const content3 = '# Hello\n\nSome content here.';

  const hash1 = hashContent(content1);
  const hash2 = hashContent(content2);
  const hash3 = hashContent(content3);

  assert(hash1 !== hash2, 'Different content produces different hashes');
  assertEq(hash1, hash3, 'Same content produces same hash (deterministic)');
  assertEq(hash1.length, 64, 'Hash is 64 hex chars (SHA-256)');
}

console.log('\n─── Chunk IDs Are Deterministic ───');

{
  const chunks1 = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: 'POLICY.md',
    scope: 'shared-fleet',
  });

  const chunks2 = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: 'POLICY.md',
    scope: 'shared-fleet',
  });

  assert(chunks1.length === chunks2.length, 'Same input produces same chunk count');
  for (let i = 0; i < chunks1.length; i++) {
    assertEq(chunks1[i].id, chunks2[i].id, `Chunk ${i} ID is deterministic`);
  }
}

console.log('\n─── Chunk IDs Are Unique Across Source Paths ───');

{
  // Same content, same collection, different source paths → different IDs
  const chunksA = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/agentA/POLICY.md',
    scope: 'shared-fleet',
  });

  const chunksB = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/agentB/POLICY.md',
    scope: 'shared-fleet',
  });

  assert(chunksA.length === chunksB.length, 'Same content produces same chunk count from different paths');
  for (let i = 0; i < chunksA.length; i++) {
    assert(chunksA[i].id !== chunksB[i].id, `Chunk ${i} IDs differ across source paths`);
  }

  // Same path produces same IDs (deterministic)
  const chunksA2 = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/agentA/POLICY.md',
    scope: 'shared-fleet',
  });
  for (let i = 0; i < chunksA.length; i++) {
    assertEq(chunksA[i].id, chunksA2[i].id, `Chunk ${i} ID is stable for same path`);
  }
}

// ─── Suite 2: DocChunkStore ──────────────────────────────────────

console.log('\n─── DocChunkStore: Basic Indexing ───');

{
  const db = makeDb();
  const store = new DocChunkStore(db);

  const chunks = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/POLICY.md',
    scope: 'shared-fleet',
  });

  const result = store.indexChunks(chunks);
  assert(result.inserted > 0, `Inserted ${result.inserted} chunks`);
  assert(!result.skipped, 'Not skipped (first index)');
  assert(!result.reindexed, 'Not reindexed (first index)');
  assert(result.deleted === 0, 'Nothing deleted on first index');

  // Query them back
  const retrieved = store.queryChunks({ collection: 'governance/policy' });
  assert(retrieved.length > 0, 'Chunks retrievable after indexing');
  assert(retrieved[0].content.length > 0, 'Retrieved chunk has content');
}

console.log('\n─── DocChunkStore: Idempotency ───');

{
  const db = makeDb();
  const store = new DocChunkStore(db);

  const chunks = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/POLICY.md',
    scope: 'shared-fleet',
  });

  const r1 = store.indexChunks(chunks);
  assert(r1.inserted > 0, 'First index inserts chunks');

  // Index same chunks again — should be a no-op
  const r2 = store.indexChunks(chunks);
  assert(r2.skipped, 'Second index of same content is skipped');
  assertEq(r2.inserted, 0, 'No new chunks inserted on repeat');
}

console.log('\n─── DocChunkStore: Atomic Re-indexing ───');

{
  const db = makeDb();
  const store = new DocChunkStore(db);

  // Index v1
  const v1chunks = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/POLICY.md',
    scope: 'shared-fleet',
  });
  const r1 = store.indexChunks(v1chunks);
  assert(r1.inserted > 0, 'V1 indexed');

  // Index v2 (different content)
  const modifiedPolicy = POLICY_LIKE + '\n## §4 New Section\n\nThis section was added in a policy update with important new governance rules that agents must follow.\n';
  const v2chunks = chunkMarkdown(modifiedPolicy, {
    collection: 'governance/policy',
    sourcePath: '/workspace/POLICY.md',
    scope: 'shared-fleet',
  });
  const r2 = store.indexChunks(v2chunks);

  assert(r2.reindexed, 'V2 triggers re-index (hash changed)');
  assert(r2.deleted > 0, 'Stale V1 chunks deleted');
  assert(r2.inserted > 0, 'New V2 chunks inserted');

  // Verify new chunk is there, old hashes are gone
  const retrieved = store.queryChunks({ collection: 'governance/policy' });
  assert(retrieved.some(c => c.content.includes('§4 New Section') || c.sectionPath.includes('§4 New Section') || c.content.includes('policy update')), 'New §4 section chunk present');
  assert(retrieved.every(c => c.sourceHash === v2chunks[0].sourceHash), 'All chunks have V2 hash (no stale chunks)');
}

console.log('\n─── DocChunkStore: FTS5 Keyword Search ───');

{
  const db = makeDb();
  const store = new DocChunkStore(db);

  const chunks = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/POLICY.md',
    scope: 'shared-fleet',
  });
  store.indexChunks(chunks);

  // Search for a specific term
  const results = store.keywordSearch('escalation', { collection: 'governance/policy' });
  assert(results.length > 0, 'FTS5 finds "escalation" keyword');
  assert(results[0].content.toLowerCase().includes('escalat'), 'Returned chunk contains "escalat"');
}

console.log('\n─── DocChunkStore: Cross-Source Isolation ───');

{
  // Two files with identical content — must not collide in doc_chunks
  const db = makeDb();
  const store = new DocChunkStore(db);

  const chunksA = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/agentA/POLICY.md',
    scope: 'shared-fleet',
  });
  const chunksB = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/agentB/POLICY.md',
    scope: 'shared-fleet',
  });

  const r1 = store.indexChunks(chunksA);
  const r2 = store.indexChunks(chunksB);

  assert(r1.inserted > 0, 'First source indexed');
  assert(r2.inserted > 0, 'Second source indexed (no collision)');

  // Both sources tracked
  const sources = store.listSources({ collection: 'governance/policy' });
  assert(sources.length === 2, `Both sources tracked (got ${sources.length})`);
  assert(sources.some(s => s.sourcePath.includes('agentA')), 'Source A tracked');
  assert(sources.some(s => s.sourcePath.includes('agentB')), 'Source B tracked');

  // Total chunks = both sets (no overwrite)
  const allChunks = store.queryChunks({ collection: 'governance/policy', limit: 100 });
  assert(allChunks.length === chunksA.length + chunksB.length,
    `Total chunks = A + B (${allChunks.length} === ${chunksA.length + chunksB.length})`);
}

console.log('\n─── DocChunkStore: FTS Relevance Over Sort Order ───');

{
  // Reviewer's repro: alphabetically-first sections should NOT beat the actually-relevant one
  const db = makeDb();
  const store = new DocChunkStore(db);

  const content = `# Policy

## Aardvark Section

This section covers aardvark-related operational procedures for the fleet.

## Billing Rules

This section describes billing rules and payment processing procedures.

## Escalation Procedures

This section describes escalation triggers and mandatory human review requirements.
All agents must escalate when facing policy conflicts or irreversible actions.

## Zebra Section

This section covers zebra-related operational procedures for the fleet.
`;

  const chunks = chunkMarkdown(content, {
    collection: 'governance/policy',
    sourcePath: '/workspace/POLICY.md',
    scope: 'shared-fleet',
  });
  store.indexChunks(chunks);

  // Without keyword: returns by depth/section_path order (alphabetical)
  const byOrder = store.queryChunks({ collection: 'governance/policy', limit: 2 });
  assert(byOrder.length > 0, 'Order-based query returns results');

  // With FTS keyword: should return Escalation first
  const byKeyword = store.keywordSearch('escalation', { collection: 'governance/policy', limit: 2 });
  assert(byKeyword.length > 0, 'FTS keyword search returns results');
  assert(byKeyword[0].sectionPath.toLowerCase().includes('escalat'),
    `FTS returns Escalation section first (got: ${byKeyword[0].sectionPath})`);
}

console.log('\n─── DocChunkStore: Stats ───');

{
  const db = makeDb();
  const store = new DocChunkStore(db);

  const chunks1 = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/POLICY.md',
    scope: 'shared-fleet',
  });
  const chunks2 = chunkMarkdown(SIMPLE_MARKDOWN, {
    collection: 'operations/agents',
    sourcePath: '/workspace/AGENTS.md',
    scope: 'per-tier',
    tier: 'council',
  });

  store.indexChunks(chunks1);
  store.indexChunks(chunks2);

  const stats = store.getStats();
  assert(stats.length === 2, 'Stats shows 2 collections');

  const policyStats = stats.find(s => s.collection === 'governance/policy');
  assert(policyStats !== undefined, 'Policy collection in stats');
  assert(policyStats.count === chunks1.length, `Policy chunk count matches (${policyStats.count})`);
  assert(policyStats.totalTokens > 0, 'Policy total tokens > 0');
}

console.log('\n─── DocChunkStore: needsReindex ───');

{
  const db = makeDb();
  const store = new DocChunkStore(db);

  const chunks = chunkMarkdown(POLICY_LIKE, {
    collection: 'governance/policy',
    sourcePath: '/workspace/POLICY.md',
    scope: 'shared-fleet',
  });

  // Before indexing — needs reindex
  assert(store.needsReindex('/workspace/POLICY.md', 'governance/policy', chunks[0].sourceHash), 'Needs reindex before first index');

  store.indexChunks(chunks);

  // After indexing with same hash — no reindex needed
  assert(!store.needsReindex('/workspace/POLICY.md', 'governance/policy', chunks[0].sourceHash), 'No reindex needed after index with same hash');

  // Different hash — needs reindex
  assert(store.needsReindex('/workspace/POLICY.md', 'governance/policy', 'differenthash'), 'Needs reindex with different hash');
}

// ─── Suite 3: WorkspaceSeeder ────────────────────────────────────

console.log('\n─── WorkspaceSeeder: Seed Workspace ───');

{
  const db = makeDb();
  const seeder = new WorkspaceSeeder(db);
  const tmpDir = makeTempDir();

  try {
    // Write test ACA files
    writeFileSync(path.join(tmpDir, 'POLICY.md'), POLICY_LIKE);
    writeFileSync(path.join(tmpDir, 'AGENTS.md'), SIMPLE_MARKDOWN);

    const result = await seeder.seedWorkspace(tmpDir, { agentId: 'agent-alpha', tier: 'council' });

    assert(result.totalInserted > 0, `Seeded ${result.totalInserted} chunks`);
    assert(result.errors.length === 0, 'No errors during seeding');
    assert(result.files.some(f => f.collection === 'governance/policy'), 'POLICY.md seeded as governance/policy');
    assert(result.files.some(f => f.collection === 'operations/agents'), 'AGENTS.md seeded as operations/agents');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
}

console.log('\n─── WorkspaceSeeder: Idempotency ───');

{
  const db = makeDb();
  const seeder = new WorkspaceSeeder(db);
  const tmpDir = makeTempDir();

  try {
    writeFileSync(path.join(tmpDir, 'POLICY.md'), POLICY_LIKE);

    const r1 = await seeder.seedWorkspace(tmpDir, { agentId: 'agent-alpha' });
    assert(r1.totalInserted > 0, 'First seed inserts chunks');
    assert(r1.skipped === 0, 'Nothing skipped on first seed');

    const r2 = await seeder.seedWorkspace(tmpDir, { agentId: 'agent-alpha' });
    assert(r2.totalInserted === 0, 'Second seed inserts nothing (unchanged)');
    assert(r2.skipped === 1, 'Unchanged file skipped on second seed');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
}

console.log('\n─── WorkspaceSeeder: Force Re-index ───');

{
  const db = makeDb();
  const seeder = new WorkspaceSeeder(db);
  const tmpDir = makeTempDir();

  try {
    writeFileSync(path.join(tmpDir, 'POLICY.md'), POLICY_LIKE);

    const r1 = await seeder.seedWorkspace(tmpDir, { agentId: 'agent-alpha' });
    assert(r1.totalInserted > 0, 'First seed inserts chunks');

    const r2 = await seeder.seedWorkspace(tmpDir, { agentId: 'agent-alpha', force: true });
    assert(r2.totalInserted > 0, 'Force re-index inserts chunks even if unchanged');
    assert(r2.reindexed === 0, 'Force re-index deletes source before insert (treated as first-time)');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
}

console.log('\n─── WorkspaceSeeder: Daily Memory Files ───');

{
  const db = makeDb();
  const seeder = new WorkspaceSeeder(db);
  const tmpDir = makeTempDir();
  const memDir = path.join(tmpDir, 'memory');
  mkdirSync(memDir, { recursive: true });

  try {
    writeFileSync(path.join(memDir, '2026-03-31.md'), `## Today's Work\n\nBuilt the chunk ingestion pipeline for HyperMem. This includes the section-aware markdown parser, the DocChunkStore with atomic re-indexing, and the WorkspaceSeeder.\n\n## Key Decisions\n\nDecided to use section-level chunking instead of token count because governance docs have interdependent sections that must be kept together as coherent units.\n`);
    writeFileSync(path.join(memDir, '2026-03-30.md'), `## Yesterday's Work\n\nImplemented the token-bucket rate limiter for embedding API calls. The key bug was that unref() on the interval timer prevented Promise resolution in top-level await contexts.\n\n## Key Decisions\n\nFixed unref() bug and added priority queue with reserved tokens for high-priority recall operations.\n`);

    const result = await seeder.seedWorkspace(tmpDir, {
      agentId: 'agent-alpha',
      includeDailyMemory: true,
      dailyMemoryLimit: 5,
    });

    const memoryFiles = result.files.filter(f => f.collection === 'memory/daily');
    assert(memoryFiles.length === 2, `Seeded ${memoryFiles.length} daily memory files`);
    assert(result.totalInserted > 0, 'Daily memory chunks inserted');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
}

console.log('\n─── WorkspaceSeeder: Query After Seed ───');

{
  const db = makeDb();
  const seeder = new WorkspaceSeeder(db);
  const tmpDir = makeTempDir();

  try {
    writeFileSync(path.join(tmpDir, 'POLICY.md'), POLICY_LIKE);

    await seeder.seedWorkspace(tmpDir, { agentId: 'agent-alpha', tier: 'council' });

    const chunks = seeder.queryChunks('governance/policy', { limit: 10 });
    assert(chunks.length > 0, 'Can query chunks after seeding');
    assert(chunks[0].collection === 'governance/policy', 'Chunks have correct collection');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
}

console.log('\n─── WorkspaceSeeder: Index Stats ───');

{
  const db = makeDb();
  const seeder = new WorkspaceSeeder(db);
  const tmpDir = makeTempDir();

  try {
    writeFileSync(path.join(tmpDir, 'POLICY.md'), POLICY_LIKE);
    writeFileSync(path.join(tmpDir, 'COMMS.md'), SIMPLE_MARKDOWN);

    await seeder.seedWorkspace(tmpDir, { agentId: 'agent-alpha' });

    const stats = seeder.getIndexStats();
    assert(stats.length >= 2, `Stats shows ${stats.length} collections (≥ 2)`);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
}

// ─── Suite 4: inferCollection ────────────────────────────────────

console.log('\n─── inferCollection ───');

{
  assert(inferCollection('POLICY.md')?.collection === 'governance/policy', 'POLICY.md → governance/policy');
  assert(inferCollection('CHARTER.md')?.collection === 'governance/charter', 'CHARTER.md → governance/charter');
  assert(inferCollection('COMMS.md')?.collection === 'governance/comms', 'COMMS.md → governance/comms');
  assert(inferCollection('AGENTS.md')?.collection === 'operations/agents', 'AGENTS.md → operations/agents');
  assert(inferCollection('TOOLS.md')?.collection === 'operations/tools', 'TOOLS.md → operations/tools');
  assert(inferCollection('SOUL.md')?.collection === 'identity/soul', 'SOUL.md → identity/soul');
  assert(inferCollection('JOB.md')?.collection === 'identity/job', 'JOB.md → identity/job');
  assert(inferCollection('MEMORY.md')?.collection === 'memory/decisions', 'MEMORY.md → memory/decisions');
  assert(inferCollection('2026-03-31.md')?.collection === 'memory/daily', 'YYYY-MM-DD.md → memory/daily');
  assert(inferCollection('UNKNOWN.md') === undefined, 'Unknown file → undefined');
}

// ─── Results ────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════════════');
if (failed === 0) {
  console.log(`  ALL ${passed} TESTS PASSED ✅`);
} else {
  console.log(`  ${passed} PASSED, ${failed} FAILED ❌`);
  process.exit(1);
}
console.log('═══════════════════════════════════════════════════\n');
