# SP-23 Agent Planning Phase

## Main objective

Add a mandatory planning phase to every agent loop iteration so the agent
produces an updated, tracked plan before choosing its next action — improving
reasoning quality and observability.

## Context

Today the agent loop (`src/agent.ts`) makes one LLM call per iteration: the
model receives the system prompt + conversation history and picks tool(s) to
execute. Planning guidance exists only as soft instructions in the system prompt
("Understand → Gather → Process → Submit"), but nothing enforces or tracks it.

The `think` tool offers ad-hoc reasoning but is optional and doesn't produce a
structured, evolving plan.

This spec introduces a **Plan-Act loop**: each iteration makes two LLM calls —
one to plan, one to act — so the agent always has a current, explicitly tracked
plan grounded in results so far.

## Out of scope

- Human approval gate for plans (auto-execute only)
- DAG / dependency graph planning (simple numbered list)
- Modifying existing tools or schemas
- Changes to the `think` tool (it remains available as-is)

## Constraints

- Must not break existing agent invocations (`bun run agent "prompt"`)
- Persona config must still work (objective, tone injected into act prompt)
- Plan phase adds one extra LLM call per iteration — keep plan prompt concise to
  limit token/cost overhead
- Both plan and act models configurable via prompt frontmatter; defaults must
  work out of the box
- Existing logging (console + markdown) must capture plan output
- Plan output must be a numbered step list with status markers (e.g. `[x]` done,
  `[ ]` pending, `[>]` current)

## Acceptance criteria

- [ ] `src/prompts/system.md` renamed to `src/prompts/act.md`; all references
      updated
- [ ] New `src/prompts/plan.md` created with planning-specific system prompt
- [ ] Agent loop calls plan LLM before act LLM on every iteration
- [ ] Plan LLM receives: plan system prompt + full conversation history
      (user message, previous assistant messages, tool calls, tool results)
- [ ] Plan output is injected as an assistant message into the act call's
      message array (not persisted in the main history — only the act call sees it)
- [ ] Act LLM receives: act system prompt + full conversation history + plan
      (as assistant message)
- [ ] Plan contains numbered steps with status markers (`[x]`/`[ ]`/`[>]`)
- [ ] Plan model is configurable via `plan.md` frontmatter `model` field
- [ ] Act model is configurable via `act.md` frontmatter `model` field (persona
      override still takes precedence)
- [ ] Plan output is logged in markdown logs (new "Plan" section per step)
- [ ] Console logger shows a summary of the current plan each iteration
- [ ] Agent still respects `MAX_ITERATIONS` (each plan+act pair = one iteration)
- [ ] Existing tests pass; new tests cover plan injection logic

## Implementation plan

1. **Rename prompt**: `src/prompts/system.md` → `src/prompts/act.md`. Update
   `agent.ts` to load `"act"` instead of `"system"`.

2. **Create plan prompt**: Write `src/prompts/plan.md` with frontmatter
   (`model`, optional `temperature`). Prompt instructs the LLM to:
   - Analyse the task and all actions/results so far
   - Produce/update a numbered step list with status markers
   - Keep it concise (max ~10 steps)
   - Mark completed steps `[x]`, current step `[>]`, future steps `[ ]`

3. **Modify agent loop** (`src/agent.ts`):
   - At the start of each iteration, before the act LLM call:
     a. Build plan messages: plan system prompt + conversation history
     b. Call LLM with plan messages (no tools available)
     c. Extract plan text from response
     d. Log plan to console and markdown logger
   - Build act messages: act system prompt + conversation history + plan
     injected as final assistant message
   - Rest of the loop (tool execution, result appending) unchanged

4. **Update logging**:
   - `MarkdownLogger`: add `logPlan(plan: string, model: string, tokens: {...})`
     method that writes a "### Plan" section before tool calls in each step
   - Console logger: print plan summary (step count, current step) each iteration

5. **Update persona handling**: Ensure persona model override applies to the act
   phase. Plan phase uses whatever `plan.md` frontmatter specifies (independent
   of persona).

6. **Tests**:
   - Unit test: plan message construction (plan system prompt + history)
   - Unit test: plan injection into act messages (assistant message at end)
   - Unit test: prompt rename doesn't break loading
   - Integration: run agent with a simple task, verify log contains plan sections

## Testing scenarios

- **Happy path**: Run `bun run agent "What is 2+2?"` — log should show a plan
  on every iteration, final answer correct
- **Multi-step task**: Run a task requiring multiple tool calls — plan should
  update each iteration, marking completed steps
- **Model config**: Set different models in `plan.md` and `act.md` frontmatter —
  verify each phase uses its configured model
- **Persona override**: Use a persona with model override — act phase uses
  persona model, plan phase uses `plan.md` model
- **Logging**: Check `logs/log_*.md` for plan sections with step lists and
  status markers
- **Existing tests**: `bun test` passes without regressions
