#!/usr/bin/env node
/**
 * preflight-trim-sessions.js
 *
 * Pre-flight script: truncates oversized JSONL session transcripts before
 * the gateway loads them. Run this before `openclaw gateway start/restart`.
 *
 * Why this exists:
 *   HyperMem's in-session compaction (nuclear path, pressure-tiered trim,
 *   afterTurn) all fire AFTER a session is loaded into the runtime context
 *   window. If a session JSONL is large enough to fill the context on load
 *   (the "EC1 JSONL replay saturation" failure mode), those guards are
 *   unreachable — all tool calls strip before any hook can fire.
 *
 *   This script solves the problem at the source: trim the JSONL on disk
 *   to a safe depth before the gateway reads it.
 *
 * Usage:
 *   node preflight-trim-sessions.js [--dry-run] [--agents agent1,agent2]
 *
 * Options:
 *   --dry-run       Report what would be trimmed without writing anything
 *   --agents        Comma-separated list of agent IDs to check (default: all)
 *   --max-messages  Max conversation messages to keep per session (default: 60)
 *   --budget-pct    Trim any JSONL whose line count exceeds this % of max-messages
 *                   (default: 150, i.e. trim if over 90 lines when max=60)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const AGENTS_DIR = path.join(OPENCLAW_DIR, 'agents');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const MAX_MESSAGES = parseInt(args.find(a => a.startsWith('--max-messages='))?.split('=')[1] ?? '60', 10);
const BUDGET_PCT = parseInt(args.find(a => a.startsWith('--budget-pct='))?.split('=')[1] ?? '150', 10);
const AGENTS_FILTER = args.find(a => a.startsWith('--agents='))?.split('=')[1]?.split(',') ?? null;

const TRIM_THRESHOLD = Math.floor(MAX_MESSAGES * (BUDGET_PCT / 100));

function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(msg, rawLine) {
  // Use raw line length as primary estimator — it's reliable regardless of
  // field structure (OpenClaw JSONL stores content in various shapes).
  // Field-level parsing is a cross-check only.
  const rawEstimate = rawLine ? Math.ceil(rawLine.length / 4) : 0;
  if (!msg || typeof msg !== 'object') return rawEstimate;
  let fieldEstimate = 0;
  if (typeof msg.content === 'string') fieldEstimate += estimateTokens(msg.content);
  if (Array.isArray(msg.content)) {
    for (const c of msg.content) {
      if (typeof c?.text === 'string') fieldEstimate += estimateTokens(c.text);
    }
  }
  if (typeof msg.textContent === 'string') fieldEstimate += estimateTokens(msg.textContent);
  if (msg.toolResults) fieldEstimate += Math.ceil(JSON.stringify(msg.toolResults).length / 4);
  if (msg.toolCalls) fieldEstimate += Math.ceil(JSON.stringify(msg.toolCalls).length / 4);
  // Take the max — whichever is higher is more likely correct
  return Math.max(rawEstimate, fieldEstimate);
}

function trimJsonlFile(filePath, maxMessages, dryRun) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { skipped: true, reason: 'empty' };

  const header = lines[0];
  const messageLines = [];
  const metaLines = [];

  for (let i = 1; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed?.type === 'message') {
        messageLines.push({ line: lines[i], parsed });
      } else {
        metaLines.push(lines[i]);
      }
    } catch {
      metaLines.push(lines[i]);
    }
  }

  // Token-aware trim: keep newest messages within budget
  // Budget: 40% of 128k = 51200 tokens — leaves 60% headroom after system prompt loads
  const tokenBudget = Math.floor(128000 * 0.40);

  // Estimate total tokens using raw line lengths (reliable regardless of field structure)
  const totalEstimatedTokens = messageLines.reduce((sum, m) => sum + estimateMessageTokens(m.parsed?.message ?? m.parsed, m.line), 0);

  // Skip only if BOTH message count AND token count are within safe bounds
  if (messageLines.length <= TRIM_THRESHOLD && totalEstimatedTokens <= tokenBudget) {
    return { skipped: true, reason: `within threshold (${messageLines.length} msgs, ~${totalEstimatedTokens} tokens)` };
  }

  let tokenCount = 0;
  const kept = [];

  for (let i = messageLines.length - 1; i >= 0 && kept.length < maxMessages; i--) {
    const t = estimateMessageTokens(messageLines[i].parsed?.message ?? messageLines[i].parsed, messageLines[i].line);
    if (tokenCount + t > tokenBudget && kept.length > 0) break;
    kept.unshift(messageLines[i].line);
    tokenCount += t;
  }

  const rebuilt = [header, ...metaLines, ...kept].join('\n') + '\n';

  if (!dryRun) {
    const tmpPath = `${filePath}.preflight-${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, rebuilt, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  }

  return {
    trimmed: true,
    before: messageLines.length,
    after: kept.length,
    estimatedTokens: tokenCount,
  };
}

function getActiveSessionFile(agentDir) {
  const sessionsDir = path.join(agentDir, 'sessions');
  const sessionsJson = path.join(sessionsDir, 'sessions.json');
  if (!fs.existsSync(sessionsJson)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(sessionsJson, 'utf-8'));
    // Find the most recently updated session
    let best = null;
    let bestTime = 0;
    for (const [, session] of Object.entries(data)) {
      const t = session.updatedAt ?? 0;
      if (t > bestTime) {
        bestTime = t;
        best = session;
      }
    }
    if (!best?.sessionId) return null;
    const jsonlPath = path.join(sessionsDir, `${best.sessionId}.jsonl`);
    return fs.existsSync(jsonlPath) ? { path: jsonlPath, session: best } : null;
  } catch {
    return null;
  }
}

// Main
if (!fs.existsSync(AGENTS_DIR)) {
  console.error(`Agents dir not found: ${AGENTS_DIR}`);
  process.exit(1);
}

const agents = fs.readdirSync(AGENTS_DIR).filter(d => {
  if (AGENTS_FILTER && !AGENTS_FILTER.includes(d)) return false;
  return fs.statSync(path.join(AGENTS_DIR, d)).isDirectory();
});

console.log(`[preflight-trim] Checking ${agents.length} agents (threshold: ${TRIM_THRESHOLD} msgs, max: ${MAX_MESSAGES})${DRY_RUN ? ' [DRY RUN]' : ''}`);

let trimCount = 0;
let skipCount = 0;

for (const agentId of agents) {
  const agentDir = path.join(AGENTS_DIR, agentId);
  const info = getActiveSessionFile(agentDir);
  if (!info) {
    continue;
  }

  try {
    const result = trimJsonlFile(info.path, MAX_MESSAGES, DRY_RUN);
    if (result.skipped) {
      skipCount++;
    } else {
      trimCount++;
      console.log(`[preflight-trim] ${agentId}: ${result.before} → ${result.after} messages (~${result.estimatedTokens} tokens kept)${DRY_RUN ? ' [would trim]' : ''}`);
    }
  } catch (err) {
    console.warn(`[preflight-trim] ${agentId}: ERROR — ${err.message}`);
  }
}

console.log(`[preflight-trim] Done. Trimmed: ${trimCount}, Skipped: ${skipCount}`);
