/**
 * hypermem Rate Limiter
 *
 * Token-bucket rate limiter for embedding API calls.
 * Prevents hammering Ollama during bulk indexing.
 *
 * Strategy:
 *   - Burst: allow immediate calls up to bucket capacity
 *   - Sustained: refill tokens at a steady rate
 *   - Backpressure: when tokens exhausted, delay until available
 *   - Priority: high-priority requests (user-facing recall) get reserved tokens
 *
 * Usage:
 *   const limiter = new RateLimiter({ tokensPerSecond: 5, burstSize: 10 });
 *   await limiter.acquire();  // Waits if necessary
 *   const embeddings = await generateEmbeddings(texts);
 */
export interface RateLimiterConfig {
    /** Tokens refilled per second. Default: 5 */
    tokensPerSecond: number;
    /** Maximum burst capacity. Default: 10 */
    burstSize: number;
    /** Reserved tokens for high-priority requests. Default: 2 */
    reservedHigh: number;
    /** Maximum wait time before rejecting (ms). Default: 30000 (30s) */
    maxWaitMs: number;
}
export type Priority = 'high' | 'normal' | 'low';
export declare class RateLimiter {
    private tokens;
    private lastRefill;
    private readonly config;
    private waitQueue;
    private refillTimer;
    private _totalAcquired;
    private _totalWaited;
    private _totalRejected;
    constructor(config?: Partial<RateLimiterConfig>);
    /**
     * Acquire tokens. Blocks until tokens are available or maxWaitMs expires.
     *
     * @param count - Number of tokens to acquire (default 1)
     * @param priority - Request priority (high gets reserved tokens)
     * @throws Error if wait exceeds maxWaitMs
     */
    acquire(count?: number, priority?: Priority): Promise<void>;
    /**
     * Try to acquire tokens without waiting.
     * Returns true if tokens were acquired, false if not.
     */
    tryAcquire(count?: number, priority?: Priority): boolean;
    /**
     * Get current limiter state.
     */
    get state(): {
        availableTokens: number;
        pendingRequests: number;
        stats: {
            acquired: number;
            waited: number;
            rejected: number;
        };
    };
    /**
     * Stop the refill timer.
     */
    destroy(): void;
    private refill;
    private processQueue;
}
/**
 * Rate-limited embedding generator.
 * Wraps generateEmbeddings with rate limiting.
 */
export declare function createRateLimitedEmbedder(embedFn: (texts: string[]) => Promise<Float32Array[]>, limiter: RateLimiter): (texts: string[], priority?: Priority) => Promise<Float32Array[]>;
//# sourceMappingURL=rate-limiter.d.ts.map