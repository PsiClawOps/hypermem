/**
 * Topic Synthesizer
 *
 * Synthesizes compiled knowledge pages (wiki-style) from stale topics.
 * Heuristic-only: no LLM calls. Uses content-type classifier + keystone scoring.
 *
 * Architecture: Karpathy LLM Wiki Pattern adapted for HyperMem.
 * Raw sources (messages.db) → Wiki (knowledge table) → Compositor (compose-time)
 */

import type { DatabaseSync } from 'node:sqlite';
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
export {
  SYNTHESIS_STALE_MINUTES,
  SYNTHESIS_MIN_MESSAGES,
  SYNTHESIS_REGROWTH_THRESHOLD,
  SYNTHESIS_MAX_SUMMARY_CHARS,
  SYNTHESIS_MAX_DECISIONS,
  SYNTHESIS_MAX_QUESTIONS,
  LINT_FREQUENCY,
  LINT_STALE_DAYS,
};

// ─── Types ──────────────────────────────────────────────────────

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
}

interface TopicRow {
  id: number;
  agent_id: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  last_session_key: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  conversation_id: string;
  agent_id: string;
  role: string;
  text_content: string | null;
  tool_calls: string | null;
  tool_results: string | null;
  metadata: string | null;
  token_count: number | null;
  message_index: number;
  is_heartbeat: number;
  created_at: string;
  topic_id: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Score a message for keystone quality.
 * Heuristic: count references (file paths, agent mentions, quoted content, backticks).
 */
function keystoneScore(msg: MessageRow): number {
  const text = msg.text_content || '';
  let score = 0;

  // File path references
  const pathMatches = text.match(/\/[\w./\-]+/g) || [];
  score += pathMatches.length * 0.3;

  // Backtick code references (inline or block)
  const backtickMatches = text.match(/`[^`]+`/g) || [];
  score += backtickMatches.length * 0.2;

  // Agent mentions — add your agent IDs here for better topic scoring
  // const agentMentions = text.match(/\b(agent-one|agent-two)\b/gi) || [];
  // score += agentMentions.length * 0.25;

  // Quoted content
  const quotedMatches = text.match(/"[^"]{10,}"/g) || [];
  score += quotedMatches.length * 0.15;

  // Decision/spec content type boosts score
  const classification = classifyContentType(text);
  if (classification.type === 'decision') score += 1.0;
  else if (classification.type === 'spec') score += 0.5;
  else if (classification.type === 'preference') score += 0.3;

  // Length bonus (up to 0.5 for ~500 chars)
  score += Math.min(text.length / 1000, 0.5);

  return score;
}

/**
 * Extract file artifact paths from a message's tool_calls JSON.
 */
function extractArtifacts(msg: MessageRow): string[] {
  if (!msg.tool_calls) return [];
  const artifacts: string[] = [];
  try {
    const calls = JSON.parse(msg.tool_calls);
    if (!Array.isArray(calls)) return [];
    for (const call of calls) {
      const args = call.input || call.function?.arguments || call.arguments || {};
      let parsed = args;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch { continue; }
      }
      if (typeof parsed !== 'object' || !parsed) continue;
      for (const key of ['path', 'file', 'filePath', 'file_path']) {
        const val = (parsed as Record<string, unknown>)[key];
        if (typeof val === 'string' && val.startsWith('/')) {
          artifacts.push(val);
        }
      }
    }
  } catch {
    // Malformed JSON — skip
  }
  return artifacts;
}

/**
 * Truncate text to maxChars with head+tail preservation.
 * head = 60% of budget, tail = 40%.
 */
function truncateHeadTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
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
function parseStoredMessageCount(sourceRef: string | null): number {
  if (!sourceRef) return 0;
  const match = sourceRef.match(/:mc:(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

// ─── TopicSynthesizer ───────────────────────────────────────────

export class TopicSynthesizer {
  private readonly effectiveConfig: SynthesisConfig;

  constructor(
    private readonly libraryDb: DatabaseSync,
    private readonly getMessageDb: (agentId: string) => DatabaseSync | null,
    private readonly config?: Partial<SynthesisConfig>
  ) {
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
  tick(agentId: string): SynthesisResult {
    const result: SynthesisResult = {
      topicsSynthesized: 0,
      topicsSkipped: 0,
      knowledgeEntriesWritten: 0,
    };

    const cfg = this.effectiveConfig;
    const staleThresholdMinutes = cfg.SYNTHESIS_STALE_MINUTES;

    // Query stale topics for this agent
    // "Stale" = updated_at older than SYNTHESIS_STALE_MINUTES ago
    let staleTopics: TopicRow[];
    try {
      staleTopics = this.libraryDb.prepare(`
        SELECT * FROM topics
        WHERE agent_id = ?
          AND message_count >= ?
          AND updated_at < datetime('now', '-${staleThresholdMinutes} minutes')
        ORDER BY updated_at ASC
      `).all(agentId, cfg.SYNTHESIS_MIN_MESSAGES) as unknown as TopicRow[];
    } catch {
      return result;
    }

    if (staleTopics.length === 0) return result;

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

      let messages: MessageRow[];
      try {
        messages = messageDb.prepare(`
          SELECT * FROM messages WHERE topic_id = ? ORDER BY created_at ASC
        `).all(String(topic.id)) as unknown as MessageRow[];
      } catch {
        result.topicsSkipped++;
        continue;
      }

      if (messages.length === 0) {
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
   * Synthesize a wiki page for a topic from its messages.
   */
  private synthesizeTopic(
    topic: TopicRow,
    messages: MessageRow[],
    cfg: SynthesisConfig
  ): string {
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
    const openQuestions: typeof scored = [];
    for (let i = 0; i < scored.length; i++) {
      const item = scored[i];
      const text = item.msg.text_content || '';
      // Question detection: ends with ? OR is a discussion-type with question keywords
      const isQuestion = /\?\s*$/.test(text.trim()) ||
        (item.classification.type === 'discussion' && /\b(why|how|what|when|where|should|could|would|can|is there)\b/i.test(text));
      if (!isQuestion) continue;

      // Check if there's a decision-type response within next 5 messages
      const followup = scored.slice(i + 1, i + 6);
      const hasDecisionFollowup = followup.some(f => f.classification.type === 'decision');
      if (!hasDecisionFollowup) {
        openQuestions.push(item);
        if (openQuestions.length >= cfg.SYNTHESIS_MAX_QUESTIONS) break;
      }
    }

    // Extract artifacts from tool_calls
    const allArtifacts = new Set<string>();
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
    const lines: string[] = [];

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
    } else {
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
    } else {
      lines.push('_No open questions_');
    }
    lines.push('');

    lines.push('## Artifacts');
    if (allArtifacts.size > 0) {
      for (const artifact of allArtifacts) {
        lines.push(`- ${artifact}`);
      }
    } else {
      lines.push('_No artifacts recorded_');
    }
    lines.push('');

    lines.push('## Cross-References');
    lines.push('_Auto-generated — see knowledge graph for links_');

    return lines.join('\n');
  }
}
