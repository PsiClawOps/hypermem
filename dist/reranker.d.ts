/**
 * hypermem Reranker
 *
 * Pluggable reranking interface with circuit-breaker protection and graceful
 * degradation. Callers that receive null fall back to the original document
 * order without disruption.
 *
 * Providers:
 *   - ZeroEntropyReranker — https://api.zeroentropy.dev/v1/models/rerank (zerank-2)
 *   - OpenRouterReranker  — https://openrouter.ai/api/v1/rerank (cohere/rerank-4-pro)
 *   - OllamaReranker      — http://localhost:11434/api/chat (yes/no classification)
 *
 * API key resolution order (per provider):
 *   zeroentropy: config.zeroEntropyApiKey → ZEROENTROPY_API_KEY env var
 *   openrouter:  config.openrouterApiKey  → OPENROUTER_API_KEY env var
 */
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
export declare class ZeroEntropyReranker implements RerankerProvider {
    readonly name = "zeroentropy";
    private readonly circuit;
    private readonly apiKey;
    private readonly model;
    private readonly timeoutMs;
    constructor(apiKey: string, model?: string, timeoutMs?: number);
    rerank(query: string, documents: string[], topK?: number): Promise<RerankResult[] | null>;
}
export declare class OpenRouterReranker implements RerankerProvider {
    readonly name = "openrouter";
    private readonly circuit;
    private readonly apiKey;
    private readonly model;
    private readonly timeoutMs;
    constructor(apiKey: string, model?: string, timeoutMs?: number);
    rerank(query: string, documents: string[], topK?: number): Promise<RerankResult[] | null>;
}
export declare class OllamaReranker implements RerankerProvider {
    readonly name = "ollama";
    private readonly circuit;
    private readonly baseUrl;
    private readonly model;
    private readonly timeoutMs;
    constructor(baseUrl?: string, model?: string, timeoutMs?: number);
    /**
     * Scores documents sequentially — one chat call per document.
     * The Qwen3-Reranker-0.6B model responds with "yes" (relevant) or "no".
     * Score: yes → 1.0, anything else → 0.0.
     *
     * Sequential iteration is required because Ollama's /api/chat is stateless
     * per-request and running calls in parallel would overload a local GPU.
     * Returns null on the first failure to preserve circuit breaker semantics.
     */
    rerank(query: string, documents: string[], topK?: number): Promise<RerankResult[] | null>;
}
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
export declare function createReranker(config: RerankerConfig): RerankerProvider | null;
//# sourceMappingURL=reranker.d.ts.map