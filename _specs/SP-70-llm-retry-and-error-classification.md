# SP-70 LLM Retry and Error Classification

## Main objective

Classify LLM errors as transient vs fatal, leverage built-in SDK retry for OpenAI, enable opt-in retry for Gemini, and add a fatal-error fast-fail layer so that quota exhaustion and auth errors fail immediately while transient errors are retried with backoff.

## Context

### Current state

Both LLM providers (`src/llm/openai.ts`, `src/llm/gemini.ts`) make bare API calls with no error handling. Errors propagate uncaught through the router (`src/llm/router.ts`) into the agent loop (`src/agent/loop.ts`), where the outer try/catch emits `agent.failed` and re-throws — ending the session.

**OpenAI SDK already retries internally** — `new OpenAI()` defaults to 2 retries with exponential backoff (0.5s base, 8s max, 25% jitter), and respects `retry-after` / `x-should-retry` headers. However, it retries *all* 429s including `insufficient_quota`, which wastes time on billing errors.

**Gemini SDK has opt-in retry** via `httpOptions.retryOptions` (backed by `p-retry`), but the codebase does not enable it. Gemini calls currently have no retry.

### Error classification (single source of truth)

| Error | Source | Code | Classification |
|---|---|---|---|
| `RateLimitError` | OpenAI | 429 | Transient — SDK retries automatically |
| `insufficient_quota` | OpenAI | 429 | **Fatal** — billing issue, must fast-fail |
| `InternalServerError` | OpenAI | 500+ | Transient — SDK retries automatically |
| `APIConnectionError` | OpenAI | — | Transient — SDK retries automatically |
| `APIConnectionTimeoutError` | OpenAI | — | Transient — SDK retries automatically |
| `AuthenticationError` | OpenAI | 401 | **Fatal** — bad key |
| `BadRequestError` | OpenAI | 400 | **Fatal** — invalid input |
| `PermissionDeniedError` | OpenAI | 403 | **Fatal** — access denied |
| Server errors | Gemini | 429, 500-504 | Transient — SDK retries (when enabled) |
| `RESOURCE_EXHAUSTED` | Gemini | 403/429 | **Fatal** — quota |
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

## Constraints

- Do not add custom retry on top of OpenAI SDK's built-in retry — configure the SDK instead (avoid double-retry / up to 9 attempts)
- LLM-specific error classifier lives in `src/llm/` (not `src/utils/`) to keep dependency direction correct (`llm/ → utils/`, never `utils/ → llm/`)
- Retry events use the event bus for observability (Langfuse traces, session logs), not `console.warn`
- No new dependencies
- LLM calls are assumed idempotent (no side effects) — safe to retry
- `maxAttempts` means total attempts including the first call (3 = 1 original + 2 retries)

## Acceptance criteria

- [ ] OpenAI client configured with `maxRetries: 3` (up from default 2)
- [ ] Gemini client configured with `retryOptions` enabled (retry on 429, 500-504)
- [ ] Fatal error classifier at router level: `insufficient_quota`, `AuthenticationError`, `BadRequestError`, `PermissionDeniedError`, and Gemini `RESOURCE_EXHAUSTED` throw immediately without SDK retry
- [ ] `ProviderRegistry` wraps provider calls to catch and classify errors — fatal errors re-thrown immediately, transient errors left to SDK retry
- [ ] New events `llm.retry_attempted` and `llm.retry_exhausted` emitted via event bus
- [ ] `config.retry` gains `openaiMaxAttempts: 3` and `geminiMaxAttempts: 4`
- [ ] Fatal errors propagate with their original error message (no wrapping)
- [ ] Existing tests continue to pass
- [ ] New tests cover: fatal error fast-fail, quota exhaustion detection, error classification accuracy

## Implementation plan

1. **Create `src/llm/errors.ts`** — LLM error classifier
   - Export `isFatalLLMError(err: unknown): boolean` — returns true for errors that must not be retried
   - Handles both OpenAI SDK error classes and Gemini error patterns
   - Uses the classification table above as the source of truth

2. **Add retry events to `src/types/events.ts`**
   - `llm.retry_attempted` — emitted on each retry with model, attempt number, error summary, delay
   - `llm.retry_exhausted` — emitted when all retries fail

3. **Configure OpenAI SDK retry** in `src/llm/openai.ts`
   - Pass `maxRetries` from config to `new OpenAI({ maxRetries })`

4. **Enable Gemini SDK retry** in `src/llm/gemini.ts`
   - Pass `retryOptions` to `GoogleGenAI` constructor with max attempts from config

5. **Wire fatal-error fast-fail into `ProviderRegistry`** in `src/llm/router.ts`
   - Wrap provider calls: catch errors, check `isFatalLLMError()`, re-throw fatal errors immediately
   - For transient errors that exhausted SDK retries, emit `llm.retry_exhausted` and re-throw
   - Emit `llm.retry_attempted` via an SDK retry callback if available, or infer from error timing

6. **Add retry config** in `src/config/index.ts`
   - New `retry` section (not flat in `limits`) with `openaiMaxAttempts` and `geminiMaxAttempts`

7. **Write tests** in `src/llm/errors.test.ts`
   - Fatal error classification for each error type in the table
   - Transient error classification
   - Edge cases: `insufficient_quota` on 429, Gemini `RESOURCE_EXHAUSTED`

## Testing scenarios

| Scenario | Verification |
|---|---|
| Quota exhaustion (`insufficient_quota`) | Throws immediately, no retry, `llm.retry_exhausted` not emitted |
| Auth error (401) | Throws immediately, no retry |
| Bad request (400) | Throws immediately, no retry |
| Gemini `RESOURCE_EXHAUSTED` | Throws immediately, no retry |
| OpenAI rate limit (non-quota) | SDK retries internally, succeeds or emits `llm.retry_exhausted` |
| Gemini server error (503) | SDK retries internally with enabled `retryOptions` |
| Success on first try | No events emitted, no overhead |
| All retries exhausted | `llm.retry_exhausted` emitted, original error thrown |
