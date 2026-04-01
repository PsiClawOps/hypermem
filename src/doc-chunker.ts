/**
 * HyperMem Document Chunker
 *
 * Splits markdown documents into semantically coherent chunks for L3 indexing.
 *
 * Design principles:
 * - Chunk by logical section (## / ###), NOT by token count
 * - Each chunk is a self-contained policy/operational unit
 * - Preserve section hierarchy for context assembly
 * - Track source file hash for atomic re-indexing
 * - Idempotent: same source produces same chunks (deterministic IDs)
 *
 * Collections (as defined in ACA offload spec):
 *   governance/policy   — POLICY.md, shared-fleet
 *   governance/charter  — CHARTER.md, per-tier (council/director)
 *   governance/comms    — COMMS.md, shared-fleet
 *   operations/agents   — AGENTS.md, per-tier
 *   operations/tools    — TOOLS.md, per-agent
 *   memory/decisions    — MEMORY.md, per-agent
 *   memory/daily        — memory/YYYY-MM-DD.md, per-agent
 *   identity/soul       — SOUL.md, per-agent (always-loaded kernel, but still indexed)
 *   identity/job        — JOB.md, per-agent (demand-loaded during deliberation)
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// ─── Types ──────────────────────────────────────────────────────

export interface DocChunk {
  /** Unique deterministic ID: sha256(collection + sectionPath + sourceHash) */
  id: string;
  /** Collection path: governance/policy, operations/tools, etc. */
  collection: string;
  /** Full section path: "§3 > Naming > Single-Name Rule" */
  sectionPath: string;
  /** Section depth (0=root, 1=#, 2=##, 3=###) */
  depth: number;
  /** The actual text content of this chunk */
  content: string;
  /** Token estimate (rough: chars / 4) */
  tokenEstimate: number;
  /** SHA-256 of the source file at time of chunking */
  sourceHash: string;
  /** Source file path (relative to workspace) */
  sourcePath: string;
  /** Scope: shared-fleet | per-tier | per-agent */
  scope: 'shared-fleet' | 'per-tier' | 'per-agent';
  /** Tier filter (for per-tier scope): council | director | all */
  tier?: string;
  /** Agent ID (for per-agent scope) */
  agentId?: string;
  /** Parent section path (for hierarchy context) */
  parentPath?: string;
}

export interface ChunkOptions {
  collection: string;
  sourcePath: string;
  scope: DocChunk['scope'];
  tier?: string;
  agentId?: string;
  /** Minimum content length to emit a chunk (avoids empty section headers) */
  minContentLen?: number;
  /** Whether to include parent context prefix in chunk content */
  includeParentContext?: boolean;
}

// ─── Core chunker ───────────────────────────────────────────────

/**
 * Hash a string with SHA-256.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Estimate token count from character length.
 * Rough heuristic: 1 token ≈ 4 chars for English prose.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Parse markdown into sections based on heading levels.
 * Splits on # / ## / ### headers, preserving content under each header.
 */
interface MarkdownSection {
  heading: string;       // The heading text (without # prefix)
  level: number;         // 1, 2, or 3
  content: string;       // Everything between this heading and the next same-or-higher level
  rawHeading: string;    // Original heading line with # prefix
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const sections: MarkdownSection[] = [];
  
  let currentLevel = 0;
  let currentHeading = '';
  let currentRaw = '';
  let contentLines: string[] = [];

  function flush() {
    if (currentHeading || contentLines.length > 0) {
      sections.push({
        heading: currentHeading,
        level: currentLevel,
        content: contentLines.join('\n').trim(),
        rawHeading: currentRaw,
      });
    }
  }

