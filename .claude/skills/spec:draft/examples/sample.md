# SP-03 Support error recovery in agent loop

## Main objective

Add automatic error recovery to the agent loop so transient failures (API
timeouts, rate limits, tool crashes) are retried instead of aborting the run.

## Context

The agent loop in `src/agent.ts` currently makes a single attempt per tool call
and per LLM request. Any error — including transient ones like 429 rate-limit
responses or network timeouts — immediately terminates the run. This forces
manual reruns and loses accumulated conversation context.

The tool dispatcher (`src/tools/dispatcher.ts`) catches tool errors but
re-throws them without retry logic.

## Out of scope

- Circuit-breaker / fallback patterns (future spec)
- Retry for streaming responses
- Persisting conversation state to disk for crash recovery

## Constraints

- No new runtime dependencies — use only built-in `setTimeout` / `Bun.sleep`
- Retry delay must not exceed 30 seconds total per call
- Must not break existing tool interface (`ToolDefinition`)

## Acceptance criteria

- [ ] LLM API calls retry up to 3 times on transient errors (429, 5xx, timeout)
- [ ] Tool executions retry once on non-deterministic failures
- [ ] Retry uses exponential back-off (1s, 2s, 4s base)
- [ ] Permanent errors (4xx except 429, validation errors) fail immediately
- [ ] Agent run resumes from the last successful step after recovery
- [ ] All retries are logged with attempt number and error summary

## Implementation plan

1. Create `src/utils/retry.ts` with a generic `withRetry(fn, opts)` helper
   supporting configurable max attempts, back-off strategy, and retriable-error
   predicate.
2. Wrap the OpenAI chat completion call in `src/agent.ts` with `withRetry`,
   classifying 429 / 5xx / ETIMEDOUT as retriable.
3. Wrap tool dispatch in `src/tools/dispatcher.ts` with `withRetry` (max 1
   retry), treating only unexpected runtime errors as retriable.
4. Add structured logging for each retry attempt via the existing output utils.

## Testing scenarios

- Unit test `withRetry`: succeeds on first try, succeeds after transient
  failure, gives up after max attempts, skips retry on permanent error.
- Integration test agent loop with a mock LLM that returns 429 once then
  succeeds — verify the run completes and retry is logged.
- Integration test tool dispatch with a tool that throws once then succeeds.
