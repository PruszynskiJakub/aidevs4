# SP-59 Delegate Tool

## Main objective

Add a `delegate` tool that lets the main agent spawn a subagent by name and prompt, returning the subagent's final answer — with the list of available agents dynamically injected into the tool schema at startup.

## Context

The system currently supports multiple agent definitions (`workspace/agents/*.agent.md`) but each session is pinned to a single agent. There is no way for an agent to delegate a subtask to a specialized agent. The orchestrator (`executeTurn`) and session model already support creating independent sessions, so the infrastructure for isolated child runs exists — it just isn't exposed as a tool.

The tool registry supports dynamic schema construction (see `register()` in `src/tools/registry.ts`), and `agentsService` can load any agent by name. Combining these two capabilities enables a `delegate` tool whose `agent` parameter enum is populated at startup by scanning `.agent.md` files.

## Out of scope

- Recursive delegation (subagents spawning subagents)
- Shared session / message history between parent and child
- Streaming child progress back to the parent
- Inter-agent file sharing (child output goes to its own session)
- Parallel subagent execution (one delegation at a time)

## Dependencies

- **SP-60** (Zod tool schemas) — delegate's dynamic schema relies on Zod; implement SP-60 first

## Constraints

- Must use OpenAI strict-mode-compatible schema — no `oneOf`, `anyOf`, or type arrays
- Agent names in the enum must be generated dynamically using Zod (no hardcoded JSON)
- The `delegate` tool must NOT be available to subagents (prevents recursion)
- Child session must be fully isolated: own session ID, own message history, own output directory
- Child agent runs synchronously from the parent's perspective — the parent waits for the result

## Acceptance criteria

- [ ] A `delegate` tool exists with parameters `agent` (string) and `prompt` (string)
- [ ] The `agent` parameter's allowed values are dynamically populated at startup from `workspace/agents/*.agent.md` files
- [ ] The tool description includes a short summary of each available agent (name + capabilities from frontmatter)
- [ ] Calling `delegate` creates a new child session and runs the specified agent with the given prompt
- [ ] The parent agent receives the child's final answer text as the tool result (Document)
- [ ] The child agent cannot use the `delegate` tool (no recursion)
- [ ] The child session is logged independently (own log directory under `workspace/sessions/`)
- [ ] The parent's log includes a reference to the child session ID for traceability
- [ ] If the child agent fails or hits max iterations without answering, the tool returns an actionable error

## Implementation plan

1. **Add `listAgents()` to `agentsService`** (`src/agent/agents.ts`)
   - Scan `workspace/agents/` for `*.agent.md` files
   - Return array of `{ name, description }` where description comes from a `description` or `capabilities` field in frontmatter
   - Cache the result (agents don't change at runtime)

2. **Create `src/tools/delegate.ts`**
   - Export `default { name: "delegate", handler }` satisfying `ToolDefinition`
   - Handler validates `agent` against known agents, validates `prompt` (non-empty, max length)
   - Creates a child session via `executeTurn({ prompt, assistant: agent })`
   - Strips the `delegate` tool from the child's toolset before execution
   - Returns the child's final answer as a Document, including child session ID in metadata

3. **Create `src/schemas/delegate.json` as a minimal stub**
   - Contains `name`, `description`, and `parameters` with `agent` (string, no enum yet) and `prompt` (string)
   - The actual enum values for `agent` will be injected dynamically

4. **Extend the registry to support dynamic schema enrichment**
   - Add a `register()` overload or post-registration hook that allows injecting enum values into a parameter after initial registration
   - Alternatively: the `delegate` tool's registration in `index.ts` reads agent list and patches the schema before calling `register()`
   - Preferred approach: build the schema object in `index.ts` at registration time rather than loading from JSON — call `agentsService.listAgents()`, construct the schema with the enum populated, then `register()`

5. **Register in `src/tools/index.ts`**
   - Import delegate tool + base schema
   - Call `agentsService.listAgents()` to get available agents
   - Inject agent names as `enum` on the `agent` parameter, and build a description that lists each agent with a one-line summary
   - Call `register(delegate, enrichedSchema)`

6. **Ensure child agent excludes `delegate` tool**
   - In the delegate handler, when calling `executeTurn` or `runAgent`, pass an option that filters out `delegate` from the child's resolved tools
   - Simplest approach: add an `excludeTools?: string[]` option to `executeTurn` / the agent resolution path

7. **Add child session reference to parent log**
   - Emit an event or log entry in the parent session with the child session ID
   - The tool result Document metadata should include `childSessionId`

## Testing scenarios

- **Happy path**: delegate to a known agent with a valid prompt, verify a Document is returned with the answer text
- **Unknown agent**: pass an agent name not in the enum, verify actionable error
- **Empty prompt**: pass empty string, verify validation error
- **Dynamic enum**: add a new `.agent.md` file, restart, verify it appears in the tool schema
- **No recursion**: verify the child agent's resolved toolset does not contain `delegate`
- **Child failure**: mock a child agent that exceeds max iterations, verify parent gets an error Document with explanation
- **Logging**: verify child session creates its own log directory and parent log references child session ID
