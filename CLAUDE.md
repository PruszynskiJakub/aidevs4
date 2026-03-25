# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
  ├── playground/<task_name>/       # Prototyping area — one dir per task
  │   ├── <task_name>.ts            # Standalone script
  │   └── output/                   # Generated artifacts (gitignored)
  ├── src/                          # Production agent system
  │   ├── agent/                    # The brain — loop, orchestration, session, memory
  │   │   ├── loop.ts               # Plan/Act state machine
  │   │   ├── orchestrator.ts       # executeTurn entry point
  │   │   ├── session.ts            # Session store + output paths
  │   │   ├── agents.ts             # Agent config loader (.agent.md)
  │   │   ├── context.ts            # AsyncLocalStorage session context
  │   │   └── memory/               # Observation, reflection, persistence
  │   ├── llm/                      # Everything LLM: routing, providers, prompts
  │   │   ├── llm.ts                # Provider registry singleton + factory
  │   │   ├── router.ts             # Model→provider routing logic
  │   │   ├── openai.ts             # OpenAI adapter
  │   │   ├── gemini.ts             # Gemini adapter
  │   │   └── prompt.ts             # Prompt loader (.md + YAML frontmatter)
  │   ├── infra/                    # I/O, side effects, external world
  │   │   ├── file.ts               # Sandboxed file service
  │   │   ├── document.ts           # Document store + XML formatting
  │   │   ├── guard.ts              # Input moderation (OpenAI Moderation API)
  │   │   └── log/                  # Logging (console, markdown, composite)
  │   ├── tools/                    # Tool implementations (auto-registered)
  │   │   ├── registry.ts           # Tool registry and dispatch logic
  │   │   ├── index.ts              # Explicit tool + schema registration
  │   │   └── <tool_name>.ts        # Each exports default ToolDefinition
  │   ├── schemas/                  # OpenAI function calling schemas (JSON)
  │   │   └── <tool_name>.json      # Matched to tools by filename
  │   ├── config/                   # Environment + path configuration
  │   ├── types/                    # Shared TypeScript interfaces
  │   ├── prompts/                  # Markdown prompt files (.md + YAML frontmatter)
  │   ├── utils/                    # Pure helpers (parse, tokens, xml, id, timing)
  │   ├── cli.ts                    # CLI entry point
  │   └── server.ts                 # HTTP server (Hono)
  ├── _specs/                       # Task specifications & backlog
  ├── .env                          # API keys (gitignored)
  └── index.ts                      # Entry point (placeholder)
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
```

## Agent Testing

- **CLI**: Run `bun run agent "your prompt"` to test the agent end-to-end from
  the terminal. This is the primary way to verify that new tools work correctly
  within the full agent loop.
- **Logging**: Every agent run writes a detailed Markdown log to
  `logs/{YYYY-MM-DD}/{sessionId}/log_{HH-mm-ss}.md`. Logs capture each step,
  tool calls with arguments, tool results, LLM token usage, and the final
  answer. Session ID is printed to console on startup — reuse it with
  `--session <id>` to group runs. **Always check the latest log file after a
  run** to debug issues or verify tool behavior — it's more complete than
  console output.

## Code Style

## Architecture

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
- **File convention**: `src/tools/<tool_name>.ts` + `src/schemas/<tool_name>.json` —
  dispatcher matches them by filename. Naming is snake_case.
- **Registration**: Add the tool import and `register()` call in
  `src/tools/index.ts`. No auto-discovery — every tool is explicitly wired.
- **Schemas**: Hand-written JSON in OpenAI function-calling format. Always set
  `additionalProperties: false` on every object, list all properties in `required`.
  Dispatcher adds `strict: true`. Avoid `oneOf`, `anyOf`, type arrays
  (`["array", "null"]`), and free-form `"type": "object"` without defined
  properties — these are not supported by OpenAI strict mode.
- **Multi-action tools**: Use `{ action: string, payload: Record<string, any> }`
  handler shape. Schema uses a top-level `actions` key (not `oneOf`) — the
  dispatcher expands each action into a separate OpenAI function named
  `${tool}__${action}` (double-underscore separator). Each action has its own
  `description` and `parameters`. Handler switches on `action`.
  See `agents_hub` as the reference pattern.
- **File I/O**: Always use `files` service (`src/infra/file.ts`), never raw `fs`.
- **Output files**: Use `ensureOutputDir()` + `outputPath(filename)` from
  `src/utils/output.ts` for any tool-generated files.
- **Errors**: Throw `Error` — dispatcher catches and returns `{ error: message }`.
- **Response hints**: Tool results should hint at what can be done next with
  the result, but **never reference other tools by name** — describe the
  capability or goal instead. Format hints on a new line starting with
  `Note: …`. This keeps tools decoupled and reusable across different agent
  configurations.

## Playground

