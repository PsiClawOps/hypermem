/**
 * hypermem Compositor
 *
 * Assembles context for LLM calls by orchestrating all four memory layers:
 *   L1 Redis    — hot session working memory (system, identity, recent msgs)
 *   L2 Messages — conversation history from messages.db
 *   L3 Vectors  — semantic search across all indexed content
 *   L4 Library  — structured knowledge (facts, preferences, knowledge, episodes)
 *
 * Token-budgeted: never exceeds the budget, prioritizes by configured order.
 * Provider-neutral internally, translates at the output boundary.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  ComposeRequest,
  ComposeResult,
  ComposeDiagnostics,
  SlotTokenCounts,
  NeutralMessage,
  ProviderMessage,
  StoredMessage,
  CompositorConfig,
  SessionMeta,
  SessionCursor,
} from './types.js';
import { filterByScope } from './retrieval-policy.js';
import {
  CollectionTrigger,
  DEFAULT_TRIGGERS,
  matchTriggers,
  logRegistryStartup,
  TRIGGER_REGISTRY_VERSION,
  TRIGGER_REGISTRY_HASH,
} from './trigger-registry.js';
import { CacheLayer } from './cache.js';
type AnyCache = CacheLayer;
import { MessageStore } from './message-store.js';
import { SessionTopicMap } from './session-topic-map.js';
import { toProviderFormat } from './provider-translator.js';
import { VectorStore, type VectorSearchResult } from './vector-store.js';
import { DocChunkStore } from './doc-chunk-store.js';
import { hybridSearch, type HybridSearchResult } from './hybrid-retrieval.js';
import { ensureCompactionFenceSchema, updateCompactionFence } from './compaction-fence.js';
import { rankKeystones, scoreKeystone, type KeystoneCandidate, type ScoredKeystone } from './keystone-scorer.js';
import { buildOrgRegistryFromDb, defaultOrgRegistry, type OrgRegistry } from './cross-agent.js';
import { getActiveFOS, matchMOD, renderFOS, renderMOD, renderLightFOS, resolveOutputTier, buildActionVerificationSummary } from './fos-mod.js';
import { KnowledgeStore } from './knowledge-store.js';
import { TemporalStore, hasTemporalSignals } from './temporal-store.js';
import { isOpenDomainQuery, searchOpenDomain } from './open-domain.js';

/**
 * Files that OpenClaw's contextInjection injects into the system prompt.
 * HyperMem must not re-inject these via doc chunk retrieval to avoid duplication.
 * Exported so plugin and other consumers can share the same dedup set.
 */
export const OPENCLAW_BOOTSTRAP_FILES = new Set([
  'SOUL.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md',
  'AGENTS.md', 'HEARTBEAT.md', 'MEMORY.md', 'BOOTSTRAP.md',
]);

/**
 * Model context window sizes by provider/model string (or partial match).
 * Used as fallback when tokenBudget is not passed by the runtime.
 * Order matters: first match wins. Partial substring match on the model string.
 */
const MODEL_CONTEXT_WINDOWS: Array<{ pattern: string; tokens: number }> = [
  // Anthropic
  { pattern: 'claude-opus-4',    tokens: 200_000 },
  { pattern: 'claude-sonnet-4',  tokens: 200_000 },
  { pattern: 'claude-3-5',       tokens: 200_000 },
  { pattern: 'claude-3-7',       tokens: 200_000 },
  { pattern: 'claude',           tokens: 200_000 },
  // OpenAI
  { pattern: 'gpt-5',            tokens: 128_000 },
  { pattern: 'gpt-4o',           tokens: 128_000 },
  { pattern: 'gpt-4',            tokens: 128_000 },
  { pattern: 'o3',               tokens: 128_000 },
  { pattern: 'o4',               tokens: 128_000 },
  // Google
  { pattern: 'gemini-3.1-pro',   tokens: 1_000_000 },
  { pattern: 'gemini-3.1-flash', tokens: 1_000_000 },
  { pattern: 'gemini-2.5-pro',   tokens: 1_000_000 },
  { pattern: 'gemini-2',        tokens: 1_000_000 },
  { pattern: 'gemini',           tokens: 1_000_000 },
  // Zhipu / GLM
  { pattern: 'glm-5',            tokens: 131_072 },
  { pattern: 'glm-4',            tokens: 131_072 },
  // Alibaba / Qwen
  { pattern: 'qwen3',            tokens: 262_144 },
  { pattern: 'qwen',             tokens: 131_072 },
  // DeepSeek
  { pattern: 'deepseek-v3',      tokens: 131_072 },
  { pattern: 'deepseek',         tokens: 131_072 },
];

/**
 * Resolve effective token budget from model string.
 * Returns the context window for the model, minus the configured reserve fraction
 * for output tokens and hypermem operational overhead.
 * Default reserve: 25% (leaves 75% for input context).
 * Falls back to defaultTokenBudget if no model match.
 */
/**
 * Resolve effective input token budget for a model.
 *
 * Priority:
 * 1. If budgetFraction is set AND model window is detected: window × budgetFraction × (1 - reserve)
 * 2. If model window detected but no budgetFraction: window × (1 - reserve)
 * 3. Fallback to defaultTokenBudget (absolute number)
 */
function resolveModelBudget(
  model: string | undefined,
  defaultBudget: number,
  reserve = 0.15,
  budgetFraction?: number,
): number {
  const window = resolveModelWindow(model, defaultBudget);
  // If we detected an actual model window (not the fallback derivation)
  if (model && budgetFraction != null) {
    const normalized = model.toLowerCase();
    for (const entry of MODEL_CONTEXT_WINDOWS) {
      if (normalized.includes(entry.pattern)) {
        return Math.floor(entry.tokens * budgetFraction * (1 - reserve));
      }
    }
  }
  // Original path: detected window × (1 - reserve), or absolute fallback
  if (!model) return defaultBudget;
  const normalized = model.toLowerCase();
  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (normalized.includes(entry.pattern)) {
      return Math.floor(entry.tokens * (1 - reserve));
    }
  }
  return defaultBudget;
}

/**
 * Resolve the raw context window size for a model (no reserve applied).
 * Used as totalWindow for dynamic reserve calculation.
 * Falls back to defaultBudget / 0.85 (reverse of 15% reserve default) if no match.
 */
function resolveModelWindow(model: string | undefined, defaultBudget: number): number {
  if (!model) return Math.floor(defaultBudget / 0.85);
  const normalized = model.toLowerCase();
  for (const entry of MODEL_CONTEXT_WINDOWS) {
    if (normalized.includes(entry.pattern)) {
      return entry.tokens;
    }
  }
  return Math.floor(defaultBudget / 0.85);
}

/**
 * Compute dynamic context window reserve based on recent turn cost.
 *
 * Reserve = clamp(avg_turn_cost × horizon / totalWindow, base, max)
 *
 * Returns the reserve fraction and diagnostics. When dynamic reserve
 * is clamped at max, sessionPressureHigh is set true so callers can
 * emit a warning or trigger checkpointing.
 */
function computeDynamicReserve(
  recentMessages: NeutralMessage[],
  totalWindow: number,
  config: CompositorConfig,
): { reserve: number; avgTurnCost: number; dynamic: boolean; pressureHigh: boolean } {
  const base = config.reserveFraction ?? config.contextWindowReserve ?? 0.25;
  const horizon = config.dynamicReserveTurnHorizon ?? 5;
  const max = config.dynamicReserveMax ?? 0.50;
  const enabled = config.dynamicReserveEnabled ?? true;

  if (!enabled || recentMessages.length === 0 || totalWindow <= 0) {
    return { reserve: base, avgTurnCost: 0, dynamic: false, pressureHigh: false };
  }

  // Sample the last 20 user+assistant messages for turn cost estimation.
  // Tool messages are excluded — they're already compressed by the gradient
  // and don't represent per-turn user intent cost.
  const sample = recentMessages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-20);

  if (sample.length === 0) {
    return { reserve: base, avgTurnCost: 0, dynamic: false, pressureHigh: false };
  }

  const totalCost = sample.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const avgTurnCost = Math.floor(totalCost / sample.length);
  const safetyTokens = avgTurnCost * horizon;
  const dynamicFrac = safetyTokens / totalWindow;

  if (dynamicFrac <= base) {
    return { reserve: base, avgTurnCost, dynamic: false, pressureHigh: false };
  }

  if (dynamicFrac >= max) {
    return { reserve: max, avgTurnCost, dynamic: true, pressureHigh: true };
  }

  return { reserve: dynamicFrac, avgTurnCost, dynamic: true, pressureHigh: false };
}

const DEFAULT_CONFIG: CompositorConfig = {
  // Primary budget controls
  budgetFraction: 0.703,
  reserveFraction: 0.25,
  historyFraction: 0.40,
  memoryFraction: 0.40,
  // Absolute fallback
  defaultTokenBudget: 90000,
  // History internals
  maxHistoryMessages: 250,
  warmHistoryBudgetFraction: 0.4,
  keystoneHistoryFraction: 0.2,
  keystoneMaxMessages: 15,
  keystoneMinSignificance: 0.5,
  // Memory internals
  maxFacts: 28,
  maxCrossSessionContext: 6000,
  // Tool gradient (internal)
  maxRecentToolPairs: 3,
  maxProseToolPairs: 10,
  // Dynamic reserve
  dynamicReserveTurnHorizon: 5,
  dynamicReserveMax: 0.50,
  dynamicReserveEnabled: true,
};

// Tool gradient thresholds — controls how aggressively tool results are
// truncated as they age out of the recent window.
// Recent-turn policy (2026-04-07): protect turn 0 + turn 1, budget against a
// conservative 120k planning window, and only head+tail trim large (>40k)
// recent results when projected occupancy crosses the orange zone.
const TOOL_GRADIENT_T0_TURNS = 2;   // current + 2 prior completed turns: full fidelity (matches OpenClaw keepLastAssistants: 3)
const TOOL_GRADIENT_T1_TURNS = 4;   // turns 2-4: moderate truncation (was 3)
const TOOL_GRADIENT_T2_TURNS = 7;   // turns 4-7: aggressive truncation (was 12)
// T3 = turns 8+: one-liner stub
const TOOL_GRADIENT_T1_CHAR_CAP = 6_000;   // per-message cap (was 8k)
const TOOL_GRADIENT_T1_TURN_CAP = 12_000;  // per-turn-pair cap (was 16k)
const TOOL_GRADIENT_T2_CHAR_CAP = 800;     // per-message cap (was 1k)
const TOOL_GRADIENT_T2_TURN_CAP = 3_000;   // per-turn-pair cap (was 4k)
const TOOL_GRADIENT_T3_CHAR_CAP = 150;     // oldest tier: stub only (was 200)
const TOOL_GRADIENT_T3_TURN_CAP = 800;     // per-turn-pair cap (was 1k)
const TOOL_GRADIENT_MAX_TAIL_CHARS = 3_000; // tail preserve budget for T1+
const TOOL_GRADIENT_MIDDLE_MARKER = '\n[... tool output truncated ...]\n';
const TOOL_PLANNING_BASELINE_WINDOW = 120_000;
const TOOL_PLANNING_MIN_RESERVE_TOKENS = 24_000;
const TOOL_PRESSURE_YELLOW = 0.75;
const TOOL_PRESSURE_ORANGE = 0.80;
const TOOL_PRESSURE_RED = 0.85;
const TOOL_RECENT_OVERSIZE_CHAR_THRESHOLD = 40_000;
const TOOL_RECENT_OVERSIZE_TARGET_CHARS = 40_000;
const TOOL_RECENT_OVERSIZE_MAX_TAIL_CHARS = 12_000;
const TOOL_TRIM_NOTE_PREFIX = '[hypermem_tool_result_trim';

// ─── Trigger Registry ────────────────────────────────────────────
// Moved to src/trigger-registry.ts (W5).
// CollectionTrigger, DEFAULT_TRIGGERS, matchTriggers imported above.
// Re-exported below for backward compatibility with existing consumers.
export { CollectionTrigger, DEFAULT_TRIGGERS, matchTriggers } from './trigger-registry.js';

// ─── Test-only exports (not part of public API) ───────────────────────────
// These are exported solely for unit testing. Do not use in production code.
export { getTurnAge, applyToolGradient, appendToolSummary, truncateWithHeadTail, applyTierPayloadCap, evictLargeToolResults };


interface NeutralMessageCluster<T extends NeutralMessage> {
  messages: T[];
  tokenCost: number;
}

function clusterNeutralMessages<T extends NeutralMessage>(messages: T[]): NeutralMessageCluster<T>[] {
  const clusters: NeutralMessageCluster<T>[] = [];

  for (let i = 0; i < messages.length; i++) {
    const current = messages[i];
    const cluster: T[] = [current];

    if (current.toolCalls && current.toolCalls.length > 0) {
      const callIds = new Set(current.toolCalls.map(tc => tc.id).filter(Boolean));
      let j = i + 1;
      while (j < messages.length) {
        const candidate = messages[j];
        if (!candidate.toolResults || candidate.toolResults.length === 0) break;
        const resultIds = candidate.toolResults.map(tr => tr.callId).filter(Boolean);
        if (callIds.size > 0 && resultIds.length > 0 && !resultIds.some(id => callIds.has(id))) break;
        cluster.push(candidate);
        j++;
      }
      i = j - 1;
    } else if (current.toolResults && current.toolResults.length > 0) {
      let j = i + 1;
      while (j < messages.length) {
        const candidate = messages[j];
        if (!candidate.toolResults || candidate.toolResults.length === 0 || (candidate.toolCalls && candidate.toolCalls.length > 0)) break;
        cluster.push(candidate);
        j++;
      }
      i = j - 1;
    }

    clusters.push({
      messages: cluster,
      tokenCost: cluster.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0),
    });
  }

  return clusters;
}


/**
 * Public reshape helper: apply tool gradient then trim to fit within a token budget.
 *
 * Used by the plugin's budget-downshift pass to pre-process a Redis history window
 * after a model switch to a smaller context window, before the full compose pipeline
 * runs. Trims from oldest to newest until estimated token cost fits within
 * tokenBudget * 0.65 (using the standard char/4 heuristic).
 *
 * @param messages     NeutralMessage array from the Redis hot window
 * @param tokenBudget  Effective token budget for this session
 * @returns            Trimmed message array ready for setWindow()
 */
export function applyToolGradientToWindow(
  messages: NeutralMessage[],
  tokenBudget: number,
  totalWindowTokens?: number,
): NeutralMessage[] {
  const reshaped = applyToolGradient(messages, { totalWindowTokens });
  const targetTokens = Math.floor(tokenBudget * 0.65);
  const clusters = clusterNeutralMessages(reshaped);
  let totalTokens = clusters.reduce((sum, cluster) => sum + cluster.tokenCost, 0);
  let start = 0;
  // walk oldest to newest, drop until we fit
  while (totalTokens > targetTokens && start < clusters.length - 1) {
    totalTokens -= clusters[start].tokenCost;
    start++;
  }
  return clusters.slice(start).flatMap(cluster => cluster.messages);
}

/**
 * Canonical history must remain lossless for tool turns.
 *
 * If a window contains any structured tool calls or tool results, the caller
 * should treat applyToolGradientToWindow() as a view-only transform for the
 * current compose pass and avoid writing the reshaped messages back into the
 * canonical cache/history store.
 */
export function canPersistReshapedHistory(messages: NeutralMessage[]): boolean {
  return !messages.some(msg => hasToolContent(msg));
}

