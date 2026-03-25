# SP-51 Simplify Agent Loader — Collapse Resolver, Rename to Agents

## Main objective

Collapse the now-redundant two-layer assistant loader/resolver into a single `agents` service, rename all "assistant" terminology to "agent", switch to `.agent.md` file suffix, and simplify the tools field from `{include, exclude}` to a flat `string[]`.

## Context

SP-50 moved agent definitions to self-contained markdown files in `workspace/agents/`. This eliminated the `act.md` template composition that justified the loader/resolver split. What remains:

- **`assistants.ts`** loads all `.md` files, validates, caches in a `Map<string, AgentConfig>`
- **`assistant-resolver.ts`** wraps the loader, remaps `tools` → `toolFilter`, and adds a second cache

The resolver is now a pass-through — it adds no value. Additionally:

- All naming still says "assistant" (service names, directory, error messages, exports) despite the concept being "agent"
- Files use `.md` suffix — no disambiguation from other markdown (e.g. a future README in the same directory)
- `tools` uses `ToolFilter` (`{include?, exclude?}`) but no agent uses `exclude`, and the registry's `getTools()` can accept a simple `string[]` for include-only filtering
- The `AssistantConfig` deprecated alias adds noise

## Out of scope

- Changing the agent execution loop, planning, or memory system
- Modifying tool implementations or the tool registry's `getTools()` signature (it will still accept `ToolFilter` — we just stop producing `exclude`)
- Creating new agents
- Changes to the CLI interface

## Constraints

- `agent.ts` and `orchestrator.ts` must continue to work — the resolved shape (`{ prompt, model, toolFilter? }`) stays compatible
- `getTools()` in the registry accepts `ToolFilter` — passing `{ include: [...] }` is still valid, so the registry doesn't need changes
- The `workspace/agents/` directory stays at its current location
- Playground code (`event_agent.ts`) must be updated to use new imports

## Acceptance criteria

- [ ] `assistant-resolver.ts` is deleted — its logic is inlined into the single service
- [ ] `assistants.ts` is renamed to `agents.ts`; the service export is `agentsService` (not `assistantsService`)
- [ ] The `assistant/` directory is renamed to `agents/` under `src/services/agent/`
- [ ] Agent files use `.agent.md` suffix (`default.agent.md`, `proxy.agent.md`, `s2e1.agent.md`)
- [ ] `AgentConfig.tools` is `string[]` (tool names to include) instead of `ToolFilter`; when passed to `getTools()`, it's wrapped as `{ include: tools }`
- [ ] The deprecated `AssistantConfig` alias is removed
- [ ] Error messages say "agent" not "assistant"
- [ ] All imports across `agent.ts`, `orchestrator.ts`, `index.ts`, and `playground/semantic_events/event_agent.ts` are updated
- [ ] `index.ts` barrel re-exports are updated
- [ ] All tests pass with updated assertions
- [ ] No two-layer caching — single cache in the agents service

## Implementation plan

1. **Rename agent files** in `workspace/agents/`: `default.md` → `default.agent.md`, `proxy.md` → `proxy.agent.md`, `s2e1.md` → `s2e1.agent.md`.

2. **Update frontmatter**: change `tools` from object (`include: [...]`) to flat array (`tools: [shipping, think]`). Remove `tools` key entirely from `default.agent.md` (it has no filter). Update `AgentConfig` type accordingly:
   ```typescript
   export interface AgentConfig {
     name: string;
     model: string;
     prompt: string;
     tools?: string[];
     capabilities?: string[];
   }
   ```

3. **Create `src/services/agent/agents/agents.ts`** (new directory `agents/`, replacing `assistant/`):
   - Merge loader + resolver into one service
   - Glob for `*.agent.md`
   - Single `Map<string, ResolvedAgent>` cache
   - `resolve(name)` returns `{ prompt, model, toolFilter? }` directly — wraps flat `string[]` into `{ include: tools }` for `getTools()` compatibility
   - Export as `agentsService`

4. **Create `src/services/agent/agents/index.ts`** barrel export.

5. **Update consumers**:
   - `agent.ts`: import `agentsService.resolve()` instead of `assistantResolverService.resolve()`
   - `orchestrator.ts`: import `agentsService.get()` instead of `assistantsService.get()` (or use `resolve()` if `get()` was only for validation — check if the result is used)
   - `playground/semantic_events/event_agent.ts`: update import path
   - `src/services/agent/index.ts`: re-export from `agents/` not `assistant/`

6. **Delete `src/services/agent/assistant/`** directory entirely (all 5 files).

7. **Remove the `AssistantConfig` deprecated alias** from `src/types/assistant.ts`.

8. **Write tests** in `src/services/agent/agents/agents.test.ts` covering: load, resolve, cache, unknown agent error, validation errors.

## Testing scenarios

- **Load + resolve**: `agentsService.resolve("default")` returns `{ prompt, model, toolFilter: undefined }`
- **Tool filter wrapping**: `agentsService.resolve("proxy")` returns `{ toolFilter: { include: ["shipping", "think"] } }`
- **Caching**: two `resolve()` calls return the same object reference
- **Unknown agent**: descriptive error listing available agents
- **Validation**: missing `name` throws, missing `model` throws, empty body throws
- **File suffix**: only `*.agent.md` files are picked up (a stray `.md` file is ignored)
- **Full agent run**: `bun run agent "hello"` works end-to-end
