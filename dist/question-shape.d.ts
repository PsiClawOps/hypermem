/**
 * question-shape.ts — Heuristic v1 multi-hop question shape detector
 *
 * Sprint A of the multi-hop closure plan: deterministic, no model call.
 * Classifies a query as 'multi-hop' when it appears to require bridging
 * evidence across two or more distinct named entities or entity+grace pairs.
 *
 * Detection logic (all deterministic):
 *   - Extract named entities (TitleCase spans, quoted strings, capitalized 2+ tokens)
 *   - Extract grace terms from the LoCoMo answer-bearing noun lexicon
 *   - Multi-hop if: (2+ entities) OR (1 entity + 1 grace), PLUS a relation word
 *
 * False-positive gate: temporal-anchor / single-hop-span queries are NOT
 * multi-hop even when they have multiple entity tokens. A FP-rate check
 * hook is available via `questionShapeFalsePositiveScore`.
 *
 * Exported symbols:
 *   detectQuestionShape(query)  → QuestionShape
 *   questionShapeFalsePositiveScore(query) → number  (0 = likely real, 1 = likely FP)
 */
export interface QuestionShape {
    /** 'multi-hop' = requires bridging evidence across 2+ entities or entity+grace */
    kind: 'multi-hop' | 'single-hop';
    /** Named entity tokens extracted from the query */
    entities: string[];
    /** Grace terms matched from the LoCoMo grace lexicon */
    facets: string[];
    /**
     * Confidence in the multi-hop classification. 0–1.
     * For 'single-hop', this is a confidence in NOT being multi-hop.
     */
    confidence: number;
}
export declare const QUESTION_SHAPE_FACETS: Array<{
    name: string;
    terms: string[];
}>;
/**
 * Extract named entity candidates from a query string.
 * Returns deduplicated lowercase entity tokens.
 */
export declare function extractQueryEntities(query: string): string[];
/**
 * Extract grace terms from a query string using the LoCoMo grace lexicon.
 * Returns matched grace group names (deduplicated).
 */
export declare function extractQueryFacets(query: string): string[];
/**
 * Extract matched grace terms (raw tokens, not group names) from a query.
 * Used for structured handoff header annotation.
 */
export declare function extractQueryFacetTerms(query: string): string[];
/**
 * Estimate the probability that a 'multi-hop' classification is a false positive.
 * Returns 0.0 (clearly multi-hop) to 1.0 (clearly single-hop / FP).
 *
 * High FP score → do not apply structured handoff even if multi-hop shape detected.
 * Spec threshold: FP rate > 0.30 on held-out single-hop-multi-entity set →
 * add a negative check. This function provides that check.
 */
export declare function questionShapeFalsePositiveScore(query: string): number;
/**
 * Detect whether a query has multi-hop shape.
 *
 * Multi-hop criteria (all must be true):
 *   1. 2+ named entities OR (1 entity + 1 grace group)
 *   2. At least one relation/intersection word
 *   3. False-positive score < 0.60
 *
 * Returns a QuestionShape with extracted entities, facets, and confidence.
 */
export declare function detectQuestionShape(query: string): QuestionShape;
//# sourceMappingURL=question-shape.d.ts.map