# SP-29 Assistants Registry

## Main objective

Replace the hardcoded personas system with a YAML-based assistants registry that controls identity (objective, tone, model) and tool visibility per assistant, selectable via CLI positional argument.

## Context

Today `src/config/personas.ts` defines personas as TypeScript objects with `objective`, `tone`, and optional `model`. Tool filtering was specced (SP-21) but not fully shipped — the agent still sends all tools to every LLM call. Adding a new persona requires editing TypeScript source and restarting.

The assistants registry replaces this with auto-discovered YAML files. Each file declares the assistant's identity and which tools it can access. The agent resolves the assistant at startup, filters the tool list accordingly, and templates the system prompt — same plan-act loop, just scoped.

**Supersedes**: SP-19 (Prompt Persona Configuration) and SP-21 (Persona Tool Filtering) — both are folded into this spec.

## Out of scope

- Custom prompt files per assistant (objective + tone templating into `act.md` is sufficient)
- Per-action tool filtering (e.g. allowing `shipping__check` but not `shipping__redirect`)
- Runtime assistant switching within a session
- UI/API for managing assistants — YAML files only
- Changes to the plan-act loop, prompt service, or LLM providers

## Constraints

- YAML files live in `src/assistants/` — one file per assistant, auto-discovered at startup
- `default.yaml` must exist and reproduce current `default` persona behavior exactly (all tools, same objective/tone)
- Only one of `tools.include` or `tools.exclude` may be set per assistant — validation rejects files with both
- The `promptService` placeholder mechanism (`{{objective}}`, `{{tone}}`) remains the injection point — no new templating
- Tool filtering happens at two layers: (1) hide from LLM schema list, (2) reject at dispatch time
- Must not break existing tests or the server entry point
- YAML parsing uses a dependency already available or adds a minimal one (e.g. `yaml` package)

## Acceptance criteria

- [ ] `src/config/personas.ts` is deleted; all persona references are replaced
- [ ] Assistant definitions are YAML files in `src/assistants/*.yaml`, auto-discovered at startup
- [ ] Each YAML file has: `name`, `objective`, `tone`, optional `model`, optional `tools.include` or `tools.exclude`
- [ ] An `AssistantConfig` TypeScript interface exists in `src/types/assistant.ts`
- [ ] An assistants service (`src/services/assistants.ts`) loads, validates, and caches all YAML files at startup
- [ ] Validation rejects: missing required fields, both `tools.include` and `tools.exclude` set, unknown tool names (warning, not error)
- [ ] CLI syntax: `bun run agent [assistant] "prompt" [--session ID] [--model model]` — assistant is optional positional arg, defaults to `default`
- [ ] `getTools()` accepts optional tool filter and returns only matching tools
- [ ] `dispatch()` rejects calls to tools not allowed by the assistant's config
- [ ] `default.yaml` reproduces current default persona behavior (all tools, same objective/tone)
- [ ] `proxy.yaml` reproduces current proxy persona behavior (shipping + think tools only, same objective/tone/model)
- [ ] Server entry point resolves assistant from env var (`ASSISTANT`, fallback `default`)
- [ ] Tests cover: YAML loading, validation errors, tool filtering, dispatch rejection, CLI arg parsing

## Implementation plan

1. **Add `yaml` dependency** — `bun add yaml` (or use Bun's built-in if available). Verify it's available for parsing.

2. **Create `AssistantConfig` type** in `src/types/assistant.ts`:
   ```typescript
   export interface AssistantConfig {
     name: string;
     objective: string;
     tone: string;
     model?: string;
     tools?: {
       include?: string[];
       exclude?: string[];
     };
   }
   ```

3. **Create YAML assistant files** in `src/assistants/`:
   - `default.yaml` — objective and tone extracted from current `default` persona, no tool filter (all tools)
   - `proxy.yaml` — full proxy persona config with `tools.include: [shipping, think]` and `model: gpt-4.1`

4. **Create assistants service** (`src/services/assistants.ts`):
   - `loadAll()` — scans `src/assistants/*.yaml`, parses each, validates, caches in a `Map<string, AssistantConfig>`
   - `get(name)` — returns cached config or throws with available names listed
   - Validation: required fields present, only one of include/exclude set, tool names are strings
   - Called once at startup (lazy singleton pattern)

5. **Add tool filtering to registry** (`src/tools/registry.ts`):
   - `getTools(filter?)` — accepts optional `{ include?: string[], exclude?: string[] }`. When `include` is set, return only matching tools (base-name match for multi-action). When `exclude` is set, return all except matching. When neither, return all.
   - `dispatch(name, args, allowedFilter?)` — before executing, verify the tool is allowed by the filter. Return `toolError` if rejected.

6. **Update agent** (`src/agent.ts`):
   - Resolve assistant config from name (passed as argument)
   - Pass `assistant.tools` to `getTools()` and `dispatch()`
   - Template `act.md` with `assistant.objective` and `assistant.tone`
   - Use `assistant.model` as override when present

7. **Update CLI argument parsing** in `src/agent.ts`:
   - New syntax: `bun run agent [assistant] "prompt" [--session ID] [--model model]`
   - Heuristic: if first non-flag arg doesn't start with `--` and there are at least 2 non-flag args, first is assistant name, second is prompt. If only 1 non-flag arg, it's the prompt (assistant defaults to `default`).
   - Load assistant via `assistants.get(name)`

8. **Update server** (`src/server.ts`):
   - Read `ASSISTANT` env var (default: `"default"`)
   - Load assistant config at startup
   - Pass tool filter through to agent calls

9. **Delete `src/config/personas.ts`** and update all imports.

10. **Write tests**:
    - `src/services/assistants.test.ts` — YAML loading, validation, missing file, both include+exclude rejection
    - `src/tools/registry.test.ts` — tool filtering with include, exclude, no filter; dispatch rejection
    - CLI arg parsing — assistant + prompt, prompt only, with flags

## Testing scenarios

- **YAML loading**: Place valid `default.yaml` and `proxy.yaml` → `loadAll()` returns both configs with correct fields
- **Validation — both filters**: YAML with both `tools.include` and `tools.exclude` → throws validation error
- **Validation — missing required field**: YAML without `objective` → throws with field name
- **Unknown assistant**: `get("nonexistent")` → throws with list of available assistants
- **Tool filtering — include**: `getTools({ include: ["think"] })` → returns only `think` tool
- **Tool filtering — include multi-action**: `getTools({ include: ["shipping"] })` → returns `shipping__check` and `shipping__redirect`
- **Tool filtering — exclude**: `getTools({ exclude: ["bash"] })` → returns all tools except `bash`
- **Tool filtering — no filter**: `getTools()` → returns all tools (backward compatible)
- **Dispatch rejection**: `dispatch("bash", '{"command":"ls"}', { include: ["think"] })` → returns tool error
- **Dispatch allowed**: `dispatch("think", '{"thought":"..."}', { include: ["think"] })` → succeeds
- **CLI — with assistant**: args `["solver", "do something", "--session", "abc"]` → assistant=`solver`, prompt=`do something`, session=`abc`
- **CLI — without assistant**: args `["do something", "--session", "abc"]` → assistant=`default`, prompt=`do something`
- **Default equivalence**: Load `default.yaml` → objective and tone match current `default` persona values exactly
- **End-to-end**: Run `bun run agent proxy "check package X"` → only shipping and think tools in LLM tool list
