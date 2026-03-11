# SP-13 Think tool

## Main objective

Add an LLM-powered `think` tool that gives the agent an explicit internal reasoning step for planning, analysis, and decision-making during task execution.

## Context

The agent's system prompt (`src/prompts/system.md`) already encourages structured reasoning (What do I know? / What do I need? / Shortest path?), but this happens implicitly in the model's own output. A dedicated `think` tool lets the agent offload deeper reasoning to a separate LLM call — passing a specific question and accumulated context — and receive a focused analysis back as a tool result. This is especially useful when the agent needs to synthesize information from multiple tool calls before deciding the next step.

The tool follows all existing conventions: `ToolDefinition` interface, auto-discovered by `dispatcher.ts`, schema in `src/schemas/`, prompt in `src/prompts/`.

## Out of scope

- Changing the agent loop or system prompt — this is purely a new tool
- Persisting or caching reasoning results across agent runs
- Multi-turn reasoning (the tool makes a single LLM call per invocation)

## Constraints

- Must use `promptService.load()` for the system instruction — no hardcoded prompts in `.ts` files
- Schema must comply with OpenAI strict mode (`additionalProperties: false`, all properties in `required`, no `oneOf`/`anyOf`)
- Single-handler tool (not multi-action) — simple `{ name, handler }` shape
- Use the existing `llm` provider from `src/services/llm.ts`

## Acceptance criteria

- [ ] `src/tools/think.ts` exists, exports a default `ToolDefinition`
- [ ] `src/schemas/think.json` exists with `question` (required string) and `context` (required string) parameters
- [ ] `src/prompts/think.md` exists with YAML frontmatter (`model`, optionally `temperature`) and a system instruction for reasoning
- [ ] Handler calls `llm.completion()` (or `llm.chatCompletion()`) with the loaded prompt + user input and returns a plain string
- [ ] Tool is auto-discovered by dispatcher — `bun run agent "think about X"` shows the tool in available tools
- [ ] Unit test `src/tools/think.test.ts` verifies handler returns a string given valid input

## Implementation plan

1. Create `src/prompts/think.md` — a reasoning-focused system prompt with frontmatter (`model`, `temperature`). The prompt should instruct the LLM to analyze the question in the given context, reason step by step, and return a clear conclusion.
2. Create `src/schemas/think.json` — single-function schema with two required string properties: `question` (what to think about) and `context` (relevant information gathered so far).
3. Create `src/tools/think.ts` — handler loads the prompt via `promptService.load("think")`, constructs a messages array (system + user), calls `llm.chatCompletion()`, and returns the content string.
4. Create `src/tools/think.test.ts` — mock the LLM provider, verify the handler returns a string.
5. Smoke-test with `bun run agent` to verify the tool appears and can be called.

## Testing scenarios

- **Unit**: Mock `llm` provider, call `handler({ question: "...", context: "..." })`, assert result is a non-empty string.
- **Integration**: Run `bun run agent "Use the think tool to reason about what 2+2 equals"` and verify in the log that the think tool was called and returned reasoning.
