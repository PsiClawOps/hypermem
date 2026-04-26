/**
 * Topic Synthesizer
 *
 * Synthesizes compiled knowledge pages (wiki-style) from stale topics.
 * Heuristic-only: no LLM calls. Uses content-type classifier + keystone scoring.
 *
 * Architecture: Karpathy LLM Wiki Pattern adapted for hypermem.
 * Raw sources (messages.db) → Wiki (knowledge table) → Compositor (compose-time)
 */
import { classifyContentType } from './content-type-classifier.js';
import { KnowledgeStore } from './knowledge-store.js';
// ─── Configuration ──────────────────────────────────────────────
const SYNTHESIS_STALE_MINUTES = 30;
const SYNTHESIS_MIN_MESSAGES = 5;
const SYNTHESIS_REGROWTH_THRESHOLD = 5;
const SYNTHESIS_MAX_SUMMARY_CHARS = 800;
const SYNTHESIS_MAX_DECISIONS = 10;
const SYNTHESIS_MAX_QUESTIONS = 5;
const LINT_FREQUENCY = 10;
const LINT_STALE_DAYS = 7;
// Export so tests can reference them
export { SYNTHESIS_STALE_MINUTES, SYNTHESIS_MIN_MESSAGES, SYNTHESIS_REGROWTH_THRESHOLD, SYNTHESIS_MAX_SUMMARY_CHARS, SYNTHESIS_MAX_DECISIONS, SYNTHESIS_MAX_QUESTIONS, LINT_FREQUENCY, LINT_STALE_DAYS, };
// ─── Helpers ────────────────────────────────────────────────────
/**
 * Score a message for keystone quality.
 * Heuristic: count references (file paths, agent mentions, quoted content, backticks).
 */
