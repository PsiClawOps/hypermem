/**
 * HyperMem Rate Limiter
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

const DEFAULT_CONFIG: RateLimiterConfig = {
  tokensPerSecond: 5,
  burstSize: 10,
  reservedHigh: 2,
  maxWaitMs: 30000,
};

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly config: RateLimiterConfig;
  private waitQueue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    priority: Priority;
    tokensNeeded: number;
    deadline: number;
  }> = [];
  private refillTimer: ReturnType<typeof setInterval> | null = null;
  private _totalAcquired = 0;
  private _totalWaited = 0;
  private _totalRejected = 0;

  constructor(config?: Partial<RateLimiterConfig>) {
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
  async acquire(count: number = 1, priority: Priority = 'normal'): Promise<void> {
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

    return new Promise<void>((resolve, reject) => {
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
        if (priDiff !== 0) return priDiff;
        return a.deadline - b.deadline;
      });
    });
  }

  /**
   * Try to acquire tokens without waiting.
   * Returns true if tokens were acquired, false if not.
   */
  tryAcquire(count: number = 1, priority: Priority = 'normal'): boolean {
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
  get state(): {
    availableTokens: number;
    pendingRequests: number;
    stats: { acquired: number; waited: number; rejected: number };
  } {
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
  destroy(): void {
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

  private refill(): void {
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

  private processQueue(): void {
    const now = Date.now();
    const toRemove: number[] = [];

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
export function createRateLimitedEmbedder(
  embedFn: (texts: string[]) => Promise<Float32Array[]>,
  limiter: RateLimiter
): (texts: string[], priority?: Priority) => Promise<Float32Array[]> {
  return async (texts: string[], priority: Priority = 'normal'): Promise<Float32Array[]> => {
    if (texts.length === 0) return [];

    // Each batch counts as 1 token regardless of batch size
    // This limits the number of API calls, not the number of texts
    await limiter.acquire(1, priority);
    return embedFn(texts);
  };
}
