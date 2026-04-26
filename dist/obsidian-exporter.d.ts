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
import type { DatabaseSync } from 'node:sqlite';
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
export declare function exportToVault(mainDb: DatabaseSync, libraryDb: DatabaseSync, config: ObsidianExportConfig): ObsidianExportResult;
//# sourceMappingURL=obsidian-exporter.d.ts.map