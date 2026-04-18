/**
 * HyperMem Canonical Degradation Contracts, Phase C0.2
 *
 * Defines the typed surfaces, reason enum, and format builders for degraded
 * prompt-visible outputs. These shapes stay in volatile context and should not
 * cross the stable-prefix boundary.
 */

// ─── Reason surface ───────────────────────────────────────────────────────────

/**
 * Closed set of reasons for any degradation decision.
 * Use these values in telemetry and tests instead of ad-hoc strings.
 */
export type DegradationReason =
  | 'gradient_t2_prose'
  | 'gradient_t3_stub'
  | 'eviction_oversize'
  | 'eviction_turn0_trim'
  | 'wave_guard_pressure_high'
  | 'wave_guard_pressure_elevated'
  | 'budget_cluster_drop'
  | 'artifact_oversize'
  | 'artifact_fetch_hint'
  | 'replay_cold_redis'
  | 'replay_stabilizing'
  | 'replay_exited'
  | 'pressure_mismatch'
  | 'unknown';

/** All valid DegradationReason values as a readonly array. */
export const DEGRADATION_REASONS = [
  'gradient_t2_prose',
  'gradient_t3_stub',
  'eviction_oversize',
  'eviction_turn0_trim',
  'wave_guard_pressure_high',
  'wave_guard_pressure_elevated',
  'budget_cluster_drop',
  'artifact_oversize',
  'artifact_fetch_hint',
  'replay_cold_redis',
  'replay_stabilizing',
  'replay_exited',
  'pressure_mismatch',
  'unknown',
] as const satisfies readonly DegradationReason[];

/** Field-length caps for canonical degraded strings. */
export const DEGRADATION_LIMITS = {
  toolName: 64,
  toolId: 64,
  reason: 48,
  toolSummary: 120,
  artifactId: 64,
  artifactPath: 160,
  artifactFetchHint: 80,
  replayState: 32,
  replaySummary: 120,
} as const;

function sanitizeInline(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/]/g, ')')
    .trim();
}

function clampInline(value: string, limit: number): string {
  const cleaned = sanitizeInline(value);
  if (cleaned.length <= limit) return cleaned;
  if (limit <= 3) return cleaned.slice(0, limit);
  return cleaned.slice(0, limit - 3) + '...';
}

export function isDegradationReason(value: string): value is DegradationReason {
  return (DEGRADATION_REASONS as readonly string[]).includes(value);
}

// ─── 1. Tool-chain stub ───────────────────────────────────────────────────────

/**
 * Canonical shape for a degraded tool call/result pair.
 *
 * Prompt-visible format:
 *   [tool:<name> id=<id> status=ejected reason=<reason> summary=<stub>]
 */
export interface ToolChainStub {
  name: string;
  id: string;
  status: 'ejected';
  reason: DegradationReason;
  summary: string;
}

const TOOL_CHAIN_RE = /^\[tool:([^\s\]]+) id=([^\s\]]+) status=(ejected) reason=([^\s\]]+) summary=(.*)\]$/s;

export function formatToolChainStub(stub: ToolChainStub): string {
  const name = clampInline(stub.name, DEGRADATION_LIMITS.toolName);
  const id = clampInline(stub.id, DEGRADATION_LIMITS.toolId);
  const reason = clampInline(stub.reason, DEGRADATION_LIMITS.reason);
  const summary = clampInline(stub.summary, DEGRADATION_LIMITS.toolSummary);
  return `[tool:${name} id=${id} status=${stub.status} reason=${reason} summary=${summary}]`;
}

export function parseToolChainStub(text: string): ToolChainStub | null {
  const match = text.match(TOOL_CHAIN_RE);
  if (!match) return null;
  const [, name, id, status, reason, summary] = match;
  if (status !== 'ejected' || !isDegradationReason(reason)) return null;
  return { name, id, status: 'ejected', reason, summary };
}

export function isToolChainStub(text: string): boolean {
  return parseToolChainStub(text) !== null;
}

