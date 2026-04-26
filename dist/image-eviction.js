/**
 * Image and heavy-content eviction pre-pass.
 *
 * Runs before the LLM call inside assemble(). Scans the live messages array
 * for stale image payloads and large tool results, replaces them with compact
 * text descriptors. This frees tokens before pressure tiers fire, so compaction
 * runs less often.
 *
 * Works on the raw OpenClaw message format (AgentMessage / content arrays),
 * not on hypermem's internal NeutralMessage format.
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
export const DEFAULT_EVICTION_CONFIG = {
    imageAgeTurns: 1,
    toolResultAgeTurns: 1,
    minTokensToEvict: 200,
    keepPreviewChars: 120,
};
// ── Token estimation ─────────────────────────────────────────────────────────
/**
 * Attempt to read image dimensions from the first few bytes of a base64-encoded image.
 * Supports PNG, JPEG, GIF, WebP. Returns null if format is unrecognized or parse fails.
 */
function tryReadImageDimensions(base64) {
    try {
        // PNG: decode 32 bytes — magic at 0-7, IHDR at 8-15, width at 16-19, height at 20-23
        const hdrBuf = Buffer.from(base64.slice(0, 44), 'base64');
        if (hdrBuf[0] === 0x89 && hdrBuf[1] === 0x50 && hdrBuf[2] === 0x4e && hdrBuf[3] === 0x47) {
            const w = hdrBuf.readUInt32BE(16);
            const h = hdrBuf.readUInt32BE(20);
            if (w > 0 && h > 0 && w <= 16384 && h <= 16384)
                return { width: w, height: h };
        }
        // GIF: 6-byte header, then width/height as little-endian 16-bit at offsets 6-7, 8-9
        if (hdrBuf[0] === 0x47 && hdrBuf[1] === 0x49 && hdrBuf[2] === 0x46) {
            const w = hdrBuf.readUInt16LE(6);
            const h = hdrBuf.readUInt16LE(8);
            if (w > 0 && h > 0)
                return { width: w, height: h };
        }
        // JPEG: SOI is \xff\xd8 — scan a larger chunk for SOF0 (\xff\xc0) or SOF2 (\xff\xc2)
        if (hdrBuf[0] === 0xff && hdrBuf[1] === 0xd8) {
            const jpegBuf = Buffer.from(base64.slice(0, 680), 'base64');
            for (let i = 2; i < jpegBuf.length - 8; i++) {
                if (jpegBuf[i] === 0xff && (jpegBuf[i + 1] === 0xc0 || jpegBuf[i + 1] === 0xc2)) {
                    const h = jpegBuf.readUInt16BE(i + 5);
                    const w = jpegBuf.readUInt16BE(i + 7);
                    if (w > 0 && h > 0 && w <= 16384 && h <= 16384)
                        return { width: w, height: h };
                }
            }
        }
        // WebP: RIFF....WEBP — VP8L (lossless) has readable dimensions quickly
        if (hdrBuf[0] === 0x52 && hdrBuf[1] === 0x49 && hdrBuf[2] === 0x46 && hdrBuf[3] === 0x46 &&
            hdrBuf[8] === 0x57 && hdrBuf[9] === 0x45 && hdrBuf[10] === 0x42 && hdrBuf[11] === 0x50 &&
            hdrBuf[12] === 0x56 && hdrBuf[13] === 0x50 && hdrBuf[14] === 0x38 && hdrBuf[15] === 0x4c) {
            if (hdrBuf[20] === 0x2f) {
                const bits = hdrBuf.readUInt32LE(21);
                const w = (bits & 0x3fff) + 1;
                const h = ((bits >> 14) & 0x3fff) + 1;
                if (w > 0 && h > 0)
                    return { width: w, height: h };
            }
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Estimate virtual tokens for a base64-encoded image using provider-appropriate math.
 * Uses Claude's formula (w×h / 750, capped at 1600) as the canonical estimate —
 * GPT-4o and Gemini are in the same ballpark for typical screenshots.
 * Falls back to a conservative 1200-token default when dimensions cannot be read.
 *
 * NOTE: Base64 string length is irrelevant — providers decode the image and run it
 * through a vision encoder. Only pixel dimensions determine token cost.
 */
function estimateBase64Tokens(base64) {
    const dims = tryReadImageDimensions(base64);
    if (dims) {
        return Math.min(Math.ceil((dims.width * dims.height) / 750), 1600);
    }
    // Fallback: typical tool screenshot ~1000-1600 tokens; use midpoint
    return 1200;
}
/** Standard prose/JSON estimation. */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
// ── Message turn-age calculation ─────────────────────────────────────────────
/**
 * Returns the turn age of a message at index `i` in the array.
 * Turn age = number of assistant messages between position i and the end.
 * (Each assistant message marks the end of one turn.)
 */
function getTurnAge(messages, index) {
    let age = 0;
    for (let j = index + 1; j < messages.length; j++) {
        const m = messages[j];
        if (m.role === 'assistant')
            age++;
    }
    return age;
}
// ── Content-block helpers ─────────────────────────────────────────────────────
/** Detect OpenAI-style image_url block or Anthropic-style image block. */
function isImageBlock(block) {
    if (block.type === 'image_url')
        return true;
    if (block.type === 'image')
        return true;
    return false;
}
/**
 * Extract base64 data from an image block regardless of provider format.
 * Returns null if the image is a plain URL (not base64-encoded — not worth evicting).
 */
function extractBase64(block) {
    // OpenAI format: { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
    if (block.type === 'image_url') {
        const imageUrl = block.image_url;
        const url = typeof imageUrl?.url === 'string' ? imageUrl.url : null;
        if (url?.startsWith('data:')) {
            const commaIdx = url.indexOf(',');
            return commaIdx >= 0 ? url.slice(commaIdx + 1) : null;
        }
        return null; // plain URL, not base64
    }
    // Anthropic format: { type: 'image', source: { type: 'base64', data: '...' } }
    if (block.type === 'image') {
        const source = block.source;
        if (source?.type === 'base64' && typeof source.data === 'string') {
            return source.data;
        }
        return null;
    }
    return null;
}
/** Infer media type string from an image block for the descriptor. */
function inferMediaType(block) {
    if (block.type === 'image_url') {
        const imageUrl = block.image_url;
        const url = typeof imageUrl?.url === 'string' ? imageUrl.url : '';
        const match = url.match(/^data:(image\/[^;]+)/);
        return match ? match[1] : 'image';
    }
    if (block.type === 'image') {
        const source = block.source;
        return typeof source?.media_type === 'string' ? source.media_type : 'image';
    }
    return 'image';
}
// ── Main eviction pass ────────────────────────────────────────────────────────
/**
 * Evict stale images and large tool results from the messages array.
 * Returns a new array (original is not mutated) plus eviction stats.
 */
export function evictStaleContent(messages, config = {}) {
    const cfg = { ...DEFAULT_EVICTION_CONFIG, ...config };
    const stats = { imagesEvicted: 0, toolResultsEvicted: 0, tokensFreed: 0 };
    const result = messages.map((msg, i) => {
        const m = msg;
        const role = m.role;
        // Only touch user messages (images) and tool messages (tool results).
        // Never touch assistant text, system prompts, or thinking blocks.
        if (role !== 'user' && role !== 'tool')
            return msg;
        const turnAge = getTurnAge(messages, i);
        // ── Image eviction (user messages with content arrays) ──────────────────
        if (role === 'user' && Array.isArray(m.content)) {
            if (turnAge <= cfg.imageAgeTurns)
                return msg;
            let changed = false;
            let newContent = m.content.map(block => {
                const b = block;
                if (!isImageBlock(b))
                    return block;
                const base64 = extractBase64(b);
                if (!base64)
                    return block; // plain URL — don't touch
                const tokens = estimateBase64Tokens(base64);
                if (tokens < cfg.minTokensToEvict)
                    return block;
                // Replace with a text descriptor
                const mediaType = inferMediaType(b);
                const dims = tryReadImageDimensions(base64);
                const dimStr = dims ? ` ${dims.width}×${dims.height}` : '';
                const descriptor = `[${mediaType}${dimStr} evicted — ~${tokens.toLocaleString()} tokens, ${turnAge} turns ago]`;
                stats.imagesEvicted++;
                stats.tokensFreed += tokens;
                changed = true;
                return { type: 'text', text: descriptor };
            });
            if (!changed)
                return msg;
            return { ...m, content: newContent };
        }
        // ── Tool result eviction (tool-role messages or toolResults arrays) ──────
        if (role === 'tool' && typeof m.content === 'string') {
            if (turnAge <= cfg.toolResultAgeTurns)
                return msg;
            const tokens = estimateTokens(m.content);
            if (tokens < cfg.minTokensToEvict)
                return msg;
            const preview = m.content.slice(0, cfg.keepPreviewChars).replace(/\s+/g, ' ').trim();
            const toolName = typeof m.name === 'string' ? m.name : 'tool_result';
            const descriptor = `[${toolName} result evicted — ~${tokens.toLocaleString()} tokens, ${turnAge} turns ago. Preview: ${preview}${preview.length < m.content.length ? '...' : ''}]`;
            stats.toolResultsEvicted++;
            stats.tokensFreed += tokens - estimateTokens(descriptor);
            return { ...m, content: descriptor };
        }
        // NeutralMessage format — toolResults as array on assistant/user messages
        if (Array.isArray(m.toolResults) && turnAge > cfg.toolResultAgeTurns) {
            let changed = false;
            const newToolResults = m.toolResults.map(tr => {
                const r = tr;
                if (typeof r.content !== 'string')
                    return tr;
                const tokens = estimateTokens(r.content);
                if (tokens < cfg.minTokensToEvict)
                    return tr;
                const preview = r.content.slice(0, cfg.keepPreviewChars).replace(/\s+/g, ' ').trim();
                const name = typeof r.name === 'string' ? r.name : 'tool_result';
                const descriptor = `[${name} evicted — ~${tokens.toLocaleString()} tokens, ${turnAge} turns ago. Preview: ${preview}${preview.length < r.content.length ? '...' : ''}]`;
                stats.toolResultsEvicted++;
                stats.tokensFreed += tokens - estimateTokens(descriptor);
                changed = true;
                return { ...r, content: descriptor };
            });
            if (!changed)
                return msg;
            return { ...m, toolResults: newToolResults };
        }
        return msg;
    });
    return { messages: result, stats };
}
//# sourceMappingURL=image-eviction.js.map