/**
 * obsidian-exporter.ts
 *
 * Exports hypermem facts and wiki pages to an Obsidian vault.
 * Complements obsidian-watcher.ts (import direction).
 *
 * Output format:
 *   - Wiki pages → one .md file per topic, with frontmatter + [[wikilinks]]
 *   - Facts → grouped by domain into .md files, frontmatter-tagged
 *   - Index note → _hypermem-index.md with TOC and stats
 *
 * Safe to run repeatedly — existing files are overwritten only if content changed.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ObsidianExportConfig {
  /** Absolute path to target Obsidian vault directory */
  vaultPath: string;
  /** Sub-folder inside vault to write hypermem exports. Default: 'hypermem' */
  vaultFolder?: string;
  /** Agent ID to scope export to. If omitted, exports all agents */
  agentId?: string;
  /** Include raw facts (not just wiki pages). Default: true */
  includeFacts?: boolean;
  /** Include synthesized wiki pages. Default: true */
  includeWikiPages?: boolean;
  /** Include an index note. Default: true */
  includeIndex?: boolean;
  /** Tag prefix added to all exported notes. Default: 'hypermem' */
  tagPrefix?: string;
  /** Skip files whose content hasn't changed. Default: true */
  skipUnchanged?: boolean;
}

export interface ObsidianExportResult {
  written: number;
  skipped: number;
  errors: string[];
  outputDir: string;
  files: string[];
}

interface FactRow {
  id: number;
  agent_id: string;
  scope: string;
  domain: string | null;
  content: string;
  confidence: number;
  tags: string | null;
  created_at: number;
  updated_at: number;
}

interface KnowledgeRow {
  id: number;
  agent_id: string;
  key: string;
  content: string;
  domain: string | null;
  topic: string | null;
  tags: string | null;
  created_at: number;
  updated_at: number;
  superseded_at: number | null;
}

