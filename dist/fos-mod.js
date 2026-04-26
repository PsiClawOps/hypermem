/**
 * hypermem FOS/MOD — Fleet Output Standard & Model Output Directives
 *
 * Provides per-model output calibration injected into the context window.
 * Thread-safe: no module-scoped state. All functions take explicit db parameter.
 *
 * FOS (Fleet Output Standard): shared rules applied to all agents.
 * MOD (Model Output Directive): per-model corrections and calibrations.
 */
// ── Token budget constants ────────────────────────────────────
const FOS_TOKEN_BUDGET = 250;
const MOD_TOKEN_BUDGET = 150;
// ── Internal helpers ──────────────────────────────────────────
function tryParseJson(val, fallback) {
    if (!val)
        return fallback;
    try {
        return JSON.parse(val);
    }
    catch {
        return fallback;
    }
}
/**
 * Rough token estimate: 4 chars per token on average.
 */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/**
 * Truncate an array of strings to fit within a token budget.
 * Never cuts mid-item: drops complete items from the end.
 */
function truncateLines(lines, budget) {
    const result = [];
    let total = 0;
    for (const line of lines) {
        const cost = estimateTokens(line) + 1; // +1 for newline
        if (total + cost > budget)
            break;
        result.push(line);
        total += cost;
    }
    return result;
}
function parseRow(row) {
    return {
        id: row.id,
        name: row.name,
        directives: tryParseJson(row.directives, {}),
        task_variants: tryParseJson(row.task_variants, {}),
        token_budget: row.token_budget ?? FOS_TOKEN_BUDGET,
        active: row.active,
        source: row.source,
        version: row.version,
        last_validated_at: row.last_validated_at || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}
function parseMODRow(row) {
    return {
        id: row.id,
        match_pattern: row.match_pattern,
        priority: row.priority ?? 0,
        corrections: tryParseJson(row.corrections, []),
        calibration: tryParseJson(row.calibration, []),
        task_overrides: tryParseJson(row.task_overrides, {}),
        token_budget: row.token_budget ?? MOD_TOKEN_BUDGET,
        version: row.version ?? 1,
        source: row.source || 'builtin',
        enabled: row.enabled ?? 1,
        last_validated_at: row.last_validated_at || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}
// ── Core API ──────────────────────────────────────────────────
/**
 * Get the active FOS profile.
 * Returns null if no active profile exists or tables don't exist yet.
 */
export function getActiveFOS(db) {
    try {
        const row = db.prepare("SELECT * FROM fleet_output_standard WHERE active = 1 ORDER BY version DESC LIMIT 1").get();
        return row ? parseRow(row) : null;
    }
    catch {
        // Table doesn't exist yet (pre-migration)
        return null;
    }
}
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
export function matchMOD(modelId, db) {
    if (!modelId)
        return null;
    try {
        const rows = db.prepare("SELECT * FROM model_output_directives WHERE enabled = 1 ORDER BY priority DESC, id ASC").all();
        if (rows.length === 0)
            return null;
        const mods = rows.map(parseMODRow);
        const model = modelId.toLowerCase();
        // 1. Exact match on id
        for (const mod of mods) {
            if (mod.id.toLowerCase() === model)
                return mod;
        }
        // 2. Glob match — collect all matching patterns, pick longest
        // Supports: prefix* (e.g., 'gpt-5.4*'), *suffix, *wildcard*
        const globMatches = [];
        for (const mod of mods) {
            const pattern = mod.match_pattern;
            if (pattern === '*')
                continue; // wildcard handled separately
            if (globMatch(pattern, modelId)) {
                globMatches.push({ mod, patternLen: pattern.length });
            }
        }
        if (globMatches.length > 0) {
            // Sort by pattern length descending (longer = more specific), then priority descending
            globMatches.sort((a, b) => {
                if (b.patternLen !== a.patternLen)
                    return b.patternLen - a.patternLen;
                return b.mod.priority - a.mod.priority;
            });
            return globMatches[0].mod;
        }
        // 3. Wildcard '*' fallback
        for (const mod of mods) {
            if (mod.match_pattern === '*')
                return mod;
        }
        return null;
    }
    catch {
        // Table doesn't exist yet
        return null;
    }
}
/**
 * Simple glob matching: supports * as wildcard substring.
 * Pattern like 'gpt-5.4*' matches 'gpt-5.4', 'gpt-5.4-turbo', etc.
 * Case-insensitive.
 */
function globMatch(pattern, value) {
    const p = pattern.toLowerCase();
    const v = value.toLowerCase();
    if (!p.includes('*'))
        return p === v;
    const parts = p.split('*');
    let pos = 0;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === 0) {
            // First segment must match at start
            if (!v.startsWith(part))
                return false;
            pos = part.length;
        }
        else if (i === parts.length - 1) {
            // Last segment must match at end
            if (!v.endsWith(part))
                return false;
        }
        else {
            const idx = v.indexOf(part, pos);
            if (idx === -1)
                return false;
            pos = idx + part.length;
        }
    }
    return true;
}
/**
 * Render the light-tier output profile.
 * Standalone: no compositor concepts, no fleet terminology, no DB required.
 * ~100 tokens. Covers anti-sycophancy, em dash ban, AI vocab ban, length targets,
 * anti-pagination, and evidence calibration.
 */
