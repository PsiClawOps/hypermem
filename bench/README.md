# HyperMem Benchmark Suite

**Architecture-neutral memory system benchmark for OpenClaw agents.**

## Methodology

Sequential A/B testing on identical OpenClaw stacks. The ONLY variable between runs is the memory system hook.

- Same Docker image (OpenClaw 2026.3.28)
- Same agent config, system prompt, model, token budget
- Same conversation dataset
- Same hardware (sequential, not parallel — no resource contention)
- Clean teardown between runs (`docker compose down -v`)

## Memory Systems Tested

| System | Type | Hook adapter |
|---|---|---|
| noop (baseline) | No memory | Passes through raw context, no retrieval |
| HyperMem | SQLite + Redis compositor | Native Node.js hook |
| Mem0 | Vector + graph memory | Python subprocess adapter |
| Letta (MemGPT) | Self-editing memory | REST API adapter |

## Running

```bash
./run-bench.sh
```

Results land in `results/`. Final comparison: `results/comparison.md`.

## Dataset

Uses LoCoMo (Long Conversation Memory) — 81 Q&A pairs across multi-session conversations.

## Scoring

- F1 (token overlap)
- BLEU-1 (unigram precision)
- J (LLM-as-Judge — GPT-4 or equivalent rates answer quality 1-5)
- Latency (p50, p95, p99 for record + compose operations)
- Token usage (context tokens consumed per response)
