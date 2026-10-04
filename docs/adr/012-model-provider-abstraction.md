# ADR-012: Model Provider Abstraction

Status: Accepted (2026-10-02)

## Context

The LLM tier must work with OpenAI, Anthropic, Gemini, OpenRouter and local models (Ollama, vLLM, LM Studio, llama.cpp server). The router needs only one narrow capability: given a short prompt and a JSON schema, return JSON plus token usage. Browser-OS must also work with **no model at all** (cache + deterministic + human).

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Vercel AI SDK (`ai`) (Stagehand v3 uses it) | Many providers | Large dependency surface, frequent breaking changes, abstractions we don't need |
| Vendor SDKs (`openai`, `@anthropic-ai/sdk`) | Official | Multiple heavy deps; vendor types leak |
| LangChain | Ecosystem | Very heavy; agent-framework baggage |
| **Own `ModelProvider` interface + plain `fetch` implementations** | Tiny, dependency-free, testable, vendor-neutral | We maintain two small HTTP clients |

## Decision

- `ModelProvider { id; complete(ModelRequest, signal?): Promise<ModelResponse> }` lives in `@browser-os/protocol` (`specs/data-models.md` §9). Requests carry `purpose`, `tier` (`fast` | `capable` | `vision`), system + messages, optional `jsonSchema`, `maxOutputTokens`, `temperature`, `timeoutMs`.
- Implementations in `packages/ai` using global `fetch` only:
  - `OpenAICompatibleProvider` (`/chat/completions`): covers OpenAI, Ollama, vLLM, LM Studio, llama.cpp server, OpenRouter, Gemini's OpenAI-compatible endpoint. Uses `response_format: json_schema` when `supportsJsonSchema` is set; otherwise prompt-instructed JSON.
  - `AnthropicProvider` (`/v1/messages`).
  - `FakeModelProvider`: scripted responses, records requests, call counter. Used by all CI tests and the "no LLM on deterministic path" assertions.
- Bounded retries on 429/5xx (max 2, backoff); timeouts via `AbortSignal`.
- Outputs are always re-validated by the caller with zod; invalid output → one retry → `LLM_INVALID_OUTPUT`.
- Tiers are user-configured in `config.json` (`models.fast/capable/vision`), API keys referenced by env var name only, never stored. No model configured → llm tier disabled (`LLM_DISABLED`), everything else works.
- **Not allowed** without a new ADR: `openai`, `@anthropic-ai/sdk`, `ai`, `langchain`, any LLM SDK.
- MVP uses only the `fast` tier for `resolve_target` (and optional `extract`). `vision` tier is used by P13-03.

## Consequences

Positive: zero LLM dependencies; vendor details confined to `packages/ai`; deterministic CI.
Negative: we track provider API changes ourselves (small surface).
Follow-ups: P5-01…P5-05.

## Revisit when

- A required provider feature (e.g. a new structured-output mode, vision input format) costs more than ~300 LOC to support ourselves.

## References

- `specs/data-models.md` §9, `specs/action-router.md` §5.2, `specs/protocol.md` §6, `CODING_AGENT.md` §6
