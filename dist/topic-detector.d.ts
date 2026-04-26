/**
 * Topic Detector (P3.1)
 *
 * Heuristic-based topic shift detection. No model calls.
 * Uses explicit markers, entity shift, conversation gap, and continuation signals.
 */
import type { NeutralMessage } from './types.js';
/**
 * Strip inbound protocol metadata from message text before topic detection.
 *
 * Removes:
 *   - "Sender (untrusted metadata):" header blocks through next blank line
 *   - Pure timestamp lines: ISO 8601, bracket format, System YYYY-MM-DD
 *   - JSON code blocks containing "\"schema\": \"openclaw" or "inbound_meta"
 *   - Any ```json...``` block whose content contains those markers
 *
 * Called as the FIRST step in detectTopicShift() so that pattern matching
 * operates on clean user content, not on injected transport headers.
 */
export declare function stripMessageMetadata(text: string): string;
export interface TopicSignal {
    topicId: string | null;
    isNewTopic: boolean;
    confidence: number;
    topicName: string | null;
}
/**
 * Detect whether the incoming message starts a new conversation topic.
 *
 * @param incomingMessage  The new user message to evaluate
 * @param recentMessages   Last N messages for context (any role)
 * @param currentTopicId   The active topic id, or null if none
 */
export declare function detectTopicShift(incomingMessage: NeutralMessage, recentMessages: NeutralMessage[], currentTopicId: string | null): TopicSignal;
//# sourceMappingURL=topic-detector.d.ts.map