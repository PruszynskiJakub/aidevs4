# SP-08 Agent Observability

## Main objective

Add transparent, structured console logging of every agent loop step — LLM calls, tool calls, tool results, errors, and timing — so the developer can see exactly what is happening and debug problems.

## Context

Today the agent loop (`src/agent.ts`) logs only two things:
- `→ tool_name(args)` before dispatch
- `✓ tool_name done` after dispatch

Everything else is invisible: tool return values, errors (silently wrapped in `{ error }` JSON), execution timing, LLM token usage, and iteration progress. Debugging requires adding ad-hoc `console.log` calls and removing them afterwards.

The OpenAI API returns `usage` data (prompt/completion tokens) but `createOpenAIProvider` discards it. `LLMChatResponse` has no field for it.

## Out of scope

- Log file output (console only for now)
- External observability services (OpenTelemetry, Datadog, etc.)
- Log persistence or rotation
- Modifying tool implementations — logging is added at the agent/dispatcher layer only

## Constraints

- No new runtime dependencies — use only `console` and Bun built-ins
- Logging must not alter the data flowing through the agent loop (tool results, message history)
- Must not break existing tests
- Keep the logger simple — a thin utility, not a framework

## Acceptance criteria

- [ ] A `src/services/logger.ts` module provides `log.info()`, `log.success()`, `log.error()`, `log.debug()` functions with colour-coded, prefixed console output
- [ ] Each agent iteration prints its number (e.g., `[iter 1/20]`)
- [ ] Each LLM call logs: model name, message count, and duration (e.g., `LLM ← gpt-4.1 | 4 msgs | 2.3s`)
- [ ] LLM token usage (prompt + completion tokens) is logged after each call (e.g., `tokens: 1240 in / 85 out`)
- [ ] Each tool call logs the tool name and full arguments (keep existing `→` format)
- [ ] Each tool result is logged in full (e.g., `← tool_name: { ... }`)
- [ ] Tool errors are logged with a distinct error prefix/colour (e.g., `✗ tool_name: error message`)
- [ ] Tool execution duration is logged per call (e.g., `✓ tool_name done [1.2s]`)
- [ ] When parallel tool calls complete, a summary line shows total batch duration
- [ ] The agent's final text response is logged clearly
- [ ] Max-iteration warning is logged as an error

## Implementation plan

1. **Create `src/services/logger.ts`**
   - Export a `log` object with methods: `info`, `success`, `error`, `debug`
   - Each method prints to console with a colour prefix (ANSI codes): info=cyan, success=green, error=red, debug=dim/grey
   - Formatting: `[prefix] message` — one-line for short messages, indented block for multi-line
   - Add a `duration(startMs: number)` helper that returns a formatted string like `[1.23s]`

2. **Extend `LLMChatResponse` with usage metadata**
   - Add optional `usage?: { promptTokens: number; completionTokens: number }` to `LLMChatResponse` in `src/types/llm.ts`
   - Update `toResponse()` in `src/services/llm.ts` to populate `usage` from the OpenAI response object (available on `response.usage`)

3. **Instrument the agent loop (`src/agent.ts`)**
   - Log iteration number at the start of each loop pass
   - Wrap the `provider.chatCompletion()` call with timing; log model, message count, duration, and token usage
   - Keep existing `→ tool(args)` log for tool dispatch
   - After `Promise.allSettled`, log each result:
     - Success: `← tool_name: <full JSON result>` + `✓ tool_name done [Xs]`
     - Error: `✗ tool_name: <error message>` with error styling
   - Log a batch summary line when multiple tools run in parallel (count + total duration)
   - Log the final assistant response with a clear delimiter
   - Change max-iteration warning to `log.error`

4. **Add timing to dispatcher (`src/tools/dispatcher.ts`)**
   - `dispatch()` already returns the result string — no change to its signature
   - Timing is measured in the agent loop (wrap each `dispatch()` call with `performance.now()`)

5. **Tests**
   - Add `src/services/logger.test.ts`: verify each method writes to console with correct prefix/colour codes
   - Update `src/agent.test.ts` (if it exists) or add one: verify log output for a single tool-call iteration using a mock LLM provider

## Testing scenarios

- **Logger unit tests**: call each `log.*` method, capture stdout, assert prefix and colour codes are present
- **Agent iteration logging**: run agent with a mock provider that returns one tool call then stops; verify iteration number, LLM timing, tool call, tool result, and final response are all logged
- **Error visibility**: mock a tool that throws; verify the error is logged with error styling and the agent continues
- **Token usage**: mock provider returns usage data; verify it appears in the log
- **Parallel batch summary**: mock provider returns 3 tool calls; verify batch summary line with count and duration
