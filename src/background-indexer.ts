/**
 * HyperMem Background Indexer
 *
 * Processes message history to extract structured knowledge:
 *   - Facts: atomic pieces of learned information
 *   - Episodes: significant events worth remembering
 *   - Topics: conversation threads and their lifecycle
 *   - Knowledge: durable structured entries (domain + key)
 *
 * Runs as a periodic background task, processing unindexed messages
 * in batches. Each batch is scored, classified, and stored in L4 (library.db).
 *
 * Design principles:
 *   - No LLM dependency: extraction uses pattern matching + heuristics
 *   - Idempotent: tracks watermarks per agent to avoid reprocessing
 *   - Bounded: processes N messages per tick to avoid blocking
 *   - Observable: logs extraction stats for monitoring
 */

import type { DatabaseSync } from 'node:sqlite';
import type { StoredMessage, IndexerConfig, EpisodeType } from './types.js';
import { MessageStore } from './message-store.js';
import { FactStore } from './fact-store.js';
import { EpisodeStore } from './episode-store.js';
import { TopicStore } from './topic-store.js';
import { KnowledgeStore } from './knowledge-store.js';

// ─── Types ──────────────────────────────────────────────────────

export interface IndexerStats {
  agentId: string;
  messagesProcessed: number;
  factsExtracted: number;
  episodesRecorded: number;
  topicsUpdated: number;
  knowledgeUpserted: number;
  elapsedMs: number;
}

export interface WatermarkState {
  agentId: string;
  lastMessageId: number;
  lastRunAt: string;
}

// ─── Pattern Matchers ───────────────────────────────────────────

/**
 * Patterns that indicate a message contains extractable facts.
 * Returns extracted facts as strings.
 */
