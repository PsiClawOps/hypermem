/**
 * Content Type Classifier
 *
 * Classifies message content by signal type: decision, spec, preference,
 * skill, attribute, discussion, ack, or noise. Used by:
 *   - Keystone history slot (P2.1) for decisional weight scoring
 *   - Background indexer for extraction priority
 *   - Compaction for retention decisions
 *
 * Ported from ClawText content-type-classifier.ts — adapted for
 * hypermem's NeutralMessage interface.
 *
 * No LLM dependency. Pure pattern matching + heuristics.
 */
export type ContentType = 'decision' | 'spec' | 'preference' | 'skill' | 'attribute' | 'discussion' | 'ack' | 'noise';
export interface ContentTypeResult {
    type: ContentType;
    confidence: number;
    /** Approximate half-life in days. Infinity = never decays. 0 = discard immediately. */
    halfLifeDays: number;
}
/** Signal value weight for context assembly prioritization (0–1). */
export declare const SIGNAL_WEIGHT: Record<ContentType, number>;
/**
 * Classify a message's content by signal type.
 *
 * @param content - Raw text content of the message
 * @returns Classification with type, confidence, and decay half-life
 */
export declare function classifyContentType(content: string): ContentTypeResult;
/**
 * Convenience: classify and return the signal weight (0–1).
 * Higher = more valuable for context retention.
 */
export declare function signalWeight(content: string): number;
/**
 * Convenience: is this message worth keeping in context?
 * Returns false for ack and noise.
 */
export declare function isSignalBearing(content: string): boolean;
//# sourceMappingURL=content-type-classifier.d.ts.map