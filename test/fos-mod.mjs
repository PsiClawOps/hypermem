/**
 * FOS/MOD Unit Tests
 *
 * Tests for getActiveFOS, matchMOD, renderFOS, renderMOD, recordOutputMetrics
 * from fos-mod.ts. Validates:
 *   - matchMOD hierarchy: exact → glob → wildcard
 *   - matchMOD with null/undefined falls through to wildcard default
 *   - renderFOS respects token_budget
 *   - renderMOD respects token_budget
 *   - renderFOS applies task_variants when taskContext provided
 *   - Seeded builtins exist after migration
 *   - Only one FOS active at a time
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getActiveFOS, matchMOD, renderFOS, renderMOD, recordOutputMetrics, buildActionVerificationSummary } from '../dist/fos-mod.js';
import { migrateLibrary } from '../dist/library-schema.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

function assertEq(actual, expected, msg) {
  if (actual === expected) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.log(`  ❌ FAIL: ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── Test DB setup ─────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-fos-mod-'));
const dbPath = path.join(tmpDir, 'library.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
migrateLibrary(db, '0.5.0');

// ── Seeded builtins exist after migration ─────────────────────

console.log('\n── Seeded Builtins ──');

const fos = getActiveFOS(db);
assert(fos !== null, 'getActiveFOS() returns a non-null record after migration');
assertEq(fos?.id, 'psiclawops-default', 'Active FOS id is psiclawops-default');
assertEq(fos?.active, 1, 'Active FOS has active=1');

// Count MODs
const modRows = db.prepare('SELECT id FROM model_output_directives ORDER BY id').all();
assert(modRows.length >= 5, `At least 5 MOD profiles seeded (got ${modRows.length}): ${modRows.map(r => r.id).join(', ')}`);

const modIds = modRows.map(r => r.id);
assert(modIds.includes('gpt-5.4'), 'gpt-5.4 MOD exists');
assert(modIds.includes('claude-opus-4.6'), 'claude-opus-4.6 MOD exists');
assert(modIds.includes('claude-sonnet-4.6'), 'claude-sonnet-4.6 MOD exists');
assert(modIds.includes('gemini-3.1'), 'gemini-3.1 MOD exists');
assert(modIds.includes('default'), 'default (*) MOD exists');

// ── Only one FOS active at a time ─────────────────────────────

console.log('\n── Single Active FOS ──');

const activeCount = db.prepare("SELECT COUNT(*) AS c FROM fleet_output_standard WHERE active = 1").get();
assertEq(activeCount?.c, 1, 'Exactly one FOS profile is active');

// Insert a second FOS profile, set active=1 — active count should go to 2 (constraint check)
// In a real system, an upsert path would deactivate others. This test verifies enforcement isn't
// implicit — the API contract is that callers must not activate two at once.
const now = new Date().toISOString();
db.prepare(`
  INSERT INTO fleet_output_standard (id, name, directives, task_variants, token_budget, active, source, version, created_at, updated_at)
  VALUES ('test-second', 'Test Second', '{}', '{}', 250, 0, 'test', 1, ?, ?)
`).run(now, now);

const activeCountAfter = db.prepare("SELECT COUNT(*) AS c FROM fleet_output_standard WHERE active = 1").get();
assertEq(activeCountAfter?.c, 1, 'Still only one FOS active after inserting an inactive second profile');

// ── matchMOD hierarchy ────────────────────────────────────────

console.log('\n── matchMOD Hierarchy ──');

// Exact match on id
const exactMatch = matchMOD('gpt-5.4', db);
assert(exactMatch !== null, 'matchMOD("gpt-5.4") returns non-null (exact id match)');
assertEq(exactMatch?.id, 'gpt-5.4', 'matchMOD("gpt-5.4") matches gpt-5.4 MOD by id');

// Glob match: 'gpt-5.4-turbo' should match 'gpt-5.4*'
const globMatch = matchMOD('gpt-5.4-turbo', db);
assert(globMatch !== null, 'matchMOD("gpt-5.4-turbo") returns non-null (glob match)');
assertEq(globMatch?.id, 'gpt-5.4', 'matchMOD("gpt-5.4-turbo") resolves to gpt-5.4 via gpt-5.4* pattern');

// Glob match: claude-sonnet-4.6-20260401 → claude-sonnet-4*
const claudeGlob = matchMOD('claude-sonnet-4.6-20260401', db);
assert(claudeGlob !== null, 'matchMOD("claude-sonnet-4.6-20260401") returns non-null');
assertEq(claudeGlob?.id, 'claude-sonnet-4.6', 'matchMOD("claude-sonnet-4.6-20260401") resolves to claude-sonnet-4.6');

// Glob match: claude-opus-4.5 → claude-opus-4*
const opusGlob = matchMOD('claude-opus-4.5', db);
assert(opusGlob !== null, 'matchMOD("claude-opus-4.5") returns non-null');
assertEq(opusGlob?.id, 'claude-opus-4.6', 'matchMOD("claude-opus-4.5") resolves to claude-opus-4.6 via claude-opus-4* pattern');

// Wildcard fallback: unknown model → default '*'
const wildcardFallback = matchMOD('unknown-llm-9.0', db);
assert(wildcardFallback !== null, 'matchMOD("unknown-llm-9.0") returns non-null (wildcard fallback)');
assertEq(wildcardFallback?.id, 'default', 'matchMOD("unknown-llm-9.0") falls through to default *');

// ── matchMOD with null/undefined ──────────────────────────────

console.log('\n── matchMOD Null/Undefined ──');

const nullMatch = matchMOD(null, db);
assertEq(nullMatch, null, 'matchMOD(null) returns null (no modelId to match)');

const undefinedMatch = matchMOD(undefined, db);
assertEq(undefinedMatch, null, 'matchMOD(undefined) returns null');

// ── renderFOS token_budget ────────────────────────────────────

console.log('\n── renderFOS Token Budget ──');

const fosFull = getActiveFOS(db);
assert(fosFull !== null, 'Active FOS available for renderFOS test');

const fosLines = renderFOS(fosFull);
assert(Array.isArray(fosLines) && fosLines.length > 0, 'renderFOS returns non-empty array');
assert(fosLines[0].startsWith('## Output Standard'), 'First line is the section header');

// Estimate total tokens
const totalChars = fosLines.join('\n').length;
const estimatedTokens = Math.ceil(totalChars / 4);
assert(estimatedTokens <= fosFull.token_budget, `renderFOS respects token_budget (${estimatedTokens} <= ${fosFull.token_budget})`);

// Test with tiny budget — must truncate
const tinyFOS = { ...fosFull, token_budget: 20 };
const tinyLines = renderFOS(tinyFOS);
const tinyChars = tinyLines.join('\n').length;
const tinyTokens = Math.ceil(tinyChars / 4);
assert(tinyTokens <= 20, `renderFOS respects tiny budget (${tinyTokens} <= 20)`);
assert(tinyLines.length >= 1, 'renderFOS with tiny budget returns at least the header');

// ── renderFOS task_variants ───────────────────────────────────

console.log('\n── renderFOS Task Variants ──');

const councilLines = renderFOS(fosFull, 'council-deliberation');
assert(Array.isArray(councilLines), 'renderFOS("council-deliberation") returns array');
const councilText = councilLines.join('\n');
assert(councilText.includes('400-800'), 'council-deliberation variant includes density_target text (400-800)');

const codeLines = renderFOS(fosFull, 'code-generation');
const codeText = codeLines.join('\n');
assert(codeText.includes('prose') || codeText.includes('code'), 'code-generation variant includes relevant guidance');

const quickLines = renderFOS(fosFull, 'quick-answer');
const quickText = quickLines.join('\n');
assert(quickText.includes('1-3'), 'quick-answer variant includes 1-3 sentence density target');

// Unknown task context — falls back to defaults
const unknownLines = renderFOS(fosFull, 'totally-unknown-context');
assert(Array.isArray(unknownLines) && unknownLines.length > 0, 'Unknown taskContext falls back to default rendering');

// ── renderMOD token_budget ────────────────────────────────────

console.log('\n── renderMOD Token Budget ──');

const gptMod = matchMOD('gpt-5.4', db);
assert(gptMod !== null, 'gpt-5.4 MOD available for renderMOD test');

const modLines = renderMOD(gptMod, fosFull, 'gpt-5.4');
assert(Array.isArray(modLines) && modLines.length > 0, 'renderMOD returns non-empty array');
assert(modLines[0].includes('gpt-5.4'), 'First line includes model id');

const modChars = modLines.join('\n').length;
const modTokens = Math.ceil(modChars / 4);
assert(modTokens <= gptMod.token_budget, `renderMOD respects token_budget (${modTokens} <= ${gptMod.token_budget})`);

// Test with tiny budget
const tinyMOD = { ...gptMod, token_budget: 15 };
const tinyModLines = renderMOD(tinyMOD, fosFull, 'gpt-5.4');
const tinyModChars = tinyModLines.join('\n').length;
const tinyModTokens = Math.ceil(tinyModChars / 4);
assert(tinyModTokens <= 15, `renderMOD respects tiny budget (${tinyModTokens} <= 15)`);

// renderMOD with null fos is safe
const modWithNullFos = renderMOD(gptMod, null, 'gpt-5.4');
assert(Array.isArray(modWithNullFos), 'renderMOD with null fos returns array without throwing');

// ── recordOutputMetrics ───────────────────────────────────────

console.log('\n── recordOutputMetrics ──');

const metricId = `test-metric-${Date.now()}`;
recordOutputMetrics(db, {
  id: metricId,
  timestamp: now,
  agent_id: 'alice',
  session_key: 'agent:alice:webchat:test',
  model_id: 'gpt-5.4',
  provider: 'openai',
  fos_version: 1,
  mod_version: 1,
  mod_id: 'gpt-5.4',
  task_type: 'quick-answer',
  output_tokens: 42,
  input_tokens: 1000,
  corrections_fired: ['plan-loop'],
  latency_ms: 500,
});

const recorded = db.prepare('SELECT * FROM output_metrics WHERE id = ?').get(metricId);
assert(recorded !== undefined, 'recordOutputMetrics inserts a row');
assertEq(recorded?.agent_id, 'alice', 'Metric agent_id is alice');
assertEq(recorded?.model_id, 'gpt-5.4', 'Metric model_id is gpt-5.4');
assertEq(recorded?.output_tokens, 42, 'Metric output_tokens is 42');

// recordOutputMetrics is non-throwing on bad db scenario (test with missing table — skip for now)
// At minimum: duplicate insert should log warning but not throw
recordOutputMetrics(db, {
  id: metricId, // duplicate id
  timestamp: now,
  agent_id: 'alice',
  session_key: 'test',
  model_id: 'gpt-5.4',
  provider: 'openai',
  output_tokens: 0,
});
assert(true, 'recordOutputMetrics with duplicate id does not throw (best-effort)');

// ── FOS Confabulation Guard ──────────────────────────────────

console.log('\n── FOS Confabulation Guard ──');

const fosForGuard = getActiveFOS(db);
assert(fosForGuard !== null, 'Active FOS available for confabulation guard test');
const antiPatterns = fosForGuard?.directives?.anti_patterns ?? [];
assert(
  antiPatterns.some(p => p.toLowerCase().includes('unverifiable')),
  'FOS anti_patterns includes confabulation guard: no unverifiable references'
);
assert(
  antiPatterns.some(p => p.toLowerCase().includes('tool results')),
  'FOS anti_patterns includes confabulation guard: no claiming actions without tool results'
);
assert(
  antiPatterns.some(p => p.toLowerCase().includes('attributing')),
  'FOS anti_patterns includes confabulation guard: no attributing statements without quoting'
);

// ── buildActionVerificationSummary ───────────────────────────

console.log('\n── buildActionVerificationSummary ──');

// Helper: build a NeutralMessage tool-use/result pair
function makeToolPair(id, name, resultContent) {
  const useMsg = {
    role: 'assistant',
    textContent: null,
    toolCalls: [{ id, name, arguments: '{}' }],
    toolResults: null,
  };
  const resultMsg = {
    role: 'tool',
    textContent: null,
    toolCalls: null,
    toolResults: [{ callId: id, name, content: resultContent }],
  };
  return [useMsg, resultMsg];
}

// Build a message array with 6 tool pairs
const allPairs = [];
for (let i = 1; i <= 6; i++) {
  allPairs.push(...makeToolPair(`id-${i}`, `tool_${i}`, `result for tool ${i} with some content`));
}

// Low pressure (<80%): should render up to 5 actions
const summaryLow = buildActionVerificationSummary(allPairs, 50);
assert(typeof summaryLow === 'string', 'buildActionVerificationSummary returns a string at low pressure');
assert(summaryLow.startsWith('## Recent Actions'), 'Low pressure summary starts with ## Recent Actions header');
const lowLines = summaryLow.split('\n').filter(l => l.startsWith('- '));
assert(lowLines.length <= 5, `Low pressure renders at most 5 actions (got ${lowLines.length})`);
assert(lowLines.length >= 1, `Low pressure renders at least 1 action (got ${lowLines.length})`);

// 80% pressure: should render at most 3 actions
const summary80 = buildActionVerificationSummary(allPairs, 80);
assert(typeof summary80 === 'string', 'buildActionVerificationSummary returns a string at 80% pressure');
const lines80 = summary80.split('\n').filter(l => l.startsWith('- '));
assert(lines80.length <= 3, `80% pressure renders at most 3 actions (got ${lines80.length})`);

// 90% pressure: should render at most 1 action
const summary90 = buildActionVerificationSummary(allPairs, 90);
assert(typeof summary90 === 'string', 'buildActionVerificationSummary returns a string at 90% pressure');
const lines90 = summary90.split('\n').filter(l => l.startsWith('- '));
assert(lines90.length <= 1, `90% pressure renders at most 1 action (got ${lines90.length})`);

// 95%+ pressure: must return empty string
const summary95 = buildActionVerificationSummary(allPairs, 95);
assertEq(summary95, '', '95% pressure returns empty string (drop entirely)');

const summary99 = buildActionVerificationSummary(allPairs, 99);
assertEq(summary99, '', '99% pressure returns empty string');

// Missing tool_result (tool_use with no matching result): should be skipped
const orphanPairs = [
  {
    role: 'assistant',
    textContent: null,
    toolCalls: [{ id: 'orphan-1', name: 'orphan_tool', arguments: '{}' }],
    toolResults: null,
  },
  // No matching result message
  ...makeToolPair('matched-1', 'real_tool', 'real result'),
];
const summaryOrphan = buildActionVerificationSummary(orphanPairs, 50);
assert(typeof summaryOrphan === 'string', 'buildActionVerificationSummary handles missing tool_result gracefully');
const orphanLines = summaryOrphan.split('\n').filter(l => l.startsWith('- '));
assert(
  orphanLines.every(l => !l.includes('orphan_tool')),
  'Unverified tool_use (no matching result) is excluded from summary'
);
assert(
  orphanLines.some(l => l.includes('real_tool')),
  'Verified tool pair (real_tool) is included in summary'
);

// Empty message array: should return empty string
const summaryEmpty = buildActionVerificationSummary([], 50);
assertEq(summaryEmpty, '', 'Empty message array returns empty string');

// Result truncated at 100 chars
const longResult = 'x'.repeat(200);
const longPairs = makeToolPair('long-1', 'long_tool', longResult);
const summaryLong = buildActionVerificationSummary(longPairs, 50);
assert(summaryLong.includes('\u2026'), 'Long result is truncated with ellipsis at 100 chars');
const longLine = summaryLong.split('\n').find(l => l.startsWith('- long_tool:'));
assert(longLine !== undefined, 'Long tool result appears in summary');
assert(longLine.length < 150, 'Truncated result line is under 150 chars');

// ── Cleanup ───────────────────────────────────────────────────

try {
  db.close();
  fs.rmSync(tmpDir, { recursive: true });
} catch { /* ignore */ }

// ── Summary ──────────────────────────────────────────────────

console.log(`\n── FOS/MOD Results: ${passed} passed, ${failed} failed ──\n`);

if (failed > 0) {
  process.exit(1);
}
