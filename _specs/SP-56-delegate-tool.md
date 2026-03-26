# SP-56 Sub-task delegation tool

## Main objective

Add a `delegate` tool that lets the main agent spawn a scoped sub-agent loop using a named `.agent.md` config, with clean context, an independent 10-iteration cap, and file output accessible to the parent.

## Context

The agent system supports specialist agents (`.agent.md` files with per-agent models, prompts, and tool filters), but only one agent runs per session. There is no way for an agent to offload a sub-problem to a specialist mid-task.

`executeTurn()` in `src/agent/orchestrator.ts` already handles session creation, agent loading, moderation, and loop execution. The iteration cap is currently global (`config.limits.maxIterations = 40`) with no per-call override. `runAgent()` in `src/agent/loop.ts` reads this at line 258.

Output directories already namespace by agent name (`sessionDir/{agentName}/output/`), so sub-agent files are naturally separated.

## Out of scope

- Agent-to-agent communication (inbox/outbox, shared workspace)
- Parallel sub-agent execution (only synchronous delegation)
- Sub-agent inheriting parent conversation history
- Memory sharing between parent and sub-agent
- Recursive delegation (sub-agent calling delegate)

## Constraints

- Must follow existing tool conventions (`ToolDefinition`, schema in `src/schemas/`, registered in `src/tools/index.ts`)
- Sub-agent must not see parent's conversation — clean context with only the delegated prompt
- Sub-agent gets its own session ID (avoids session pinning conflict and memory bleed)
- Sub-agent iteration cap is 10, independent of parent's remaining budget
- The `delegate` tool must not appear in the sub-agent's tool set (no recursion)
- Sub-agent's output directory must be within the parent's session directory for easy access

## Acceptance criteria

- [ ] `delegate` tool exists at `src/tools/delegate.ts` with schema at `src/schemas/delegate.json`
- [ ] Tool accepts `{ agent: string, prompt: string }` — agent is a named `.agent.md` config
- [ ] `ExecuteTurnOpts` gains optional `maxIterations?: number`; defaults to `config.limits.maxIterations` when unset
- [ ] `AgentState` gains optional `maxIterations?: number`; `runAgent` uses it instead of `config.limits.maxIterations` at loop line 258
- [ ] Sub-agent runs with a fresh session (new session ID), empty memory, no parent messages
- [ ] Sub-agent is capped at 10 iterations regardless of parent config
- [ ] `delegate` tool is excluded from sub-agent's tool set (either by explicit filter or by the tool removing itself)
- [ ] Sub-agent's final answer is returned to the parent as a Document
- [ ] If sub-agent hits max iterations without answering, tool returns an error document explaining this
- [ ] Sub-agent files (produced via `outputPath()`) are written inside the parent's session directory and their paths appear in the sub-agent's answer (sub-agent is responsible for including paths)
- [ ] Existing tests pass; new tests cover happy path, unknown agent, max-iteration timeout

## Implementation plan

1. **Add `maxIterations` to `ExecuteTurnOpts`** (`src/agent/orchestrator.ts`). Pass it through to `AgentState` when building state. Default to `config.limits.maxIterations` if not provided.

2. **Add `maxIterations` to `AgentState`** (`src/types/agent-state.ts`). Optional field, defaults to `config.limits.maxIterations`.

3. **Use `state.maxIterations` in `runAgent`** (`src/agent/loop.ts` line 258). Replace `config.limits.maxIterations` with `state.maxIterations ?? config.limits.maxIterations`. Also update the `session.closed` and `turn.ended` events that reference the config value (lines 312-320).

4. **Create `src/schemas/delegate.json`**. Simple schema:
   ```json
   {
     "name": "delegate",
     "description": "Delegate a sub-task to a specialist agent. The sub-agent runs independently with its own context and tools. Use when a task requires a specialist's prompt/toolset or when you want to isolate a sub-problem. The sub-agent cannot see your conversation — describe the task fully in the prompt. If the sub-agent produces files, their paths will appear in the response.",
     "parameters": {
       "type": "object",
       "properties": {
         "agent": {
           "type": "string",
           "description": "Name of the agent config to use (matches a .agent.md file)"
         },
         "prompt": {
           "type": "string",
           "description": "The task to delegate. Must be self-contained — the sub-agent has no other context."
         }
       },
       "required": ["agent", "prompt"],
       "additionalProperties": false
     }
   }
   ```

5. **Create `src/tools/delegate.ts`**. Handler:
   - Validate `agent` with `assertMaxLength` + char allowlist
   - Validate `prompt` with `assertMaxLength` (cap at 10,000 chars)
   - Call `executeTurn({ prompt, assistant: agent, maxIterations: 10 })`
   - Wrap `result.answer` in a Document and return it
   - If answer is empty (max iterations hit), return error document: `"Sub-agent '${agent}' reached iteration limit without producing an answer."`
   - Catch errors (unknown agent, moderation flag) and return error documents

6. **Register in `src/tools/index.ts`**. Import delegate tool and schema, call `register()`.

7. **Exclude `delegate` from sub-agent tool sets**. In the delegate handler, before calling `executeTurn`, the sub-agent's tool filtering already comes from its `.agent.md` config. Add a mechanism to exclude `delegate` — simplest approach: in `runAgent`, after `getTools()`, filter out the `delegate` tool if `state.maxIterations` is set and less than `config.limits.maxIterations` (signals a sub-agent). Alternative: pass an `excludeTools` list through the opts chain. The latter is cleaner.

8. **Add `excludeTools` to `ExecuteTurnOpts`** (optional `string[]`). Pass through to state. In `runAgent` after `getTools()`, filter out any tools whose names are in `excludeTools`. The delegate handler passes `excludeTools: ["delegate"]`.

9. **Write tests** at `src/tools/delegate.test.ts`:
   - Happy path: delegate to a known agent, get answer back
   - Unknown agent: returns error document
   - Max iterations: sub-agent exhausts 10 iterations, returns error document
   - Input validation: overly long prompt, invalid agent name chars

## Testing scenarios

- **Happy path**: Create a test `.agent.md` with a simple prompt. Delegate a trivial task, verify the answer comes back as a Document with correct metadata.
- **Unknown agent**: Delegate to `"nonexistent_agent"`, verify error document with "Unknown agent" message.
- **Iteration limit**: Delegate a task that requires more than 10 iterations (or mock the loop), verify error document about iteration limit.
- **Input validation**: Send agent name with path traversal (`../etc`), verify rejection. Send prompt exceeding 10,000 chars, verify rejection.
- **Recursion prevention**: Verify `delegate` tool is not available to the sub-agent (check filtered tool list).
- **File output**: Sub-agent writes a file via `outputPath()`, verify the path is accessible from parent's perspective.