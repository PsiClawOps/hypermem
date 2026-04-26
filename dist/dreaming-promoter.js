/**
 * dreaming-promoter.ts
 *
 * hypermem-native dreaming promotion pass.
 *
 * Unlike the stock memory-core dreaming feature (which appends raw content to
 * MEMORY.md), this promoter generates pointer-format entries that match the
 * council's MEMORY.md convention:
 *
 *   - **{domain} — {title}:** {summary}
 *     → `memory_search("{query}")`
 *
 * Scoring uses confidence, decay, recency, and domain cluster weight.
 * Dedup prevents re-promoting topics already covered by existing pointers.
 *
 * Dry-run mode returns what would be written without modifying any files.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
export const DEFAULT_DREAMER_CONFIG = {
    enabled: false,
    minScore: 0.75,
    minConfidence: 0.70,
    maxPromotionsPerRun: 5,
    tickInterval: 12,
    dryRun: false,
    recencyHalfLifeDays: 7,
    maxAgeDays: 30,
};
// ─── Workspace path resolution ───────────────────────────────────────────────
/**
 * Resolve the workspace directory for an agent.
 * Council agents live at ~/.openclaw/workspace/{agentId}/
 * Other agents at ~/.openclaw/workspace/{agentId}/
 */
export async function resolveAgentWorkspacePath(agentId) {
    const home = os.homedir();
    const councilPath = path.join(home, '.openclaw', 'workspace', agentId);
    const workspacePath = path.join(home, '.openclaw', 'workspace', agentId);
    try {
        await fs.access(councilPath);
        return councilPath;
    }
    catch {
        try {
            await fs.access(workspacePath);
            return workspacePath;
        }
        catch {
            return null;
        }
    }
}
// ─── Scoring ─────────────────────────────────────────────────────────────────
/**
 * Composite promotion score.
 *
 * score = confidence_factor × recency_factor × quality_factor
 *
 * confidence_factor: 0..1 — the raw confidence, penalized by decay
 * recency_factor:    0..1 — exponential decay from age (half-life = config)
 * quality_factor:    0..1 — length/richness proxy (bonus for medium-length facts)
 */
function scoreCandidate(fact, config) {
    const confidenceFactor = fact.confidence * (1 - fact.decayScore * 0.5);
    const halfLife = config.recencyHalfLifeDays;
    const recencyFactor = Math.exp(-(Math.LN2 / halfLife) * fact.ageDays);
    // Quality: medium-length facts (80–180 chars) score best. Very long or very
    // short get penalized — they're likely fragments or noisy captures.
    const len = fact.content.length;
    const qualityFactor = len < 60 ? 0.6 : len > 220 ? 0.75 : 1.0;
    return confidenceFactor * recencyFactor * qualityFactor;
}
// ─── Pointer generation ───────────────────────────────────────────────────────
/**
 * Extract a concise title and search query from fact content.
 * Avoids NLP — purely string heuristics, fast and deterministic.
 */
function extractPointerMeta(content, domain) {
    // Clean up trailing code artifacts
    const cleaned = content
        .replace(/['"]\s*\).*$/, '') // strip trailing '); or '),
        .replace(/',\s*tool_calls:.*$/, '') // strip tool_calls artifacts
        .replace(/…$/, '') // strip ellipsis
        .replace(/\s+/g, ' ')
        .trim();
    // Title: first meaningful clause (up to first period, comma, or 50 chars)
    let title = cleaned.split(/[.,;:]/)[0].trim();
    if (title.length > 55)
        title = title.slice(0, 52) + '…';
    // Query: leading noun phrase — first 6-8 significant words, excluding articles/prepositions
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'as', 'it', 'its',
        'this', 'that', 'we', 'i', 'you', 'they', 'and', 'or', 'but', 'so',
    ]);
    const words = cleaned
        .split(/\s+/)
        .map(w => w.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase())
        .filter(w => w.length > 2 && !stopWords.has(w));
    const queryWords = words.slice(0, 7);
    // Prepend domain as context anchor so search hits the right agent scope
    const query = `${domain} ${queryWords.join(' ')}`.slice(0, 60).trim();
    return { title, query };
}
/**
 * Format a promoted fact as a MEMORY.md pointer entry.
 */
function formatPointer(domain, title, summary, query) {
    // Capitalize domain label for display
    const domainLabel = domain.charAt(0).toUpperCase() + domain.slice(1);
    return `- **${domainLabel} — ${title}:** ${summary}\n  → \`memory_search("${query}")\``;
}
// ─── Dedup ───────────────────────────────────────────────────────────────────
/**
 * Parse existing memory_search() calls from MEMORY.md content.
 * Returns a set of normalized query strings already indexed.
 */
