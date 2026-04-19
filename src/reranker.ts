/**
 * hypermem Reranker
 *
 * Pluggable reranking interface with circuit-breaker protection and graceful
 * degradation. Callers that receive null fall back to the original document
 * order without disruption.
 *
 * Providers:
 *   - ZeroEntropyReranker — https://api.zeroentropy.dev/v1/rerank (zerank-2)
 *   - OpenRouterReranker  — https://openrouter.ai/api/v1/rerank (cohere/rerank-4-pro)
 *   - OllamaReranker      — http://localhost:11434/api/chat (yes/no classification)
 *
 * API key resolution order (per provider):
 *   zeroentropy: config.zeroEntropyApiKey → ZEROENTROPY_API_KEY env var
 *   openrouter:  config.openrouterApiKey  → OPENROUTER_API_KEY env var
 */

// ── Circuit Breaker ───────────────────────────────────────────────────────────
/** Number of consecutive failures before the circuit opens. */
const CIRCUIT_FAILURE_THRESHOLD = 3;
/** How long the circuit stays open after tripping (ms). */
const CIRCUIT_DISABLE_DURATION_MS = 60_000;

/**
 * CircuitBreaker protects a provider from repeated calls during sustained
 * failures.
 *
 * State machine:
 *   CLOSED  — normal operation; failures increment the counter.
 *   OPEN    — provider disabled; isOpen() returns true for DISABLE_DURATION.
 *   HALF-OPEN — one probe allowed after the disable window expires;
 *               success resets the counter, failure re-opens the circuit.
 *
 * Transition: CLOSED → OPEN when consecutiveFailures >= FAILURE_THRESHOLD.
 * Transition: OPEN → HALF-OPEN when Date.now() >= disabledUntil.
 * Transition: HALF-OPEN → CLOSED on recordSuccess().
 * Transition: HALF-OPEN → OPEN on recordFailure() (reset window starts fresh).
 */
class CircuitBreaker {
  /** Consecutive failures since last success. Reset to 0 on any success. */
  consecutiveFailures = 0;

  /**
   * Epoch ms after which the circuit allows a probe.
   * 0 means the circuit is CLOSED (not disabled).
   */
  disabledUntil = 0;

  /** Returns true when the provider should be skipped. */
  isOpen(): boolean {
    if (this.disabledUntil === 0) return false; // CLOSED
    if (Date.now() >= this.disabledUntil) {
      // Disable window expired — transition to HALF-OPEN: allow one probe.
      // We clear disabledUntil here so the next call goes through.
      // If it fails, recordFailure() re-opens the circuit with a fresh window.
      this.disabledUntil = 0;
      return false;
    }
    return true; // OPEN
  }

  /** Call on a successful provider response. Resets all failure state. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.disabledUntil = 0;
  }

  /**
   * Call on any provider failure (non-2xx, timeout, parse error, etc.).
   * After CIRCUIT_FAILURE_THRESHOLD consecutive failures, opens the circuit
   * for CIRCUIT_DISABLE_DURATION_MS milliseconds.
   */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      // Trip the circuit — disable for the configured window.
      // Reset consecutiveFailures so the probe after the window isn't
      // pre-tripped by the old count.
      this.disabledUntil = Date.now() + CIRCUIT_DISABLE_DURATION_MS;
      this.consecutiveFailures = 0;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns an AbortController that fires after `ms` and a cleanup handle. */
function withTimeout(ms: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { controller, clear: () => clearTimeout(id) };
}

// ── Public Types ──────────────────────────────────────────────────────────────

export interface RerankResult {
  index: number;
  score: number;
  content: string;
}

export interface RerankerProvider {
  readonly name: string;
  /**
   * Reranks `documents` by relevance to `query`.
   * Returns null on any failure — callers MUST fall back to original order.
   */
  rerank(query: string, documents: string[], topK?: number): Promise<RerankResult[] | null>;
}

export interface RerankerConfig {
  provider: 'zeroentropy' | 'openrouter' | 'local' | 'none';
  minCandidates: number;
  maxDocuments: number;
  topK: number;
  timeoutMs: number;
  zeroEntropyApiKey?: string;
  zeroEntropyModel?: string;
  openrouterApiKey?: string;
  openrouterModel?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
}

// ── ZeroEntropyReranker ───────────────────────────────────────────────────────

export class ZeroEntropyReranker implements RerankerProvider {
  readonly name = 'zeroentropy';
  private readonly circuit = new CircuitBreaker();
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model = 'zerank-2', timeoutMs = 2000) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async rerank(query: string, documents: string[], topK = 10): Promise<RerankResult[] | null> {
    if (this.circuit.isOpen()) return null;
    const { controller, clear } = withTimeout(this.timeoutMs);
    try {
      const response = await fetch('https://api.zeroentropy.dev/v1/rerank', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ query, documents, model: this.model, top_n: topK }),
        signal: controller.signal,
      });
      clear();
      if (!response.ok) {
        this.circuit.recordFailure();
        return null;
      }
      const data = (await response.json()) as {
        results: { index: number; score?: number; relevance_score?: number; content?: string; document?: string | { text?: string } }[];
      };
      if (!Array.isArray(data.results)) {
        this.circuit.recordFailure();
        return null;
      }
      this.circuit.recordSuccess();
      return data.results.map((r) => {
        const score = r.score ?? r.relevance_score ?? 0;
        const content = resolveDocumentText(r.content, r.document, documents[r.index]);
        return { index: r.index, score, content };
      });
    } catch {
      clear();
      this.circuit.recordFailure();
      return null;
    }
  }
}

// ── OpenRouterReranker ────────────────────────────────────────────────────────

