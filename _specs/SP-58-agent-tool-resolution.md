# SP-58 Agent tool resolution and lazy loading

## Main objective

Replace the include/exclude tool filtering with direct name-based tool lookup, load agent templates on demand without caching, and gracefully warn on misconfigured tool names instead of silently dropping them.

## Context

Today the agent system has three issues:

1. **Indirect tool resolution** — agent templates declare `tools: [name1, name2]`, but this is wrapped into a `ToolFilter: { include: [...] }` and run through a generic `matchesFilter()` function. This indirection adds unnecessary complexity when the intent is simply "give me exactly these tools."

2. **Eager bulk loading** — `agentsService` scans and parses all `.agent.md` files on first access, even though only one agent is used per session. This is wasteful and couples startup to the number of agent templates.

3. **Silent misconfiguration** — if an agent template references a tool name that doesn't exist in the registry (typo or removed tool), the tool is silently absent. There's no feedback to the developer.

### Key files

- `src/agent/agents.ts` — agent loading, `resolve()` produces `toolFilter`
- `src/tools/registry.ts` — `ToolFilter` type, `matchesFilter()`, `getTools()`
- `src/types/assistant.ts` — `AgentConfig`, `ResolvedAgent`
- `src/types/tool.ts` — `ToolFilter` type definition
- `src/agent/loop.ts` — calls `getTools(resolved.toolFilter)`

## Out of scope

- Changing the agent template format (`.agent.md` YAML frontmatter structure stays the same)
- Tool registration or schema changes
- Multi-action tool dispatch logic (`tool__action` naming stays as-is)

## Constraints

- Agent templates continue to use `tools: [name1, name2]` in frontmatter — no format change
- The warning for misconfigured tools must go through the existing logging infrastructure, not `console.log`
- Must not break agents that omit the `tools` field (they get all tools, as today)

## Acceptance criteria

- [ ] `ToolFilter` type, `matchesFilter()`, and `toolFilter` field on `ResolvedAgent` are removed
- [ ] `agentsService.resolve()` returns a `tools` array of resolved `LLMTool[]` (or all tools if agent has no `tools` field) instead of a filter
- [ ] Agent templates are loaded on demand per `get(name)` call — no glob scan, no caching
- [ ] If an agent template references a tool name not in the registry, a warning is logged and the tool is skipped (app continues normally)
- [ ] The warning message includes the agent name and the invalid tool name
- [ ] Existing agents (`default`, `proxy`, `s2e1`) work without modification
- [ ] `loop.ts` uses the resolved tools directly instead of calling `getTools(filter)`

## Implementation plan

1. **Add `getToolByName(name: string): LLMTool[] | undefined` to registry** — returns all expanded tools for a base name (e.g., `shipping` returns `shipping__verify`, `shipping__track`, etc.), or `undefined` if not registered.

2. **Remove `ToolFilter` and `matchesFilter()`** — delete `ToolFilter` type from `src/types/tool.ts`, remove `matchesFilter()` from `src/tools/registry.ts`, remove `toolFilter` from `ResolvedAgent` in `src/types/assistant.ts`.

3. **Update `agentsService.resolve()`** — instead of producing `toolFilter: { include: [...] }`, resolve tool names directly:
   - For each name in agent's `tools` array, call `getToolByName(name)`
   - If found, add to resolved tools list
   - If not found, log a warning: `"Agent '{agent}': tool '{name}' not found in registry, skipping"`
   - If agent has no `tools` field, return all tools via existing `getTools()`
   - Return resolved `LLMTool[]` on the `ResolvedAgent`

4. **Change `agentsService` to load on demand without caching** — replace the glob-scan-and-cache pattern with direct file read: `get(name)` reads `workspace/agents/{name}.agent.md` directly, parses, validates, and returns. No Map cache, no glob.

5. **Update `loop.ts`** — use `resolved.tools` directly instead of `await getTools(resolved.toolFilter)`.

6. **Update `ResolvedAgent` type** — replace `toolFilter?: ToolFilter` with `tools: LLMTool[]`.

7. **Clean up imports** — remove unused `ToolFilter` imports from all files.

## Testing scenarios

- Agent with valid `tools` list resolves to exactly those tools (including multi-action expansion)
- Agent with no `tools` field resolves to all registered tools
- Agent with an invalid tool name logs a warning and resolves remaining valid tools
- Agent with all invalid tool names logs warnings and resolves to empty tools array
- `get()` for a non-existent agent throws an error
- `get()` reads from disk each time (no stale cache)