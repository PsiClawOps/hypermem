/**
 * hypermem Spawn Context — Subagent Context Inheritance
 *
 * Provides tools to snapshot a parent session's working context and make it
 * available to a spawned subagent at compose time.
 *
 * Usage:
 *   const ctx = await buildSpawnContext(messageStore, docChunkStore, agentId, {
 *     parentSessionKey: 'agent:forge:webchat:main',
 *     workingSnapshot: 10,
 *     documents: ['/path/to/spec.md'],
 *   });
 *   // Inject ctx.parentContextBlock into the subagent task prompt.
 *   // Pass ctx.sessionKey as ComposeRequest.parentSessionKey for doc chunk retrieval.
 *   // When done: docChunkStore.clearSessionChunks(ctx.sessionKey);
 */

import { readFile } from 'node:fs/promises';
import type { MessageStore } from './message-store.js';
import type { DocChunkStore } from './doc-chunk-store.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SpawnContextOptions {
  /** Parent session key to snapshot working context from */
  parentSessionKey: string;
  /** Number of recent turns to include (default 25, max 50) */
  workingSnapshot?: number;
  /** File paths to chunk and inject as session-scoped doc chunks */
  documents?: string[];
  /** Token budget for the entire spawn context (default 4000) */
  budgetTokens?: number;
}

export interface SpawnContext {
  /** Formatted parent context block for injection into subagent task prompt */
  parentContextBlock: string | null;
  /** Session key to use for querying injected doc chunks at compose time */
  sessionKey: string;
  /** Summary of what was injected (for logging) */
  summary: {
    turnsIncluded: number;
    documentsIndexed: number;
    documentsSkipped: string[];
    tokenEstimate: number;
  };
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_WORKING_SNAPSHOT = 25;
const MAX_WORKING_SNAPSHOT = 50;
const DEFAULT_BUDGET_TOKENS = 4000;
const MAX_CHUNK_CHARS = 500;
const CHUNK_OVERLAP_CHARS = 50;

// ─── Helpers ────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text on double-newlines, max 500 chars per chunk, with overlap.
 */
function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length === 0) {
      current = trimmed;
    } else if (current.length + trimmed.length + 2 <= MAX_CHUNK_CHARS) {
      current += '\n\n' + trimmed;
    } else {
      // Flush current chunk
      chunks.push(current);
      // Start new chunk with overlap from end of previous chunk
      const overlap = current.slice(-CHUNK_OVERLAP_CHARS);
      current = (overlap.trim() ? overlap.trim() + '\n\n' : '') + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // If text had no double-newlines or a single large paragraph, split by chars
  if (chunks.length === 0 && text.trim()) {
    let pos = 0;
    const raw = text.trim();
    while (pos < raw.length) {
      const end = Math.min(pos + MAX_CHUNK_CHARS, raw.length);
      chunks.push(raw.slice(pos, end));
      pos += MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS;
    }
  }

  return chunks;
}

// ─── Main Function ───────────────────────────────────────────────

/**
 * Build a spawn context for a subagent by snapshotting the parent session.
 *
 * 1. Generates a unique session key for this spawn.
 * 2. Pulls recent turns from the parent session (L2 messages).
 * 3. Formats them into a compact block for injection into the task prompt.
 * 4. Optionally chunks and indexes documents as session-scoped doc chunks.
 * 5. Returns the context block, spawn session key, and a summary.
 *
 * Errors are handled gracefully — this function never throws.
 */
export async function buildSpawnContext(
  messageStore: MessageStore,
  docChunkStore: DocChunkStore,
  agentId: string,
  options: SpawnContextOptions
): Promise<SpawnContext> {
  const sessionKey = `spawn:${agentId}:${Date.now()}`;
  const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const snapshotN = Math.min(
    options.workingSnapshot ?? DEFAULT_WORKING_SNAPSHOT,
    MAX_WORKING_SNAPSHOT
  );

  const summary = {
    turnsIncluded: 0,
    documentsIndexed: 0,
    documentsSkipped: [] as string[],
    tokenEstimate: 0,
  };

  // ── Step 1: Get recent turns from parent session ─────────────
  let parentContextBlock: string | null = null;

  try {
    let turns = messageStore.getRecentTurns(options.parentSessionKey, snapshotN);

    if (turns.length > 0) {
      // Format turns into compact block
      const formatBlock = (ts: typeof turns): string => {
        const lines: string[] = [
          `## Parent Session Context`,
          `[Last ${ts.length} turns from session ${options.parentSessionKey}]`,
          '',
        ];
        for (const turn of ts) {
          const roleLabel = turn.role === 'user' ? 'User' : 'Assistant';
          const content = turn.content?.trim() || '(empty)';
          lines.push(`${roleLabel}: ${content}`);
        }
        return lines.join('\n');
      };

      let block = formatBlock(turns);
      let tokenEst = estimateTokens(block);

      // If over 60% of budget, truncate from oldest end
      const maxContextTokens = Math.floor(budgetTokens * 0.6);
      if (tokenEst > maxContextTokens) {
        // Binary-ish approach: drop turns from the front until we fit
        while (turns.length > 1 && estimateTokens(formatBlock(turns)) > maxContextTokens) {
          turns = turns.slice(1);
        }
        block = formatBlock(turns);
        tokenEst = estimateTokens(block);
      }

      if (turns.length > 0) {
        parentContextBlock = block;
        summary.turnsIncluded = turns.length;
        summary.tokenEstimate += tokenEst;
      }
    }
  } catch (err) {
    console.warn('[hypermem:spawn-context] Failed to get recent turns:', (err as Error).message);
  }

  // ── Step 2: Index documents as session-scoped doc chunks ─────
  const documents = options.documents ?? [];

  for (const docPath of documents) {
    try {
      const content = await readFile(docPath, 'utf8');
      const chunks = chunkText(content);

      if (chunks.length === 0) {
        summary.documentsSkipped.push(docPath);
        continue;
      }

      docChunkStore.indexDocChunks(agentId, docPath, chunks, { sessionKey });
      summary.documentsIndexed++;

      // Add rough token estimate for documents
      summary.tokenEstimate += estimateTokens(content);
    } catch (err) {
      // File not found or unreadable — skip gracefully
      const msg = (err as Error).message;
      console.warn(`[hypermem:spawn-context] Skipping document "${docPath}": ${msg}`);
      summary.documentsSkipped.push(docPath);
    }
  }

  return {
    parentContextBlock,
    sessionKey,
    summary,
  };
}
