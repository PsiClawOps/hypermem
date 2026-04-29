/**
 * hypermem Background Indexer
 *
 * Processes message history to extract structured knowledge:
 *   - Facts: atomic pieces of learned information
 *   - Episodes: significant events worth remembering
 *   - Topics: conversation threads and their lifecycle
 *   - Knowledge: durable structured entries (domain + key)
 *
 * Runs as a periodic background task, processing unindexed messages
 * in batches. Each batch is scored, classified, and stored in L4 (library.db).
 *
 * Design principles:
 *   - No LLM dependency: extraction uses pattern matching + heuristics
 *   - Idempotent: tracks watermarks per agent to avoid reprocessing
 *   - Bounded: processes N messages per tick to avoid blocking
 *   - Observable: logs extraction stats for monitoring
 */

import type { DatabaseSync } from 'node:sqlite';
import type { StoredMessage, IndexerConfig, EpisodeType, SessionCursor, MaintenanceTickDiagnostics } from './types.js';
import { lintKnowledge } from './knowledge-lint.js';
import { MessageStore } from './message-store.js';
import { runNoiseSweep, runToolDecay } from './proactive-pass.js';
import { TopicSynthesizer } from './topic-synthesizer.js';
import { runDreamingPassForFleet, type DreamerConfig } from './dreaming-promoter.js';
import { FactStore } from './fact-store.js';
import { EpisodeStore } from './episode-store.js';
import { TopicStore } from './topic-store.js';
import { KnowledgeStore } from './knowledge-store.js';
import { TemporalStore } from './temporal-store.js';
import { ContradictionDetector } from './contradiction-detector.js';
import { ContradictionAuditStore } from './contradiction-audit-store.js';
import { DEFAULT_CONTRADICTION_POLICY, type ContradictionResolutionPolicy } from './contradiction-resolution-policy.js';
import { isSafeForSharedVisibility } from './secret-scanner.js';
import type { VectorStore } from './vector-store.js';

// ─── Agent-to-Domain Map ────────────────────────────────────────
// Maps well-known agent IDs to their primary domain.
// Used to populate the `domain` column on extracted facts so that
// domain-scoped retrieval (e.g. getActiveFacts({ domain: 'infrastructure' }))
// returns results. New agents default to 'general'.
//
// ── EXAMPLE DATA ──────────────────────────────────────────────────
// The agent names below (alice, director1, etc.) are PLACEHOLDERS.
// Replace them with your own agent IDs and domain labels to match
// your fleet. Single-agent installs don't need to edit this:
// unknown agents fall through to 'general' automatically.
// See INSTALL.md § "Configure your fleet" for details.
// ─────────────────────────────────────────────────────────────────
const AGENT_DOMAIN_MAP: Record<string, string> = {
  alice:        'infrastructure',
  director2:        'infrastructure',
  director1:        'infrastructure',
  director3:        'infrastructure',
  bob:      'product',
  director4:         'product',
  director5:       'product',
  director6:        'product',
  dave:     'security',
  director7:      'security',
  director8:        'security',
  agent4:      'ux',
  carol:        'governance',
  oscar:     'strategy',
  specialist1:     'development',
  specialist2:        'communications',
  main:         'general',
  'channel-mini': 'general',
};

/**
 * Derive a domain label for a fact based on agent ID.
 * Falls back to 'general' for unknown agents.
 */
function domainForAgent(agentId: string): string {
  return AGENT_DOMAIN_MAP[agentId] ?? 'general';
}


// ─── Types ──────────────────────────────────────────────────────

export interface IndexerStats {
  agentId: string;
  messagesProcessed: number;
  factsExtracted: number;
  episodesRecorded: number;
  topicsUpdated: number;
  knowledgeUpserted: number;
  /** Number of superseded fact vectors tombstoned from the vector index this tick. */
  tombstoned: number;
  /** Number of contradiction audits recorded for review this tick. */
  contradictionAuditsLogged: number;
  /** Number of old facts auto-superseded via contradiction policy this tick. */
  contradictionsAutoSuperseded: number;
  /** Number of old facts auto-invalidated via contradiction policy this tick. */
  contradictionsAutoInvalidated: number;
  elapsedMs: number;
  /** Number of messages that were post-cursor (unseen by model, high-signal priority). */
  postCursorMessages: number;
}

/**
 * Optional callback to fetch the session cursor for an agent+session.
 * When provided, the indexer uses the cursor to prioritize unseen messages.
 * The cursor boundary separates "model has seen this" from "new since last compose".
 */
export type CursorFetcher = (agentId: string, sessionKey: string) => Promise<SessionCursor | null>;

export interface WatermarkState {
  agentId: string;
  lastMessageId: number;
  lastRunAt: string;
}

// ─── Pattern Matchers ───────────────────────────────────────────

/**
 * Patterns that indicate a message contains extractable facts.
 * Returns extracted facts as strings.
 */
/** Extracted fact candidate with pattern-based confidence. */
interface FactCandidate {
  content: string;
  /** TUNE-003: confidence varies by extraction pattern type */
  confidence: number;
}

function extractFactCandidates(content: string): FactCandidate[] {
  const facts: FactCandidate[] = [];
  if (!content || content.length < 20) return facts;

  // Decision patterns: "decided to", "agreed on", "choosing", "going with" — high confidence (0.75)
  const decisionPatterns = [
    /(?:we |I |they )?(?:decided|agreed|chose|selected|committed) (?:to |on |that )(.{20,200})/gi,
    /(?:going|went) with (.{10,150})/gi,
    /decision:\s*(.{10,200})/gi,
  ];

  // Learned/discovered patterns — medium-high confidence (0.65)
  const learnedPatterns = [
    /(?:learned|discovered|found out|realized|noticed) (?:that |)(.{20,200})/gi,
    /turns out (?:that |)(.{20,200})/gi,
    /(?:TIL|FYI|note to self)[:\s]+(.{10,200})/gi,
  ];

  // Config/setting patterns — medium confidence (0.60); matches more promiscuously
  const configPatterns = [
    /(?:set|changed|updated|configured) (\S+ to .{5,150})/gi,
    /(?:model|config|setting)[:\s]+(\S+\s*(?:→|->|=|is)\s*.{5,100})/gi,
  ];

  // Preference patterns — medium confidence (0.60)
  const preferencePatterns = [
    /(?:prefer|always use|never use|don't use|avoid) (.{10,150})/gi,
    /(?:operator) (?:wants|prefers|likes|hates|dislikes) (.{10,150})/gi,
  ];

  // Operational patterns: deployments, incidents, fixes — high confidence (0.70)
  const operationalPatterns = [
    /(?:deployed|shipped|released|rolled back|reverted) (.{10,200})/gi,
    /(?:outage|incident|failure|broke|broken|crashed)(?:: | — | - )(.{10,200})/gi,
    /(?:fixed|resolved|patched|hotfixed) (.{10,200})/gi,
  ];

  const patternGroups: Array<{ patterns: RegExp[]; confidence: number }> = [
    { patterns: decisionPatterns,    confidence: 0.75 },
    { patterns: learnedPatterns,     confidence: 0.65 },
    { patterns: configPatterns,      confidence: 0.60 },
    { patterns: preferencePatterns,  confidence: 0.60 },
    { patterns: operationalPatterns, confidence: 0.70 },
  ];

  for (const { patterns, confidence } of patternGroups) {
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      // Reset lastIndex for global patterns
      pattern.lastIndex = 0;
      while ((match = pattern.exec(content)) !== null) {
        const candidate = match[1].trim();
        // Quality gate: reject noise that matched patterns but isn't a real fact
        if (!isQualityFact(candidate)) continue;
        facts.push({ content: candidate, confidence });
      }
    }
  }

  return facts;
}

