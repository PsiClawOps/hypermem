/**
 * Topic Synthesizer
 *
 * Synthesizes compiled knowledge pages (wiki-style) from stale topics.
 * Heuristic-only: no LLM calls. Uses content-type classifier + keystone scoring.
 *
 * Architecture: Karpathy LLM Wiki Pattern adapted for hypermem.
 * Raw sources (messages.db) → Wiki (knowledge table) → Compositor (compose-time)
 */
import type { DatabaseSync } from 'node:sqlite';
declare const SYNTHESIS_STALE_MINUTES = 30;
declare const SYNTHESIS_MIN_MESSAGES = 5;
declare const SYNTHESIS_REGROWTH_THRESHOLD = 5;
declare const SYNTHESIS_MAX_SUMMARY_CHARS = 800;
declare const SYNTHESIS_MAX_DECISIONS = 10;
declare const SYNTHESIS_MAX_QUESTIONS = 5;
declare const LINT_FREQUENCY = 10;
declare const LINT_STALE_DAYS = 7;
export { SYNTHESIS_STALE_MINUTES, SYNTHESIS_MIN_MESSAGES, SYNTHESIS_REGROWTH_THRESHOLD, SYNTHESIS_MAX_SUMMARY_CHARS, SYNTHESIS_MAX_DECISIONS, SYNTHESIS_MAX_QUESTIONS, LINT_FREQUENCY, LINT_STALE_DAYS, };
export interface SynthesisConfig {
    SYNTHESIS_STALE_MINUTES: number;
    SYNTHESIS_MIN_MESSAGES: number;
    SYNTHESIS_REGROWTH_THRESHOLD: number;
    SYNTHESIS_MAX_SUMMARY_CHARS: number;
    SYNTHESIS_MAX_DECISIONS: number;
    SYNTHESIS_MAX_QUESTIONS: number;
    LINT_FREQUENCY: number;
    LINT_STALE_DAYS: number;
}
export interface SynthesisResult {
    topicsSynthesized: number;
    topicsSkipped: number;
    knowledgeEntriesWritten: number;
    topicIdsResolved: number;
    topicsWithoutResolvedIds: number;
    topicsWithoutMessages: number;
}
export declare class TopicSynthesizer {
    private readonly libraryDb;
    private readonly getMessageDb;
    private readonly config?;
    private readonly effectiveConfig;
    constructor(libraryDb: DatabaseSync, getMessageDb: (agentId: string) => DatabaseSync | null, config?: Partial<SynthesisConfig> | undefined);
    /**
     * Run one synthesis pass for an agent.
     * Finds stale topics, synthesizes wiki pages, writes to knowledge table.
     */
    tick(agentId: string): SynthesisResult;
    /**
     * Resolve a library topic to message-db topic ids.
     *
     * Library topics use integer ids and aggregate per agent/name. Message DBs
     * use UUID topic ids scoped to sessions. Preserve the legacy direct-id path
     * for older data, then bridge current data by case-insensitive topic name.
     */
    private resolveMessageTopicIds;
    /**
     * Load source messages for a library topic.
     *
     * Primary path uses session topic ids. Fallback path mirrors the background
     * indexer's topic detector because library topics are created from message
     * content, not from SessionTopicMap UUID names.
     */
    private loadTopicMessages;
    private loadMessagesByDetectedTopic;
    /**
     * Synthesize a wiki page for a topic from its messages.
     */
    private synthesizeTopic;
}
//# sourceMappingURL=topic-synthesizer.d.ts.map