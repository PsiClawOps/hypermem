/**
 * Image and heavy-content eviction pre-pass.
 *
 * Runs before the LLM call inside assemble(). Scans the live messages array
 * for stale image payloads and large tool results, replaces them with compact
 * text descriptors. This frees tokens before pressure tiers fire, so compaction
 * runs less often.
 *
 * Works on the raw OpenClaw message format (AgentMessage / content arrays),
 * not on HyperMem's internal NeutralMessage format.
 *
 * What gets evicted:
 *   - Base64 image blocks (OpenAI image_url / Anthropic image source) older than imageAgeTurns
 *   - Tool results larger than minTokensToEvict, older than toolResultAgeTurns
 *
 * What is never touched:
 *   - User text content
 *   - Assistant text responses
 *   - Recent messages (within staleness thresholds)
 *   - Tool call structure (type, id, name preserved — required for API pairing)
 *   - Small tool results (below minTokensToEvict)
 *   - Thinking blocks
 */

export interface ImageEvictionConfig {
  /** Turns after which images are evicted. Default: 2 */
  imageAgeTurns: number;
  /** Turns after which large tool results are evicted. Default: 4 */
  toolResultAgeTurns: number;
  /** Minimum estimated tokens to bother evicting a tool result. Default: 200 */
  minTokensToEvict: number;
  /** Characters of preview to keep from evicted tool result content. Default: 120 */
  keepPreviewChars: number;
}

export interface EvictionStats {
  imagesEvicted: number;
  toolResultsEvicted: number;
  tokensFreed: number;
}

export interface EvictionResult {
  messages: unknown[];
  stats: EvictionStats;
}

export const DEFAULT_EVICTION_CONFIG: ImageEvictionConfig = {
  imageAgeTurns: 2,
  toolResultAgeTurns: 4,
  minTokensToEvict: 200,
  keepPreviewChars: 120,
};

// ── Rough token estimation ────────────────────────────────────────────────────

/** Base64 strings are ~0.75 bytes/char but tokens are ~4 chars — net ~3 chars/token for dense base64. */
function estimateBase64Tokens(base64: string): number {
  return Math.ceil(base64.length / 3);
}

/** Standard prose/JSON estimation. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Message turn-age calculation ─────────────────────────────────────────────

/**
 * Returns the turn age of a message at index `i` in the array.
 * Turn age = number of assistant messages between position i and the end.
 * (Each assistant message marks the end of one turn.)
 */
function getTurnAge(messages: unknown[], index: number): number {
  let age = 0;
  for (let j = index + 1; j < messages.length; j++) {
    const m = messages[j] as Record<string, unknown>;
    if (m.role === 'assistant') age++;
  }
  return age;
}

// ── Content-block helpers ─────────────────────────────────────────────────────

/** Detect OpenAI-style image_url block or Anthropic-style image block. */
function isImageBlock(block: Record<string, unknown>): boolean {
  if (block.type === 'image_url') return true;
  if (block.type === 'image') return true;
  return false;
}

/**
 * Extract base64 data from an image block regardless of provider format.
 * Returns null if the image is a plain URL (not base64-encoded — not worth evicting).
 */
function extractBase64(block: Record<string, unknown>): string | null {
  // OpenAI format: { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
  if (block.type === 'image_url') {
    const imageUrl = block.image_url as Record<string, unknown> | undefined;
    const url = typeof imageUrl?.url === 'string' ? imageUrl.url : null;
    if (url?.startsWith('data:')) {
      const commaIdx = url.indexOf(',');
      return commaIdx >= 0 ? url.slice(commaIdx + 1) : null;
    }
    return null; // plain URL, not base64
  }
  // Anthropic format: { type: 'image', source: { type: 'base64', data: '...' } }
  if (block.type === 'image') {
    const source = block.source as Record<string, unknown> | undefined;
    if (source?.type === 'base64' && typeof source.data === 'string') {
      return source.data;
    }
    return null;
  }
  return null;
}

