# Phase 5: AI providers (`packages/ai`)

Read first: `docs/specs/data-models.md` §9, `docs/specs/action-router.md` §5.2, `docs/SECURITY.md` §9–§10, ADR-012.
**Rules:** plain `fetch` only. No vendor SDKs. **No real API calls in tests or CI**; use a local fake HTTP server (`node:http`) with recorded responses (TESTING.md §5.3).

---

## P5-01 · FakeModelProvider

| Field | Value |
|---|---|
| depends_on | P1-02 |
| supervision | cheap-ok |
| size | S |
| spec | data-models §9; TESTING.md (FakeModel usage) |

**Files:** `packages/ai/src/fake-provider.ts`, `test/fake-provider.test.ts`.

**Requirements**
1. `new FakeModelProvider({ responder, latencyMs?, clock? })`, where `responder(req) => ModelResponse['json'] | string | Error`.
2. Records every request (`requests: ModelRequest[]`), exposes `calls` (number), `reset()`.
3. Simulated latency via `setTimeout(latencyMs)`, used by benchmarks (800 ms in the M3 test).
4. Usage: `inputTokens = ceil(promptChars / 4)`, `outputTokens = ceil(textChars / 4)`.
5. Helper `truthResponder(truthMap)`: answers `resolve_target` requests by looking up the intent in a map `{ [intent]: ref | null }` (benchmarks and tests feed it from fixtures).

**Tests:** counts, latency (fake timers), error propagation, truthResponder.

**Acceptance criteria**
- [ ] Used by all later router tests to assert `calls === 0` on deterministic paths

---

## P5-02 · OpenAI-compatible provider

| Field | Value |
|---|---|
| depends_on | P5-01 |
| supervision | cheap-ok |
| size | M |
| spec | data-models §9; protocol §6 (`models` config) |

**Files:** `packages/ai/src/openai-compatible.ts`, `src/http.ts` (shared fetch with timeout/abort/retry), `test/openai-compatible.test.ts`, `test/fixtures/openai-*.http.json`.

**Requirements**
1. `POST {baseUrl}/chat/completions` with `model`, `messages` (system + user/assistant; image parts as `image_url` data URLs), `temperature`, `max_tokens` (or `max_completion_tokens` when `config.maxTokensParam === 'max_completion_tokens'`).
2. JSON output:
   - if `supportsJsonSchema`: send `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`
   - otherwise: `response_format: { type: 'json_object' }` and append "Respond with JSON only." to the system prompt
   - parse `choices[0].message.content` as JSON into `json`
3. API key from `process.env[apiKeyEnv]` as `Authorization: Bearer`. Missing key → `LLM_UNAVAILABLE` (message names the env var, never prints a value).
4. Timeout via `AbortController` (`req.timeoutMs`). Retries: up to 2 on 429/500/502/503/504/network errors, with exponential backoff (250 ms, 1 s), honoring `Retry-After` ≤ 5 s. Then `LLM_UNAVAILABLE` (retryable).
5. Usage from `usage.prompt_tokens` / `completion_tokens`. If absent, estimate as in the Fake provider.
6. Never log request bodies or headers.

**Tests (fake server):** success with json_schema; success with json_object; 429 then success; 500×3 → `LLM_UNAVAILABLE`; timeout; malformed JSON content → `json` undefined and `text` preserved; missing API key; the request never contains the key in the body.

**Acceptance criteria**
- [ ] Works against Ollama (`http://localhost:11434/v1`) in a **manual** check (documented in the package README; not in CI)

---

## P5-03 · Anthropic provider

| Field | Value |
|---|---|
| depends_on | P5-02 |
| supervision | cheap-ok |
| size | S |
| spec | data-models §9 |

**Files:** `packages/ai/src/anthropic.ts`, `test/anthropic.test.ts`, fixtures.

**Requirements**
1. `POST https://api.anthropic.com/v1/messages` (base URL overridable), headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type`. Body: `model`, `system`, `messages` (image parts as base64 `image` blocks), `max_tokens`, `temperature`.
2. JSON output: when `jsonSchema` is set, append to the system prompt "Respond with a single JSON object matching this schema: <schema>" and parse the first text block. (Do not depend on beta structured-output features in MVP.)
3. Usage from `usage.input_tokens` / `output_tokens`. Same retry and timeout policy as P5-02 (reuse `http.ts`); also retry on 529.

**Tests:** as in P5-02, adapted.

**Acceptance criteria**
- [ ] Shares `http.ts`; no duplicated retry logic

---

## P5-04 · Model registry from config

| Field | Value |
|---|---|
| depends_on | P5-02, P5-03, P1-03 |
| supervision | cheap-ok |
| size | S |
| spec | protocol §6 |

**Files:** `packages/ai/src/registry.ts`, `test/registry.test.ts`.

**Requirements:** `ModelRegistry.fromConfig(config.models, env)` → `{ get(tier: ModelTier): ModelProvider | null }`. `provider: 'openai-compatible' | 'anthropic' | 'fake'`. A missing tier → `null` (the router disables that tier). Validate with `ConfigSchema`.

**Tests:** each provider kind; missing tiers; invalid config → `INVALID_REQUEST` with a readable zod message.

---

## P5-05 · Resolve-target prompt and output validation

| Field | Value |
|---|---|
| depends_on | P5-01 |
| supervision | cheap-ok (security review) |
| size | S |
| spec | action-router §5.2–5.2.1; SECURITY.md §9–§10 |

**Files:** `packages/ai/src/prompts/resolve-target.ts`, `src/resolve.ts`, tests `test/resolve-target.test.ts`.

**Requirements**
1. `RESOLVE_SYSTEM_PROMPT` (exact text from the spec) and `buildResolvePrompt({ actionType, intent, url, title, dialogs, candidates: SemanticElement[] }) → ModelRequest` (line format exactly as spec §5.2.1; values masked; `maxOutputTokens: 100`, `temperature: 0`, `timeoutMs: 10000`, `tier: 'fast'`, `purpose: 'resolve_target'`, `jsonSchema` = JSON Schema equivalent of `ResolveOutput`).
2. `resolveWithModel(provider, promptInput, candidates) → { ref: string | null, confidence, usage, retried }`:
   - validate with zod
   - on invalid output, retry once with an extra user message "Return only JSON matching the schema."
   - reject refs not in `candidates` (→ `ref: null`)
3. `dom` must not be imported by `ai`. Input elements are `SemanticElement` from `protocol`. Implement the element line formatter here, exactly per action-router §5.2.1. It intentionally mirrors `dom`'s compact line format. Add a test comparing both on a shared sample in P7-04, once both exist.

**Tests:** snapshot of a built prompt for a fixed candidate list; masked values; a password-field value never appears; out-of-list ref → null; invalid JSON twice → `LLM_INVALID_OUTPUT`; a token estimate for 30 candidates ≤ 1,500 (E1).

**Acceptance criteria**
- [ ] Prompt contains the untrusted-data framing sentence (S15 part)
