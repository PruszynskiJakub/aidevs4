# SP-72 Remove Plan Phase

## Main objective

Remove the separate plan LLM call from the agent loop to halve per-turn latency and simplify the architecture, relying on the existing think tool for explicit reasoning.

## Context

The agent loop currently executes two LLM calls per iteration:

1. **Plan phase** — calls `gpt-4.1` (temp 0.3) with the full conversation to produce a numbered step list (`[x]`/`[>]`/`[ ]` markers).
2. **Act phase** — injects the plan text as a fake assistant message, then calls the act model with tools.

This was valuable when models needed explicit scaffolding, but current models reason well without it. The think tool (SP-13/SP-22) already provides on-demand structured reasoning. The plan phase doubles latency, adds token cost, and introduces coupling (plan prompt references tool names).

**Affected code:**

| File | What to change |
|---|---|
| `src/agent/loop.ts` | Remove `executePlanPhase()`, simplify main loop |
| `src/types/agent-state.ts` | Flatten `tokens` from `{ plan, act }` to `{ promptTokens, completionTokens }` |
| `src/agent/orchestrator.ts` | Update token initialization |
| `src/prompts/plan.md` | Delete |
| `src/infra/log/bridge.ts` | Remove plan-specific routing |
| `src/types/logger.ts` | Remove `plan()` method |
| `src/infra/log/markdown.ts` | Remove `plan()` implementation |
| `src/infra/log/console.ts` | Remove `plan()` implementation (if present) |
| `src/infra/log/composite.ts` | Remove `plan()` delegation (if present) |
| `src/types/events.ts` | Update token shape in event payloads |
| `src/infra/langfuse-subscriber.ts` | Simplify token aggregation, remove plan generation tracking |

## Out of scope

- Changing the act system prompt or agent `.agent.md` files
- Modifying the think tool itself
- Adding any new reasoning mechanism to replace the plan phase
- Changing models or temperature settings

## Constraints

- Token tracking must remain functional — just flattened to a single bucket
- Langfuse tracing must continue to work with the simplified structure
- Event payloads that include tokens must use the new flat shape
- No breaking changes to the public `runAgent()` return type

## Acceptance criteria

- [ ] Agent loop executes exactly one LLM call per iteration (act only)
- [ ] `plan.md` prompt file is deleted
- [ ] `AgentState.tokens` is `{ promptTokens: number; completionTokens: number }`
- [ ] `Logger` interface no longer has a `plan()` method
- [ ] All event payloads using tokens use the flat shape
- [ ] Langfuse subscriber correctly reports token usage with flat structure
- [ ] `bun test` passes
- [ ] Agent runs end-to-end successfully (`bun run agent "test prompt"`)

## Implementation plan

1. Flatten `TokenUsage` in `agent-state.ts` — change `tokens` from `{ plan: TokenUsage; act: TokenUsage }` to a single `TokenUsage` (`{ promptTokens, completionTokens }`)
2. Update `orchestrator.ts` — initialize `tokens` as `{ promptTokens: 0, completionTokens: 0 }`
3. Update `events.ts` — change token shape in `turn.completed`, `session.completed`, and any other events that carry tokens
4. Remove `executePlanPhase()` from `loop.ts` — delete the function and its call site; remove the plan prompt loading; update `executeActPhase` to no longer inject plan text as assistant message
5. Delete `src/prompts/plan.md`
6. Update token accumulation in `executeActPhase` — write to `state.tokens.promptTokens` / `state.tokens.completionTokens` directly
7. Clean up logger — remove `plan()` from `Logger` interface, `MarkdownLogger`, `ConsoleLogger`, `CompositeLogger`
8. Update `bridge.ts` — remove the `name === "plan"` branch
9. Update `langfuse-subscriber.ts` — simplify token aggregation to use flat structure
10. Run `bun test` and fix any type errors or test failures
11. Verify with `bun run agent "test prompt"` end-to-end

## Testing scenarios

- **Type check**: `bun test` passes — confirms all references to old token shape are updated
- **Unit tests**: Any existing tests touching `AgentState` or token tracking compile and pass
- **End-to-end**: Run `bun run agent "what is 2+2"` — agent answers in one LLM call per turn, logs show no plan phase
- **Langfuse**: Verify traces show correct token counts (no plan generation, flat totals)
- **Logging**: Markdown log files no longer contain `### Plan` sections