// ─── 2. Artifact reference ────────────────────────────────────────────────────

/**
 * Canonical shape for a degraded oversized artifact replaced by a pointer.
 *
 * Prompt-visible format:
 *   [artifact:<id> path=<path> size=<tokens> status=degraded fetch=<hint>]
 */
export interface ArtifactRef {
  id: string;
  path: string;
  sizeTokens: number;
  status: 'degraded';
  reason: DegradationReason;
  fetchHint: string;
}

const ARTIFACT_REF_RE = /^\[artifact:(.+?) path=(.+?) size=(\d+) status=(degraded) reason=(.+?) fetch=(.*)\]$/s;

export function formatArtifactRef(ref: ArtifactRef): string {
  const id = clampInline(ref.id, DEGRADATION_LIMITS.artifactId);
  const path = clampInline(ref.path, DEGRADATION_LIMITS.artifactPath);
  const reason = clampInline(ref.reason, DEGRADATION_LIMITS.reason);
  const fetchHint = clampInline(ref.fetchHint, DEGRADATION_LIMITS.artifactFetchHint);
  return `[artifact:${id} path=${path} size=${ref.sizeTokens} status=${ref.status} reason=${reason} fetch=${fetchHint}]`;
}

export function parseArtifactRef(text: string): ArtifactRef | null {
  const match = text.match(ARTIFACT_REF_RE);
  if (!match) return null;
  const [, id, path, sizeTokens, status, reason, fetchHint] = match;
  if (status !== 'degraded' || !isDegradationReason(reason)) return null;
  return {
    id,
    path,
    sizeTokens: parseInt(sizeTokens, 10),
    status: 'degraded',
    reason,
    fetchHint,
  };
}

export function isArtifactRef(text: string): boolean {
  return parseArtifactRef(text) !== null;
}

// ─── 3. Replay marker ─────────────────────────────────────────────────────────

/**
 * State of the replay recovery window.
 */
export type ReplayState = 'entering' | 'stabilizing' | 'exited';

export function isReplayState(value: string): value is ReplayState {
  return value === 'entering' || value === 'stabilizing' || value === 'exited';
}

/**
 * Canonical shape for a replay recovery mode marker.
 *
 * Prompt-visible format:
 *   [replay state=<state> status=bounded reason=<reason> summary=<stub>]
 */
export interface ReplayMarker {
  state: ReplayState;
  status: 'bounded';
  reason: DegradationReason;
  summary: string;
}

const REPLAY_MARKER_RE = /^\[replay state=([^\s\]]+) status=(bounded) reason=([^\s\]]+) summary=(.*)\]$/s;

export function formatReplayMarker(marker: ReplayMarker): string {
  const state = clampInline(marker.state, DEGRADATION_LIMITS.replayState);
  const reason = clampInline(marker.reason, DEGRADATION_LIMITS.reason);
  const summary = clampInline(marker.summary, DEGRADATION_LIMITS.replaySummary);
  return `[replay state=${state} status=${marker.status} reason=${reason} summary=${summary}]`;
}

export function parseReplayMarker(text: string): ReplayMarker | null {
  const match = text.match(REPLAY_MARKER_RE);
  if (!match) return null;
  const [, state, status, reason, summary] = match;
  if (status !== 'bounded' || !isReplayState(state) || !isDegradationReason(reason)) return null;
  return {
    state,
    status: 'bounded',
    reason,
    summary,
  };
}

export function isReplayMarker(text: string): boolean {
  return parseReplayMarker(text) !== null;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

export function isDegradedContent(text: string): boolean {
  return isToolChainStub(text) || isArtifactRef(text) || isReplayMarker(text);
}

// ─── Telemetry helper ─────────────────────────────────────────────────────────

export interface DegradationEvent {
  event: 'degradation';
  ts: string;
  agentId: string;
  sessionKey: string;
  degradationClass: 'tool_chain' | 'artifact' | 'replay';
  reason: DegradationReason;
  tokensSaved: number;
  emittedText: string;
}
