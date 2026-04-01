/**
 * HyperMem Knowledge Store
 *
 * Long-term structured knowledge — replaces MEMORY.md.
 * Knowledge entries are keyed (domain + key), versioned via superseded_by,
 * and linked to each other via knowledge_links.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Knowledge } from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function parseKnowledgeRow(row: Record<string, unknown>): Knowledge {
  return {
    id: row.id as number,
    agentId: row.agent_id as string,
    domain: row.domain as string,
    key: row.key as string,
    content: row.content as string,
    confidence: row.confidence as number,
    sourceType: row.source_type as string,
    sourceRef: (row.source_ref as string) || null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: (row.expires_at as string) || null,
    supersededBy: (row.superseded_by as number) || null,
  };
}

export type LinkType = 'supports' | 'contradicts' | 'depends_on' | 'supersedes' | 'related';

export class KnowledgeStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Upsert a knowledge entry.
   * If the domain+key already exists, the old entry is superseded by the new one.
   */
  upsert(
    agentId: string,
    domain: string,
    key: string,
    content: string,
    opts?: {
      confidence?: number;
      sourceType?: string;
      sourceRef?: string;
      expiresAt?: string;
    }
  ): Knowledge {
    const now = nowIso();
    const sourceType = opts?.sourceType || 'manual';

    // Check for existing entry
    const existing = this.db.prepare(`
      SELECT * FROM knowledge
      WHERE agent_id = ? AND domain = ? AND key = ?
      AND superseded_by IS NULL
    `).get(agentId, domain, key) as Record<string, unknown> | undefined;

    if (existing && (existing.content as string) === content) {
      // Same content — just update timestamp and confidence
      this.db.prepare(`
        UPDATE knowledge SET confidence = ?, updated_at = ? WHERE id = ?
      `).run(opts?.confidence || existing.confidence as number, now, existing.id as number);

      return parseKnowledgeRow({ ...existing, updated_at: now });
    }

    // Insert new entry
    const result = this.db.prepare(`
      INSERT INTO knowledge (agent_id, domain, key, content, confidence, source_type, source_ref, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, domain, key) DO UPDATE SET
        content = excluded.content,
        confidence = excluded.confidence,
        source_type = excluded.source_type,
        source_ref = excluded.source_ref,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(
      agentId,
      domain,
      key,
      content,
      opts?.confidence || 1.0,
      sourceType,
      opts?.sourceRef || null,
      now,
      now,
      opts?.expiresAt || null
    );

    const id = (result as unknown as { lastInsertRowid: number }).lastInsertRowid;

    // If there was an old entry with different content, create supersedes link
    if (existing && (existing.content as string) !== content) {
      this.db.prepare(`
        UPDATE knowledge SET superseded_by = ? WHERE id = ?
      `).run(id, existing.id as number);

      this.addLink(id, existing.id as number, 'supersedes');
    }

    return {
      id,
      agentId,
      domain,
      key,
      content,
      confidence: opts?.confidence || 1.0,
      sourceType,
      sourceRef: opts?.sourceRef || null,
      createdAt: now,
      updatedAt: now,
      expiresAt: opts?.expiresAt || null,
      supersededBy: null,
    };
  }

  /**
   * Get current (non-superseded) knowledge for an agent.
   */
  getActive(
    agentId: string,
    opts?: {
      domain?: string;
      limit?: number;
    }
  ): Knowledge[] {
    let sql = `
      SELECT * FROM knowledge
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
    `;
    const params: (string | number)[] = [agentId];

    if (opts?.domain) {
      sql += ' AND domain = ?';
      params.push(opts.domain);
    }

    sql += ' ORDER BY domain, key';

    if (opts?.limit) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(parseKnowledgeRow);
  }

  /**
   * Get a specific knowledge entry by domain + key.
   */
  get(agentId: string, domain: string, key: string): Knowledge | null {
    const row = this.db.prepare(`
      SELECT * FROM knowledge
      WHERE agent_id = ? AND domain = ? AND key = ?
      AND superseded_by IS NULL
    `).get(agentId, domain, key) as Record<string, unknown> | undefined;

    return row ? parseKnowledgeRow(row) : null;
  }

  /**
   * Get the version history of a knowledge entry.
   */
  getHistory(agentId: string, domain: string, key: string): Knowledge[] {
    const rows = this.db.prepare(`
      SELECT * FROM knowledge
      WHERE agent_id = ? AND domain = ? AND key = ?
      ORDER BY created_at DESC
    `).all(agentId, domain, key) as Record<string, unknown>[];

    return rows.map(parseKnowledgeRow);
  }

  /**
   * Search knowledge by content.
   */
  search(agentId: string, query: string, limit: number = 20): Knowledge[] {
    const rows = this.db.prepare(`
      SELECT * FROM knowledge
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (content LIKE ? OR key LIKE ?)
      ORDER BY confidence DESC
      LIMIT ?
    `).all(agentId, `%${query}%`, `%${query}%`, limit) as Record<string, unknown>[];

    return rows.map(parseKnowledgeRow);
  }

  /**
   * List all domains for an agent.
   */
  getDomains(agentId: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT domain FROM knowledge
      WHERE agent_id = ? AND superseded_by IS NULL
      ORDER BY domain
    `).all(agentId) as Array<{ domain: string }>;

    return rows.map(r => r.domain);
  }

  /**
   * Add a link between knowledge entries.
   */
  addLink(fromId: number, toId: number, linkType: LinkType): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO knowledge_links (from_id, to_id, link_type, created_at)
      VALUES (?, ?, ?, ?)
    `).run(fromId, toId, linkType, nowIso());
  }

  /**
   * Get knowledge count.
   */
  getCount(agentId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM knowledge WHERE agent_id = ? AND superseded_by IS NULL'
    ).get(agentId) as { count: number };
    return row.count;
  }

  /**
   * Import from MEMORY.md content.
   * Parses markdown sections into domain/key/content entries.
   */
  importFromMarkdown(agentId: string, markdown: string, sourcePath: string): number {
    const lines = markdown.split('\n');
    let currentDomain = 'general';
    let currentKey = '';
    let currentContent: string[] = [];
    let imported = 0;

    const flush = () => {
      if (currentKey && currentContent.length > 0) {
        this.upsert(agentId, currentDomain, currentKey, currentContent.join('\n').trim(), {
          sourceType: 'manual',
          sourceRef: sourcePath,
        });
        imported++;
      }
      currentContent = [];
    };

    for (const line of lines) {
      // ## Section = domain
      if (line.startsWith('## ')) {
        flush();
        currentDomain = line.replace('## ', '').trim().toLowerCase().replace(/\s+/g, '_');
        currentKey = '';
        continue;
      }

      // ### Subsection or **Bold** = key
      if (line.startsWith('### ')) {
        flush();
        currentKey = line.replace('### ', '').trim();
        continue;
      }

      // - **Key:** Value pattern
      const kvMatch = line.match(/^[-*]\s+\*\*(.+?)\*\*[:\s]+(.+)/);
      if (kvMatch) {
        flush();
        currentKey = kvMatch[1].trim();
        currentContent.push(kvMatch[2].trim());
        continue;
      }

      // Regular content line
      if (currentKey) {
        currentContent.push(line);
      } else if (line.trim()) {
        // Content without a key — use line hash as key
        currentKey = `note_${lines.indexOf(line)}`;
        currentContent.push(line);
      }
    }

    flush();
    return imported;
  }
}
