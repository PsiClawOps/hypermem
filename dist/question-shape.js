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
// ── Relation lexicon ──────────────────────────────────────────────────────
// Spec: "relation/intersection word" — signals that the question asks about
// a shared attribute, comparison, or intersection across entities.
const RELATION_WORDS = new Set([
    'common', 'share', 'shared', 'both', 'same', 'between',
    'bought', 'lost', 'planned', 'pursued', 'interested',
    'also', 'together', 'neither', 'either',
    'compare', 'comparing', 'overlap', 'overlapping', 'link', 'connect',
    'relationship', 'relation', 'difference', 'similar', 'similarity',
]);
// ── Grace lexicon ─────────────────────────────────────────────────────────
// LoCoMo answer-bearing nouns. Kept minimal for Sprint A; promoted in Sprint B.
export const QUESTION_SHAPE_FACETS = [
    {
        name: 'job',
        terms: ['job', 'jobs', 'work', 'career', 'occupation', 'profession', 'employment', 'fired', 'hired', 'promotion'],
    },
    {
        name: 'death',
        terms: ['death', 'died', 'passed away', 'funeral', 'loss', 'deceased', 'passing'],
    },
    {
        name: 'hobby',
        terms: ['hobby', 'hobbies', 'activity', 'activities', 'interest', 'interests', 'passion', 'pastime', 'free time'],
    },
    {
        name: 'purchase',
        terms: ['bought', 'purchase', 'purchased', 'buy', 'buying', 'item', 'items', 'shopping', 'order', 'ordered'],
    },
    {
        name: 'venue',
        terms: ['place', 'places', 'venue', 'venues', 'location', 'where', 'meet', 'met', 'visited', 'restaurant', 'bar', 'club'],
    },
    {
        name: 'activity',
        terms: ['planned', 'planning', 'event', 'events', 'trip', 'trips', 'vacation', 'travel'],
    },
    {
        name: 'time',
        terms: ['month', 'months', 'year', 'years', 'january', 'february', 'march', 'april', 'may', 'june',
            'july', 'august', 'september', 'october', 'november', 'december', 'spring', 'summer', 'fall', 'winter'],
    },
    {
        name: 'relationship',
        terms: ['friend', 'friends', 'partner', 'boyfriend', 'girlfriend', 'husband', 'wife', 'family',
            'sibling', 'brother', 'sister', 'parent', 'mother', 'father', 'colleague', 'coworker'],
    },
];
// Flat set for quick lookup
const FACET_TERM_SET = new Set(QUESTION_SHAPE_FACETS.flatMap(f => f.terms));
// ── Temporal-anchor / single-hop span patterns ────────────────────────────
// Used by the FP-score hook. A temporal question about one entity's history
// looks multi-hop by entity count but should not trigger structured handoff.
const TEMPORAL_SINGLE_HOP_PATTERNS = [
    /\bwhen (did|was|were|is|are)\b/i,
    /^what (year|month|date) did\b/i,
    /\b(first|last)\s+(time|year|month|day|week)\b/i,
    /\bhow long (ago|since|has|have)\b/i,
    /\b(how many|what number|count of)\b/i,
    /\b(date|dates|year|years)\s+(of|for|when|that)\b/i,
];
// Strong single-hop signals — query is about a single subject's attribute
const SINGLE_HOP_SUBJECT_PATTERNS = [
    /^(what|who|where|which|when|how) (is|was|are|were|did|does|do) [A-Z][a-z]+/,
    /^(tell me|describe|explain|summarize)/i,
    /\b(his|her|their|its) (name|job|career|hobby|hobbies|death|purchase|friend|partner)\b/i,
];
// ── Entity extraction ─────────────────────────────────────────────────────
/** TitleCase word pattern (starts with capital, >= 2 chars) */
const TITLE_CASE_WORD = /\b[A-Z][a-z][a-zA-Z]*\b/g;
/** Quoted string pattern */
const QUOTED_STRING = /["']([^"']{2,30})["']/g;
/** ALL-CAPS abbreviation (e.g. VR, NBA, UCSF) */
const ALLCAPS_ABBREV = /\b[A-Z]{2,6}\b/g;
const COMMON_TITLE_CASE_STOP_WORDS = new Set([
    'The', 'A', 'An', 'In', 'On', 'At', 'To', 'For', 'Of', 'And', 'Or', 'But',
    'By', 'Is', 'It', 'If', 'So', 'Do', 'Be', 'My', 'We', 'He', 'She', 'They',
    'You', 'Me', 'Us', 'His', 'Her', 'Its', 'Our', 'Your', 'Who', 'What', 'How',
    'When', 'Where', 'Which', 'Why', 'Would', 'Could', 'Should', 'Did', 'Does',
    'Was', 'Were', 'Has', 'Have', 'Had', 'Will', 'Can', 'May', 'Might', 'Shall',
    'Just', 'Also', 'Both', 'Each', 'With', 'From', 'That', 'This', 'These', 'Those',
    'Any', 'All', 'Not', 'Now', 'Well', 'Too', 'Very', 'More', 'Most', 'Some',
    'Same', 'Last', 'Next', 'New', 'Old', 'Then', 'Than', 'Into', 'Upon',
]);
/**
 * Extract named entity candidates from a query string.
 * Returns deduplicated lowercase entity tokens.
 */
