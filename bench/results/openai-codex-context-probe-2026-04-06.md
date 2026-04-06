# OpenAI Codex raw context probe, 2026-04-06

## Summary

Direct raw-provider probes against the ChatGPT Codex responses path show that the backend limit is model-specific.

| Model | Max approx accepted/completed | First fail approx | Notes |
|---|---:|---:|---|
| `gpt-5.4` | `921k` | `922k` | completion-confirmed near boundary |
| `gpt-5.4-mini` | `271k` | `272k` | request-acceptance boundary on raw path |
| `gpt-5.3-codex` | `271k` | `272k` | request-acceptance boundary on raw path |

## What this answers

- The current `272k` OpenClaw cap is **not** the raw backend limit for `gpt-5.4`.
- `gpt-5.4` on the raw Codex path is **well above 272k** and **below 1M**.
- `gpt-5.4-mini` and `gpt-5.3-codex` appear to sit right around `272k` even on the raw path.

## Probe path

These tests were done against the raw provider path, not the OpenClaw gateway/model cap path.

- Provider: `openai-codex`
- Endpoint: `https://chatgpt.com/backend-api/codex/responses`
- Auth: provider-owned OAuth profile used by OpenClaw
- Transport: `stream=true` SSE

## Method

Input load was generated with repeated minimal text (`"a "`) to approximate token count while minimizing output complexity.

Interpretation rules:
- `gpt-5.4`: near-boundary values were treated as success only when completion was observed.
- `gpt-5.4-mini` and `gpt-5.3-codex`: treated as accepted when request creation succeeded without explicit streaming error, and failed when explicit error/event failure appeared.

This means the `gpt-5.4` number is the strongest result of the three. The other two are still good operational boundaries, but with slightly weaker evidence than full completion confirmation.

## Boundary detail

### `gpt-5.4`

Observed:
- `920k`: completed
- `921k`: completed
- `922k`: failed
- `925k`: failed
- `1,000k`: failed

Representative failure: `context_length_exceeded`

### `gpt-5.4-mini`

Observed accepted up to `271k`, then failure at `272k` and above.

### `gpt-5.3-codex`

Observed accepted up to `271k`, then failure at `272k` and above.

## Operational implication

If OpenClaw raises `gpt-5.4` beyond `272k`, it should not assume the same ceiling applies across all Codex GPT-5 variants.

A reasonable interpretation of this run:
- `gpt-5.4`: candidate for a much higher configured cap
- `gpt-5.4-mini`: keep near current `272k`
- `gpt-5.3-codex`: keep near current `272k`

## Artifact

Machine-readable companion file:
- `bench/results/openai-codex-context-probe-2026-04-06.json`