interface KnowledgeLinkRow {
  from_id: number;
  to_id: number;
  link_type: string;
  to_key: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function safeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function formatTimestamp(unixMs: number): string {
  return new Date(unixMs).toISOString().split('T')[0];
}

function yamlString(value: string): string {
  if (/[:#\[\]{},&*?|<>=!%@`]/.test(value) || value.includes('\n')) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function buildFrontmatter(fields: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlString(String(item))}`);
    } else {
      lines.push(`${key}: ${yamlString(String(value))}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function writeIfChanged(
  filePath: string,
  content: string,
  skipUnchanged: boolean,
  result: ObsidianExportResult
): void {
  if (skipUnchanged && existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8');
    if (existing === content) {
      result.skipped++;
      return;
    }
  }
  writeFileSync(filePath, content, 'utf8');
  result.written++;
  result.files.push(filePath);
}

// ─── Wiki page export ────────────────────────────────────────────────────────

function exportWikiPages(
  libraryDb: DatabaseSync,
  outputDir: string,
  agentFilter: string | null,
  tagPrefix: string,
  skipUnchanged: boolean,
  result: ObsidianExportResult
): string[] {
  const wikiDir = join(outputDir, 'wiki');
  mkdirSync(wikiDir, { recursive: true });

  let rows: KnowledgeRow[];
  try {
    const sql = agentFilter
      ? `SELECT * FROM knowledge WHERE agent_id = ? AND superseded_at IS NULL AND domain = 'topic-synthesis' ORDER BY updated_at DESC`
      : `SELECT * FROM knowledge WHERE superseded_at IS NULL AND domain = 'topic-synthesis' ORDER BY updated_at DESC`;
    rows = (agentFilter
      ? libraryDb.prepare(sql).all(agentFilter)
      : libraryDb.prepare(sql).all()) as unknown as KnowledgeRow[];
  } catch {
    result.errors.push('wiki: failed to query knowledge table');
    return [];
  }

  const topicFiles: string[] = [];

  for (const row of rows) {
    try {
      const rawTags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
      const tags = [tagPrefix, `${tagPrefix}/wiki`, ...rawTags];

      // Resolve cross-links from knowledge_links table
      let linkRows: KnowledgeLinkRow[] = [];
      try {
        linkRows = libraryDb.prepare(`
          SELECT kl.from_id, kl.to_id, kl.link_type, k.key as to_key
          FROM knowledge_links kl
          JOIN knowledge k ON k.id = kl.to_id
          WHERE kl.from_id = ? AND kl.from_type = 'knowledge' AND kl.to_type = 'knowledge'
        `).all(row.id) as unknown as KnowledgeLinkRow[];
      } catch {
        // knowledge_links may not exist yet — non-fatal
      }

      const wikilinks = linkRows
        .map(l => `[[${safeFilename(l.to_key)}]]`)
        .join(' ');

      const frontmatter = buildFrontmatter({
        title: row.key,
        tags,
        agent: row.agent_id,
        topic: row.topic || row.key,
        domain: row.domain,
        'hypermem-type': 'wiki-page',
        'last-synthesized': formatTimestamp(row.updated_at),
        'created-at': formatTimestamp(row.created_at),
      });

      let body = row.content.trim();

      if (linkRows.length > 0) {
        body += `\n\n## Related Topics\n\n${wikilinks}`;
      }

      const note = `${frontmatter}${body}\n`;
      const fileName = `${safeFilename(row.key)}.md`;
      const filePath = join(wikiDir, fileName);

      writeIfChanged(filePath, note, skipUnchanged, result);
      topicFiles.push(fileName);
    } catch (err) {
      result.errors.push(`wiki: failed to export topic '${row.key}': ${String(err)}`);
    }
  }

  return topicFiles;
}

// ─── Facts export ────────────────────────────────────────────────────────────

function exportFacts(
  mainDb: DatabaseSync,
  outputDir: string,
  agentFilter: string | null,
  tagPrefix: string,
  skipUnchanged: boolean,
  result: ObsidianExportResult
): string[] {
  const factsDir = join(outputDir, 'facts');
  mkdirSync(factsDir, { recursive: true });

  let rows: FactRow[];
  try {
    const sql = agentFilter
      ? `SELECT * FROM facts WHERE agent_id = ? ORDER BY domain, updated_at DESC`
      : `SELECT * FROM facts ORDER BY agent_id, domain, updated_at DESC`;
    rows = (agentFilter
      ? mainDb.prepare(sql).all(agentFilter)
      : mainDb.prepare(sql).all()) as unknown as FactRow[];
  } catch {
    result.errors.push('facts: failed to query facts table');
    return [];
  }

  // Group by agent + domain
  const groups = new Map<string, FactRow[]>();
  for (const row of rows) {
    const domain = row.domain || 'general';
    const key = `${row.agent_id}__${domain}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const factFiles: string[] = [];

  for (const [groupKey, facts] of groups) {
    try {
      const [agentId, domain] = groupKey.split('__');
      const rawTags = [tagPrefix, `${tagPrefix}/facts`, `agent/${agentId}`, `domain/${domain}`];

      const frontmatter = buildFrontmatter({
        title: `${agentId} — ${domain} facts`,
        tags: rawTags,
        agent: agentId,
        domain,
        'hypermem-type': 'facts',
        'fact-count': facts.length,
        'last-updated': formatTimestamp(Math.max(...facts.map(f => f.updated_at))),
      });

      const lines: string[] = [`# ${agentId} — ${domain}\n`];

      for (const fact of facts) {
        const confidence = Math.round(fact.confidence * 100);
        const date = formatTimestamp(fact.updated_at);
        const factTags = fact.tags
          ? (JSON.parse(fact.tags) as string[]).map(t => `#${t}`).join(' ')
          : '';
        lines.push(`- ${fact.content}  `);
        lines.push(`  *confidence: ${confidence}% · ${date}${factTags ? ' · ' + factTags : ''}*\n`);
      }

      const note = `${frontmatter}${lines.join('\n')}\n`;
      const fileName = `${safeFilename(agentId)}-${safeFilename(domain)}.md`;
      const filePath = join(factsDir, fileName);

      writeIfChanged(filePath, note, skipUnchanged, result);
      factFiles.push(fileName);
    } catch (err) {
      result.errors.push(`facts: failed to export group '${groupKey}': ${String(err)}`);
    }
  }

