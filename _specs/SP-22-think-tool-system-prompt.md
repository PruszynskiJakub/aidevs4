# SP-22 Encourage active use of think tool in system prompt

## Main objective

Add a dedicated section to `src/prompts/system.md` that instructs the agent to actively use the `think` tool at key decision points and for periodic reflection, so it leverages deep reasoning instead of only relying on inline chain-of-thought.

## Context

The agent system prompt (`src/prompts/system.md`) currently has a "Reasoning Protocol" section that requires brief inline reasoning before every tool call (4 questions: what do I know / need / shortest path / execute). This works well for quick pre-call checks.

A `think` tool already exists (`src/tools/think.ts`) — it takes a `thought` string, routes it to GPT-4.1 with a dedicated reasoning prompt, and returns structured analysis. However, the system prompt **never mentions** the think tool. The agent only discovers it by chance from the tool list, and has no guidance on when or why to use it.

The inline protocol and the think tool serve different purposes:
- **Inline protocol** → fast, lightweight sanity check before each tool call
- **Think tool** → deep, deliberate reasoning for complex decisions and reflection

Both should coexist. The system prompt needs to explicitly encourage the think tool at the right moments.

## Out of scope

- Changing the think tool implementation or its prompt (`src/prompts/think.md`)
- Modifying the inline Reasoning Protocol section
- Changing the think tool schema (`src/schemas/think.json`)
- Adding new tools or changing other tools

## Constraints

- The system prompt must remain model-agnostic (no model-specific tricks)
- Keep the new section concise — the system prompt is already fairly long
- Do not duplicate the inline Reasoning Protocol; the new section should complement it
- Preserve existing `{{objective}}` and `{{tone}}` placeholders

## Acceptance criteria

- [ ] `src/prompts/system.md` contains a new section (e.g. "## Think Tool") that explains when and how to use the think tool
- [ ] The section lists at least these trigger situations: (1) choosing between multiple approaches, (2) interpreting ambiguous data, (3) periodic progress reflection after several steps, (4) when results are unexpected
- [ ] The section clarifies the distinction: inline reasoning = quick pre-call check, think tool = deep analysis
- [ ] No changes to the existing Reasoning Protocol section
- [ ] The prompt still renders correctly with `promptService.load("system", { objective, tone })`

## Implementation plan

1. Open `src/prompts/system.md`
2. Add a new `## Think Tool` section after the existing `## Reasoning Protocol` section (before `## Workflow`)
3. In the new section:
   - State the purpose: use the think tool for deep reasoning that goes beyond the inline protocol
   - List specific trigger situations:
     - **Decision points**: multiple valid approaches, unclear trade-offs
     - **Ambiguous data**: tool results that need interpretation or are unexpected
     - **Periodic reflection**: after 3-5 tool calls, pause and reflect on overall progress and whether the current approach is still optimal
     - **Complex multi-step planning**: when the task requires coordinating several tools in a specific sequence
   - Clarify the relationship with the inline Reasoning Protocol (complementary, not replacing)
4. Keep the section to ~10-15 lines — enough to be clear, short enough to not bloat the prompt

## Testing scenarios

- Load the system prompt with `promptService.load("system", { objective: "test", tone: "test" })` and verify it renders without errors
- Visually inspect that the new section is positioned between Reasoning Protocol and Workflow
- Run the agent with a multi-step task (e.g. `bun run agent "..."`) and check the log (`logs/`) to confirm the agent calls the think tool at decision points
- Verify the Reasoning Protocol section is unchanged by diffing before/after
