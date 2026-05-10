/**
 * entity-extractor.ts — Entity and grace tagger
 *
 * Sprint A: compose-time annotation only.
 * Sprint B: also used at ingest time. Adds shared key normalization
 * (`normalizeEntityKey`, `normalizeFacetKey`) and an ingest-friendly
 * `extractEntityFacetMentions(text)` returning cheap (start,end) offsets
 * suitable for storing in `message_entity_mentions` / `message_facet_mentions`.
 *
 * Exported symbols:
 *   extractEntitiesFromText(text, knownEntities?)   → ExtractedTextEntities
 *   annotateRecallGroups(...)                       → AnnotatedGroup[]
 *   formatStructuredHandoffBlock(...)               → structured block
 *   buildStructuredHandoffInstruction(...)          → string
 *   normalizeEntityKey(token)                       → string                (Sprint B)
 *   normalizeFacetKey(token)                        → string                (Sprint B)
 *   extractEntityFacetMentions(text)                → EntityFacetMentions    (Sprint B)
 */
export interface EntityMention {
    /** Normalized entity key (lowercase, trimmed). */
    key: string;
    /** Original surface form as it appears in the text. */
    surface: string;
    /** Inclusive start offset in the source string. */
    start: number;
    /** Exclusive end offset in the source string. */
    end: number;
}
export interface FacetMention {
    /** Grace group key (e.g. 'job', 'death', 'venue'). */
    key: string;
    /** Raw grace term that triggered the match. */
    term: string;
    /** Inclusive start offset in the source string. */
    start: number;
    /** Exclusive end offset in the source string. */
    end: number;
}
export interface EntityFacetMentions {
    entities: EntityMention[];
    facets: FacetMention[];
}
export interface ExtractedTextEntities {
    /** Normalized entity tokens found in the text */
    entities: string[];
    /** Grace group names matched in the text */
    facets: string[];
    /** Raw grace terms matched in the text */
    facetTerms: string[];
}
export interface AnnotatedGroup {
    /** Original group identifier (e.g. conversation_id / conversation id) */
    groupId: string;
    /** Original group content lines */
    lines: string[];
    /** Entity tokens from query that appear in this group's content */
    matchedEntities: string[];
    /** Grace group names from query that appear in this group's content */
    matchedFacets: string[];
    /** Raw grace terms matched in this group */
    matchedFacetTerms: string[];
    /** True when this group contains at least one query entity or grace */
    isRelevant: boolean;
}
/**
 * Extract entity and grace tokens from a block of text content.
 * When `knownEntities` is provided, the scan is biased toward those tokens
 * (useful for narrowing to query-relevant entities during structured handoff).
 */
export declare function extractEntitiesFromText(text: string, knownEntities?: string[]): ExtractedTextEntities;
/**
 * Parse raw recall content (already grouped by conversation_id) into annotated groups.
 *
 * Input is the `recall.content` string from `buildQueryMessageRecall()`,
 * which uses `### Raw transcript group {id}` headers.
 *
 * For each group, annotates which query entities and facets appear in the
 * group's content lines. This is the core of the Sprint A structured handoff.
 */
export declare function annotateRecallGroups(recallContent: string, queryEntities: string[], queryFacets: string[]): AnnotatedGroup[];
/**
 * Format annotated groups into structured evidence blocks for multi-hop handoff.
 *
 * Each group gets a header that names which query entities/facets it contains,
 * so the reader can quickly identify which groups are evidence for each hop.
 *
 * Token cost is minimal relative to the raw content: only the header changes.
 * No content is dropped; existing budget accounting from buildQueryMessageRecall
 * applies before this formatter runs.
 */
export declare function formatStructuredHandoffBlock(groups: AnnotatedGroup[], queryEntities: string[], queryFacets: string[]): {
    content: string;
    entityGroupCount: number;
    facetGroupCount: number;
};
/**
 * Normalize an entity surface form into a canonical bridge key.
 *
 * Strategy: lowercase, collapse whitespace, strip leading/trailing punctuation,
 * preserve internal alphanumerics + a small set of joiners (-, _, .).
 * The result is the join key used by `memory_entities.entity_key`.
 */
export declare function normalizeEntityKey(token: string): string;
/**
 * Normalize a grace group name into a canonical bridge key.
 * Grace keys are already lowercase identifiers in QUESTION_SHAPE_FACETS,
 * but callers may pass raw terms. We snap raw terms to their grace group.
 */
export declare function normalizeFacetKey(token: string): string;
/**
 * Extract entity and grace mentions from a text block, with cheap (start,end)
 * offsets, for ingest indexing into the entity/grace bridge tables.
 *
 * Designed to be cheap and deterministic; never calls a model, never reads
 * a DB. Caller decides whether to write the resulting mentions.
 */
export declare function extractEntityFacetMentions(text: string): EntityFacetMentions;
/**
 * Build the structured handoff instruction preamble.
 * Replaces the current flat multi-hop instruction string when structured
 * handoff is active.
 */
export declare function buildStructuredHandoffInstruction(entities: string[], facets: string[]): string;
//# sourceMappingURL=entity-extractor.d.ts.map