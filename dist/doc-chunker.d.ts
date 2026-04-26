/**
 * hypermem Document Chunker
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
/**
 * Hash a string with SHA-256.
 */
export declare function hashContent(content: string): string;
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
export declare function chunkMarkdown(content: string, opts: ChunkOptions): DocChunk[];
/**
 * Chunk a file from disk.
 */
export declare function chunkFile(filePath: string, opts: Omit<ChunkOptions, 'sourcePath'>): DocChunk[];
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
export declare const ACA_COLLECTIONS: Record<string, CollectionDef>;
/**
 * Infer the collection definition for a file based on its name.
 * Returns undefined if the file is not a known ACA file.
 */
export declare function inferCollection(fileName: string, agentId?: string): CollectionDef | undefined;
//# sourceMappingURL=doc-chunker.d.ts.map