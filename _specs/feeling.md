# The Discovery Gap — Why the Agent Doesn't Feel Agentic

## The comparison

The agent doesn't feel like Claude Code. Claude Code explores, navigates, understands, then acts. Our agent plans, then executes. The difference is structural.

## Claude Code's loop

- **No separate plan phase.** Reasoning and acting happen in one stream.
- **Tools are senses.** Read, Grep, Glob, Agent — these are acts of perception, not operations on data. Claude Code *looks at things* to understand them.
- **Exploration is the default first move.** Asked to audit a codebase? First move: spawn three sub-agents to read everything in parallel. Not a plan. Exploration.
- **Understanding emerges from navigation.** Read `loop.ts`, notice it imports `processMemory`, follow that to `processor.ts`, see the thresholds — now the memory system is understood. No one said to do that. The code was followed.
- **Sub-agents for parallel exploration.** Multiple angles investigated simultaneously.
- **Reasoning is continuous and inline.** No separate "thinking step" — the thinking IS the acting.

## Our agent's loop

- **Mandatory plan phase every iteration.** A separate LLM call produces a numbered checklist before anything happens.
- **Tools are operations.** `agents_hub__verify`, `shipping__track`, `geo_distance`. The agent *does things to data*.
- **The prompt discourages exploration.** "Plan the full solution path, then execute it — don't explore aimlessly."
- **Understanding is a byproduct of execution**, not the goal.
- **Plan prompt says "name the tool or action for each step."** The agent commits to specific tool calls before it has explored the problem.

## The structural difference

```
Claude Code:  [reason + perceive + act]  →  [reason + perceive + act]  →  ...
Our agent:    [plan] → [act] → [plan] → [act] → [plan] → [act] → ...
```

The plan phase forces the agent into an execution frame *before it has looked at anything*. The first thing the agent does with a new task is produce a 10-step checklist. Claude Code's first move would be to *look*.

## Two different questions drive two different behaviors

- **Executor asks:** "What should I do next?"
- **Discoverer asks:** "What don't I understand yet?"

The plan-act loop encodes the first question. Every iteration begins with "update the plan, mark the next step." The agent literally cannot begin an iteration without answering "what should I do next?"

A discovery-oriented loop begins each iteration with: "Given what I just learned, what's my understanding of the problem? What's uncertain? What would reduce that uncertainty the most?"

## Concrete example

Task: *"Find the coordinates of the place where the robots were seen."*

**Our agent (executor):**
1. Plan: download task data, extract location, geocode, submit
2. Downloads data → gets a report with 3 locations mentioned
3. Picks the most obvious one → geocodes → submits → wrong
4. Retries with second location → wrong
5. Pivots after 3 attempts (plan rule)

**A discovering agent:**
1. Downloads data → reads it carefully
2. "Three locations mentioned. Why? What role does each play in the narrative?"
3. Thinks: "The report describes robots *passing through* A and B, but *spotted repeatedly* at C. 'Seen' implies repeated sightings, not transit."
4. Geocodes C → submits → correct

Same tools. Different relationship with the unknown. The executor treats data as input to a procedure. The discoverer treats data as territory to understand.

## What needs to change — key differences with evaluated solutions

These are not architecture changes. They're changes in how the agent relates to its environment. For each key difference, three solutions are proposed and self-critiqued.

---

### Difference 1: The plan phase forces execution before understanding

The plan fires before the agent has looked at anything, committing it to tool calls named in advance. The plan prompt says "name the tool or action for each step." This is navigating with a map drawn before entering the building.

#### Solution A: Remove the plan phase entirely

Inline reasoning in the system prompt replaces the separate call. The agent reasons in its response text ("I see X, so I should look at Y"), then makes tool calls. One LLM call per iteration.

**Critique:** The plan phase was probably added because GPT models lost track in long sessions. Removing it risks the agent going in circles. However — the memory system now compresses old context, which reduces that risk. The bigger concern: debugging gets harder. The plan log is a clean audit trail of what the agent intended. You'd lose that visibility.

**Verdict: High risk, high reward. Try it on a branch, compare against the current loop on 5 real tasks.**

