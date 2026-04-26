/**
 * hypermem Keystone Scorer
 *
 * Scores message candidates for inclusion in the Keystone History Slot (P2.1).
 * A "keystone" is an older, high-signal message that provides critical context
 * for the current conversation — decisions, specs, discoveries that happened
 * before the recent history window.
 *
 * Scoring formula (weights sum to 1.0):
 *   - episodeSignificance × 0.5  (was this message linked to a significant episode?)
 *   - ftsRelevance × 0.3         (is it semantically relevant to the current prompt?)
 *   - recencyFactor × 0.2        (how recent is it, relative to maxAgeHours?)
 *
 * Content-type bonus: messages classified as 'decision' or 'spec' get +0.1,
 * capped at 1.0. These are the highest-value signals for context recall.
 */
export interface KeystoneCandidate {
    messageId: number;
    messageIndex: number;
    role: string;
    content: string;
    timestamp: string;
    /** Significance from the episodes table (NULL if no episode was linked). */
    episodeSignificance: number | null;
    /** FTS5 BM25 relevance rank, already normalized to [0, 1]. */
    ftsRank: number;
    /** Age in hours from now. */
    ageHours: number;
}
export interface ScoredKeystone extends KeystoneCandidate {
    score: number;
}
/**
 * Score a single keystone candidate.
 *
 * @param candidate - The message candidate with its signals
 * @param maxAgeHours - The age ceiling for the recency factor (messages older
 *   than this get recencyFactor = 0, but are not excluded — they can still score
 *   via significance + ftsRelevance).
 * @returns Score in [0.0, 1.0]
 */
export declare function scoreKeystone(candidate: KeystoneCandidate, maxAgeHours: number): number;
/**
 * Score an array of candidates and sort by score descending.
 *
 * @param candidates - Raw candidates from the DB query
 * @param maxAgeHours - Age ceiling for recency scoring (e.g. 720 = 30 days)
 * @returns Candidates sorted by score DESC with score field attached
 */
export declare function rankKeystones(candidates: KeystoneCandidate[], maxAgeHours: number): ScoredKeystone[];
//# sourceMappingURL=keystone-scorer.d.ts.map