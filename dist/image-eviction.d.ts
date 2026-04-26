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
export interface ImageEvictionConfig {
    /** Turns after which images are evicted. Default: 1 */
    imageAgeTurns: number;
    /** Turns after which large tool results are evicted. Default: 1 */
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
export declare const DEFAULT_EVICTION_CONFIG: ImageEvictionConfig;
/**
 * Evict stale images and large tool results from the messages array.
 * Returns a new array (original is not mutated) plus eviction stats.
 */
export declare function evictStaleContent(messages: unknown[], config?: Partial<ImageEvictionConfig>): EvictionResult;
//# sourceMappingURL=image-eviction.d.ts.map