  return factFiles;
}

// ─── Index note ───────────────────────────────────────────────────────────────

function exportIndex(
  outputDir: string,
  wikiFiles: string[],
  factFiles: string[],
  tagPrefix: string,
  skipUnchanged: boolean,
  result: ObsidianExportResult
): void {
  const now = new Date().toISOString();
  const frontmatter = buildFrontmatter({
    title: 'hypermem export index',
    tags: [tagPrefix, `${tagPrefix}/index`],
    'hypermem-type': 'index',
    'exported-at': now,
    'wiki-pages': wikiFiles.length,
    'fact-files': factFiles.length,
  });

  const lines = [
    '# hypermem export index\n',
    `> exported at ${now}\n`,
  ];

  if (wikiFiles.length > 0) {
    lines.push('## wiki pages\n');
    for (const f of wikiFiles) {
      const name = f.replace('.md', '');
      lines.push(`- [[wiki/${name}]]`);
    }
    lines.push('');
  }

  if (factFiles.length > 0) {
    lines.push('## fact collections\n');
    for (const f of factFiles) {
      const name = f.replace('.md', '');
      lines.push(`- [[facts/${name}]]`);
    }
    lines.push('');
  }

  const note = `${frontmatter}${lines.join('\n')}\n`;
  const filePath = join(outputDir, '_hypermem-index.md');
  writeIfChanged(filePath, note, skipUnchanged, result);
}

// ─── Main export function ────────────────────────────────────────────────────

/**
 * Export hypermem memories to an Obsidian vault.
 *
 * @param mainDb - hypermem main DB (facts, episodes)
 * @param libraryDb - hypermem library DB (knowledge, wiki pages)
 * @param config - export config
 * @returns ObsidianExportResult with counts and file list
 *
 * @example
 * const result = await exportToVault(mainDb, libraryDb, {
 *   vaultPath: '/Users/me/obsidian/my-vault',
 *   agentId: 'main',
 *   tagPrefix: 'hypermem',
 * });
 * console.log(`Wrote ${result.written} files to ${result.outputDir}`);
 */
export function exportToVault(
  mainDb: DatabaseSync,
  libraryDb: DatabaseSync,
  config: ObsidianExportConfig
): ObsidianExportResult {
  const vaultFolder = config.vaultFolder ?? 'hypermem';
  const tagPrefix = config.tagPrefix ?? 'hypermem';
  const includeFacts = config.includeFacts ?? true;
  const includeWikiPages = config.includeWikiPages ?? true;
  const includeIndex = config.includeIndex ?? true;
  const skipUnchanged = config.skipUnchanged ?? true;
  const agentFilter = config.agentId ?? null;

  const outputDir = resolve(config.vaultPath, vaultFolder);
  mkdirSync(outputDir, { recursive: true });

  const result: ObsidianExportResult = {
    written: 0,
    skipped: 0,
    errors: [],
    outputDir,
    files: [],
  };

  const wikiFiles = includeWikiPages
    ? exportWikiPages(libraryDb, outputDir, agentFilter, tagPrefix, skipUnchanged, result)
    : [];

  const factFiles = includeFacts
    ? exportFacts(mainDb, outputDir, agentFilter, tagPrefix, skipUnchanged, result)
    : [];

  if (includeIndex) {
    exportIndex(outputDir, wikiFiles, factFiles, tagPrefix, skipUnchanged, result);
  }

  return result;
}