export function extractQueryEntities(query) {
    const candidates = new Set();
    // Quoted strings first (highest confidence)
    for (const m of query.matchAll(QUOTED_STRING)) {
        const val = m[1].trim();
        if (val.length >= 2)
            candidates.add(val.toLowerCase());
    }
    // TitleCase words (excluding common stop words)
    for (const m of query.matchAll(TITLE_CASE_WORD)) {
        const word = m[0];
        if (!COMMON_TITLE_CASE_STOP_WORDS.has(word)) {
            candidates.add(word.toLowerCase());
        }
    }
    // ALL-CAPS abbreviations
    for (const m of query.matchAll(ALLCAPS_ABBREV)) {
        candidates.add(m[0].toLowerCase());
    }
    return [...candidates];
}
/**
 * Extract grace terms from a query string using the LoCoMo grace lexicon.
 * Returns matched grace group names (deduplicated).
 */
export function extractQueryFacets(query) {
    const lower = query.toLowerCase();
    const matchedFacets = new Set();
    for (const grace of QUESTION_SHAPE_FACETS) {
        for (const term of grace.terms) {
            if (lower.includes(term)) {
                matchedFacets.add(grace.name);
                break;
            }
        }
    }
    return [...matchedFacets];
}
/**
 * Extract matched grace terms (raw tokens, not group names) from a query.
 * Used for structured handoff header annotation.
 */
export function extractQueryFacetTerms(query) {
    const lower = query.toLowerCase();
    const matched = [];
    for (const term of FACET_TERM_SET) {
        if (lower.includes(term))
            matched.push(term);
    }
    return [...new Set(matched)];
}
// ── Relation word detection ───────────────────────────────────────────────
function hasRelationWord(query) {
    const lower = query.toLowerCase();
    const words = lower.split(/\s+/);
    return words.some(w => RELATION_WORDS.has(w.replace(/[^a-z]/g, '')));
}
// ── False-positive scoring ────────────────────────────────────────────────
/**
 * Estimate the probability that a 'multi-hop' classification is a false positive.
 * Returns 0.0 (clearly multi-hop) to 1.0 (clearly single-hop / FP).
 *
 * High FP score → do not apply structured handoff even if multi-hop shape detected.
 * Spec threshold: FP rate > 0.30 on held-out single-hop-multi-entity set →
 * add a negative check. This function provides that check.
 */
export function questionShapeFalsePositiveScore(query) {
    let fpScore = 0;
    for (const pattern of TEMPORAL_SINGLE_HOP_PATTERNS) {
        if (pattern.test(query)) {
            fpScore += 0.35;
            break;
        }
    }
    for (const pattern of SINGLE_HOP_SUBJECT_PATTERNS) {
        if (pattern.test(query)) {
            fpScore += 0.25;
            break;
        }
    }
    // Short queries with < 7 words are unlikely to be true multi-hop
    const wordCount = query.trim().split(/\s+/).length;
    if (wordCount < 7)
        fpScore += 0.15;
    // If query has no relation word at all, reduce confidence
    if (!hasRelationWord(query))
        fpScore += 0.30;
    return Math.min(1.0, fpScore);
}
// ── Main detector ─────────────────────────────────────────────────────────
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
export function detectQuestionShape(query) {
    if (!query || !query.trim()) {
        return { kind: 'single-hop', entities: [], facets: [], confidence: 0.9 };
    }
    const entities = extractQueryEntities(query);
    const facets = extractQueryFacets(query);
    const fpScore = questionShapeFalsePositiveScore(query);
    const hasEnoughSignals = entities.length >= 2 ||
        (entities.length >= 1 && facets.length >= 1);
    const hasRelation = hasRelationWord(query);
    const isSafe = fpScore < 0.35;
    if (hasEnoughSignals && hasRelation && isSafe) {
        // Confidence: scale down by FP score
        const baseConfidence = Math.min(1.0, 0.5 + (entities.length * 0.15) + (facets.length * 0.10));
        const confidence = Math.max(0.1, baseConfidence * (1 - fpScore));
        return { kind: 'multi-hop', entities, facets, confidence };
    }
    // Single-hop: confidence is inverse of multi-hop signals
    const singleHopConfidence = Math.min(1.0, 0.5 + fpScore * 0.5);
    return { kind: 'single-hop', entities, facets, confidence: singleHopConfidence };
}
//# sourceMappingURL=question-shape.js.map