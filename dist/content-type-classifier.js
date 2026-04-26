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
/** Signal value weight for context assembly prioritization (0–1). */
export const SIGNAL_WEIGHT = {
    decision: 1.0,
    spec: 0.85,
    preference: 0.8,
    skill: 0.6,
    attribute: 0.5,
    discussion: 0.4,
    ack: 0.0,
    noise: 0.0,
};
// ─── Patterns ───────────────────────────────────────────────────
const DECISION_PATTERNS = [
    /\bdecided\b/i,
    /\bthe approach is\b/i,
    /\bwe(?:'|')ll go with\b/i,
    /\bthe plan is\b/i,
    /\bapproved\b/i,
    /\bconfirmed\b/i,
    /\bshipped\b/i,
    /\bmerged\b/i,
    /\bdeployed\b/i,
    /\b(?:decision|verdict|ruling|conclusion)\s*:/i,
    /🟢\s*GREEN/,
    /🔴\s*RED/,
    /🟡\s*YELLOW/,
];
const SPEC_PATTERNS = [
    /```[\s\S]*?```/m,
    /\binterface\s+[A-Za-z0-9_]+/,
    /\btype\s+[A-Za-z0-9_]+\s*=/,
    /\barchitecture\b/i,
    /\bapi\b/i,
    /\bcontract\b/i,
    /\bschema\b/i,
    /\bmigration\b/i,
    /\bspec\b/i,
];
const PREFERENCE_PATTERNS = [
    /\b(?:i|we)\s+(?:prefer|like|love|favor)\b/i,
    /\bmy\s+preferred\b/i,
    /\bpreference\b/i,
    /\bi(?:'|')d\s+rather\b/i,
    /\bdefault\s+to\b/i,
    /\b(?:always|usually)\s+use\b/i,
];
const SKILL_PATTERNS = [
    /\b(?:i|we)\s+(?:know|understand|can|able to)\b/i,
    /\b(?:experienced|proficient|expert)\s+with\b/i,
    /\b(?:skill|strength|competenc(?:y|ies))\b/i,
    /\b(?:familiar|comfortable)\s+with\b/i,
];
const ATTRIBUTE_PATTERNS = [
    /\b(?:i|we)\s+(?:am|are)\b/i,
    /\bmy\s+(?:role|timezone|location|name|pronouns|schedule|availability)\b/i,
    /\b(?:timezone|pronouns|role|availability|schedule)\s*:/i,
    /\b(?:working\s+hours|hard\s+stop|deadline)\b/i,
];
const NOISE_PATTERNS = [
    /\bheartbeat\b/i,
    /\braw log\b/i,
    /^\[[A-Z_]+\]/m,
    /\b(system|daemon|telemetry)\s+message\b/i,
    /\btraceback\b/i,
    /\bstdout\b/i,
    /\bstderr\b/i,
    /^NO_REPLY$/,
    /^HEARTBEAT_OK$/,
];
const ACK_PHRASES = new Set([
    'ok',
    'okay',
    'yes',
    'sounds good',
    'lets do it',
    "let's do it",
    'perfect',
    'nice',
    'got it',
    'acknowledged',
    'roger',
    'done',
    'thanks',
    'thank you',
    'ty',
    'lgtm',
    '👍',
]);
const HALF_LIFE = {
    decision: Number.POSITIVE_INFINITY,
    spec: 180,
    preference: 180,
    skill: 120,
    attribute: 30,
    discussion: 60,
    ack: 0,
    noise: 0,
};
// ─── Classifier ─────────────────────────────────────────────────
function normalized(content) {
    return content.trim().toLowerCase().replace(/[.!?]+$/g, '');
}
/**
 * Classify a message's content by signal type.
 *
 * @param content - Raw text content of the message
 * @returns Classification with type, confidence, and decay half-life
 */
export function classifyContentType(content) {
    const raw = String(content ?? '');
    const body = raw.trim();
    const lc = normalized(body);
    if (!body) {
        return { type: 'noise', confidence: 0.95, halfLifeDays: HALF_LIFE.noise };
    }
    // Noise first — fast path for system/control messages
    if (NOISE_PATTERNS.some((rx) => rx.test(body))) {
        return { type: 'noise', confidence: 0.85, halfLifeDays: HALF_LIFE.noise };
    }
    // Short acks — "ok", "sounds good", etc.
    if (body.length < 40 && ACK_PHRASES.has(lc)) {
        return { type: 'ack', confidence: 0.95, halfLifeDays: HALF_LIFE.ack };
    }
    // Decisions — highest value signal
    if (DECISION_PATTERNS.some((rx) => rx.test(body))) {
        return { type: 'decision', confidence: 0.9, halfLifeDays: HALF_LIFE.decision };
    }
    // Specs — code blocks, type definitions, architecture
    if (SPEC_PATTERNS.some((rx) => rx.test(body))) {
        return { type: 'spec', confidence: 0.82, halfLifeDays: HALF_LIFE.spec };
    }
    // Preferences — user likes, defaults
    if (PREFERENCE_PATTERNS.some((rx) => rx.test(body))) {
        return { type: 'preference', confidence: 0.8, halfLifeDays: HALF_LIFE.preference };
    }
    // Skills — capabilities, knowledge
    if (SKILL_PATTERNS.some((rx) => rx.test(body))) {
        return { type: 'skill', confidence: 0.78, halfLifeDays: HALF_LIFE.skill };
    }
    // Attributes — identity, schedule, role
    if (ATTRIBUTE_PATTERNS.some((rx) => rx.test(body))) {
        return { type: 'attribute', confidence: 0.72, halfLifeDays: HALF_LIFE.attribute };
    }
    // Questions and exploratory discussion
    if (/\?$/.test(body) || /\b(why|how|maybe|could|should|explore|question)\b/i.test(body)) {
        return { type: 'discussion', confidence: 0.75, halfLifeDays: HALF_LIFE.discussion };
    }
    // Default: generic discussion
    return { type: 'discussion', confidence: 0.6, halfLifeDays: HALF_LIFE.discussion };
}
/**
 * Convenience: classify and return the signal weight (0–1).
 * Higher = more valuable for context retention.
 */
export function signalWeight(content) {
    const { type } = classifyContentType(content);
    return SIGNAL_WEIGHT[type];
}
/**
 * Convenience: is this message worth keeping in context?
 * Returns false for ack and noise.
 */
export function isSignalBearing(content) {
    const { type } = classifyContentType(content);
    return type !== 'ack' && type !== 'noise';
}
//# sourceMappingURL=content-type-classifier.js.map