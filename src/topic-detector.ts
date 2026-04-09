/**
 * Topic Detector (P3.1)
 *
 * Heuristic-based topic shift detection. No model calls.
 * Uses explicit markers, entity shift, conversation gap, and continuation signals.
 */

import type { NeutralMessage } from './types.js';

// ─── Metadata Stripping ───────────────────────────────────────────────────────

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
export function stripMessageMetadata(text: string): string {
  if (!text) return text;

  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── ```json blocks containing openclaw markers ──────────────────────────
    if (/^```json\s*$/i.test(line)) {
      // Peek ahead to collect the block
      const blockLines: string[] = [line];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        blockLines.push(lines[j]);
        if (lines[j].trim() === '```') {
          closed = true;
          j++;
          break;
        }
        j++;
      }
      const blockContent = blockLines.join('\n');
      if (
        blockContent.includes('"schema": "openclaw') ||
        blockContent.includes('inbound_meta')
      ) {
        // Skip the whole block
        i = j;
        continue;
      }
      // Not an openclaw block — keep as-is
      result.push(...blockLines.slice(0, closed ? blockLines.length : blockLines.length));
      i = j;
      continue;
    }

    // ── Sender (untrusted metadata): block ──────────────────────────────────
    if (/^Sender \(untrusted metadata\):/i.test(line)) {
      // Skip through next blank line or closing ```
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '' || l.trim() === '```') {
          i++; // consume the blank/closing line too
          break;
        }
        i++;
      }
      continue;
    }

    // ── Pure timestamp lines ─────────────────────────────────────────────────
    // ISO 8601: 2026-04-05T02:43:00Z  /  2026-04-05T02:43:00.000Z
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(line.trim())) {
      i++;
      continue;
    }
    // Bracket format: [Mon 2026-04-05 02:43 MST]
    if (/^\[\w{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\w+\]$/.test(line.trim())) {
      i++;
      continue;
    }
    // System YYYY-MM-DD
    if (/^System\s+\d{4}-\d{2}-\d{2}$/.test(line.trim())) {
      i++;
      continue;
    }

    result.push(line);
    i++;
  }

  return result.join('\n').trim();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TopicSignal {
  topicId: string | null;   // null = continue current topic
  isNewTopic: boolean;
  confidence: number;       // 0-1
  topicName: string | null; // heuristic name, null if continuing
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GAP_MS = 30 * 60 * 1000; // 30 minutes

// Explicit topic-shift markers
const SHIFT_PATTERNS: RegExp[] = [
  /^(?:let'?s?|can we)\s+(?:talk|discuss|chat)\s+about\s+(.+)/i,
  /^switching\s+to\s+(.+)/i,
  /^new\s+topic\s*[:—-]\s*(.+)/i,
  /^regarding\s+(.+)/i,
  /^on\s+(?:the\s+)?(?:topic\s+of\s+)?(.+)/i,
  /^(?:i\s+want\s+to\s+)?(?:talk|ask)\s+about\s+(.+)/i,
  /^(?:change\s+of\s+)?subject\s*[:—-]\s*(.+)/i,
];

// Continuation markers — if any match, this is almost certainly same topic
const CONTINUATION_PATTERNS: RegExp[] = [
  /^\s*(?:also|and|additionally|furthermore|moreover|plus)\b/i,
  /^\s*(?:what\s+about|how\s+about)\s+/i,
  /^\s*(?:following\s+up|follow[- ]up|just\s+to\s+follow\s+up)\b/i,
  /^\s*(?:actually|wait|oh)\s*[,—-]/i,
  /^\s*(?:one\s+more\s+thing|another\s+thing|by\s+the\s+way)\b/i,
];

// Stop words for noun-phrase extraction
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'i', 'you', 'we', 'they',
  'it', 'he', 'she', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'on', 'at', 'for', 'with',
  'by', 'from', 'up', 'about', 'into', 'through', 'and', 'or', 'but', 'not',
  'so', 'yet', 'both', 'either', 'neither', 'nor', 'as', 'just', 'than',
  'then', 'because', 'while', 'although', 'if', 'when', 'where', 'how', 'what',
  'which', 'who', 'whom', 'whose',
]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract a short heuristic topic name from message text (max 40 chars).
 * Returns the first meaningful noun phrase or the first substantive clause.
 */
function extractTopicName(text: string): string {
  // First, check if any shift pattern captured a phrase
  for (const pattern of SHIFT_PATTERNS) {
    const m = text.match(pattern);
    if (m?.[1]) {
      const phrase = m[1].replace(/[?!.]+$/, '').trim();
      return phrase.slice(0, 40);
    }
  }

  // Fall back: split into words, skip stop words, take first 5 content words
  const words = text
    .replace(/[^\w\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));

  if (words.length === 0) {
    // Last resort: first 40 chars
    return text.slice(0, 40).trim();
  }

  return words.slice(0, 5).join(' ').slice(0, 40);
}

/**
 * Naive named-entity heuristic: extract capitalized words (length ≥ 3) and
 * quoted strings as "entities". Returns a Set<string> (lowercased).
 */
function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();

  // Quoted strings
  const quoted = text.match(/["']([^"']{2,30})["']/g);
  if (quoted) {
    for (const q of quoted) entities.add(q.replace(/["']/g, '').toLowerCase());
  }

  // Capitalized words (simple NER proxy — excludes sentence-start)
  const words = text.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[^a-zA-Z-]/g, '');
    if (w.length >= 3 && /^[A-Z]/.test(w)) {
      entities.add(w.toLowerCase());
    }
  }

  return entities;
}

/**
 * Jaccard similarity between two entity sets (0 = no overlap, 1 = identical).
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) {
    if (b.has(x)) intersect++;
  }
  const union = a.size + b.size - intersect;
  return intersect / union;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Detect whether the incoming message starts a new conversation topic.
 *
 * @param incomingMessage  The new user message to evaluate
 * @param recentMessages   Last N messages for context (any role)
 * @param currentTopicId   The active topic id, or null if none
 */
export function detectTopicShift(
  incomingMessage: NeutralMessage,
  recentMessages: NeutralMessage[],
  currentTopicId: string | null,
): TopicSignal {
  // Strip inbound protocol metadata FIRST — pattern matching must operate on
  // clean user content, not on transport headers (timestamps, sender blocks, etc.)
  const text = stripMessageMetadata(incomingMessage.textContent ?? '');

  // Guard: if the message is entirely metadata with no real content, never
  // create a new topic — there is nothing to name or classify.
  if (!text) {
    return { topicId: currentTopicId, isNewTopic: false, confidence: 0.9, topicName: null };
  }

  // ── 1. Continuation check (highest priority) ──────────────────────────────
  for (const pat of CONTINUATION_PATTERNS) {
    if (pat.test(text)) {
      return { topicId: currentTopicId, isNewTopic: false, confidence: 0.85, topicName: null };
    }
  }

  // ── 2. Explicit shift marker ───────────────────────────────────────────────
  for (const pat of SHIFT_PATTERNS) {
    if (pat.test(text)) {
      const name = extractTopicName(text);
      return { topicId: null, isNewTopic: true, confidence: 0.95, topicName: name };
    }
  }

  // ── 3. Conversation gap (empty history or >30 min since last message) ──────
  if (recentMessages.length === 0) {
    const name = extractTopicName(text);
    return { topicId: null, isNewTopic: true, confidence: 0.8, topicName: name };
  }

  // Find last message with a timestamp in metadata
  const lastMsg = recentMessages[recentMessages.length - 1];
  const lastTs = lastMsg.metadata?.createdAt
    ? new Date(lastMsg.metadata.createdAt as string).getTime()
    : null;

  if (lastTs !== null && !isNaN(lastTs)) {
    const now = Date.now();
    if (now - lastTs > GAP_MS) {
      const name = extractTopicName(text);
      return { topicId: null, isNewTopic: true, confidence: 0.75, topicName: name };
    }
  }

  // ── 4. Entity shift (compare incoming to last 3 messages) ─────────────────
  const incomingEntities = extractEntities(text);
  const contextWindow = recentMessages.slice(-3);
  const contextText = contextWindow
    .map(m => m.textContent ?? '')
    .join(' ');

  if (incomingEntities.size > 0 && contextText.length > 0) {
    const contextEntities = extractEntities(contextText);
    const similarity = jaccardSimilarity(incomingEntities, contextEntities);

    // Low similarity + no continuation marker → likely a new topic
    if (similarity < 0.1) {
      const name = extractTopicName(text);
      return { topicId: null, isNewTopic: true, confidence: 0.6, topicName: name };
    }
  }

  // ── 5. Default: continue current topic ────────────────────────────────────
  return { topicId: currentTopicId, isNewTopic: false, confidence: 0.7, topicName: null };
}
