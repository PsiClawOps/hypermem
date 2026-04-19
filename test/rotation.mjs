/**
 * Message database rotation tests.
 *
 * Tests:
 *   1. Size detection and threshold check
 *   2. Rotation renames and creates fresh DB
 *   3. Rotated files follow naming convention (YYYYQN)
 *   4. Collision handling on same-quarter rotation
 *   5. Fresh DB gets new schema after rotation
 *   6. Rotated files are listed correctly
 *   7. Auto-rotate scans all agents
 *   8. WAL/SHM cleanup on rotation
 */

import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rotation-'));

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
  console.log('  HyperMem Message Rotation Test');
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

  // ── Test 1: Size detection ──
  console.log('── Size Detection ──');

  const agentId = 'test-agent';
  const sessionKey = 'agent:test-agent:webchat:main';

  // Create some data
  await hm.recordUserMessage(agentId, sessionKey, 'Hello world', {
    channelType: 'webchat',
  });

  const size = hm.getMessageDbSize(agentId);
  assert(size > 0, `Message DB size: ${size} bytes`);

  // ── Test 2: shouldRotate with default thresholds ──
  console.log('\n── Rotation Threshold Check ──');

  // Default threshold is 100MB — our test DB is tiny
  const check1 = hm.shouldRotate(agentId);
  assert(check1 === null, 'Small DB does not need rotation');

  // Test with very low threshold
  const check2 = hm.shouldRotate(agentId, { maxSizeBytes: 1 }); // 1 byte threshold
  assert(check2 !== null, 'DB exceeds 1 byte threshold');
  assert(check2.reason === 'size', 'Reason is size');
  assert(check2.current > 1, `Current size: ${check2.current}`);
  assert(check2.threshold === 1, 'Threshold is 1');

  // ── Test 3: Rotation ──
  console.log('\n── Database Rotation ──');

  // Add more data so there's something to rotate
  for (let i = 0; i < 20; i++) {
    await hm.recordUserMessage(agentId, sessionKey, `Message ${i}: ${'x'.repeat(100)}`, {
      channelType: 'webchat',
    });
  }

  const preSize = hm.getMessageDbSize(agentId);
  assert(preSize > 0, `Pre-rotation size: ${preSize}`);

  const rotatedPath = hm.rotateMessageDb(agentId);
  assert(rotatedPath !== null, 'Rotation returned path');
  assert(fs.existsSync(rotatedPath), 'Rotated file exists');
  assert(rotatedPath.includes('messages_'), 'Rotated file follows naming convention');
  assert(rotatedPath.endsWith('.db'), 'Rotated file has .db extension');

  // Extract name from path
  const rotatedName = path.basename(rotatedPath);
  const match = rotatedName.match(/^messages_(\d{4})Q(\d)\.db$/);
  assert(match !== null, `Name matches YYYYQN pattern: ${rotatedName}`);

  // ── Test 4: Fresh DB after rotation ──
  console.log('\n── Fresh DB After Rotation ──');

  // New DB should be created on next access
  const postSize = hm.getMessageDbSize(agentId);
  // New DB is empty or just has schema
  assert(postSize === 0 || postSize < preSize, `Post-rotation size: ${postSize} (was ${preSize})`);

  // Should be able to write to the fresh DB
  await hm.recordUserMessage(agentId, sessionKey, 'After rotation', {
    channelType: 'webchat',
  });
  const afterWrite = hm.getMessageDbSize(agentId);
  assert(afterWrite > 0, `After writing to fresh DB: ${afterWrite}`);

  // ── Test 5: Collision handling ──
  console.log('\n── Collision Handling ──');

  // Rotate again — same quarter, should get suffix
  const rotated2 = hm.rotateMessageDb(agentId);
  assert(rotated2 !== null, 'Second rotation succeeded');
  assert(rotated2 !== rotatedPath, 'Different path from first rotation');
  assert(fs.existsSync(rotated2), 'Second rotated file exists');
  const name2 = path.basename(rotated2);
  assert(name2.includes('_1'), `Collision suffix: ${name2}`);

  // ── Test 6: listRotatedDbs ──
  console.log('\n── List Rotated DBs ──');

  const rotated = hm.listRotatedDbs(agentId);
  assert(rotated.length === 2, `Found ${rotated.length} rotated DBs`);
  assert(rotated.every(f => f.startsWith('messages_')), 'All follow naming convention');
  assert(rotated.every(f => f.endsWith('.db')), 'All have .db extension');

  // ── Test 7: Auto-rotate ──
  console.log('\n── Auto-Rotate ──');

  // Create a second agent with data
  const agent2 = 'test-agent-2';
  await hm.recordUserMessage(agent2, 'agent:test-agent-2:webchat:main', 'Hello from agent 2', {
    channelType: 'webchat',
  });

  // Auto-rotate with very low threshold
  const autoResult = hm.autoRotate({ maxSizeBytes: 1 });
  assert(autoResult.length >= 1, `Auto-rotated ${autoResult.length} agents`);
  assert(autoResult.every(r => r.reason.includes('size')), 'All rotated for size');
  assert(autoResult.every(r => fs.existsSync(r.rotatedTo)), 'All rotated files exist');

  // ── Test 8: WAL/SHM cleanup ──
  console.log('\n── WAL/SHM Cleanup ──');

  // Create a new agent and write to it to generate WAL
  const agent3 = 'test-agent-3';
  for (let i = 0; i < 10; i++) {
    await hm.recordUserMessage(agent3, 'agent:test-agent-3:webchat:main', `Msg ${i}`, {
      channelType: 'webchat',
    });
  }

  const agentDir = path.join(tmpDir, 'agents', agent3);
  const walExists = fs.existsSync(path.join(agentDir, 'messages.db-wal'));
  // WAL may or may not exist depending on checkpoint behavior — that's fine

  hm.rotateMessageDb(agent3);
  const walAfter = fs.existsSync(path.join(agentDir, 'messages.db-wal'));
  const shmAfter = fs.existsSync(path.join(agentDir, 'messages.db-shm'));
  assert(!walAfter, 'WAL file cleaned up after rotation');
  assert(!shmAfter, 'SHM file cleaned up after rotation');

  // ── Test 9: Rotation of non-existent agent ──
  console.log('\n── Edge Cases ──');

  const noAgent = hm.rotateMessageDb('nonexistent');
  assert(noAgent === null, 'Non-existent agent returns null');

  const noCheck = hm.shouldRotate('nonexistent');
  assert(noCheck === null, 'Non-existent agent shouldRotate returns null');

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
