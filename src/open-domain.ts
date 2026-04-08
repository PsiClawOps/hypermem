/**
 * open-domain.ts — Open-domain query detection and FTS5 retrieval
 *
 * LoCoMo benchmark open-domain questions are broad, exploratory, and have no
 * topical anchor. They span the full conversation history and require content
 * that may have been filtered out by the quality gate (isQualityFact). The
 * fix: detect open-domain queries and run a separate FTS5 search against raw
 * messages_fts, bypassing the quality filter entirely.
 *
 * Detection heuristics (conservative — false positives add noise):
 *   - Short query with no named entities (no TitleCase tokens)
 *   - Broad interrogative patterns (what did, how did, tell me about, etc.)
 *   - No temporal signals (those go to the temporal retrieval path)
 *   - No specific identifiers (URLs, IDs, ticket numbers, version strings)
 *
 * Retrieval: MessageStore.searchMessages() against messages_fts — covers all
 * raw message history regardless of quality gate.
 */

import type { DatabaseSync } from 'node:sqlite';

// ── Open-domain signal patterns ───────────────────────────────────────────

const BROAD_INTERROGATIVE = /\b(what did|what does|what has|what was|what were|what is|how did|how does|how has|tell me about|describe|explain|summarize|overview|recap|what do you know about|what have|who is|who was|who did)\b/i;

const SPECIFIC_ANCHOR = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})+|v\d+\.\d+|#\d{2,}|https?:\/\/|[A-Z]{2,}-\d+)\b/;

const TEMPORAL_SIGNALS = /\b(before|after|when|last\s+\w+|yesterday|today|recently|between|since|until|ago|this\s+week|this\s+month|in\s+(january|february|march|april|may|june|july|august|september|october|november|december))\b/i;

/**
 * Returns true if the query looks like an open-domain question:
 * broad, exploratory, no specific anchors, no temporal signals.
 */
export function isOpenDomainQuery(query: string): boolean {
  if (!query || query.trim().length < 8) return false;

  // Has temporal signals → temporal path handles it
  if (TEMPORAL_SIGNALS.test(query)) return false;

  // Has specific named entity / version / ticket anchor → not open-domain
  if (SPECIFIC_ANCHOR.test(query)) return false;

  // Must match a broad interrogative pattern
  if (!BROAD_INTERROGATIVE.test(query)) return false;

  // Sanity: query should not be too long (long queries are usually specific)
  const wordCount = query.trim().split(/\s+/).length;
  if (wordCount > 20) return false;

  return true;
}

// ── FTS5 query builder ────────────────────────────────────────────────────

/**
 * Build a FTS5 MATCH query from a broad question.
 * Strips stop words, question words, and punctuation.
 * Returns up to 6 prefix-matched terms joined with OR.
 */
export function buildOpenDomainFtsQuery(query: string): string | null {
  const STOP_WORDS = new Set([
    'what', 'did', 'does', 'has', 'was', 'were', 'is', 'are', 'how',
    'tell', 'me', 'about', 'describe', 'explain', 'summarize', 'overview',
    'recap', 'who', 'do', 'you', 'know', 'have', 'the', 'a', 'an', 'of',
    'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but', 'with', 'from',
  ]);

  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    .slice(0, 6)
    .map(w => `${w}*`);

  if (terms.length === 0) return null;
  return terms.join(' OR ');
}

// ── Open-domain FTS retrieval ─────────────────────────────────────────────

export interface OpenDomainResult {
  role: string;
  content: string;
  createdAt: string;
}

/**
 * Search raw message history via FTS5 for open-domain queries.
 * Returns up to `limit` matching messages, deduplicated against existing context.
 *
 * @param db — agent messages DB (contains messages_fts)
 * @param query — the user's query
 * @param existingContent — already-assembled context (for dedup)
 * @param limit — max results (default 10)
 */
export function searchOpenDomain(
  db: DatabaseSync,
  query: string,
  existingContent: string,
  limit: number = 10,
): OpenDomainResult[] {
  const ftsQuery = buildOpenDomainFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    const rows = db.prepare(`
      WITH fts_matches AS (
        SELECT rowid, rank
        FROM messages_fts
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      )
      SELECT
        m.role,
        m.text_content AS content,
        m.created_at AS createdAt
      FROM messages m
      JOIN fts_matches ON m.id = fts_matches.rowid
      WHERE m.text_content IS NOT NULL
        AND m.text_content != ''
        AND m.is_heartbeat = 0
      ORDER BY fts_matches.rank
    `).all(ftsQuery, limit * 2) as unknown as OpenDomainResult[];

    // Deduplicate against existing context and filter short content
    const seen = new Set<string>();
    const results: OpenDomainResult[] = [];

    for (const row of rows) {
      if (!row.content || row.content.trim().length < 20) continue;
      const fingerprint = row.content.slice(0, 80);
      if (seen.has(fingerprint)) continue;
      if (existingContent.includes(fingerprint)) continue;
      seen.add(fingerprint);
      results.push(row);
      if (results.length >= limit) break;
    }

    return results;
  } catch {
    // FTS query may fail on special characters — degrade silently
    return [];
  }
}
