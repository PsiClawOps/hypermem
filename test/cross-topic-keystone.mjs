/**
 * Cross-topic keystone retrieval tests (P3.5)
 */

import { DatabaseSync } from 'node:sqlite';
import { Compositor } from '../dist/compositor.js';
import { migrate } from '../dist/schema.js';

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

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg) {
  return estimateTokens(msg.textContent) + 4;
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

function makeCompositor() {
  const fakeVectorStore = {
    async search() { return []; },
  };

  const fakeCache = {
    async getSlot() { return null; },
    async getHistory() { return []; },
    async setWindow() {},
    async setCursor() {},
    async getQueryEmbedding() { return null; },
    async setTopicWindow() {},
    async replaceHistory() {},
    async warmSession() {},
  };

  return new Compositor({
    cache: fakeCache,
    vectorStore: fakeVectorStore,
    libraryDb: null,
  });
}

function seedConversation(db, sessionKey, agentId = 'forge') {
  db.prepare(`
    INSERT INTO conversations (
      session_key, session_id, agent_id, channel_type, status,
      message_count, token_count_in, token_count_out, created_at, updated_at
    ) VALUES (?, 'sess-1', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
  `).run(sessionKey, agentId);

  return db.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey).id;
}

function seedTopic(db, sessionKey, id, name, lastActiveAt) {
  db.prepare(`
    INSERT INTO topics (id, session_key, name, created_at, last_active_at, message_count, metadata)
    VALUES (?, ?, ?, ?, ?, 0, NULL)
  `).run(id, sessionKey, name, lastActiveAt - 1000, lastActiveAt);
}

function seedMessage(db, convId, { agentId = 'forge', role, text, idx, topicId, createdAt }) {
  db.prepare(`
    INSERT INTO messages (
      conversation_id, agent_id, role, text_content,
      message_index, is_heartbeat, created_at, topic_id
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
  `).run(convId, agentId, role, text, idx, createdAt, topicId ?? null);
}

function makeFakeTopicDb({ topics, messagesByTopic, throwOnTopicIds = [] }) {
  const throwSet = new Set(throwOnTopicIds);
  return {
    prepare(sql) {
      if (sql.includes('FROM topics')) {
        return {
          all(sessionKey, activeId) {
            return topics.filter(t => t.session_key === sessionKey && t.id !== activeId)
              .sort((a, b) => b.last_active_at - a.last_active_at)
              .slice(0, 5)
              .map(t => ({ id: t.id, name: t.name }));
          },
        };
      }

      if (sql.includes('JOIN conversations c ON m.conversation_id = c.id')) {
        return {
          all(sessionKey, agentId, topicId) {
            if (throwSet.has(topicId)) throw new Error('corrupt topic data');
            return messagesByTopic[topicId] ?? [];
          },
        };
      }

      throw new Error(`Unexpected SQL in fake DB: ${sql}`);
    },
  };
}

