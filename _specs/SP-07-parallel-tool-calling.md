# SP-07 Parallel tool calling in agent loop

## Main objective

Execute multiple tool calls from a single LLM response concurrently instead of
sequentially, so independent tools run in parallel and the agent completes
multi-tool turns faster.

## Context

The agent loop (`src/agent.ts`) already handles multiple tool calls returned by
OpenAI in one response. However, it processes them sequentially — each
`await dispatch(...)` must finish before the next one starts. When the LLM
requests two or more independent tools (e.g. two file reads, a download + a
search), they could run concurrently. The dispatcher and tool definitions are
already async and stateless, so no downstream changes are needed.

## Out of scope

- Concurrency limits or semaphore-based throttling (OpenAI rarely returns more
  than 3-5 parallel calls; unlimited concurrency is acceptable).
- Changes to the dispatcher, tool definitions, schemas, or message format.
- Rate-limiting or queuing across multiple agent loop iterations.

## Constraints

- Must use `Promise.allSettled` for isolated error handling — one tool failing
  must not cancel or affect other parallel tools.
- Tool result messages must still be pushed in the same order as the original
  tool calls (deterministic message history).
- No new dependencies.

## Acceptance criteria

- [ ] When the LLM returns N tool calls in one response, all N are dispatched
      concurrently (not awaited one-by-one).
- [ ] A failed tool returns its error result normally; other parallel tools
      still succeed and return their results.
- [ ] Tool result messages are appended to the message history in the same order
      as the tool calls in the assistant message (stable ordering).
- [ ] Existing single-tool-call responses work unchanged.
- [ ] Agent test covers a multi-tool-call response with mixed success/failure.

## Implementation plan

1. In `src/agent.ts`, replace the sequential `for` loop over `response.toolCalls`
   with a `Promise.allSettled(response.toolCalls.map(...))` that dispatches all
   tools concurrently.
2. Map each settled result back to its corresponding `toolCall` (by index) and
   push tool-result messages in original order.
3. For rejected promises, format the error the same way the dispatcher already
   does (`{ error: message }`).
4. Add a test in `src/agent.test.ts` that mocks the LLM provider to return
   multiple tool calls and verifies parallel execution + mixed success/failure
   handling.

## Testing scenarios

- **Happy path**: LLM returns 3 tool calls → all 3 dispatched concurrently →
  all 3 results appear in messages in order.
- **Partial failure**: LLM returns 2 tool calls, one succeeds, one throws →
  successful result returned, failed one returns `{ error }`, both in order.
- **Single tool call**: Behaviour identical to current sequential path.
- **No tool calls**: Agent prints response and exits loop (unchanged).
