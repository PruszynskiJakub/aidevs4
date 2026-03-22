# SP-46 Lazy agent-state resolution

## Main objective

Move tool loading, assistant resolution, and system-prompt construction from the orchestrator into `runAgent`, so AgentState starts minimal and the agent loop owns its own configuration.

## Context

Today `orchestrator.executeTurn()` does three things before calling `runAgent`:

1. **Resolves the assistant** — loads YAML config, renders the act prompt, extracts model/toolFilter.
2. **Builds the system message** — prepends it to `session.messages`.
3. **Fetches tools implicitly** — `getTools()` is called inside `executeActPhase`, but the tool list isn't part of state; it's pulled from the global registry each iteration.

Problems:
- `AgentState` carries derived values (`model`, `assistant` name) but not the tools or resolved prompt — the split of responsibilities between orchestrator and agent is inconsistent.
- The system prompt is baked into `session.messages`, coupling session storage to prompt rendering. If the prompt template changes between runs, stale sessions carry the old prompt.
- Tools are invisible in state, making it hard to test or override per-run.

## Out of scope

- Changing how tools are *registered* (registry.ts / index.ts stay the same).
- Multi-assistant switching within a single session.
- Persisting system prompts in session storage.
- Changing the plan-act loop structure.

## Constraints

- `runAgent` must remain a pure-ish function: it receives state + provider, returns answer + messages. Assistant resolution is an async setup step at the top of `runAgent`, not scattered through phases.
- Session stores only conversation messages (user, assistant, tool) — never the system message. The session's `assistant` field (name string) is sufficient to re-derive the prompt.
- No breaking changes to the CLI interface (`bun run agent "prompt"`).
- Existing tests must pass or be updated in the same PR.

## Acceptance criteria

- [ ] `AgentState.tools` exists as `LLMTool[]`, initialised to `[]` by the orchestrator.
- [ ] `runAgent` resolves the assistant config from `state.assistant` name (loads YAML, renders prompt, extracts model if not overridden).
- [ ] `runAgent` populates `state.tools` from the registry (applying `state.toolFilter`) as part of its setup, before the first iteration.
- [ ] `runAgent` constructs LLM messages for each phase as `[systemMessage(resolvedPrompt), ...state.messages]` — the system message is never stored in `state.messages` or in the session.
- [ ] `session.messages` contains only user / assistant / tool messages — no system messages.
- [ ] Orchestrator no longer resolves assistant config or builds the system message — it only creates/loads the session, appends the user message, and builds a minimal `AgentState`.
- [ ] Plan phase similarly receives `[systemMessage(planPrompt), ...state.messages]` with its own system prompt, not pulled from state.messages.
- [ ] Agent log output is unchanged (session ID, final answer printed to console).

## Implementation plan

1. **Add `tools` field to `AgentState`** (`src/types/agent-state.ts`) — typed `LLMTool[]`, default `[]`.
2. **Create a setup step in `runAgent`** (`src/agent.ts`) at the top of the function:
   - Load assistant config via `assistantService.resolve(state.assistant)`.
   - Render act prompt via `promptService.load(...)`.
   - Set `state.model` from assistant config if not already overridden.
   - Populate `state.tools` via `getTools(state.toolFilter)`.
3. **Refactor `executeActPhase`** — receive the resolved system prompt and `state.tools` as arguments instead of calling `getTools()` or reading system message from `state.messages[0]`. Build messages as `[{ role: "system", content: resolvedPrompt }, ...state.messages]`.
4. **Refactor `executePlanPhase`** — similarly build messages as `[{ role: "system", content: planPrompt }, ...state.messages]`. Plan prompt loaded once during setup.
5. **Strip orchestrator** (`src/services/agent/orchestrator.ts`):
   - Remove assistant resolution (YAML loading, prompt rendering).
   - Remove system message construction/appending.
   - `executeTurn` builds state with: `sessionId`, `messages` (from session, no system msg), `assistant` (name string), `toolFilter`, `tokens`, `iteration: 0`, `tools: []`.
6. **Clean session service** — ensure `appendMessage` / session retrieval never injects a system message. Remove any system-message logic if present.
7. **Update tests** — adjust orchestrator tests (no longer resolves assistant), agent tests (now does resolution), session tests (no system messages).

## Testing scenarios

- **Unit: runAgent resolves assistant** — mock assistantService + promptService, verify they're called with correct assistant name and that state.tools is populated.
- **Unit: messages exclude system prompt** — after a full run, verify `state.messages` contains no `role: "system"` entries.
- **Unit: LLM receives system prompt** — mock LLM provider, verify first message in chat completion call is `role: "system"` with the rendered prompt.
- **Unit: session has no system messages** — after executeTurn, inspect session.messages — assert no system-role entries.
- **Integration: CLI round-trip** — `bun run agent "hello"` completes successfully, logs show correct model and tools.
- **Regression: tool filter** — configure an assistant with `toolFilter.include`, verify only those tools appear in state.tools and LLM calls.
