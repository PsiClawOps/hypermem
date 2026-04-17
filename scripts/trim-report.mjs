#!/usr/bin/env node
/**
 * HyperMem Trim Telemetry Report
 *
 * Parses a HyperMem telemetry JSONL stream (captured with HYPERMEM_TELEMETRY=1)
 * and emits a per-turn summary:
 *   - compose count  (assembleTrace events)
 *   - trim count     (trimTelemetry events)
 *   - tokens removed (pre - post, summed)
 *   - afterTurn -> next-assemble churn pattern flag
 *
 * The churn pattern is defined as: an `afterTurn.secondary` trim event
 * followed (within the same agent/sessionKey) by an `assemble.*` trim event
 * at the very next assembleTrace boundary. This matches the failure mode
 * Sprint 1 is hunting: afterTurn pre-trims, and the immediately following
 * assemble() re-trims the same (or nearby) window on entry.
 *
 * Usage:
 *   node scripts/trim-report.mjs [--input <path>] [--json]
 *
 * Defaults:
 *   --input defaults to $HYPERMEM_TELEMETRY_PATH, falling back to
 *           ./hypermem-telemetry.jsonl
 *   Output is a human-readable table unless --json is passed.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = { input: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/trim-report.mjs [--input <path>] [--json]');
      process.exit(0);
    }
  }
  return out;
}

function resolveInputPath(fromArg) {
  if (fromArg) return fromArg;
  if (process.env.HYPERMEM_TELEMETRY_PATH) return process.env.HYPERMEM_TELEMETRY_PATH;
  return path.resolve(process.cwd(), 'hypermem-telemetry.jsonl');
}

function readJsonl(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`telemetry file not found: ${inputPath}`);
  }
  const raw = fs.readFileSync(inputPath, 'utf8');
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines — the stream is append-only and partial writes
      // can produce a final truncated line.
    }
  }
  return events;
}

/**
 * Group events into per-turn buckets. A "turn" boundary is an assembleTrace
 * event. Every event up to (but not including) the next assembleTrace
 * belongs to the current turn. Events that appear before the first
 * assembleTrace are grouped into a synthetic "preamble" turn.
 *
 * The churn detector operates across turn boundaries: an afterTurn.secondary
 * in turn N paired with any assemble.* trim event in turn N+1 for the same
 * (agentId, sessionKey) triggers the churn flag on turn N+1.
 */
function buildReport(events) {
  const turns = [];
  let current = null;
  const startTurn = (meta) => {
    if (current) turns.push(current);
    current = {
      turnId: meta?.turnId ?? null,
      agentId: meta?.agentId ?? null,
      sessionKey: meta?.sessionKey ?? null,
      path: meta?.path ?? null,
      toolLoop: Boolean(meta?.toolLoop),
      msgCount: meta?.msgCount ?? null,
      composeCount: meta ? 1 : 0,
      trimCount: 0,
      tokensRemoved: 0,
      trims: [],
      churn: false,
    };
  };
  startTurn(null); // synthetic preamble

  for (const ev of events) {
    if (ev.event === 'assemble') {
      startTurn(ev);
    } else if (ev.event === 'trim') {
      current.trimCount++;
      const delta = Math.max(0, (ev.preTokens ?? 0) - (ev.postTokens ?? 0));
      current.tokensRemoved += delta;
      current.trims.push({
        path: ev.path,
        removed: ev.removed ?? 0,
        preTokens: ev.preTokens ?? 0,
        postTokens: ev.postTokens ?? 0,
        cacheInvalidated: Boolean(ev.cacheInvalidated),
        reason: ev.reason ?? '',
        agentId: ev.agentId ?? null,
        sessionKey: ev.sessionKey ?? null,
      });
    }
  }
  if (current) turns.push(current);

  // Churn detection: afterTurn.secondary in turn N, followed by any
  // assemble.* trim event in turn N+1 for the same (agentId, sessionKey).
  for (let i = 0; i + 1 < turns.length; i++) {
    const a = turns[i];
    const b = turns[i + 1];
    const hasAfterTurnSecondary = a.trims.some(t => t.path === 'afterTurn.secondary');
    if (!hasAfterTurnSecondary) continue;
    const aKey = a.trims.find(t => t.path === 'afterTurn.secondary');
    const matchesNextAssemble = b.trims.some(t =>
      t.path.startsWith('assemble.') &&
      (!aKey || (t.agentId === aKey.agentId && t.sessionKey === aKey.sessionKey))
    );
    if (matchesNextAssemble) {
      b.churn = true;
    }
  }

  const totals = {
    turns: turns.length,
    composeCount: turns.reduce((s, t) => s + t.composeCount, 0),
    trimCount: turns.reduce((s, t) => s + t.trimCount, 0),
    tokensRemoved: turns.reduce((s, t) => s + t.tokensRemoved, 0),
    churnTurns: turns.filter(t => t.churn).length,
  };
  return { turns, totals };
}

function renderText(report, inputPath) {
  const lines = [];
  lines.push('═══════════════════════════════════════════════════');
  lines.push('  HyperMem Trim Telemetry Report');
  lines.push('═══════════════════════════════════════════════════');
  lines.push(`Input:   ${inputPath}`);
  lines.push(`Turns:   ${report.totals.turns}   Compose: ${report.totals.composeCount}   ` +
             `Trims: ${report.totals.trimCount}   Tokens removed: ${report.totals.tokensRemoved}   ` +
             `Churn turns: ${report.totals.churnTurns}`);
  lines.push('');
  lines.push('Per-turn summary:');
  lines.push('  # | path      | tL | trims | pre→post | removed | churn | turnId');
  lines.push('  --+-----------+----+-------+----------+---------+-------+---------');
  report.turns.forEach((t, i) => {
    const pathStr = (t.path ?? '-').padEnd(9);
    const tl = t.toolLoop ? 'Y' : 'n';
    const pre = t.trims.length > 0 ? String(t.trims[0].preTokens) : '-';
    const post = t.trims.length > 0 ? String(t.trims[t.trims.length - 1].postTokens) : '-';
    const churn = t.churn ? 'YES' : '   ';
    lines.push(
      `  ${String(i).padStart(2)} | ${pathStr} | ${tl}  | ${String(t.trimCount).padStart(5)} | ` +
      `${String(pre).padStart(4)}→${String(post).padEnd(4)} | ${String(t.tokensRemoved).padStart(7)} | ` +
      ` ${churn}  | ${t.turnId ?? '-'}`
    );
    if (t.trims.length > 0) {
      for (const tr of t.trims) {
        lines.push(`       └ ${tr.path.padEnd(22)} removed=${tr.removed} reason=${tr.reason}`);
      }
    }
  });
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolveInputPath(args.input);
  const events = readJsonl(inputPath);
  const report = buildReport(events);
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderText(report, inputPath) + '\n');
  }
  // Non-zero exit if churn detected, so the script can gate CI tests.
  if (report.totals.churnTurns > 0) process.exit(2);
}

main();