/**
 * TUNE-011: Quality gate for fact extraction.
 * Rejects pattern matches that are code, table fragments, questions,
 * or too short to be meaningful facts.
 */
/**
 * Operational boilerplate phrases that appear frequently across sessions
 * but carry zero signal value. High knn similarity makes them *worse*
 * retrieval candidates — they match everything and contaminate episodes.
 */
const OPERATIONAL_BOILERPLATE: RegExp[] = [
  /timed?\s*out\s*waiting/i,
  /message\s*was\s*delivered/i,
  /no\s*reply\s*(back\s*)?yet/i,
  /picked?\s*it\s*up\s*on\s*(next\s*)?heartbeat/i,
  /session\s*not\s*found/i,
  /\bretrying\b/i,
  /tool\s*call\s*failed/i,
  /exec\s*completed/i,
  /no\s*reply\s*needed/i,
  /still\s*waiting/i,
  /will\s*pick\s*(it\s*)?up\s*(on\s*(next|the))?/i,
  /message\s*is\s*in\s*(his|her|their|the)\s*queue/i,
  /sent\s+to\s+(carol|bob|agent4|dave|oscar|alice)/i,
  /dispatched\s+(it\s+)?to/i,
  /timed\s*out\s*after/i,
  /\bNO_REPLY\b/,
];