export function renderLightFOS() {
    return [
        '## Output Standard',
        '- Lead with the answer. Conclusion first, reasoning after.',
        '- No sycophantic openings: never start with "Great question", "Certainly", "Absolutely", "Of course".',
        '- No em dashes. Use commas, colons, semicolons, or periods.',
        '- Avoid AI vocabulary: delve, tapestry, pivotal, fostering, leverage, robust, noteworthy, realm, harness, showcase.',
        '- Simple answers: 1-3 sentences. Analysis: 200-500 words. Code: code first, explain only non-obvious parts.',
        '- Every sentence states a fact, makes a decision, or advances an argument. Cut filler.',
        '- Do not paginate short answers. No headers, sections, or bullet lists unless the content requires structure.',
        '- Numbers over adjectives. Match confidence to evidence.',
    ];
}
/** @deprecated Use renderLightFOS */
export function renderStarterFOS() {
    return renderLightFOS();
}
/**
 * Resolve the effective output standard tier given compositor config.
 * MOD is only eligible at the 'fleet' tier.
 */
export function resolveOutputTier(outputProfile, enableFOS, enableMOD) {
    // Legacy path: if outputProfile is not set, honor enableFOS/enableMOD directly
    if (outputProfile === undefined) {
        return {
            tier: 'full',
            fos: enableFOS !== false,
            mod: enableMOD !== false,
        };
    }
    // Backward compat: map old names to new
    const tier = outputProfile === 'starter' ? 'light'
        : outputProfile === 'fleet' ? 'full'
            : outputProfile;
    switch (tier) {
        case 'light':
            return { tier: 'light', fos: false, mod: false };
        case 'standard':
            return { tier: 'standard', fos: true, mod: false };
        case 'full':
            return { tier: 'full', fos: true, mod: enableMOD !== false };
        default:
            return { tier: 'full', fos: true, mod: enableMOD !== false };
    }
}
export function renderFOS(fos, taskContext) {
    const budget = fos.token_budget || FOS_TOKEN_BUDGET;
    const d = fos.directives;
    const lines = ['## Output Standard (Fleet)'];
    // Structural rules
    if (d.structural?.length) {
        for (const rule of d.structural) {
            lines.push(`- ${rule}`);
        }
    }
    // Anti-patterns — condense into one line for density
    if (d.anti_patterns?.length) {
        lines.push(`Never: ${d.anti_patterns.join('; ')}`);
    }
    // Density targets — check for task variant override first
    const variant = taskContext ? fos.task_variants[taskContext] : undefined;
    if (variant) {
        if (variant.density_target) {
            lines.push(`Density: ${variant.density_target}`);
        }
        if (variant.structure) {
            lines.push(`Structure: ${variant.structure}`);
        }
        if (variant.list_cap) {
            lines.push(`List cap: ${variant.list_cap}`);
        }
    }
    else if (d.density_targets) {
        const parts = Object.entries(d.density_targets)
            .map(([k, v]) => `${k[0].toUpperCase() + k.slice(1)}: ${v}`)
            .join('. ');
        if (parts)
            lines.push(parts + '.');
    }
    // Voice rules
    if (d.voice?.length) {
        for (const rule of d.voice) {
            lines.push(`- ${rule}`);
        }
    }
    return truncateLines(lines, budget);
}
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
export function renderMOD(mod, fos, modelId, taskContext) {
    const budget = mod.token_budget || MOD_TOKEN_BUDGET;
    const lines = [`## Output Calibration (${modelId})`];
    // Calibration summary first (tendencies are the "known state")
    if (mod.calibration.length > 0) {
        const tendencies = mod.calibration.map(c => c.model_tendency).join(', ');
        lines.push(`Known tendencies: ${tendencies}`);
    }
    // Calibration adjustments
    for (const cal of mod.calibration) {
        if (cal.adjustment) {
            lines.push(`- ${cal.adjustment}`);
        }
    }
    // Corrections — hard severity first, then medium
    const sorted = [...mod.corrections].sort((a, b) => {
        const order = { hard: 0, medium: 1, soft: 2 };
        return (order[a.severity] ?? 2) - (order[b.severity] ?? 2);
    });
    for (const correction of sorted) {
        lines.push(`- ${correction.rule}`);
    }
    // Task-specific overrides (if taskContext provided and overrides exist)
    if (taskContext && mod.task_overrides[taskContext]) {
        const override = mod.task_overrides[taskContext];
        for (const [, v] of Object.entries(override)) {
            lines.push(`- [${taskContext}] ${v}`);
        }
    }
    void fos; // fos reserved for future cross-calibration
    return truncateLines(lines, budget);
}
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
export function buildActionVerificationSummary(messages, pressurePct) {
    if (pressurePct >= 95)
        return '';
    const maxActions = pressurePct < 80 ? 5 :
        pressurePct < 90 ? 3 : 1;
    // Build an index of tool_use → result by scanning all messages
    // tool_use: messages with toolCalls
    // tool_result: messages with toolResults
    // Match by tool_use_id (NeutralToolCall.id === NeutralToolResult.callId)
    // Collect all tool_use entries in order (newest first)
    const toolPairs = [];
    // Walk newest to oldest to get the most recent actions first
    for (let i = messages.length - 1; i >= 0 && toolPairs.length < maxActions; i--) {
        const msg = messages[i];
        if (!msg.toolCalls || msg.toolCalls.length === 0)
            continue;
        for (const tc of msg.toolCalls) {
            if (toolPairs.length >= maxActions)
                break;
            // Find the matching tool_result by callId
            let resultContent;
            // Search forward from this message for the result
            for (let j = i; j < messages.length; j++) {
                const resultMsg = messages[j];
                if (!resultMsg.toolResults)
                    continue;
                const match = resultMsg.toolResults.find(r => r.callId === tc.id);
                if (match) {
                    resultContent = match.content ?? '';
                    break;
                }
            }
            // Only include verified pairs (tool_use + matching tool_result)
            if (resultContent === undefined)
                continue;
            // Truncate result to 100 chars
            const raw = resultContent.replace(/\s+/g, ' ').trim();
            const summary = raw.length > 100 ? raw.slice(0, 100) + '\u2026' : raw;
            toolPairs.push({ name: tc.name, resultSummary: summary });
        }
    }
    if (toolPairs.length === 0)
        return '';
    const TOKEN_BUDGET = 150;
    const lines = ['## Recent Actions'];
    for (const pair of toolPairs) {
        const line = `- ${pair.name}: ${pair.resultSummary}`;
        const currentCost = estimateTokens(lines.join('\n') + '\n' + line);
        if (currentCost > TOKEN_BUDGET)
            break;
        lines.push(line);
    }
    // If only the header was added (no pairs fit), return empty
    if (lines.length <= 1)
        return '';
    return lines.join('\n');
}
/**
 * Record output metrics for analytics.
 * Best-effort: logs errors but never throws.
 */
export function recordOutputMetrics(db, metrics) {
    try {
        const now = new Date().toISOString();
        db.prepare(`
      INSERT OR REPLACE INTO output_metrics (
        id, timestamp, agent_id, session_key, model_id, provider,
        fos_version, mod_version, mod_id, task_type,
        output_tokens, input_tokens, cache_read_tokens,
        corrections_fired, latency_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(metrics.id, metrics.timestamp, metrics.agent_id, metrics.session_key, metrics.model_id, metrics.provider, metrics.fos_version ?? null, metrics.mod_version ?? null, metrics.mod_id ?? null, metrics.task_type ?? null, metrics.output_tokens, metrics.input_tokens ?? null, metrics.cache_read_tokens ?? null, JSON.stringify(metrics.corrections_fired ?? []), metrics.latency_ms ?? null, now);
    }
    catch (err) {
        // Non-fatal — metrics are optional
        console.warn('[fos-mod] recordOutputMetrics failed:', err.message);
    }
}
//# sourceMappingURL=fos-mod.js.map