# SP-60 Migrate Tool Schemas from JSON to Zod

## Main objective

Replace the 14 hand-written JSON schema files in `src/schemas/` with co-located Zod schemas inside each tool file, eliminating the separate schema directory and enabling dynamic/programmatic schema construction (needed by SP-59 delegate tool).

## Context

Tool schemas are currently standalone JSON files in `src/schemas/*.json`, imported and paired with handlers in `src/tools/index.ts`. This works for static schemas but breaks down when a schema needs runtime data — e.g. the `delegate` tool (SP-59) must populate its `agent` enum dynamically from `.agent.md` files at startup. JSON files can't express that.

Zod is a natural fit: it provides TypeScript-native schema definitions, runtime validation, and can convert to JSON Schema (OpenAI function-calling format) via `zod-to-json-schema` or the built-in `.toJsonSchema()` in Zod 4. Co-locating each schema with its handler removes the two-file convention and simplifies registration.

## Out of scope

- Changing tool handler logic or behavior
- Changing the OpenAI function-calling wire format (the registry still produces `LLMTool` objects)
- Adding Zod-based runtime validation to handler args (can be done later; handlers keep existing manual validation for now)
- Multi-action schema redesign — the `actions` pattern stays, just expressed in Zod

## Constraints

- Output must remain OpenAI strict-mode compatible: `additionalProperties: false`, all props in `required`, no `oneOf`/`anyOf`/type arrays
- Zod version must support JSON Schema conversion compatible with OpenAI's subset
- Migration is 1:1 — each JSON schema maps to an equivalent Zod schema, no behavioral changes
- `src/schemas/` directory is deleted after migration (no lingering JSON files)

## Acceptance criteria

- [ ] `zod` (and `zod-to-json-schema` if needed) added as dependencies
- [ ] Each tool file (`src/tools/*.ts`) exports a `schema` alongside the existing default `ToolDefinition`
- [ ] `ToolDefinition` type updated to include `schema` field (Zod object that the registry converts to OpenAI format)
- [ ] The registry (`src/tools/registry.ts`) accepts Zod schemas and converts them to `LLMTool` objects internally
- [ ] Multi-action tools (e.g. `agents_hub`) express their actions as a record of named Zod schemas
- [ ] All 14 JSON schema files in `src/schemas/` are deleted
- [ ] `src/tools/index.ts` simplified — no more separate schema imports; registration uses the schema from each tool's export
- [ ] `bun test` passes with no regressions
- [ ] Agent runs produce identical tool definitions in LLM requests (verified by comparing before/after log output)

## Implementation plan

1. **Install dependencies**
   - `bun add zod`
   - `bun add zod-to-json-schema` (if Zod 3; Zod 4 has `.toJsonSchema()` built-in — check which version is available)

2. **Update `ToolDefinition` type** (`src/types/tool.ts`)
   - Add `schema` field for simple tools: a Zod object + `name` + `description`
   - Add `actions` field for multi-action tools: record of `{ description, schema: ZodObject }`
   - Make schema required so every tool is self-describing

3. **Update registry** (`src/tools/registry.ts`)
   - Change `register()` to accept the new `ToolDefinition` (which includes schema)
   - Convert Zod schemas to OpenAI JSON Schema format internally using `zodToJsonSchema()` or equivalent
   - Ensure `additionalProperties: false` and `strict: true` are set on output
   - Remove the separate `SimpleSchema` / `MultiActionSchema` interfaces for JSON (replaced by Zod-derived types)

4. **Migrate each tool** (14 tools, one at a time)
   - For each tool in `src/tools/*.ts`:
     a. Define a Zod schema matching the current JSON schema exactly
     b. Export it as part of the tool definition
     c. Delete the corresponding `src/schemas/<tool_name>.json`
   - Order: start with `think` (simplest), then other simple tools, then `agents_hub` (multi-action)

5. **Simplify `src/tools/index.ts`**
   - Remove all JSON schema imports
   - `register()` calls take just the tool definition (schema is embedded)
   - Result: each line is just `register(toolName)`

6. **Delete `src/schemas/` directory**

7. **Verify equivalence**
   - Run agent before and after, compare the `tools` array in LLM request logs
   - Ensure parameter names, types, descriptions, required fields all match

## Testing scenarios

- **Schema equivalence**: For each tool, compare the Zod-generated JSON Schema against the original JSON file — must be structurally identical
- **Registry integration**: Register a Zod-based tool, verify `getTools()` returns a valid `LLMTool` with correct `function.parameters`
- **Multi-action expansion**: Verify `agents_hub` still expands to 4 separate `LLMTool` entries with correct names
- **Strict mode compliance**: Verify all generated schemas have `additionalProperties: false` and all properties in `required`
- **End-to-end**: Run `bun run agent "test"` and verify tools appear correctly in the LLM request
- **No leftover JSON**: Verify `src/schemas/` directory no longer exists