  for (const line of lines) {
    const h3Match = line.match(/^### (.+)$/);
    const h2Match = line.match(/^## (.+)$/);
    const h1Match = line.match(/^# (.+)$/);
    
    if (h3Match || h2Match || h1Match) {
      flush();
      currentRaw = line;
      if (h3Match) { currentLevel = 3; currentHeading = h3Match[1].trim(); }
      else if (h2Match) { currentLevel = 2; currentHeading = h2Match[1].trim(); }
      else if (h1Match) { currentLevel = 1; currentHeading = h1Match[1].trim(); }
      contentLines = [];
    } else {
      contentLines.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Build a hierarchical section path from the section stack.
 * e.g., ["POLICY.md", "§3 Escalation", "Triggers"] → "POLICY.md > §3 Escalation > Triggers"
 */
function buildSectionPath(stack: string[]): string {
  return stack.filter(Boolean).join(' > ');
}

/**
 * Generate a deterministic chunk ID from its identifying properties.
 */
function chunkId(collection: string, sectionPath: string, sourceHash: string): string {
  const key = `${collection}::${sectionPath}::${sourceHash}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Chunk a markdown document into semantic sections.
 *
 * Approach:
 * - Level 1 (#) headings become top-level section anchors
 * - Level 2 (##) headings become primary chunks
 * - Level 3 (###) headings become sub-chunks under their parent
 * - Content before the first heading becomes a "preamble" chunk
 * - Empty sections (heading only, no content) are skipped unless minContentLen=0
 *
 * For documents with deeply nested content, we group level-3 sections under
 * their parent level-2 section. This keeps related policy sections together.
 */
export function chunkMarkdown(content: string, opts: ChunkOptions): DocChunk[] {
  const minLen = opts.minContentLen ?? 50;
  const sourceHash = hashContent(content);
  const sections = parseMarkdownSections(content);
  const chunks: DocChunk[] = [];

  // Track current section hierarchy for path building
  let h1Heading = '';
  let h2Heading = '';
  const h2ContentLines: string[] = [];
  let h2Active = false;

  function flushH2() {
    if (!h2Active) return;
    const body = h2ContentLines.join('\n').trim();
    if (body.length < minLen && !opts.includeParentContext) {
      h2Active = false;
      h2ContentLines.length = 0;
      return;
    }

    const sectionPath = buildSectionPath([h1Heading, h2Heading].filter(Boolean));
    const chunkContent = [
      h1Heading ? `# ${h1Heading}` : '',
      `## ${h2Heading}`,
      '',
      body,
    ].filter(l => l !== '' || body).join('\n').trim();

    if (chunkContent.length >= minLen) {
      chunks.push({
        id: chunkId(opts.collection, sectionPath, sourceHash),
        collection: opts.collection,
        sectionPath,
        depth: 2,
        content: chunkContent,
        tokenEstimate: estimateTokens(chunkContent),
        sourceHash,
        sourcePath: opts.sourcePath,
        scope: opts.scope,
        tier: opts.tier,
        agentId: opts.agentId,
        parentPath: h1Heading || undefined,
      });
    }

    h2Active = false;
    h2ContentLines.length = 0;
  }

  // Preamble: text before first heading
  let preamble = '';

  for (const section of sections) {
    if (section.level === 1) {
      flushH2();
      h1Heading = section.heading;
      h2Heading = '';

      // Level-1 headings with body content become a preamble chunk
      if (section.content.length >= minLen) {
        const sectionPath = buildSectionPath([h1Heading]);
        const chunkContent = [`# ${h1Heading}`, '', section.content].join('\n').trim();
        chunks.push({
          id: chunkId(opts.collection, sectionPath + '::intro', sourceHash),
          collection: opts.collection,
          sectionPath: sectionPath + ' (intro)',
          depth: 1,
          content: chunkContent,
          tokenEstimate: estimateTokens(chunkContent),
          sourceHash,
          sourcePath: opts.sourcePath,
          scope: opts.scope,
          tier: opts.tier,
          agentId: opts.agentId,
        });
      }
    } else if (section.level === 2) {
      flushH2();
      h2Heading = section.heading;
      h2Active = true;
      // Start accumulating: begin with this section's own content
      h2ContentLines.length = 0;
      if (section.content) h2ContentLines.push(section.content);
    } else if (section.level === 3) {
      // Append h3 sub-sections into the current h2 chunk
      if (h2Active) {
        h2ContentLines.push(`\n### ${section.heading}`);
        if (section.content) h2ContentLines.push(section.content);
      } else {
        // h3 without a parent h2 — emit as standalone
        const sectionPath = buildSectionPath([h1Heading, section.heading].filter(Boolean));
        const chunkContent = [
          h1Heading ? `# ${h1Heading}` : '',
          `### ${section.heading}`,
          '',
          section.content,
        ].filter(l => l !== '' || section.content).join('\n').trim();

        if (chunkContent.length >= minLen) {
          chunks.push({
            id: chunkId(opts.collection, sectionPath, sourceHash),
            collection: opts.collection,
            sectionPath,
            depth: 3,
            content: chunkContent,
            tokenEstimate: estimateTokens(chunkContent),
            sourceHash,
            sourcePath: opts.sourcePath,
            scope: opts.scope,
            tier: opts.tier,
            agentId: opts.agentId,
            parentPath: h1Heading || undefined,
          });
        }
      }
    } else if (section.level === 0) {
      // Pre-heading content
      preamble = section.content.trim();
    }
  }

  // Flush any remaining h2
  flushH2();

  // Emit preamble if substantial
  if (preamble.length >= minLen) {
    chunks.unshift({
      id: chunkId(opts.collection, '(preamble)', sourceHash),
      collection: opts.collection,
      sectionPath: '(preamble)',
      depth: 0,
      content: preamble,
      tokenEstimate: estimateTokens(preamble),
      sourceHash,
      sourcePath: opts.sourcePath,
      scope: opts.scope,
      tier: opts.tier,
      agentId: opts.agentId,
    });
  }

  return chunks;
}

/**
 * Chunk a file from disk.
 */
export function chunkFile(filePath: string, opts: Omit<ChunkOptions, 'sourcePath'>): DocChunk[] {
  const content = readFileSync(filePath, 'utf-8');
  return chunkMarkdown(content, { ...opts, sourcePath: filePath });
}

// ─── Collection registry ─────────────────────────────────────────

/**
 * Standard collection definitions for ACA workspace files.
 * Maps file names to collection paths and scope metadata.
 */
export interface CollectionDef {
  collection: string;
  scope: DocChunk['scope'];
  tier?: string;
  description: string;
}

export const ACA_COLLECTIONS: Record<string, CollectionDef> = {
  'POLICY.md': {
    collection: 'governance/policy',
    scope: 'shared-fleet',
    description: 'Governance policy: escalation triggers, decision states, council procedures, naming rules',
  },
  'CHARTER.md': {
    collection: 'governance/charter',
    scope: 'per-tier',
    description: 'Org charter: mission, director structure, boundaries, escalation, work queue',
  },
  'COMMS.md': {
    collection: 'governance/comms',
    scope: 'shared-fleet',
    description: 'Communications protocol: inter-agent tiers, delegation, platform formatting',
  },
  'AGENTS.md': {
    collection: 'operations/agents',
    scope: 'per-tier',
    description: 'Agent operational guide: boot sequence, identity, memory, messaging, group chats',
  },
  'TOOLS.md': {
    collection: 'operations/tools',
    scope: 'per-agent',
    description: 'Tool and runtime configuration: workspace path, model, key paths, quick commands',
  },
  'SOUL.md': {
    collection: 'identity/soul',
    scope: 'per-agent',
    description: 'Agent soul: core principles, personality, tone, continuity',
  },
  'JOB.md': {
    collection: 'identity/job',
    scope: 'per-agent',
    description: 'Job performance criteria: duties, response contract, council mode, output discipline',
  },
  'MOTIVATIONS.md': {
    collection: 'identity/motivations',
    scope: 'per-agent',
    description: 'Agent motivations: drives, fears, tensions that shape perspective',
  },
  'MEMORY.md': {
    collection: 'memory/decisions',
    scope: 'per-agent',
    description: 'Long-term curated memory: key decisions, lessons, context',
  },
};

/**
 * Infer the collection definition for a file based on its name.
 * Returns undefined if the file is not a known ACA file.
 */
export function inferCollection(fileName: string, agentId?: string): CollectionDef | undefined {
  // Strip path, get just the filename
  const base = fileName.split('/').pop() ?? fileName;

  // Daily memory files: memory/YYYY-MM-DD.md
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(base)) {
    return {
      collection: 'memory/daily',
      scope: 'per-agent',
      description: `Daily memory log for ${agentId || 'agent'}`,
    };
  }

  return ACA_COLLECTIONS[base];
}
