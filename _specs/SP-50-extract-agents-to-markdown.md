# SP-50 Extract Agents to Self-Contained Markdown Files

## Main objective

Replace the YAML-based assistant system (`src/assistants/`) with self-contained Markdown agent files in `workspace/agents/`, where each file carries the full system prompt in its body and agent metadata in YAML frontmatter — removing the dependency on `act.md` template composition.

## Context

Today, assistants are defined as YAML files in `src/assistants/` with fields `name`, `objective`, `tone`, optional `model` and `tools`. At resolve time, `assistant-resolver.ts` loads the shared `act.md` prompt template and injects `{{objective}}` and `{{tone}}` via placeholder substitution. This means:

- The actual system prompt an agent receives is split across two files (`act.md` + the YAML) and only assembled at runtime — hard to read, hard to reason about.
- Every assistant inherits the same reasoning protocol, workflow, and error recovery scaffolding from `act.md` — even when it's inappropriate (e.g. the `proxy` assistant explicitly tells the LLM to "ignore the Reasoning Protocol and Workflow sections").
- Adding a new agent requires understanding the template composition system rather than just writing a prompt.

The new format makes each agent file a single source of truth: open the file, read the prompt. No indirection, no placeholders, no inherited scaffolding.

## Out of scope

- Changing the agent execution loop (`agent.ts`), planning phase, or memory system
- Modifying tool implementations or the tool registry
- Auto-discovery of agent files (keep explicit registration or simple glob)
- Creating new agents beyond migrating the existing three
- Changes to the CLI interface beyond updating the assistant resolution path

## Constraints

- The new loader must remain compatible with the existing `ResolvedAssistant` interface (`{ prompt, model, toolFilter }`) so `agent.ts` and `orchestrator.ts` require minimal changes
- Agent files must be parseable by standard YAML frontmatter + Markdown parsers (same pattern as `src/prompts/*.md`)
- The `workspace/` directory is at the project root (sibling to `src/`, `playground/`)
- Existing session pinning (sessions bound to an assistant name) must continue to work
- `act.md` may be kept temporarily but should no longer be used by the agent resolution path

## Acceptance criteria

- [ ] Directory `workspace/agents/` exists with one `.md` file per agent
- [ ] Each agent file has YAML frontmatter with required fields: `name`, `model` and optional fields: `tools` (include/exclude), `capabilities` (string array of behavioral traits)
- [ ] The Markdown body below frontmatter is the complete system prompt — no `{{placeholders}}`, no dependency on `act.md` or any shared template
- [ ] `assistants.ts` (or its replacement) loads `.md` files from `workspace/agents/` instead of `.yaml` files from `src/assistants/`
- [ ] `assistant-resolver.ts` returns the Markdown body directly as `prompt` instead of composing via `act.md`
- [ ] `AssistantConfig` type is updated (or replaced) to reflect the new shape: `name`, `model`, `prompt` (full body), `tools?`, `capabilities?`
- [ ] All three existing assistants (`default`, `proxy`, `s2e1`) are migrated to the new format with their full, self-contained system prompts
- [ ] Agent runs via `bun run agent "prompt"` produce identical behavior (same model, same tools, same system prompt content)
- [ ] Existing tests pass; new tests cover the updated loader and resolver
- [ ] Old `src/assistants/` directory is removed

## Implementation plan

1. **Create `workspace/agents/` directory** at project root.

2. **Define the new agent file format.** Each file is `<agent_name>.md`:

   ```markdown
   ---
   name: default
   model: gpt-5-2025-08-07
   tools:
     include: [think, bash, web]
   capabilities:
     - task solving
     - web browsing
     - code execution
   ---

   You are an autonomous agent that solves tasks...

   ## Reasoning Protocol

   Before every tool call, reason explicitly...

   (full prompt — no placeholders)
   ```

3. **Migrate existing assistants.** For each of the three:
   - `default.yaml` → `default.md`: Merge `act.md` scaffolding with default's objective/tone into one self-contained prompt. Model: `gpt-5-2025-08-07` (from `act.md`). No tool filter (all tools available).
   - `proxy.yaml` → `proxy.md`: Write a standalone prompt with the proxy identity rules and conversation style. Model: `gpt-4.1`. Tools: `include: [shipping, think]`. Strip the reasoning protocol and workflow sections that proxy currently tells the LLM to ignore.
   - `s2e1.yaml` → `s2e1.md`: Merge `act.md` scaffolding with s2e1's detailed workflow into one prompt. Model: `gpt-5-2025-08-07`. Tools: `include: [think, prompt_engineer, agents_hub, web, bash]`.

4. **Update `AssistantConfig` type** (`src/types/assistant.ts`):
   ```typescript
   export interface AgentConfig {
     name: string;
     model: string;
     prompt: string;           // full system prompt from markdown body
     tools?: ToolFilter;
     capabilities?: string[];
   }
   ```

5. **Rewrite the loader** (`src/services/agent/assistant/assistants.ts`):
   - Change `ASSISTANTS_DIR` to point to `workspace/agents/`
   - Glob for `*.md` instead of `*.yaml`
   - Parse YAML frontmatter + Markdown body (reuse `promptService` parsing or extract the frontmatter parser)
   - Validate new required fields (`name`, `model`) and optional fields (`tools`, `capabilities`)
   - Return the Markdown body as `prompt`

6. **Simplify the resolver** (`src/services/agent/assistant/assistant-resolver.ts`):
   - Remove `act.md` loading and placeholder substitution
   - `resolve()` now returns `{ prompt: agent.prompt, model: agent.model, toolFilter: agent.tools }` directly from the loaded config
   - The resolver becomes a thin pass-through (may be inlined into the loader if desired)

7. **Update imports and references:**
   - `agent.ts`: no changes needed if `ResolvedAssistant` shape is preserved
   - `orchestrator.ts`: no changes needed (uses assistant name for session pinning)
   - `cli.ts`: no changes needed (passes assistant name string)

8. **Remove old files:**
   - Delete `src/assistants/` directory (all three YAML files)
   - Optionally keep `act.md` in `src/prompts/` with a deprecation note, or remove if nothing else references it

9. **Update tests** for the new loader and resolver.

## Testing scenarios

- **Loader tests**: Valid agent `.md` file loads correctly; missing required frontmatter fields (`name`, `model`) throw descriptive errors; malformed YAML frontmatter throws; empty markdown body throws; `tools` validation (include/exclude mutual exclusivity) still works
- **Resolver tests**: `resolve()` returns the full markdown body as `prompt`, correct `model`, and correct `toolFilter`; caching works as before
- **Migration verification**: Run `bun run agent "What tools do you have?"` with each agent and compare system prompt in logs against the old composed prompt — content should be equivalent
- **Session pinning**: Start a session with one agent, resume with `--session` — same agent is used
- **Edge cases**: Unknown agent name returns descriptive error with available agents listed; agent file with no tools field means all tools available
