/**
 * HyperMem Keystone Scorer
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

import { classifyContentType } from './content-type-classifier.js';

// ─── Types ───────────────────────────────────────────────────────

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

// ─── Scorer ──────────────────────────────────────────────────────

/**
 * Score a single keystone candidate.
 *
 * @param candidate - The message candidate with its signals
 * @param maxAgeHours - The age ceiling for the recency factor (messages older
 *   than this get recencyFactor = 0, but are not excluded — they can still score
 *   via significance + ftsRelevance).
 * @returns Score in [0.0, 1.0]
 */
export function scoreKeystone(
  candidate: KeystoneCandidate,
  maxAgeHours: number
): number {
  const significance = candidate.episodeSignificance ?? 0.3;
  const ftsRelevance = Math.min(1.0, Math.max(0, candidate.ftsRank));
  const recencyFactor = Math.max(0, 1.0 - (candidate.ageHours / maxAgeHours));

  let score = (significance * 0.5) + (ftsRelevance * 0.3) + (recencyFactor * 0.2);

  // Content-type bonus: decisions and specs get +0.1 (capped at 1.0)
  const contentType = classifyContentType(candidate.content);
  if (contentType.type === 'decision' || contentType.type === 'spec') {
    score = Math.min(1.0, score + 0.1);
  }

  return score;
}

/**
 * Score an array of candidates and sort by score descending.
 *
 * @param candidates - Raw candidates from the DB query
 * @param maxAgeHours - Age ceiling for recency scoring (e.g. 720 = 30 days)
 * @returns Candidates sorted by score DESC with score field attached
 */
export function rankKeystones(
  candidates: KeystoneCandidate[],
  maxAgeHours: number
): ScoredKeystone[] {
  return candidates
    .map(c => ({ ...c, score: scoreKeystone(c, maxAgeHours) }))
    .sort((a, b) => b.score - a.score);
}
