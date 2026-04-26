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
/**
 * Returns true if the query looks like an open-domain question:
 * broad, exploratory, no specific anchors, no temporal signals.
 */
export declare function isOpenDomainQuery(query: string): boolean;
/**
 * Build a FTS5 MATCH query from a broad question.
 * Strips stop words, question words, and punctuation.
 * Returns up to 6 prefix-matched terms joined with OR.
 */
export declare function buildOpenDomainFtsQuery(query: string): string | null;
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
export declare function searchOpenDomain(db: DatabaseSync, query: string, existingContent: string, limit?: number): OpenDomainResult[];
//# sourceMappingURL=open-domain.d.ts.map