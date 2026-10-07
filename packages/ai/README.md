# @browser-os/ai

ModelProvider implementations (openai-compatible, anthropic, fake), registry and prompts.

Plain `fetch` only — no vendor SDKs (ADR-012). Tests never call a real API: they use a local
`node:http` fake server with recorded responses.

## Providers

| Provider | Class | Endpoint |
|---|---|---|
| `openai-compatible` | `OpenAiCompatibleProvider` | `POST {baseUrl}/chat/completions` |
| `anthropic` | `AnthropicProvider` | `POST {baseUrl}/v1/messages` |
| `fake` | `FakeModelProvider` | none (in-process responder) |

Retry, timeout and backoff live in `src/http.ts` and are shared by both HTTP providers, so the
policy cannot drift between them. The API key is read from `process.env[apiKeyEnv]` and sent only
in a header — never in the body, never logged. A missing key raises `LLM_UNAVAILABLE` naming the
environment variable, never the value.

## ModelRegistry

```ts
ModelRegistry.fromConfig(config.models) // -> { get(tier: ModelTier): ModelProvider | null }
```

A missing or `null` tier returns `null`, which tells the router to disable that tier. Invalid
config raises `BosError('INVALID_REQUEST')` whose message carries zod's path and issue wording
(for example `fast.provider: Invalid enum value ...`), with the structured issues under
`details.issues`.

## Manual check against Ollama (not run in CI)

CI uses the fake server, so the real-wire path against a local OpenAI-compatible server is
verified by hand. This is a manual, opt-in step and is deliberately kept out of CI:

```bash
# 1. serve a local model
ollama serve &
ollama pull llama3.2

# 2. run one request through the registry
node --input-type=module -e '
  import { ModelRegistry } from "./packages/ai/dist/index.js";
  const registry = ModelRegistry.fromConfig({
    fast: {
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.2",
      apiKeyEnv: "OLLAMA_API_KEY",
    },
  });
  const res = await registry.get("fast").complete({
    purpose: "resolve_target",
    tier: "fast",
    system: "Answer with JSON only.",
    messages: [{ role: "user", content: [{ type: "text", text: "Return {\"ref\":null}" }] }],
    temperature: 0,
    maxOutputTokens: 100,
    timeoutMs: 10000,
  });
  console.log(res.text, res.usage);
'
```

Expect `choices[0].message.content` to parse as JSON. Ollama ignores `Authorization`, so an empty
`OLLAMA_API_KEY` is fine. Keep `supportsJsonSchema` off for models that do not implement
structured output: the provider then falls back to `response_format: { type: "json_object" }` and
appends "Respond with JSON only." to the system prompt.