function isQualityFact(content: string): boolean {
  // Too short — sentence fragments
  if (content.length < 40) return false;

  // Too long — likely captured a paragraph, not a fact
  if (content.length > 300) return false;

  // Fewer than 5 words — fragment
  const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount < 5) return false;

  // Questions — not assertions of fact
  if (content.trimEnd().endsWith('?')) return false;

  // Code indicators: braces, arrows, imports, variable declarations
  if (/^[\s{}\[\]|`]/.test(content)) return false;  // starts with structural char
  if (/[{}].*[{}]/.test(content)) return false;       // contains paired braces (code blocks)
  if (/^\s*(import|export|const|let|var|function|class|interface|type|return|if|for|while|switch)\s/i.test(content)) return false;
  if (/=>\s*[{(]/.test(content)) return false;        // arrow functions
  if (/SELECT\s|INSERT\s|UPDATE\s|DELETE\s|CREATE\s/i.test(content)) return false;  // SQL

  // Table cell fragments: contains pipe-delimited cells
  if (/\|.*\|.*\|/.test(content)) return false;

  // Regex patterns leaked from source
  if (/\/[^/]+\/[gimsuvy]*[,;]/.test(content)) return false;

  // Raw file paths without context (tool output, not facts)
  if (/^\/[\w/.-]+$/.test(content.trim())) return false;

  // Markdown formatting artifacts
  if (content.startsWith('```') || content.startsWith('---') || content.startsWith('===')) return false;

  // Git output
  if (/^[a-f0-9]{7,40}\s/.test(content) || /^\+\+\+|^---\s[ab]\//.test(content)) return false;
  if (/^\d+ files? changed/.test(content)) return false;

  // Stack traces
  if (/^\s*at\s+\S+\s+\(/.test(content) || /node:internal/.test(content)) return false;

  // High non-alpha ratio indicates code/data, not natural language
  const alphaChars = (content.match(/[a-zA-Z]/g) || []).length;
  if (alphaChars / content.length < 0.5) return false;

  // TUNE-013: External/untrusted content markers — web search excerpts,
  // external doc pulls, and injected context blocks should never become facts.
  if (/<<<\s*(END_EXTERNAL|BEGIN_EXTERNAL|EXTERNAL_UNTRUSTED|UNTRUSTED_CONTENT)/i.test(content)) return false;
  if (/EXTERNAL_UNTRUSTED_CONTENT\s+id=/.test(content)) return false;

  // TUNE-013: Multi-paragraph content — real extracted facts are single sentences.
  // More than 2 newlines means we captured a paragraph or structured block, not a fact.
  const newlineCount = (content.match(/\n/g) || []).length;
  if (newlineCount > 2) return false;

  // TUNE-013: URL-heavy content — external source snippets, not actionable facts
  const urlMatches = content.match(/https?:\/\/\S+/g) || [];
  if (urlMatches.length >= 2) return false;  // one URL in a fact is ok; multiple = source snippet

  // TUNE-013: Content starting with a markdown heading is section text, not a fact
  if (/^#{1,4}\s/.test(content.trim())) return false;

  // TUNE-014: Operational boilerplate — phrases common across sessions that produce
  // high knn similarity scores but carry zero signal. They cross-contaminate episodes.
  for (const pattern of OPERATIONAL_BOILERPLATE) {
    if (pattern.test(content)) return false;
  }

  return true;
}

/**
 * Classify a message for episode significance.
 * Returns episode type and significance score, or null if not significant.
 */
function classifyEpisode(msg: StoredMessage): { type: EpisodeType; significance: number; summary: string } | null {
  const content = msg.textContent || '';
  if (!content || content.length < 50) return null;  // Raised from 30

  // Skip heartbeats
  if (msg.isHeartbeat) return null;

  // Skip messages that are primarily code/data output (tool results, logs)
  const alphaRatio = (content.match(/[a-zA-Z]/g) || []).length / content.length;
  if (alphaRatio < 0.4) return null;

  // Skip messages that start with structural output indicators
  if (/^[\s]*[{[\d|#=+\-]/.test(content) && content.length < 200) return null;

  const lower = content.toLowerCase();

  // ── Negation-aware incident detection ──────────────────────
  // Only trigger on actual incidents, not "zero failures" or "no crashes"
  const incidentTerms = ['outage', 'incident', 'failure', 'crash', 'broke', 'broken', 'emergency'];
  const negationPrefixes = ['no ', 'zero ', 'without ', '0 ', 'never ', 'fixed ', 'resolved '];

  const hasIncidentTerm = incidentTerms.some(term => lower.includes(term));
  const isNegated = hasIncidentTerm && incidentTerms.some(term => {
    const idx = lower.indexOf(term);
    if (idx < 0) return false;
    const prefix = lower.substring(Math.max(0, idx - 15), idx).toLowerCase();
    return negationPrefixes.some(neg => prefix.includes(neg.trimEnd()));
  });

  if (hasIncidentTerm && !isNegated && content.length > 100) {
    // Genuine incident — verify it's describing a problem, not analyzing code
    if (!/^\s*(\/\/|#|\*|\/\*|```|import|const|function)/.test(content)) {
      const summary = content.slice(0, 200);
      return { type: 'incident', significance: 0.9, summary };
    }
  }

  // Deployment events (high significance)
  if (
    /(?:deployed|shipped|released|went live|now live|go live)/i.test(content) &&
    content.length > 60
  ) {
    const summary = content.slice(0, 200);
    return { type: 'deployment', significance: 0.8, summary };
  }

  // Architecture decisions (high significance)
  if (
    /(?:decided on|chose|committed to|architecture|design decision)/i.test(content) &&
    content.length > 80
  ) {
    const summary = content.slice(0, 200);
    return { type: 'decision', significance: 0.7, summary };
  }

  // Discovery/insight (medium significance)
  if (/(?:discovered|found|realized|root cause|turns out)/i.test(content) && content.length > 80) {
    const summary = content.slice(0, 200);
    return { type: 'discovery', significance: 0.5, summary };
  }

  // Config changes (medium significance) — TUNE-004: raised to 0.5
  if (/(?:changed|updated|migrated|switched|model.*(?:→|->|to))/i.test(content) && content.length > 60) {
    // Skip if it's just a tool output confirmation
    if (/^Successfully replaced|^\[main [a-f0-9]|^ok \d+ -/.test(content)) return null;
    const summary = content.slice(0, 200);
    return { type: 'config_change', significance: 0.5, summary };
  }

  // Milestone/completion (medium significance)
  if (
    /(?:completed|finished|done|milestone|all tests pass|all green)/i.test(content) &&
    content.length > 60
  ) {
    // Skip tool output that happens to contain "done"
    if (/^Successfully|^\[main|^ok \d+/.test(content)) return null;
    const summary = content.slice(0, 200);
    return { type: 'milestone', significance: 0.5, summary };
  }

  return null;
}

/**
 * Extract knowledge candidates — structured (domain, key, value) tuples.
 */
function extractKnowledgeCandidates(
  content: string,
  agentId: string
): Array<{ domain: string; key: string; value: string }> {
  const results: Array<{ domain: string; key: string; value: string }> = [];
  if (!content || content.length < 30) return results;

  // TUNE-012: Broadened path extraction.
  // Real messages use paths inline without explicit prefixes like "located at".
  // Match any absolute path that's at least 3 segments deep (filters /tmp, /etc noise).
  const pathMatches = content.matchAll(
    /(?:`([/][\w./-]{10,})`|(?:^|[\s:=])(\/home\/[\w./-]{10,}|\/opt\/[\w./-]{10,}|\/var\/[\w./-]{10,}))/gm
  );
  for (const match of pathMatches) {
    const value = (match[1] || match[2]).replace(/[`'".,;:)]+$/, '').trim();
    if (value.length > 10 && value.split('/').length >= 4) {
      const segments = value.split('/').filter(s => s.length > 0);
      const lastSeg = segments[segments.length - 1] || '';
      // Reject truncated paths (last segment < 3 chars unless it's a known ext)
      if (lastSeg.length < 3 && !lastSeg.includes('.')) continue;
      const key = lastSeg || segments[segments.length - 2] || 'unknown';
      results.push({ domain: 'paths', key, value });
    }
  }

  // Explicit location references (original patterns, kept for completeness)
  const locationPatterns = [
    /(?:path|located at|lives at|stored at|found at|repo at|running at)[:\s]+(`[^`]+`|\/\S+)/gi,
    /(?:workspace|directory|repo|project)[:\s]+(`[^`]+`|\/\S+)/gi,
  ];
  for (const pattern of locationPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const value = match[1].replace(/[`'".,;:)]+/g, '').trim();
      if (value.startsWith('/') && value.length > 10 && !results.some(r => r.value === value)) {
        const key = value.split('/').pop() || 'unknown';
        results.push({ domain: 'paths', key, value });
      }
    }
  }

  // Service/port patterns — broadened to catch "port NNNN" and "on :NNNN"
  const servicePatterns = [
    /(\S+)\s+(?:runs on|listening on|port|on port)\s+(\d{2,5})/gi,
    /(?:service|server|daemon)\s+(\S+)\s+(?:on |at |: )(\S+)/gi,
    /(?:localhost|127\.0\.0\.1):(\d{2,5})\b/gi,
  ];

  for (const pattern of servicePatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (pattern.source.includes('localhost')) {
        // localhost:PORT pattern — key is the port, value is the URL
        results.push({ domain: 'services', key: `port:${match[1]}`, value: match[0] });
      } else {
        results.push({ domain: 'services', key: match[1], value: match[2] });
      }
    }
  }

  // Agent identity patterns — broadened
  const identityPatterns = [
    /(\w+)\s+(?:is|was)\s+(?:the\s+)?(\w+)\s+(?:seat|director|specialist|council)/gi,
    /(\w+)\s+(?:reports to|owned by|managed by)\s+(\w+)/gi,
    /(?:agents?|directors?|seats?)[:\s]+(\w+)(?:\s*[,/]\s*(\w+))+/gi,
  ];

  for (const pattern of identityPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[2]) {
        results.push({ domain: 'fleet', key: match[1].toLowerCase(), value: `${match[1]} ${match[2]}` });
      }
    }
  }

  // Dedup by domain+key
  const seen = new Set<string>();
  return results.filter(r => {
    const k = `${r.domain}:${r.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Detect conversation topic from message content.
 * Returns a topic name candidate or null.
 */
function detectTopic(content: string): string | null {
  if (!content || content.length < 50) return null;

  // Product/project name detection
  const productMatch = content.match(
    /\b(HyperMem|ClawText|dashboard|canvas|council|automation|OpenClaw|dispatch)\b/i
  );
  if (productMatch) return productMatch[1];

  // Infrastructure topic detection
  if (/\b(?:redis|sqlite|database|migration|deployment|docker|nginx)\b/i.test(content)) {
    return 'infrastructure';
  }

  // Security topic detection
  if (/\b(?:security|auth|permission|access|token|credential)\b/i.test(content)) {
    return 'security';
  }

  return null;
}

// ─── Background Indexer ─────────────────────────────────────────

export class BackgroundIndexer {
  private readonly config: IndexerConfig;
  private readonly dreamerConfig: Partial<DreamerConfig>;
  private readonly globalWritePolicy: import('./types.js').GlobalWritePolicy;
  private readonly contradictionPolicy: ContradictionResolutionPolicy;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private vectorStore: VectorStore | null = null;
  private synthesizer: TopicSynthesizer | null = null;
  private tickCount: number = 0;
  /** Circuit breaker: consecutive tick failure count. Resets on success. */
  private consecutiveFailures: number = 0;
  /** True when the indexer is running in backoff mode due to repeated failures. */
  private inBackoff: boolean = false;
  private readonly _conversationLastProcessed = new Map<string, number>();
  lastMaintenanceDiagnostics: MaintenanceTickDiagnostics | null = null;

  constructor(
    config?: Partial<IndexerConfig>,
    private getMessageDb?: (agentId: string) => DatabaseSync,
    private getLibraryDb?: () => DatabaseSync,
    private listAgents?: () => string[],
    private getCursor?: CursorFetcher,
    dreamerConfig?: Partial<DreamerConfig>,
    globalWritePolicy?: import('./types.js').GlobalWritePolicy,
    contradictionPolicy?: ContradictionResolutionPolicy,
  ) {
    // Initialize synthesizer if libraryDb accessor is available
    if (getLibraryDb) {
      const libDb = getLibraryDb();
      if (libDb) {
        this.synthesizer = new TopicSynthesizer(
          libDb,
          (agentId: string) => {
            if (!getMessageDb) return null;
            try { return getMessageDb(agentId); } catch { return null; }
          }
        );
      }
    }

    this.config = {
      enabled: config?.enabled ?? true,
      factExtractionMode: config?.factExtractionMode ?? 'tiered',
      topicDormantAfter: config?.topicDormantAfter ?? '24h',
      topicClosedAfter: config?.topicClosedAfter ?? '7d',
      factDecayRate: config?.factDecayRate ?? 0.01,
      episodeSignificanceThreshold: config?.episodeSignificanceThreshold ?? 0.5,
      periodicInterval: config?.periodicInterval ?? 60000,  // 1 minute
      batchSize: config?.batchSize ?? 128,
      maxMessagesPerTick: config?.maxMessagesPerTick ?? 500,
      maxActiveConversations: config?.maxActiveConversations ?? 5,
      recentConversationCooldownMs: config?.recentConversationCooldownMs ?? 30000,
      maxCandidatesPerPass: config?.maxCandidatesPerPass ?? 200,
    };
    this.dreamerConfig = dreamerConfig ?? {};
    this.globalWritePolicy = globalWritePolicy ?? 'deny';
    this.contradictionPolicy = contradictionPolicy ?? DEFAULT_CONTRADICTION_POLICY;
  }

  /**
   * Set the vector store for embedding new facts/episodes at index time.
   * Optional — if not set, indexer runs without embedding (FTS5-only mode).
   */
  setVectorStore(vs: VectorStore): void {
    this.vectorStore = vs;
  }

  /**
   * Start periodic indexing.
   */
  start(): void {
    if (!this.config.enabled) return;
    if (this.intervalHandle) return;

    // Startup integrity check — catch corruption before the first tick writes anything.
    if (this.getLibraryDb) {
      try {
        const libDb = this.getLibraryDb();
        if (libDb) {
          const row = libDb.prepare('PRAGMA quick_check').get() as { integrity_check?: string } | undefined;
          if (row?.integrity_check && row.integrity_check !== 'ok') {
            console.error(
              '[indexer] ⚠️  library.db integrity check failed: ' + row.integrity_check + '\n' +
              '[indexer] Recovery: stop OpenClaw, run ' +
              '`sqlite3 ~/.openclaw/hypermem/library.db ".recover" | sqlite3 ~/.openclaw/hypermem/library_recovered.db`' +
              ', swap the files, and restart. If recovery fails, delete library.db — the indexer rebuilds from message history.'
            );
            // Don't start the interval — nothing will succeed with a corrupt DB.
            return;
          }
        }
      } catch (err) {
        // If we can't even open the DB, log and bail — don't start the interval.
        console.error('[indexer] Could not open library.db for integrity check:', (err as Error).message);
        return;
      }
    }

    // Run once immediately
    this.tick().catch(err => {
      this._handleTickError(err, 'initial');
    });

    // Run episode vector backfill once at startup (no-op if already done)
    if (this.vectorStore && this.getLibraryDb) {
      this.backfillEpisodeVectors().catch(err => {
        console.error('[indexer] Episode backfill failed:', err);
      });
    }

    // Then periodically
    this.intervalHandle = setInterval(() => {
      this.tick().catch(err => {
        this._handleTickError(err, 'periodic');
      });
    }, this.config.periodicInterval);

    console.log(`[indexer] Started with interval ${this.config.periodicInterval}ms, batchSize ${this.config.batchSize}, maxPerTick ${this.config.maxMessagesPerTick}`);
  }

  /**
   * Circuit breaker for tick failures.
   *
   * - Tracks consecutive failures.
   * - After 3 failures, logs actionable recovery guidance once, then switches
   *   the indexer to 10× backoff interval so it stops spamming the log.
   * - On the next successful tick, resets state and restores normal interval.
   */
  private _handleTickError(err: unknown, phase: 'initial' | 'periodic'): void {
    this.consecutiveFailures++;
    const msg = err instanceof Error ? err.message : String(err);
    const isSqliteCorrupt = msg.includes('database disk image is malformed') ||
      msg.includes('SQLITE_CORRUPT') ||
      (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR');

    if (this.consecutiveFailures < 3) {
      // First 1–2 failures: log normally.
      console.error(`[indexer] ${phase === 'initial' ? 'Initial' : 'Periodic'} tick failed (attempt ${this.consecutiveFailures}/3):`, err);
      return;
    }

    if (this.consecutiveFailures === 3) {
      // Third failure: log once with recovery instructions, then enter backoff.
      if (isSqliteCorrupt) {
        console.error(
          `[indexer] ⛔ Tick failed 3 times consecutively — library.db appears corrupted. Entering backoff mode.\n` +
          `[indexer] Recovery steps:\n` +
          `[indexer]   1. Stop OpenClaw: openclaw gateway stop\n` +
          `[indexer]   2. Check damage: sqlite3 ~/.openclaw/hypermem/library.db "PRAGMA integrity_check"\n` +
          `[indexer]   3. Attempt recovery: sqlite3 ~/.openclaw/hypermem/library.db ".recover" | sqlite3 ~/.openclaw/hypermem/library_recovered.db\n` +
          `[indexer]   4. Swap: mv library.db library_corrupt.bak && mv library_recovered.db library.db\n` +
          `[indexer]   5. If recovery fails, delete library.db — the indexer rebuilds from message history on next start.\n` +
          `[indexer]   6. Restart: openclaw gateway start\n` +
          `[indexer] Indexer will retry every ${(this.config.periodicInterval * 10) / 60000} minutes until then.`
        );
      } else {
        console.error(
          `[indexer] ⛔ Tick failed 3 times consecutively (${msg}). Entering backoff mode. ` +
          `Will retry every ${(this.config.periodicInterval * 10) / 60000} minutes.`
        );
      }

      // Switch to backoff interval.
      this.inBackoff = true;
      if (this.intervalHandle) {
        clearInterval(this.intervalHandle);
      }
      this.intervalHandle = setInterval(() => {
        this.tick().catch(backoffErr => {
          this._handleTickError(backoffErr, 'periodic');
        });
      }, this.config.periodicInterval * 10);
      return;
    }

    // Beyond 3: silent (already logged, in backoff — don't spam).
  }

  /**
   * Reset the circuit breaker and restore normal interval after a successful tick.
   * Called at the end of a successful tick().
   */
  private _resetCircuitBreaker(): void {
    if (this.consecutiveFailures === 0) return;
    const wasInBackoff = this.inBackoff;
    this.consecutiveFailures = 0;
    this.inBackoff = false;
    if (wasInBackoff) {
      // Restore normal interval.
      if (this.intervalHandle) clearInterval(this.intervalHandle);
      this.intervalHandle = setInterval(() => {
        this.tick().catch(err => {
          this._handleTickError(err, 'periodic');
        });
      }, this.config.periodicInterval);
      console.log('[indexer] Circuit breaker reset — tick succeeded, restored normal interval.');
    }
  }

  /**
   * Stop periodic indexing.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Run one indexing pass across all agents.
   */
  async tick(): Promise<IndexerStats[]> {
    if (this.running) {
      console.log('[indexer] Skipping tick — previous run still active');
      return [];
    }

    this.running = true;
    const results: IndexerStats[] = [];
    let tickSucceeded = false;

    try {
      if (!this.listAgents || !this.getMessageDb || !this.getLibraryDb) {
        console.warn('[indexer] Missing database accessors — skipping');
        return [];
      }

      const agents = this.listAgents();
      const libraryDb = this.getLibraryDb();
      let tickTotal = 0;

      for (const agentId of agents) {
        if (tickTotal >= this.config.maxMessagesPerTick) {
          console.log(`[indexer] maxMessagesPerTick (${this.config.maxMessagesPerTick}) reached — deferring remaining agents`);
          break;
        }
        try {
          const stats = await this.processAgent(agentId, libraryDb);
          tickTotal += stats.messagesProcessed;
          if (stats.messagesProcessed > 0 || stats.tombstoned > 0) {
            results.push(stats);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[indexer] Failed to process ${agentId}: ${msg}`);
        }
      }

      if (results.length > 0) {
        const totalMessages = results.reduce((s, r) => s + r.messagesProcessed, 0);
        const totalFacts = results.reduce((s, r) => s + r.factsExtracted, 0);
        const totalEpisodes = results.reduce((s, r) => s + r.episodesRecorded, 0);
        const totalTombstoned = results.reduce((s, r) => s + r.tombstoned, 0);
        const tombstonedPart = totalTombstoned > 0 ? `, ${totalTombstoned} tombstoned` : '';
        console.log(
          `[indexer] Tick complete: ${totalMessages} messages → ${totalFacts} facts, ${totalEpisodes} episodes${tombstonedPart}`
        );
      }

      // Run decay on every tick
      this.applyDecay(libraryDb);

      // Topic synthesis — run for each agent after main indexer tick
      if (this.synthesizer) {
        for (const agentId of agents) {
          try {
            const synthResult = this.synthesizer.tick(agentId);
            if (synthResult.topicsSynthesized > 0) {
              console.log(`[indexer] Synthesized ${synthResult.topicsSynthesized} topics for ${agentId}, ${synthResult.knowledgeEntriesWritten} knowledge entries`);
            }
          } catch {
            // Non-fatal
          }
        }
      }

      // Knowledge lint — every LINT_FREQUENCY ticks
      this.tickCount++;
      if (this.tickCount % 10 === 0 && this.getLibraryDb) {
        try {
          const libDb = this.getLibraryDb();
          if (libDb) {
            const lint = lintKnowledge(libDb);
            if (lint.staleDecayed > 0 || lint.coverageGaps.length > 0) {
              console.log(`[indexer] Lint: ${lint.staleDecayed} stale decayed, ${lint.orphansFound} orphans, ${lint.coverageGaps.length} coverage gaps`);
            }
          }
        } catch {
          // Non-fatal
        }
      }

      // Dreaming promotion pass — every tickInterval ticks (default 12 = ~1hr)
      const dreamerEnabled = this.dreamerConfig.enabled ?? false;
      const dreamerTickInterval = this.dreamerConfig.tickInterval ?? 12;
      if (dreamerEnabled && this.tickCount % dreamerTickInterval === 0 && this.getLibraryDb) {
        try {
          const libDb = this.getLibraryDb();
          if (libDb) {
            const dreamResults = await runDreamingPassForFleet(agents, libDb, this.dreamerConfig);
            const totalPromoted = dreamResults.reduce((s, r) => s + r.promoted, 0);
            if (totalPromoted > 0) {
              console.log(`[indexer] Dreaming: promoted ${totalPromoted} facts across ${dreamResults.length} agents`);
            }
          }
        } catch (err) {
          // Non-fatal — dreaming failures never block indexing
          console.warn('[indexer] Dreaming pass failed (non-fatal):', (err as Error).message);
        }
      }

      // Run proactive passes on each agent's message DB
      const maintStart = Date.now();
      let maintConsidered = 0;
      let maintSkipped = 0;
      let maintScanned = 0;
      let maintMutated = 0;
      let maintExitReason: MaintenanceTickDiagnostics['exitReason'] = 'complete';
      const maxConvs = this.config.maxActiveConversations ?? 5;
      const cooldownMs = this.config.recentConversationCooldownMs ?? 30000;
      const maxCandidates = this.config.maxCandidatesPerPass ?? 200;
      const now = Date.now();

      for (const agentId of agents) {
        const messageDb = this.getMessageDb!(agentId);
        if (!messageDb) continue;

        let convRows: Array<{ id: number }>;
        try {
          convRows = messageDb.prepare(
            `SELECT id FROM conversations WHERE agent_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT ?`
          ).all(agentId, maxConvs) as Array<{ id: number }>;
        } catch {
          continue;
        }

        if (convRows.length === 0) {
          if (maintExitReason === 'complete') maintExitReason = 'no-conversations';
          continue;
        }

        for (const conv of convRows) {
          maintConsidered++;
          const conversationKey = `${agentId}:${conv.id}`;
          const lastProcessed = this._conversationLastProcessed.get(conversationKey) ?? 0;
          if (now - lastProcessed < cooldownMs) {
            maintSkipped++;
            continue;
          }

          maintScanned++;
          // Any successful scan means we're in a real working state —
          // clear any stale 'no-conversations' marker from an earlier agent.
          if (maintExitReason === 'no-conversations') maintExitReason = 'complete';
          const proactiveContext = { agentId };
          const noiseSweepResult = runNoiseSweep(messageDb, conv.id, 20, maxCandidates, proactiveContext);
          const toolDecayResult = runToolDecay(messageDb, conv.id, 40, maxCandidates, proactiveContext);
          const changed = noiseSweepResult.messagesDeleted + toolDecayResult.messagesUpdated;
          if (changed > 0) {
            maintMutated += changed;
            console.log(
              `[indexer] Proactive pass (agent ${agentId} conv ${conv.id}): swept ${noiseSweepResult.messagesDeleted} noise msgs, ` +
              `decayed ${toolDecayResult.messagesUpdated} tool results (${toolDecayResult.bytesFreed} bytes freed)`
            );
          }
          this._conversationLastProcessed.set(conversationKey, now);

          if (maintMutated >= maxCandidates) {
            maintExitReason = 'cap-reached';
            break;
          }
        }
        if (maintExitReason === 'cap-reached') break;
      }

      this.lastMaintenanceDiagnostics = {
        considered: maintConsidered,
        skipped: maintSkipped,
        scanned: maintScanned,
        mutated: maintMutated,
        durationMs: Date.now() - maintStart,
        exitReason: maintExitReason,
      };
      if (maintScanned > 0) {
        console.log(
          `[indexer] Maintenance: considered=${maintConsidered} skipped=${maintSkipped} scanned=${maintScanned} mutated=${maintMutated} ` +
          `duration=${this.lastMaintenanceDiagnostics.durationMs}ms exit=${maintExitReason}`
        );
      }

      // If we reach here, the tick completed without throwing.
      tickSucceeded = true;

    } finally {
      if (tickSucceeded) this._resetCircuitBreaker();
      this.running = false;
    }

    return results;
  }

  /**
   * Process a single agent's unindexed messages.
   *
   * When a cursor fetcher is available, messages are split into two tiers:
   *   - Post-cursor (id > cursor.lastSentId): "unseen" by the model, high-signal priority
   *   - Pre-cursor (id <= cursor.lastSentId): already in the model's context window, lower priority
   * Post-cursor messages are processed first. This ensures the indexer prioritizes
   * content the model hasn't seen yet — decisions, incidents, and discoveries that
   * happened between context windows.
   */
  private async processAgent(agentId: string, libraryDb: DatabaseSync): Promise<IndexerStats> {
    const start = Date.now();
    const messageDb = this.getMessageDb!(agentId);

    const messageStore = new MessageStore(messageDb);
    const factStore = new FactStore(libraryDb);
    const episodeStore = new EpisodeStore(libraryDb);
    const topicStore = new TopicStore(libraryDb);
    const knowledgeStore = new KnowledgeStore(libraryDb);
    const temporalStore = new TemporalStore(libraryDb);

    // Get watermark — last processed message ID for this agent
    const watermark = this.getWatermark(libraryDb, agentId);
    const lastProcessedId = watermark?.lastMessageId ?? 0;

    // Fetch unindexed messages (batch size from config)
    const messages = this.getUnindexedMessages(messageDb, agentId, lastProcessedId, this.config.batchSize);

    if (messages.length === 0) {
      // Even with no new messages, run tombstone cleanup in case supersedes
      // were written externally (e.g. via FactStore.markSuperseded()).
      let tombstoned = 0;
      if (this.vectorStore) {
        tombstoned = this.vectorStore.tombstoneSuperseded();
      }
      return {
        agentId,
        messagesProcessed: 0,
        factsExtracted: 0,
        episodesRecorded: 0,
        topicsUpdated: 0,
        knowledgeUpserted: 0,
        tombstoned,
        postCursorMessages: 0,
        contradictionAuditsLogged: 0,
        contradictionsAutoSuperseded: 0,
        contradictionsAutoInvalidated: 0,
        elapsedMs: Date.now() - start,
      };
    }

    // ── Cursor-aware prioritization ──────────────────────────────
    // Fetch the cursor boundary to split messages into post-cursor (unseen)
    // and pre-cursor (already in context). Post-cursor messages are processed
    // first — they're the highest signal for fact/episode extraction.
    let cursorBoundary = 0;
    if (this.getCursor) {
      try {
        // Get session key from the first message's conversation
        const sessionKey = this.getSessionKeyForMessage(messageDb, messages[0].conversationId);
        if (sessionKey) {
          const cursor = await this.getCursor(agentId, sessionKey);
          if (cursor) {
            cursorBoundary = cursor.lastSentId;
          }
        }
      } catch {
        // Cursor fetch is best-effort — fall through to default ordering
      }
    }

    // Sort: post-cursor messages first (highest signal), then pre-cursor.
    // Within each tier, maintain original (ascending) order.
    const postCursor = messages.filter(m => m.id > cursorBoundary);
    const preCursor = messages.filter(m => m.id <= cursorBoundary);
    const ordered = [...postCursor, ...preCursor];

    let factsExtracted = 0;
    let episodesRecorded = 0;
    let topicsUpdated = 0;
    let knowledgeUpserted = 0;
    let supersededFacts = 0;
    let contradictionAuditsLogged = 0;
    let contradictionsAutoSuperseded = 0;
    let contradictionsAutoInvalidated = 0;
    let maxMessageId = lastProcessedId;

    const contradictionDetector = new ContradictionDetector(factStore, this.vectorStore ?? undefined, {
      autoResolve: false,
      maxCandidates: 6,
      minSimilarity: 0.45,
    });
    const contradictionAuditStore = new ContradictionAuditStore(libraryDb);

    for (const msg of ordered) {
      const content = msg.textContent || '';
      if (msg.id > maxMessageId) maxMessageId = msg.id;

      // Skip heartbeats and very short messages
      if (msg.isHeartbeat || content.length < 30) continue;

      // 1. Extract facts (TUNE-003: confidence varies by extraction pattern type)
      const factCandidates = extractFactCandidates(content);
      for (const { content: factContent, confidence: factConfidence } of factCandidates) {
        try {
          const factDomain = domainForAgent(agentId);
          // 1. Detect contradictions BEFORE addFact (operates on existing facts only)
          const contradictionResult = await contradictionDetector.detectOnIngest(agentId, {
            content: factContent,
            domain: factDomain,
          });
          const topContradictions = contradictionResult.contradictions.slice(0, 3);

          // 2. addFact first — we need fact.id for supersede linkage
          const fact = factStore.addFact(agentId, factContent, {
            scope: 'agent',
            domain: factDomain,
            confidence: factConfidence,
            sourceType: 'indexer',
            sourceSessionKey: this.getSessionKeyForMessage(messageDb, msg.conversationId),
            sourceRef: `msg:${msg.id}`,
          });
          factsExtracted++;

          // 3. Apply contradiction policy for each candidate (now we have fact.id)
          for (const candidate of topContradictions) {
            const score = candidate.contradictionScore;
            let auditStatus = 'pending';

            if (score >= this.contradictionPolicy.autoSupersedeThreshold) {
              const didSupersede = factStore.markSuperseded(candidate.existingFactId, fact.id);
              if (didSupersede) {
                contradictionsAutoSuperseded++;
                // Immediately remove stale vector so it cannot surface in KNN recall
                if (this.vectorStore) {
                  this.vectorStore.removeItem('facts', candidate.existingFactId);
                }
              }
              auditStatus = 'auto-superseded';
            } else if (score >= this.contradictionPolicy.autoInvalidateThreshold) {
              const didInvalidate = factStore.invalidateFact(candidate.existingFactId);
              if (didInvalidate) {
                contradictionsAutoInvalidated++;
              }
              auditStatus = 'auto-invalidated';
            }

            if (this.contradictionPolicy.alwaysAudit || auditStatus === 'pending') {
              contradictionAuditStore.recordFactAudit(
                agentId,
                { content: factContent, domain: factDomain },
                candidate,
                { sourceRef: `msg:${msg.id}`, status: auditStatus }
              );
              contradictionAuditsLogged++;
            }
          }

          // ── Supersedes detection ─────────────────────────────────
          // Check if the newly extracted fact supersedes an existing one.
          // A supersede is detected when an existing active fact shares the
          // same 60-char prefix (same topic, different phrasing/update).
          if (fact.id) {
            // Index into temporal store (ingest_at as proxy, confidence=0.5)
            temporalStore.indexFact(fact.id, agentId, fact.createdAt);

            const oldFactId = factStore.findSupersedableByContent(agentId, factContent);
            if (oldFactId !== null && oldFactId !== fact.id) {
              const didSupersede = factStore.markSuperseded(oldFactId, fact.id);
              if (didSupersede) {
                supersededFacts++;
                // Immediately remove the stale vector so it can't surface in KNN recall
                if (this.vectorStore) {
                  this.vectorStore.removeItem('facts', oldFactId);
                }
              }
            }
          }

          // Embed new fact for semantic recall (best-effort, non-blocking)
          if (this.vectorStore && fact.id) {
            this.vectorStore.indexItem('facts', fact.id, factContent, fact.domain || undefined)
              .catch(() => { /* embedding failure is non-fatal */ });
          }
        } catch {
          // Duplicate or constraint violation — skip
        }
      }

      // 2. Classify episodes
      const episode = classifyEpisode(msg);
      if (episode && episode.significance >= this.config.episodeSignificanceThreshold) {
        // Secret gate: shared visibility requires clean content.
        // Downgrade to 'private' rather than drop, so we don't lose the episode.
        const episodeVisibility = isSafeForSharedVisibility(episode.summary) ? 'org' : 'private';
        try {
          const recorded = episodeStore.record(agentId, episode.type, episode.summary, {
            significance: episode.significance,
            visibility: episodeVisibility,
            sessionKey: this.getSessionKeyForMessage(messageDb, msg.conversationId),
            sourceMessageId: msg.id,
          });
          episodesRecorded++;
          // Embed episodes at sig>=0.5 (lowered from 0.7 — discovery/config_change events
          // at sig=0.5 are real operational events, not noise).
          if (this.vectorStore && recorded?.id && episode.significance >= 0.5) {
            this.vectorStore.indexItem('episodes', recorded.id, episode.summary, episode.type)
              .catch(() => { /* embedding failure is non-fatal */ });
          }
        } catch {
          // Skip duplicate episodes
        }
      }

      // 3. Detect and update topics
      const topicName = detectTopic(content);
      if (topicName && topicName.trim().length >= 3) {
        try {
          const msgSessionKey =
            this.getSessionKeyForMessage(messageDb, msg.conversationId) || '';
          // findOrCreate handles case-insensitive dedup at the schema level;
          // always touch afterward so message_count reflects real activity
          // rather than sitting at 0 forever (which made every topic an orphan).
          const topic = topicStore.findOrCreate(
            agentId,
            topicName,
            `Auto-detected from conversation`
          );
          topicStore.touch(topic.id, msgSessionKey, 1);
          topicsUpdated++;
        } catch {
          // Skip topic creation/touch errors
        }
      }

      // 4. Extract knowledge candidates
      const knowledgeCandidates = extractKnowledgeCandidates(content, agentId);
      for (const { domain, key, value } of knowledgeCandidates) {
        try {
          knowledgeStore.upsert(agentId, domain, key, value, {
            sourceType: 'indexer',
            sourceRef: `msg:${msg.id}`,
          });
          knowledgeUpserted++;
        } catch {
          // Skip duplicates
        }
      }
    }

    // Update watermark
    this.setWatermark(libraryDb, agentId, maxMessageId);

    // Run tombstone pass: remove vector entries for any facts marked superseded
    // (covers both the supersedes detected above and external markSuperseded calls).
    let tombstoned = 0;
    if (this.vectorStore) {
      tombstoned = this.vectorStore.tombstoneSuperseded();
    }

    return {
      agentId,
      messagesProcessed: messages.length,
      factsExtracted,
      episodesRecorded,
      topicsUpdated,
      knowledgeUpserted,
      tombstoned,
      contradictionAuditsLogged,
      contradictionsAutoSuperseded,
      contradictionsAutoInvalidated,
      postCursorMessages: postCursor.length,
      elapsedMs: Date.now() - start,
    };
  }

  /**
   * Fetch unindexed messages for an agent.
   */
  private getUnindexedMessages(
    db: DatabaseSync,
    agentId: string,
    afterId: number,
    limit: number
  ): StoredMessage[] {
    const rows = db.prepare(`
      SELECT m.*, c.session_key
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE m.agent_id = ? AND m.id > ?
      ORDER BY m.id ASC
      LIMIT ?
    `).all(agentId, afterId, limit) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      id: row.id as number,
      conversationId: row.conversation_id as number,
      agentId: row.agent_id as string,
      role: row.role as StoredMessage['role'],
      textContent: (row.text_content as string) || null,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : null,
      toolResults: row.tool_results ? JSON.parse(row.tool_results as string) : null,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
      messageIndex: row.message_index as number,
      tokenCount: (row.token_count as number) || null,
      isHeartbeat: (row.is_heartbeat as number) === 1,
      createdAt: row.created_at as string,
    }));
  }

  /**
   * Get the session key for a conversation ID.
   */
  private getSessionKeyForMessage(db: DatabaseSync, conversationId: number): string | undefined {
    const row = db.prepare('SELECT session_key FROM conversations WHERE id = ?').get(conversationId) as { session_key: string } | undefined;
    return row?.session_key;
  }

  /**
   * Get the indexing watermark for an agent.
   */
  private getWatermark(libraryDb: DatabaseSync, agentId: string): WatermarkState | null {
    // Ensure watermarks table exists
    libraryDb.prepare(`
      CREATE TABLE IF NOT EXISTS indexer_watermarks (
        agent_id TEXT PRIMARY KEY,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT NOT NULL
      )
    `).run();

    const row = libraryDb.prepare(
      'SELECT agent_id, last_message_id, last_run_at FROM indexer_watermarks WHERE agent_id = ?'
    ).get(agentId) as { agent_id: string; last_message_id: number; last_run_at: string } | undefined;

    if (!row) return null;
    return {
      agentId: row.agent_id,
      lastMessageId: row.last_message_id,
      lastRunAt: row.last_run_at,
    };
  }

  /**
   * Set the indexing watermark for an agent.
   */
  private setWatermark(libraryDb: DatabaseSync, agentId: string, lastMessageId: number): void {
    const now = new Date().toISOString();
    libraryDb.prepare(`
      INSERT INTO indexer_watermarks (agent_id, last_message_id, last_run_at)
      VALUES (?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        last_message_id = excluded.last_message_id,
        last_run_at = excluded.last_run_at
    `).run(agentId, lastMessageId, now);
  }

  /**
   * Apply time-based decay to facts.
   * Increases decay_score for older facts, making them less relevant.
   */
  private applyDecay(libraryDb: DatabaseSync): void {
    const rate = this.config.factDecayRate;

    // Decay facts that haven't been referenced recently
    libraryDb.prepare(`
      UPDATE facts
      SET decay_score = MIN(1.0, decay_score + ?)
      WHERE superseded_by IS NULL
        AND decay_score < 1.0
        AND updated_at < datetime('now', '-1 day')
    `).run(rate);

    // Decay episodes older than 7 days
    libraryDb.prepare(`
      UPDATE episodes
      SET decay_score = MIN(1.0, decay_score + ?)
      WHERE decay_score < 1.0
        AND created_at < datetime('now', '-7 days')
    `).run(rate * 0.5);

    // Mark dormant topics
    const dormantThreshold = this.parseDuration(this.config.topicDormantAfter);
    if (dormantThreshold > 0) {
      // Compute threshold timestamp in JS and pass as parameter — avoids SQL template interpolation.
      const dormantBefore = new Date(Date.now() - dormantThreshold * 1000).toISOString();
      libraryDb.prepare(`
        UPDATE topics
        SET status = 'dormant'
        WHERE status = 'active'
          AND updated_at < ?
      `).run(dormantBefore);
    }

    // Close old dormant topics
    const closedThreshold = this.parseDuration(this.config.topicClosedAfter);
    if (closedThreshold > 0) {
      const closedBefore = new Date(Date.now() - closedThreshold * 1000).toISOString();
      libraryDb.prepare(`
        UPDATE topics
        SET status = 'closed'
        WHERE status = 'dormant'
          AND updated_at < ?
      `).run(closedBefore);
    }
  }

  /**
   * Parse a duration string like "24h", "7d" into seconds.
   */
  private parseDuration(dur: string): number {
    const match = dur.match(/^(\d+)\s*(h|d|m|s)$/);
    if (!match) return 0;
    const val = parseInt(match[1]);
    switch (match[2]) {
      case 's': return val;
      case 'm': return val * 60;
      case 'h': return val * 3600;
      case 'd': return val * 86400;
      default: return 0;
    }
  }

  /**
   * One-time backfill: embed episodes with sig>=0.5 that were missed by the
   * old >=0.7 vectorization threshold.
   *
   * Gated by a system_state flag 'indexer:episode_backfill_v1' so it runs
   * exactly once even across gateway restarts. Safe to re-run manually
   * (delete the flag row first) if re-backfill is ever needed.
   */
  async backfillEpisodeVectors(): Promise<void> {
    if (!this.vectorStore || !this.getLibraryDb) return;

    const libraryDb = this.getLibraryDb();
    const BACKFILL_FLAG = 'episode_backfill_v1';

    // Ensure system_state table exists (schema may not have been applied yet)
    try {
      libraryDb.prepare(`
        CREATE TABLE IF NOT EXISTS system_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          updated_at TEXT NOT NULL,
          updated_by TEXT,
          ttl TEXT,
          UNIQUE(category, key)
        )
      `).run();
    } catch {
      // Table already exists — safe to ignore
    }

    // Check if backfill already completed
    const existing = libraryDb.prepare(
      "SELECT value FROM system_state WHERE category = 'indexer' AND key = ?"
    ).get(BACKFILL_FLAG) as { value: string } | undefined;

    if (existing) {
      // Already done
      return;
    }

    console.log('[indexer] Starting episode vector backfill (sig>=0.5, not yet vectorized)...');

    // Find episodes with sig>=0.5 that have no vec_index_map entry.
    // We join against vec_index_map using a fallback: if the table is in a
    // separate DB (vectors.db), we query it directly via the VectorStore.
    let episodes: Array<{ id: number; summary: string; event_type: string }>;
    try {
      episodes = libraryDb.prepare(`
        SELECT id, summary, event_type
        FROM episodes
        WHERE significance >= 0.5
        ORDER BY created_at DESC
      `).all() as Array<{ id: number; summary: string; event_type: string }>;
    } catch {
      console.warn('[indexer] Backfill: could not query episodes table');
      return;
    }

    let queued = 0;
    let skipped = 0;

    for (const ep of episodes) {
      // Check if already vectorized
      if (this.vectorStore.hasItem('episodes', ep.id)) {
        skipped++;
        continue;
      }
      try {
        await this.vectorStore.indexItem('episodes', ep.id, ep.summary, ep.event_type);
        queued++;
      } catch {
        // Non-fatal — keep going
      }
    }

    // Mark backfill complete
    const now = new Date().toISOString();
    libraryDb.prepare(`
      INSERT INTO system_state (category, key, value, updated_at, updated_by)
      VALUES ('indexer', ?, ?, ?, 'indexer')
      ON CONFLICT(category, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(BACKFILL_FLAG, JSON.stringify({ completedAt: now, queued, skipped }), now);

    console.log(`[indexer] Episode backfill complete: ${queued} queued, ${skipped} already vectorized`);
  }

  /**
   * Get current watermarks for all agents.
   */
  getWatermarks(libraryDb: DatabaseSync): WatermarkState[] {
    try {
      const rows = libraryDb.prepare(
        'SELECT agent_id, last_message_id, last_run_at FROM indexer_watermarks ORDER BY agent_id'
      ).all() as Array<{ agent_id: string; last_message_id: number; last_run_at: string }>;

      return rows.map(r => ({
        agentId: r.agent_id,
        lastMessageId: r.last_message_id,
        lastRunAt: r.last_run_at,
      }));
    } catch {
      return [];
    }
  }
}

// ─── Standalone runner ──────────────────────────────────────────

/**
 * Create and start a background indexer connected to hypermem databases.
 * Used by the hook or a standalone daemon.
 */
export function createIndexer(
  getMessageDb: (agentId: string) => DatabaseSync,
  getLibraryDb: () => DatabaseSync,
  listAgents: () => string[],
  config?: Partial<IndexerConfig>,
  getCursor?: CursorFetcher,
  vectorStore?: VectorStore,
  dreamerConfig?: Partial<DreamerConfig>,
  globalWritePolicy?: import('./types.js').GlobalWritePolicy,
): BackgroundIndexer {
  const indexer = new BackgroundIndexer(config, getMessageDb, getLibraryDb, listAgents, getCursor, dreamerConfig, globalWritePolicy);
  if (vectorStore) indexer.setVectorStore(vectorStore);
  return indexer;
}
