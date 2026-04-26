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
import { watch, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { hashContent, chunkMarkdown } from './doc-chunker.js';
import { isSafeForSharedVisibility } from './secret-scanner.js';
// ─── Frontmatter parser ──────────────────────────────────────────
/**
 * Extract YAML frontmatter from a markdown file.
 * Returns { frontmatter, body } where frontmatter is a key/value map
 * and body is the content after the closing ---.
 */
export function parseFrontmatter(content) {
    const frontmatter = {};
    if (!content.startsWith('---')) {
        return { frontmatter, body: content };
    }
    const end = content.indexOf('\n---', 3);
    if (end === -1) {
        return { frontmatter, body: content };
    }
    const yaml = content.slice(4, end).trim();
    const body = content.slice(end + 4).trim();
    // Simple YAML key: value parser (no nested objects — Obsidian frontmatter is flat)
    for (const line of yaml.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        const rawVal = line.slice(colonIdx + 1).trim();
        if (!key)
            continue;
        // Handle list values: "- item" lines that follow a key
        // Simple case: tags: [tag1, tag2] or tags: tag1, tag2
        if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
            frontmatter[key] = rawVal
                .slice(1, -1)
                .split(',')
                .map(s => s.trim().replace(/^["']|["']$/g, ''))
                .filter(Boolean);
        }
        else if (rawVal === '' || rawVal === '~' || rawVal === 'null') {
            frontmatter[key] = null;
        }
        else if (rawVal === 'true') {
            frontmatter[key] = true;
        }
        else if (rawVal === 'false') {
            frontmatter[key] = false;
        }
        else if (!isNaN(Number(rawVal)) && rawVal !== '') {
            frontmatter[key] = Number(rawVal);
        }
        else {
            frontmatter[key] = rawVal.replace(/^["']|["']$/g, '');
        }
    }
    return { frontmatter, body };
}
// ─── Wikilink extractor ──────────────────────────────────────────
/**
 * Extract all [[wikilinks]] from markdown content.
 * Handles:
 *   [[Page Name]]          → { target: 'Page Name' }
 *   [[Page Name|Alias]]    → { target: 'Page Name', alias: 'Alias' }
 *   ![[Embedded File.png]] → { target: 'Embedded File.png', isEmbed: true }
 */
export function extractWikilinks(content) {
    const links = [];
    const pattern = /(!?)\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
        const isEmbed = match[1] === '!';
        const inner = match[2].trim();
        const pipeIdx = inner.indexOf('|');
        if (pipeIdx !== -1) {
            links.push({
                target: inner.slice(0, pipeIdx).trim(),
                alias: inner.slice(pipeIdx + 1).trim(),
                isEmbed,
            });
        }
        else {
            links.push({ target: inner, isEmbed });
        }
    }
    return links;
}
// ─── Tag extractor ───────────────────────────────────────────────
/**
 * Extract #tags from markdown content (not inside code blocks).
 * Also merges frontmatter tags array if present.
 */
export function extractTags(content, frontmatter) {
    const tags = new Set();
    // Content #tags (not inside code blocks or URLs)
    const tagPattern = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9/_-]*)/g;
    let match;
    while ((match = tagPattern.exec(content)) !== null) {
        tags.add(match[1].toLowerCase());
    }
    // Frontmatter tags
    const fmTags = frontmatter['tags'];
    if (Array.isArray(fmTags)) {
        for (const t of fmTags) {
            if (typeof t === 'string')
                tags.add(t.toLowerCase().replace(/^#/, ''));
        }
    }
    else if (typeof fmTags === 'string') {
        tags.add(fmTags.toLowerCase().replace(/^#/, ''));
    }
    return Array.from(tags);
}
// ─── Content cleaner ─────────────────────────────────────────────
/**
 * Clean Obsidian markdown for chunking:
 * - Convert [[wikilinks]] to plain text (preserve the label)
 * - Strip ![[embeds]] entirely
 * - Strip Obsidian-specific syntax that confuses the chunker
 */
export function cleanObsidianMarkdown(content) {
    return content
        // Remove embedded files: ![[file.png]]
        .replace(/!\[\[[^\]]+\]\]/g, '')
        // Convert wikilinks with alias to alias text: [[Page|Alias]] → Alias
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
        // Convert plain wikilinks to plain text: [[Page Name]] → Page Name
        .replace(/\[\[([^\]]+)\]\]/g, '$1')
        // Strip Obsidian callout syntax: > [!note]
        .replace(/^>\s*\[![\w]+\]/gm, '>')
        .trim();
}
// ─── Vault scanner ───────────────────────────────────────────────
/**
 * Default folders to always exclude from Obsidian import.
 */
const DEFAULT_EXCLUDE_FOLDERS = new Set([
    '.obsidian',
    '.trash',
    'templates',
    'Templates',
    'attachments',
    'Attachments',
    '_attachments',
    '.git',
]);
/**
 * Read Obsidian's excluded folders from .obsidian/app.json if present.
 */
function readObsidianExcludedFolders(vaultPath) {
    const appJson = join(vaultPath, '.obsidian', 'app.json');
    if (!existsSync(appJson))
        return [];
    try {
        const config = JSON.parse(readFileSync(appJson, 'utf-8'));
        return Array.isArray(config.excludedFolders) ? config.excludedFolders : [];
    }
    catch {
        return [];
    }
}
/**
 * Recursively collect all .md files in a vault, respecting exclusions.
 */
function collectVaultFiles(dir, vaultRoot, excludeFolders, results = []) {
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return results;
    }
    for (const entry of entries) {
        const fullPath = join(dir, entry);
        const relPath = relative(vaultRoot, fullPath);
        // Check if any path segment is excluded
        const segments = relPath.split('/');
        if (segments.some(s => excludeFolders.has(s)))
            continue;
        let stat;
        try {
            stat = statSync(fullPath);
        }
        catch {
            continue;
        }
        if (stat.isDirectory()) {
            collectVaultFiles(fullPath, vaultRoot, excludeFolders, results);
        }
        else if (extname(entry) === '.md') {
            results.push(fullPath);
        }
    }
    return results;
}
// ─── Note parser ─────────────────────────────────────────────────
/**
 * Parse a single Obsidian markdown file into an ObsidianNote.
 * Returns null if the file cannot be read or fails secret scanning.
 */
export function parseObsidianNote(filePath, vaultRoot) {
    let raw;
    try {
        raw = readFileSync(filePath, 'utf-8');
    }
    catch {
        return null;
    }
    // Secret scan before doing anything with content
    if (!isSafeForSharedVisibility(raw)) {
        return null;
    }
    const contentHash = hashContent(raw);
    const { frontmatter, body } = parseFrontmatter(raw);
    const wikilinks = extractWikilinks(body);
    const tags = extractTags(body, frontmatter);
    const cleanedContent = cleanObsidianMarkdown(body);
    const relativePath = relative(vaultRoot, filePath);
    // Title: frontmatter title > filename without extension
    const title = typeof frontmatter['title'] === 'string'
        ? frontmatter['title']
        : basename(filePath, '.md');
    let modifiedAt;
    try {
        modifiedAt = new Date(statSync(filePath).mtimeMs);
    }
    catch {
        modifiedAt = new Date();
    }
    return {
        relativePath,
        title,
        content: cleanedContent,
        frontmatter,
        tags,
        wikilinks,
        contentHash,
        modifiedAt,
    };
}
// ─── Importer ────────────────────────────────────────────────────
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
export function importVault(config, seenHashes = new Map()) {
    const { vaultPath, collection = 'obsidian/vault', excludeFolders: userExclude = [], agentId, importTags = true, importFrontmatter: _importFm = true, } = config;
    if (!existsSync(vaultPath)) {
        return { imported: 0, skipped: 0, failed: 0, chunks: [], notes: [], wikilinks: new Map() };
    }
    // Build exclusion set
    const obsidianExcluded = readObsidianExcludedFolders(vaultPath);
    const excludeSet = new Set([
        ...DEFAULT_EXCLUDE_FOLDERS,
        ...obsidianExcluded,
        ...userExclude,
    ]);
    const files = collectVaultFiles(vaultPath, vaultPath, excludeSet);
    const allChunks = [];
    const allNotes = [];
    const allWikilinks = new Map();
    let imported = 0;
    let skipped = 0;
    let failed = 0;
    for (const filePath of files) {
        const note = parseObsidianNote(filePath, vaultPath);
        if (!note) {
            failed++;
            continue;
        }
        // Skip unchanged files
        const prev = seenHashes.get(note.relativePath);
        if (prev === note.contentHash) {
            skipped++;
            continue;
        }
        // Track wikilinks for cross-reference resolution
        if (note.wikilinks.length > 0) {
            allWikilinks.set(note.relativePath, note.wikilinks);
        }
        // Build tag annotation to append to content
        const tagLine = importTags && note.tags.length > 0
            ? `\n\n<!-- tags: ${note.tags.join(', ')} -->`
            : '';
        const annotatedContent = note.content + tagLine;
        // Chunk the cleaned content
        const chunks = chunkMarkdown(annotatedContent, {
            collection,
            sourcePath: note.relativePath,
            scope: 'per-agent',
            agentId,
        });
        allChunks.push(...chunks);
        allNotes.push(note);
        seenHashes.set(note.relativePath, note.contentHash);
        imported++;
    }
    return {
        imported,
        skipped,
        failed,
        chunks: allChunks,
        notes: allNotes,
        wikilinks: allWikilinks,
    };
}
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
export function watchVault(config, onChange) {
    const seenHashes = new Map();
    const interval = config.watchInterval ?? 30_000;
    // Initial import
    const initial = importVault(config, seenHashes);
    if (initial.imported > 0) {
        void onChange(initial);
    }
    // Debounce: coalesce rapid change events into one import pass
    let debounceTimer = null;
    function scheduleImport() {
        if (debounceTimer)
            clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const result = importVault(config, seenHashes);
            if (result.imported > 0) {
                void onChange(result);
            }
        }, 1500);
    }
    // fs.watch on the vault directory (recursive where supported)
    let watcher = null;
    try {
        watcher = watch(config.vaultPath, { recursive: true }, (eventType, filename) => {
            if (filename && extname(filename) === '.md') {
                scheduleImport();
            }
        });
        watcher.on('error', () => {
            // fs.watch failed; fall through to polling
            watcher = null;
        });
    }
    catch {
        watcher = null;
    }
    // Polling fallback (always runs alongside watch as belt-and-suspenders)
    const pollTimer = setInterval(() => {
        scheduleImport();
    }, interval);
    return {
        stop() {
            if (debounceTimer)
                clearTimeout(debounceTimer);
            clearInterval(pollTimer);
            watcher?.close();
        },
    };
}
//# sourceMappingURL=obsidian-watcher.js.map