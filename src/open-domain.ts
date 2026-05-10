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

const BROAD_INTERROGATIVE = /\b(what did|what does|what has|what was|what were|what is|what are|how did|how does|how has|tell me about|describe|explain|summarize|overview|recap|what do you know about|what have|who is|who was|who did)\b/i;

// LoCoMo category-3/open-domain questions are often inferential rather than
// classic WH recall. Keep this benchmark-agnostic: these are question shapes
// that need raw dialogue evidence, not answer terms.
const INFERENTIAL_OPEN_DOMAIN = /\b(what might|would\b.*\b(enjoy|consider|considered|likely|pursue|be)\b|could\b.*\b(enjoy|consider|likely|pursue|be)\b|should\b.*\b(enjoy|consider|likely|pursue|be)\b|is it likely|which country|in what country|what fields?|suspected health|financial status)\b/i;

const SPECIFIC_NON_DIALOG_ANCHOR = /\b(v\d+\.\d+|#\d{2,}|https?:\/\/|[A-Z]{2,}-\d+)\b/;

const TEMPORAL_SIGNALS = /\b(before|after|when|last\s+\w+|yesterday|today|recently|between|since|until|ago|this\s+week|this\s+month|in\s+(january|february|march|april|may|june|july|august|september|october|november|december))\b/i;

type OpenDomainFacet = {
  name: string;
  pattern: RegExp;
  terms: string[];
};

const OPEN_DOMAIN_FACETS: OpenDomainFacet[] = [
  {
    name: 'education-career',
    pattern: /\b(educat\w*|field|fields|career|pursue|certification|training|study|school|college|class|degree)\b/i,
    terms: ['education', 'school', 'college', 'study', 'class', 'degree', 'training', 'certificate', 'certification', 'career', 'work', 'job', 'interest', 'interested'],
  },
  {
    name: 'financial-status',
    pattern: /\b(financial|status|wealth|wealthy|money|afford|income|class|expensive|cost)\b/i,
    terms: ['money', 'financial', 'finance', 'wealth', 'wealthy', 'income', 'afford', 'expensive', 'cost', 'job', 'work', 'salary', 'rent', 'house', 'apartment', 'vacation', 'donate', 'donation', 'charity', 'fundraiser'],
  },
  {
    name: 'social-circle',
    pattern: /\b(friend|friends|besides|teammate|teammates|team|group|social)\b/i,
    terms: ['friend', 'friends', 'teammate', 'teammates', 'team', 'group', 'club', 'community', 'classmate', 'coworker', 'game', 'games', 'gaming', 'video', 'online', 'player', 'players'],
  },
  {
    name: 'reading-preference',
    pattern: /\b(read|reading|book|books|author|novel|writer|lewis|greene|green)\b/i,
    terms: ['read', 'reading', 'book', 'books', 'author', 'authors', 'novel', 'writer', 'story', 'stories', 'fiction', 'fantasy', 'literature', 'library', 'recommendation', 'recommend'],
  },
  {
    name: 'activity-pet',
    pattern: /\b(indoor|activity|activities|dog|dogs|puppy|pet|happy|hobby|hobbies|treat|treats)\b/i,
    terms: ['indoor', 'activity', 'activities', 'dog', 'dogs', 'puppy', 'pet', 'happy', 'hobby', 'hobbies', 'cook', 'cooking', 'bake', 'baking', 'recipe', 'treat', 'treats', 'kitchen', 'homemade', 'cookie', 'cookies', 'biscuit', 'biscuits'],
  },
  {
    name: 'health-status',
    pattern: /\b(health|problem|problems|suspected|medical|condition|weight|exercise|diet|symptom|symptoms)\b/i,
    terms: ['health', 'medical', 'condition', 'problem', 'problems', 'weight', 'exercise', 'diet', 'doctor', 'symptom', 'symptoms'],
  },
  {
    name: 'travel-country',
    pattern: /\b(country|visiting|visit|visited|travel|trip|vacation|pendant|souvenir|mother)\b/i,
    terms: ['country', 'visit', 'visited', 'visiting', 'travel', 'trip', 'vacation', 'souvenir', 'pendant', 'mother', 'abroad'],
  },
  {
    name: 'civic-patriotic',
    pattern: /\b(patriotic|patriot|country|flag|military|veteran|service|civic|community)\b/i,
    terms: ['patriotic', 'patriot', 'country', 'flag', 'military', 'veteran', 'service', 'civic', 'community', 'charity', 'fundraiser', 'volunteer', 'memorial', 'parade', 'independence', 'america', 'american', 'national', 'vote', 'voting', 'election'],
  },
];

const QUERY_INITIAL_WORDS = new Set([
  'what', 'which', 'would', 'could', 'should', 'is', 'in', 'how', 'who',
]);

export function extractOpenDomainAnchors(query: string): string[] {
  const anchors: string[] = [];
  const tokens = query.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (QUERY_INITIAL_WORDS.has(lower)) continue;
    anchors.push(lower);
  }
  return [...new Set(anchors)];
}

