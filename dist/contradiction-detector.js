/**
 * Contradiction Detector — heuristic-based contradiction detection for the fact store.
 *
 * Detects when a newly ingested fact contradicts existing active facts using
 * vector similarity (when available) and FTS candidate retrieval, scored by
 * pattern-based heuristics (negation, numeric conflict, state conflict, temporal).
 *
 * No LLM calls — v1 is purely heuristic. LLM-enhanced scoring is a future item.
 */
// ─── Internal Constants ──────────────────────────────────────────
const DEFAULT_CONFIG = {
    minSimilarity: 0.6,
    autoResolveThreshold: 0.85,
    maxCandidates: 10,
    autoResolve: true,
};
/** Words whose presence/absence flips meaning. */
const NEGATION_WORDS = new Set([
    'not', 'no', 'never', 'none', 'neither', 'nor', 'cannot', "can't",
    "don't", "doesn't", "didn't", "won't", "wouldn't", "shouldn't",
    "isn't", "aren't", "wasn't", "weren't", "hasn't", "haven't", "hadn't",
]);
/** Antonym pairs where one in text A and the other in text B signals conflict. */
const STATE_ANTONYMS = [
    ['enabled', 'disabled'],
    ['active', 'inactive'],
    ['active', 'deprecated'],
    ['running', 'stopped'],
    ['running', 'crashed'],
    ['up', 'down'],
    ['true', 'false'],
    ['yes', 'no'],
    ['on', 'off'],
    ['open', 'closed'],
    ['allowed', 'denied'],
    ['allowed', 'blocked'],
    ['available', 'unavailable'],
    ['connected', 'disconnected'],
    ['online', 'offline'],
    ['present', 'absent'],
    ['healthy', 'unhealthy'],
    ['valid', 'invalid'],
    ['complete', 'incomplete'],
    ['success', 'failure'],
];
// ─── Helpers ─────────────────────────────────────────────────────
/** Normalize text for comparison: lowercase, collapse whitespace. */
function normalize(text) {
    return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
/** Tokenize into word-boundary tokens. */
function tokenize(text) {
    return normalize(text).split(/[\s,;:()[\]{}]+/).filter(Boolean);
}
/** Convert VectorStore distance (lower = closer) to a 0-1 similarity score. */
function distanceToSimilarity(distance) {
    // sqlite-vec uses L2 distance by default. Convert to 0-1 similarity.
    // distance=0 => similarity=1, distance grows => similarity decays toward 0.
    return 1 / (1 + distance);
}
/**
 * Build a safe FTS query from content. Takes the first several meaningful words
 * to avoid FTS syntax errors from special characters.
 */
function buildFtsQuery(content) {
    const words = tokenize(content)
        .filter(w => w.length > 2 && !/^\d+$/.test(w))
        .slice(0, 6);
    if (words.length === 0)
        return '';
    // OR-join for broad recall
    return words.join(' OR ');
}
/**
 * Extract numbers and their rough context (preceding word) from text.
 * Returns pairs of [contextWord, number].
 */
function extractNumbers(text) {
    const results = [];
    const tokens = tokenize(text);
    for (let i = 0; i < tokens.length; i++) {
        const num = parseFloat(tokens[i]);
        if (!isNaN(num) && isFinite(num)) {
            const context = i > 0 ? tokens[i - 1] : '';
            results.push({ context, value: num });
        }
    }
    return results;
}
/**
 * Check if one text contains a negation of the other.
 * Returns true if one has a negation word in a position where the other doesn't
 * (or vice versa), given high token overlap.
 */
function detectNegation(tokensA, tokensB) {
    const negA = tokensA.filter(t => NEGATION_WORDS.has(t));
    const negB = tokensB.filter(t => NEGATION_WORDS.has(t));
    // One has negation words, the other doesn't (or different count)
    if (negA.length !== negB.length) {
        // Check that the non-negation content overlaps substantially
        const contentA = new Set(tokensA.filter(t => !NEGATION_WORDS.has(t)));
        const contentB = new Set(tokensB.filter(t => !NEGATION_WORDS.has(t)));
        const intersection = [...contentA].filter(t => contentB.has(t));
        const smaller = Math.min(contentA.size, contentB.size);
        // Need at least 40% content overlap to consider it a negation of the same claim
        return smaller > 0 && intersection.length / smaller >= 0.4;
    }
    return false;
}
/**
 * Check for antonym state pairs between two token sets.
 * Returns the matching antonym pair if found, or null.
 */
function detectStateConflict(tokensA, tokensB) {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    for (const [word1, word2] of STATE_ANTONYMS) {
        if ((setA.has(word1) && setB.has(word2)) || (setA.has(word2) && setB.has(word1))) {
            // Verify there's enough shared context (not just random words)
            const contentA = new Set(tokensA.filter(t => t !== word1 && t !== word2));
            const contentB = new Set(tokensB.filter(t => t !== word1 && t !== word2));
            const intersection = [...contentA].filter(t => contentB.has(t));
            const smaller = Math.min(contentA.size, contentB.size);
            if (smaller > 0 && intersection.length / smaller >= 0.3) {
                return setA.has(word1) ? [word1, word2] : [word2, word1];
            }
        }
    }
    return null;
}
/**
 * Check for numeric conflicts: same contextual subject, different numbers.
 */
function detectNumericConflict(textA, textB) {
    const numsA = extractNumbers(textA);
    const numsB = extractNumbers(textB);
    for (const a of numsA) {
        for (const b of numsB) {
            // Same context word, different value
            if (a.context && a.context === b.context && a.value !== b.value) {
                return { contextWord: a.context, valueA: a.value, valueB: b.value };
            }
        }
    }
    return null;
}
// ─── ContradictionDetector ───────────────────────────────────────
export class ContradictionDetector {
    factStore;
    vectorStore;
    config;
    constructor(factStore, vectorStore, config) {
        this.factStore = factStore;
        this.vectorStore = vectorStore;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * On fact ingest, check if the new fact contradicts existing active facts.
     * Uses vector similarity (when available) + FTS to find candidates, then
     * scores each candidate with heuristic contradiction checks.
     */
    async detectOnIngest(agentId, newFact) {
        const candidates = await this.findCandidates(agentId, newFact);
        const contradictions = [];
        for (const candidate of candidates) {
            const scored = this.scoreContradiction(newFact.content, candidate);
            if (scored) {
                contradictions.push(scored);
            }
        }
        // Sort by contradiction score descending
        contradictions.sort((a, b) => b.contradictionScore - a.contradictionScore);
        const result = {
            contradictions,
            autoResolved: false,
            resolvedCount: 0,
        };
        return result;
    }
    /**
     * Resolve a detected contradiction between an existing fact and a new fact.
     */
    resolveContradiction(oldFactId, newFactId, resolution) {
        switch (resolution) {
            case 'supersede':
                this.factStore.markSuperseded(oldFactId, newFactId);
                break;
            case 'keep-both':
                // No-op: both facts remain active
                break;
            case 'reject-new':
                this.factStore.invalidateFact(newFactId);
                break;
        }
    }
    /**
     * Auto-resolve high-confidence contradictions: newer supersedes older.
     * Only resolves candidates above the autoResolveThreshold.
     *
     * @param agentId - The agent whose facts are being resolved (for audit trail)
     * @param candidates - Scored contradiction candidates from detectOnIngest
     * @returns Count of auto-resolved contradictions
     */
    async autoResolve(_agentId, candidates) {
        if (!this.config.autoResolve)
            return 0;
        let resolved = 0;
        for (const candidate of candidates) {
            if (candidate.contradictionScore >= this.config.autoResolveThreshold) {
                // The existing fact is older; the new fact (which triggered detection)
                // is assumed to be the more recent truth. We mark the existing as superseded.
                // Note: the caller must supply the newFactId when wiring this into ingest.
                // For now, we invalidate the old fact since we don't have the new fact's id here.
                this.factStore.invalidateFact(candidate.existingFactId);
                resolved++;
            }
        }
        return resolved;
    }
    // ─── Private Methods ────────────────────────────────────────────
    /**
     * Find candidate facts that might contradict the new fact.
     * Uses vector search (if available) and FTS, deduplicates, and returns
     * up to maxCandidates results above minSimilarity.
     */
    async findCandidates(agentId, newFact) {
        const seen = new Set();
        const candidates = [];
        const { maxCandidates, minSimilarity } = this.config;
        // Path 1: Vector similarity search (if VectorStore is available)
        if (this.vectorStore) {
            try {
                const vectorResults = await this.vectorStore.search(newFact.content, {
                    tables: ['facts'],
                    limit: maxCandidates * 2, // over-fetch to allow for filtering
                });
                for (const vr of vectorResults) {
                    const similarity = distanceToSimilarity(vr.distance);
                    if (similarity < minSimilarity)
                        continue;
                    if (seen.has(vr.sourceId))
                        continue;
                    seen.add(vr.sourceId);
                    // Retrieve the full fact row for metadata checks
                    const facts = this.factStore.searchFacts(vr.content.slice(0, 30), {
                        agentId,
                        limit: 1,
                    });
                    const fact = facts.find(f => f.id === vr.sourceId);
                    if (fact && !fact.supersededBy && !fact.invalidAt) {
                        candidates.push({ fact, similarity });
                    }
                }
            }
            catch {
                // Vector search failed (embedding model unavailable, etc.)
                // Fall through to FTS-only path
            }
        }
        // Path 2: FTS search (always available, fills gaps)
        if (candidates.length < maxCandidates) {
            const ftsQuery = buildFtsQuery(newFact.content);
            if (ftsQuery) {
                try {
                    const ftsResults = this.factStore.searchFacts(ftsQuery, {
                        agentId,
                        domain: newFact.domain,
                        limit: maxCandidates * 2,
                    });
                    for (const fact of ftsResults) {
                        if (seen.has(fact.id))
                            continue;
                        if (fact.supersededBy || fact.invalidAt)
                            continue;
                        seen.add(fact.id);
                        // Compute a rough token-overlap similarity for FTS results
                        const similarity = this.tokenOverlapSimilarity(newFact.content, fact.content);
                        if (similarity >= minSimilarity) {
                            candidates.push({ fact, similarity });
                        }
                    }
                }
                catch {
                    // FTS query failed (malformed query, etc.)
                }
            }
        }
        // Sort by similarity descending, trim to maxCandidates
        candidates.sort((a, b) => b.similarity - a.similarity);
        return candidates.slice(0, maxCandidates);
    }
    /**
     * Score a candidate fact against the new fact content for contradiction.
     * Returns a ContradictionCandidate if any heuristic fires, null otherwise.
     */
    scoreContradiction(newContent, candidate) {
        const existingContent = candidate.fact.content;
        const tokensNew = tokenize(newContent);
        const tokensExisting = tokenize(existingContent);
        let bestScore = 0;
        let bestReason = '';
        // Heuristic 1: Negation detection (score: 0.9)
        if (detectNegation(tokensNew, tokensExisting)) {
            bestScore = 0.9;
            bestReason = 'Negation detected: one fact negates the other';
        }
        // Heuristic 2: State conflict via antonym pairs (score: 0.85)
        const stateConflict = detectStateConflict(tokensNew, tokensExisting);
        if (stateConflict && stateConflict.length === 2) {
            const score = 0.85;
            if (score > bestScore) {
                bestScore = score;
                bestReason = `State conflict: "${stateConflict[0]}" vs "${stateConflict[1]}"`;
            }
        }
        // Heuristic 3: Numeric conflict (score: 0.8)
        const numConflict = detectNumericConflict(newContent, existingContent);
        if (numConflict) {
            const score = 0.8;
            if (score > bestScore) {
                bestScore = score;
                bestReason = `Numeric conflict on "${numConflict.contextWord}": ${numConflict.valueA} vs ${numConflict.valueB}`;
            }
        }
        // Heuristic 4: Temporal supersede — high similarity, different conclusion (score: 0.7)
        // If similarity is very high (>0.8) but content isn't identical, it's likely a revised version
        if (bestScore === 0 && candidate.similarity > 0.8) {
            const contentDiffers = normalize(newContent) !== normalize(existingContent);
            if (contentDiffers) {
                bestScore = 0.7;
                bestReason = 'Temporal supersede: high similarity with different content (likely revised)';
            }
        }
        if (bestScore === 0)
            return null;
        return {
            existingFactId: candidate.fact.id,
            existingContent,
            similarityScore: candidate.similarity,
            contradictionScore: bestScore,
            reason: bestReason,
        };
    }
    /**
     * Compute Jaccard-like token overlap between two texts.
     * Returns 0-1 where 1 means identical token sets.
     */
    tokenOverlapSimilarity(textA, textB) {
        const setA = new Set(tokenize(textA));
        const setB = new Set(tokenize(textB));
        if (setA.size === 0 || setB.size === 0)
            return 0;
        let intersection = 0;
        for (const token of setA) {
            if (setB.has(token))
                intersection++;
        }
        const union = new Set([...setA, ...setB]).size;
        return union > 0 ? intersection / union : 0;
    }
}
//# sourceMappingURL=contradiction-detector.js.map