# SP-45 Agent State Consolidation

## Main objective

Move all agent-run configuration (messages, model, toolFilter, assistant)
into `AgentState` so that `runAgent` accepts `(state, provider)` created by
`executeTurn`, making the data flow explicit and the agent loop free of loose
option bags.

## Context

Today `runAgent` accepts `(messages[], provider, options?)` where options is an
ad-hoc bag of `model`, `sessionId`, `toolFilter`, and `assistant`. The
`AgentState` type is created inside `runAgent` and only holds runtime counters
(`tokens`, `iteration`) plus a copy of messages. This means:

- `runAgent` has a wide, implicit interface — callers must know which options
  exist and how they interact.
- `AgentState` doesn't represent the full agent context — model, toolFilter,
  assistant, and provider live outside it.
- `executeTurn` copies session messages into a plain array, calls `runAgent`,
  then manually syncs new messages back — the boundary is fuzzy.

The fix: `executeTurn` builds a complete `AgentState` (with full session
messages, resolved assistant, model, toolFilter) and hands it to
`runAgent(state, provider)`. After the run, `executeTurn` reads
`state.messages` to sync new messages back to the session store.

## Out of scope

- Removing or replacing the `Session` type — sessions remain as the
  persistence layer
- Changing the session store implementation (in-memory map)
- Modifying the plan/act phase logic or tool dispatch internals
- Changing the logging/MarkdownLogger setup (still created in `runAgent`)

## Constraints

- `runAgent` signature becomes `runAgent(state: AgentState, provider?: LLMProvider): Promise<AgentResult>`
  — state + optional provider, no options bag
- `AgentState` must be the only way to pass configuration to the agent loop —
  no side-channel globals
- Existing callers (`executeTurn`, CLI, tests) must be updated
- `Session` stays as-is for persistence; `executeTurn` remains the bridge
  between session and state
- AsyncLocalStorage context (`runWithContext`) continues to use `AgentState`

## Acceptance criteria

- [ ] `AgentState` interface includes: `messages`, `sessionId`, `assistant`,
      `model`, `toolFilter`, `tokens`, `iteration`
- [ ] `runAgent` accepts `(state: AgentState, provider?: LLMProvider)` — no
      options bag
- [ ] `executeTurn` creates `AgentState` from session data + resolved assistant
      config and passes it to `runAgent`
- [ ] After `runAgent` returns, `executeTurn` syncs new messages from
      `state.messages` back to the session store
- [ ] Internal agent functions (`executePlanPhase`, `executeActPhase`,
      `dispatchTools`) read model/toolFilter from state via
      `requireState()` instead of function parameters; provider remains
      a function parameter passed through from `runAgent`
- [ ] CLI entry point (`cli.ts`) builds `AgentState` or calls `executeTurn` —
      no direct `runAgent` with loose options
- [ ] All existing tests pass after the refactor
- [ ] `AgentResult` still returns `{ answer, messages }` where `messages` are
      only the new messages produced during the run

## Implementation plan

1. **Extend `AgentState` interface** (`src/types/agent-state.ts`): add
   `assistant: string`, `model: string`, `toolFilter?: ToolFilter`
   fields alongside the existing `sessionId`, `messages`, `tokens`,
   `iteration`.

2. **Update `executeTurn`** (`src/services/agent/orchestrator.ts`):
   - After resolving assistant and appending system/user messages to session,
     build a full `AgentState` with: session messages (copied), resolved model,
     toolFilter, assistant name, zero-initialized tokens, iteration 0.
   - Call `runAgent(state)` (provider defaults inside `runAgent`).
   - After return, compute new messages (slice from original length) and
     append to session.

3. **Simplify `runAgent`** (`src/agent.ts`):
   - Change signature to `runAgent(state: AgentState, provider?: LLMProvider)`.
   - Remove internal state creation — use the passed-in state directly.
   - Provider defaults to `defaultLLM` if not supplied.
   - Logger creation stays in `runAgent` (uses `state.sessionId`).
   - `resolveActModel` is no longer needed — `state.model` is authoritative.
   - Pass state into `runWithContext` as before.

4. **Update internal agent functions**:
   - `executeActPhase`: get `model` from state instead of parameter; provider
     stays as function parameter.
   - `dispatchTools`: get `toolFilter` from state instead of parameter.
   - `getTools()` call: read `toolFilter` from state.

5. **Update CLI** (`src/cli.ts`): if calling `runAgent` directly, build
   `AgentState`; if going through `executeTurn`, pass options as today.

6. **Update tests**: adjust any test that calls `runAgent` directly to pass
   a full `AgentState` object.

## Testing scenarios

- Run `bun test` — all existing tests pass with the new signatures.
- Run `bun run agent "hello"` — agent completes a turn, logs are written,
  answer is returned.
- Run two turns on the same session via the HTTP server — second turn sees
  full message history from the first turn.
- Verify `AgentState.toolFilter` is respected: an assistant with
  `tools.include` should only see those tools during the run.
- Verify `AgentState.model` is used for the act phase (check logs for model
  name).
