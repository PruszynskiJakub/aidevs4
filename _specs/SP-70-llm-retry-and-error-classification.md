# SP-70 LLM Retry and Error Classification

## Main objective

Classify LLM errors as transient vs fatal, configure SDK retry for both providers, and add a post-retry error classifier so that quota and auth errors surface with clear messages after SDK retries are exhausted.

## Context

### Current state

Both LLM providers (`src/llm/openai.ts`, `src/llm/gemini.ts`) make bare API calls with no error handling. Errors propagate uncaught through the router (`src/llm/router.ts`) into the agent loop (`src/agent/loop.ts`), where the outer try/catch emits `agent.failed` and re-throws — ending the session.

**OpenAI SDK already retries internally** — `new OpenAI()` defaults to 2 retries with exponential backoff (0.5s base, 8s max, 25% jitter), and respects `retry-after` / `x-should-retry` headers.

**Gemini SDK defaults to 5 retry attempts** via built-in `p-retry` integration when `retryOptions` is not explicitly set. The retry covers 429, 500, 502, 503, 504.

### SDK retry limitation (known trade-off)

Neither SDK exposes a hook to intercept retry decisions or emit events during internal retries. Both SDKs retry **all** 429s — including `insufficient_quota` (OpenAI) and `RESOURCE_EXHAUSTED` (Gemini) — before throwing. OpenAI may send `x-should-retry: false` for quota errors, which the SDK respects, but this is undocumented behavior.

This means fatal 429 errors may incur ~3.5s of wasted retries (0.5s + 1s + 2s backoff) before the router-level classifier sees them. This is an acceptable trade-off vs. the complexity of disabling SDK retry and reimplementing it. The classifier's value is in **clear error messages and event emission**, not in saving retry time.

### Error classification (single source of truth)

| Error | Source | Code | Classification |
|---|---|---|---|
| `RateLimitError` | OpenAI | 429 | Transient — SDK retries automatically |
| `insufficient_quota` | OpenAI | 429 | **Fatal** — billing issue (SDK may retry before surfacing) |
| `InternalServerError` | OpenAI | 500+ | Transient — SDK retries automatically |
| `APIConnectionError` | OpenAI | — | Transient — SDK retries automatically |
| `APIConnectionTimeoutError` | OpenAI | — | Transient — SDK retries automatically |
| `AuthenticationError` | OpenAI | 401 | **Fatal** — bad key (no SDK retry) |
| `BadRequestError` | OpenAI | 400 | **Fatal** — invalid input (no SDK retry) |
| `PermissionDeniedError` | OpenAI | 403 | **Fatal** — access denied (no SDK retry) |
| Server errors | Gemini | 429, 500-504 | Transient — SDK retries automatically |
| `RESOURCE_EXHAUSTED` | Gemini | 429 | **Fatal** — quota (SDK may retry before surfacing) |
| Timeout (`AbortSignal`) | Gemini | — | Transient |
| Network errors (`ECONNRESET`, etc.) | Any | — | Transient |

### What works well (keep as-is)

- Tool dispatch uses `Promise.allSettled` — individual tool failures don't crash the loop
- Memory processing has graceful degradation — falls back to uncompressed state on error
- Moderation has fail-open policy with logging
- Event bus isolates listener errors

## Out of scope

- Cross-provider fallback (e.g., OpenAI down → try Gemini)
- Circuit breaker pattern
- CLI or server error handling improvements
- File I/O error handling
- Retry logic for non-LLM HTTP calls (hub-fetch, serper, web tool)
- Streaming response retry (not currently used)
- Thundering herd mitigation for concurrent retries
- Pre-retry interception of fatal errors (accepted trade-off — see above)

## Constraints

- Delegate retry to SDK built-in mechanisms — do not add a custom retry wrapper on top
- LLM-specific error classifier lives in `src/llm/` (not `src/utils/`) to keep dependency direction correct
- Error classification and events happen **after** SDK retries are exhausted (post-retry), not before
- No new dependencies
- LLM calls are assumed idempotent (no side effects) — safe to retry

## Acceptance criteria

- [ ] OpenAI client configured with `maxRetries: 2` (explicit, matching current SDK default — can be tuned later via config)
- [ ] Gemini client configured with explicit `retryOptions.attempts` from config (currently implicit SDK default of 5)
- [ ] `src/llm/errors.ts` exports `isFatalLLMError(err): boolean` classifying errors per the table above
- [ ] `ProviderRegistry` wraps provider calls in try/catch — on error, classifies it, emits `llm.call.failed` event with classification, then re-throws
- [ ] `llm.call.failed` event includes: model, error message, whether the error is fatal or transient, and error code
- [ ] Fatal errors propagate with their original error message (no wrapping)
- [ ] `config.retry` section with `openaiMaxRetries` and `geminiMaxAttempts`
- [ ] Existing tests continue to pass
- [ ] New tests cover: error classification for each fatal/transient type in the table

## Implementation plan

1. **Create `src/llm/errors.ts`** — LLM error classifier
   - Export `isFatalLLMError(err: unknown): boolean`
   - Handles OpenAI SDK error classes and Gemini error patterns per the classification table

2. **Add `llm.call.failed` event to `src/types/events.ts`**
   - Emitted once per failed LLM call (after SDK retries exhausted)
   - Payload: `{ model, error, fatal, code? }`

3. **Configure OpenAI SDK retry** in `src/llm/openai.ts`
   - Pass `maxRetries` from config to `new OpenAI({ maxRetries })`
   - When `client` is injected (test path), respect the injected client's config

4. **Configure Gemini SDK retry** in `src/llm/gemini.ts`
   - Pass explicit `httpOptions.retryOptions.attempts` from config to `GoogleGenAI` constructor

5. **Wire error classification into `ProviderRegistry`** in `src/llm/router.ts`
   - Wrap `chatCompletion()` and `completion()` in try/catch
   - On error: classify via `isFatalLLMError()`, emit `llm.call.failed`, re-throw

6. **Add retry config** in `src/config/index.ts`
   - New `retry` section: `{ openaiMaxRetries: 2, geminiMaxAttempts: 5 }`

7. **Write tests** in `src/llm/errors.test.ts`
   - Classification accuracy for each error type in the table

## Testing scenarios

| Scenario | Verification |
|---|---|
| `insufficient_quota` (429) | Classified as fatal, `llm.call.failed` emitted with `fatal: true` |
| Auth error (401) | Classified as fatal, no SDK retry (401 is not retried by SDK) |
| Bad request (400) | Classified as fatal |
| `PermissionDeniedError` (403) | Classified as fatal |
| Gemini `RESOURCE_EXHAUSTED` | Classified as fatal |
| Rate limit (429, non-quota) | Classified as transient, `llm.call.failed` emitted with `fatal: false` |
| Server error (500+) | Classified as transient |
| Connection error | Classified as transient |
| Success on first try | No event emitted, no overhead |
| Router integration | `ProviderRegistry` emits `llm.call.failed` on provider error |
