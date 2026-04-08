/**
 * wiki-page-emitter.ts
 *
 * Query-time API for the hypermem wiki layer.
 * Retrieves synthesized topic pages, resolves cross-links,
 * and triggers on-demand synthesis when pages are stale/missing.
 */

import type { DatabaseSync } from 'node:sqlite';
import { KnowledgeStore } from './knowledge-store.js';
import { TopicSynthesizer, type SynthesisConfig, SYNTHESIS_REGROWTH_THRESHOLD } from './topic-synthesizer.js';

// ─── Types ──────────────────────────────────────────────────────

export interface WikiPage {
  topicName: string;
  content: string;         // full markdown from knowledge table
  version: number;
  updatedAt: string;
  crossLinks: WikiLink[];  // resolved from knowledge_links
}

export interface WikiLink {
  topicName: string;
  linkType: string;        // 'supports' | 'contradicts' | 'depends_on' | 'supersedes' | 'related'
  direction: 'from' | 'to';
}

export interface WikiPageSummary {
  topicName: string;
  updatedAt: string;
  messageCount: number;
  version: number;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Parse message_count stored in source_ref ("topic:<id>:mc:<count>").
 */
function parseStoredMessageCount(sourceRef: string | null): number {
  if (!sourceRef) return 0;
  const match = sourceRef.match(/:mc:(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

// ─── WikiPageEmitter ────────────────────────────────────────────

export class WikiPageEmitter {
  private readonly knowledgeStore: KnowledgeStore;
  private readonly synthesizer: TopicSynthesizer;
  private readonly regrowthThreshold: number;

  constructor(
    private readonly libraryDb: DatabaseSync,
    private readonly getMessageDb: (agentId: string) => DatabaseSync | null,
    private readonly synthConfig?: Partial<SynthesisConfig>
  ) {
    this.knowledgeStore = new KnowledgeStore(libraryDb);
    this.synthesizer = new TopicSynthesizer(libraryDb, getMessageDb, synthConfig);
    this.regrowthThreshold = synthConfig?.SYNTHESIS_REGROWTH_THRESHOLD ?? SYNTHESIS_REGROWTH_THRESHOLD;
  }

  /**
   * Fetch the version number for an active knowledge entry.
   */
  private getVersion(agentId: string, topicName: string): number {
    try {
      const row = this.libraryDb.prepare(`
        SELECT version FROM knowledge
        WHERE agent_id = ? AND domain = 'topic-synthesis' AND key = ?
        AND superseded_by IS NULL
        LIMIT 1
      `).get(agentId, topicName) as { version: number } | undefined;
      return row?.version ?? 1;
    } catch {
      return 1;
    }
  }

  /**
   * Get a wiki page for a topic.
   * If no page exists, or page is stale (topic has grown by >= regrowthThreshold
   * since last synthesis), trigger a synthesis pass first.
   * Returns null if topic has no messages or doesn't exist.
   */
  getPage(agentId: string, topicName: string): WikiPage | null {
    // Look up topic to check current message_count and existence
    let topicRow: { id: number; message_count: number } | undefined;
    try {
      topicRow = this.libraryDb.prepare(`
        SELECT id, message_count FROM topics
        WHERE agent_id = ? AND name = ?
        LIMIT 1
      `).get(agentId, topicName) as { id: number; message_count: number } | undefined;
    } catch {
      // Topics table may not exist or topic not found
    }

    // Check existing synthesis
    const existing = this.knowledgeStore.get(agentId, 'topic-synthesis', topicName);

    if (existing) {
      // Check staleness if we have topic data
      if (topicRow) {
        const storedMc = parseStoredMessageCount(existing.sourceRef);
        const growth = topicRow.message_count - storedMc;
        if (growth >= this.regrowthThreshold) {
          // Stale — re-synthesize by running a targeted tick
          // TopicSynthesizer.tick() picks up topics that have grown enough
          this.synthesizer.tick(agentId);
        }
      }
    } else {
      // No page at all — trigger synthesis regardless of staleness threshold
      if (!topicRow) return null;
      const messageDb = this.getMessageDb(agentId);
      if (!messageDb) return null;

      // Check if there are actually messages for this topic before attempting synthesis
      let msgCount = 0;
      try {
        const row = messageDb.prepare(
          'SELECT COUNT(*) AS cnt FROM messages WHERE topic_id = ?'
        ).get(String(topicRow.id)) as { cnt: number } | undefined;
        msgCount = row?.cnt ?? 0;
      } catch {
        // messages table query failed
      }

      if (msgCount === 0) return null;

      this.synthesizer.tick(agentId);
    }

    // Re-fetch after possible synthesis
    const knowledge = this.knowledgeStore.get(agentId, 'topic-synthesis', topicName);
    if (!knowledge) return null;

    const crossLinks = this.resolveLinks(agentId, knowledge.id);

    return {
      topicName,
      content: knowledge.content,
      version: this.getVersion(agentId, topicName),
      updatedAt: knowledge.updatedAt,
      crossLinks,
    };
  }

  /**
   * List all synthesized pages for an agent — the table of contents.
   */
  listPages(agentId: string, opts?: { limit?: number; domain?: string }): WikiPageSummary[] {
    const domain = opts?.domain ?? 'topic-synthesis';
    const limit = opts?.limit ?? 100;

    let rows: Array<{ key: string; updated_at: string; version: number; source_ref: string | null }>;
    try {
      rows = this.libraryDb.prepare(`
        SELECT key, updated_at, version, source_ref
        FROM knowledge
        WHERE agent_id = ?
          AND domain = ?
          AND superseded_by IS NULL
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(agentId, domain, limit) as Array<{
        key: string;
        updated_at: string;
        version: number;
        source_ref: string | null;
      }>;
    } catch {
      return [];
    }

    return rows.map(row => ({
      topicName: row.key,
      updatedAt: row.updated_at,
      messageCount: parseStoredMessageCount(row.source_ref),
      version: row.version,
    }));
  }

  /**
   * Get a page's cross-links from knowledge_links table.
   * Resolves both directions (from and to).
   */
  private resolveLinks(agentId: string, knowledgeId: number): WikiLink[] {
    const links: WikiLink[] = [];

    // Outgoing links (from this knowledge entry to another)
    let fromRows: Array<{ to_id: number; link_type: string }> = [];
    try {
      fromRows = this.libraryDb.prepare(`
        SELECT kl.to_id, kl.link_type
        FROM knowledge_links kl
        WHERE kl.from_type = 'knowledge' AND kl.from_id = ?
          AND kl.to_type = 'knowledge'
      `).all(knowledgeId) as Array<{ to_id: number; link_type: string }>;
    } catch {
      // knowledge_links may not exist
    }

    for (const row of fromRows) {
      // Look up the topic name from the target knowledge row
      let targetKey: string | null = null;
      try {
        const targetRow = this.libraryDb.prepare(`
          SELECT key FROM knowledge
          WHERE id = ? AND agent_id = ? AND domain = 'topic-synthesis'
        `).get(row.to_id, agentId) as { key: string } | undefined;
        targetKey = targetRow?.key ?? null;
      } catch {
        // Ignore
      }
      if (targetKey) {
        links.push({ topicName: targetKey, linkType: row.link_type, direction: 'from' });
      }
    }

    // Incoming links (from other knowledge entries to this one)
    let toRows: Array<{ from_id: number; link_type: string }> = [];
    try {
      toRows = this.libraryDb.prepare(`
        SELECT kl.from_id, kl.link_type
        FROM knowledge_links kl
        WHERE kl.to_type = 'knowledge' AND kl.to_id = ?
          AND kl.from_type = 'knowledge'
      `).all(knowledgeId) as Array<{ from_id: number; link_type: string }>;
    } catch {
      // Ignore
    }

    for (const row of toRows) {
      let sourceKey: string | null = null;
      try {
        const sourceRow = this.libraryDb.prepare(`
          SELECT key FROM knowledge
          WHERE id = ? AND agent_id = ? AND domain = 'topic-synthesis'
        `).get(row.from_id, agentId) as { key: string } | undefined;
        sourceKey = sourceRow?.key ?? null;
      } catch {
        // Ignore
      }
      if (sourceKey) {
        links.push({ topicName: sourceKey, linkType: row.link_type, direction: 'to' });
      }
    }

    return links;
  }

  /**
   * Force re-synthesis of a specific topic regardless of staleness.
   * Returns the new page or null if topic not found.
   */
  forceSynthesize(agentId: string, topicName: string): WikiPage | null {
    // Verify topic exists
    let topicId: number | undefined;
    try {
      const row = this.libraryDb.prepare(`
        SELECT id FROM topics WHERE agent_id = ? AND name = ? LIMIT 1
      `).get(agentId, topicName) as { id: number } | undefined;
      topicId = row?.id;
    } catch {
      // Topics table may not exist
    }

    if (topicId === undefined) return null;

    // Invalidate existing synthesis by setting superseded_by so tick() will re-synthesize
    // Strategy: temporarily lower the stored message_count to force re-synthesis.
    // Actually, simplest approach: call tick() after removing the existing knowledge entry.
    // But KnowledgeStore doesn't have a delete method. Instead, we can use the upsert
    // with forced content change to invalidate, then call tick().
    //
    // Better approach: use a fresh synthesizer with regrowthThreshold=0 so any growth triggers.
    const forceSynth = new TopicSynthesizer(this.libraryDb, this.getMessageDb, {
      ...this.synthConfig,
      SYNTHESIS_REGROWTH_THRESHOLD: 0,
      SYNTHESIS_STALE_MINUTES: 0, // bypass staleness time gate too
    });
    forceSynth.tick(agentId);

    const knowledge = this.knowledgeStore.get(agentId, 'topic-synthesis', topicName);
    if (!knowledge) return null;

    const crossLinks = this.resolveLinks(agentId, knowledge.id);

    return {
      topicName,
      content: knowledge.content,
      version: this.getVersion(agentId, topicName),
      updatedAt: knowledge.updatedAt,
      crossLinks,
    };
  }
}