#### Solution B: Plan becomes a periodic checkpoint, not a per-iteration gate

Plan fires every 3rd iteration (or after the agent explicitly asks for it), not every iteration. First iterations are plan-free — the agent explores, reads, probes. The plan prompt changes from "produce execution steps" to "summarize understanding so far and identify what's still unclear."

**Critique:** The "every 3rd iteration" threshold is arbitrary and will need tuning per task type. Two modes (planning vs. non-planning iterations) make the loop harder to reason about. Also — a plan that asks "what's unclear?" is just the think tool with extra steps. If the agent already has think, why add another reflection mechanism?

**Verdict: Over-engineered. Adds complexity for marginal improvement over A or C.**

#### Solution C: Merge planning into the system prompt as a reflection habit ★

Remove the separate plan LLM call. Add to the system prompt:

```
Before choosing your next action, state in 2-3 sentences:
- What you've learned so far
- What's still uncertain
- What would reduce that uncertainty most
```

The agent's visible reasoning (response text before tool calls) replaces the formal plan. The think tool remains for deeper analysis.

**Critique:** Depends on GPT-5 being disciplined enough to self-reflect inline without a separate prompt forcing it. Claude does this naturally; GPT-5 may need more structure. You also lose the structured `[x]/[>]/[ ]` plan format, which was useful for logging. Could preserve it by having the logger extract the agent's stated intent from the response — but that's messy.

**Verdict: Best balance. Low risk (the plan was guidance, not a hard constraint — the act phase could always ignore it). Easy to iterate on. Start here.**

---

### Difference 2: The prompts actively suppress exploration

Three lines in `default.agent.md` directly fight discovery:

- *"Solve every task correctly in the fewest possible steps"*
- *"Don't explore aimlessly"*
- *"Don't make exploratory calls 'just to see' — know what you expect before calling"*

Claude Code has the opposite bias: read before edit, explore before act, use Agent to investigate.

#### Solution A: Rewrite the prompt to invert the bias ★

```
Before: "fewest possible steps"
After:  "fewest possible steps once you understand the problem"

Before: "don't explore aimlessly"
After:  "explore systematically — read, search, inspect before you process or submit"

Before: "Don't make exploratory calls 'just to see'"
After:  "Your first tool calls should be reads and searches. Understand the data before acting on it."
```

**Critique:** The original phrasing existed because the agent was burning iterations on unfocused exploration. Swinging to "explore first" without guardrails could bring that back. The fix is in the word "systematically" — but that's vague. The model may interpret it differently each run. Also — some tasks are genuinely simple ("submit 42"). Forcing exploration on trivial tasks wastes time and tokens.

**Verdict: Necessary. The wording needs iteration, but the current phrasing is actively harmful to discovery. Pair with Solution 2C (tool hierarchy) to make "explore systematically" concrete.**

#### Solution B: Add an explicit "orient" phase to the workflow

Change the workflow from `Understand → Gather → Process → Submit` to:

```
1. Orient — Read/download the task data. Inspect it. What kind of problem is this?
2. Investigate — Search for patterns, edge cases, surprises. Call think if anything is unexpected.
3. Plan — Now that you understand the data, determine the minimal steps to solve.
4. Execute — Process, transform, submit.
```

**Critique:** The current prompt already has "Understand → Gather → Process → Submit" — it just doesn't enforce it. Adding more workflow steps won't help if the plan phase still fires first and skips to execution. Also, 4-step named workflows are hard for models to follow reliably — they tend to collapse steps.

**Verdict: Redundant if Difference 1 is fixed. The workflow section should exist but shouldn't be the primary fix.**

#### Solution C: Create an explicit tool hierarchy in the prompt ★

Add to the system prompt:

```
## Tool Priority

Your tools serve different purposes. Use them in this order:

**Perceive** (use first, use often): read_file, glob, grep, web__download, web__scrape
**Analyze** (use to deepen understanding): think, document_processor, execute_code
**Act** (use once you understand): write_file, edit_file, bash, agents_hub__verify
```