/**
 * Rough token estimation: ~4 chars per token for English text.
 * This is a heuristic — actual tokenization varies by model.
 * Good enough for budget management; exact count comes from the provider.
 */
function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Dense token estimation for tool content (JSON, code, base64).
 * Tool payloads are typically 2x denser than English prose.
 */
function estimateToolTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

function estimateMessageTokens(msg: NeutralMessage): number {
  let tokens = estimateTokens(msg.textContent);
  if (msg.toolCalls) {
    tokens += estimateToolTokens(JSON.stringify(msg.toolCalls)); // dense: /2 not /4
  }
  if (msg.toolResults) {
    tokens += estimateToolTokens(JSON.stringify(msg.toolResults)); // dense: /2 not /4
  }
  // Overhead per message (role, formatting)
  tokens += 4;
  return tokens;
}

function parseToolArgs(argumentsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toolLabelFromCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'read':
      return `read ${(args.path ?? args.file_path ?? args.filePath ?? 'file') as string}`;
    case 'write':
      return `write ${(args.path ?? args.file ?? args.filePath ?? 'file') as string}`;
    case 'edit':
      return `edit ${(args.path ?? args.file ?? args.filePath ?? 'file') as string}`;
    case 'exec':
      return `exec ${String(args.command ?? '').slice(0, 80) || 'command'}`;
    case 'web_search':
      return `web_search ${String(args.query ?? '').slice(0, 80) || 'query'}`;
    case 'web_fetch':
      return `web_fetch ${String(args.url ?? '').slice(0, 80) || 'url'}`;
    case 'sessions_send':
      return `sessions_send ${String(args.sessionKey ?? args.label ?? '').slice(0, 80) || 'target'}`;
    case 'memory_search':
      return `memory_search ${String(args.query ?? '').slice(0, 80) || 'query'}`;
    default:
      return name;
  }
}

/**
 * Strip OpenClaw's external-content security wrapper from tool results before truncation.
 * web_fetch results are wrapped in <<<BEGIN_EXTERNAL_UNTRUSTED_CONTENT ... >>> blocks.
 * That preamble consumes the entire head budget in truncateWithHeadTail, leaving only
 * the security notice + last sentence visible — the actual body becomes the middle marker.
 * Strip the wrapper first so truncation operates on the real content.
 */
function stripSecurityPreamble(content: string): string {
  // Match: <<<BEGIN_EXTERNAL_UNTRUSTED_CONTENT id="...">\n...\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="...">>>
  // Strip opening tag line and closing tag line; keep the content between.
  const stripped = content.replace(
    /^[\s\S]*?<<<BEGIN_EXTERNAL_UNTRUSTED_CONTENT[^\n]*>>>?\n?/,
    ''
  ).replace(
    /\n?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^\n]*>>>?[\s\S]*$/,
    ''
  );
  // If stripping removed everything or nearly everything, return original.
  return stripped.trim().length > 20 ? stripped.trim() : content;
}

// Minimum floor: if trimming would leave less than 30% of original content, return a
// stripped dave instead of a misleading fragment. A partial result that looks
// complete is worse than a clear signal that the result was dropped.
// Applied only in applyTierPayloadCap (pressure-driven trimming), not in structural
// truncation paths where head+tail is always semantically useful.
const TOOL_GRADIENT_MIN_USEFUL_FRACTION = 0.30;

function truncateWithHeadTail(content: string, maxChars: number, maxTailChars = TOOL_GRADIENT_MAX_TAIL_CHARS): string {
  if (content.length <= maxChars) return content;
  const tailBudget = Math.min(Math.floor(maxChars * 0.30), maxTailChars);
  const headBudget = Math.max(0, maxChars - tailBudget - TOOL_GRADIENT_MIDDLE_MARKER.length);
  return content.slice(0, headBudget) + TOOL_GRADIENT_MIDDLE_MARKER + content.slice(-tailBudget);
}

function truncateHead(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = '…';
  const keep = Math.max(0, maxChars - marker.length);
  return content.slice(0, keep) + marker;
}

function firstNonEmptyLine(content: string): string {
  const line = content.split('\n').find(l => l.trim().length > 0) ?? '';
  return line.trim();
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hostFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
}

function extractTopHeading(content: string): string {
  const heading = content.split('\n').find(line => /^#{1,3}\s+/.test(line.trim()));
  return heading ? heading.replace(/^#{1,3}\s+/, '').trim() : '';
}

function extractExitCode(content: string): string | null {
  const match = content.match(/(?:exit code|exit|code)\s*[:=]?\s*(\d+)/i);
  return match ? match[1] : null;
}

function estimateSearchResultCount(content: string): number | null {
  const jsonMatch = content.match(/"results"\s*:\s*\[/);
  if (jsonMatch) {
    const titles = content.match(/"title"\s*:/g);
    if (titles?.length) return titles.length;
  }
  const resultLines = content.match(/\bSource:\b|\bsiteName\b|\btitle\b/gi);
  return resultLines?.length ? Math.min(resultLines.length, 20) : null;
}

function summarizeOutcome(label: string, content: string, maxChars: number): string {
  const firstLine = firstNonEmptyLine(content);
  const base = firstLine ? `${label} — ${firstLine}` : `${label} — ${content.length} chars`;
  return truncateHead(base, maxChars);
}

function summarizeToolInteraction(name: string, args: Record<string, unknown>, content: string, maxChars: number, compact = false): string {
  const line = normalizeInline(firstNonEmptyLine(content));
  switch (name) {
    case 'read': {
      const path = String(args.path ?? args.file_path ?? args.filePath ?? 'file');
      const heading = extractTopHeading(content);
      const detail = heading || line || `${content.length} chars`;
      return truncateHead(`Read ${path} — ${detail}`, maxChars);
    }
    case 'exec': {
      const cmd = String(args.command ?? 'command').slice(0, compact ? 40 : 80);
      const exitCode = extractExitCode(content);
      const status = exitCode ? `exit ${exitCode}` : (/(error|failed|timeout|timed out)/i.test(content) ? 'failed' : 'completed');
      const detail = line && !/^exit\s+\d+$/i.test(line) ? `, ${line}` : '';
      return truncateHead(`Ran ${cmd} — ${status}${detail}`, maxChars);
    }
    case 'web_search': {
      const query = String(args.query ?? 'query').slice(0, compact ? 40 : 80);
      const count = estimateSearchResultCount(content);
      const heading = extractTopHeading(content);
      const detail = heading || line;
      const countText = count ? ` — ${count} results` : '';
      const summary = compact
        ? `Searched '${query}'${countText}`
        : `Searched '${query}'${countText}${detail ? `, top: ${detail}` : ''}`;
      return truncateHead(summary, maxChars);
    }
    case 'web_fetch': {
      const url = String(args.url ?? 'url');
      const host = hostFromUrl(url);
      const heading = extractTopHeading(content);
      const detail = heading || line || `${content.length} chars`;
      return truncateHead(`Fetched ${host} — ${detail}`, maxChars);
    }
    case 'memory_search': {
      const query = String(args.query ?? 'query').slice(0, compact ? 40 : 80);
      const count = estimateSearchResultCount(content);
      return truncateHead(`Searched memory for '${query}'${count ? ` — ${count} hits` : ''}${line ? `, top: ${line}` : ''}`, maxChars);
    }
    default: {
      const label = toolLabelFromCall(name, args);
      return compact
        ? truncateHead(`${label} — ${line || `${content.length} chars`}`, maxChars)
        : (() => {
            const prefix = `[${label}] `;
            const available = Math.max(40, maxChars - prefix.length);
            return prefix + truncateWithHeadTail(content, available);
          })();
    }
  }
}

function buildTier2Envelope(label: string, content: string, maxChars: number, name?: string, args?: Record<string, unknown>): string {
  if (name && args) return summarizeToolInteraction(name, args, content, maxChars, false);
  const prefix = `[${label}] `;
  const available = Math.max(40, maxChars - prefix.length);
  return prefix + truncateWithHeadTail(content, available);
}

function buildTier3Envelope(label: string, content: string, maxChars: number, name?: string, args?: Record<string, unknown>): string {
  if (name && args) return `[${summarizeToolInteraction(name, args, content, maxChars - 2, true)}]`;
  return `[${summarizeOutcome(label, content, maxChars - 2)}]`;
}

/**
 * Extract a heuristic prose summary from a tool call/result pair.
 * Used when tool payloads are removed but continuity should remain.
 */
function extractToolProseSummary(msg: NeutralMessage, perResultCap: number, compact: boolean = false): string {
  const parts: string[] = [];

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      const args = parseToolArgs(tc.arguments);
      const label = toolLabelFromCall(tc.name, args);
      const resultContent = msg.toolResults?.find(r => r.callId === tc.id)?.content ?? '';
      if (resultContent) {
        parts.push(compact
          ? buildTier3Envelope(label, resultContent, perResultCap, tc.name, args)
          : buildTier2Envelope(label, resultContent, perResultCap, tc.name, args));
      } else {
        parts.push(compact ? `[${truncateHead(label, perResultCap - 2)}]` : label);
      }
    }
  } else if (msg.toolResults && msg.toolResults.length > 0) {
    for (const tr of msg.toolResults) {
      const label = tr.name || 'tool_result';
      const args: Record<string, unknown> = {};
      parts.push(compact
        ? buildTier3Envelope(label, tr.content ?? '', perResultCap, tr.name || 'tool_result', args)
        : buildTier2Envelope(label, tr.content ?? '', perResultCap, tr.name || 'tool_result', args));
    }
  }

  return truncateHead(parts.join('; '), Math.max(perResultCap, 120));
}

function appendToolSummary(textContent: string | null, summary: string): string {
  const existing = textContent ?? '';
  if (!summary) return existing;
  return existing ? `${existing}\n[Tools: ${summary}]` : summary;
}

function getTurnAge(messages: NeutralMessage[], index: number): number {
  let turnAge = 0;
  for (let i = messages.length - 1; i > index; i--) {
    const candidate = messages[i];
    if (candidate?.role === 'user' && (!candidate.toolResults || candidate.toolResults.length === 0)) {
      turnAge++;
    }
  }
  return turnAge;
}

function hasToolContent(msg: NeutralMessage): boolean {
  return Boolean((msg.toolCalls && msg.toolCalls.length > 0) || (msg.toolResults && msg.toolResults.length > 0));
}

type ToolPressureZone = 'green' | 'yellow' | 'orange' | 'red';

interface ToolPressureState {
  planningWindowTokens: number;
  reserveTokens: number;
  projectedTokens: number;
  occupancy: number;
  zone: ToolPressureZone;
}

function resolveToolPlanningWindow(totalWindowTokens?: number): number {
  const actualWindow = totalWindowTokens && totalWindowTokens > 0
    ? totalWindowTokens
    : TOOL_PLANNING_BASELINE_WINDOW;
  return Math.min(actualWindow, TOOL_PLANNING_BASELINE_WINDOW);
}

function computeToolPressureState(messages: NeutralMessage[], totalWindowTokens?: number): ToolPressureState {
  const planningWindowTokens = resolveToolPlanningWindow(totalWindowTokens);
  const reserveTokens = Math.max(
    TOOL_PLANNING_MIN_RESERVE_TOKENS,
    Math.floor(planningWindowTokens * 0.10),
  );
  const usedTokens = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
  const projectedTokens = usedTokens + reserveTokens;
  const occupancy = planningWindowTokens > 0 ? projectedTokens / planningWindowTokens : 1;

  let zone: ToolPressureZone = 'green';
  if (occupancy > TOOL_PRESSURE_RED) zone = 'red';
  else if (occupancy > TOOL_PRESSURE_ORANGE) zone = 'orange';
  else if (occupancy > TOOL_PRESSURE_YELLOW) zone = 'yellow';

  return {
    planningWindowTokens,
    reserveTokens,
    projectedTokens,
    occupancy,
    zone,
  };
}

function isStructuredTrimNote(content: string): boolean {
  return content.startsWith(TOOL_TRIM_NOTE_PREFIX);
}

function buildRecentTrimNote(
  originalChars: number,
  keptHeadChars: number,
  keptTailChars: number,
  pressure: ToolPressureState,
  resultId?: string,
): string {
  const parts = [
    TOOL_TRIM_NOTE_PREFIX,
    'partial_result=true',
    'reason=oversize_turn0_trim',
    `original_chars=${originalChars}`,
    `kept_head_chars=${keptHeadChars}`,
    `kept_tail_chars=${keptTailChars}`,
    `projected_occupancy_pct=${Math.round(pressure.occupancy * 100)}`,
    `planning_window_tokens=${pressure.planningWindowTokens}`,
    `reserve_tokens=${pressure.reserveTokens}`,
    'retry_recommended=true',
  ];
  if (resultId) parts.push(`result_id=${resultId}`);
  parts.push(']');
  return parts.join(' ');
}

function countHeadTailChars(content: string): { headChars: number; tailChars: number } {
  const markerIdx = content.indexOf(TOOL_GRADIENT_MIDDLE_MARKER);
  if (markerIdx === -1) {
    return { headChars: content.length, tailChars: 0 };
  }
  return {
    headChars: markerIdx,
    tailChars: content.length - markerIdx - TOOL_GRADIENT_MIDDLE_MARKER.length,
  };
}

function trimRecentToolResult(
  content: string,
  pressure: ToolPressureState,
  resultId?: string,
): string {
  if (isStructuredTrimNote(content)) return content;

  const stripped = stripSecurityPreamble(content);
  const baseOriginal = stripped.length > 0 ? stripped : content;
  const noteSkeleton = buildRecentTrimNote(baseOriginal.length, 0, 0, pressure, resultId);
  const availableChars = Math.max(
    2_000,
    TOOL_RECENT_OVERSIZE_TARGET_CHARS - noteSkeleton.length - 1,
  );
  const truncated = truncateWithHeadTail(baseOriginal, availableChars, TOOL_RECENT_OVERSIZE_MAX_TAIL_CHARS);
  const { headChars, tailChars } = countHeadTailChars(truncated);
  const note = buildRecentTrimNote(baseOriginal.length, headChars, tailChars, pressure, resultId);
  return `${note}
${truncated}`;
}

function protectRecentToolContent<T extends NeutralMessage>(msg: T, pressure: ToolPressureState): T {
  if (!msg.toolResults || msg.toolResults.length === 0) return msg;

  const shouldEmergencyTrim = pressure.zone === 'orange' || pressure.zone === 'red';
  const toolResults = msg.toolResults.map(result => {
    const content = result.content ?? '';
    if (!content) return result;
    if (!shouldEmergencyTrim) return result;
    if (content.length <= TOOL_RECENT_OVERSIZE_CHAR_THRESHOLD) return result;
    return {
      ...result,
      content: trimRecentToolResult(content, pressure, result.callId || result.name || undefined),
    };
  });

  return { ...msg, toolResults } as T;
}

function applyTierPayloadCap(msg: NeutralMessage, perResultCap: number, perTurnCap?: number, usedSoFar: number = 0, maxTailChars = TOOL_GRADIENT_MAX_TAIL_CHARS): { msg: NeutralMessage; usedChars: number } {
  const toolResults = msg.toolResults?.map(result => {
    let content = result.content ?? '';
    if (content.length > perResultCap) {
      // Strip security preamble before truncation so it doesn't consume the head budget.
      // web_fetch results wrapped in <<<EXTERNAL_UNTRUSTED_CONTENT>>> blocks would otherwise
      // render the truncated result as: [security notice] + [middle marker] + [last line].
      const stripped = stripSecurityPreamble(content);
      // Floor check (TUNE-015): if the cap would leave less than 30% of the stripped content
      // AND less than 2000 chars absolute, return a dave instead of a misleading fragment.
      // Partial results that look complete are worse than a clear dropped-result signal.
      // The absolute floor prevents the dave from firing on large natural truncations
      // (e.g., 110k → 16k is a meaningful slice, not a misleading fragment).
      if (perResultCap < stripped.length * TOOL_GRADIENT_MIN_USEFUL_FRACTION && perResultCap < 2_000) {
        content = `[result too large for current context budget \u2014 ${stripped.length} chars stripped]`;
      } else {
        // Reserve space for the \n[trimmed] marker within the cap so the total
        // content length stays within perResultCap and doesn't overflow the
        // per-turn aggregate cap when multiple results are truncated.
        const TRIMMED_MARKER = '\n[trimmed]';
        content = truncateWithHeadTail(stripped, perResultCap - TRIMMED_MARKER.length, maxTailChars) + TRIMMED_MARKER;
      }
    }
    return { ...result, content };
  }) ?? null;

  let usedChars = usedSoFar + (toolResults?.reduce((sum, r) => sum + (r.content?.length ?? 0), 0) ?? 0);
  if (perTurnCap != null && usedChars > perTurnCap) {
    const downgradeSummary = extractToolProseSummary(msg, TOOL_GRADIENT_T2_CHAR_CAP, false);
    return {
      msg: {
        ...msg,
        textContent: appendToolSummary(msg.textContent, downgradeSummary),
        toolCalls: null,
        toolResults: null,
      },
      usedChars: usedSoFar + downgradeSummary.length,
    };
  }

  return {
    msg: { ...msg, toolResults },
    usedChars,
  };
}

/**
 * Evict tool results exceeding 800 tokens (~3200 chars) before the history
 * budget-fit loop. Large stale results waste budget; replace them with a
 * stub so consumers know the result existed and can re-run if needed.
 *
 * Applied to the already-gradient-processed history before window selection.
 * Does NOT affect turn 0 or turn 1.
 */
const TOOL_RESULT_EVICTION_CHAR_THRESHOLD = 3_200; // ~800 tokens at 4 chars/token

function evictLargeToolResults<T extends NeutralMessage>(messages: T[]): T[] {
  return messages.map((msg, idx) => {
    // Never evict from the protected recent-turn window.
    const turnAge = getTurnAge(messages, idx);
    if (turnAge <= TOOL_GRADIENT_T0_TURNS) return msg;
    if (!msg.toolResults || msg.toolResults.length === 0) return msg;

    const evicted = msg.toolResults.map(result => {
      const content = result.content ?? '';
      if (content.length <= TOOL_RESULT_EVICTION_CHAR_THRESHOLD) return result;
      const approxKTokens = Math.round(content.length / 4 / 1000);
      return {
        ...result,
        content: `[tool result evicted: ~${approxKTokens}k tokens \u2014 use memory_search or re-run if needed]`,
      };
    });
    return { ...msg, toolResults: evicted };
  }) as T[];
}

/**
 * Apply gradient tool treatment to a message array.
 *
 * Tiers are based on turn age, where turn age is the number of newer user
 * messages after the current message.
 */
function applyToolGradient<T extends NeutralMessage>(messages: T[], opts?: { totalWindowTokens?: number }): T[] {
  const result = [...messages] as T[];
  const pressure = computeToolPressureState(messages, opts?.totalWindowTokens);
  const perTurnUsage = new Map<number, { t0: number; t1: number; t2: number; t3: number }>();

  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i];
    if (!hasToolContent(msg)) continue;

    const turnAge = getTurnAge(result, i);
    const usage = perTurnUsage.get(turnAge) ?? { t0: 0, t1: 0, t2: 0, t3: 0 };

    if (turnAge <= TOOL_GRADIENT_T0_TURNS) {
      // T0/T1: preserve full recent tool results unless we hit the conservative
      // orange/red pressure zones and the payload itself is oversized (>40k).
      result[i] = protectRecentToolContent(msg, pressure) as T;
    } else if (turnAge <= TOOL_GRADIENT_T1_TURNS) {
      const capped = applyTierPayloadCap(msg, TOOL_GRADIENT_T1_CHAR_CAP, TOOL_GRADIENT_T1_TURN_CAP, usage.t1);
      usage.t1 = capped.usedChars;
      result[i] = capped.msg as T;
    } else if (turnAge <= TOOL_GRADIENT_T2_TURNS) {
      const summary = extractToolProseSummary(msg, TOOL_GRADIENT_T2_CHAR_CAP, false);
      const allowed = Math.max(0, TOOL_GRADIENT_T2_TURN_CAP - usage.t2);
      const boundedSummary = truncateHead(summary, Math.min(TOOL_GRADIENT_T2_CHAR_CAP, allowed || TOOL_GRADIENT_T3_CHAR_CAP));
      usage.t2 += boundedSummary.length;
      result[i] = {
        ...msg,
        textContent: appendToolSummary(msg.textContent, boundedSummary),
        toolCalls: null,
        toolResults: null,
      } as T;
    } else {
      const summary = extractToolProseSummary(msg, TOOL_GRADIENT_T3_CHAR_CAP, true);
      const allowed = Math.max(0, TOOL_GRADIENT_T3_TURN_CAP - usage.t3);
      const boundedSummary = truncateHead(summary, Math.min(TOOL_GRADIENT_T3_CHAR_CAP, allowed || TOOL_GRADIENT_T3_CHAR_CAP));
      usage.t3 += boundedSummary.length;
      result[i] = {
        ...msg,
        textContent: appendToolSummary(msg.textContent, boundedSummary),
        toolCalls: null,
        toolResults: null,
      } as T;
    }

    perTurnUsage.set(turnAge, usage);
  }

  return result;
}

