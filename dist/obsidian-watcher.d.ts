/**
 * hypermem Obsidian Compatibility Layer
 *
 * Watch a user-configured Obsidian vault directory and import markdown
 * notes into the hypermem fact/doc-chunk pipeline.
 *
 * Obsidian-specific parsing:
 *   - YAML frontmatter (--- blocks): extracted as metadata, tags, aliases
 *   - [[Wikilinks]]: resolved to cross-references, stored as fact relationships
 *   - [[Wikilink|alias]]: aliased links normalized
 *   - ![[Embedded files]]: stripped (non-text embeds skipped)
 *   - #tags: extracted and stored as fact tags
 *   - Backlinks: tracked via wikilink resolution
 *
 * Design:
 *   - Uses fs.watch for low-dependency file watching (no chokidar)
 *   - Idempotent: tracks file hashes, skips unchanged files
 *   - Respects .obsidian/app.json excludedFolders if present
 *   - Sanitizes secrets before ingest (reuses secret-scanner)
 *   - Does NOT ingest .obsidian/ config files, templates, or attachments
 *
 * Config (via HyperMemConfig.obsidian):
 *   vaultPath:        Absolute path to Obsidian vault directory
 *   enabled:          Master switch (default: false)
 *   watchInterval:    Polling interval ms for fs.watch fallback (default: 30000)
 *   collection:       Doc-chunk collection name (default: 'obsidian/vault')
 *   excludeFolders:   Additional folders to skip (merged with .obsidian excludedFolders)
 *   agentId:          Agent to scope imported facts to (default: plugin agentId)
 *   importTags:       Import #tags as fact tags (default: true)
 *   importFrontmatter: Import frontmatter fields as facts (default: true)
 *   staleDays:        Re-import files not seen in N days (default: 7)
 */
import { type DocChunk } from './doc-chunker.js';
export interface ObsidianConfig {
    /** Absolute path to the Obsidian vault directory */
    vaultPath: string;
    /** Master switch — vault is not watched unless true */
    enabled: boolean;
    /** Polling interval ms for change detection (default: 30000) */
    watchInterval?: number;
    /** Collection name for doc-chunk store (default: 'obsidian/vault') */
    collection?: string;
    /** Additional folders to exclude from import */
    excludeFolders?: string[];
    /** Agent ID to scope imported facts to */
    agentId?: string;
    /** Import #tags as fact tags (default: true) */
    importTags?: boolean;
    /** Import frontmatter key/value pairs as facts (default: true) */
    importFrontmatter?: boolean;
    /** Re-import files not seen in N days (default: 7) */
    staleDays?: number;
}
export interface ObsidianNote {
    /** Relative path from vault root */
    relativePath: string;
    /** Note title (filename without extension, or frontmatter title) */
    title: string;
    /** Raw markdown content (post-frontmatter strip) */
    content: string;
    /** Parsed frontmatter fields */
    frontmatter: Record<string, unknown>;
    /** Extracted #tags (from content and frontmatter) */
    tags: string[];
    /** Wikilinks found in this note: [[target]] → target title */
    wikilinks: ObsidianWikiLink[];
    /** SHA-256 of original file content */
    contentHash: string;
    /** File mtime */
    modifiedAt: Date;
}
export interface ObsidianWikiLink {
    /** The target page title (normalized) */
    target: string;
    /** Alias if present: [[target|alias]] */
    alias?: string;
    /** Whether this is an embed: ![[target]] */
    isEmbed: boolean;
}
export interface ObsidianImportResult {
    imported: number;
    skipped: number;
    failed: number;
    chunks: DocChunk[];
    notes: ObsidianNote[];
    wikilinks: Map<string, ObsidianWikiLink[]>;
}
/**
 * Extract YAML frontmatter from a markdown file.
 * Returns { frontmatter, body } where frontmatter is a key/value map
 * and body is the content after the closing ---.
 */
export declare function parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    body: string;
};
/**
 * Extract all [[wikilinks]] from markdown content.
 * Handles:
 *   [[Page Name]]          → { target: 'Page Name' }
 *   [[Page Name|Alias]]    → { target: 'Page Name', alias: 'Alias' }
 *   ![[Embedded File.png]] → { target: 'Embedded File.png', isEmbed: true }
 */
export declare function extractWikilinks(content: string): ObsidianWikiLink[];
/**
 * Extract #tags from markdown content (not inside code blocks).
 * Also merges frontmatter tags array if present.
 */
export declare function extractTags(content: string, frontmatter: Record<string, unknown>): string[];
/**
 * Clean Obsidian markdown for chunking:
 * - Convert [[wikilinks]] to plain text (preserve the label)
 * - Strip ![[embeds]] entirely
 * - Strip Obsidian-specific syntax that confuses the chunker
 */
export declare function cleanObsidianMarkdown(content: string): string;
/**
 * Parse a single Obsidian markdown file into an ObsidianNote.
 * Returns null if the file cannot be read or fails secret scanning.
 */
export declare function parseObsidianNote(filePath: string, vaultRoot: string): ObsidianNote | null;
/**
 * Import all notes from an Obsidian vault into hypermem doc chunks.
 *
 * This is the main entry point for one-shot import. The watcher calls
 * this incrementally on file change events.
 *
 * @param config   ObsidianConfig from HyperMemConfig
 * @param seenHashes  Map of relativePath → contentHash for skip-unchanged logic
 * @returns Import result with chunks ready for doc-chunk-store insertion
 */
export declare function importVault(config: ObsidianConfig, seenHashes?: Map<string, string>): ObsidianImportResult;
export type VaultChangeCallback = (result: ObsidianImportResult) => void | Promise<void>;
/**
 * Watch an Obsidian vault for changes and trigger imports incrementally.
 *
 * Uses Node's built-in fs.watch (no chokidar dependency).
 * Falls back to polling if watch events are unreliable on the platform.
 *
 * @param config    ObsidianConfig
 * @param onChange  Callback receiving incremental import results on each change
 * @returns stop()  Call to unwatch the vault
 */
export declare function watchVault(config: ObsidianConfig, onChange: VaultChangeCallback): {
    stop: () => void;
};
//# sourceMappingURL=obsidian-watcher.d.ts.map