function keystoneScore(msg) {
    const text = msg.text_content || '';
    let score = 0;
    // File path references
    const pathMatches = text.match(/\/[\w./\-]+/g) || [];
    score += pathMatches.length * 0.3;
    // Backtick code references (inline or block)
    const backtickMatches = text.match(/`[^`]+`/g) || [];
    score += backtickMatches.length * 0.2;
    // Agent mentions (known patterns)
    const agentMentions = text.match(/\b(alice|bob|agent4|dave|oscar|carol|director1|director2|director7|specialist2|specialist1)\b/gi) || [];
    score += agentMentions.length * 0.25;
    // Quoted content
    const quotedMatches = text.match(/"[^"]{10,}"/g) || [];
    score += quotedMatches.length * 0.15;
    // Decision/spec content type boosts score
    const classification = classifyContentType(text);
    if (classification.type === 'decision')
        score += 1.0;
    else if (classification.type === 'spec')
        score += 0.5;
    else if (classification.type === 'preference')
        score += 0.3;
    // Length bonus (up to 0.5 for ~500 chars)
    score += Math.min(text.length / 1000, 0.5);
    return score;
}
/**
 * Extract file artifact paths from a message's tool_calls JSON.
 */
function extractArtifacts(msg) {
    if (!msg.tool_calls)
        return [];
    const artifacts = [];
    try {
        const calls = JSON.parse(msg.tool_calls);
        if (!Array.isArray(calls))
            return [];
        for (const call of calls) {
            const args = call.input || call.function?.arguments || call.arguments || {};
            let parsed = args;
            if (typeof parsed === 'string') {
                try {
                    parsed = JSON.parse(parsed);
                }
                catch {
                    continue;
                }
            }
            if (typeof parsed !== 'object' || !parsed)
                continue;
            for (const key of ['path', 'file', 'filePath', 'file_path']) {
                const val = parsed[key];
                if (typeof val === 'string' && val.startsWith('/')) {
                    artifacts.push(val);
                }
            }
        }
    }
    catch {
        // Malformed JSON — skip
    }
    return artifacts;
}
/**
 * Truncate text to maxChars with head+tail preservation.
 * head = 60% of budget, tail = 40%.
 */
function truncateHeadTail(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const headLen = Math.floor(maxChars * 0.6);
    const tailLen = maxChars - headLen - 5; // 5 for " ... "
    return text.slice(0, headLen) + ' ... ' + text.slice(text.length - tailLen);
}
/**
 * Parse the message_count stored in a knowledge source_ref or metadata.
 * source_ref format: "topic:<id>" — but we need to find message_count
 * from when the synthesis was stored. We store it in the content itself
 * as a comment, or we can read from the knowledge row's source_ref.
 *
 * Strategy: embed last message count in sourceRef as "topic:<id>:mc:<count>"
 */
function parseStoredMessageCount(sourceRef) {
    if (!sourceRef)
        return 0;
    const match = sourceRef.match(/:mc:(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
}
function escapeLike(value) {
    return value.replace(/[\\%_]/g, match => `\\${match}`);
}
// ─── TopicSynthesizer ───────────────────────────────────────────
export class TopicSynthesizer {
    libraryDb;
    getMessageDb;
    config;
    effectiveConfig;
    constructor(libraryDb, getMessageDb, config) {
        this.libraryDb = libraryDb;
        this.getMessageDb = getMessageDb;
        this.config = config;
        this.effectiveConfig = {
            SYNTHESIS_STALE_MINUTES: config?.SYNTHESIS_STALE_MINUTES ?? SYNTHESIS_STALE_MINUTES,
            SYNTHESIS_MIN_MESSAGES: config?.SYNTHESIS_MIN_MESSAGES ?? SYNTHESIS_MIN_MESSAGES,
            SYNTHESIS_REGROWTH_THRESHOLD: config?.SYNTHESIS_REGROWTH_THRESHOLD ?? SYNTHESIS_REGROWTH_THRESHOLD,
            SYNTHESIS_MAX_SUMMARY_CHARS: config?.SYNTHESIS_MAX_SUMMARY_CHARS ?? SYNTHESIS_MAX_SUMMARY_CHARS,
            SYNTHESIS_MAX_DECISIONS: config?.SYNTHESIS_MAX_DECISIONS ?? SYNTHESIS_MAX_DECISIONS,
            SYNTHESIS_MAX_QUESTIONS: config?.SYNTHESIS_MAX_QUESTIONS ?? SYNTHESIS_MAX_QUESTIONS,
            LINT_FREQUENCY: config?.LINT_FREQUENCY ?? LINT_FREQUENCY,
            LINT_STALE_DAYS: config?.LINT_STALE_DAYS ?? LINT_STALE_DAYS,
        };
    }
    /**
     * Run one synthesis pass for an agent.
     * Finds stale topics, synthesizes wiki pages, writes to knowledge table.
     */
    tick(agentId) {
        const result = {
            topicsSynthesized: 0,
            topicsSkipped: 0,
            knowledgeEntriesWritten: 0,
            topicIdsResolved: 0,
            topicsWithoutResolvedIds: 0,
            topicsWithoutMessages: 0,
        };
        const cfg = this.effectiveConfig;
        const staleThresholdMinutes = cfg.SYNTHESIS_STALE_MINUTES;
        // Query stale topics for this agent
        // "Stale" = updated_at older than SYNTHESIS_STALE_MINUTES ago
        let staleTopics;
        try {
            staleTopics = this.libraryDb.prepare(`
        SELECT * FROM topics
        WHERE agent_id = ?
          AND message_count >= ?
          AND updated_at < datetime('now', '-' || ? || ' minutes')
          -- safe: staleThresholdMinutes is a validated integer
        ORDER BY updated_at ASC
      `).all(agentId, cfg.SYNTHESIS_MIN_MESSAGES, Math.floor(staleThresholdMinutes));
        }
        catch {
            return result;
        }
        if (staleTopics.length === 0)
            return result;
        const knowledgeStore = new KnowledgeStore(this.libraryDb);
        for (const topic of staleTopics) {
            // Check if existing synthesis exists
            const existing = knowledgeStore.get(agentId, 'topic-synthesis', topic.name);
            if (existing) {
                // Only re-synthesize if message_count has grown by >= threshold
                const storedMc = parseStoredMessageCount(existing.sourceRef);
                const growth = topic.message_count - storedMc;
                if (growth < cfg.SYNTHESIS_REGROWTH_THRESHOLD) {
                    result.topicsSkipped++;
                    continue;
                }
            }
            // Get messages for this topic from per-agent messages.db
            const messageDb = this.getMessageDb(agentId);
            if (!messageDb) {
                result.topicsSkipped++;
                continue;
            }
            const resolvedTopicIds = this.resolveMessageTopicIds(messageDb, topic);
            result.topicIdsResolved += resolvedTopicIds.length;
            if (resolvedTopicIds.length === 0) {
                result.topicsWithoutResolvedIds++;
                result.topicsSkipped++;
                continue;
            }
            let messages;
            try {
                messages = this.loadTopicMessages(messageDb, topic, resolvedTopicIds);
            }
            catch {
                result.topicsSkipped++;
                continue;
            }
            if (messages.length === 0) {
                result.topicsWithoutMessages++;
                result.topicsSkipped++;
                continue;
            }
            // Build synthesis
            const content = this.synthesizeTopic(topic, messages, cfg);
            // Upsert into knowledge table
            const sourceRef = `topic:${topic.id}:mc:${topic.message_count}`;
            knowledgeStore.upsert(agentId, 'topic-synthesis', topic.name, content, {
                sourceType: 'synthesizer',
                sourceRef,
            });
            result.topicsSynthesized++;
            result.knowledgeEntriesWritten++;
        }
        return result;
    }
    /**
     * Resolve a library topic to message-db topic ids.
     *
     * Library topics use integer ids and aggregate per agent/name. Message DBs
     * use UUID topic ids scoped to sessions. Preserve the legacy direct-id path
     * for older data, then bridge current data by case-insensitive topic name.
     */
    resolveMessageTopicIds(messageDb, topic) {
        const ids = new Set([String(topic.id)]);
        try {
            const rows = messageDb.prepare(`
        SELECT id FROM topics WHERE lower(name) = lower(?) ORDER BY last_active_at ASC
      `).all(topic.name);
            for (const row of rows) {
                if (row.id)
                    ids.add(String(row.id));
            }
        }
        catch {
            // Older message DBs may not have the per-session topics table. In that
            // case the legacy direct-id fallback above is the only valid resolver.
        }
        return [...ids];
    }
    /**
     * Load source messages for a library topic.
     *
     * Primary path uses session topic ids. Fallback path mirrors the background
     * indexer's topic detector because library topics are created from message
     * content, not from SessionTopicMap UUID names.
     */
    loadTopicMessages(messageDb, topic, resolvedTopicIds) {
        const byId = (() => {
            try {
                const placeholders = resolvedTopicIds.map(() => '?').join(', ');
                return messageDb.prepare(`
          SELECT * FROM messages WHERE topic_id IN (${placeholders}) ORDER BY created_at ASC
        `).all(...resolvedTopicIds);
            }
            catch {
                return [];
            }
        })();
        const byContent = this.loadMessagesByDetectedTopic(messageDb, topic);
        const seen = new Set();
        const merged = [];
        for (const msg of [...byId, ...byContent]) {
            if (seen.has(msg.id))
                continue;
            seen.add(msg.id);
            merged.push(msg);
        }
        return merged.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }
    loadMessagesByDetectedTopic(messageDb, topic) {
        const topicName = topic.name.toLowerCase();
        const limit = Math.max(topic.message_count * 3, topic.message_count, this.effectiveConfig.SYNTHESIS_MIN_MESSAGES);
        if (topicName === 'infrastructure') {
            return messageDb.prepare(`
        SELECT * FROM messages
        WHERE text_content IS NOT NULL
          AND (
            lower(text_content) LIKE '%redis%'
            OR lower(text_content) LIKE '%sqlite%'
            OR lower(text_content) LIKE '%database%'
            OR lower(text_content) LIKE '%migration%'
            OR lower(text_content) LIKE '%deployment%'
            OR lower(text_content) LIKE '%docker%'
            OR lower(text_content) LIKE '%nginx%'
          )
        ORDER BY created_at ASC
        LIMIT ?
      `).all(limit);
        }
        if (topicName === 'security') {
            return messageDb.prepare(`
        SELECT * FROM messages
        WHERE text_content IS NOT NULL
          AND (
            lower(text_content) LIKE '%security%'
            OR lower(text_content) LIKE '%auth%'
            OR lower(text_content) LIKE '%permission%'
            OR lower(text_content) LIKE '%access%'
            OR lower(text_content) LIKE '%token%'
            OR lower(text_content) LIKE '%credential%'
          )
        ORDER BY created_at ASC
        LIMIT ?
      `).all(limit);
        }
        return messageDb.prepare(`
      SELECT * FROM messages
      WHERE text_content IS NOT NULL
        AND lower(text_content) LIKE ? ESCAPE '\\'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(`%${escapeLike(topicName)}%`, limit);
    }
    /**
     * Synthesize a wiki page for a topic from its messages.
     */
    synthesizeTopic(topic, messages, cfg) {
        // Classify + score all messages
        const scored = messages.map(msg => ({
            msg,
            classification: classifyContentType(msg.text_content || ''),
            score: keystoneScore(msg),
        }));
        // Extract decisions: classified as decision with confidence >= 0.7, top N
        const decisions = scored
            .filter(m => m.classification.type === 'decision' && m.classification.confidence >= 0.7)
            .sort((a, b) => b.score - a.score)
            .slice(0, cfg.SYNTHESIS_MAX_DECISIONS);
        // Extract open questions: classified as discussion + ends with ?, no decision follow-up within 5 msgs
        const openQuestions = [];
        for (let i = 0; i < scored.length; i++) {
            const item = scored[i];
            const text = item.msg.text_content || '';
            // Question detection: ends with ? OR is a discussion-type with question keywords
            const isQuestion = /\?\s*$/.test(text.trim()) ||
                (item.classification.type === 'discussion' && /\b(why|how|what|when|where|should|could|would|can|is there)\b/i.test(text));
            if (!isQuestion)
                continue;
            // Check if there's a decision-type response within next 5 messages
            const followup = scored.slice(i + 1, i + 6);
            const hasDecisionFollowup = followup.some(f => f.classification.type === 'decision');
            if (!hasDecisionFollowup) {
                openQuestions.push(item);
                if (openQuestions.length >= cfg.SYNTHESIS_MAX_QUESTIONS)
                    break;
            }
        }
        // Extract artifacts from tool_calls
        const allArtifacts = new Set();
        for (const { msg } of scored) {
            for (const artifact of extractArtifacts(msg)) {
                allArtifacts.add(artifact);
            }
        }
        // Extract participants: unique agent_ids
        const participants = [...new Set(messages.map(m => m.agent_id).filter(Boolean))];
        // Build summary: top-3 scored messages, concatenated and truncated
        const top3 = [...scored]
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(m => (m.msg.text_content || '').trim())
            .filter(t => t.length > 0)
            .join(' ');
        const summary = truncateHeadTail(top3, cfg.SYNTHESIS_MAX_SUMMARY_CHARS);
        // Build the wiki page markdown
        const lines = [];
        lines.push(`# ${topic.name}`);
        lines.push('');
        lines.push(`**Status:** ${topic.status}`);
        lines.push(`**Last activity:** ${topic.updated_at}`);
        lines.push(`**Messages:** ${topic.message_count}`);
        lines.push(`**Participants:** ${participants.join(', ') || 'unknown'}`);
        lines.push('');
        lines.push('## Summary');
        lines.push(summary || '_No summary available_');
        lines.push('');
        lines.push('## Key Decisions');
        if (decisions.length > 0) {
            for (const { msg } of decisions) {
                const text = (msg.text_content || '').trim();
                const first = text.split('\n')[0].slice(0, 200);
                lines.push(`- ${first}`);
            }
        }
        else {
            lines.push('_No key decisions recorded_');
        }
        lines.push('');
        lines.push('## Open Questions');
        if (openQuestions.length > 0) {
            for (const { msg } of openQuestions) {
                const text = (msg.text_content || '').trim();
                const first = text.split('\n')[0].slice(0, 200);
                lines.push(`- ${first}`);
            }
        }
        else {
            lines.push('_No open questions_');
        }
        lines.push('');
        lines.push('## Artifacts');
        if (allArtifacts.size > 0) {
            for (const artifact of allArtifacts) {
                lines.push(`- ${artifact}`);
            }
        }
        else {
            lines.push('_No artifacts recorded_');
        }
        lines.push('');
        lines.push('## Cross-References');
        lines.push('_Auto-generated — see knowledge graph for links_');
        return lines.join('\n');
    }
}
//# sourceMappingURL=topic-synthesizer.js.map