import { HyperMem } from '../dist/index.js';
import { Compositor } from '../dist/compositor.js';
import { toProviderFormat } from '../dist/provider-translator.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function runCachePrefixStabilitySuite(assert) {
  console.log('\n── Cache Prefix Stability (Phase B1 + B2) ──');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cache-prefix-'));
  let hm;

  try {
    hm = await HyperMem.create({ dataDir: tmpDir });

    const agentId = 'prefix-agent';
    const sessionKey = 'agent:prefix-agent:webchat:main';
    const msgDb = hm.dbManager.getMessageDb(agentId);
    const libDb = hm.dbManager.getLibraryDb();

    msgDb.prepare(`
      INSERT INTO conversations (session_key, session_id, agent_id, channel_type, status, message_count, token_count_in, token_count_out, created_at, updated_at)
      VALUES (?, 'prefix-sess-1', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
    `).run(sessionKey, agentId);

    const convId = msgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(sessionKey).id;

    const insertMessage = (role, text, idx) => {
      msgDb.prepare(`
        INSERT INTO messages (conversation_id, agent_id, role, text_content, message_index, is_heartbeat, created_at)
        VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
      `).run(convId, agentId, role, text, idx);
    };

    insertMessage('user', 'What changed in my current work?', 1);
    insertMessage('assistant', 'You have a stable cache prefix and some active session facts.', 2);

    hm.addFact(agentId, 'The compositor uses a stable prefix boundary for cache reuse.', {
      domain: 'architecture',
      visibility: 'fleet',
      scope: 'agent',
    });
    hm.addFact(agentId, 'Current session is debugging cache-prefix stability.', {
      domain: 'session',
      visibility: 'private',
      scope: 'session',
      sourceSessionKey: sessionKey,
    });
    hm.upsertKnowledge(agentId, 'architecture', 'cache-prefix',
      'Stable memory facts and long-lived expertise should stay above the dynamic boundary.');
    hm.setPreference('operator', 'response_style', 'Direct and explicit', {
      domain: 'communication',
      agentId,
    });

    const compositor = new Compositor({
      cache: hm.cache,
      vectorStore: null,
      libraryDb: libDb,
    });

    await compositor.warmSession(agentId, sessionKey, msgDb, {
      systemPrompt: 'You are the HyperMem test agent.',
      identity: 'prefix-agent identity v1',
      libraryDb: libDb,
      model: 'claude-opus-4-6',
    });

    const composeBase = async () => compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 12000,
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      includeHistory: true,
      includeFacts: true,
      includeLibrary: true,
      includeContext: true,
      includeSemanticRecall: false,
      includeDocChunks: false,
      skipProviderTranslation: true,
      skipWindowCache: true,
    }, msgDb, libDb);

    const first = await composeBase();
    const firstDiag = first.diagnostics ?? {};
    const firstMessages = first.messages;
    const firstBoundaryIdx = firstMessages.findIndex(m => m.metadata?.dynamicBoundary === true);

    assert(typeof firstDiag.prefixHash === 'string' && firstDiag.prefixHash.length === 64,
      `B1: prefix hash emitted (${firstDiag.prefixHash})`);
    assert((firstDiag.prefixSegmentCount ?? 0) >= 4,
      `B1: prefix segment count captured (${firstDiag.prefixSegmentCount})`);
    assert((firstDiag.prefixTokens ?? 0) > 0,
      `B1: prefix token estimate captured (${firstDiag.prefixTokens})`);
    assert((firstDiag.volatileHistoryTokens ?? 0) > 0,
      `B1: volatile token estimate captured (${firstDiag.volatileHistoryTokens})`);
    assert(firstBoundaryIdx === firstDiag.prefixSegmentCount,
      `B1: dynamic boundary follows stable prefix (${firstBoundaryIdx} === ${firstDiag.prefixSegmentCount})`);

    const firstPrefixText = firstMessages
      .slice(0, firstDiag.prefixSegmentCount)
      .map(m => m.textContent ?? '')
      .join('\n\n');
    const firstDynamicText = firstBoundaryIdx >= 0
      ? (firstMessages[firstBoundaryIdx].textContent ?? '')
      : '';

    assert(firstPrefixText.includes('## Stable Facts'), 'B1: stable facts stay above boundary');
    assert(firstPrefixText.includes('## Knowledge'), 'B1: knowledge stays above boundary');
    assert(firstPrefixText.includes('## User Preferences'), 'B1: preferences stay above boundary');
    assert(firstDynamicText.includes('## Active Facts'), 'B1: session-volatile facts stay below boundary');

    insertMessage('user', 'Any new volatile turn details?', 3);
    insertMessage('assistant', 'Yes, only recent history changed.', 4);
    hm.addFact(agentId, 'Another volatile session note for this turn.', {
      domain: 'session',
      visibility: 'private',
      scope: 'session',
      sourceSessionKey: sessionKey,
    });

    const second = await composeBase();
    assert(second.diagnostics?.prefixHash === firstDiag.prefixHash,
      'B1: volatile history changes do not churn prefix hash');

    await compositor.warmSession(agentId, sessionKey, msgDb, {
      systemPrompt: 'You are the HyperMem test agent.',
      identity: 'prefix-agent identity v2',
      libraryDb: libDb,
      model: 'claude-opus-4-6',
    });

    const third = await composeBase();
    assert(third.diagnostics?.prefixHash !== firstDiag.prefixHash,
      'B1: stable input mutation changes prefix hash');

    // ── Phase B2: prefixHash in WindowCacheMeta ──────────────────────
    console.log('\n── Phase B2: prefixHash wired into window cache ──');

    // Reset to v1 identity for B2 tests
    await compositor.warmSession(agentId, sessionKey, msgDb, {
      systemPrompt: 'You are the HyperMem test agent.',
      identity: 'prefix-agent identity v1',
      libraryDb: libDb,
      model: 'claude-opus-4-6',
    });

    // Do a full compose (skipWindowCache: true) to populate the window cache
    const b2First = await compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 12000,
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      includeHistory: true,
      includeFacts: true,
      includeLibrary: true,
      includeContext: true,
      includeSemanticRecall: false,
      includeDocChunks: false,
      skipProviderTranslation: true,
      skipWindowCache: true,  // force full compose to seed the cache
    }, msgDb, libDb);
    const b2FirstHash = b2First.diagnostics?.prefixHash;
    assert(typeof b2FirstHash === 'string', `B2: full compose emits prefixHash (${b2FirstHash})`);

    // Read back the window meta and verify prefixHash is stored
    const b2Meta = await hm.cache.getWindowMeta(agentId, sessionKey);
    assert(b2Meta !== null, 'B2: window meta is stored after full compose');
    assert(b2Meta?.prefixHash === b2FirstHash,
      `B2: WindowCacheMeta.prefixHash matches compose diagnostics (${b2Meta?.prefixHash} === ${b2FirstHash})`);
    assert(typeof b2Meta?.prefixInputHash === 'string' && b2Meta.prefixInputHash.length === 64,
      `B2: WindowCacheMeta.prefixInputHash is stored (${b2Meta?.prefixInputHash})`);

    // C4 fast-exit: with same inputs, volatile-only change should use cache
    // (adds a new message so cursor.lastSentId advances, which invalidates C4
    // via getFreshWindowBundle — this tests that cache IS invalidated correctly
    // after new messages). Actually to test C4 stable fast-exit we need:
    // same messages, same prefix. Test the bypass path instead:
    // Change identity (prefix input mutation) and verify full compose runs.
    // Mutate only the identity slot — do NOT call warmSession, which would
    // call invalidateWindow and wipe the cached bundle we just wrote. We need
    // the cache to survive so the C4 bypass can fire and set prevPrefixHash.
    await hm.cache.setSlot(agentId, sessionKey, 'identity', 'prefix-agent identity CHANGED');
    // The real test: do a compose WITHOUT skipWindowCache — it should detect
    // the prefixInputHash mismatch and fall through to full compose.
    const b2AfterChange = await compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 12000,
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      includeHistory: true,
      includeFacts: true,
      includeLibrary: true,
      includeContext: true,
      includeSemanticRecall: false,
      includeDocChunks: false,
      skipProviderTranslation: true,
      skipWindowCache: false,  // allow cache — but prefix changed so it should bypass
    }, msgDb, libDb);
    // Should be a full compose (not windowCacheHit) because identity changed
    assert(b2AfterChange.diagnostics?.windowCacheHit !== true,
      'B2: C4 bypasses cache when prefix input (identity) changed');
    const b2ChangedHash = b2AfterChange.diagnostics?.prefixHash;
    assert(b2ChangedHash !== b2FirstHash,
      `B2: new prefixHash after identity change differs (old=${b2FirstHash?.slice(0,8)}, new=${b2ChangedHash?.slice(0,8)})`);
    assert(typeof b2AfterChange.diagnostics?.prevPrefixHash === 'string',
      'B2: prevPrefixHash set on bypass');

    // ── B2: Unchanged prefix, volatile-only change: cache bypass should NOT fire ──
    // Restore identity v1
    await compositor.warmSession(agentId, sessionKey, msgDb, {
      systemPrompt: 'You are the HyperMem test agent.',
      identity: 'prefix-agent identity v1',
      libraryDb: libDb,
      model: 'claude-opus-4-6',
    });
    // Seed the cache with a fresh full compose
    await compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 12000,
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      includeHistory: true,
      includeFacts: true,
      includeLibrary: true,
      includeContext: true,
      includeSemanticRecall: false,
      includeDocChunks: false,
      skipProviderTranslation: true,
      skipWindowCache: true,
    }, msgDb, libDb);

    // Stamp the cursor so getFreshWindowBundle can validate freshness.
    // lastSentAt must match meta.composedAt; lastSentId must be >= newestMsgId.
    const b2SeedMeta = await hm.cache.getWindowMeta(agentId, sessionKey);
    assert(b2SeedMeta !== null, 'B2: seed meta present before cursor stamp');
    const b2NewestRow = msgDb.prepare('SELECT MAX(id) AS maxId FROM messages WHERE agent_id = ?').get(agentId);
    await hm.cache.setCursor(agentId, sessionKey, {
      lastSentId: b2NewestRow.maxId,
      lastSentIndex: 4,
      lastSentAt: b2SeedMeta.composedAt,
      windowSize: 4,
      tokenCount: b2SeedMeta.totalTokens,
    });

    // Now call with skipWindowCache: false — same inputs, cursor is fresh.
    // C4 fast-exit should fire: windowCacheHit=true, no prevPrefixHash bypass.
    const b2CacheHit = await compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 12000,
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      includeHistory: true,
      includeFacts: true,
      includeLibrary: true,
      includeContext: true,
      includeSemanticRecall: false,
      includeDocChunks: false,
      skipProviderTranslation: true,
      skipWindowCache: false,
    }, msgDb, libDb);
    assert(b2CacheHit.diagnostics?.windowCacheHit === true,
      'B2: volatile-only path returns windowCacheHit: true');
    assert(b2CacheHit.diagnostics?.prevPrefixHash === undefined,
      'B2: stable prefix — no prevPrefixHash emitted (bypass did not fire)');

    // ── B2: E2E cache_control:ephemeral on last stable system message ─
    console.log('\n── B2: Anthropic cache_control:ephemeral placement ──');

    // Compose a fresh neutral window for Anthropic translation
    await compositor.warmSession(agentId, sessionKey, msgDb, {
      systemPrompt: 'You are the HyperMem test agent.',
      identity: 'prefix-agent identity v1',
      libraryDb: libDb,
      model: 'claude-opus-4-6',
    });
    const ephemeralResult = await compositor.compose({
      agentId,
      sessionKey,
      tokenBudget: 12000,
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      includeHistory: true,
      includeFacts: true,
      includeLibrary: true,
      includeContext: true,
      includeSemanticRecall: false,
      includeDocChunks: false,
      skipProviderTranslation: true,  // get neutral messages for manual translation
      skipWindowCache: true,
    }, msgDb, libDb);

    // Translate neutral messages to Anthropic format
    const anthropicMsgs = toProviderFormat(ephemeralResult.messages, 'anthropic');

    // Count cache_control:{type:'ephemeral'} occurrences on system messages
    const ephemeralMarks = anthropicMsgs.filter(
      m => m.role === 'system' && m.cache_control?.type === 'ephemeral'
    );
    assert(ephemeralMarks.length === 1,
      `B2: exactly one cache_control:ephemeral on system messages (found ${ephemeralMarks.length})`);

    // Verify it is on the LAST stable system message (before dynamicBoundary)
    const dynamicBoundaryIdx = ephemeralResult.messages.findIndex(
      m => m.metadata?.dynamicBoundary === true
    );
    const lastStableIdx = dynamicBoundaryIdx > 0 ? dynamicBoundaryIdx - 1 : -1;
    assert(lastStableIdx >= 0, 'B2: dynamic boundary exists in neutral messages');

    // The Anthropic-translated messages preserve system message order.
    // Find the Anthropic system messages in order.
    const anthropicSysMsgs = anthropicMsgs
      .map((m, i) => ({ ...m, _idx: i }))
      .filter(m => m.role === 'system');
    // The last system message BEFORE any dynamicBoundary system message
    // corresponds to lastStableIdx in the neutral array.
    // Since neutral and Anthropic arrays have the same order:
    const ephemeralMarkedIdx = anthropicSysMsgs.findIndex(m => m.cache_control?.type === 'ephemeral');
    const expectedEphemeralNeutralIdx = lastStableIdx;
    // Map: in the neutral array, messages[lastStableIdx] is the last static system msg.
    // In the Anthropic array, it should be at the same relative position.
    // Count system messages in neutral array up to lastStableIdx (inclusive).
    const neutralSysMsgsBeforeAndAt = ephemeralResult.messages
      .slice(0, lastStableIdx + 1)
      .filter(m => m.role === 'system').length;
    assert(
      ephemeralMarkedIdx === neutralSysMsgsBeforeAndAt - 1,
      `B2: cache_control:ephemeral is on the last static system msg before dynamic boundary (at system-msg index ${ephemeralMarkedIdx}, expected ${neutralSysMsgsBeforeAndAt - 1})`
    );

    // Verify NO ephemeral marker appears on or after the dynamicBoundary
    const dynamicSysMsgs = anthropicMsgs
      .filter((m, i) => {
        // Match by position: find where neutral dynamicBoundary idx lands in anthropic
        return m.role === 'system' && i >= neutralSysMsgsBeforeAndAt;
      });
    const dynamicEphemeral = dynamicSysMsgs.filter(m => m.cache_control?.type === 'ephemeral');
    assert(dynamicEphemeral.length === 0,
      `B2: no cache_control:ephemeral on dynamic boundary or later (found ${dynamicEphemeral.length})`);

    // ── B2: rotateSessionContext — session lifecycle hook ─────────────
    // Validate that rotateSessionContext archives the old context and creates
    // a fresh active context when called on an existing session.
    console.log('\n── B2: rotateSessionContext lifecycle ──');
    const { rotateSessionContext: rotateCtx, getActiveContext, ensureContextSchema } = await import('../dist/context-store.js');

    const rotateAgentId = 'rotate-agent';
    const rotateSessionKey = 'agent:rotate-agent:webchat:test';
    const rotateMsgDb = hm.dbManager.getMessageDb(rotateAgentId);

    // Ensure context schema is present
    ensureContextSchema(rotateMsgDb);

    // Create a conversation to anchor the context
    rotateMsgDb.prepare(`
      INSERT OR IGNORE INTO conversations (session_key, session_id, agent_id, channel_type, status, message_count, token_count_in, token_count_out, created_at, updated_at)
      VALUES (?, 'sess-v1', ?, 'webchat', 'active', 0, 0, 0, datetime('now'), datetime('now'))
    `).run(rotateSessionKey, rotateAgentId);

    const rotateConv = rotateMsgDb.prepare('SELECT id FROM conversations WHERE session_key = ?').get(rotateSessionKey);
    const rotateConvId = rotateConv.id;

    // Create an initial active context
    const initCtx = getActiveContext(rotateMsgDb, rotateAgentId, rotateSessionKey);
    assert(initCtx === null || typeof initCtx.id === 'number', 'B2: initial context is null or valid');

    // Rotate: this should archive the existing context (if any) and create a fresh one
    const rotated = rotateCtx(rotateMsgDb, rotateAgentId, rotateSessionKey, rotateConvId);
    assert(typeof rotated.id === 'number', `B2: rotateSessionContext returns a new context (id=${rotated.id})`);
    assert(rotated.status === 'active', 'B2: rotated context is active');
    assert(rotated.headMessageId === null, 'B2: rotated context starts with null head (clean slate)');
    assert(rotated.agentId === rotateAgentId, 'B2: rotated context has correct agentId');
    assert(rotated.sessionKey === rotateSessionKey, 'B2: rotated context has correct sessionKey');

    // Verify there is exactly one active context after rotation
    const afterRotateCtx = getActiveContext(rotateMsgDb, rotateAgentId, rotateSessionKey);
    assert(afterRotateCtx !== null, 'B2: active context exists after rotation');
    assert(afterRotateCtx?.id === rotated.id, 'B2: active context is the rotated one');

    // Rotate again: previous context should be archived, new one created
    const rotated2 = rotateCtx(rotateMsgDb, rotateAgentId, rotateSessionKey, rotateConvId);
    assert(rotated2.id !== rotated.id, 'B2: second rotation creates a distinct context');
    assert(rotated2.parentContextId === rotated.id, 'B2: second rotated context links to prior via parentContextId');

    // Verify old context is archived
    const archivedRow = rotateMsgDb.prepare('SELECT status FROM contexts WHERE id = ?').get(rotated.id);
    assert(archivedRow?.status === 'archived', 'B2: previous context is archived after second rotation');

  } finally {
    if (hm) await hm.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