async function run() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  HyperMem Cross-Topic Keystone Test (P3.5)');
  console.log('═══════════════════════════════════════════════════\n');

  const sessionKey = 'agent:forge:webchat:main';
  const agentId = 'forge';

  // ── 1. No other topics -> empty + compose succeeds ─────────────
  console.log('── 1. No other topics ──\n');
  {
    const db = makeDb();
    const compositor = makeCompositor();
    const convId = seedConversation(db, sessionKey, agentId);
    const now = Date.now();

    seedTopic(db, sessionKey, 'topic-active', 'sessionless architecture', now);
    seedMessage(db, convId, {
      role: 'user',
      text: 'We need a sessionless architecture with stateless routing and topic-aware context.',
      idx: 1,
      topicId: 'topic-active',
      createdAt: new Date(now - 10_000).toISOString(),
    });
    seedMessage(db, convId, {
      role: 'assistant',
      text: 'Agreed. Topic-aware retrieval keeps context local while staying sessionless.',
      idx: 2,
      topicId: 'topic-active',
      createdAt: new Date(now - 9_000).toISOString(),
    });

    const currentMessages = [
      { role: 'user', textContent: 'sessionless architecture with stateless routing', toolCalls: null, toolResults: null },
    ];

    const cross = await compositor.getKeystonesByTopic(
      agentId,
      sessionKey,
      { id: 'topic-active', name: 'sessionless architecture' },
      currentMessages,
      db,
      3,
    );
    assert(Array.isArray(cross) && cross.length === 0, 'No other topics returns empty array');

    const result = await compositor.compose({
      agentId,
      sessionKey,
      topicId: 'topic-active',
      tokenBudget: 1200,
      includeFacts: false,
      includeContext: false,
      includeLibrary: false,
      includeDocChunks: false,
      skipProviderTranslation: true,
    }, db);

    assert(Array.isArray(result.messages), 'Compose succeeds with no other topics');
    assert((result.diagnostics?.crossTopicKeystones ?? 0) === 0, 'Compose diagnostics reports zero cross-topic keystones');
  }

  // ── 2. Other topics but no semantic overlap ───────────────────
  console.log('\n── 2. No semantic overlap ──\n');
  {
    const db = makeDb();
    const compositor = makeCompositor();
    const convId = seedConversation(db, sessionKey, agentId);
    const now = Date.now();

    seedTopic(db, sessionKey, 'topic-active', 'sessionless architecture', now);
    seedTopic(db, sessionKey, 'topic-other', 'garden planning', now - 1000);

    seedMessage(db, convId, {
      role: 'assistant',
      text: 'Tomatoes need more sun and less water this season.',
      idx: 1,
      topicId: 'topic-other',
      createdAt: new Date(now - 60_000).toISOString(),
    });

    const cross = await compositor.getKeystonesByTopic(
      agentId,
      sessionKey,
      { id: 'topic-active', name: 'sessionless architecture' },
      [{ role: 'user', textContent: 'stateless routing and topic context', toolCalls: null, toolResults: null }],
      db,
      3,
    );

    assert(cross.length === 0, 'Unrelated other-topic messages are filtered out');
  }

  // ── 3. Matching terms -> top 3 returned, scored descending ───
  console.log('\n── 3. Matching terms and scoring ──\n');
  {
    const db = makeDb();
    const compositor = makeCompositor();
    const convId = seedConversation(db, sessionKey, agentId);
    const now = Date.now();

    seedTopic(db, sessionKey, 'topic-active', 'sessionless architecture', now);
    seedTopic(db, sessionKey, 'topic-stabilization', 'HyperMem stabilization', now - 1000);
    seedTopic(db, sessionKey, 'topic-routing', 'Routing design', now - 2000);

    seedMessage(db, convId, {
      role: 'assistant',
      text: 'Decision: adopt sessionless architecture with stateless routing and topic-aware context retrieval.',
      idx: 1,
      topicId: 'topic-stabilization',
      createdAt: new Date(now - 5_000).toISOString(),
    });
    seedMessage(db, convId, {
      role: 'assistant',
      text: 'Spec: the architecture keeps sessionless routing, stateless workers, and topic context isolation.',
      idx: 2,
      topicId: 'topic-stabilization',
      createdAt: new Date(now - 6_000).toISOString(),
    });
    seedMessage(db, convId, {
      role: 'assistant',
      text: 'We should document stateless routing in the architecture notes for sessionless topic switching.',
      idx: 3,
      topicId: 'topic-routing',
      createdAt: new Date(now - 20_000).toISOString(),
    });
    seedMessage(db, convId, {
      role: 'assistant',
      text: 'General discussion about architecture and routing.',
      idx: 4,
      topicId: 'topic-routing',
      createdAt: new Date(now - 60_000).toISOString(),
    });

    const cross = await compositor.getKeystonesByTopic(
      agentId,
      sessionKey,
      { id: 'topic-active', name: 'sessionless architecture' },
      [
        { role: 'user', textContent: 'Need stateless routing and topic-aware sessionless context.', toolCalls: null, toolResults: null },
        { role: 'user', textContent: 'Keep architecture stable during topic switching.', toolCalls: null, toolResults: null },
      ],
      db,
      3,
    );

    assert(cross.length === 3, 'Top 3 matching cross-topic keystones are returned');
    assert(cross[0].score >= cross[1].score && cross[1].score >= cross[2].score, 'Cross-topic results are scored in descending order');
    assert(cross[0].content.includes('Decision:') || cross[0].content.includes('Spec:'), 'High-signal decision/spec content ranks at the top');
  }

  // ── 4. Deduplication by message id ────────────────────────────
  console.log('\n── 4. Deduplication ──\n');
  {
    const compositor = makeCompositor();
    const fakeDb = makeFakeTopicDb({
      topics: [
        { id: 'topic-a', name: 'A', session_key: sessionKey, last_active_at: 20 },
        { id: 'topic-b', name: 'B', session_key: sessionKey, last_active_at: 10 },
      ],
      messagesByTopic: {
        'topic-a': [
          { id: 42, message_index: 1, role: 'assistant', text_content: 'Decision: sessionless architecture uses stateless routing and topic isolation.', created_at: new Date().toISOString() },
        ],
        'topic-b': [
          { id: 42, message_index: 2, role: 'assistant', text_content: 'Decision: sessionless architecture uses stateless routing and topic isolation.', created_at: new Date().toISOString() },
        ],
      },
    });

    const cross = await compositor.getKeystonesByTopic(
      agentId,
      sessionKey,
      { id: 'topic-active', name: 'sessionless architecture' },
      [{ role: 'user', textContent: 'Need stateless routing and topic isolation', toolCalls: null, toolResults: null }],
      fakeDb,
      3,
    );

    assert(cross.length === 1, 'Duplicate message ids across topics are returned only once');
    assert(cross[0].messageId === 42, 'Deduplicated result keeps the original message id');
  }

  // ── 5. Token budget cap on cross-topic block ─────────────────
  console.log('\n── 5. Token budget cap ──\n');
  {
    const db = makeDb();
    const compositor = makeCompositor();
    const convId = seedConversation(db, sessionKey, agentId);
    const now = Date.now();

    seedTopic(db, sessionKey, 'topic-active', 'sessionless architecture', now);
    seedTopic(db, sessionKey, 'topic-other', 'HyperMem stabilization', now - 1000);

    seedMessage(db, convId, {
      role: 'user',
      text: 'We need sessionless architecture with stateless routing and topic-aware context retrieval.',
      idx: 1,
      topicId: 'topic-active',
      createdAt: new Date(now - 15_000).toISOString(),
    });
    seedMessage(db, convId, {
      role: 'assistant',
      text: 'Working on topic-aware retrieval now.',
      idx: 2,
      topicId: 'topic-active',
      createdAt: new Date(now - 14_000).toISOString(),
    });

    const longChunk = ' sessionless architecture stateless routing topic context retrieval'.repeat(4);
    for (let i = 0; i < 4; i++) {
      seedMessage(db, convId, {
        role: 'assistant',
        text: `Decision: keep${longChunk}`,
        idx: 10 + i,
        topicId: 'topic-other',
        createdAt: new Date(now - (60_000 + i * 1000)).toISOString(),
      });
    }

    const budget = 800;
    const result = await compositor.compose({
      agentId,
      sessionKey,
      topicId: 'topic-active',
      tokenBudget: budget,
      includeFacts: false,
      includeContext: false,
      includeLibrary: false,
      includeDocChunks: false,
      skipProviderTranslation: true,
    }, db);

    const messages = result.messages;
    const start = messages.findIndex(m => m.textContent === '## Cross-Topic Context');
    assert(start >= 0, 'Cross-topic block is injected when matching topic keystones exist');

    let crossTopicBlockTokens = 0;
    if (start >= 0) {
      for (let i = start; i < messages.length; i++) {
        if (i > start && messages[i].role === 'system' && messages[i].textContent === '## Recent Conversation') break;
        if (i > start && messages[i].role === 'system' && messages[i].textContent === '## Recalled Context (high-signal older messages)') break;
        crossTopicBlockTokens += estimateMessageTokens(messages[i]);
      }
    }

    assert(crossTopicBlockTokens <= Math.floor(budget * 0.15), 'Cross-topic block stays within 15% of token budget');
  }

  // ── 6. Non-fatal corrupt topic data ──────────────────────────
  console.log('\n── 6. Non-fatal corrupt topic data ──\n');
  {
    const compositor = makeCompositor();
    const fakeDb = makeFakeTopicDb({
      topics: [
        { id: 'topic-bad', name: 'Broken topic', session_key: sessionKey, last_active_at: 20 },
      ],
      messagesByTopic: {},
      throwOnTopicIds: ['topic-bad'],
    });

    let threw = false;
    let cross = [];
    try {
      cross = await compositor.getKeystonesByTopic(
        agentId,
        sessionKey,
        { id: 'topic-active', name: 'sessionless architecture' },
        [{ role: 'user', textContent: 'Need stateless routing and topic isolation', toolCalls: null, toolResults: null }],
        fakeDb,
        3,
      );
    } catch {
      threw = true;
    }

    assert(threw === false, 'Corrupt topic data does not throw');
    assert(Array.isArray(cross) && cross.length === 0, 'Corrupt topic data returns an empty result');
  }

  console.log(`\nPassed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
