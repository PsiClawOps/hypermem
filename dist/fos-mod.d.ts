/**
 * hypermem FOS/MOD — Fleet Output Standard & Model Output Directives
 *
 * Provides per-model output calibration injected into the context window.
 * Thread-safe: no module-scoped state. All functions take explicit db parameter.
 *
 * FOS (Fleet Output Standard): shared rules applied to all agents.
 * MOD (Model Output Directive): per-model corrections and calibrations.
 */
import type { DatabaseSync } from 'node:sqlite';
export interface FOSDirectives {
    structural?: string[];
    anti_patterns?: string[];
    density_targets?: Record<string, string>;
    voice?: string[];
}
export interface FOSTaskVariant {
    density_target?: string;
    structure?: string;
    list_cap?: string;
}
export interface FOSRecord {
    id: string;
    name: string;
    directives: FOSDirectives;
    task_variants: Record<string, FOSTaskVariant>;
    token_budget: number;
    active: number;
    source: string;
    version: number;
    last_validated_at: string | null;
    created_at: string;
    updated_at: string;
}
export interface MODCorrection {
    id: string;
    rule: string;
    severity: 'hard' | 'medium' | 'soft';
}
export interface MODCalibration {
    id: string;
    fos_target: string;
    model_tendency: string;
    adjustment: string;
}
export interface MODRecord {
    id: string;
    match_pattern: string;
    priority: number;
    corrections: MODCorrection[];
    calibration: MODCalibration[];
    task_overrides: Record<string, unknown>;
    token_budget: number;
    version: number;
    source: string;
    enabled: number;
    last_validated_at: string | null;
    created_at: string;
    updated_at: string;
}
export interface OutputMetricsRow {
    id: string;
    timestamp: string;
    agent_id: string;
    session_key: string;
    model_id: string;
    provider: string;
    fos_version?: number | null;
    mod_version?: number | null;
    mod_id?: string | null;
    task_type?: string | null;
    output_tokens: number;
    input_tokens?: number | null;
    cache_read_tokens?: number | null;
    corrections_fired?: string[];
    latency_ms?: number | null;
}
/**
 * Get the active FOS profile.
 * Returns null if no active profile exists or tables don't exist yet.
 */
export declare function getActiveFOS(db: DatabaseSync): FOSRecord | null;
/**
 * Match a MOD for the given model ID.
 *
 * Match hierarchy (in order):
 *   1. Exact match on id (case-sensitive)
 *   2. Glob pattern match — longest pattern wins ties
 *   3. Wildcard '*' fallback
 *   4. null
 *
 * Only enabled=1 MODs are considered. Higher priority wins on equal pattern length.
 */
export declare function matchMOD(modelId: string | undefined, db: DatabaseSync): MODRecord | null;
/**
 * Render a FOS record into prompt lines.
 *
 * Output format:
 *   ## Output Standard (Fleet)
 *   - Lead with the answer...
 *   Never: no em dashes, no sycophancy...
 *   Simple: 1-3 sentences. Analysis: 200-500 words. Code: code first.
 *   - Numbers over adjectives...
 *
 * Respects token_budget (default 250 tokens). Never cuts mid-sentence.
 * If taskContext is provided and a matching task variant exists, overrides density targets.
 */
/**
 * Output standard tiers. Controls what FOS content is injected into context.
 *
 * 'light'    — ~100 token standalone directives. No MOD, no fleet concepts.
 *              Works on any single-agent 64k setup. No DB required.
 * 'standard' — Full FOS: density targets, format rules, compression ratios,
 *              task-context scoping. MOD suppressed.
 * 'full'     — FOS + MOD. Full spec for multi-agent fleet operators.
 *
 * Backward compat: 'starter' maps to 'light', 'fleet' maps to 'full'.
 */
export type OutputProfileTier = 'light' | 'standard' | 'full';
/** @deprecated Use OutputProfileTier */
export type OutputStandardTier = OutputProfileTier;
/**
 * Render the light-tier output profile.
 * Standalone: no compositor concepts, no fleet terminology, no DB required.
 * ~100 tokens. Covers anti-sycophancy, em dash ban, AI vocab ban, length targets,
 * anti-pagination, and evidence calibration.
 */
export declare function renderLightFOS(): string[];
/** @deprecated Use renderLightFOS */
export declare function renderStarterFOS(): string[];
/**
 * Resolve the effective output standard tier given compositor config.
 * MOD is only eligible at the 'fleet' tier.
 */
export declare function resolveOutputTier(outputProfile: OutputProfileTier | undefined, enableFOS: boolean | undefined, enableMOD: boolean | undefined): {
    tier: OutputProfileTier;
    fos: boolean;
    mod: boolean;
};
export declare function renderFOS(fos: FOSRecord, taskContext?: string): string[];
/**
 * Render a MOD record into prompt lines.
 *
 * Output format:
 *   ## Output Calibration (gpt-5.4)
 *   Known tendencies: 2x verbosity, 1.8x list length vs target.
 *   - Actively compress. Cut first drafts in half.
 *   - Do not open with I. No preamble before the answer.
 *
 * Respects token_budget (default 150 tokens). Never cuts mid-sentence.
 */
export declare function renderMOD(mod: MODRecord, fos: FOSRecord | null, modelId: string, taskContext?: string): string[];
export type { NeutralMessage } from './types.js';
/**
 * Build a rolling summary of the last N verified tool actions from the message window.
 *
 * Scans for tool_use/tool_result pairs (matched by tool_use_id / callId).
 * Renders as:
 *   ## Recent Actions
 *   - tool_name: result_summary
 *   ...
 *
 * Pressure-aware:
 *   <80%  → 5 actions
 *   80-90% → 3 actions
 *   90-95% → 1 action
 *   ≥95%  → empty string (drop entirely)
 *
 * Token budget: 150 tokens total.
 * Gate: returns '' when pressurePct >= 95.
 */
export declare function buildActionVerificationSummary(messages: import('./types.js').NeutralMessage[], pressurePct: number): string;
/**
 * Record output metrics for analytics.
 * Best-effort: logs errors but never throws.
 */
export declare function recordOutputMetrics(db: DatabaseSync, metrics: OutputMetricsRow): void;
//# sourceMappingURL=fos-mod.d.ts.map