**Critique:** Hardcodes tool categories, creating maintenance burden when tools are added/removed. Some tools cross categories (web is both perceive and act). The model might follow this too literally and refuse to write a file early even when it makes sense (e.g., saving intermediate data). The hierarchy should be guidance, not a rule.

**Verdict: Good practical step. Frame as "prefer this order" not "must follow this order." Combine with Solution 2A for maximum effect.**

---

### Difference 3: No parallel exploration (sub-agents)

Claude Code spawns sub-agents to explore multiple angles simultaneously. Three agents reading different parts of the codebase at once. Our agent is single-threaded: one tool call batch per iteration, all decided in one reasoning step.

#### Solution A: Implement SP-56 as-is ★

The spec is complete and ready to build. Gives the agent the ability to delegate to specialist agents.

**Critique:** SP-56 is synchronous delegation, not parallel exploration. The parent blocks while the child runs. The child gets clean context (can't share understanding). It's "go do this sub-task" not "go investigate this angle while I investigate another." Useful for composition, but doesn't give Claude Code's parallel exploration pattern.

**Verdict: Build it — it's valuable for composition. But don't expect it to create the exploration feel. It solves a different problem (specialist delegation, not parallel discovery).**

#### Solution B: Lighter-weight "investigate" tool

A tool that runs a short (3-5 iteration) sub-loop with the same agent and a focused question. Unlike SP-56, it inherits the parent's understanding (a summary, not full history) and returns findings, not a final answer.

```
investigate({ question: "What format does column 3 use?", context: "Downloaded CSV with 15 columns..." })
→ runs 3 iterations of read/grep/think
→ returns: "Column 3 contains ISO-8601 dates with timezone offsets. 3 rows have malformed entries."
```

**Critique:** Functionally SP-56 with different defaults (shorter, same agent, includes context summary). Building a separate tool creates two delegation mechanisms. The real question: can SP-56's interface cover both? `delegate({ agent: "default", prompt: "Given this context: ..., investigate: ...", maxIterations: 5 })` works without a separate tool.

**Verdict: Don't build separately. Extend SP-56 to support the investigation pattern by allowing context injection and flexible iteration caps. One mechanism, two use patterns.**

#### Solution C: Lean harder on parallel tool calls within iterations

The agent already supports parallel tool calls. Reframe the prompt guidance from efficiency to exploration:

```
When investigating a problem, issue multiple exploratory calls simultaneously:
- Read multiple files at once to compare structures
- Search for multiple patterns in parallel
- Download and inspect multiple resources together
```

**Critique:** Requires no code change, just prompt guidance. But limited — parallel tool calls within one iteration are decided in one reasoning step. The model has to predict all exploration angles upfront, which is the opposite of reactive discovery.

**Verdict: Quick win, easy to add. Works well for initial orientation. Doesn't help with iterative, reactive exploration.**

---

### Difference 4: The agent has no sense of "where it is"

Claude Code is always situated in a codebase. It has a working directory. It navigates. Read a file, see an import, follow it — not because a plan said to, but because of what it just saw.

Our agent operates in abstract task-space. It receives a task, calls tools, gets results. The plan prompt says "name the tool for each step" — the agent thinks in tool invocations, not in navigating a problem space.

#### Solution A: Give the agent a working context it narrates

Add to the system prompt:

```
You are situated in a workspace. As you work:
- Describe what you're looking at ("The downloaded file has 3 columns: id, name, coordinates")
- Note what catches your attention ("The coordinates column has mixed formats — some decimal, some DMS")
- Follow surprising details ("Let me check how many rows use each format")

Your response text IS your exploration. Think out loud as you navigate the data.
```

**Critique:** Prompt-only change that asks the model to roleplay as an explorer. Might work — GPT-5 is good at behavioral guidance. But adds tokens to every response, and narration may be formulaic rather than genuinely driving behavior. The model might narrate exploration while still following the plan checklist.

**Verdict: Worth trying. Low cost, easy to iterate. But soft nudge, not structural. Only works if Difference 1 is also fixed (no plan-phase execution frame).**

#### Solution B: Elevate inline reasoning, demote the think tool

Currently think is positioned as optional enrichment. Claude Code's reasoning is always-on (response text IS thinking). Instead of promoting the think tool, promote inline reasoning as the primary mode:

```
Before: "Call think actively — do not wait until you are stuck"
After:  "Reason out loud in every response. Describe what you see, what it means,
         what you want to investigate next. Reserve the think tool for genuinely
         complex analysis that needs a dedicated reasoning pass."
```

**Critique:** Making the think tool primary (as the existing doc suggested) would turn every reflection into a separate tool dispatch — extra latency, extra cost, extra XML wrapping. Better to make inline reasoning primary and keep think as the heavy-duty tool for genuine complexity. This matches Claude Code's pattern: always-on inline reasoning + occasional deep analysis.

**Verdict: Right direction. Inline reasoning as default, think tool as escalation for complex situations. Avoids the overhead of routing every thought through a tool call.**

#### Solution C: Restructure the system prompt around phases of understanding ★

Replace the current workflow (`Understand → Gather → Process → Submit`) with one that mirrors how Claude Code navigates:

```
## How You Work

1. **Look** — Your first tool calls are always reads and searches.
   Download the data. Open the files. Search for patterns.
   You are building a mental model of the problem.

2. **Notice** — As you read, note what's interesting, unexpected,
   or ambiguous. State it in your response. These observations
   drive your next move.

3. **Follow** — When something surprises you, investigate it.
   Read related files. Search for the pattern elsewhere.
   Use think if you need to reason about implications.

4. **Understand** — Once you can explain the problem structure
   in 2-3 sentences, you understand it well enough to act.

5. **Act** — Now process, transform, submit. This should be
   the minority of your iterations.
```

**Critique:** This is a rewrite of the behavioral frame, not a code change. The risk is that 5 named phases is a lot — models tend to collapse or reorder. The names also feel prescriptive; real discovery doesn't follow a strict sequence. Also, doesn't guarantee different behavior if the plan phase still dominates.

**Verdict: Best of the three for this difference. ONLY works if Difference 1 is also fixed. The prompt sets the intent; the loop structure must allow it.**

---

## Implementation sequence

The four differences interact. Fixing them in isolation won't work:

```
1. Fix the loop (1C) ──────────── unblocks everything else
       ↓
2. Fix the prompt (2A + 2C) ──── directs the freed agent toward discovery
       ↓
3. Reframe behavior (4C + 4B) ── gives the agent a discoverer's mental model
       ↓
4. Build SP-56 (3A) ──────────── enables composition and delegation
```

Steps 1 and 2 are the critical pair. Without removing the plan phase, prompt changes won't take hold — the plan-act frame overrides behavioral guidance. Without prompt changes, removing the plan phase creates an undirected agent. Together they transform the agent from executor to explorer.

Steps 3 and 4 build on the new foundation — once the agent can explore freely, give it the vocabulary (behavioral prompt) and the force multiplier (sub-agents) to explore well.

## The deeper insight

The agent's tools ARE its way of thinking. When Claude Code reads a file, it's not executing a plan step — it's looking at something to understand it. The tool call is perception, not execution.

Our agent treats tools as operations to perform. Claude Code treats tools as senses to perceive with.

Navigation implies: "I'm in a space, I can move around, I can look at things, I can decide where to go next based on what I see."

Tool-calling implies: "I have a menu of operations, I pick one, I get a result, I pick the next."

The agent has the filesystem tools now (read_file, glob, grep). It CAN explore. But nothing in the loop or prompts makes exploration the natural first move. The plan phase makes execution the natural first move.

## Status

- [ ] **1C** — Remove separate plan phase, merge into inline reflection in system prompt
- [ ] **2A** — Rewrite anti-exploration prompt language
- [ ] **2C** — Add tool hierarchy (Perceive → Analyze → Act) to system prompt
- [ ] **4C** — Restructure workflow as Look → Notice → Follow → Understand → Act
- [ ] **4B** — Promote inline reasoning as primary, think tool as escalation
- [ ] **3A** — Implement SP-56 (delegate) for composition and sub-agent exploration
- [ ] Test: give the agent a complex task, observe whether it explores before acting