/** Infer media type string from an image block for the descriptor. */
function inferMediaType(block: Record<string, unknown>): string {
  if (block.type === 'image_url') {
    const imageUrl = block.image_url as Record<string, unknown> | undefined;
    const url = typeof imageUrl?.url === 'string' ? imageUrl.url : '';
    const match = url.match(/^data:(image\/[^;]+)/);
    return match ? match[1] : 'image';
  }
  if (block.type === 'image') {
    const source = block.source as Record<string, unknown> | undefined;
    return typeof source?.media_type === 'string' ? source.media_type : 'image';
  }
  return 'image';
}

// ── Main eviction pass ────────────────────────────────────────────────────────

/**
 * Evict stale images and large tool results from the messages array.
 * Returns a new array (original is not mutated) plus eviction stats.
 */
export function evictStaleContent(
  messages: unknown[],
  config: Partial<ImageEvictionConfig> = {},
): EvictionResult {
  const cfg: ImageEvictionConfig = { ...DEFAULT_EVICTION_CONFIG, ...config };
  const stats: EvictionStats = { imagesEvicted: 0, toolResultsEvicted: 0, tokensFreed: 0 };

  const result = messages.map((msg, i) => {
    const m = msg as Record<string, unknown>;
    const role = m.role as string | undefined;

    // Only touch user messages (images) and tool messages (tool results).
    // Never touch assistant text, system prompts, or thinking blocks.
    if (role !== 'user' && role !== 'tool') return msg;

    const turnAge = getTurnAge(messages, i);

    // ── Image eviction (user messages with content arrays) ──────────────────
    if (role === 'user' && Array.isArray(m.content)) {
      if (turnAge < cfg.imageAgeTurns) return msg;

      let changed = false;
      let newContent = (m.content as unknown[]).map(block => {
        const b = block as Record<string, unknown>;
        if (!isImageBlock(b)) return block;

        const base64 = extractBase64(b);
        if (!base64) return block; // plain URL — don't touch

        const tokens = estimateBase64Tokens(base64);
        if (tokens < cfg.minTokensToEvict) return block;

        // Replace with a text descriptor
        const mediaType = inferMediaType(b);
        const descriptor = `[${mediaType} evicted — ~${tokens.toLocaleString()} tokens, ${turnAge} turns ago]`;
        stats.imagesEvicted++;
        stats.tokensFreed += tokens;
        changed = true;
        return { type: 'text', text: descriptor };
      });

      if (!changed) return msg;
      return { ...m, content: newContent };
    }

    // ── Tool result eviction (tool-role messages or toolResults arrays) ──────
    if (role === 'tool' && typeof m.content === 'string') {
      if (turnAge < cfg.toolResultAgeTurns) return msg;

      const tokens = estimateTokens(m.content);
      if (tokens < cfg.minTokensToEvict) return msg;

      const preview = m.content.slice(0, cfg.keepPreviewChars).replace(/\s+/g, ' ').trim();
      const toolName = typeof m.name === 'string' ? m.name : 'tool_result';
      const descriptor = `[${toolName} result evicted — ~${tokens.toLocaleString()} tokens, ${turnAge} turns ago. Preview: ${preview}${preview.length < m.content.length ? '...' : ''}]`;
      stats.toolResultsEvicted++;
      stats.tokensFreed += tokens - estimateTokens(descriptor);
      return { ...m, content: descriptor };
    }

    // NeutralMessage format — toolResults as array on assistant/user messages
    if (Array.isArray(m.toolResults) && turnAge >= cfg.toolResultAgeTurns) {
      let changed = false;
      const newToolResults = (m.toolResults as unknown[]).map(tr => {
        const r = tr as Record<string, unknown>;
        if (typeof r.content !== 'string') return tr;
        const tokens = estimateTokens(r.content);
        if (tokens < cfg.minTokensToEvict) return tr;

        const preview = r.content.slice(0, cfg.keepPreviewChars).replace(/\s+/g, ' ').trim();
        const name = typeof r.name === 'string' ? r.name : 'tool_result';
        const descriptor = `[${name} evicted — ~${tokens.toLocaleString()} tokens, ${turnAge} turns ago. Preview: ${preview}${preview.length < r.content.length ? '...' : ''}]`;
        stats.toolResultsEvicted++;
        stats.tokensFreed += tokens - estimateTokens(descriptor);
        changed = true;
        return { ...r, content: descriptor };
      });

      if (!changed) return msg;
      return { ...m, toolResults: newToolResults };
    }

    return msg;
  });

  return { messages: result, stats };
}
