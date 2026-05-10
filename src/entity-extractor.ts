/**
 * entity-extractor.ts — Entity and grace tagger
 *
 * Sprint A: compose-time annotation only.
 * Sprint B: also used at ingest time. Adds shared key normalization
 * (`normalizeEntityKey`, `normalizeFacetKey`) and an ingest-friendly
 * `extractEntityFacetMentions(text)` returning cheap (start,end) offsets
 * suitable for storing in `message_entity_mentions` / `message_facet_mentions`.
 *
 * Exported symbols:
 *   extractEntitiesFromText(text, knownEntities?)   → ExtractedTextEntities
 *   annotateRecallGroups(...)                       → AnnotatedGroup[]
 *   formatStructuredHandoffBlock(...)               → structured block
 *   buildStructuredHandoffInstruction(...)          → string
 *   normalizeEntityKey(token)                       → string                (Sprint B)
 *   normalizeFacetKey(token)                        → string                (Sprint B)
 *   extractEntityFacetMentions(text)                → EntityFacetMentions    (Sprint B)
 */

import {
  QUESTION_SHAPE_FACETS,
  extractQueryFacetTerms,
} from './question-shape.js';

// ── Sprint B types ────────────────────────────────────────────────────────

export interface EntityMention {
  /** Normalized entity key (lowercase, trimmed). */
  key: string;
  /** Original surface form as it appears in the text. */
  surface: string;
  /** Inclusive start offset in the source string. */
  start: number;
  /** Exclusive end offset in the source string. */
  end: number;
}

export interface FacetMention {
  /** Grace group key (e.g. 'job', 'death', 'venue'). */
  key: string;
  /** Raw grace term that triggered the match. */
  term: string;
  /** Inclusive start offset in the source string. */
  start: number;
  /** Exclusive end offset in the source string. */
  end: number;
}

export interface EntityFacetMentions {
  entities: EntityMention[];
  facets: FacetMention[];
}

export interface ExtractedTextEntities {
  /** Normalized entity tokens found in the text */
  entities: string[];
  /** Grace group names matched in the text */
  facets: string[];
  /** Raw grace terms matched in the text */
  facetTerms: string[];
}