function parseExistingPointers(memoryContent) {
    const existing = new Set();
    const re = /memory_search\("([^"]+)"\)/g;
    let m;
    while ((m = re.exec(memoryContent)) !== null) {
        existing.add(m[1].toLowerCase().trim());
    }
    return existing;
}
/**
 * Check if a proposed query overlaps significantly with any existing pointer.
 * Uses word-level Jaccard similarity (threshold 0.4).
 */
function isDuplicatePointer(proposedQuery, existing) {
    if (existing.has(proposedQuery.toLowerCase().trim()))
        return true;
    const proposedWords = new Set(proposedQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    if (proposedWords.size === 0)
        return false;
    for (const existingQuery of existing) {
        const existingWords = new Set(existingQuery.split(/\s+/).filter(w => w.length > 2));
        const intersection = [...proposedWords].filter(w => existingWords.has(w)).length;
        const union = new Set([...proposedWords, ...existingWords]).size;
        const jaccard = union > 0 ? intersection / union : 0;
        if (jaccard >= 0.4)
            return true;
    }
    return false;
}
// ─── MEMORY.md write ─────────────────────────────────────────────────────────
const PROMOTED_SECTION_HEADER = '## Promoted Facts';
const PROMOTED_SECTION_MARKER = '<!-- hypermem:dreaming-promoted -->';
/**
 * Append promoted pointer entries to MEMORY.md.
 * Writes into an existing "## Promoted Facts" section, or appends one.
 * Non-destructive: only appends, never rewrites existing content.
 */
async function appendToMemoryFile(memoryPath, entries) {
    if (entries.length === 0)
        return;
    let existing = '';
    try {
        existing = await fs.readFile(memoryPath, 'utf-8');
    }
    catch {
        // File doesn't exist — start fresh (unlikely but handle gracefully)
        existing = `# MEMORY.md\n\n_This is an index, not a store. Use \`memory_search\` for full context on any topic._\n\n`;
    }
    const newLines = entries.map(e => e.pointer).join('\n');
    const timestamp = new Date().toISOString().slice(0, 10);
    if (existing.includes(PROMOTED_SECTION_HEADER)) {
        // Inject after the section header line
        const headerIdx = existing.indexOf(PROMOTED_SECTION_HEADER);
        const afterHeader = existing.indexOf('\n', headerIdx) + 1;
        const insertPoint = afterHeader;
        const updated = existing.slice(0, insertPoint) +
            `<!-- promoted ${timestamp} -->\n${newLines}\n` +
            existing.slice(insertPoint);
        await fs.writeFile(memoryPath, updated, 'utf-8');
    }
    else {
        // Append a new section at end of file
        const appendBlock = `\n${PROMOTED_SECTION_HEADER}\n${PROMOTED_SECTION_MARKER}\n` +
            `<!-- promoted ${timestamp} -->\n${newLines}\n`;
        await fs.writeFile(memoryPath, existing.trimEnd() + '\n' + appendBlock, 'utf-8');
    }
}
// ─── Promotion-time content filter ─────────────────────────────────────────
/**
 * Temporal-state markers that indicate a fact is time-bound or conditional.
 *
 * Facts containing any of these markers MUST carry structured recency metadata
 * (`validFrom` / `invalidAt` columns) to be eligible for durable promotion.
 * Plain ISO dates in the content text do NOT satisfy this requirement — a
 * dated sentence like "suspended pending X as of 2026-04-18" is still temporary
 * and would harden stale state if promoted.
 *
 * Exported so tests and downstream callers can verify coverage and extend it.
 * Keep this list centralized; do not fork copies into other modules.
 */
export const TEMPORAL_MARKERS = [
    /\bas of\b/i,
    /\buntil\b/i,
    /\bcurrently\b/i,
    /\bfor now\b/i,
    /\bsuspended\b/i,
    /\bpending\b/i,
    /\brollout\b/i,
    /\bphase\b/i,
    /\btemporary\b/i,
    /\btemporarily\b/i,
    /\brecheck\b/i,
    /\bpaused\b/i,
    /\bblocked\b/i,
    /\btrial\b/i,
    /\bexperiment(?:al)?\b/i,
    /\bexploratory period\b/i,
    /\bin effect during\b/i,
    /\bwhile .* (?:continues|ongoing|in progress|rolls out|rolling out)\b/i,
    /\boverride\b/i,
    /\bhotfix\b/i,
    /\bworkaround\b/i,
    /\bmigration (?:ongoing|in progress|underway)\b/i,
    /\bfreeze(?:d)?\b/i,
    /\bpre-release\b/i,
];
/**
 * Returns true if content contains any temporal-state marker.
 * Exported for test coverage and for callers that want to gate their own writes.
 */
export function hasTemporalMarker(content) {
    return TEMPORAL_MARKERS.some((re) => re.test(content));
}
function hasStrongRecencyMetadata(meta) {
    if (!meta)
        return false;
    const vf = (meta.validFrom ?? '').trim();
    const ia = (meta.invalidAt ?? '').trim();
    return vf.length > 0 || ia.length > 0;
}
/**
 * Reject facts that are clearly noise at promotion time.
 * A second line of defense — the indexer's isQualityFact() is the primary filter,
 * but legacy noise in the DB (pre-TUNE-013) still needs to be caught here.
 *
 * Additionally blocks promotion of temporally-scoped facts that lack structured
 * recency metadata. A fact like "model frozen until provider routing stable"
 * without `validFrom`/`invalidAt` would harden a temporary state into durable
 * memory forever. Plain ISO dates in content text do NOT bypass this check.
 */
export function isPromotable(content, meta) {
    // Multi-line content — reject both actual newlines AND escaped \n sequences
    // (some facts stored pre-TUNE-013 have literal \n in the string value)
    if (content.includes('\n') || content.includes('\\n'))
        return false;
    // External content markers
    if (content.includes('EXTERNAL_UNTRUSTED_CONTENT') || content.includes('<<<'))
        return false;
    // Markdown heading fragments
    if (/^#{1,4}\s/.test(content))
        return false;
    // Code/tool artifacts
    if (/tool_calls:|\)\s*[;,]\s*$|',\s*$/.test(content))
        return false;
    // Escaped newlines embedded in content (stored as literal \n in DB)
    if (/\\n/.test(content))
        return false;
    // URL-heavy (external research/docs, not fleet knowledge)
    const urlCount = (content.match(/https?:\/\//g) || []).length;
    if (urlCount >= 2)
        return false;
    // Fragment starts — no subject (lowercase/article/conjunction lead-ins)
    if (/^(and |or |but |to |in |of |the |a |an |by |for |at |on |with |\d+\.|\* |\- )/.test(content.trim()))
        return false;
    // Context-free references: starts with a possessive/pronoun referencing something outside
    if (/^(it |its |this |that |these |those |they |their |we |our |i |my )/.test(content.toLowerCase().trim()))
        return false;
    // External research noise: benchmark/tool comparison content
    if (/\b(LOCOMO|LoCoMo|LangMem|SuperMemory|Zep|Honcho|Mem0)\b/i.test(content) &&
        /\b(study|benchmark|dataset|employed|researchers|similarity|retrieval|accuracy)\b/i.test(content))
        return false;
    // Apache license boilerplate
    if (/AS IS.*BASIS|distributed under the License/i.test(content))
        return false;
    // Pure CLI output or file path patterns
    if (/^(git |npm |node |python3? |bash |echo |cat |ls |curl )/.test(content.trim()))
        return false;
    // Templated TODO/example patterns (from docs, not real fleet state)
    if (/TODO:|implement Z|capture\.py/.test(content))
        return false;
    // Must start with a capital letter or number (complete sentences only)
    if (!/^[A-Z0-9]/.test(content.trim()))
        return false;
    // Minimum meaningful length: 50 chars as promotion floor (stricter than indexer's 40)
    if (content.trim().length < 50)
        return false;
    // Temporal-state screen: if the content is time-bound ("until X", "suspended
    // pending Y", "rollout phase", etc.) it must carry structured recency
    // metadata. Otherwise the promoter would harden a temporary state into
    // durable memory. Plain ISO dates in the content do NOT satisfy this — a
    // dated sentence confirms the claim is temporary, it does not unblock it.
    if (hasTemporalMarker(content) && !hasStrongRecencyMetadata(meta))
        return false;
    return true;
}
/**
 * Run the dreaming promotion pass for a single agent.
 *
 * Reads qualified facts from library.db, scores them, deduplicates against
 * existing MEMORY.md pointers, and writes new pointer entries.
 */
export async function runDreamingPromoter(agentId, libraryDb, config = {}) {
    const cfg = { ...DEFAULT_DREAMER_CONFIG, ...config };
    const result = {
        agentId,
        candidates: 0,
        promoted: 0,
        skippedDuplicate: 0,
        skippedThreshold: 0,
        entries: [],
        memoryPath: null,
        dryRun: cfg.dryRun,
    };
    // 1. Resolve workspace path
    const wsPath = await resolveAgentWorkspacePath(agentId);
    if (!wsPath) {
        return result; // No workspace — skip silently
    }
    const memoryPath = path.join(wsPath, 'MEMORY.md');
    result.memoryPath = memoryPath;
    // 2. Read existing MEMORY.md (for dedup)
    let memoryContent = '';
    try {
        memoryContent = await fs.readFile(memoryPath, 'utf-8');
    }
    catch {
        // File may not exist — will be created on first promotion
    }
    const existingPointers = parseExistingPointers(memoryContent);
    // 3. Query candidate facts from library.db
    // Criteria: active (not superseded), has domain, meets confidence floor,
    // within age window, not null content
    const cutoffDate = new Date(Date.now() - cfg.maxAgeDays * 86400_000).toISOString();
    const rawFacts = libraryDb.prepare(`
    SELECT
      id,
      agent_id,
      domain,
      content,
      confidence,
      decay_score,
      valid_from,
      invalid_at,
      ROUND((julianday('now') - julianday(created_at)), 2) AS age_days
    FROM facts
    WHERE agent_id = ?
      AND superseded_by IS NULL
      AND domain IS NOT NULL
      AND confidence >= ?
      AND created_at >= ?
      AND LENGTH(content) >= 40
      AND LENGTH(content) <= 300
    ORDER BY confidence DESC, decay_score ASC, created_at DESC
    LIMIT 200
  `).all(agentId, cfg.minConfidence, cutoffDate);
    result.candidates = rawFacts.length;
    // 4. Score and rank
    const scored = rawFacts
        .filter(f => isPromotable(f.content, { validFrom: f.valid_from, invalidAt: f.invalid_at }))
        .map(f => ({
        id: f.id,
        agentId: f.agent_id,
        domain: f.domain,
        content: f.content,
        confidence: f.confidence,
        decayScore: f.decay_score,
        ageDays: f.age_days,
        score: scoreCandidate({ confidence: f.confidence, decayScore: f.decay_score, ageDays: f.age_days, content: f.content }, cfg),
    }));
    scored.sort((a, b) => b.score - a.score);
    // 5. Select up to maxPromotionsPerRun entries, with dedup
    // Track which queries we've already added this run (cross-entry dedup)
    const addedThisRun = new Set(existingPointers);
    const toPromote = [];
    for (const fact of scored) {
        if (toPromote.length >= cfg.maxPromotionsPerRun)
            break;
        // Score threshold
        if (fact.score < cfg.minScore) {
            result.skippedThreshold++;
            continue;
        }
        const { title, query } = extractPointerMeta(fact.content, fact.domain);
        // Dedup check against existing pointers + already-selected entries this run
        if (isDuplicatePointer(query, addedThisRun)) {
            result.skippedDuplicate++;
            continue;
        }
        // Trim summary to a clean one-liner (max 120 chars)
        const rawSummary = fact.content
            .replace(/['"]\s*\).*$/, '')
            .replace(/\s+/g, ' ')
            .trim();
        const summary = rawSummary.length > 120 ? rawSummary.slice(0, 117) + '…' : rawSummary;
        const pointer = formatPointer(fact.domain, title, summary, query);
        const entry = {
            factId: fact.id,
            domain: fact.domain,
            pointer,
            title,
            summary,
            query,
            score: Math.round(fact.score * 1000) / 1000,
            dryRun: cfg.dryRun,
        };
        toPromote.push(entry);
        addedThisRun.add(query.toLowerCase().trim());
    }
    result.entries = toPromote;
    result.promoted = toPromote.length;
    // 6. Write to MEMORY.md (unless dry-run)
    if (!cfg.dryRun && toPromote.length > 0) {
        await appendToMemoryFile(memoryPath, toPromote);
        console.log(`[dreaming] Promoted ${toPromote.length} facts to ${memoryPath} ` +
            `(${result.skippedDuplicate} dupes, ${result.skippedThreshold} below threshold)`);
    }
    return result;
}
/**
 * Run the dreaming promotion pass for all agents in a fleet.
 * Called from the BackgroundIndexer on every N ticks.
 */
export async function runDreamingPassForFleet(agentIds, libraryDb, config = {}) {
    const results = [];
    for (const agentId of agentIds) {
        try {
            const r = await runDreamingPromoter(agentId, libraryDb, config);
            if (r.promoted > 0 || r.dryRun) {
                results.push(r);
            }
        }
        catch (err) {
            console.warn(`[dreaming] Failed for agent ${agentId} (non-fatal):`, err.message);
        }
    }
    return results;
}
//# sourceMappingURL=dreaming-promoter.js.map