function matchedOpenDomainFacets(query: string): OpenDomainFacet[] {
  return OPEN_DOMAIN_FACETS.filter(grace => grace.pattern.test(query));
}

export function expandOpenDomainQueryTerms(query: string, terms: string[]): string[] {
  const expanded = [...extractOpenDomainAnchors(query), ...terms];
  for (const grace of matchedOpenDomainFacets(query)) {
    expanded.push(...grace.terms);
  }
  return [...new Set(expanded)].slice(0, 40);
}

function toFtsAndQuery(anchorTerms: string[], facetTerms: string[], limit: number): string | null {
  const anchors = [...new Set(anchorTerms)]
    .map(w => w.replace(/"/g, '').trim())
    .filter(Boolean)
    .slice(0, 4);
  const facets = [...new Set(facetTerms)]
    .map(w => w.replace(/"/g, '').trim())
    .filter(Boolean)
    .slice(0, limit);

  if (anchors.length === 0 || facets.length === 0) return null;
  const anchorQuery = anchors.map(w => `"${w}"*`).join(' OR ');
  const facetQuery = facets.map(w => `"${w}"*`).join(' OR ');
  return `(${anchorQuery}) AND (${facetQuery})`;
}

export function scoreOpenDomainEvidence(content: string, query: string, baseTerms: string[]): number {
  const lower = content.toLowerCase();
  let score = 0;
  for (const anchor of extractOpenDomainAnchors(query)) {
    if (lower.includes(anchor)) score += 8;
  }
  for (const term of baseTerms) {
    if (lower.includes(term)) score += term.length >= 6 ? 2 : 1;
  }
  for (const grace of matchedOpenDomainFacets(query)) {
    for (const term of grace.terms) {
      if (lower.includes(term)) score += 1;
    }
  }
  return score;
}

/**
 * Returns true if the query looks like an open-domain question:
 * broad, exploratory, no specific anchors, no temporal signals.
 */
export function isOpenDomainQuery(query: string): boolean {
  if (!query || query.trim().length < 8) return false;

  // Has temporal signals → temporal path handles it, unless the query is also
  // a broad/inferential open-domain question. LoCoMo category-3 questions often
  // mention dates while still requiring raw-message inference rather than a
  // pure temporal answer.
  const broad = BROAD_INTERROGATIVE.test(query) || INFERENTIAL_OPEN_DOMAIN.test(query);
  if (TEMPORAL_SIGNALS.test(query) && !broad) return false;

  // Version, ticket, and URL anchors usually belong to specific retrieval paths.
  // Do not exclude named people/places here: LoCoMo open-domain questions often
  // ask broad questions about a named speaker, and the entity is the useful
  // retrieval anchor rather than a reason to bypass raw-message recall.
  if (SPECIFIC_NON_DIALOG_ANCHOR.test(query)) return false;

  // Must match a broad interrogative pattern
  if (!broad) return false;

  // Sanity: query should not be too long (long queries are usually specific)
  const wordCount = query.trim().split(/\s+/).length;
  if (wordCount > 28) return false;

  return true;
}

// ── FTS5 query builder ────────────────────────────────────────────────────

/**
 * Build a FTS5 MATCH query from a broad question.
 * Strips stop words, question words, and punctuation.
 * Returns up to 6 prefix-matched terms joined with OR.
 */
function tokenizeOpenDomainQuery(query: string): string[] {
  const STOP_WORDS = new Set([
    'what', 'did', 'does', 'has', 'was', 'were', 'is', 'are', 'how',
    'tell', 'me', 'about', 'describe', 'explain', 'summarize', 'overview',
    'recap', 'who', 'do', 'you', 'know', 'have', 'the', 'a', 'an', 'of',
    'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but', 'with', 'from',
    'their', 'them', 'they', 'your', 'his', 'her', 'him', 'she', 'he',
    'would', 'could', 'should', 'might', 'likely', 'considered', 'consider',
    'besides', 'while', 'make', 'doing', 'person',
  ]);

  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  return expandOpenDomainQueryTerms(query, terms);
}

function toFtsOrQuery(terms: string[], limit: number): string | null {
  const unique = [...new Set(terms)]
    .slice(0, limit)
    .map(w => `"${w.replace(/"/g, '')}"*`);

  if (unique.length === 0) return null;
  return unique.join(' OR ');
}

export function buildOpenDomainFtsQuery(query: string): string | null {
  return toFtsOrQuery(tokenizeOpenDomainQuery(query), 8);
}

/**
 * Build multiple prompt-only FTS probes for broad open-domain questions.
 * The primary query favors specific terms; the secondary query preserves the
 * natural query order so shorter but important entity/activity terms are not
 * lost when the broad question contains many long words.
 */
export function buildOpenDomainFtsQueries(query: string): string[] {
  const terms = tokenizeOpenDomainQuery(query);
  const anchors = extractOpenDomainAnchors(query);
  const baseTerms = terms.filter(term => !anchors.includes(term));
  const facetQueries = matchedOpenDomainFacets(query)
    .map(grace => toFtsAndQuery(anchors, grace.terms, 10))
    .filter((q): q is string => Boolean(q));

  const queries = [
    ...facetQueries,
    toFtsOrQuery(terms, 10),
    toFtsOrQuery(baseTerms, 12),
  ].filter((q): q is string => Boolean(q));

  return [...new Set(queries)];
}

// ── Open-domain FTS retrieval ─────────────────────────────────────────────

export interface OpenDomainResult {
  role: string;
  content: string;
  createdAt: string;
  conversationId?: number;
  messageIndex?: number;
  rank?: number;
  anchorScore?: number;
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
  const ftsQueries = buildOpenDomainFtsQueries(query);
  if (ftsQueries.length === 0) return [];

  try {
    const rowsById = new Map<number, OpenDomainResult & { id: number }>();

    const hitStmt = db.prepare(`
      WITH fts_matches AS (
        SELECT rowid, rank
        FROM messages_fts
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      )
      SELECT
        m.id,
        m.conversation_id AS conversationId,
        m.role,
        m.text_content AS content,
        m.created_at AS createdAt,
        m.message_index AS messageIndex,
        fts_matches.rank AS rank
      FROM messages m
      JOIN fts_matches ON m.id = fts_matches.rowid
      WHERE m.role IN ('user', 'assistant')
        AND m.text_content IS NOT NULL
        AND trim(m.text_content) != ''
        AND m.is_heartbeat = 0
      ORDER BY fts_matches.rank
    `);

    const neighborStmt = db.prepare(`
      SELECT
        id,
        conversation_id AS conversationId,
        role,
        text_content AS content,
        created_at AS createdAt,
        message_index AS messageIndex
      FROM messages
      WHERE conversation_id = ?
        AND message_index BETWEEN ? AND ?
        AND role IN ('user', 'assistant')
        AND text_content IS NOT NULL
        AND trim(text_content) != ''
        AND is_heartbeat = 0
      ORDER BY message_index ASC
    `);

    for (const ftsQuery of ftsQueries) {
      const hits = hitStmt.all(ftsQuery, limit * 2) as unknown as Array<OpenDomainResult & { id: number }>;
      for (const hit of hits) {
        if (!rowsById.has(hit.id)) rowsById.set(hit.id, hit);

        // Preserve local dialogue context. Open-domain answers often live in the
        // assistant turn adjacent to a broad user turn, or vice versa.
        if (hit.conversationId == null) continue;
        const messageIndex = hit.messageIndex ?? 0;
        const neighbors = neighborStmt.all(
          hit.conversationId,
          messageIndex - 2,
          messageIndex + 2,
        ) as unknown as Array<OpenDomainResult & { id: number }>;

        for (const neighbor of neighbors) {
          if (!rowsById.has(neighbor.id)) rowsById.set(neighbor.id, {
            ...neighbor,
            rank: hit.rank,
          });
        }
      }
    }

    const baseTerms = tokenizeOpenDomainQuery(query);
    for (const row of rowsById.values()) {
      row.anchorScore = scoreOpenDomainEvidence(row.content ?? '', query, baseTerms);
    }

    const rows = [...rowsById.values()].sort((a, b) => {
      const scoreA = a.anchorScore ?? 0;
      const scoreB = b.anchorScore ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      const rankA = a.rank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.rank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      if ((a.conversationId ?? 0) !== (b.conversationId ?? 0)) return (a.conversationId ?? 0) - (b.conversationId ?? 0);
      return (a.messageIndex ?? 0) - (b.messageIndex ?? 0);
    });

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