export interface AnnotatedGroup {
  /** Original group identifier (e.g. conversation_id / conversation id) */
  groupId: string;
  /** Original group content lines */
  lines: string[];
  /** Entity tokens from query that appear in this group's content */
  matchedEntities: string[];
  /** Grace group names from query that appear in this group's content */
  matchedFacets: string[];
  /** Raw grace terms matched in this group */
  matchedFacetTerms: string[];
  /** True when this group contains at least one query entity or grace */
  isRelevant: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────

/** TitleCase word pattern for content scanning */
const TITLE_CASE_CONTENT_WORD = /\b[A-Z][a-z][a-zA-Z]*\b/g;
/** Quoted string pattern */
const QUOTED_STRING_CONTENT = /["']([^"']{2,30})["']/g;
/** ALL-CAPS abbreviation */
const ALLCAPS_ABBREV_CONTENT = /\b[A-Z]{2,6}\b/g;

const CONTENT_STOP_WORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but',
  'by', 'is', 'it', 'if', 'so', 'do', 'be', 'my', 'we', 'he', 'she', 'they',
  'you', 'me', 'us', 'his', 'her', 'its', 'our', 'your', 'who', 'what', 'how',
  'when', 'where', 'which', 'why', 'would', 'could', 'should', 'did', 'does',
  'was', 'were', 'has', 'have', 'had', 'will', 'can', 'may', 'might', 'shall',
  'just', 'also', 'both', 'each', 'with', 'from', 'that', 'this', 'these',
  'those', 'any', 'all', 'not', 'now', 'well', 'too', 'very', 'more', 'most',
  'some', 'same', 'last', 'next', 'new', 'old', 'then', 'than', 'into', 'upon',
  // Role labels that appear in recall blocks
  'user', 'assistant', 'raw', 'transcript', 'group',
  // Common discourse words
  'yes', 'yeah', 'okay', 'ok', 'sure', 'right', 'true', 'false',
  // Date words
  'january', 'february', 'march', 'april', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

/**
 * Extract entity and grace tokens from a block of text content.
 * When `knownEntities` is provided, the scan is biased toward those tokens
 * (useful for narrowing to query-relevant entities during structured handoff).
 */
export function extractEntitiesFromText(
  text: string,
  knownEntities?: string[],
): ExtractedTextEntities {
  const entities = new Set<string>();
  const lower = text.toLowerCase();

  // If caller provides a known entity list, check those first (fast path)
  if (knownEntities && knownEntities.length > 0) {
    for (const e of knownEntities) {
      if (lower.includes(e.toLowerCase())) {
        entities.add(e.toLowerCase());
      }
    }
  }

  // Always scan for TitleCase entities (catches entities not in knownEntities)
  for (const m of text.matchAll(TITLE_CASE_CONTENT_WORD)) {
    const word = m[0];
    const wLower = word.toLowerCase();
    if (!CONTENT_STOP_WORDS.has(wLower)) {
      entities.add(wLower);
    }
  }

  // Quoted strings
  for (const m of text.matchAll(QUOTED_STRING_CONTENT)) {
    const val = m[1].trim().toLowerCase();
    if (val.length >= 2 && !CONTENT_STOP_WORDS.has(val)) {
      entities.add(val);
    }
  }

  // ALL-CAPS abbreviations
  for (const m of text.matchAll(ALLCAPS_ABBREV_CONTENT)) {
    const abbrev = m[0].toLowerCase();
    if (abbrev.length >= 2 && !CONTENT_STOP_WORDS.has(abbrev)) {
      entities.add(abbrev);
    }
  }

  // Facets
  const facets = new Set<string>();
  const facetTerms: string[] = [];
  for (const grace of QUESTION_SHAPE_FACETS) {
    for (const term of grace.terms) {
      if (lower.includes(term)) {
        facets.add(grace.name);
        facetTerms.push(term);
        break; // one match per grace group is enough
      }
    }
  }

  return {
    entities: [...entities],
    facets: [...facets],
    facetTerms: [...new Set(facetTerms)],
  };
}

// ── Group annotator ───────────────────────────────────────────────────────

/**
 * Parse raw recall content (already grouped by conversation_id) into annotated groups.
 *
 * Input is the `recall.content` string from `buildQueryMessageRecall()`,
 * which uses `### Raw transcript group {id}` headers.
 *
 * For each group, annotates which query entities and facets appear in the
 * group's content lines. This is the core of the Sprint A structured handoff.
 */
export function annotateRecallGroups(
  recallContent: string,
  queryEntities: string[],
  queryFacets: string[],
): AnnotatedGroup[] {
  const groups: AnnotatedGroup[] = [];
  const queryFacetTerms = extractQueryFacetTerms(queryFacets.join(' '));

  // Build a set of raw grace terms for matching within group content
  const facetTermsByGroup = new Map<string, string[]>();
  for (const facetName of queryFacets) {
    const grace = QUESTION_SHAPE_FACETS.find(f => f.name === facetName);
    if (grace) {
      facetTermsByGroup.set(facetName, grace.terms);
    }
  }

  // Split content by group headers
  const groupHeaderPattern = /^### Raw transcript group (\S+)/m;
  const parts = recallContent.split(/^(?=### Raw transcript group \S+)/m);

  for (const part of parts) {
    if (!part.trim()) continue;

    const headerMatch = part.match(groupHeaderPattern);
    if (!headerMatch) continue;

    const groupId = headerMatch[1];
    const lines = part.split('\n');
    const contentLines = lines.slice(1); // skip header line

    // Flatten group text for entity/grace matching
    const groupText = contentLines.join(' ');
    const groupLower = groupText.toLowerCase();

    // Which query entities appear in this group?
    const matchedEntities = queryEntities.filter(e => groupLower.includes(e.toLowerCase()));

    // Which query grace groups appear in this group?
    const matchedFacets: string[] = [];
    const matchedFacetTerms: string[] = [];
    for (const [facetName, terms] of facetTermsByGroup) {
      const matched = terms.filter(t => groupLower.includes(t));
      if (matched.length > 0) {
        matchedFacets.push(facetName);
        matchedFacetTerms.push(...matched);
      }
    }

    groups.push({
      groupId,
      lines: contentLines,
      matchedEntities,
      matchedFacets,
      matchedFacetTerms: [...new Set(matchedFacetTerms)],
      isRelevant: matchedEntities.length > 0 || matchedFacets.length > 0,
    });
  }

  return groups;
}

// ── Structured handoff formatter ──────────────────────────────────────────

/**
 * Format annotated groups into structured evidence blocks for multi-hop handoff.
 *
 * Each group gets a header that names which query entities/facets it contains,
 * so the reader can quickly identify which groups are evidence for each hop.
 *
 * Token cost is minimal relative to the raw content: only the header changes.
 * No content is dropped; existing budget accounting from buildQueryMessageRecall
 * applies before this formatter runs.
 */
export function formatStructuredHandoffBlock(
  groups: AnnotatedGroup[],
  queryEntities: string[],
  queryFacets: string[],
): { content: string; entityGroupCount: number; facetGroupCount: number } {
  const lines: string[] = [];
  let entityGroupCount = 0;
  let facetGroupCount = 0;

  for (const group of groups) {
    const hasMeaningfulContent = group.lines.some(l => l.trim().startsWith('-'));
    if (!hasMeaningfulContent) continue;

    // Build a compact annotation for the group header
    const annotations: string[] = [];
    if (group.matchedEntities.length > 0) {
      annotations.push(`entities: ${group.matchedEntities.slice(0, 4).join(', ')}`);
      entityGroupCount++;
    }
    if (group.matchedFacets.length > 0) {
      annotations.push(`facets: ${group.matchedFacets.slice(0, 3).join(', ')}`);
      facetGroupCount++;
    }

    // Emit header with annotation (or without if no match — still emit the group)
    if (annotations.length > 0) {
      lines.push(`### Evidence group ${group.groupId} [${annotations.join('; ')}]`);
    } else {
      lines.push(`### Raw transcript group ${group.groupId}`);
    }

    // Emit content lines (unchanged from recall output)
    for (const line of group.lines) {
      if (line.trim()) lines.push(line);
    }
    lines.push('');
  }

  return {
    content: lines.join('\n').trimEnd(),
    entityGroupCount,
    facetGroupCount,
  };
}

// ── Sprint B: shared key normalization and ingest extraction ─────────────

/**
 * Normalize an entity surface form into a canonical bridge key.
 *
 * Strategy: lowercase, collapse whitespace, strip leading/trailing punctuation,
 * preserve internal alphanumerics + a small set of joiners (-, _, .).
 * The result is the join key used by `memory_entities.entity_key`.
 */
export function normalizeEntityKey(token: string): string {
  if (!token) return '';
  const trimmed = String(token).trim().toLowerCase();
  if (!trimmed) return '';
  // Collapse internal whitespace, strip leading/trailing punctuation.
  const collapsed = trimmed.replace(/\s+/g, ' ');
  return collapsed.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/**
 * Normalize a grace group name into a canonical bridge key.
 * Grace keys are already lowercase identifiers in QUESTION_SHAPE_FACETS,
 * but callers may pass raw terms. We snap raw terms to their grace group.
 */
export function normalizeFacetKey(token: string): string {
  if (!token) return '';
  const lower = String(token).trim().toLowerCase();
  if (!lower) return '';
  // If the token is already a grace group name, return it.
  for (const f of QUESTION_SHAPE_FACETS) {
    if (f.name === lower) return lower;
  }
  // Otherwise look it up against the term list.
  for (const f of QUESTION_SHAPE_FACETS) {
    if (f.terms.includes(lower)) return f.name;
  }
  return lower.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/**
 * Internal helper: yield a regex that matches the union of grace terms with
 * word boundaries where possible. Cached at module level.
 */
let _facetTermPattern: RegExp | null = null;
let _facetTermLookup: Map<string, string> | null = null;
function getFacetTermPattern(): { pattern: RegExp; lookup: Map<string, string> } {
  if (_facetTermPattern && _facetTermLookup) {
    return { pattern: _facetTermPattern, lookup: _facetTermLookup };
  }
  const lookup = new Map<string, string>();
  const escaped: string[] = [];
  for (const grace of QUESTION_SHAPE_FACETS) {
    for (const term of grace.terms) {
      // Last write wins for ambiguous terms; QUESTION_SHAPE_FACETS authors
      // are responsible for keeping the lexicon disjoint enough.
      lookup.set(term.toLowerCase(), grace.name);
      escaped.push(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
  }
  // Sort by length descending so multi-word terms beat single-word prefixes.
  escaped.sort((a, b) => b.length - a.length);
  _facetTermPattern = new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
  _facetTermLookup = lookup;
  return { pattern: _facetTermPattern, lookup };
}

/**
 * Extract entity and grace mentions from a text block, with cheap (start,end)
 * offsets, for ingest indexing into the entity/grace bridge tables.
 *
 * Designed to be cheap and deterministic; never calls a model, never reads
 * a DB. Caller decides whether to write the resulting mentions.
 */
export function extractEntityFacetMentions(text: string): EntityFacetMentions {
  const entities: EntityMention[] = [];
  const facets: FacetMention[] = [];
  if (!text) return { entities, facets };

  const seenEntity = new Map<string, EntityMention>();

  // TitleCase entities
  for (const m of text.matchAll(TITLE_CASE_CONTENT_WORD)) {
    const surface = m[0];
    const key = normalizeEntityKey(surface);
    if (!key || CONTENT_STOP_WORDS.has(key)) continue;
    if (seenEntity.has(key)) continue;
    const start = m.index ?? text.indexOf(surface);
    const end = start + surface.length;
    const mention: EntityMention = { key, surface, start, end };
    seenEntity.set(key, mention);
    entities.push(mention);
  }

  // Quoted strings
  for (const m of text.matchAll(QUOTED_STRING_CONTENT)) {
    const inner = m[1];
    const key = normalizeEntityKey(inner);
    if (!key || key.length < 2 || CONTENT_STOP_WORDS.has(key)) continue;
    if (seenEntity.has(key)) continue;
    const matchStart = m.index ?? text.indexOf(m[0]);
    const innerStart = matchStart + 1; // skip opening quote
    const mention: EntityMention = {
      key,
      surface: inner,
      start: innerStart,
      end: innerStart + inner.length,
    };
    seenEntity.set(key, mention);
    entities.push(mention);
  }

  // ALL-CAPS abbreviations
  for (const m of text.matchAll(ALLCAPS_ABBREV_CONTENT)) {
    const surface = m[0];
    const key = normalizeEntityKey(surface);
    if (!key || key.length < 2 || CONTENT_STOP_WORDS.has(key)) continue;
    if (seenEntity.has(key)) continue;
    const start = m.index ?? text.indexOf(surface);
    const mention: EntityMention = {
      key,
      surface,
      start,
      end: start + surface.length,
    };
    seenEntity.set(key, mention);
    entities.push(mention);
  }

  // Grace term scan
  const { pattern, lookup } = getFacetTermPattern();
  pattern.lastIndex = 0;
  const seenFacetGroup = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const term = m[0].toLowerCase();
    const facetKey = lookup.get(term);
    if (!facetKey) continue;
    // Keep the first occurrence per grace group; cheap and bounded.
    if (seenFacetGroup.has(facetKey)) continue;
    seenFacetGroup.add(facetKey);
    facets.push({
      key: facetKey,
      term,
      start: m.index,
      end: m.index + term.length,
    });
  }

  return { entities, facets };
}

/**
 * Build the structured handoff instruction preamble.
 * Replaces the current flat multi-hop instruction string when structured
 * handoff is active.
 */
export function buildStructuredHandoffInstruction(
  entities: string[],
  facets: string[],
): string {
  const parts: string[] = [
    '## Query-Matched Conversation Memory',
  ];

  if (entities.length > 0 || facets.length > 0) {
    const subjectParts: string[] = [];
    if (entities.length > 0) subjectParts.push(`entities: ${entities.slice(0, 4).join(', ')}`);
    if (facets.length > 0) subjectParts.push(`facets: ${facets.slice(0, 3).join(', ')}`);
    parts.push(`Query subjects — ${subjectParts.join('; ')}.`);
  }

  parts.push(
    'Evidence groups below are tagged with which query subjects appear in each group.',
    'For multi-part questions, scan all groups and collect every relevant item before answering.',
    'If the question asks what people share, have in common, bought, planned, pursued, or lost, scan all groups and include every matching item before summarizing.',
    'Prefer the shortest complete list of supported items; do not add unsupported extras.',
    'For names, places, events, purchases, deaths, goals, or activities, preserve each distinct transcript anchor you find instead of collapsing to a generic category.',
    'Do not answer that no information is available when the groups contain supporting evidence.',
  );

  return parts.join('\n');
}