export class OpenRouterReranker implements RerankerProvider {
  readonly name = 'openrouter';
  private readonly circuit = new CircuitBreaker();
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model = 'cohere/rerank-4-pro', timeoutMs = 2000) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async rerank(query: string, documents: string[], topK = 10): Promise<RerankResult[] | null> {
    if (this.circuit.isOpen()) return null;
    const { controller, clear } = withTimeout(this.timeoutMs);
    try {
      const response = await fetch('https://openrouter.ai/api/v1/rerank', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ query, documents, model: this.model, top_n: topK }),
        signal: controller.signal,
      });
      clear();
      if (!response.ok) {
        this.circuit.recordFailure();
        return null;
      }
      const data = (await response.json()) as {
        results: { index: number; relevance_score?: number; score?: number; document?: string | { text?: string } }[];
      };
      if (!Array.isArray(data.results)) {
        this.circuit.recordFailure();
        return null;
      }
      this.circuit.recordSuccess();
      return data.results.map((r) => {
        const score = r.relevance_score ?? r.score ?? 0;
        const content = resolveDocumentText(undefined, r.document, documents[r.index]);
        return { index: r.index, score, content };
      });
    } catch {
      clear();
      this.circuit.recordFailure();
      return null;
    }
  }
}

// ── OllamaReranker ────────────────────────────────────────────────────────────

const OLLAMA_SYSTEM_PROMPT =
  'Judge whether the Document meets the requirements based on the Query and the Instruct provided. ' +
  'Note that the answer can only be "yes" or "no".';

export class OllamaReranker implements RerankerProvider {
  readonly name = 'ollama';
  private readonly circuit = new CircuitBreaker();
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(
    baseUrl = 'http://localhost:11434',
    model = 'dengcao/Qwen3-Reranker-0.6B:Q5_K_M',
    timeoutMs = 10_000,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Scores documents sequentially — one chat call per document.
   * The Qwen3-Reranker-0.6B model responds with "yes" (relevant) or "no".
   * Score: yes → 1.0, anything else → 0.0.
   *
   * Sequential iteration is required because Ollama's /api/chat is stateless
   * per-request and running calls in parallel would overload a local GPU.
   * Returns null on the first failure to preserve circuit breaker semantics.
   */
  async rerank(query: string, documents: string[], topK = 10): Promise<RerankResult[] | null> {
    if (this.circuit.isOpen()) return null;
    const scored: RerankResult[] = [];
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const userContent =
        `Instruct: Given a query, retrieve relevant passages that answer the query\n\n` +
        `Query: ${query}\n\nDocument: ${doc}`;
      const { controller, clear } = withTimeout(this.timeoutMs);
      try {
        const response = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: OLLAMA_SYSTEM_PROMPT },
              { role: 'user', content: userContent },
            ],
            stream: false,
          }),
          signal: controller.signal,
        });
        clear();
        if (!response.ok) {
          this.circuit.recordFailure();
          return null;
        }
        const data = (await response.json()) as { message?: { content?: string } };
        const answer = (data.message?.content ?? '').trim().toLowerCase();
        // "yes" prefix → relevant; anything else (including "no") → not relevant
        const score = answer.startsWith('yes') ? 1.0 : 0.0;
        scored.push({ index: i, score, content: doc });
      } catch {
        clear();
        this.circuit.recordFailure();
        return null;
      }
    }
    this.circuit.recordSuccess();
    // Sort by score descending and return top-K
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Creates a RerankerProvider from the supplied config.
 *
 * API key resolution order:
 *   zeroentropy: config.zeroEntropyApiKey → ZEROENTROPY_API_KEY env var
 *   openrouter:  config.openrouterApiKey  → OPENROUTER_API_KEY env var
 *
 * Returns null when:
 *   - provider is 'none'
 *   - provider is 'zeroentropy' and no key found in config or env
 *   - provider is 'openrouter' and no key found in config or env
 *
 * 'local' (Ollama) never returns null from the factory — it has no required
 * API key. The provider itself returns null on runtime failure.
 */
export function createReranker(config: RerankerConfig): RerankerProvider | null {
  switch (config.provider) {
    case 'none':
      return null;

    case 'zeroentropy': {
      const apiKey = config.zeroEntropyApiKey ?? process.env['ZEROENTROPY_API_KEY'];
      if (!apiKey) return null;
      return new ZeroEntropyReranker(apiKey, config.zeroEntropyModel ?? 'zerank-2', config.timeoutMs);
    }

    case 'openrouter': {
      const apiKey = config.openrouterApiKey ?? process.env['OPENROUTER_API_KEY'];
      if (!apiKey) return null;
      return new OpenRouterReranker(apiKey, config.openrouterModel ?? 'cohere/rerank-4-pro', config.timeoutMs);
    }

    case 'local': {
      return new OllamaReranker(
        config.ollamaUrl ?? 'http://localhost:11434',
        config.ollamaModel ?? 'dengcao/Qwen3-Reranker-0.6B:Q5_K_M',
        config.timeoutMs,
      );
    }
  }
}

// ── Private Helpers ───────────────────────────────────────────────────────────

/**
 * Resolves the document text from a reranking API response.
 * Preference order: explicit `content` string → `document` string →
 * `document.text` string → original document from the input array.
 */
function resolveDocumentText(
  content: string | undefined,
  document: string | { text?: string } | null | undefined,
  fallback: string | undefined,
): string {
  if (typeof content === 'string') return content;
  if (typeof document === 'string') return document;
  if (document !== null && typeof document === 'object' && typeof document.text === 'string') {
    return document.text;
  }
  return fallback ?? '';
}
