# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

IMPORTANT: Update this file with every major change to this module. When implementing new features, modifying architecture, or changing key interfaces, update the relevant sections to keep guidance accurate for future agents.

## Core Principals

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.


## Project Overview

AI Devs 4 course project — an evolving agentic system for solving tasks from
the AG3NTS hub platform (hub.ag3nts.org).

Workflow per task:
1. Read the AI Devs 4 task description
2. Decompose it into small, quasi-tool scripts — each prototyped in playground/
3. Once a script works, promote it to a generic, reusable tool in src/tools/
   (or extend an existing one). Tools must not be task-specific — they should be
   broadly applicable across many tasks
4. Pass the original task to the agent, which can use the new tool alongside
   all tools accumulated from previous tasks

The agent's toolbox grows with each completed task.

## Tech Stack

- Runtime: Bun (not Node.js)
- Language: TypeScript (strict mode, ESNext target, bundler module resolution)

## Project Structure

```
  ├── workspace/                      # Unified workspace directory
  │   ├── system/                     # Curated, version-controlled definitions
  │   │   ├── agents/                 # Agent definitions (.agent.md files)
  │   │   ├── skills/                 # Reusable skill definitions
  │   │   ├── tasks_prompts/          # Task and prompt management
  │   │   └── mcp.json                # MCP server configuration
  │   ├── workflows/                  # Workflow definitions
  │   ├── knowledge/                  # Agent-curated persistent knowledge base
  │   │   ├── _index.md               # Auto-maintained index
  │   │   ├── procedures/             # How-to guides, methodologies
  │   │   ├── reference/              # Lookup data, API docs, inventories
  │   │   ├── insights/               # Agent-discovered patterns, learnings
  │   │   ├── entities/               # Known people, places, concepts
  │   │   └── datasets/               # CSVs, structured data for tooling
  │   ├── scratch/                    # Freeform agent exploration space
  │   ├── sessions/                   # Runtime output (ephemeral, per-run)
  │   │   └── {YYYY-MM-DD}/
  │   │       └── {sessionId}/
  │   │           ├── log/            # Markdown logs + JSONL events
  │   │           ├── shared/         # Inter-agent file dump
  │   │           └── {agentName}/
  │   │               └── output/     # Agent artifacts by file type
  │   └── browser/                    # Browser state & cache
  ├── playground/<task_name>/         # Prototyping area — one dir per task
  │   ├── <task_name>.ts              # Standalone script
  │   └── output/                     # Generated artifacts (gitignored)
  ├── src/                            # Production agent system
  │   ├── agent/                      # The brain — loop, orchestration, session, memory
  │   │   ├── loop.ts                 # Plan/Act state machine
  │   │   ├── orchestrator.ts         # executeTurn entry point
  │   │   ├── session.ts              # Session store + output paths
  │   │   ├── agents.ts               # Agent config loader (.agent.md)
  │   │   ├── context.ts              # AsyncLocalStorage session context
  │   │   └── memory/                 # observer, processor, reflector, persistence, generation
  │   ├── llm/                        # Everything LLM: routing, providers, prompts
  │   │   ├── llm.ts                  # Provider registry singleton + factory
  │   │   ├── router.ts               # Model→provider routing logic
  │   │   ├── openai.ts               # OpenAI adapter
  │   │   ├── gemini.ts               # Gemini adapter
  │   │   ├── errors.ts               # LLM error types
  │   │   └── prompt.ts               # Prompt loader (.md + YAML frontmatter)
  │   ├── infra/                      # I/O, side effects, external world
  │   │   ├── file.ts                 # Sandboxed file service
  │   │   ├── result-store.ts         # Tool call result store (by toolCallId)
  │   │   ├── guard.ts                # Input moderation (OpenAI Moderation API)
  │   │   ├── events.ts               # Event bus
  │   │   ├── browser.ts              # Browser automation (Playwright)
  │   │   ├── browser-feedback.ts     # Browser visual feedback
  │   │   ├── browser-interventions.ts # Browser intervention handling
  │   │   ├── condense.ts             # Context condensation
  │   │   ├── mcp.ts                  # MCP integration
  │   │   ├── serper.ts               # Serper search API client
  │   │   ├── tracing.ts              # Tracing (Langfuse)
  │   │   ├── langfuse-subscriber.ts  # Langfuse event subscriber
  │   │   └── log/                    # Logging (console, markdown, composite, jsonl)
  │   ├── tools/                      # Tool implementations (auto-registered)
  │   │   ├── registry.ts             # Tool registry and dispatch logic
  │   │   ├── index.ts                # Explicit tool + schema registration
  │   │   ├── <tool_name>.ts          # Each exports default ToolDefinition
  │   │   └── sandbox/                # Code execution sandbox (bridge, prelude)
  │   ├── config/                     # Environment, paths, MCP configuration
  │   ├── types/                      # Shared TypeScript interfaces
  │   ├── prompts/                    # Markdown prompt files (.md + YAML frontmatter)
  │   ├── utils/                      # Pure helpers (parse, tokens, xml, id, timing, uri)
  │   ├── cli.ts                      # CLI entry point
  │   ├── server.ts                   # HTTP server (Hono)
  │   └── slack.ts                    # Slack bot entry point
  ├── data/                            # Technical runtime data (DB files) — NOT for agent content
  ├── _specs/                         # Task specifications & backlog
  ├── _aidocs/                        # Internal docs (tool standard, course materials)
  ├── _cases/                         # Use case scratchpads
  ├── .env                            # API keys (gitignored)
  └── index.ts                        # Entry point (placeholder)
```

## Testing

- Runner: bun test
- Convention: Test files live next to the source file — xyz.ts → xyz.test.ts
- Scope: Test src/ code (tools, utils). Playground scripts don't need tests.