export interface CompositorDeps {
  cache: AnyCache;
  vectorStore?: VectorStore | null;
  libraryDb?: DatabaseSync | null;
  /** Custom trigger registry; defaults to DEFAULT_TRIGGERS if not provided */
  triggerRegistry?: CollectionTrigger[];
}

/** Guard: logRegistryStartup() fires only once per process, not per instance. */
let _registryLogged = false;

export class Compositor {
  private readonly config: CompositorConfig;
  private readonly cache: AnyCache;
  private vectorStore: VectorStore | null;
  private readonly libraryDb: DatabaseSync | null;
  private readonly triggerRegistry: CollectionTrigger[];
  /** Cached org registry loaded from fleet_agents at construction time. */
  private _orgRegistry: OrgRegistry;

  constructor(
    deps: CompositorDeps,
    config?: Partial<CompositorConfig>
  ) {
    this.cache = deps.cache;
    this.vectorStore = deps.vectorStore || null;
    this.libraryDb = deps.libraryDb || null;
    this.triggerRegistry = deps.triggerRegistry || DEFAULT_TRIGGERS;
    // Load org registry from DB on init; fall back to hardcoded if DB empty.
    this._orgRegistry = this.libraryDb
      ? buildOrgRegistryFromDb(this.libraryDb)
      : defaultOrgRegistry();
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!_registryLogged) {
      logRegistryStartup();
      _registryLogged = true;
    }
  }

  /**
   * Set or replace the vector store after construction.
   * Called by hypermem.create() once sqlite-vec is confirmed available.
   */
  setVectorStore(vs: VectorStore): void {
    this.vectorStore = vs;
  }

  /**
   * Hot-reload the org registry from the fleet_agents table.
   * Call after fleet membership changes (new agent, org restructure)
   * to pick up the latest without a full restart.
   * Falls back to the current cached registry if the DB is unavailable.
   */
  refreshOrgRegistry(): OrgRegistry {
    if (this.libraryDb) {
      this._orgRegistry = buildOrgRegistryFromDb(this.libraryDb);
    }
    return this._orgRegistry;
  }

  /**
   * Return the currently cached org registry.
   */
  get orgRegistry(): OrgRegistry {
    return this._orgRegistry;
  }

  /**
   * Compose a complete message array for sending to an LLM.
   *
   * Orchestrates all four memory layers:
   *   1. System prompt + identity (never truncated)
   *   2. Conversation history (L1 Redis → L2 messages.db)
   *   3. Active facts from library (L4)
   *   4. Knowledge entries relevant to conversation (L4)
   *   5. User preferences (L4)
   *   6. Semantic recall via vector search (L3)
   *   7. Cross-session context (L2)
   *
   * Each slot respects the remaining token budget.
   */
  async compose(request: ComposeRequest, db: DatabaseSync, libraryDb?: DatabaseSync): Promise<ComposeResult> {
    const store = new MessageStore(db);
    const libDb = libraryDb || this.libraryDb;
    const toComposeOutputMessages = (inputMessages: NeutralMessage[]): ProviderMessage[] => {
      // When skipProviderTranslation is set, compose returns the neutral window
      // typed as ProviderMessage[] by contract. The runtime translates later.
      return request.skipProviderTranslation
        ? inputMessages as unknown as ProviderMessage[]
        : toProviderFormat(inputMessages, request.provider ?? request.model ?? null);
    };

    // ── C4: Window cache fast-exit ────────────────────────────
    // If nothing has changed since the last compose (cursor.lastSentId >= newest
    // message id in the DB), skip the full pipeline and return the cached window.
    // Particularly effective for low-frequency sessions (heartbeat agents, council
    // seats between rounds). TTL on the cache write remains 120s — this is a
    // conservative early-exit before the TTL expires, not a TTL extension.
    if (request.includeHistory !== false && request.skipWindowCache !== true) {
      try {
        const newestRow = db.prepare(
          'SELECT MAX(id) AS maxId FROM messages WHERE agent_id = ?'
        ).get(request.agentId) as { maxId: number | null } | undefined;
        const newestMsgId = newestRow?.maxId;
        if (newestMsgId != null) {
          const cachedBundle = await this.cache.getFreshWindowBundle(
            request.agentId, request.sessionKey, newestMsgId
          );
          if (cachedBundle) {
            const cachedSlots: SlotTokenCounts = {
              system: cachedBundle.meta.slots['system'] ?? 0,
              identity: cachedBundle.meta.slots['identity'] ?? 0,
              history: cachedBundle.meta.slots['history'] ?? 0,
              facts: cachedBundle.meta.slots['facts'] ?? 0,
              context: cachedBundle.meta.slots['context'] ?? 0,
              library: cachedBundle.meta.slots['library'] ?? 0,
            };
            return {
              messages: toComposeOutputMessages(cachedBundle.messages),
              tokenCount: cachedBundle.meta.totalTokens,
              slots: cachedSlots,
              truncated: false,
              hasWarnings: cachedBundle.meta.warnings.length > 0,
              warnings: cachedBundle.meta.warnings,
              diagnostics: {
                ...cachedBundle.meta.diagnostics,
                windowCacheHit: true,
              },
            };
          }
        }
      } catch {
        // Cache fast-exit is best-effort, fall through to full compose
      }
    }

    // Dynamic reserve: use a lightweight SQLite sample to estimate avg turn cost
    // BEFORE assembling the full context. This gives us the reserve fraction we
    // need to compute the effective token budget at the start of compose.
    // Full history assembly happens later in the pipeline.
    const totalWindow = resolveModelWindow(request.model, this.config.defaultTokenBudget);
    const sampleConv = store.getConversation(request.sessionKey);
    const sampleMessages: NeutralMessage[] = sampleConv
      ? (store.getRecentMessages(sampleConv.id, 40) as NeutralMessage[])
      : [];
    const { reserve: dynamicReserve, avgTurnCost, dynamic: isDynamic, pressureHigh } =
      computeDynamicReserve(sampleMessages, totalWindow, this.config);
    const budget = request.tokenBudget || resolveModelBudget(request.model, this.config.defaultTokenBudget, dynamicReserve, this.config.budgetFraction);
    let remaining = budget;
    const warnings: string[] = [];
    const slots: SlotTokenCounts = {
      system: 0,
      identity: 0,
      history: 0,
      facts: 0,
      context: 0,
      library: 0,
    };

    const messages: NeutralMessage[] = [];

    // ─── System Prompt (never truncated) ───────────────────────
    const systemContent = await this.getSlotContent(
      request.agentId,
      request.sessionKey,
      'system',
      db
    );

    if (systemContent) {
      const tokens = estimateTokens(systemContent);
      messages.push({
        role: 'system',
        textContent: systemContent,
        toolCalls: null,
        toolResults: null,
      });
      slots.system = tokens;
      remaining -= tokens;
    }

    // ─── Identity (never truncated) ────────────────────────────
    const identityContent = await this.getSlotContent(
      request.agentId,
      request.sessionKey,
      'identity',
      db
    );

    if (identityContent) {
      const tokens = estimateTokens(identityContent);
      messages.push({
        role: 'system',
        textContent: identityContent,
        toolCalls: null,
        toolResults: null,
      });
      slots.identity = tokens;
      remaining -= tokens;
    }

    // ─── Stable Output Profile Prefix ──────────────────────────
    // Keep deterministic output instructions on the static side of the cache
    // boundary so Anthropic and OpenAI warm-prefix caching can reuse them.
    if (remaining > 100 && request.includeLibrary !== false) {
      const fosEnabled = this.config?.enableFOS !== false;
      const modEnabled = this.config?.enableMOD !== false;
      const outputTier = resolveOutputTier(
        (this.config?.hyperformProfile ?? this.config?.outputProfile ?? this.config?.outputStandard) as any,
        fosEnabled,
        modEnabled
      );

      const stableOutputParts: string[] = [];

      if (outputTier.tier === 'light') {
        stableOutputParts.push(renderLightFOS().join('\n'));
      } else if (libDb) {
        if (outputTier.fos) {
          const fos = getActiveFOS(libDb);
          if (fos) {
            const fosContent = renderFOS(fos).join('\n');
            if (fosContent.trim()) stableOutputParts.push(fosContent);
          }
        }

        if (outputTier.mod) {
          const mod = matchMOD(request.model, libDb);
          if (mod) {
            const modContent = renderMOD(mod, null, request.model || '').join('\n');
            if (modContent.trim()) stableOutputParts.push(modContent);
          }
        }
      }

      if (stableOutputParts.length > 0) {
        const stableOutputContent = stableOutputParts.join('\n\n');
        const stableOutputTokens = estimateTokens(stableOutputContent);
        if (stableOutputTokens <= remaining) {
          messages.push({
            role: 'system',
            textContent: stableOutputContent,
            toolCalls: null,
            toolResults: null,
          });
          slots.system += stableOutputTokens;
          remaining -= stableOutputTokens;
        }
      }
    }

    // ─── Conversation History ──────────────────────────────────
    let diagCrossTopicKeystones = 0;
    // Hoisted: activeTopicId/name resolved inside history block, used for window dual-write (VS-1) and wiki page injection
    let composedActiveTopicId: string | undefined;
    let composedActiveTopicName: string | undefined;
    if (request.includeHistory !== false) {
      // P3.4: Look up the active topic for this session (non-fatal)
      let activeTopicId: string | undefined;
      let activeTopic: { id: string; name: string } | undefined;
      if (!request.topicId) {
        try {
          const topicMap = new SessionTopicMap(db);
          activeTopic = topicMap.getActiveTopic(request.sessionKey) || undefined;
          if (activeTopic) activeTopicId = activeTopic.id;
        } catch {
          // Topic lookup is best-effort — fall back to full history
        }
      } else {
        activeTopicId = request.topicId;
        try {
          activeTopic = db.prepare(`
            SELECT id, name
            FROM topics
            WHERE session_key = ? AND id = ?
            LIMIT 1
          `).get(request.sessionKey, request.topicId) as { id: string; name: string } | undefined;
        } catch {
          // Topic lookup is best-effort — fall back to ID-only history fetch
        }
      }
      // Hoist resolved topic id+name so the window dual-write and wiki injection sections can access them
      composedActiveTopicId = activeTopicId;
      composedActiveTopicName = activeTopic?.name;

      const rawHistoryMessages = await this.getHistory(
        request.agentId,
        request.sessionKey,
        request.historyDepth || this.config.maxHistoryMessages,
        store,
        activeTopicId
      );

      // Deduplicate history by StoredMessage.id (second line of defense after
      // pushHistory() tail-check dedup). Guards against any duplicates that
      // slipped through the warm path — e.g. bootstrap re-runs on existing sessions.
      const seenIds = new Set<number>();
      const historyMessages = rawHistoryMessages.filter(m => {
        const sm = m as import('./types.js').StoredMessage;
        if (sm.id != null) {
          if (seenIds.has(sm.id)) return false;
          seenIds.add(sm.id);
        }
        return true;
      });

      // ── Transform-first: apply gradient tool treatment BEFORE budget math ──
      // All tool payloads are in their final form before any token estimation.
      // This ensures estimateMessageTokens() measures actual submission cost,
      // not pre-transform cost (which caused overflow: dense tool JSON was
      // undercounted at length/4 when it should be measured post-stub).
      const transformedHistory = applyToolGradient(historyMessages, { totalWindowTokens: totalWindow });

      // ── Evict large tool results (>800 tokens) before window selection ─────
      // Replace oversized stale results with stubs so they don't burn budget.
      // Current-turn results (turn age 0) are never evicted.
      const evictedHistory = evictLargeToolResults(transformedHistory);

      // ── Budget-fit: walk newest→oldest, drop whole clusters ─────────────
      // Group tool_use + tool_result messages into clusters so they are kept
      // or dropped as a unit. Breaking mid-cluster creates orphaned tool
      // pairs that repairToolPairs has to strip downstream — wasting budget
      // and leaving gaps in conversation continuity.
      const budgetClusters = clusterNeutralMessages(evictedHistory);
      let historyTokens = 0;
      const includedClusters: NeutralMessageCluster<NeutralMessage>[] = [];

      // Pre-allocate history budget. historyFraction is a fraction of the
      // effective token budget (post-reserve). Falls back to unbounded fill
      // (remaining) when historyFraction is not set.
      const historyBudget = this.config.historyFraction != null
        ? Math.floor(budget * this.config.historyFraction)
        : remaining;
      const historyFillCap = Math.min(historyBudget, remaining);

      for (let i = budgetClusters.length - 1; i >= 0; i--) {
        const cluster = budgetClusters[i];
        if (historyTokens + cluster.tokenCost > historyFillCap && includedClusters.length > 0) {
          const droppedMsgCount = budgetClusters.slice(0, i + 1).reduce((s, c) => s + c.messages.length, 0);
          warnings.push(`History truncated at cluster ${i + 1}/${budgetClusters.length} (${droppedMsgCount} messages dropped)`);
          break;
        }
        includedClusters.unshift(cluster);
        historyTokens += cluster.tokenCost;
      }

      const includedHistory: NeutralMessage[] = includedClusters.flatMap(c => c.messages);

      // ── Keystone History Slot (P2.1) ──────────────────────────────────
      // For long conversations (≥30 messages), inject high-signal older messages
      // from before the recent window as recalled context. This lets the model
      // see key decisions and specs that happened earlier in the conversation
      // without them consuming the full recent history budget.
      const keystoneFraction = this.config.keystoneHistoryFraction ?? 0.2;
      const keystoneMaxMsgs = this.config.keystoneMaxMessages ?? 15;

      let keystoneMessages: NeutralMessage[] = [];
      let keystoneTokens = 0;

      if (request.includeKeystones !== false && includedHistory.length >= 30 && keystoneFraction > 0) {
        const keystoneResult = await this.buildKeystones(
          db,
          request.agentId,
          includedHistory,
          historyTokens,
          keystoneFraction,
          keystoneMaxMsgs,
          request.prompt,
          libDb || undefined
        );
        if (keystoneResult) {
          keystoneMessages = keystoneResult.keystoneMessages;
          keystoneTokens = keystoneResult.keystoneTokens;
          // Replace includedHistory and historyTokens with the trimmed versions
          // (keystoneResult reflects the trimming done inside buildKeystones)
          includedHistory.splice(0, includedHistory.length, ...keystoneResult.trimmedHistory);
          historyTokens = keystoneResult.trimmedHistoryTokens;
          warnings.push(`Keystone: injected ${keystoneMessages.length} recalled messages`);
        }
      }

      // ── Cross-Topic Keystones (P3.5) ──────────────────────────────────
      // Pull high-signal messages from OTHER topics in this session when their
      // content is semantically relevant to the current topic. Non-fatal.
      let crossTopicMessages: NeutralMessage[] = [];
      let crossTopicTokens = 0;

      if (request.includeKeystones !== false && activeTopic && this.vectorStore) {
        try {
          const rawCrossTopicKeystones = await this.getKeystonesByTopic(
            request.agentId,
            request.sessionKey,
            activeTopic,
            includedHistory,
            db,
            3
          );
          if (rawCrossTopicKeystones.length > 0) {
            // Token budget: cap the full cross-topic block at 15% of remaining,
            // including the header line.
            const crossTopicHeaderTokens = estimateTokens('## Cross-Topic Context');
            const crossTopicBudget = Math.max(0, Math.floor(remaining * 0.15) - crossTopicHeaderTokens);
            let used = 0;
            for (const candidate of rawCrossTopicKeystones) {
              const msg: NeutralMessage = {
                role: candidate.role as NeutralMessage['role'],
                textContent: candidate.content,
                toolCalls: null,
                toolResults: null,
              };
              const msgTokens = estimateMessageTokens(msg);
              if (used + msgTokens > crossTopicBudget) continue;
              crossTopicMessages.push(msg);
              used += msgTokens;
            }
            crossTopicTokens = used;
            diagCrossTopicKeystones = crossTopicMessages.length;
          }
        } catch {
          // Cross-topic retrieval is non-fatal — never block compose
        }
      }

      // Push history with keystone separators if we have keystones.
      if (keystoneMessages.length > 0 || crossTopicMessages.length > 0) {
        // Cross-topic context (from other topics) — prepended before within-session keystones
        if (crossTopicMessages.length > 0) {
          messages.push({
            role: 'system',
            textContent: '## Cross-Topic Context',
            toolCalls: null,
            toolResults: null,
          });
          messages.push(...crossTopicMessages);
        }
        // Separator before recalled context (within-session keystones)
        if (keystoneMessages.length > 0) {
          messages.push({
            role: 'system',
            textContent: '## Recalled Context (high-signal older messages)',
            toolCalls: null,
            toolResults: null,
          });
          messages.push(...keystoneMessages);
        }
        // Separator before recent conversation
        messages.push({
          role: 'system',
          textContent: '## Recent Conversation',
          toolCalls: null,
          toolResults: null,
        });
        messages.push(...includedHistory);
        // Account for separator tokens in history slot
        const crossTopicSepTokens = crossTopicMessages.length > 0
          ? estimateTokens('## Cross-Topic Context')
          : 0;
        const keystoneSepTokens = keystoneMessages.length > 0
          ? estimateTokens('## Recalled Context (high-signal older messages)')
          : 0;
        const recentSepTokens = estimateTokens('## Recent Conversation');
        const sepTokens = crossTopicSepTokens + keystoneSepTokens + recentSepTokens;
        slots.history = historyTokens + keystoneTokens + crossTopicTokens + sepTokens;
        remaining -= (historyTokens + keystoneTokens + crossTopicTokens + sepTokens);
      } else {
        messages.push(...includedHistory);
        slots.history = historyTokens;
        remaining -= historyTokens;
      }

      // Memory budget pool: facts, wiki, semantic recall, cross-session, and
      // trigger-fired doc chunks all draw from this shared pool via `remaining`.
      // memoryFraction is a fraction of the effective token budget (post-reserve).
      // Falls back to targetBudgetFraction cap behavior when memoryFraction is not set.
      let memoryBudget: number;
      if (this.config.memoryFraction != null) {
        memoryBudget = Math.floor(budget * this.config.memoryFraction);
        if (remaining > memoryBudget) {
          remaining = memoryBudget;
        }
      } else {
        const targetFraction = this.config.targetBudgetFraction ?? 0.65;
        memoryBudget = Math.floor(budget * targetFraction);
        if (remaining > memoryBudget) {
          remaining = memoryBudget;
        }
      }

      // T1.3: Ghost message suppression.
      // If the last message in the included history is a warm-seeded user message
      // AND there's a subsequent message in SQLite that wasn't included (meaning
      // the assistant already responded), drop it. This prevents the model from
      // re-answering a question that was already handled in a prior session.
      // Only triggers when: (1) message has _warmed flag, (2) it's role=user,
      // (3) SQLite has messages after it (the response exists but wasn't included).
      const lastIncluded = messages[messages.length - 1];
      if (lastIncluded?.role === 'user') {
        const sm = lastIncluded as import('./types.js').StoredMessage;
        const meta = sm.metadata as Record<string, unknown> | undefined;
        if (meta?._warmed && sm.id != null) {
          // Check if there are any messages after this one in SQLite
          try {
            const hasMore = db.prepare(
              'SELECT 1 FROM messages WHERE conversation_id = (SELECT conversation_id FROM messages WHERE id = ?) AND id > ? LIMIT 1'
            ).get(sm.id, sm.id);
            if (hasMore) {
              messages.pop();
              warnings.push('Dropped trailing warm-seeded user message with existing response (ghost suppression)');
            }
          } catch {
            // Ghost check is best-effort — don't block compose
          }
        }
      }
    }

    // ─── Injected Context Block ────────────────────────────────
    // Facts, knowledge, preferences, semantic recall, and cross-session
    // context are assembled into a single system message injected before
    // conversation history (after system/identity).
    const contextParts: string[] = [];
    let contextTokens = 0;

    // ── C1: Content fingerprint dedup set ────────────────────
    // Replaces fragile substring-match dedup across temporal, open-domain,
    // semantic recall, and cross-session paths. O(1) lookup on a normalized
    // 120-char prefix catches rephrased duplicates the old 60-char includes()
    // match missed without needing a hash.
    const contextFingerprints = new Set<string>();
    const fingerprintEntries = new Map<string, Set<string>>();

    // ── Compose-level diagnostics tracking vars ──────────────
    let diagTriggerHits = 0;
    let diagTriggerFallbackUsed = false;
    let diagFactsIncluded = 0;
    let diagSemanticResults = 0;
    let diagDocChunkCollections = 0;
    let diagScopeFiltered = 0;
    let diagFingerprintDedups = 0;
    let diagFingerprintCollisions = 0;
    let diagRetrievalMode: ComposeDiagnostics['retrievalMode'] = 'none';

    function normalizeFingerprintText(text: string): string {
      return text.toLowerCase().replace(/\s+/g, ' ').trim();
    }
    function contentFingerprint(text: string): string {
      return normalizeFingerprintText(text).slice(0, 120);
    }
    function addFingerprint(text: string): void {
      const normalized = normalizeFingerprintText(text);
      const fingerprint = normalized.slice(0, 120);
      contextFingerprints.add(fingerprint);
      const entries = fingerprintEntries.get(fingerprint) ?? new Set<string>();
      entries.add(normalized);
      fingerprintEntries.set(fingerprint, entries);
    }
    function isDuplicate(text: string): boolean {
      const normalized = normalizeFingerprintText(text);
      const fingerprint = normalized.slice(0, 120);
      if (!contextFingerprints.has(fingerprint)) return false;
      const entries = fingerprintEntries.get(fingerprint);
      if (entries && !entries.has(normalized)) diagFingerprintCollisions += 1;
      return true;
    }

    // ── Wiki Page (L4: Library — active topic synthesis) ──────
    // Inject synthesized wiki page for the active topic before general knowledge.
    // Draws from the shared memory budget pool (remaining is pre-capped by memoryBudget).
    if (request.includeLibrary !== false && remaining > 300 && libDb && composedActiveTopicName) {
      const wikiContent = this.buildWikiPageContext(request.agentId, composedActiveTopicName, libDb);
      if (wikiContent) {
        const tokens = estimateTokens(wikiContent);
        if (tokens <= remaining) {
          contextParts.push(wikiContent);
          contextTokens += tokens;
          remaining -= tokens;
          slots.library += tokens;
        } else if (remaining > 200) {
          const truncated = this.truncateToTokens(wikiContent, remaining);
          const truncTokens = estimateTokens(truncated);
          contextParts.push(truncated);
          contextTokens += truncTokens;
          remaining -= truncTokens;
          slots.library += truncTokens;
        }
      }
    }

    // ── Facts (L4: Library) ──────────────────────────────────
    // scope: agent — filtered by agentId via filterByScope after fetch
    // Draws from the shared memory budget pool (remaining is pre-capped by memoryBudget).
    if (request.includeFacts !== false && remaining > 500) {
      const factsContent = this.buildFactsFromDb(request.agentId, request.sessionKey, libDb || db);
      if (factsContent !== null) {
        const [content, factCount, scopeFiltered] = factsContent;
        diagFactsIncluded += factCount;
        diagScopeFiltered += scopeFiltered;
        if (content) {
          const tokens = estimateTokens(content);
          if (tokens <= remaining) {
            contextParts.push(`## Active Facts\n${content}`);
            contextTokens += tokens;
            remaining -= tokens;
            slots.facts = tokens;
          } else if (remaining > 200) {
            const truncated = this.truncateToTokens(content, remaining);
            const truncTokens = estimateTokens(truncated);
            contextParts.push(`## Active Facts (truncated)\n${truncated}`);
            contextTokens += truncTokens;
            remaining -= truncTokens;
            slots.facts = truncTokens;
            warnings.push('Facts truncated to fit memory budget');
          }
          // C1: Fingerprint each fact line so downstream dedup paths can skip duplicates
          const factLines = content.split('\n');
          for (const line of factLines) {
            if (line.startsWith('- [')) {
              addFingerprint(line);
            }
          }
        }
      }

      // ── Temporal retrieval (L4: Library) ─────────────────────
      // Fires when the query has temporal signals (before/after/when/last etc).
      // Returns facts in time order from temporal_index. Deduplicates against
      // facts already included above. Uses ingest_at as occurred_at proxy (v1).
      const queryText = request.prompt ?? '';

      if (request.includeSemanticRecall !== false && queryText && hasTemporalSignals(queryText) && libDb && remaining > 300) {
        try {
          const temporalStore = new TemporalStore(libDb);
          const temporalFacts = temporalStore.timeRangeQuery({
            agentId: request.agentId,
            limit: 15,
            order: 'DESC',
          });

          if (temporalFacts.length > 0) {
            // C1: Use fingerprint dedup instead of fragile substring match
            const beforeCount = temporalFacts.length;
            const novel = temporalFacts.filter(f => !isDuplicate(f.content));
            diagFingerprintDedups += beforeCount - novel.length;

            if (novel.length > 0) {
              const temporalBlock = novel
                .map(f => {
                  const ts = new Date(f.occurredAt).toISOString().slice(0, 10);
                  const line = `[${ts}] ${f.content}`;
                  addFingerprint(f.content);
                  return line;
                })
                .join('\n');

              const temporalSection = `## Temporal Context\n${temporalBlock}`;
              const tempTokens = estimateTokens(temporalSection);
              const tempBudget = Math.floor(remaining * 0.20); // Cap at 20% of remaining

              if (tempTokens <= tempBudget) {
                contextParts.push(temporalSection);
                contextTokens += tempTokens;
                remaining -= tempTokens;
                slots.facts = (slots.facts ?? 0) + tempTokens;
              } else {
                const truncated = this.truncateToTokens(temporalSection, tempBudget);
                const truncTokens = estimateTokens(truncated);
                contextParts.push(truncated);
                contextTokens += truncTokens;
                remaining -= truncTokens;
                slots.facts = (slots.facts ?? 0) + truncTokens;
              }
            }
          }
        } catch {
          // Temporal index not yet available (migration pending) — skip silently
        }
      }

      // ── Open-domain FTS retrieval (L4: Library) ──────────────────
      // Fires when the query looks broad/exploratory with no topical anchor.
      // Searches raw messages_fts — bypasses isQualityFact() quality gate so
      // content filtered from library.db is still reachable for open-domain
      // questions. Primary fix for LoCoMo open-domain F1 gap (0.133 baseline).
      if (request.includeSemanticRecall !== false && queryText && isOpenDomainQuery(queryText) && db && remaining > 300) {
        try {
          // searchOpenDomain still does intra-result dedup. Existing-context dedup
          // now happens here via fingerprints so we keep one dedup path.
          const rawOdResults = searchOpenDomain(db, queryText, '', 10);
          const beforeOd = rawOdResults.length;
          const odResults = rawOdResults.filter(r => !isDuplicate(r.content));
          diagFingerprintDedups += beforeOd - odResults.length;

          if (odResults.length > 0) {
            const odBlock = odResults
              .map(r => {
                addFingerprint(r.content);
                const ts = r.createdAt
                  ? new Date(r.createdAt).toISOString().slice(0, 10)
                  : '';
                const prefix = ts ? `[${ts}] ` : '';
                const snippet = r.content.length > 300
                  ? r.content.slice(0, 300) + '…'
                  : r.content;
                return `${prefix}${snippet}`;
              })
              .join('\n');

            const odSection = `## Open Domain Context\n${odBlock}`;
            const odTokens = estimateTokens(odSection);
            const odBudget = Math.floor(remaining * 0.20); // Cap at 20% of remaining

            if (odTokens <= odBudget) {
              contextParts.push(odSection);
              contextTokens += odTokens;
              remaining -= odTokens;
              slots.facts = (slots.facts ?? 0) + odTokens;
            } else {
              const truncated = this.truncateToTokens(odSection, odBudget);
              const truncTokens = estimateTokens(truncated);
              contextParts.push(truncated);
              contextTokens += truncTokens;
              remaining -= truncTokens;
              slots.facts = (slots.facts ?? 0) + truncTokens;
            }
          }
        } catch {
          // Open-domain FTS unavailable — skip silently
        }
      }
    }

    // ── Knowledge (L4: Library) ──────────────────────────────
    // scope: agent — filtered by agent_id in the SQL query (existing behavior)
    if (request.includeLibrary !== false && remaining > 500 && libDb) {
      const knowledgeContent = this.buildKnowledgeFromDb(request.agentId, libDb);
      if (knowledgeContent) {
        const tokens = estimateTokens(knowledgeContent);
        if (tokens <= remaining * 0.2) { // Cap knowledge at 20% of remaining
          contextParts.push(`## Knowledge\n${knowledgeContent}`);
          contextTokens += tokens;
          remaining -= tokens;
          slots.library += tokens;
        } else {
          const truncated = this.truncateToTokens(knowledgeContent, Math.floor(remaining * 0.2));
          const truncTokens = estimateTokens(truncated);
          contextParts.push(`## Knowledge (truncated)\n${truncated}`);
          contextTokens += truncTokens;
          remaining -= truncTokens;
          slots.library += truncTokens;
          warnings.push('Knowledge truncated to fit budget');
        }
      }
    }

    // ── Preferences (L4: Library) ────────────────────────────
    // scope: agent — filtered by agent_id OR NULL in the SQL query (existing behavior)
    if (request.includeLibrary !== false && remaining > 300 && libDb) {
      const prefsContent = this.buildPreferencesFromDb(request.agentId, libDb);
      if (prefsContent) {
        const tokens = estimateTokens(prefsContent);
        if (tokens <= remaining * 0.1) { // Cap preferences at 10% of remaining
          contextParts.push(`## User Preferences\n${prefsContent}`);
          contextTokens += tokens;
          remaining -= tokens;
          slots.library += tokens;
        }
      }
    }

    // ── Semantic Recall (L3: Hybrid FTS5+KNN) ───────────────
    // scope: agent — buildSemanticRecall filters by agentId internally
    // Fires when either vector store or library DB is available.
    // FTS5-only (no embeddings) still returns keyword matches.
    // KNN-only (no FTS terms) still returns semantic matches.
    // Both present → Reciprocal Rank Fusion.
    // Use request.prompt as the retrieval query when available — it is the
    // live current-turn text. Falling back to getLastUserMessage(messages)
    // reads from the already-assembled history, which is one turn stale.
    if (request.includeSemanticRecall !== false && remaining > 500 && (this.vectorStore || libDb)) {
      const lastUserMsg = request.prompt?.trim() || this.getLastUserMessage(messages);
      if (lastUserMsg) {
        try {
          // Check Redis for a pre-computed embedding from afterTurn()
          let precomputedEmbedding: Float32Array | undefined;
          try {
            const cached = await this.cache.getQueryEmbedding(request.agentId, request.sessionKey);
            if (cached) precomputedEmbedding = cached;
          } catch {
            // Redis lookup is best-effort — fall through to Ollama
          }

          const semanticContent = await this.buildSemanticRecall(
            lastUserMsg,
            request.agentId,
            Math.floor(remaining * 0.12), // Cap at 12% of remaining (W4: was 0.15)
            libDb || undefined,
            precomputedEmbedding,
            contextFingerprints  // C2: skip results already in Active Facts
          );
          if (semanticContent) {
            const tokens = estimateTokens(semanticContent);
            contextParts.push(`## Related Memory\n${semanticContent}`);
            contextTokens += tokens;
            remaining -= tokens;
            // Semantic recall draws from multiple sources, attribute to context
            slots.context += tokens;
            // W3 diagnostics: count non-empty lines as rough results count
            diagSemanticResults = semanticContent.split('\n').filter(l => l.trim().length > 0).length;
          }
        } catch (err) {
          // Semantic search is best-effort — don't fail composition
          warnings.push(`Semantic recall failed: ${(err as Error).message}`);
        }
      }
    }

    // ── Doc Chunks (L4: Trigger-based retrieval) ─────────────
    // scope: per-tier/per-agent — queryChunks filters by agentId and tier
    // Demand-load governance, identity, and memory chunks based on
    // conversation context. Replaces full ACA file injection for
    // the files that have been seeded into the doc chunk index.
    let triggerFallbackUsed = false;
    if (request.includeDocChunks !== false && remaining > 400 && libDb) {
      // Use request.prompt when available (current-turn text, not stale history)
      const lastMsg = request.prompt?.trim() || this.getLastUserMessage(messages) || '';
      const triggered = matchTriggers(lastMsg, this.triggerRegistry);

      if (triggered.length > 0) {
        diagTriggerHits = triggered.length;
        diagRetrievalMode = 'triggered';
        const docChunkStore = new DocChunkStore(libDb);
        const docParts: string[] = [];
        const maxTotalTriggerTokens = Math.min(
          remaining,
          this.config.maxTotalTriggerTokens && this.config.maxTotalTriggerTokens > 0
            ? this.config.maxTotalTriggerTokens
            : Math.floor(remaining * 0.40)
        );
        let totalTriggerTokens = 0;

        for (const trigger of triggered) {
          if (remaining < 200) break;

          const triggerBudgetRemaining = maxTotalTriggerTokens - totalTriggerTokens;
          if (triggerBudgetRemaining < 200) break;

          const maxTokens = Math.min(
            trigger.maxTokens || 1000,
            Math.floor(remaining * 0.12), // No single collection takes > 12% of remaining (W4: was 0.15)
            triggerBudgetRemaining
          );

          try {
            // Build a relevance-based FTS5 query from the user message.
            //
            // Problem: trigger keywords are stems ('escalat', 'irreversib') for
            // substring matching against user messages, but FTS5 tokenizes on word
            // boundaries. 'escalat' does not match 'escalation' in FTS5 without a
            // prefix operator.
            //
            // Solution: extract actual words from the user message that contain a
            // matched trigger keyword, then use FTS5 prefix queries (word*) for
            // each extracted word. This bridges stem-matching and FTS5 indexing.
            const msgLower = lastMsg.toLowerCase();
            const matchedKeywords = trigger.keywords.filter(kw =>
              msgLower.includes(kw.toLowerCase())
            );

            // Extract whole words from the message that overlap with matched keywords
            const msgWords = lastMsg.match(/\b\w{4,}\b/g) || [];
            const relevantWords = msgWords.filter(word =>
              matchedKeywords.some(kw => word.toLowerCase().includes(kw.toLowerCase()) ||
                                        kw.toLowerCase().includes(word.toLowerCase().slice(0, 5)))
            );

            // Build FTS5 OR query: "word1* OR word2* OR word3*"
            // FTS5 treats space-separated terms as AND by default — we want OR so
            // that any relevant term is sufficient to retrieve a matching chunk.
            // Prefix operator (*) ensures stems match full words in the index.
            // Sort by keyword match specificity (longer matched keyword = more specific term),
            // then cap at 6 terms to keep FTS queries reasonable.
            // No positional slice — all relevant words participate, not just the first 3.
            const sortedWords = [...new Set(relevantWords)].sort((a, b) => {
              const aLen = Math.max(...matchedKeywords.filter(kw =>
                a.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(a.toLowerCase().slice(0, 5))
              ).map(kw => kw.length), 0);
              const bLen = Math.max(...matchedKeywords.filter(kw =>
                b.toLowerCase().includes(kw.toLowerCase()) || kw.toLowerCase().includes(b.toLowerCase().slice(0, 5))
              ).map(kw => kw.length), 0);
              return bLen - aLen; // Most specific match first
            });

            const ftsTerms = sortedWords.length > 0
              ? sortedWords.slice(0, 6).map(w => `${w}*`).join(' OR ')
              : matchedKeywords
                  .sort((a, b) => b.length - a.length)
                  .slice(0, 3)
                  .map(kw => `${kw}*`)
                  .join(' OR ');

            const ftsKeyword = ftsTerms || lastMsg.split(/\s+/).slice(0, 3).join(' ');

            const chunks = docChunkStore.queryChunks({
              collection: trigger.collection,
              agentId: request.agentId,
              tier: request.tier,
              limit: trigger.maxChunks || 3,
              keyword: ftsKeyword,
            });

            if (chunks.length === 0) continue;

            const chunkLines: string[] = [];
            let chunkTokens = 0;

            for (const chunk of chunks) {
              if (chunkTokens + chunk.tokenEstimate > maxTokens) break;
              // Skip chunks from files OpenClaw already injects into the system prompt
              const chunkBasename = chunk.sourcePath.split('/').pop() || '';
              if (OPENCLAW_BOOTSTRAP_FILES.has(chunkBasename)) continue;
              chunkLines.push(`### ${chunk.sectionPath}\n${chunk.content}`);
              chunkTokens += chunk.tokenEstimate;
            }

            if (chunkLines.length > 0) {
              const collectionLabel = trigger.collection.split('/').pop() || trigger.collection;
              docParts.push(`## ${collectionLabel} (retrieved)\n${chunkLines.join('\n\n')}`);
              totalTriggerTokens += chunkTokens;
              contextTokens += chunkTokens;
              remaining -= chunkTokens;
              slots.library += chunkTokens;
              diagDocChunkCollections++;
            }
          } catch {
            // Doc chunk retrieval is best-effort — don't fail composition
          }
        }

        if (docParts.length > 0) {
          contextParts.push(docParts.join('\n\n'));
        }
      } else if (remaining > 400 && (this.vectorStore || libDb)) {
        // Trigger-miss fallback: no trigger fired — attempt bounded semantic retrieval
        // so there is never a silent zero-memory path on doc chunks.
        // INVARIANT: this block is mutually exclusive with triggered-retrieval above.
        // If refactored to run both paths, cap combined semantic budget to avoid double-recall.
        try {
          const fallbackContent = await Promise.race([
            this.buildSemanticRecall(
              lastMsg,
              request.agentId,
              Math.floor(remaining * 0.10),
              libDb || undefined,
              undefined,
              contextFingerprints  // C2: skip results already in Active Facts
            ),
            new Promise<null>((_, reject) =>
              setTimeout(() => reject(new Error('fallback_knn_timeout')), 3000)
            ),
          ]);
          if (fallbackContent) {
            contextParts.push(`## Related Memory\n${fallbackContent}`);
            const fallbackTokens = estimateTokens(fallbackContent);
            contextTokens += fallbackTokens;
            remaining -= fallbackTokens;
            slots.context += fallbackTokens;
            triggerFallbackUsed = true;
            diagTriggerFallbackUsed = true;
            diagRetrievalMode = 'fallback_knn';
          }
        } catch {
          // Fallback is best-effort — never fail composition (includes timeout)
        }
      }
    }

    // ── Session-Scoped Doc Chunks (spawn context inheritance) ────
    // When parentSessionKey is set, retrieve ephemeral doc chunks indexed
    // by buildSpawnContext() for this spawn session.
    if (request.parentSessionKey && remaining > 200 && libDb) {
      try {
        const spawnChunkStore = new DocChunkStore(libDb);
        const spawnQueryMsg = request.prompt?.trim() || this.getLastUserMessage(messages) || '';
        const spawnChunks = spawnChunkStore.queryDocChunks(
          request.agentId,
          spawnQueryMsg,
          { sessionKey: request.parentSessionKey, limit: 8 }
        );
        if (spawnChunks.length > 0) {
          const spawnLines: string[] = [];
          let spawnTokens = 0;
          const maxSpawnTokens = Math.floor(remaining * 0.15);
          for (const chunk of spawnChunks) {
            if (spawnTokens + chunk.tokenEstimate > maxSpawnTokens) break;
            spawnLines.push(chunk.content);
            spawnTokens += chunk.tokenEstimate;
          }
          if (spawnLines.length > 0) {
            contextParts.push(`## Spawn Context Documents\n${spawnLines.join('\n\n')}`);
            contextTokens += spawnTokens;
            remaining -= spawnTokens;
            slots.library += spawnTokens;
          }
        }
      } catch {
        // Session-scoped chunk retrieval is best-effort
      }
    }

    // ── Cross-Session Context (L2: Messages) ─────────────────
    if (request.includeContext !== false && remaining > 500) {
      const crossSessionContent = this.buildCrossSessionContext(
        request.agentId,
        request.sessionKey,
        db,
        libDb,
        contextFingerprints  // C3: skip entries already in facts/semantic recall
      );

      if (crossSessionContent) {
        const tokens = estimateTokens(crossSessionContent);
        const maxContextTokens = Math.min(
          this.config.maxCrossSessionContext,
          Math.floor(remaining * 0.2)
        );

        if (tokens <= maxContextTokens) {
          contextParts.push(`## Other Active Sessions\n${crossSessionContent}`);
          contextTokens += tokens;
          remaining -= tokens;
          slots.context += tokens;
        } else {
          const truncated = this.truncateToTokens(crossSessionContent, maxContextTokens);
          const truncTokens = estimateTokens(truncated);
          contextParts.push(`## Other Active Sessions (truncated)\n${truncated}`);
          contextTokens += truncTokens;
          remaining -= truncTokens;
          slots.context += truncTokens;
          warnings.push('Cross-session context truncated');
        }
      }
    }

    // ── Action Verification Summary ─────────────────────────
    // Keep recent action history on the dynamic side of the cache boundary.
    if (remaining > 50 && request.includeLibrary !== false) {
      const pressurePct = budget > 0 ? Math.round(((budget - remaining) / budget) * 100) : 0;
      const actionSummary = buildActionVerificationSummary(messages, pressurePct);
      if (actionSummary) {
        const actionTokens = Math.ceil(actionSummary.length / 4);
        if (actionTokens <= remaining) {
          contextParts.push(actionSummary);
          contextTokens += actionTokens;
          remaining -= actionTokens;
          slots.context += actionTokens;
        }
      }
    }

    // ── Inject assembled context block ──────────────────────
    const assembledContextBlock = contextParts.length > 0 ? contextParts.join('\n\n') : undefined;

    if (assembledContextBlock) {
      const contextMsg: NeutralMessage = {
        role: 'system',
        textContent: assembledContextBlock,
        toolCalls: null,
        toolResults: null,
        // DYNAMIC_BOUNDARY: this slot is session-specific (facts, recall, episodes).
        // It must NOT be included in any prompt caching boundary that spans static content.
        // The provider translator will insert a cache_control ephemeral marker BEFORE
        // this message so providers can cache everything up to identity/system as static context.
        metadata: { dynamicBoundary: true },
      };
      // Insert after system/identity, before history
      // Insert context after all system/identity messages, before conversation history.
      // findIndex returns -1 when all messages are system-role — handle explicitly.
      const firstNonSystem = messages.findIndex(m => m.role !== 'system');
      const insertIdx = firstNonSystem === -1 ? messages.length : firstNonSystem;
      messages.splice(insertIdx, 0, contextMsg);
    }

    // ─── Safety Valve: Post-Assembly Budget Check ───────────────────
    // Re-estimate total tokens after all slots are assembled. If the
    // composition exceeds tokenBudget * 1.05 (5% tolerance for estimation
    // drift), trim history messages from the oldest until we're under budget.
    // History is the most compressible slot — system/identity are never
    // truncated, and context (facts/recall/episodes) is more valuable per-token.
    const estimatedTotal = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    const hardCeiling = Math.floor(budget * 1.05);

    if (estimatedTotal > hardCeiling) {
      const overage = estimatedTotal - budget;
      let trimmed = 0;
      let trimCount = 0;

      // Find history messages (non-system, after system/identity block)
      // Walk forward from the first non-system message, trimming oldest history first
      const firstNonSystemIdx = messages.findIndex(m => m.role !== 'system');
      if (firstNonSystemIdx >= 0) {
        let i = firstNonSystemIdx;
        while (i < messages.length && trimmed < overage) {
          // Don't trim the last user message (current prompt)
          if (i === messages.length - 1 && messages[i].role === 'user') break;
          const msgTokens = estimateMessageTokens(messages[i]);
          messages.splice(i, 1);
          trimmed += msgTokens;
          trimCount++;
          // Don't increment i — splice shifts everything down
        }
      }

      if (trimCount > 0) {
        slots.history = Math.max(0, slots.history - trimmed);
        remaining += trimmed;
        warnings.push(`Safety valve: trimmed ${trimCount} oldest history messages (${trimmed} tokens) to fit budget`);
      }
    }

    // ─── Translate to provider format (unless caller wants neutral) ───
    // When skipProviderTranslation is set, return NeutralMessages directly.
    // The context engine plugin uses this: the OpenClaw runtime handles its
    // own provider translation, so double-translating corrupts tool calls.
    const outputMessages = toComposeOutputMessages(messages);

    // T1.3: Strip warm-replay provenance flags before output.
    // _warmed is an internal tag added by warmSession() to mark messages
    // seeded from SQLite into Redis. It must not leak into provider submissions
    // or be visible to the runtime (which might misinterpret it).
    for (const msg of outputMessages) {
      const m = msg as unknown as NeutralMessage;
      if (m.metadata && (m.metadata as Record<string, unknown>)._warmed) {
        const { _warmed, ...cleanMeta } = m.metadata as Record<string, unknown>;
        (m as { metadata?: Record<string, unknown> }).metadata = Object.keys(cleanMeta).length > 0 ? cleanMeta : undefined;
      }
    }

    const totalTokens = budget - remaining;

    // ─── Slot reconciliation ─────────────────────────────────────────────────
    // totalTokens = budget - remaining is the authoritative spend figure.
    // The slot accounting can drift from this due to history trim (which
    // reduces slots.history but adds back to remaining after the budget
    // was already committed) and FOS/MOD token rounding.
    // Reconcile: assign any unaccounted tokens to slots.history so that
    // sum(slots) === totalTokens always holds.
    {
      const slotSum = (slots.system ?? 0) + (slots.identity ?? 0) +
        (slots.history ?? 0) + (slots.facts ?? 0) +
        (slots.context ?? 0) + (slots.library ?? 0);
      const delta = totalTokens - slotSum;
      if (delta !== 0) {
        slots.history = (slots.history ?? 0) + delta;
      }
    }

    // ─── Compaction Fence Update ──────────────────────────────
    // Record the oldest message ID that the LLM can see in this compose
    // cycle. Everything below this ID becomes eligible for compaction.
    // If history was included, query the DB for the oldest included message.
    if (request.includeHistory !== false && slots.history > 0) {
      try {
        const conversation = store.getConversation(request.sessionKey);
        if (conversation) {
          // The compositor included N history messages (after truncation).
          // Count how many non-system messages are in the output to determine
          // how far back we reached.
          const historyMsgCount = messages.filter(m => m.role !== 'system').length;
          if (historyMsgCount > 0) {
            // Get the oldest message we would have included.
            // getRecentMessages returns the last N in chronological order,
            // so the first element is the oldest included.
            const oldestIncluded = db.prepare(`
              SELECT id FROM messages
              WHERE conversation_id = ?
              ORDER BY message_index DESC
              LIMIT 1 OFFSET ?
            `).get(conversation.id, historyMsgCount - 1) as { id: number } | undefined;

            if (oldestIncluded) {
              ensureCompactionFenceSchema(db);
              updateCompactionFence(db, conversation.id, oldestIncluded.id);
            }
          }
        }
      } catch {
        // Fence update is best-effort — never fail composition
        warnings.push('Compaction fence update failed (non-fatal)');
      }
    }

    // W3: Build compose diagnostics
    let zeroResultReason: import('./types.js').ComposeDiagnostics['zeroResultReason'];
    if (contextParts.length === 0) {
      if (diagScopeFiltered > 0 && diagFactsIncluded === 0 && diagSemanticResults === 0) {
        zeroResultReason = 'scope_filtered_all';
      } else if (remaining <= 0) {
        zeroResultReason = 'budget_exhausted';
      } else if (diagTriggerHits === 0 && !diagTriggerFallbackUsed) {
        zeroResultReason = 'no_trigger_no_fallback';
      } else if ((diagTriggerHits > 0 || diagTriggerFallbackUsed) && diagFactsIncluded === 0 && diagSemanticResults === 0 && diagDocChunkCollections === 0) {
        // Retrieval was attempted (trigger fired or fallback ran) but returned nothing — likely a retrieval bug
        // rather than a genuinely empty corpus. Distinguish from 'empty_corpus' for observability.
        zeroResultReason = 'unknown';
      } else {
        zeroResultReason = 'empty_corpus';
      }
    }

    const diagnostics: import('./types.js').ComposeDiagnostics = {
      triggerHits: diagTriggerHits,
      triggerFallbackUsed: diagTriggerFallbackUsed,
      factsIncluded: diagFactsIncluded,
      semanticResultsIncluded: diagSemanticResults,
      docChunksCollections: diagDocChunkCollections,
      scopeFiltered: diagScopeFiltered,
      zeroResultReason,
      retrievalMode: diagRetrievalMode,
      crossTopicKeystones: diagCrossTopicKeystones,
      reserveFraction: dynamicReserve,
      avgTurnCostTokens: avgTurnCost,
      dynamicReserveActive: isDynamic,
      sessionPressureHigh: pressureHigh,
      fingerprintDedups: diagFingerprintDedups,
      fingerprintCollisions: diagFingerprintCollisions,
      windowCacheHit: false,
    };

    if (pressureHigh) {
      warnings.push(`SESSION_PRESSURE_HIGH: avg_turn_cost=${avgTurnCost} tokens, dynamic reserve capped at ${Math.round(dynamicReserve * 100)}%`);
    } else if (dynamicReserve > 0.40) {
      console.info(`[hypermem:compositor] dynamic_reserve=${Math.round(dynamicReserve * 100)}% avg_turn_cost=${Math.round(avgTurnCost / 1000)}k horizon=${this.config.dynamicReserveTurnHorizon ?? 5}`);
    }

    const composedAt = new Date().toISOString();

    // ─── Write Window Cache ─────────────────────────────
    // Cache the composed message array so the plugin can serve it directly
    // on the next assemble() call without re-running the full compose pipeline.
    // Short TTL (120s). External L4 mutations should set skipWindowCache=true.
    //
    // VS-1: Dual-write, session-scoped key for backwards compat;
    // topic-scoped key for per-topic window retrieval when activeTopicId is set.
    try {
      await this.cache.setWindow(request.agentId, request.sessionKey, messages, 120);
      await this.cache.setWindowMeta(request.agentId, request.sessionKey, {
        slots: slots as unknown as Record<string, number>,
        totalTokens,
        warnings,
        diagnostics,
        composedAt,
      }, 120);
    } catch {
      // Window cache write is best-effort
    }
    if (composedActiveTopicId) {
      try {
        await this.cache.setTopicWindow(request.agentId, request.sessionKey, composedActiveTopicId, messages, 120);
      } catch {
        // Topic window write is best-effort
      }
    }

    // ─── Write Session Cursor ─────────────────────────────────
    // Record the newest message included in the submission window.
    // Background indexer uses this to find unprocessed high-signal content.
    if (request.includeHistory !== false && slots.history > 0) {
      try {
        const historyMsgs = messages.filter(m => m.role !== 'system');
        const lastHistoryMsg = historyMsgs.length > 0 ? historyMsgs[historyMsgs.length - 1] : null;
        if (lastHistoryMsg) {
          const sm = lastHistoryMsg as import('./types.js').StoredMessage;
          if (sm.id != null && sm.messageIndex != null) {
            const cursor: SessionCursor = {
              lastSentId: sm.id,
              lastSentIndex: sm.messageIndex,
              lastSentAt: composedAt,
              windowSize: historyMsgs.length,
              tokenCount: totalTokens,
            };
            await this.cache.setCursor(request.agentId, request.sessionKey, cursor);

            try {
              db.prepare(`
                UPDATE conversations
                SET cursor_last_sent_id = ?,
                    cursor_last_sent_index = ?,
                    cursor_last_sent_at = ?,
                    cursor_window_size = ?,
                    cursor_token_count = ?
                WHERE session_key = ?
              `).run(
                cursor.lastSentId,
                cursor.lastSentIndex,
                cursor.lastSentAt,
                cursor.windowSize,
                cursor.tokenCount,
                request.sessionKey
              );
            } catch {
              // SQLite cursor write is best-effort, don't block compose
            }
          }
        }
      } catch {
        // Cursor write is best-effort
      }
    }

    console.log(`[hypermem:compose] agent=${request.agentId} triggers=${diagTriggerHits} fallback=${diagTriggerFallbackUsed} facts=${diagFactsIncluded} semantic=${diagSemanticResults} chunks=${diagDocChunkCollections} scopeFiltered=${diagScopeFiltered} mode=${diagRetrievalMode} crossTopicKeystones=${diagCrossTopicKeystones}`);
    return {
      messages: outputMessages,
      tokenCount: totalTokens,
      slots,
      truncated: remaining < 0 || estimatedTotal > hardCeiling,
      hasWarnings: warnings.length > 0,
      warnings,
      contextBlock: assembledContextBlock,
      diagnostics,
    };
  }

  /**
   * Warm a session from SQLite into Redis.
   * Called on session start or Redis cache miss.
   */
  async warmSession(
    agentId: string,
    sessionKey: string,
    db: DatabaseSync,
    opts?: {
      systemPrompt?: string;
      identity?: string;
      libraryDb?: DatabaseSync;
      /** Model string for budget resolution. If omitted, falls back to defaultTokenBudget. */
      model?: string;
    }
  ): Promise<void> {
    const store = new MessageStore(db);
    const conversation = store.getConversation(sessionKey);

    if (!conversation) return;

    // Fetch a generous pool from SQLite, apply gradient transform, then
    // token-budget-cap the warm set. This replaces the old WARM_BOOTSTRAP_CAP
    // message-count constant which was a blunt instrument — 100 messages of
    // large tool results can massively exceed the history budget allocation.
    // Warm budget uses the same reserve fraction as compose() so warm history
    // never pre-fills more than compose() would actually allow.
    const reserve = this.config.contextWindowReserve ?? 0.15;
    const effectiveBudget = resolveModelBudget(opts?.model, this.config.defaultTokenBudget, reserve, this.config.budgetFraction);
    const warmBudget = Math.floor(
      effectiveBudget * (this.config.warmHistoryBudgetFraction ?? 0.4)
    );
    const rawHistory = store.getRecentMessages(conversation.id, this.config.maxHistoryMessages);
    const transformedForWarm = applyToolGradient(rawHistory, {
      totalWindowTokens: resolveModelWindow(opts?.model, this.config.defaultTokenBudget),
    });

    // Walk newest→oldest, accumulate transformed token cost, stop when budget exhausted
    let warmTokens = 0;
    const history: typeof rawHistory = [];
    for (let i = transformedForWarm.length - 1; i >= 0; i--) {
      const cost = estimateMessageTokens(transformedForWarm[i]);
      if (warmTokens + cost > warmBudget) break;
      // T1.3 Provenance flag: tag warm-seeded messages so they can be identified
      // downstream. The flag is stripped before provider submission in compose().
      // This prevents the runtime from treating warm-replayed user messages as
      // new inbound queries (ghost message bug).
      const tagged = { ...transformedForWarm[i] } as typeof rawHistory[0];
      tagged.metadata = { ...(tagged.metadata || {}), _warmed: true };
      history.unshift(tagged);
      warmTokens += cost;
    }

    const libDb = opts?.libraryDb || this.libraryDb;

    // Note: facts and context are intentionally NOT cached here.
    // compose() calls buildFactsFromDb() and buildCrossSessionContext() directly
    // from SQLite on every turn (~0.3ms each) — faster than a Redis GET round-trip.
    // Caching them here would create stale entries that compose() ignores anyway.

    await this.cache.warmSession(agentId, sessionKey, {
      system: opts?.systemPrompt,
      identity: opts?.identity,
      history,
      meta: {
        agentId,
        sessionKey,
        provider: conversation.provider,
        model: conversation.model,
        channelType: conversation.channelType,
        tokenCount: conversation.tokenCountIn + conversation.tokenCountOut,
        lastActive: conversation.updatedAt,
        status: conversation.status,
      },
    });
  }

  async refreshRedisGradient(
    agentId: string,
    sessionKey: string,
    db: DatabaseSync,
    tokenBudget?: number,
  ): Promise<void> {
    const store = new MessageStore(db);
    const conversation = store.getConversation(sessionKey);
    if (!conversation) return;

    const rawHistory = store.getRecentMessages(conversation.id, this.config.maxHistoryMessages);
    const transformedHistory = applyToolGradient(rawHistory, {
      totalWindowTokens: tokenBudget && tokenBudget > 0
        ? Math.max(tokenBudget, Math.floor(tokenBudget / 0.80))
        : TOOL_PLANNING_BASELINE_WINDOW,
    });

    // If a token budget is provided, trim the gradient-compressed window to fit
    // before writing to Redis. Without this, up to maxHistoryMessages messages
    // land in Redis regardless of size, and trimHistoryToTokenBudget fires
    // on every subsequent assemble() causing per-turn churn.
    let historyToWrite: NeutralMessage[] = transformedHistory;
    if (tokenBudget && tokenBudget > 0) {
      const budgetCap = Math.floor(tokenBudget * 0.8);
      let runningTokens = 0;
      const clusters = clusterNeutralMessages(transformedHistory);
      const cappedClusters: NeutralMessageCluster<NeutralMessage>[] = [];
      // Walk newest-first, keep whole clusters so tool-call/result pairs survive together.
      for (let i = clusters.length - 1; i >= 0; i--) {
        const cluster = clusters[i];
        if (runningTokens + cluster.tokenCost > budgetCap && cappedClusters.length > 0) break;
        cappedClusters.unshift(cluster);
        runningTokens += cluster.tokenCost;
        if (runningTokens >= budgetCap) break;
      }
      historyToWrite = cappedClusters.flatMap(cluster => cluster.messages);
      if (historyToWrite.length < transformedHistory.length) {
        console.log(
          `[hypermem] refreshRedisGradient: cluster-capped ${transformedHistory.length}→${historyToWrite.length} messages ` +
          `for ${agentId}/${sessionKey} (budgetCap=${budgetCap}, tokenCost=${runningTokens})`
        );
      }
    }

    await this.cache.replaceHistory(agentId, sessionKey, historyToWrite, this.config.maxHistoryMessages);
  }

  // ─── Slot Content Resolution ─────────────────────────────────

  /**
   * Get slot content: try Redis first, fall back to SQLite.
   */
  private async getSlotContent(
    agentId: string,
    sessionKey: string,
    slot: string,
    db: DatabaseSync,
    libraryDb?: DatabaseSync
  ): Promise<string | null> {
    const cached = await this.cache.getSlot(agentId, sessionKey, slot);
    if (cached) return cached;

    switch (slot) {
      case 'facts': {
        const result = this.buildFactsFromDb(agentId, sessionKey, libraryDb || this.libraryDb || db);
        return result ? result[0] : null;
      }
      case 'context':
        return this.buildCrossSessionContext(agentId, sessionKey, db, libraryDb || this.libraryDb);
      default:
        return null;
    }
  }

  /**
   * Get conversation history: try Redis first, fall back to SQLite.
   *
   * When topicId is provided (P3.4), the SQLite path filters to messages
   * matching that topic OR with topic_id IS NULL (Option B transition safety).
   * The Redis path is unaffected — Redis doesn't index by topic, so topic
   * filtering only applies to the SQLite fallback.
   */
  private async getHistory(
    agentId: string,
    sessionKey: string,
    limit: number,
    store: MessageStore,
    topicId?: string
  ): Promise<NeutralMessage[]> {
    // Pass limit through to Redis — this is the correct enforcement point.
    // Previously getHistory() ignored the limit on the Redis path (LRANGE 0 -1),
    // meaning historyDepth in the compose request had no effect on hot sessions.
    const cached = await this.cache.getHistory(agentId, sessionKey, limit);
    if (cached.length > 0) return cached;

    const conversation = store.getConversation(sessionKey);
    if (!conversation) return [];

    if (topicId) {
      // P3.4: Option B — active topic messages + legacy NULL messages
      return store.getRecentMessagesByTopic(conversation.id, topicId, limit);
    }
    return store.getRecentMessages(conversation.id, limit);
  }

  // ─── L4 Library Builders ─────────────────────────────────────

  /**
   * Build facts content from library DB.
   */
  /**
   * Build facts content from library DB.
   * Applies filterByScope (W1) to enforce retrieval access control.
   * Returns [content, factCount, scopeFilteredCount] or null if DB unavailable.
   */
  private buildFactsFromDb(
    agentId: string,
    sessionKey: string,
    db: DatabaseSync | null,
  ): [string | null, number, number] | null {
    if (!db) return null;

    const tableExists = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='facts'"
    ).get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) return null;

    const rawRows = db.prepare(`
      SELECT content, domain, confidence, agent_id, source_session_key AS session_key, scope FROM facts
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      AND decay_score < 0.8
      AND confidence >= 0.5
      ORDER BY confidence DESC, decay_score ASC
      LIMIT ?
    `).all(agentId, this.config.maxFacts) as Array<{
      content: string;
      domain: string | null;
      confidence: number;
      agent_id: string | null;
      session_key: string | null;
      scope: string | null;
    }>;

    if (rawRows.length === 0) return [null, 0, 0];

    // W1: Apply scope filter — enforce retrieval access control
    const ctx = { agentId, sessionKey };
    const { allowed, filteredCount } = filterByScope(
      rawRows.map(r => ({
        ...r,
        agentId: r.agent_id,
        sessionKey: r.session_key,
      })),
      ctx,
    );

    if (allowed.length === 0) return [null, 0, filteredCount];

    const content = allowed
      .map(r => {
        // Session attribution: label facts from a different session so the model
        // can distinguish current-session context from cross-session facts.
        // Shows last 8 chars of session key as a stable short identifier.
        const fromOtherSession = r.sessionKey && r.sessionKey !== sessionKey;
        const sessionSuffix = fromOtherSession
          ? `, session:${r.sessionKey!.slice(-8)}`
          : '';
        return `- [${r.domain || 'general'}${sessionSuffix}] ${r.content}`;
      })
      .join('\n');

    return [content, allowed.length, filteredCount];
  }

  /**
   * Build knowledge content from library DB.
   * Prioritizes high-confidence, non-superseded entries.
   */
  private buildKnowledgeFromDb(agentId: string, db: DatabaseSync): string | null {
    const tableExists = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='knowledge'"
    ).get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) return null;

    const rows = db.prepare(`
      SELECT domain, key, content, confidence FROM knowledge
      WHERE agent_id = ?
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 15
    `).all(agentId) as Array<{
      domain: string;
      key: string;
      content: string;
      confidence: number;
    }>;

    if (rows.length === 0) return null;

    // Group by domain for cleaner presentation
    const byDomain: Record<string, Array<{ key: string; content: string }>> = {};
    for (const row of rows) {
      if (!byDomain[row.domain]) byDomain[row.domain] = [];
      byDomain[row.domain].push({ key: row.key, content: row.content });
    }

    const lines: string[] = [];
    for (const [domain, entries] of Object.entries(byDomain)) {
      lines.push(`### ${domain}`);
      for (const entry of entries) {
        lines.push(`- **${entry.key}:** ${entry.content}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build wiki page context for the active topic.
   * Queries the knowledge table for a synthesized topic page and returns it
   * wrapped with a header. Capped at 600 tokens.
   */
  private buildWikiPageContext(agentId: string, topicName: string, db: DatabaseSync): string | null {
    const knowledgeStore = new KnowledgeStore(db);
    const knowledge = knowledgeStore.get(agentId, 'topic-synthesis', topicName);
    if (!knowledge) return null;

    const wrapped = `## Active Topic: ${topicName}\n${knowledge.content}`;
    return this.truncateToTokens(wrapped, 600);
  }

  /**
   * Build preferences content from library DB.
   * Shows user/operator preferences relevant to this agent.
   */
  private buildPreferencesFromDb(agentId: string, db: DatabaseSync): string | null {
    const tableExists = db.prepare(
      "SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name='preferences'"
    ).get() as { cnt: number };

    if (!tableExists || tableExists.cnt === 0) return null;

    // Get preferences set by this agent or marked fleet-visible
    const rows = db.prepare(`
      SELECT subject, key, value, domain, confidence FROM preferences
      WHERE (agent_id = ? OR agent_id IS NULL)
      ORDER BY confidence DESC, updated_at DESC
      LIMIT 10
    `).all(agentId) as Array<{
      subject: string;
      key: string;
      value: string;
      domain: string | null;
      confidence: number;
    }>;

    if (rows.length === 0) return null;

    // Group by subject
    const bySubject: Record<string, Array<{ key: string; value: string; domain: string | null }>> = {};
    for (const row of rows) {
      if (!bySubject[row.subject]) bySubject[row.subject] = [];
      bySubject[row.subject].push({ key: row.key, value: row.value, domain: row.domain });
    }

    const lines: string[] = [];
    for (const [subject, prefs] of Object.entries(bySubject)) {
      lines.push(`### ${subject}`);
      for (const pref of prefs) {
        const domainTag = pref.domain ? ` [${pref.domain}]` : '';
        lines.push(`- **${pref.key}:**${domainTag} ${pref.value}`);
      }
    }

    return lines.join('\n');
  }

  // ─── L3 Hybrid Retrieval (FTS5 + KNN) ───────────────────────

  /**
   * Build semantic recall content using hybrid FTS5+KNN retrieval.
   *
   * Uses Reciprocal Rank Fusion to merge keyword and vector results.
   * Gracefully degrades: FTS5-only when no vector store, KNN-only
   * when FTS query is empty (all stop words), both when available.
   *
   * @param precomputedEmbedding — optional pre-computed embedding for the query.
   *   When provided, the Ollama call inside VectorStore.search() is skipped.
   */
  private async buildSemanticRecall(
    userMessage: string,
    agentId: string,
    maxTokens: number,
    libraryDb?: DatabaseSync,
    precomputedEmbedding?: Float32Array,
    existingFingerprints?: Set<string>  // C2: skip results already in Active Facts
  ): Promise<string | null> {
    const libDb = libraryDb || this.libraryDb;
    if (!libDb && !this.vectorStore) return null;

    // Inline fingerprint helper (mirrors compose-scope version; C2 dedup only used here)
    const fpCheck = existingFingerprints
      ? (text: string) => existingFingerprints.has(text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120))
      : () => false;

    // Use hybrid search when library DB is available
    if (libDb) {
      const results = await hybridSearch(libDb, this.vectorStore, userMessage, {
        tables: ['facts', 'knowledge', 'episodes'],
        limit: 10,
        agentId,
        maxKnnDistance: 1.2,
        precomputedEmbedding,
      });

      if (results.length === 0) return null;

      const lines: string[] = [];
      let tokens = 0;

      // TUNE-015: apply recency decay to recall scores.
      // Messages and episodes from distant past score down even if semantically relevant.
      // A 5-day-old task-request should not compete equally with today's messages.
      //   - Episodes: exponential decay, half-life 7 days
      //   - Facts/knowledge: step-function penalty for items older than 48h
      //     (prevents completed/stale tasks from outranking recent ones)
      //       48-72h: multiply by 0.7
      //       >72h:   multiply by 0.5
      const now = Date.now();
      const decayedResults = results.map(result => {
        if (!result.createdAt) return result;
        const ageMs = now - new Date(result.createdAt).getTime();
        const ageDays = ageMs / 86_400_000;
        if (result.sourceTable === 'episodes') {
          // Exponential half-life decay for episodes
          const decayFactor = Math.pow(0.5, ageDays / 7);
          return { ...result, score: result.score * decayFactor };
        }
        // Step-function recency penalty for facts and knowledge
        const ageHours = ageMs / 3_600_000;
        if (ageHours > 72) {
          return { ...result, score: result.score * 0.5 };
        }
        if (ageHours > 48) {
          return { ...result, score: result.score * 0.7 };
        }
        return result;
      });
      // Re-sort after decay adjustment
      decayedResults.sort((a, b) => b.score - a.score);

      for (const result of decayedResults) {
        // TUNE-001: drop very-low-relevance results (RRF scores below 0.008 are noise)
        if (result.score < 0.008) continue;
        // TUNE-016: FTS-only results require higher floor — low-score FTS hits are noise
        if (result.sources.length === 1 && result.sources[0] === 'fts' && result.score < 0.05) continue;
        // TUNE-014: episodes require higher confidence — score:2 episodes bleed adjacent
        // session context and contaminate current session. Require fts+knn agreement
        // (score >= 0.04) for episodes to make it into assembled context.
        if (result.sourceTable === 'episodes' && result.score < 0.04) continue;
        // C2: Skip results whose content is already fingerprinted (e.g. in Active Facts)
        // Dedup count is not tracked separately here — compose-level counter covers the other paths.
        if (fpCheck(result.content)) continue;
        const label = this.formatHybridResult(result);
        const lineTokens = estimateTokens(label);
        if (tokens + lineTokens > maxTokens) break;
        lines.push(label);
        tokens += lineTokens;
      }

      return lines.length > 0 ? lines.join('\n') : null;
    }

    // Fallback: KNN-only when no library DB (legacy path)
    if (!this.vectorStore) return null;

    const results = await this.vectorStore.search(userMessage, {
      tables: ['facts', 'knowledge', 'episodes'],
      limit: 8,
      maxDistance: 1.2,
      precomputedEmbedding,
    });

    if (results.length === 0) return null;

    const lines: string[] = [];
    let tokens = 0;

    for (const result of results) {
      const label = this.formatVectorResult(result);
      const lineTokens = estimateTokens(label);
      if (tokens + lineTokens > maxTokens) break;
      lines.push(label);
      tokens += lineTokens;
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  /**
   * Format a hybrid search result for injection into context.
   * Shows retrieval source(s) and relevance score.
   */
  private formatHybridResult(result: HybridSearchResult): string {
    const type = result.sourceTable;
    const sourceTag = result.sources.length === 2 ? 'fts+knn' : result.sources[0];
    const scoreStr = (result.score * 100).toFixed(0);

    switch (type) {
      case 'facts':
        return `- [fact, ${sourceTag}, score:${scoreStr}] ${result.content}`;
      case 'knowledge':
        return `- [knowledge/${result.metadata || 'general'}, ${sourceTag}, score:${scoreStr}] ${result.content}`;
      case 'episodes':
        return `- [episode/${result.domain || 'event'}, ${sourceTag}, score:${scoreStr}] ${result.content}`;
      default:
        return `- [${type}, ${sourceTag}, score:${scoreStr}] ${result.content}`;
    }
  }

  /**
   * Format a vector-only search result (legacy fallback).
   */
  private formatVectorResult(result: VectorSearchResult): string {
    const relevance = Math.max(0, Math.round((1 - result.distance) * 100));
    const type = result.sourceTable;

    switch (type) {
      case 'facts':
        return `- [fact, ${relevance}% relevant] ${result.content}`;
      case 'knowledge':
        return `- [knowledge/${result.metadata || 'general'}, ${relevance}% relevant] ${result.content}`;
      case 'episodes':
        return `- [episode/${result.domain || 'event'}, ${relevance}% relevant] ${result.content}`;
      default:
        return `- [${type}, ${relevance}% relevant] ${result.content}`;
    }
  }

  // ─── L2 Cross-Session Context ────────────────────────────────

  /**
   * Build cross-session context by finding recent activity
   * in other sessions for this agent.
   */
  private buildCrossSessionContext(
    agentId: string,
    currentSessionKey: string,
    db: DatabaseSync,
    _libraryDb?: DatabaseSync | null,
    existingFingerprints?: Set<string>  // C3: skip entries already in facts/semantic recall
  ): string | null {
    const conversation = db.prepare(
      'SELECT id FROM conversations WHERE session_key = ?'
    ).get(currentSessionKey) as { id: number } | undefined;

    if (!conversation) return null;

    const rows = db.prepare(`
      SELECT m.text_content, m.role, c.channel_type, m.created_at
      FROM messages m
      JOIN conversations c ON m.conversation_id = c.id
      WHERE c.agent_id = ?
      AND m.conversation_id != ?
      AND c.status = 'active'
      AND m.text_content IS NOT NULL
      AND m.is_heartbeat = 0
      ORDER BY m.created_at DESC
      LIMIT 10
    `).all(
      agentId,
      conversation.id
    ) as Array<{
      text_content: string;
      role: string;
      channel_type: string;
      created_at: string;
    }>;

    if (rows.length === 0) return null;

    const fpCheck = existingFingerprints
      ? (text: string) => existingFingerprints.has(text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120))
      : () => false;

    const lines: string[] = [];
    for (const r of rows) {
      // C3: Skip cross-session entries whose content fingerprint already appears in context
      if (fpCheck(r.text_content)) continue;
      const preview = r.text_content.substring(0, 200);
      lines.push(`- [${r.channel_type}/${r.role} @ ${r.created_at}] ${preview}`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  // ─── Utilities ───────────────────────────────────────────────

  /**
   * Extract the last user message text from the composed messages.
   */
  private getLastUserMessage(messages: NeutralMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && messages[i].textContent) {
        return messages[i].textContent;
      }
    }
    return null;
  }

  /**
   * Truncate text to approximately fit within a token budget.
   * Truncates at line boundaries when possible.
   */
  private truncateToTokens(text: string, maxTokens: number): string {
    const maxChars = maxTokens * 4; // inverse of our estimation

    if (text.length <= maxChars) return text;

    // Try to truncate at a line boundary
    const truncated = text.substring(0, maxChars);
    const lastNewline = truncated.lastIndexOf('\n');

    if (lastNewline > maxChars * 0.7) {
      return truncated.substring(0, lastNewline) + '\n…';
    }

    return truncated + '…';
  }

  // ─── Keystone History Builder ─────────────────────────────────────

  /**
   * Query and score keystone candidates from before the current history window.
   *
   * Trims the oldest messages from includedHistory to free a keystone budget,
   * then queries the DB for older messages scored by episode significance,
   * FTS5 relevance, and recency.
   *
   * Returns null if keystones cannot be injected (no cutoff ID found,
   * no candidates, or all errors).
   */
  private async buildKeystones(
    db: DatabaseSync,
    agentId: string,
    includedHistory: NeutralMessage[],
    historyTokens: number,
    keystoneFraction: number,
    keystoneMaxMsgs: number,
    prompt?: string,
    libraryDb?: DatabaseSync
  ): Promise<{
    keystoneMessages: NeutralMessage[];
    keystoneTokens: number;
    trimmedHistory: NeutralMessage[];
    trimmedHistoryTokens: number;
  } | null> {
    const keystoneBudget = Math.floor(historyTokens * keystoneFraction);
    if (keystoneBudget <= 0) return null;

    // Trim oldest messages from includedHistory to free keystone budget.
    const trimmedHistory = [...includedHistory];
    let trimmedHistoryTokens = historyTokens;
    let freed = 0;
    while (trimmedHistory.length > 1 && freed < keystoneBudget) {
      const oldest = trimmedHistory.shift()!;
      const oldestTokens = estimateMessageTokens(oldest);
      freed += oldestTokens;
      trimmedHistoryTokens -= oldestTokens;
    }

    // Find the oldest message ID in the trimmed recent window (cutoff point).
    const oldestRecentMsg = trimmedHistory[0] as StoredMessage;
    const cutoffId = (oldestRecentMsg as StoredMessage)?.id ?? null;
    if (cutoffId == null) return null;

    // Find the current user prompt for FTS matching.
    const promptForFts = prompt?.trim() ||
      (() => {
        for (let i = trimmedHistory.length - 1; i >= 0; i--) {
          if (trimmedHistory[i].role === 'user' && trimmedHistory[i].textContent) {
            return trimmedHistory[i].textContent!;
          }
        }
        return null;
      })();

    try {
      // Get the conversation ID from the oldest recent message.
      const convRow = db.prepare(
        'SELECT conversation_id FROM messages WHERE id = ?'
      ).get(cutoffId) as { conversation_id: number } | undefined;

      if (!convRow) return null;

      const conversationId = convRow.conversation_id;
      const maxAgeHours = 168; // 7 days — tighter window gives recency real scoring weight
      const nowMs = Date.now();

      // Build episode significance map from libraryDb (episodes live there, not in messages.db).
      // Key: source_message_id, Value: max significance for that message.
      const sigMap = new Map<number, number>();
      if (libraryDb) {
        try {
          const episodeRows = libraryDb.prepare(`
            SELECT source_message_id, MAX(significance) AS significance
            FROM episodes
            WHERE agent_id = ? AND source_message_id IS NOT NULL
            GROUP BY source_message_id
          `).all(agentId) as Array<{ source_message_id: number; significance: number }>;
          for (const row of episodeRows) {
            sigMap.set(row.source_message_id, row.significance);
          }
        } catch {
          // Episodes query is best-effort
        }
      }

      type CandidateRow = {
        id: number;
        message_index: number;
        role: string;
        text_content: string | null;
        created_at: string;
      };

      const baseQuery = `
        SELECT
          m.id,
          m.message_index,
          m.role,
          m.text_content,
          m.created_at
        FROM messages m
        WHERE m.conversation_id = ?
          AND m.id < ?
          AND m.text_content IS NOT NULL
          AND m.is_heartbeat = 0
          AND m.text_content != ''
        LIMIT 200
      `;

      let candidateRows: CandidateRow[];

      if (promptForFts && promptForFts.length >= 3) {
        // Build a safe FTS5 query: extract words ≥3 chars, up to 8, OR with prefix.
        const ftsTerms = (promptForFts.match(/\b\w{3,}\b/g) || [])
          .slice(0, 8)
          .map(w => `"${w.replace(/"/g, '')}"*`)
          .join(' OR ');

        if (ftsTerms) {
          try {
            candidateRows = db.prepare(`
              SELECT
                m.id,
                m.message_index,
                m.role,
                m.text_content,
                m.created_at
              FROM messages m
              WHERE m.conversation_id = ?
                AND m.id < ?
                AND m.text_content IS NOT NULL
                AND m.is_heartbeat = 0
                AND m.text_content != ''
                AND m.id IN (
                  SELECT rowid FROM messages_fts
                  WHERE messages_fts MATCH ?
                  LIMIT 100
                )
              LIMIT 200
            `).all(conversationId, cutoffId, ftsTerms) as CandidateRow[];
          } catch {
            // FTS query may fail on special characters — fall back to base query
            candidateRows = db.prepare(baseQuery).all(conversationId, cutoffId) as CandidateRow[];
          }
        } else {
          candidateRows = db.prepare(baseQuery).all(conversationId, cutoffId) as CandidateRow[];
        }
      } else {
        candidateRows = db.prepare(baseQuery).all(conversationId, cutoffId) as CandidateRow[];
      }

      if (candidateRows.length === 0) return null;

      // Build KeystoneCandidate objects with computed ftsRank and ageHours.
      const totalCandidates = candidateRows.length;
      const candidates: KeystoneCandidate[] = candidateRows.map((row, idx) => {
        const createdMs = new Date(row.created_at).getTime();
        const ageHours = (nowMs - createdMs) / (1000 * 60 * 60);
        // Normalize FTS rank by position (best match = 1.0, worst = 0.1)
        const ftsRank = totalCandidates > 1
          ? 1.0 - (idx / totalCandidates) * 0.9
          : 1.0;

        return {
          messageId: row.id,
          messageIndex: row.message_index,
          role: row.role,
          content: row.text_content || '',
          timestamp: row.created_at,
          episodeSignificance: sigMap.get(row.id) ?? null,
          ftsRank,
          ageHours,
        };
      });

      // Score and rank candidates.
      const ranked = rankKeystones(candidates, maxAgeHours);

      // Budget-fit: take top-scored candidates until keystoneBudget exhausted.
      let kTokens = 0;
      const selectedKeystones: KeystoneCandidate[] = [];

      for (const candidate of ranked) {
        if (selectedKeystones.length >= keystoneMaxMsgs) break;
        const msg: NeutralMessage = {
          role: candidate.role as NeutralMessage['role'],
          textContent: candidate.content,
          toolCalls: null,
          toolResults: null,
        };
        const msgTokens = estimateMessageTokens(msg);
        if (kTokens + msgTokens > keystoneBudget) continue; // skip oversized; keep trying
        selectedKeystones.push(candidate);
        kTokens += msgTokens;
      }

      if (selectedKeystones.length === 0) return null;

      // Sort selected keystones chronologically for injection.
      selectedKeystones.sort((a, b) => a.messageIndex - b.messageIndex);

      const keystoneMessages: NeutralMessage[] = selectedKeystones.map(c => ({
        role: c.role as NeutralMessage['role'],
        textContent: c.content,
        toolCalls: null,
        toolResults: null,
      }));

      return {
        keystoneMessages,
        keystoneTokens: kTokens,
        trimmedHistory,
        trimmedHistoryTokens,
      };
    } catch {
      // Keystone injection is best-effort — never fail compose
      return null;
    }
  }

  // ─── Cross-Topic Keystone Retrieval (P3.5) ───────────────────────

  /**
   * Pull high-signal messages from OTHER topics in this session when their
   * content is semantically relevant to the current active topic.
   *
   * Heuristic-only: no model calls. Token overlap between the current topic
   * name + last 3 user messages and candidate message content.
   *
   * @param agentId      - The agent's ID
   * @param sessionKey   - Current session key
   * @param activeTopic  - The current active topic (id + name)
   * @param currentMessages - Recently included history messages for query extraction
   * @param db           - The messages database
   * @param maxKeystones - Max cross-topic keystones to return (default 3)
   * @returns Scored keystones sorted by score DESC, deduplicated by message id
   */
  private async getKeystonesByTopic(
    agentId: string,
    sessionKey: string,
    activeTopic: { id: string; name: string },
    currentMessages: NeutralMessage[],
    db: DatabaseSync,
    maxKeystones: number = 3
  ): Promise<ScoredKeystone[]> {
    // Fetch all topics for this session except the active one (max 5, most recent first)
    type TopicRow = { id: string; name: string };
    const otherTopics = db.prepare(`
      SELECT id, name
      FROM topics
      WHERE session_key = ? AND id != ?
      ORDER BY last_active_at DESC
      LIMIT 5
    `).all(sessionKey, activeTopic.id) as TopicRow[];

    if (otherTopics.length === 0) return [];

    // Extract key terms from active topic name + last 3 user messages
    const queryTerms = this.extractQueryTerms(activeTopic.name, currentMessages);
    if (queryTerms.size === 0) return [];

    const nowMs = Date.now();
    const maxAgeHours = 168; // 7 days, same as within-session keystones
    const seenIds = new Set<number>();
    const allCandidates: ScoredKeystone[] = [];

    for (const topic of otherTopics) {
      // Fetch a bounded pool, then select the topic's top keystones before
      // semantic filtering so cross-topic retrieval competes on the same scale.
      type MsgRow = {
        id: number;
        message_index: number;
        role: string;
        text_content: string;
        created_at: string;
      };

      let topicMessages: MsgRow[];
      try {
        topicMessages = db.prepare(`
          SELECT m.id, m.message_index, m.role, m.text_content, m.created_at
          FROM messages m
          JOIN conversations c ON m.conversation_id = c.id
          WHERE c.session_key = ?
            AND c.agent_id = ?
            AND m.topic_id = ?
            AND m.text_content IS NOT NULL
            AND m.text_content != ''
            AND m.is_heartbeat = 0
          ORDER BY m.message_index DESC
          LIMIT 50
        `).all(sessionKey, agentId, topic.id) as MsgRow[];
      } catch {
        // Corrupt topic data — skip this topic, never throw
        continue;
      }

      if (topicMessages.length === 0) continue;

      const topicCandidates: KeystoneCandidate[] = topicMessages.map((msg, idx) => {
        const createdMs = new Date(msg.created_at).getTime();
        const ageHours = (nowMs - createdMs) / (1000 * 60 * 60);
        const ftsRank = topicMessages.length > 1
          ? 1.0 - (idx / topicMessages.length) * 0.9
          : 1.0;

        return {
          messageId: msg.id,
          messageIndex: msg.message_index,
          role: msg.role,
          content: msg.text_content,
          timestamp: msg.created_at,
          episodeSignificance: null,
          ftsRank,
          ageHours,
        };
      });

      const topTopicKeystones = rankKeystones(topicCandidates, maxAgeHours).slice(0, 10);

      // Filter to messages with semantic overlap (≥2 matching terms)
      const relevant = topTopicKeystones.filter(candidate => {
        const contentLower = candidate.content.toLowerCase();
        let matches = 0;
        for (const term of queryTerms) {
          if (contentLower.includes(term)) {
            matches++;
            if (matches >= 2) return true;
          }
        }
        return false;
      });

      if (relevant.length === 0) continue;

      // Re-score filtered candidates so they compete on the same final scale
      for (const candidate of relevant) {
        if (seenIds.has(candidate.messageId)) continue;
        seenIds.add(candidate.messageId);

        const score = scoreKeystone(candidate, maxAgeHours);
        allCandidates.push({ ...candidate, score });
      }
    }

    if (allCandidates.length === 0) return [];

    // Sort by score DESC and return top maxKeystones
    return allCandidates
      .sort((a, b) => b.score - a.score)
      .slice(0, maxKeystones);
  }

  /**
   * Extract lowercase key terms from a topic name and the last 3 user messages.
   * Terms are: tokens with ≥4 characters (skip short stop words).
   * Returns a Set for O(1) lookup.
   */
  private extractQueryTerms(
    topicName: string,
    messages: NeutralMessage[]
  ): Set<string> {
    const terms = new Set<string>();
    const MIN_TERM_LEN = 4;

    // From topic name
    const topicTokens = topicName.toLowerCase().match(/\b[a-z0-9]{4,}\b/g) ?? [];
    for (const t of topicTokens) terms.add(t);

    // From last 3 user messages
    let userCount = 0;
    for (let i = messages.length - 1; i >= 0 && userCount < 3; i--) {
      const msg = messages[i];
      if (msg.role === 'user' && msg.textContent) {
        const tokens = msg.textContent.toLowerCase().match(/\b[a-z0-9]{4,}\b/g) ?? [];
        for (const t of tokens) {
          if (t.length >= MIN_TERM_LEN) terms.add(t);
        }
        userCount++;
      }
    }

    return terms;
  }
}
