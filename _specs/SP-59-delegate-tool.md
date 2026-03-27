# SP-59 Delegate Tool

## Main objective

Add a `delegate` tool that lets the main agent spawn a subagent by name and prompt, returning the subagent's final answer — with the list of available agents dynamically injected into the tool schema at startup.

## Context

The system currently supports multiple agent definitions (`workspace/agents/*.agent.md`) but each session is pinned to a single agent. There is no way for an agent to delegate a subtask to a specialized agent. The orchestrator (`executeTurn`) and session model already support creating independent sessions, so the infrastructure for isolated child runs exists — it just isn't exposed as a tool.

The tool registry supports dynamic schema construction (see `register()` in `src/tools/registry.ts`), and `agentsService` can load any agent by name. Combining these two capabilities enables a `delegate` tool whose `agent` parameter enum is populated at startup by scanning `.agent.md` files.

## Out of scope

- Shared session / message history between parent and child
- Streaming child progress back to the parent
- Inter-agent file sharing (child output goes to its own session)
- Parallel subagent execution (one delegation at a time)

## Dependencies

- **SP-60** (Zod tool schemas) — delegate's dynamic schema relies on Zod; implement SP-60 first

## Constraints

- Must use OpenAI strict-mode-compatible schema — no `oneOf`, `anyOf`, or type arrays
- Agent names in the enum must be generated dynamically using Zod (no hardcoded JSON)
- Recursion prevention is handled by agent config: only the `default` agent lists `delegate` in its `tools` array; subagents simply don't have it
- Child session must be fully isolated: own session ID, own message history, own output directory
- Child agent runs synchronously from the parent's perspective — the parent waits for the result

## Acceptance criteria

- [ ] A `delegate` tool exists with parameters `agent` (string) and `prompt` (string)
- [ ] The `agent` parameter's allowed values are dynamically populated at startup from `workspace/agents/*.agent.md` files
- [ ] The tool description includes a short summary of each available agent (name + capabilities from frontmatter)
- [ ] Calling `delegate` creates a new child session and runs the specified agent with the given prompt
- [ ] The parent agent receives the child's final answer text as the tool result (Document)
- [ ] Only the `default` agent includes `delegate` in its `tools` list — other agents don't have access (no recursion by design)
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
   - Returns the child's final answer as a Document, including child session ID in metadata

3. **Define Zod schema in the tool file** (per SP-60 convention)
   - At startup, call `agentsService.listAgents()` to get available agent names + descriptions
   - Build a Zod schema with `agent` as `z.enum([...agentNames])` and `prompt` as `z.string()`
   - Include agent descriptions in the tool-level description string

4. **Register in `src/tools/index.ts`**
   - Import and register `delegate` like any other tool — schema is embedded in the export

5. **Add `delegate` to `default.agent.md` tools list**
   - Only the default agent gets access; other agents' `tools` arrays remain unchanged
   - This naturally prevents recursion without any special filtering logic

6. **Add child session reference to parent log**
   - Emit an event or log entry in the parent session with the child session ID
   - The tool result Document metadata should include `childSessionId`

## Testing scenarios

- **Happy path**: delegate to a known agent with a valid prompt, verify a Document is returned with the answer text
- **Unknown agent**: pass an agent name not in the enum, verify actionable error
- **Empty prompt**: pass empty string, verify validation error
- **Dynamic enum**: add a new `.agent.md` file, restart, verify it appears in the tool schema
- **No recursion**: verify that non-default agents (e.g. `proxy`) don't have `delegate` in their resolved toolset
- **Child failure**: mock a child agent that exceeds max iterations, verify parent gets an error Document with explanation
- **Logging**: verify child session creates its own log directory and parent log references child session ID

## Implementation notes

### Circular dependency avoidance

`delegate.ts` cannot statically import `agentsService` (from `agents.ts`) or `executeTurn` (from `orchestrator.ts`) because both transitively import `tools/index.ts`, which imports `delegate.ts` — creating a cycle. Two techniques break it:

1. **Agent scanning**: `delegate.ts` scans `workspace/agents/*.agent.md` directly using `Bun.Glob` + `gray-matter` at top-level `await`, bypassing `agentsService`.
2. **Lazy orchestrator import**: `executeTurn` is loaded via dynamic `import()` inside the handler, deferring resolution until call time.

### MarkdownLogger sandbox fix

When a child session is spawned from a parent's async context, `narrowOutputPaths()` in `file.ts` reads `getSessionId()` from `AsyncLocalStorage` — which still returns the **parent's** session ID at logger construction time (before `runWithContext` sets the child's context). This caused "Access denied" when the child's `MarkdownLogger` tried to `mkdir` its own log directory.

**Fix**: Scope the `MarkdownLogger`'s `FileProvider` to the exact session directory (`sessions/{date}/{sessionId}`) at construction time, rather than passing the broad `sessionsDir` and relying on runtime context narrowing.