## Commands

```bash
  bun install                          # Install dependencies
  bun test                             # Run all tests
  bun run <path/to/script.ts>          # Run any script directly
  bun run agent "your prompt"          # Run the agent (new session)
  bun run agent "prompt" --session ID  # Continue an existing session
  bun run server                       # Start HTTP server (Hono)
  bun run slack                        # Start Slack bot
```

## Agent Testing

- **CLI**: Run `bun run agent "your prompt"` to test the agent end-to-end from
  the terminal. This is the primary way to verify that new tools work correctly
  within the full agent loop.
- **Logging**: Every agent run writes a detailed Markdown log to
  `workspace/sessions/{YYYY-MM-DD}/{sessionId}/log/log_{HH-mm-ss}.md`. Logs
  capture each step, tool calls with arguments, tool results, LLM token usage,
  and the final answer. Session ID is printed to console on startup — reuse it
  with `--session <id>` to group runs. **Always check the latest log file after
  a run** to debug issues or verify tool behavior — it's more complete than
  console output.

## Code Style

## Architecture

### Events

- **Registry**: `AgentEvent` flat discriminated union in `src/types/events.ts` —
  each variant owns its `type` literal and all fields (envelope + payload) in
  one shape. `switch (e.type)` narrows everything at once.
- **Helpers**: `EventType = AgentEvent["type"]`,
  `EventOf<T> = Extract<AgentEvent, { type: T }>`,
  `EventInput<T>` (payload only — what emitters pass to `bus.emit`).
- **Envelope injection**: Bus injects `id`, `ts`, `sessionId`, `runId`, etc.
  from `AsyncLocalStorage`. Emitters only supply payload fields.
- **Per-variant invariants**: `RunScoped` variants require `runId: string`;
  `Unscoped` variants (`input.*`, `llm.call.failed`) have `runId?: string`.
- **Dedicated events over boolean flags**: Prefer separate event types for
  distinct outcomes instead of a single event with a boolean discriminator.
  For example, use `tool.succeeded` and `tool.failed` instead of
  `tool.completed` with `ok: boolean` and optional `result`/`error` fields.
  This eliminates branching in subscribers and makes payloads non-optional.
- **Naming**: `domain.past_tense` (e.g. `session.opened`, `tool.succeeded`).
  Subscribers can listen to event groups by domain prefix.

## Prompts

- **Format**: Every prompt is a `.md` file in `src/prompts/` with YAML frontmatter.
- **Frontmatter fields**: `model` (required by convention), `temperature` (optional).
  ```yaml
  ---
  model: gpt-4.1
  temperature: 0.7
  ---
  ```
- **Placeholders**: Use `{{variable_name}}` — rendered by `promptService.load()`.
  Missing variables throw; extra variables are silently ignored.
- **Service**: `promptService` from `src/llm/prompt.ts`. Call
  `promptService.load("name", { key: "value" })` → returns
  `{ model?, temperature?, content }`.
- **Consumers wire the result** into the LLM service themselves — the prompt
  service only loads and renders, it never calls the LLM.
- **Naming**: Prompt files use kebab-case (`system.md`, `classify-tags.md`).
- **No hardcoded prompts** — never put prompt text in `.ts` files. Always use a
  `.md` file + the prompt service.

## Tools

- **Interface**: Each tool is a `{ name, handler }` satisfying `ToolDefinition`
  (src/types/tool.ts). Export as `export default { … } satisfies ToolDefinition`.
- **Return type**: Handlers return `Promise<ToolResult>` (from
  `src/types/tool-result.ts`). Use the `text(s)` helper for simple text results,
  or construct `{ content: ContentPart[] }` for multi-part results (e.g. text +
  resource refs). Use `resource(uri, description, mimeType?)` to create
  `ResourceRef` content parts for large files. Never return `Document` — that
  type no longer exists.
- **File convention**: `src/tools/<tool_name>.ts` — naming is snake_case.
  Schemas are Zod objects co-located in the tool file (not separate JSON files).
- **Registration**: Add the tool import and `register()` call in
  `src/tools/index.ts`. No auto-discovery — every tool is explicitly wired.
- **Schemas**: Zod schemas in the tool file. Registry converts to JSON Schema
  via `z.toJSONSchema()` with OpenAI `strict: true`. Avoid `oneOf`, `anyOf`,
  type arrays — these are not supported by OpenAI strict mode.
- **Multi-action tools**: Use `{ action: string, payload: Record<string, any> }`
  handler shape. Schema uses a top-level `actions` key (not `oneOf`) — the
  dispatcher expands each action into a separate OpenAI function named
  `${tool}__${action}` (double-underscore separator). Each action has its own
  `description` and `parameters`. Handler switches on `action`.
  See `agents_hub` as the reference pattern.
- **File I/O**: Always use `files` service (`src/infra/file.ts`), never raw `fs`.
- **Output files**: Use `sessionService.outputPath(filename)` from
  `src/agent/session.ts` for any tool-generated files. Output lands under
  `workspace/sessions/{date}/{sessionId}/{agentName}/output/`.
- **Errors**: Throw `Error` — dispatcher catches and returns error as plain text
  with `isError: true`.
- **Response hints**: Tool results should hint at what can be done next with
  the result, but **never reference other tools by name** — describe the
  capability or goal instead. Format hints on a new line starting with
  `Note: …`. This keeps tools decoupled and reusable across different agent
  configurations.

## Cases

- **Directory**: `_cases/` — one file per use case or process to be addressed
  by the agent. Each file is a standalone scratchpad for exploring, researching,
  and documenting requirements before implementation.

## Playground

