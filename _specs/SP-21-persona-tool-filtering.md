# SP-21 Persona Tool Filtering

## Main objective

Allow each persona to declare which tools it can access, so the agent only exposes a persona-appropriate subset of tools to the LLM.

## Context

Today `PersonaConfig` defines `objective`, `tone`, and optional `model`, but has no concept of tool access. The dispatcher's `getTools()` returns every discovered tool, and the agent passes the full list to every LLM call regardless of persona. The `proxy` persona works around this by embedding "use shipping tools" in its prompt, but all 11 tools are still technically available — meaning the LLM could call any tool if it wanted to.

Adding an `allowedTools` field to `PersonaConfig` lets us enforce tool access at two layers: (1) hide disallowed tools from the LLM schema list, and (2) reject disallowed tool calls at dispatch time.

## Out of scope

- Per-action granularity (e.g. allowing `shipping__check` but not `shipping__redirect`) — filtering is at the base tool name level only
- Dynamic tool filtering based on conversation state or runtime conditions
- UI/API for managing persona-tool mappings — config is code-only
- Changes to the tool discovery or schema loading mechanisms themselves

## Constraints

- `getTools()` and `dispatch()` are cached/hot-path — filtering must not add noticeable overhead
- The `default` persona must keep current behavior (all tools) with no config changes — an omitted or empty `allowedTools` means "all tools"
- Tool names in `allowedTools` use the base name (e.g. `"shipping"`, not `"shipping__check"`) — the dispatcher already knows how to expand multi-action tools
- Must not break existing tests or the CLI/server entry points

## Acceptance criteria

- [ ] `PersonaConfig` has an optional `allowedTools?: string[]` field
- [ ] When `allowedTools` is set, `getTools()` accepts an optional filter and returns only matching tools (base name match for multi-action tools)
- [ ] When `allowedTools` is omitted/empty, all tools are returned (backward compatible)
- [ ] `dispatch()` rejects calls to tools not in the persona's allowlist (returns a `toolError`) — defense-in-depth layer
- [ ] The `proxy` persona config is updated with `allowedTools: ["shipping", "think"]`
- [ ] The agent passes the persona's `allowedTools` through to `getTools()` and `dispatch()`
- [ ] Existing tests pass; new tests cover filtering and rejection

## Implementation plan

1. **Extend `PersonaConfig`** in `src/config/personas.ts`: add optional `allowedTools?: string[]` field. Update `proxy` persona to include `allowedTools: ["shipping", "think"]`.

2. **Add filtering to `getTools()`** in `src/tools/dispatcher.ts`: accept an optional `allowedTools?: string[]` parameter. When provided, filter the cached tools list — for each tool, extract the base name (strip `__action` suffix if present) and check if it's in the allowlist. Return the full list when no filter is provided.

3. **Add guard to `dispatch()`** in `src/tools/dispatcher.ts`: accept an optional `allowedTools?: string[]` parameter. Before executing, extract the base tool name and check against the allowlist. If rejected, return `toolError("Tool not available: {name}")`. Skip the check when no allowlist is provided.

4. **Thread persona through the agent** in `src/agent.ts`: pass the persona's `allowedTools` to both `getTools(allowedTools)` and `dispatch(name, args, allowedTools)`. The persona is already loaded in the agent — just plumb the field through.

5. **Update server** in `src/server.ts`: ensure the persona's `allowedTools` is available where `dispatch` and `getTools` are called.

6. **Write tests** in `src/tools/dispatcher.test.ts`:
   - `getTools()` with no filter returns all tools
   - `getTools(["think"])` returns only `think` tool
   - `getTools(["shipping"])` returns both `shipping__check` and `shipping__redirect`
   - `dispatch("bash", ..., ["think"])` returns a tool error
   - `dispatch("shipping__check", ..., ["shipping"])` succeeds

## Testing scenarios

- **No filter (default persona)**: `getTools()` returns all 11 tools — verify count matches current behavior
- **Allowlist with simple tool**: `getTools(["think"])` returns exactly 1 tool named `think`
- **Allowlist with multi-action tool**: `getTools(["shipping"])` returns 2 tools: `shipping__check` and `shipping__redirect`
- **Dispatch allowed tool**: `dispatch("think", '{"thought":"..."}', ["think"])` succeeds with `status: "ok"`
- **Dispatch blocked tool**: `dispatch("bash", '{"command":"ls"}', ["think"])` returns `status: "error"` with message about tool not being available
- **Dispatch blocked multi-action tool**: `dispatch("shipping__check", '{}', ["think"])` returns error
- **Dispatch allowed multi-action tool**: `dispatch("shipping__check", '{"tracking_number":"X"}', ["shipping"])` succeeds
- **Empty/undefined allowlist**: behaves identically to no filtering — all tools available
- **End-to-end**: run agent with `proxy` persona, verify only `shipping` and `think` tools appear in the LLM tool list
