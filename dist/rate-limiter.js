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
const DEFAULT_CONFIG = {
    tokensPerSecond: 5,
    burstSize: 10,
    reservedHigh: 2,
    maxWaitMs: 30000,
};
export class RateLimiter {
    tokens;
    lastRefill;
    config;
    waitQueue = [];
    refillTimer = null;
    _totalAcquired = 0;
    _totalWaited = 0;
    _totalRejected = 0;
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.tokens = this.config.burstSize;
        this.lastRefill = Date.now();
        // Refill tokens periodically
        this.refillTimer = setInterval(() => this.refill(), 200); // 5x per second
    }
    /**
     * Acquire tokens. Blocks until tokens are available or maxWaitMs expires.
     *
     * @param count - Number of tokens to acquire (default 1)
     * @param priority - Request priority (high gets reserved tokens)
     * @throws Error if wait exceeds maxWaitMs
     */
    async acquire(count = 1, priority = 'normal') {
        this.refill();
        // High priority can use reserved tokens
        const available = priority === 'high'
            ? this.tokens
            : Math.max(0, this.tokens - this.config.reservedHigh);
        if (available >= count) {
            this.tokens -= count;
            this._totalAcquired += count;
            return;
        }
        // Need to wait
        this._totalWaited++;
        const deadline = Date.now() + this.config.maxWaitMs;
        return new Promise((resolve, reject) => {
            this.waitQueue.push({
                resolve,
                reject,
                priority,
                tokensNeeded: count,
                deadline,
            });
            // Sort by priority (high first) then by deadline (earliest first)
            this.waitQueue.sort((a, b) => {
                const priOrder = { high: 0, normal: 1, low: 2 };
                const priDiff = priOrder[a.priority] - priOrder[b.priority];
                if (priDiff !== 0)
                    return priDiff;
                return a.deadline - b.deadline;
            });
        });
    }
    /**
     * Try to acquire tokens without waiting.
     * Returns true if tokens were acquired, false if not.
     */
    tryAcquire(count = 1, priority = 'normal') {
        this.refill();
        const available = priority === 'high'
            ? this.tokens
            : Math.max(0, this.tokens - this.config.reservedHigh);
        if (available >= count) {
            this.tokens -= count;
            this._totalAcquired += count;
            return true;
        }
        return false;
    }
    /**
     * Get current limiter state.
     */
    get state() {
        this.refill();
        return {
            availableTokens: Math.floor(this.tokens),
            pendingRequests: this.waitQueue.length,
            stats: {
                acquired: this._totalAcquired,
                waited: this._totalWaited,
                rejected: this._totalRejected,
            },
        };
    }
    /**
     * Stop the refill timer.
     */
    destroy() {
        if (this.refillTimer) {
            clearInterval(this.refillTimer);
            this.refillTimer = null;
        }
        // Reject all pending
        for (const waiter of this.waitQueue) {
            waiter.reject(new Error('Rate limiter destroyed'));
        }
        this.waitQueue = [];
    }
    // ─── Internal ──────────────────────────────────────────────
    refill() {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000; // seconds
        const newTokens = elapsed * this.config.tokensPerSecond;
        if (newTokens > 0) {
            this.tokens = Math.min(this.config.burstSize, this.tokens + newTokens);
            this.lastRefill = now;
        }
        // Process wait queue
        this.processQueue();
    }
    processQueue() {
        const now = Date.now();
        const toRemove = [];
        for (let i = 0; i < this.waitQueue.length; i++) {
            const waiter = this.waitQueue[i];
            // Check deadline
            if (now > waiter.deadline) {
                waiter.reject(new Error(`Rate limit wait exceeded ${this.config.maxWaitMs}ms`));
                this._totalRejected++;
                toRemove.push(i);
                continue;
            }
            // Check if tokens available
            const available = waiter.priority === 'high'
                ? this.tokens
                : Math.max(0, this.tokens - this.config.reservedHigh);
            if (available >= waiter.tokensNeeded) {
                this.tokens -= waiter.tokensNeeded;
                this._totalAcquired += waiter.tokensNeeded;
                waiter.resolve();
                toRemove.push(i);
            }
        }
        // Remove processed entries (reverse order to maintain indices)
        for (let i = toRemove.length - 1; i >= 0; i--) {
            this.waitQueue.splice(toRemove[i], 1);
        }
    }
}
/**
 * Rate-limited embedding generator.
 * Wraps generateEmbeddings with rate limiting.
 */
export function createRateLimitedEmbedder(embedFn, limiter) {
    return async (texts, priority = 'normal') => {
        if (texts.length === 0)
            return [];
        // Each batch counts as 1 token regardless of batch size
        // This limits the number of API calls, not the number of texts
        await limiter.acquire(1, priority);
        return embedFn(texts);
    };
}
//# sourceMappingURL=rate-limiter.js.map