function extractFactCandidates(content: string): string[] {
  const facts: string[] = [];
  if (!content || content.length < 20) return facts;

  // Decision patterns: "decided to", "agreed on", "choosing", "going with"
  const decisionPatterns = [
    /(?:we |I |they )?(?:decided|agreed|chose|selected|committed) (?:to |on |that )(.{20,200})/gi,
    /(?:going|went) with (.{10,150})/gi,
    /decision:\s*(.{10,200})/gi,
  ];

  // Learned/discovered patterns
  const learnedPatterns = [
    /(?:learned|discovered|found out|realized|noticed) (?:that |)(.{20,200})/gi,
    /turns out (?:that |)(.{20,200})/gi,
    /(?:TIL|FYI|note to self)[:\s]+(.{10,200})/gi,
  ];

  // Config/setting patterns
  const configPatterns = [
    /(?:set|changed|updated|configured) (\S+ to .{5,150})/gi,
    /(?:model|config|setting)[:\s]+(\S+\s*(?:→|->|=|is)\s*.{5,100})/gi,
  ];

  // Preference patterns
  const preferencePatterns = [
    /(?:prefer|always use|never use|don't use|avoid) (.{10,150})/gi,
    /(?:ragesaq|operator) (?:wants|prefers|likes|hates|dislikes) (.{10,150})/gi,
  ];

  // Operational patterns
  const operationalPatterns = [
    /(?:deployed|shipped|released|rolled back|reverted) (.{10,200})/gi,
    /(?:outage|incident|failure|broke|broken|crashed)(?:: | — | - )(.{10,200})/gi,
    /(?:fixed|resolved|patched|hotfixed) (.{10,200})/gi,
  ];

  const allPatterns = [
    ...decisionPatterns,
    ...learnedPatterns,
    ...configPatterns,
    ...preferencePatterns,
    ...operationalPatterns,
  ];

  for (const pattern of allPatterns) {
    let match: RegExpExecArray | null;
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    while ((match = pattern.exec(content)) !== null) {
      const candidate = match[1].trim();
      // Filter out noise
      if (candidate.length > 10 && !candidate.startsWith('```') && !candidate.startsWith('http')) {
        facts.push(candidate);
      }
    }
  }

  return facts;
}

/**
 * Classify a message for episode significance.
 * Returns episode type and significance score, or null if not significant.
 */
function classifyEpisode(msg: StoredMessage): { type: EpisodeType; significance: number; summary: string } | null {
  const content = msg.textContent || '';
  if (!content || content.length < 30) return null;
  const lower = content.toLowerCase();

  // Deployment events (high significance)
  if (
    /(?:deployed|shipped|released|went live|now live|go live)/i.test(content) &&
    !msg.isHeartbeat
  ) {
    const summary = content.slice(0, 200);
    return { type: 'deployment', significance: 0.8, summary };
  }

  // Architecture decisions (high significance)
  if (
    /(?:decided on|chose|committed to|architecture|design decision)/i.test(content) &&
    content.length > 50
  ) {
    const summary = content.slice(0, 200);
    return { type: 'decision', significance: 0.7, summary };
  }

  // Incident/outage (high significance)
  if (/(?:outage|incident|failure|crash|broke|broken|emergency)/i.test(content)) {
    const summary = content.slice(0, 200);
    return { type: 'incident', significance: 0.9, summary };
  }

  // Discovery/insight (medium significance)
  if (/(?:discovered|found|realized|root cause|turns out)/i.test(content) && content.length > 50) {
    const summary = content.slice(0, 200);
    return { type: 'discovery', significance: 0.5, summary };
  }

  // Config changes (medium significance)
  if (/(?:changed|updated|migrated|switched|model.*(?:→|->|to))/i.test(content) && content.length > 40) {
    const summary = content.slice(0, 200);
    return { type: 'config_change', significance: 0.4, summary };
  }

  // Milestone/completion (medium significance)
  if (
    /(?:completed|finished|done|milestone|all tests pass|all green)/i.test(content) &&
    !msg.isHeartbeat
  ) {
    const summary = content.slice(0, 200);
    return { type: 'milestone', significance: 0.5, summary };
  }

  return null;
}

/**
 * Extract knowledge candidates — structured (domain, key, value) tuples.
 */
function extractKnowledgeCandidates(
  content: string,
  agentId: string
): Array<{ domain: string; key: string; value: string }> {
  const results: Array<{ domain: string; key: string; value: string }> = [];
  if (!content || content.length < 30) return results;

  // Path/location patterns
  const pathPatterns = [
    /(?:path|located at|lives at|stored at|found at)[:\s]+(`[^`]+`|\/\S+)/gi,
    /(?:workspace|directory|repo)[:\s]+(`[^`]+`|\/\S+)/gi,
  ];

  for (const pattern of pathPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[1].replace(/`/g, '').trim();
      if (value.startsWith('/') && value.length > 5) {
        const key = value.split('/').pop() || 'unknown';
        results.push({ domain: 'paths', key, value });
      }
    }
  }

  // Service/port patterns
  const servicePatterns = [
    /(\S+)\s+(?:runs on|listening on|port)\s+(\d{2,5})/gi,
    /(?:service|server|daemon)\s+(\S+)\s+(?:on |at |: )(\S+)/gi,
  ];

  for (const pattern of servicePatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      results.push({ domain: 'services', key: match[1], value: match[2] });
    }
  }

  // Agent identity patterns
  const identityPatterns = [
    /(\w+)\s+(?:is|was)\s+(?:the\s+)?(\w+)\s+(?:seat|director|specialist)/gi,
    /(\w+)\s+(?:reports to|owned by|managed by)\s+(\w+)/gi,
  ];

  for (const pattern of identityPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      results.push({ domain: 'fleet', key: match[1].toLowerCase(), value: `${match[1]} ${match[2]}` });
    }
  }

  return results;
}

/**
 * Detect conversation topic from message content.
 * Returns a topic name candidate or null.
 */
function detectTopic(content: string): string | null {
  if (!content || content.length < 50) return null;

  // Product/project name detection
  const productMatch = content.match(
    /\b(HyperMem|ClawText|ClawDash|ClawCanvas|ClawCouncil|ClawTomation|OpenClaw|ClawDispatch)\b/i
  );
  if (productMatch) return productMatch[1];

  // Infrastructure topic detection
  if (/\b(?:redis|sqlite|database|migration|deployment|docker|nginx)\b/i.test(content)) {
    return 'infrastructure';
  }

  // Security topic detection
  if (/\b(?:security|auth|permission|access|token|credential)\b/i.test(content)) {
    return 'security';
  }

  return null;
}

// ─── Background Indexer ─────────────────────────────────────────

export class BackgroundIndexer {
  private readonly config: IndexerConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    config?: Partial<IndexerConfig>,
    private getMessageDb?: (agentId: string) => DatabaseSync,
    private getLibraryDb?: () => DatabaseSync,
    private listAgents?: () => string[]
  ) {
    this.config = {
      enabled: config?.enabled ?? true,
      factExtractionMode: config?.factExtractionMode ?? 'tiered',
      topicDormantAfter: config?.topicDormantAfter ?? '24h',
      topicClosedAfter: config?.topicClosedAfter ?? '7d',
      factDecayRate: config?.factDecayRate ?? 0.01,
      episodeSignificanceThreshold: config?.episodeSignificanceThreshold ?? 0.5,
      periodicInterval: config?.periodicInterval ?? 300000, // 5 minutes
    };
  }

  /**
   * Start periodic indexing.
   */
  start(): void {
    if (!this.config.enabled) return;
    if (this.intervalHandle) return;

    // Run once immediately
    this.tick().catch(err => {
      console.error('[indexer] Initial tick failed:', err);
    });

    // Then periodically
    this.intervalHandle = setInterval(() => {
      this.tick().catch(err => {
        console.error('[indexer] Periodic tick failed:', err);
      });
    }, this.config.periodicInterval);

    console.log(`[indexer] Started with interval ${this.config.periodicInterval}ms`);
  }

  /**
   * Stop periodic indexing.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Run one indexing pass across all agents.
   */
  async tick(): Promise<IndexerStats[]> {
    if (this.running) {
      console.log('[indexer] Skipping tick — previous run still active');
      return [];
    }

    this.running = true;
    const results: IndexerStats[] = [];

    try {
      if (!this.listAgents || !this.getMessageDb || !this.getLibraryDb) {
        console.warn('[indexer] Missing database accessors — skipping');
        return [];
      }

      const agents = this.listAgents();
      const libraryDb = this.getLibraryDb();

      for (const agentId of agents) {
        try {
          const stats = this.processAgent(agentId, libraryDb);
          if (stats.messagesProcessed > 0) {
            results.push(stats);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[indexer] Failed to process ${agentId}: ${msg}`);
        }
      }

      if (results.length > 0) {
        const totalMessages = results.reduce((s, r) => s + r.messagesProcessed, 0);
        const totalFacts = results.reduce((s, r) => s + r.factsExtracted, 0);
        const totalEpisodes = results.reduce((s, r) => s + r.episodesRecorded, 0);
        console.log(
          `[indexer] Tick complete: ${totalMessages} messages → ${totalFacts} facts, ${totalEpisodes} episodes`
        );
      }

      // Run decay on every tick
      this.applyDecay(libraryDb);

    } finally {
      this.running = false;
    }

    return results;
  }

  /**
   * Process a single agent's unindexed messages.
   */
  private processAgent(agentId: string, libraryDb: DatabaseSync): IndexerStats {
    const start = Date.now();
    const messageDb = this.getMessageDb!(agentId);

    const messageStore = new MessageStore(messageDb);
    const factStore = new FactStore(libraryDb);
    const episodeStore = new EpisodeStore(libraryDb);
    const topicStore = new TopicStore(libraryDb);
    const knowledgeStore = new KnowledgeStore(libraryDb);

    // Get watermark — last processed message ID for this agent
    const watermark = this.getWatermark(libraryDb, agentId);
    const lastProcessedId = watermark?.lastMessageId ?? 0;

    // Fetch unindexed messages (batch size: 100)
    const messages = this.getUnindexedMessages(messageDb, agentId, lastProcessedId, 100);

    if (messages.length === 0) {
      return {
        agentId,
        messagesProcessed: 0,
        factsExtracted: 0,
        episodesRecorded: 0,
        topicsUpdated: 0,
        knowledgeUpserted: 0,
        elapsedMs: Date.now() - start,
      };
    }

    let factsExtracted = 0;
    let episodesRecorded = 0;
    let topicsUpdated = 0;
    let knowledgeUpserted = 0;
    let maxMessageId = lastProcessedId;

    for (const msg of messages) {
      const content = msg.textContent || '';
      if (msg.id > maxMessageId) maxMessageId = msg.id;

      // Skip heartbeats and very short messages
      if (msg.isHeartbeat || content.length < 30) continue;

      // 1. Extract facts
      const factCandidates = extractFactCandidates(content);
      for (const factContent of factCandidates) {
        try {
          factStore.addFact(agentId, factContent, {
            scope: 'agent',
            confidence: 0.6,
            sourceType: 'indexer',
            sourceSessionKey: this.getSessionKeyForMessage(messageDb, msg.conversationId),
            sourceRef: `msg:${msg.id}`,
          });
          factsExtracted++;
        } catch {
          // Duplicate or constraint violation — skip
        }
      }

      // 2. Classify episodes
      const episode = classifyEpisode(msg);
      if (episode && episode.significance >= this.config.episodeSignificanceThreshold) {
        try {
          episodeStore.record(agentId, episode.type, episode.summary, {
            significance: episode.significance,
            visibility: 'org',
            sessionKey: this.getSessionKeyForMessage(messageDb, msg.conversationId),
          });
          episodesRecorded++;
        } catch {
          // Skip duplicate episodes
        }
      }

      // 3. Detect and update topics
      const topicName = detectTopic(content);
      if (topicName) {
        try {
          const existingTopics = topicStore.getActive(agentId, 100);
          const existingTopic = existingTopics.find(
            (t) => (t as { name: string }).name.toLowerCase() === topicName.toLowerCase()
          );

          if (!existingTopic) {
            topicStore.create(agentId, topicName, `Auto-detected from conversation`);
            topicsUpdated++;
          }
        } catch {
          // Skip topic creation errors
        }
      }

      // 4. Extract knowledge candidates
      const knowledgeCandidates = extractKnowledgeCandidates(content, agentId);
      for (const { domain, key, value } of knowledgeCandidates) {
        try {
          knowledgeStore.upsert(agentId, domain, key, value, {
            sourceType: 'indexer',
            sourceRef: `msg:${msg.id}`,
          });
          knowledgeUpserted++;
        } catch {
          // Skip duplicates
        }
      }
    }

    // Update watermark
    this.setWatermark(libraryDb, agentId, maxMessageId);

    return {
      agentId,
      messagesProcessed: messages.length,
      factsExtracted,
      episodesRecorded,
      topicsUpdated,
      knowledgeUpserted,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Fetch unindexed messages for an agent.
   */
  private getUnindexedMessages(
    db: DatabaseSync,
    agentId: string,
    afterId: number,
    limit: number
  ): StoredMessage[] {
    const rows = db.prepare(`
      SELECT m.*, c.session_key
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE m.agent_id = ? AND m.id > ?
      ORDER BY m.id ASC
      LIMIT ?
    `).all(agentId, afterId, limit) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as number,
      conversationId: row.conversation_id as number,
      agentId: row.agent_id as string,
      role: row.role as StoredMessage['role'],
      textContent: (row.text_content as string) || null,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : null,
      toolResults: row.tool_results ? JSON.parse(row.tool_results as string) : null,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      messageIndex: row.message_index as number,
      tokenCount: (row.token_count as number) || null,
      isHeartbeat: (row.is_heartbeat as number) === 1,
      createdAt: row.created_at as string,
    }));
  }

  /**
   * Get the session key for a conversation ID.
   */
  private getSessionKeyForMessage(db: DatabaseSync, conversationId: number): string | undefined {
    const row = db.prepare('SELECT session_key FROM conversations WHERE id = ?').get(conversationId) as { session_key: string } | undefined;
    return row?.session_key;
  }

  /**
   * Get the indexing watermark for an agent.
   */
  private getWatermark(libraryDb: DatabaseSync, agentId: string): WatermarkState | null {
    // Ensure watermarks table exists
    libraryDb.prepare(`
      CREATE TABLE IF NOT EXISTS indexer_watermarks (
        agent_id TEXT PRIMARY KEY,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT NOT NULL
      )
    `).run();

    const row = libraryDb.prepare(
      'SELECT agent_id, last_message_id, last_run_at FROM indexer_watermarks WHERE agent_id = ?'
    ).get(agentId) as { agent_id: string; last_message_id: number; last_run_at: string } | undefined;

    if (!row) return null;
    return {
      agentId: row.agent_id,
      lastMessageId: row.last_message_id,
      lastRunAt: row.last_run_at,
    };
  }

  /**
   * Set the indexing watermark for an agent.
   */
  private setWatermark(libraryDb: DatabaseSync, agentId: string, lastMessageId: number): void {
    const now = new Date().toISOString();
    libraryDb.prepare(`
      INSERT INTO indexer_watermarks (agent_id, last_message_id, last_run_at)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        last_message_id = excluded.last_message_id,
        last_run_at = excluded.last_run_at
    `).run(agentId, lastMessageId, now);
  }

  /**
   * Apply time-based decay to facts.
   * Increases decay_score for older facts, making them less relevant.
   */
  private applyDecay(libraryDb: DatabaseSync): void {
    const rate = this.config.factDecayRate;

    // Decay facts that haven't been referenced recently
    libraryDb.prepare(`
      UPDATE facts
      SET decay_score = MIN(1.0, decay_score + ?)
      WHERE superseded_by IS NULL
        AND decay_score < 1.0
        AND updated_at < datetime('now', '-7 days')
    `).run(rate);

    // Decay episodes older than 30 days
    libraryDb.prepare(`
      UPDATE episodes
      SET decay_score = MIN(1.0, decay_score + ?)
      WHERE decay_score < 1.0
        AND created_at < datetime('now', '-30 days')
    `).run(rate * 0.5); // Episodes decay slower

    // Mark dormant topics
    const dormantThreshold = this.parseDuration(this.config.topicDormantAfter);
    if (dormantThreshold > 0) {
      libraryDb.prepare(`
        UPDATE topics
        SET status = 'dormant'
        WHERE status = 'active'
          AND updated_at < datetime('now', '-${dormantThreshold} seconds')
      `).run();
    }

    // Close old dormant topics
    const closedThreshold = this.parseDuration(this.config.topicClosedAfter);
    if (closedThreshold > 0) {
      libraryDb.prepare(`
        UPDATE topics
        SET status = 'closed'
        WHERE status = 'dormant'
          AND updated_at < datetime('now', '-${closedThreshold} seconds')
      `).run();
    }
  }

  /**
   * Parse a duration string like "24h", "7d" into seconds.
   */
  private parseDuration(dur: string): number {
    const match = dur.match(/^(\d+)\s*(h|d|m|s)$/);
    if (!match) return 0;
    const val = parseInt(match[1]);
    switch (match[2]) {
      case 's': return val;
      case 'm': return val * 60;
      case 'h': return val * 3600;
      case 'd': return val * 86400;
      default: return 0;
    }
  }

  /**
   * Get current watermarks for all agents.
   */
  getWatermarks(libraryDb: DatabaseSync): WatermarkState[] {
    try {
      const rows = libraryDb.prepare(
        'SELECT agent_id, last_message_id, last_run_at FROM indexer_watermarks ORDER BY agent_id'
      ).all() as Array<{ agent_id: string; last_message_id: number; last_run_at: string }>;

      return rows.map(r => ({
        agentId: r.agent_id,
        lastMessageId: r.last_message_id,
        lastRunAt: r.last_run_at,
      }));
    } catch {
      return [];
    }
  }
}

// ─── Standalone runner ──────────────────────────────────────────

/**
 * Create and start a background indexer connected to HyperMem databases.
 * Used by the hook or a standalone daemon.
 */
export function createIndexer(
  getMessageDb: (agentId: string) => DatabaseSync,
  getLibraryDb: () => DatabaseSync,
  listAgents: () => string[],
  config?: Partial<IndexerConfig>
): BackgroundIndexer {
  return new BackgroundIndexer(config, getMessageDb, getLibraryDb, listAgents);
}
