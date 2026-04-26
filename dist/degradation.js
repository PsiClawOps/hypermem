/**
 * HyperMem Canonical Degradation Contracts, Phase C0.2
 *
 * Defines the typed surfaces, reason enum, and format builders for degraded
 * prompt-visible outputs. These shapes stay in volatile context and should not
 * cross the stable-prefix boundary.
 */
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
];
/** Field-length caps for canonical degraded strings. */
export const DEGRADATION_LIMITS = {
    toolName: 64,
    toolId: 64,
    reason: 48,
    toolSummary: 120,
    toolArtifactId: 64,
    artifactId: 64,
    artifactPath: 160,
    artifactFetchHint: 80,
    replayState: 32,
    replaySummary: 120,
};
function sanitizeInline(value) {
    return value
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/]/g, ')')
        .trim();
}
function clampInline(value, limit) {
    const cleaned = sanitizeInline(value);
    if (cleaned.length <= limit)
        return cleaned;
    if (limit <= 3)
        return cleaned.slice(0, limit);
    return cleaned.slice(0, limit - 3) + '...';
}
export function isDegradationReason(value) {
    return DEGRADATION_REASONS.includes(value);
}
// Matches stubs with or without the optional artifact field.
const TOOL_CHAIN_RE = /^\[tool:([^\s\]]+) id=([^\s\]]+) status=(ejected) reason=([^\s\]]+)(?: artifact=([^\s\]]+))? summary=(.*)\]$/s;
export function formatToolChainStub(stub) {
    const name = clampInline(stub.name, DEGRADATION_LIMITS.toolName);
    const id = clampInline(stub.id, DEGRADATION_LIMITS.toolId);
    const reason = clampInline(stub.reason, DEGRADATION_LIMITS.reason);
    const summary = clampInline(stub.summary, DEGRADATION_LIMITS.toolSummary);
    const artifactPart = stub.artifactId
        ? ` artifact=${clampInline(stub.artifactId, DEGRADATION_LIMITS.toolArtifactId)}`
        : '';
    return `[tool:${name} id=${id} status=${stub.status} reason=${reason}${artifactPart} summary=${summary}]`;
}
export function parseToolChainStub(text) {
    const match = text.match(TOOL_CHAIN_RE);
    if (!match)
        return null;
    const [, name, id, status, reason, artifactId, summary] = match;
    if (status !== 'ejected' || !isDegradationReason(reason))
        return null;
    const out = { name, id, status: 'ejected', reason, summary };
    if (artifactId)
        out.artifactId = artifactId;
    return out;
}
export function isToolChainStub(text) {
    return parseToolChainStub(text) !== null;
}
const ARTIFACT_REF_RE = /^\[artifact:(.+?) path=(.+?) size=(\d+) status=(degraded) reason=(.+?) fetch=(.*)\]$/s;
export function formatArtifactRef(ref) {
    const id = clampInline(ref.id, DEGRADATION_LIMITS.artifactId);
    const path = clampInline(ref.path, DEGRADATION_LIMITS.artifactPath);
    const reason = clampInline(ref.reason, DEGRADATION_LIMITS.reason);
    const fetchHint = clampInline(ref.fetchHint, DEGRADATION_LIMITS.artifactFetchHint);
    return `[artifact:${id} path=${path} size=${ref.sizeTokens} status=${ref.status} reason=${reason} fetch=${fetchHint}]`;
}
export function parseArtifactRef(text) {
    const match = text.match(ARTIFACT_REF_RE);
    if (!match)
        return null;
    const [, id, path, sizeTokens, status, reason, fetchHint] = match;
    if (status !== 'degraded' || !isDegradationReason(reason))
        return null;
    return {
        id,
        path,
        sizeTokens: parseInt(sizeTokens, 10),
        status: 'degraded',
        reason,
        fetchHint,
    };
}
export function isArtifactRef(text) {
    return parseArtifactRef(text) !== null;
}
export function isReplayState(value) {
    return value === 'entering' || value === 'stabilizing' || value === 'exited';
}
const REPLAY_MARKER_RE = /^\[replay state=([^\s\]]+) status=(bounded) reason=([^\s\]]+) summary=(.*)\]$/s;
export function formatReplayMarker(marker) {
    const state = clampInline(marker.state, DEGRADATION_LIMITS.replayState);
    const reason = clampInline(marker.reason, DEGRADATION_LIMITS.reason);
    const summary = clampInline(marker.summary, DEGRADATION_LIMITS.replaySummary);
    return `[replay state=${state} status=${marker.status} reason=${reason} summary=${summary}]`;
}
export function parseReplayMarker(text) {
    const match = text.match(REPLAY_MARKER_RE);
    if (!match)
        return null;
    const [, state, status, reason, summary] = match;
    if (status !== 'bounded' || !isReplayState(state) || !isDegradationReason(reason))
        return null;
    return {
        state,
        status: 'bounded',
        reason,
        summary,
    };
}
export function isReplayMarker(text) {
    return parseReplayMarker(text) !== null;
}
// ─── Shared helpers ───────────────────────────────────────────────────────────
export function isDegradedContent(text) {
    return isToolChainStub(text) || isArtifactRef(text) || isReplayMarker(text);
}
//# sourceMappingURL=degradation.js.map