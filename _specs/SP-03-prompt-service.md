# SP-03 Prompt Service

## Main objective

Introduce a prompt service that loads `.md` prompt files with YAML frontmatter
(model, temperature) and renders `{{placeholder}}` variables, then migrate the
existing system prompt to this format.

## Context

Today the only prompt lives in `src/prompts/system.ts` as a hardcoded
TypeScript string constant. Model names are hardcoded in `src/config.ts`.
There is no way to control model or temperature per prompt, no templating, and
no frontmatter parsing. `CLAUDE.md` already mandates markdown prompts with YAML
frontmatter and `{{placeholders}}` but the infrastructure doesn't exist yet
(backlog items US-1, US-5).

The LLM service (`src/services/llm.ts`) already accepts `model`,
`systemPrompt`, `userPrompt`, and `temperature` in its `completion()` method,
so the prompt service only needs to **load and render** — callers wire the
result into the LLM service themselves.

## Out of scope

- Multi-provider support (US-2) — this spec targets OpenAI-compatible models only
- Prompt versioning or A/B testing
- Runtime prompt reloading / hot-reload
- Nested template includes (`{{> partial}}`)
- Frontmatter fields beyond `model` and `temperature`

## Constraints

- No heavy templating engines (Handlebars, Mustache, etc.) — keep it minimal
- Frontmatter parsing: use a lightweight dependency (`gray-matter` or similar);
  avoid hand-rolling YAML parsing
- Prompt files live in `src/prompts/` with `.md` extension
- The service must be pure (no side effects beyond file I/O) — it does NOT call
  the LLM
- Must work with Bun runtime

## Acceptance criteria

- [ ] A `PromptService` exists at `src/services/prompt.ts`
- [ ] It exposes a `load(name, variables?)` method that:
  - reads `src/prompts/{name}.md`
  - parses YAML frontmatter extracting `model` and `temperature`
  - replaces `{{key}}` placeholders with provided variables
  - returns `{ model: string, temperature?: number, content: string }`
- [ ] Missing placeholder variables throw a clear error
- [ ] Extra (unused) variables are silently ignored
- [ ] Frontmatter fields are optional — `model` and `temperature` can be omitted
- [ ] The existing system prompt is migrated to `src/prompts/system.md` with
      appropriate frontmatter
- [ ] `src/prompts/system.ts` is removed
- [ ] `src/agent.ts` (or wherever the system prompt is consumed) is updated to
      use the new service
- [ ] All existing tests pass; new unit tests cover the prompt service

## Implementation plan

1. **Install `gray-matter`** — `bun add gray-matter` (+ `@types/gray-matter`
   if needed)
2. **Create `src/services/prompt.ts`** — implement `PromptService` with:
   - `load(name: string, variables?: Record<string, string>)` method
   - frontmatter parsing via `gray-matter`
   - `{{placeholder}}` regex replacement
   - return type: `{ model: string; temperature?: number; content: string }`
3. **Create `src/services/prompt.test.ts`** — unit tests covering:
   - loading a prompt with frontmatter + placeholders
   - missing variable error
   - optional frontmatter fields
   - extra variables ignored
4. **Migrate system prompt** — create `src/prompts/system.md`:
   ```yaml
   ---
   model: gpt-4.1
   ---
   ```
   followed by the prompt content from `system.ts`
5. **Update consumers** — change `src/agent.ts` to use
   `promptService.load('system')` instead of importing `SYSTEM_PROMPT`
6. **Delete `src/prompts/system.ts`**
7. **Run tests** — verify everything passes

## Testing scenarios

| # | Scenario | Verifies |
|---|----------|----------|
| 1 | Load a prompt with `model` and `temperature` in frontmatter | Frontmatter extraction works |
| 2 | Load a prompt with `{{name}}` placeholder, pass `{ name: 'Alice' }` | Placeholder substitution works |
| 3 | Load a prompt with `{{name}}` placeholder, pass no variables | Throws descriptive error |
| 4 | Load a prompt with no frontmatter | Returns content, model/temperature undefined |
| 5 | Load a prompt with extra variables `{ name: 'Alice', unused: 'x' }` | No error, extra vars ignored |
| 6 | Load non-existent prompt file | Throws file-not-found error |
| 7 | `bun run agent "..."` works end-to-end after migration | System prompt migration didn't break the agent |
