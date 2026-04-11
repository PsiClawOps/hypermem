/**
 * hypermem Cache Layer
 *
 * Drop-in replacement for RedisLayer using SQLite :memory: ATTACH.
 * Same public interface, zero external dependencies, zero TCP overhead.
 */

import { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CacheConfig, SessionMeta, SessionCursor, StoredMessage, NeutralMessage } from './types.js';

export interface ModelState {
  model: string;
  tokenBudget: number;
  composedAt: string;
  historyDepth: number;
  reshapedAt?: string;
}

const DEFAULT_CONFIG: CacheConfig = {
  keyPrefix: 'hm:',
  sessionTTL: 14400,
  historyTTL: 86400,
};

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export class CacheLayer {
  private db: DatabaseSync | null = null;
  private readonly config: CacheConfig;
  private _connected = false;

  private stmtSetSlot!: StatementSync;
  private stmtGetSlot!: StatementSync;
  private stmtSetTopicSlot!: StatementSync;
  private stmtGetTopicSlot!: StatementSync;
  private stmtTouchSlots!: StatementSync;
  private stmtEvictSlots!: StatementSync;
  private stmtActivateSession!: StatementSync;
  private stmtDeactivateSession!: StatementSync;
  private stmtGetActiveSessions!: StatementSync;
  private stmtSetMeta!: StatementSync;
  private stmtGetMeta!: StatementSync;
  private stmtTouchSession!: StatementSync;
  private stmtGetMaxSeq!: StatementSync;
  private stmtInsertHistory!: StatementSync;
  private stmtGetHistory!: StatementSync;
  private stmtGetHistoryLimit!: StatementSync;
  private stmtHistoryExists!: StatementSync;
  private stmtDeleteHistory!: StatementSync;
  private stmtDeleteOldHistory!: StatementSync;
  private stmtGetAllHistoryDesc!: StatementSync;
  private stmtDeleteHistoryBeforeSeq!: StatementSync;
  private stmtEvictHistory!: StatementSync;
  private stmtSetWindow!: StatementSync;
  private stmtGetWindow!: StatementSync;
  private stmtDeleteWindow!: StatementSync;
  private stmtEvictWindows!: StatementSync;
  private stmtSetKv!: StatementSync;
  private stmtGetKv!: StatementSync;
  private stmtDeleteKv!: StatementSync;

  constructor(config?: Partial<CacheConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async connect(db?: DatabaseSync): Promise<boolean> {
    if (this._connected) return true;
    this.db = db ?? new DatabaseSync(':memory:');
    this.db.exec("ATTACH DATABASE ':memory:' AS cache");
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS cache.slots (agent_id TEXT NOT NULL, session_key TEXT NOT NULL, topic_id TEXT NOT NULL DEFAULT '', slot_name TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (agent_id, session_key, topic_id, slot_name));",
      "CREATE TABLE IF NOT EXISTS cache.history (agent_id TEXT NOT NULL, session_key TEXT NOT NULL, topic_id TEXT NOT NULL DEFAULT '', seq INTEGER NOT NULL, message TEXT NOT NULL, PRIMARY KEY (agent_id, session_key, topic_id, seq));",
      "CREATE TABLE IF NOT EXISTS cache.sessions (agent_id TEXT NOT NULL, session_key TEXT NOT NULL, meta TEXT, active INTEGER NOT NULL DEFAULT 1, touched_at INTEGER NOT NULL, PRIMARY KEY (agent_id, session_key));",
      "CREATE TABLE IF NOT EXISTS cache.windows (agent_id TEXT NOT NULL, session_key TEXT NOT NULL, topic_id TEXT NOT NULL DEFAULT '', messages TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (agent_id, session_key, topic_id));",
      "CREATE TABLE IF NOT EXISTS cache.kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0);"
    ].join(' '));
    this._prepareStatements();
    this._connected = true;
    return true;
  }

  private _prepareStatements(): void {
    const db = this.db!;
    this.stmtSetSlot = db.prepare("INSERT OR REPLACE INTO cache.slots (agent_id,session_key,topic_id,slot_name,value,expires_at) VALUES (?,?,'',?,?,?)");
    this.stmtGetSlot = db.prepare("SELECT value FROM cache.slots WHERE agent_id=? AND session_key=? AND topic_id='' AND slot_name=? AND expires_at>?");
    this.stmtSetTopicSlot = db.prepare("INSERT OR REPLACE INTO cache.slots (agent_id,session_key,topic_id,slot_name,value,expires_at) VALUES (?,?,?,?,?,?)");
    this.stmtGetTopicSlot = db.prepare("SELECT value FROM cache.slots WHERE agent_id=? AND session_key=? AND topic_id=? AND slot_name=? AND expires_at>?");
    this.stmtTouchSlots = db.prepare("UPDATE cache.slots SET expires_at=? WHERE agent_id=? AND session_key=? AND topic_id=''");
    this.stmtEvictSlots = db.prepare("DELETE FROM cache.slots WHERE agent_id=? AND session_key=?");
    this.stmtActivateSession = db.prepare("INSERT INTO cache.sessions (agent_id,session_key,meta,active,touched_at) VALUES (?,?,NULL,1,?) ON CONFLICT (agent_id,session_key) DO UPDATE SET active=1,touched_at=excluded.touched_at");
    this.stmtDeactivateSession = db.prepare("UPDATE cache.sessions SET active=0 WHERE agent_id=? AND session_key=?");
    this.stmtGetActiveSessions = db.prepare("SELECT session_key FROM cache.sessions WHERE agent_id=? AND active=1");
    this.stmtSetMeta = db.prepare("INSERT INTO cache.sessions (agent_id,session_key,meta,active,touched_at) VALUES (?,?,?,COALESCE((SELECT active FROM cache.sessions WHERE agent_id=? AND session_key=?),1),?) ON CONFLICT (agent_id,session_key) DO UPDATE SET meta=excluded.meta,touched_at=excluded.touched_at");
    this.stmtGetMeta = db.prepare("SELECT meta FROM cache.sessions WHERE agent_id=? AND session_key=?");
    this.stmtTouchSession = db.prepare("UPDATE cache.sessions SET touched_at=? WHERE agent_id=? AND session_key=?");
    this.stmtGetMaxSeq = db.prepare("SELECT MAX(seq) AS max_seq FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id=?");
    this.stmtInsertHistory = db.prepare("INSERT OR IGNORE INTO cache.history (agent_id,session_key,topic_id,seq,message) VALUES (?,?,?,?,?)");
    this.stmtGetHistory = db.prepare("SELECT message FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id='' ORDER BY seq ASC");
    this.stmtGetHistoryLimit = db.prepare("SELECT message FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id='' AND seq IN (SELECT seq FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id='' ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC");
    this.stmtHistoryExists = db.prepare("SELECT 1 FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id='' LIMIT 1");
    this.stmtDeleteHistory = db.prepare("DELETE FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id=''");
    this.stmtDeleteOldHistory = db.prepare("DELETE FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id='' AND seq NOT IN (SELECT seq FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id='' ORDER BY seq DESC LIMIT ?)");
    this.stmtGetAllHistoryDesc = db.prepare("SELECT seq,message FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id='' ORDER BY seq DESC");
    this.stmtDeleteHistoryBeforeSeq = db.prepare("DELETE FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id='' AND seq<?");
    this.stmtEvictHistory = db.prepare("DELETE FROM cache.history WHERE agent_id=? AND session_key=?");
    this.stmtSetWindow = db.prepare("INSERT OR REPLACE INTO cache.windows (agent_id,session_key,topic_id,messages,expires_at) VALUES (?,?,?,?,?)");
    this.stmtGetWindow = db.prepare("SELECT messages FROM cache.windows WHERE agent_id=? AND session_key=? AND topic_id=? AND expires_at>?");
    this.stmtDeleteWindow = db.prepare("DELETE FROM cache.windows WHERE agent_id=? AND session_key=? AND topic_id=?");
    this.stmtEvictWindows = db.prepare("DELETE FROM cache.windows WHERE agent_id=? AND session_key=?");
    this.stmtSetKv = db.prepare("INSERT OR REPLACE INTO cache.kv (key,value,expires_at) VALUES (?,?,?)");
    this.stmtGetKv = db.prepare("SELECT value FROM cache.kv WHERE key=? AND (expires_at=0 OR expires_at>?)");
    this.stmtDeleteKv = db.prepare("DELETE FROM cache.kv WHERE key=?");
  }

  get isConnected(): boolean {
    return this._connected && this.db !== null;
  }

  // ─── Agent-Level Operations ──────────────────────────────────

  async setProfile(agentId: string, profile: Record<string, unknown>): Promise<void> {
    if (!this.isConnected) return;
    this.stmtSetKv.run(
      `${this.config.keyPrefix}${agentId}:profile`,
      JSON.stringify(profile),
      0
    );
  }

  async getProfile(agentId: string): Promise<Record<string, unknown> | null> {
    if (!this.isConnected) return null;
    const row = this.stmtGetKv.get(
      `${this.config.keyPrefix}${agentId}:profile`,
      now()
    ) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  async addActiveSession(agentId: string, sessionKey: string): Promise<void> {
    if (!this.isConnected) return;
    this.stmtActivateSession.run(agentId, sessionKey, now());
  }

  async removeActiveSession(agentId: string, sessionKey: string): Promise<void> {
    if (!this.isConnected) return;
    this.stmtDeactivateSession.run(agentId, sessionKey);
  }

  async getActiveSessions(agentId: string): Promise<string[]> {
    if (!this.isConnected) return [];
    const rows = this.stmtGetActiveSessions.all(agentId) as { session_key: string }[];
    return rows.map(r => r.session_key);
  }

  // ─── Session Slot Operations ─────────────────────────────────

  async setSlot(agentId: string, sessionKey: string, slot: string, value: string): Promise<void> {
    if (!this.isConnected) return;
    this.stmtSetSlot.run(agentId, sessionKey, slot, value, now() + this.config.sessionTTL);
  }

  async getSlot(agentId: string, sessionKey: string, slot: string): Promise<string | null> {
    if (!this.isConnected) return null;
    const row = this.stmtGetSlot.get(agentId, sessionKey, slot, now()) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setSessionMeta(agentId: string, sessionKey: string, meta: SessionMeta): Promise<void> {
    if (!this.isConnected) return;
    this.stmtSetMeta.run(agentId, sessionKey, JSON.stringify(meta), agentId, sessionKey, now());
  }

  async getSessionMeta(agentId: string, sessionKey: string): Promise<SessionMeta | null> {
    if (!this.isConnected) return null;
    const row = this.stmtGetMeta.get(agentId, sessionKey) as { meta: string | null } | undefined;
    if (!row?.meta) return null;
    return JSON.parse(row.meta) as SessionMeta;
  }

  // ─── History Operations ──────────────────────────────────────

  async pushHistory(
    agentId: string,
    sessionKey: string,
    messages: StoredMessage[],
    maxMessages: number = 250
  ): Promise<void> {
    if (!this.isConnected || messages.length === 0) return;

    // Get current max seq for dedup
    const maxRow = this.stmtGetMaxSeq.get(agentId, sessionKey, '') as { max_seq: number | null } | undefined;
    const maxSeq = maxRow?.max_seq ?? -1;

    // Filter already-stored messages (same dedup logic as Redis path)
    let filteredMessages = messages;
    if (maxSeq >= 0) {
      filteredMessages = messages.filter(m => m.id > maxSeq);
    }
    if (filteredMessages.length === 0) return;

    let seq = maxSeq + 1;
    for (const msg of filteredMessages) {
      this.stmtInsertHistory.run(agentId, sessionKey, '', seq++, JSON.stringify(msg));
    }

    // Soft cap: keep only last maxMessages
    this.stmtDeleteOldHistory.run(agentId, sessionKey, agentId, sessionKey, maxMessages);
  }

  async replaceHistory(
    agentId: string,
    sessionKey: string,
    messages: NeutralMessage[],
    maxMessages: number = 250
  ): Promise<void> {
    if (!this.isConnected) return;
    this.stmtDeleteHistory.run(agentId, sessionKey);
    const slice = messages.slice(-maxMessages);
    for (let i = 0; i < slice.length; i++) {
      this.stmtInsertHistory.run(agentId, sessionKey, '', i, JSON.stringify(slice[i]));
    }
  }

  async getHistory(agentId: string, sessionKey: string, limit?: number): Promise<StoredMessage[]> {
    if (!this.isConnected) return [];
    let rows: { message: string }[];
    if (limit) {
      rows = this.stmtGetHistoryLimit.all(agentId, sessionKey, agentId, sessionKey, limit) as { message: string }[];
    } else {
      rows = this.stmtGetHistory.all(agentId, sessionKey) as { message: string }[];
    }
    return rows.map(r => JSON.parse(r.message));
  }

  async sessionExists(agentId: string, sessionKey: string): Promise<boolean> {
    if (!this.isConnected) return false;
    const row = this.stmtHistoryExists.get(agentId, sessionKey);
    return row !== undefined;
  }

  async trimHistoryToTokenBudget(
    agentId: string,
    sessionKey: string,
    tokenBudget: number
  ): Promise<number> {
    if (!this.isConnected || tokenBudget <= 0) return 0;

    const rows = this.stmtGetAllHistoryDesc.all(agentId, sessionKey) as { seq: number; message: string }[];
    if (rows.length <= 10) return 0;

    const estimateMessageTokens = (msg: StoredMessage): number => {
      let msgTokens = Math.ceil((msg.textContent?.length ?? 0) / 4);
      if (msg.toolCalls) msgTokens += Math.ceil(JSON.stringify(msg.toolCalls).length / 2);
      if (msg.toolResults) msgTokens += Math.ceil(JSON.stringify(msg.toolResults).length / 2);
      return msgTokens;
    };

    const chronological = rows
      .slice()
      .reverse()
      .map(row => {
        try {
          return { seq: row.seq, msg: JSON.parse(row.message) as StoredMessage, fallback: false };
        } catch {
          return { seq: row.seq, msg: null as StoredMessage | null, fallback: true };
        }
      });

    const clusters: Array<{ startSeq: number; endSeq: number; tokenCost: number }> = [];
    for (let i = 0; i < chronological.length; i++) {
      const current = chronological[i];
      if (current.fallback || !current.msg) {
        clusters.push({ startSeq: current.seq, endSeq: current.seq, tokenCost: 500 });
        continue;
      }

      let endSeq = current.seq;
      let tokenCost = estimateMessageTokens(current.msg);

      if (current.msg.toolCalls && current.msg.toolCalls.length > 0) {
        const callIds = new Set(current.msg.toolCalls.map(tc => tc.id).filter(Boolean));
        let j = i + 1;
        while (j < chronological.length) {
          const candidate = chronological[j];
          if (candidate.fallback || !candidate.msg || !candidate.msg.toolResults || candidate.msg.toolResults.length === 0) break;
          const resultIds = candidate.msg.toolResults.map(tr => tr.callId).filter(Boolean);
          if (callIds.size > 0 && resultIds.length > 0 && !resultIds.some(id => callIds.has(id))) break;
          tokenCost += estimateMessageTokens(candidate.msg);
          endSeq = candidate.seq;
          j++;
        }
        i = j - 1;
      } else if (current.msg.toolResults && current.msg.toolResults.length > 0) {
        let j = i + 1;
        while (j < chronological.length) {
          const candidate = chronological[j];
          if (candidate.fallback || !candidate.msg || !candidate.msg.toolResults || candidate.msg.toolResults.length === 0 || (candidate.msg.toolCalls && candidate.msg.toolCalls.length > 0)) break;
          tokenCost += estimateMessageTokens(candidate.msg);
          endSeq = candidate.seq;
          j++;
        }
        i = j - 1;
      }

      clusters.push({ startSeq: current.seq, endSeq, tokenCost });
    }

    let tokenSum = 0;
    let keepFromSeq: number | null = null;
    for (let i = clusters.length - 1; i >= 0; i--) {
      const cluster = clusters[i];
      if (tokenSum + cluster.tokenCost > tokenBudget) break;
      tokenSum += cluster.tokenCost;
      keepFromSeq = cluster.startSeq;
    }

    if (keepFromSeq === null) {
      keepFromSeq = clusters[clusters.length - 1]?.startSeq ?? null;
    }
    if (keepFromSeq === null) return 0;

    const oldestSeq = clusters[0]?.startSeq ?? keepFromSeq;
    if (keepFromSeq <= oldestSeq) return 0;

    const cutSeq = keepFromSeq - 1;
    const stmt = this.db!.prepare(
      "DELETE FROM cache.history WHERE agent_id=? AND session_key=? AND topic_id='' AND seq<=?"
    );
    stmt.run(agentId, sessionKey, cutSeq);

    const trimmed = rows.filter(r => r.seq <= cutSeq).length;
    console.log(`[hypermem-cache] trimHistoryToTokenBudget: trimmed ${trimmed} messages from ${agentId}/${sessionKey}`);
    return trimmed;
  }

  // ─── Window Cache Operations ─────────────────────────────────

  async setWindow(
    agentId: string,
    sessionKey: string,
    messages: NeutralMessage[],
    ttlSeconds: number = 120
  ): Promise<void> {
    if (!this.isConnected) return;
    this.stmtSetWindow.run(agentId, sessionKey, '', JSON.stringify(messages), now() + ttlSeconds);
  }

  async getWindow(agentId: string, sessionKey: string): Promise<NeutralMessage[] | null> {
    if (!this.isConnected) return null;
    const row = this.stmtGetWindow.get(agentId, sessionKey, '', now()) as { messages: string } | undefined;
    return row ? JSON.parse(row.messages) : null;
  }

  async invalidateWindow(agentId: string, sessionKey: string): Promise<void> {
    if (!this.isConnected) return;
    this.stmtDeleteWindow.run(agentId, sessionKey, '');
  }

  /**
   * Returns the cached window only if the cursor indicates nothing has changed
   * since the last compose (i.e. cursor.lastSentId >= lastMessageId).
   * Used for C4 window cache fast-exit in compositor.ts.
   */
  async getWindowIfFresh(
    agentId: string,
    sessionKey: string,
    lastMessageId: number
  ): Promise<NeutralMessage[] | null> {
    const cached = await this.getWindow(agentId, sessionKey);
    if (!cached) return null;
    const cursor = await this.getCursor(agentId, sessionKey);
    if (cursor && cursor.lastSentId >= lastMessageId) return cached;
    return null; // Stale — recompose
  }

  /**
   * Store compose result metadata alongside the window cache.
   * Enables the C4 fast-exit to return a complete ComposeResult without re-running.
   */
  async setWindowMeta(
    agentId: string,
    sessionKey: string,
    meta: { slots: Record<string, number>; totalTokens: number; warnings: string[] },
    ttl: number
  ): Promise<void> {
    if (!this.isConnected) return;
    this.stmtSetKv.run(
      `${this.config.keyPrefix}${agentId}:s:${sessionKey}:windowmeta`,
      JSON.stringify(meta),
      now() + ttl
    );
  }

  async getWindowMeta(
    agentId: string,
    sessionKey: string
  ): Promise<{ slots: Record<string, number>; totalTokens: number; warnings: string[] } | null> {
    if (!this.isConnected) return null;
    const row = this.stmtGetKv.get(
      `${this.config.keyPrefix}${agentId}:s:${sessionKey}:windowmeta`,
      now()
    ) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  // ─── Session Cursor Operations ────────────────────────────────

  async setCursor(agentId: string, sessionKey: string, cursor: SessionCursor): Promise<void> {
    if (!this.isConnected) return;
    this.stmtSetKv.run(
      `${this.config.keyPrefix}${agentId}:s:${sessionKey}:cursor`,
      JSON.stringify(cursor),
      now() + this.config.historyTTL
    );
  }

  async getCursor(agentId: string, sessionKey: string): Promise<SessionCursor | null> {
    if (!this.isConnected) return null;
    const row = this.stmtGetKv.get(
      `${this.config.keyPrefix}${agentId}:s:${sessionKey}:cursor`,
      now()
    ) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  // ─── Bulk Session Operations ──────────────────────────────────

  async warmSession(
    agentId: string,
    sessionKey: string,
    slots: {
      system?: string;
      identity?: string;
      context?: string;
      facts?: string;
      tools?: string;
      meta?: SessionMeta;
      history?: StoredMessage[];
    }
  ): Promise<void> {
    if (!this.isConnected) return;
    const exp = now() + this.config.sessionTTL;
    if (slots.system)   this.stmtSetSlot.run(agentId, sessionKey, 'system',   slots.system,   exp);
    if (slots.identity) this.stmtSetSlot.run(agentId, sessionKey, 'identity', slots.identity, exp);
    if (slots.context)  this.stmtSetSlot.run(agentId, sessionKey, 'context',  slots.context,  exp);
    if (slots.facts)    this.stmtSetSlot.run(agentId, sessionKey, 'facts',    slots.facts,    exp);
    if (slots.tools)    this.stmtSetSlot.run(agentId, sessionKey, 'tools',    slots.tools,    exp);
    if (slots.meta)     await this.setSessionMeta(agentId, sessionKey, slots.meta);
    if (slots.history && slots.history.length > 0) await this.pushHistory(agentId, sessionKey, slots.history);
    await this.addActiveSession(agentId, sessionKey);
  }

  async evictSession(agentId: string, sessionKey: string): Promise<void> {
    if (!this.isConnected) return;
    this.stmtEvictSlots.run(agentId, sessionKey);
    this.stmtEvictHistory.run(agentId, sessionKey);
    this.stmtEvictWindows.run(agentId, sessionKey);
    this.stmtDeactivateSession.run(agentId, sessionKey);
    // cursor
    this.stmtDeleteKv.run(`${this.config.keyPrefix}${agentId}:s:${sessionKey}:cursor`);
  }

  // ─── Touch / TTL ─────────────────────────────────────────────

  async touchSession(agentId: string, sessionKey: string): Promise<void> {
    if (!this.isConnected) return;
    const exp = now() + this.config.sessionTTL;
    this.stmtTouchSlots.run(exp, agentId, sessionKey);
    this.stmtTouchSession.run(now(), agentId, sessionKey);
  }

  async flushPrefix(): Promise<number> {
    if (!this.isConnected) return 0;
    const db = this.db!;
    const counts = [
      (db.prepare("DELETE FROM cache.slots").run() as { changes: number }).changes,
      (db.prepare("DELETE FROM cache.history").run() as { changes: number }).changes,
      (db.prepare("DELETE FROM cache.sessions").run() as { changes: number }).changes,
      (db.prepare("DELETE FROM cache.windows").run() as { changes: number }).changes,
      (db.prepare("DELETE FROM cache.kv").run() as { changes: number }).changes,
    ];
    return counts.reduce((a, b) => a + b, 0);
  }

  // ─── Fleet Cache (Library L4 Hot Layer) ──────────────────────

  async setFleetCache(key: string, value: string, ttl: number = 600): Promise<void> {
    if (!this.isConnected) return;
    this.stmtSetKv.run(`${this.config.keyPrefix}fleet:${key}`, value, now() + ttl);
  }

  async getFleetCache(key: string): Promise<string | null> {
    if (!this.isConnected) return null;
    const row = this.stmtGetKv.get(`${this.config.keyPrefix}fleet:${key}`, now()) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async delFleetCache(key: string): Promise<void> {
    if (!this.isConnected) return;
    this.stmtDeleteKv.run(`${this.config.keyPrefix}fleet:${key}`);
  }

  async cacheFleetAgent(agentId: string, data: Record<string, unknown>): Promise<void> {
    await this.setFleetCache(`agent:${agentId}`, JSON.stringify(data));
  }

  async getCachedFleetAgent(agentId: string): Promise<Record<string, unknown> | null> {
    const val = await this.getFleetCache(`agent:${agentId}`);
    return val ? JSON.parse(val) : null;
  }

  async cacheFleetSummary(summary: Record<string, unknown>): Promise<void> {
    await this.setFleetCache('summary', JSON.stringify(summary), 120);
  }

  async getCachedFleetSummary(): Promise<Record<string, unknown> | null> {
    const val = await this.getFleetCache('summary');
    return val ? JSON.parse(val) : null;
  }

  async invalidateFleetAgent(agentId: string): Promise<void> {
    await this.delFleetCache(`agent:${agentId}`);
    await this.delFleetCache('summary');
  }

  // ─── Query Embedding Cache ────────────────────────────────────

  async setQueryEmbedding(agentId: string, sessionKey: string, embedding: Float32Array): Promise<void> {
    if (!this.isConnected) return;
    const encoded = Buffer.from(embedding.buffer).toString('base64');
    this.stmtSetKv.run(
      `${this.config.keyPrefix}${agentId}:s:${sessionKey}:qembed`,
      encoded,
      now() + this.config.sessionTTL
    );
  }

  async getQueryEmbedding(agentId: string, sessionKey: string): Promise<Float32Array | null> {
    if (!this.isConnected) return null;
    try {
      const row = this.stmtGetKv.get(
        `${this.config.keyPrefix}${agentId}:s:${sessionKey}:qembed`,
        now()
      ) as { value: string } | undefined;
      if (!row) return null;
      const buf = Buffer.from(row.value, 'base64');
      return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    } catch {
      return null;
    }
  }

  // ─── Topic-Scoped Session Operations ─────────────────────────

  async setTopicSlot(agentId: string, sessionKey: string, topicId: string, slot: string, value: string): Promise<void> {
    if (!this.isConnected) return;
    this.stmtSetTopicSlot.run(agentId, sessionKey, topicId, slot, value, now() + this.config.sessionTTL);
  }

  async getTopicSlot(agentId: string, sessionKey: string, topicId: string, slot: string): Promise<string | null> {
    if (!this.isConnected) return null;
    const row = this.stmtGetTopicSlot.get(agentId, sessionKey, topicId, slot, now()) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setTopicWindow(
    agentId: string,
    sessionKey: string,
    topicId: string,
    messages: NeutralMessage[],
    ttl: number = 120
  ): Promise<void> {
    if (!this.isConnected) return;
    this.stmtSetWindow.run(agentId, sessionKey, topicId, JSON.stringify(messages), now() + ttl);
  }

  async getTopicWindow(agentId: string, sessionKey: string, topicId: string): Promise<NeutralMessage[] | null> {
    if (!this.isConnected) return null;
    const row = this.stmtGetWindow.get(agentId, sessionKey, topicId, now()) as { messages: string } | undefined;
    return row ? JSON.parse(row.messages) : null;
  }

  async invalidateTopicWindow(agentId: string, sessionKey: string, topicId: string): Promise<void> {
    if (!this.isConnected) return;
    this.stmtDeleteWindow.run(agentId, sessionKey, topicId);
  }

  async warmTopicSession(
    agentId: string,
    sessionKey: string,
    topicId: string,
    slots: {
      history?: StoredMessage[];
      window?: NeutralMessage[];
      context?: string;
      facts?: string;
      cursor?: string;
    }
  ): Promise<void> {
    if (!this.isConnected) return;
    const exp = now() + this.config.sessionTTL;
    if (slots.context) this.stmtSetTopicSlot.run(agentId, sessionKey, topicId, 'context', slots.context, exp);
    if (slots.facts)   this.stmtSetTopicSlot.run(agentId, sessionKey, topicId, 'facts',   slots.facts,   exp);
    if (slots.cursor)  this.stmtSetTopicSlot.run(agentId, sessionKey, topicId, 'cursor',  slots.cursor,  exp);
    if (slots.window)  this.stmtSetWindow.run(agentId, sessionKey, topicId, JSON.stringify(slots.window), now() + 120);
    if (slots.history && slots.history.length > 0) {
      // Topic history goes into the topic_id-scoped rows
      const maxRow = this.stmtGetMaxSeq.get(agentId, sessionKey, topicId) as { max_seq: number | null } | undefined;
      let seq = (maxRow?.max_seq ?? -1) + 1;
      for (const msg of slots.history) {
        this.stmtInsertHistory.run(agentId, sessionKey, topicId, seq++, JSON.stringify(msg));
      }
    }
  }

  // ─── Model State ─────────────────────────────────────────────

  async setModelState(agentId: string, sessionKey: string, state: ModelState): Promise<void> {
    if (!this.isConnected) return;
    this.stmtSetKv.run(
      `${this.config.keyPrefix}${agentId}:s:${sessionKey}:modelstate`,
      JSON.stringify(state),
      now() + this.config.sessionTTL
    );
  }

  async getModelState(agentId: string, sessionKey: string): Promise<ModelState | null> {
    if (!this.isConnected) return null;
    const row = this.stmtGetKv.get(
      `${this.config.keyPrefix}${agentId}:s:${sessionKey}:modelstate`,
      now()
    ) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.db = null;
  }
}
