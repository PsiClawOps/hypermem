/**
 * Keystone History Slot Test (P2.1)
 *
 * Tests:
 *   1. Scorer function with known inputs
 *   2. Keystones NOT injected for short conversations (<30 messages)
 *   3. Keystones ARE injected for long conversations (≥30 messages)
 *   4. Budget compliance (keystone tokens don't exceed allocated budget)
 *   5. Content-type bonus (decisions score higher than discussion)
 */

import { scoreKeystone, rankKeystones } from '../dist/keystone-scorer.js';
import { HyperMem } from '../dist/index.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-keystone-'));

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

function approx(a, b, tolerance = 0.01) {
  return Math.abs(a - b) <= tolerance;
}

// ─── Helper: seed N messages into a conversation ────────────────

function seedMessages(db, convId, agentId, count, opts = {}) {
  const { startIndex = 1, hoursAgo = 48, rolePattern = ['user', 'assistant'] } = opts;
  for (let i = 0; i < count; i++) {
    const idx = startIndex + i;
    const role = rolePattern[i % rolePattern.length];
    const msAgo = (hoursAgo + (count - i) * 0.1) * 60 * 60 * 1000;
    const createdAt = new Date(Date.now() - msAgo).toISOString();
    const text = opts.textFn
      ? opts.textFn(i, role)
      : `${role === 'user' ? 'User message' : 'Assistant response'} number ${idx}`;
    db.prepare(`
      INSERT INTO messages
        (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `).run(convId, agentId, role, text, idx, createdAt);
  }
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Keystone History Slot Test (P2.1)');
  console.log('═══════════════════════════════════════════════════\n');

  // ──────────────────────────────────────────────────────────────
  // 1. Scorer function with known inputs
  // ──────────────────────────────────────────────────────────────
  console.log('── 1. Scorer function ──\n');

  // Base case: 0.5 significance, 0.8 ftsRank, 0 ageHours (fresh)
  const baseScore = scoreKeystone({
    messageId: 1,
    messageIndex: 1,
    role: 'user',
    content: 'This is a general discussion message about various things.',
    timestamp: new Date().toISOString(),
    episodeSignificance: 0.5,
    ftsRank: 0.8,
    ageHours: 0,
  }, 720);
  // Expected: 0.5*0.5 + 0.8*0.3 + 1.0*0.2 = 0.25 + 0.24 + 0.20 = 0.69
  assert(approx(baseScore, 0.69, 0.01), `Base score ≈ 0.69 (got ${baseScore.toFixed(4)})`);

  // No episode linkage (significance defaults to 0.3)
  const noEpisodeScore = scoreKeystone({
    messageId: 2,
    messageIndex: 2,
    role: 'assistant',
    content: 'Just a regular discussion message with no special significance.',
    timestamp: new Date().toISOString(),
    episodeSignificance: null,
    ftsRank: 0.5,
    ageHours: 100,
  }, 720);
  // Expected: 0.3*0.5 + 0.5*0.3 + (1 - 100/720)*0.2 = 0.15 + 0.15 + 0.172 = 0.472
  assert(approx(noEpisodeScore, 0.472, 0.02), `No-episode score ≈ 0.472 (got ${noEpisodeScore.toFixed(4)})`);

  // High significance, no FTS match, very old
  const oldHighSigScore = scoreKeystone({
    messageId: 3,
    messageIndex: 3,
    role: 'user',
    content: 'We decided to use the four-layer architecture.',
    timestamp: new Date().toISOString(),
    episodeSignificance: 0.9,
    ftsRank: 0.0,
    ageHours: 700,
  }, 720);
  // Expected: 0.9*0.5 + 0*0.3 + (1-700/720)*0.2 = 0.45 + 0 + 0.00556 ≈ 0.456
  // Plus decision bonus: min(1.0, 0.456 + 0.1) = 0.556
  assert(approx(oldHighSigScore, 0.556, 0.02), `Old high-sig decision score ≈ 0.556 (got ${oldHighSigScore.toFixed(4)})`);

  // Score capped at 1.0
  const cappedScore = scoreKeystone({
    messageId: 4,
    messageIndex: 4,
    role: 'user',
    content: 'We decided on the architecture approach. This is confirmed.',
    timestamp: new Date().toISOString(),
    episodeSignificance: 1.0,
    ftsRank: 1.0,
    ageHours: 0,
  }, 720);
  // Without cap: 1.0*0.5 + 1.0*0.3 + 1.0*0.2 = 1.0, plus 0.1 decision bonus → capped at 1.0
  assert(cappedScore <= 1.0, `Score capped at 1.0 (got ${cappedScore.toFixed(4)})`);
  assert(approx(cappedScore, 1.0, 0.001), `Max score = 1.0 (got ${cappedScore.toFixed(4)})`);

  // ftsRank clamped: negative ftsRank becomes 0
  const negFtsScore = scoreKeystone({
    messageId: 5,
    messageIndex: 5,
    role: 'assistant',
    content: 'Some discussion about what we need to figure out.',
    timestamp: new Date().toISOString(),
    episodeSignificance: 0.5,
    ftsRank: -0.5,  // invalid — should be clamped to 0
    ageHours: 0,
  }, 720);
  // Expected: 0.5*0.5 + 0*0.3 + 1.0*0.2 = 0.45 (discussion, no bonus)
  assert(approx(negFtsScore, 0.45, 0.01), `Negative ftsRank clamped to 0 (got ${negFtsScore.toFixed(4)})`);

  // Beyond max age: recencyFactor = 0
  const beyondAgeScore = scoreKeystone({
    messageId: 6,
    messageIndex: 6,
    role: 'user',
    content: 'A very old discussion message.',
    timestamp: new Date(Date.now() - 800 * 3600 * 1000).toISOString(),
    episodeSignificance: 0.5,
    ftsRank: 0.5,
    ageHours: 800,  // beyond maxAgeHours=720
  }, 720);
  // Expected: 0.5*0.5 + 0.5*0.3 + 0*0.2 = 0.25 + 0.15 = 0.40
  assert(approx(beyondAgeScore, 0.40, 0.01), `Beyond-age recencyFactor=0 (got ${beyondAgeScore.toFixed(4)})`);

  // ─── Content-type bonus ──────────────────────────────────────
  console.log('\n── 5. Content-type bonus ──\n');

  const decisionContent = 'We decided to use SQLite for the cursor durability approach.';
  const discussionContent = 'Maybe we could explore what options are available here.';

  const decisionScore = scoreKeystone({
    messageId: 10,
    messageIndex: 10,
    role: 'user',
    content: decisionContent,
    timestamp: new Date().toISOString(),
    episodeSignificance: 0.5,
    ftsRank: 0.5,
    ageHours: 0,
  }, 720);

  const discussionScore = scoreKeystone({
    messageId: 11,
    messageIndex: 11,
    role: 'user',
    content: discussionContent,
    timestamp: new Date().toISOString(),
    episodeSignificance: 0.5,
    ftsRank: 0.5,
    ageHours: 0,
  }, 720);

  // Decision gets +0.1 bonus over discussion (same other signals)
  assert(decisionScore > discussionScore, `Decision scores higher than discussion (${decisionScore.toFixed(3)} > ${discussionScore.toFixed(3)})`);
  assert(approx(decisionScore - discussionScore, 0.1, 0.01), `Decision bonus is ~0.1 (diff=${(decisionScore - discussionScore).toFixed(4)})`);

  // Spec content also gets bonus
  const specContent = 'The architecture is a four-layer system with Redis L1, SQLite L2, Vectors L3, Library L4.';
  const specScore = scoreKeystone({
    messageId: 12,
    messageIndex: 12,
    role: 'assistant',
    content: specContent,
    timestamp: new Date().toISOString(),
    episodeSignificance: 0.5,
    ftsRank: 0.5,
    ageHours: 0,
  }, 720);
  assert(specScore > discussionScore, `Spec scores higher than discussion (${specScore.toFixed(3)} > ${discussionScore.toFixed(3)})`);

  // ─── rankKeystones ───────────────────────────────────────────
  console.log('\n── rankKeystones() ordering ──\n');

  const candidates = [
    {
      messageId: 20, messageIndex: 20, role: 'user',
      content: 'Some vague discussion about future options.',
      timestamp: new Date().toISOString(),
      episodeSignificance: 0.3, ftsRank: 0.2, ageHours: 100,
    },
    {
      messageId: 21, messageIndex: 21, role: 'user',
      content: 'We decided to use the FTS5 index for message search.',
      timestamp: new Date().toISOString(),
      episodeSignificance: 0.8, ftsRank: 0.9, ageHours: 10,
    },
    {
      messageId: 22, messageIndex: 22, role: 'assistant',
      content: 'Confirmed. The architecture schema is correct.',
      timestamp: new Date().toISOString(),
      episodeSignificance: 0.6, ftsRank: 0.7, ageHours: 50,
    },
  ];

  const ranked = rankKeystones(candidates, 720);
  assert(ranked.length === 3, `rankKeystones returns all 3 candidates`);
  assert(ranked[0].score >= ranked[1].score, `rankKeystones sorted descending: [0] >= [1]`);
  assert(ranked[1].score >= ranked[2].score, `rankKeystones sorted descending: [1] >= [2]`);
  // The high-significance decision should rank first
  assert(ranked[0].messageId === 21, `Highest-signal candidate ranked first (id=21, score=${ranked[0].score.toFixed(3)})`);
  // All have score field
  assert(ranked.every(r => typeof r.score === 'number'), `All ranked candidates have score field`);

  // ──────────────────────────────────────────────────────────────
  // 2 & 3. Short vs long conversation keystone injection
  // ──────────────────────────────────────────────────────────────
  console.log('\n── 2+3. Short vs long conversation injection ──\n');

  let hm;
  try {
    hm = await HyperMem.create({
      dataDir: tmpDir,
    });
  } catch (err) {
    console.log(`  ❌ Failed to create HyperMem: ${err.message}`);
    process.exit(1);
  }

  const agentId = 'keystone-test';
  const db = hm.dbManager.getMessageDb(agentId);

  // ── Short conversation (<30 messages) ────────────────────────
  const shortSessionKey = 'agent:keystone-test:webchat:short';
  db.prepare(`
    INSERT INTO conversations
      (session_key, session_id, agent_id, channel_type, status, message_count,
       token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-short', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(shortSessionKey, agentId);

  const shortConvRow = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(shortSessionKey);
  const shortConvId = shortConvRow.id;

  // Seed 10 messages total (5 old, 5 recent)
  seedMessages(db, shortConvId, agentId, 5, {
    startIndex: 1,
    hoursAgo: 72,
    textFn: (i) => `Old message ${i + 1}: We talked about things and explored options.`,
  });
  seedMessages(db, shortConvId, agentId, 5, {
    startIndex: 6,
    hoursAgo: 1,
    textFn: (i) => `Recent message ${i + 6}: The current conversation is happening.`,
  });

  // Warm session
  await hm.compositor.warmSession(agentId, shortSessionKey, db);

  const shortResult = await hm.compositor.compose({
    agentId,
    sessionKey: shortSessionKey,
    tokenBudget: 50000,
    skipProviderTranslation: true,
  }, db);

  // Should NOT have keystone separators for short conversation
  const shortAllText = shortResult.messages
    .filter(m => m.role === 'system')
    .map(m => m.content || '')
    .join('\n');
  assert(
    !shortAllText.includes('Recalled Context'),
    `Short conversation: NO keystone injection (< 30 messages)`
  );
  assert(
    !shortResult.warnings?.some(w => w.includes('Keystone')),
    `Short conversation: no Keystone warning`
  );

  // ── Long conversation (≥30 messages) ─────────────────────────
  const longSessionKey = 'agent:keystone-test:webchat:long';
  db.prepare(`
    INSERT INTO conversations
      (session_key, session_id, agent_id, channel_type, status, message_count,
       token_count_in, token_count_out, created_at, updated_at)
    VALUES (?, 'sess-long', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(longSessionKey, agentId);

  const longConvRow = db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(longSessionKey);
  const longConvId = longConvRow.id;

  // Seed 60 older messages (will fall before the recent window)
  seedMessages(db, longConvId, agentId, 60, {
    startIndex: 1,
    hoursAgo: 96,
    textFn: (i, role) => {
      if (i === 5 && role === 'user') return 'We decided to use the four-layer architecture for HyperMem. This is our confirmed approach.';
      if (i === 10 && role === 'user') return 'The plan is to deploy the keystone scorer to production this week.';
      return `${role === 'user' ? 'User' : 'Assistant'} message ${i + 1} from older history.`;
    },
  });

  // Seed 40 recent messages (will be the recent window)
  seedMessages(db, longConvId, agentId, 40, {
    startIndex: 61,
    hoursAgo: 2,
    textFn: (i, role) => `${role === 'user' ? 'User' : 'Assistant'} recent message ${i + 61} about current work.`,
  });

  // Warm session
  await hm.compositor.warmSession(agentId, longSessionKey, db);

  // Use historyDepth=40 so the compositor only fetches the 40 most recent
  // messages as history. The 60 older messages remain in the DB, reachable
  // by the keystone query (which looks for messages older than the cutoff).
  const longResult = await hm.compositor.compose({
    agentId,
    sessionKey: longSessionKey,
    tokenBudget: 50000,
    historyDepth: 40,
    prompt: 'Tell me about the architecture decisions we made.',
    skipProviderTranslation: true,
  }, db);

  const longSystemTexts = longResult.messages
    .filter(m => m.role === 'system')
    .map(m => {
      // NeutralMessage in skipProviderTranslation mode keeps textContent
      const msg = m;
      return msg.textContent || msg.content || '';
    })
    .join('\n');

  assert(
    longSystemTexts.includes('Recalled Context'),
    `Long conversation: keystone separator injected ("Recalled Context" found)`
  );
  assert(
    longSystemTexts.includes('Recent Conversation'),
    `Long conversation: recent conversation separator injected`
  );
  assert(
    longResult.warnings?.some(w => w.includes('Keystone')),
    `Long conversation: Keystone warning present (${longResult.warnings?.join(', ')})`
  );

  // ──────────────────────────────────────────────────────────────
  // 4. Budget compliance
  // ──────────────────────────────────────────────────────────────
  console.log('\n── 4. Budget compliance ──\n');

  // The keystone budget is 20% of historyTokens.
  // Total token count should be within the overall budget.
  assert(
    longResult.tokenCount <= 50000,
    `Token count within budget (${longResult.tokenCount} ≤ 50000)`
  );

  // History slot should account for both recent + keystone tokens
  // (it's the sum: trimmedHistoryTokens + keystoneTokens + sepTokens)
  assert(
    longResult.slots.history > 0,
    `History slot is non-zero (${longResult.slots.history})`
  );

  // Verify keystones appear BEFORE the recent conversation in message order
  const allMessages = longResult.messages;
  const recalledIdx = allMessages.findIndex(m => {
    const text = m.textContent || m.content || '';
    return typeof text === 'string' && text.includes('Recalled Context');
  });
  const recentIdx = allMessages.findIndex(m => {
    const text = m.textContent || m.content || '';
    return typeof text === 'string' && text.includes('Recent Conversation');
  });

  assert(recalledIdx >= 0, `"Recalled Context" separator found in messages (idx=${recalledIdx})`);
  assert(recentIdx >= 0, `"Recent Conversation" separator found in messages (idx=${recentIdx})`);
  assert(
    recalledIdx < recentIdx,
    `Keystones come before recent conversation (recalled=${recalledIdx}, recent=${recentIdx})`
  );

  // Count keystone messages (between the two separators)
  const keystoneCount = recentIdx - recalledIdx - 1;
  assert(keystoneCount > 0, `At least 1 keystone message injected (got ${keystoneCount})`);
  assert(keystoneCount <= 15, `Keystone count within max limit (${keystoneCount} ≤ 15)`);

  // Estimate keystone tokens
  let keystoneTokenSum = 0;
  for (let i = recalledIdx + 1; i < recentIdx; i++) {
    const text = allMessages[i].textContent || allMessages[i].content || '';
    keystoneTokenSum += Math.ceil((typeof text === 'string' ? text.length : JSON.stringify(text).length) / 4) + 4;
  }

  // Recent history tokens (after recentIdx separator)
  let recentTokenSum = 0;
  for (let i = recentIdx + 1; i < allMessages.length; i++) {
    if (allMessages[i].role === 'system') continue; // skip other system msgs
    const text = allMessages[i].textContent || allMessages[i].content || '';
    recentTokenSum += Math.ceil((typeof text === 'string' ? text.length : JSON.stringify(text).length) / 4) + 4;
  }

  // Keystone budget should be ~20% of (keystone + recent) combined
  const combinedHistory = keystoneTokenSum + recentTokenSum;
  const keystoneFraction = combinedHistory > 0 ? keystoneTokenSum / combinedHistory : 0;
  assert(
    keystoneFraction <= 0.5,  // keystone shouldn't dominate
    `Keystone fraction within bounds (${(keystoneFraction * 100).toFixed(1)}% ≤ 50%)`
  );

  // ── Cleanup ──

  // ──────────────────────────────────────────────────────────────
  // Summary
  // ──────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  if (failed === 0) {
    console.log(`  ALL ${passed} TESTS PASSED ✅`);
  } else {
    console.log(`  ${passed} passed, ${failed} FAILED ❌`);
  }
  console.log('═══════════════════════════════════════════════════');

  // Cleanup tmpDir
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
