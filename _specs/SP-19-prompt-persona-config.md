# SP-19 Prompt Persona Configuration

## Main objective

Support configurable prompt personas so the agent's tone, objective, and model can be swapped at server startup via a simple config, without forking the agent loop or duplicating prompt files.

## Context

Today the agent has a single hardcoded system prompt (`src/prompts/system.md`) loaded unconditionally by both the CLI entry point and the Hono server. The prompt is a monolith — reasoning protocol, workflow rules, and tool guidelines all in one file. There is no way to change the agent's personality, goals, or communication style without editing the prompt file itself.

The `promptService` already supports `{{placeholder}}` variable substitution, but no caller uses it yet for the system prompt. The server loads the prompt on first interaction per session and stores messages in `sessionService`.

For upcoming tasks (e.g., the proxy logistics assistant), the agent needs to adopt completely different personas — different tone, different objectives, potentially different models — while the core agent loop, tool dispatch, and session management remain unchanged.

## Out of scope

- Answer post-processing / rewriting step (separate spec if needed)
- Per-tool filtering by persona (all tools remain available; the prompt guides usage)
- Per-request persona override (config is server-level only)
- Runtime persona switching within a session
- Changes to tool dispatch, session service, or the agent loop itself

## Constraints

- The existing `system.md` must continue to work as the default persona (no breaking change to current agent behavior)
- Adding a new persona requires only adding an entry to the personas dictionary in `src/config/personas.ts`
- The `promptService` placeholder mechanism (`{{var}}`) is the injection point — no new templating engine
- Prompt files stay in `src/prompts/` following existing conventions (`.md` + YAML frontmatter)
- Model override in persona config takes precedence over the prompt file's frontmatter model

## Acceptance criteria

- [ ] System prompt template (`system.md`) has `{{objective}}` and `{{tone}}` placeholders with sensible defaults for the current agent behavior
- [ ] A persona registry exists as a TypeScript dictionary in `src/config/personas.ts`, mapping agent names to `{ objective, tone, model? }` with a `"default"` fallback
- [ ] Server reads persona config at startup (from env var pointing to a config file, or a default config)
- [ ] `runAgent()` accepts an optional model override parameter so the server can pass the persona's model
- [ ] Default persona reproduces current agent behavior exactly (objective = current reasoning/workflow block, tone = current style)
- [ ] A second persona can be created (e.g., `proxy`) by adding an entry to the personas dictionary — objective and tone are inline strings, no extra files needed
- [ ] Tests verify: default persona produces identical system prompt content, custom persona injects its objective/tone correctly, model override flows through to LLM call

## Implementation plan

1. **Add placeholders to `system.md`**
   - Identify the "objective" section (Reasoning Protocol + Workflow + Answer Submission) and the "tone" section (implicit — currently none)
   - Replace the objective section with `{{objective}}`
   - Add `{{tone}}` placeholder (at the end or after the objective block)
   - The extracted objective text and a default tone string become the `"default"` entry in the personas dictionary

2. **Create the personas dictionary**
   - Create `src/config/personas.ts`:
     ```typescript
     export interface PersonaConfig {
       objective: string;   // inline text injected into {{objective}}
       tone: string;        // inline text injected into {{tone}}
       model?: string;      // overrides prompt frontmatter model
     }

     const personas: Record<string, PersonaConfig> = {
       default: {
         objective: `...extracted reasoning protocol + workflow text...`,
         tone: `Respond concisely and precisely. Use the language of the task.`,
       },
       proxy: {
         objective: `You are a logistics system assistant. Help operators check and manage packages...`,
         tone: `Speak naturally like a colleague. Match the operator's language. Be casual but professional.`,
         model: "gpt-4.1",
       },
     };

     export function getPersona(name?: string): PersonaConfig {
       const key = name ?? "default";
       const persona = personas[key];
       if (!persona) throw new Error(`Unknown persona: "${key}". Available: ${Object.keys(personas).join(", ")}`);
       return persona;
     }
     ```
   - Lookup by name with fallback to `"default"`

3. **Wire persona into server startup**
   - Add `PERSONA` env var (defaults to `"default"`)
   - Server calls `getPersona(process.env.PERSONA)` once at startup
   - On session init, call `promptService.load("system", { objective: persona.objective, tone: persona.tone })`
   - If persona has a model override, pass it through to `runAgent()`

4. **Extend `runAgent()` to accept model override**
   - Add optional `options?: { model?: string }` parameter to `runAgent()`
   - If provided, use it instead of `system.model` from the prompt frontmatter
   - CLI entry point passes no override (uses prompt frontmatter as before)

## Testing scenarios

- **Default equivalence**: Load system prompt with default persona → compare output to current monolithic `system.md` content (should be identical modulo whitespace)
- **Custom persona injection**: Load system prompt with a test persona that has distinct objective/tone text → verify both appear in the rendered prompt at the correct positions
- **Model override**: Create persona with `model: "gpt-4.1-mini"` → verify `runAgent` uses that model instead of the frontmatter model
- **Unknown persona**: Call `getPersona("nonexistent")` → verify clear error with available persona names listed
- **Missing placeholder**: Remove `{{tone}}` from system.md but persona tries to inject it → verify `promptService.load` throws (existing behavior)
- **Env var loading**: Set `PERSONA=proxy` → verify server uses proxy persona; unset → verify default is used
