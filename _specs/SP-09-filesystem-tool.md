# SP-09 Filesystem tool

## Main objective

Convert the single-action `read_file` tool into a generic multi-action `filesystem` tool, following the established action/payload pattern, to serve as the foundation for all future file-system operations.

## Context

Today `read_file.ts` is a standalone single-action tool that reads a text file and returns its content with line-based truncation. The project already has a proven multi-action pattern (`csv_processor`, `agents_hub`) where one tool exposes multiple actions via the `{ action, payload }` shape and a schema with an `"actions"` key. Converting `read_file` into `filesystem` aligns it with this pattern and gives the agent a single, extensible entry point for file operations.

## Out of scope

- Adding new actions beyond `read_file` (write, list, stat, etc.) — those can be added in future specs
- Changing the `files` service (`src/services/file.ts`) or its path-sandboxing logic
- Modifying the dispatcher or schema-loading mechanism

## Constraints

- Must follow the multi-action pattern established by `csv_processor` (VALID_ACTIONS tuple, actionHandlers map)
- Schema must comply with OpenAI strict mode (`additionalProperties: false` on every object)
- Must use the `files` service for all I/O — no raw `fs` calls
- `read_file` action returns full file content (no truncation)

## Acceptance criteria

- [ ] `src/tools/read_file.ts` is deleted; `src/tools/filesystem.ts` exists and exports a `ToolDefinition` with `name: "filesystem"`
- [ ] `src/schemas/read_file.json` is deleted; `src/schemas/filesystem.json` exists with an `"actions"` key containing `read_file`
- [ ] The `read_file` action accepts `{ path: string }` in payload and returns `{ path, content }` (full file, no truncation)
- [ ] Dispatcher auto-discovers the tool and registers `filesystem__read_file` as an LLM function
- [ ] Existing tests (if any) are updated; new tests cover the `read_file` action (happy path + missing file error)
- [ ] `bun test` passes

## Implementation plan

1. Create `src/tools/filesystem.ts` — multi-action handler with `VALID_ACTIONS = ["read_file"] as const`, action handlers map, main dispatcher function accepting `{ action, payload }`
2. Implement `readFile(payload)` — calls `files.readText(path)`, returns `{ path, content }`
3. Create `src/schemas/filesystem.json` — multi-action schema with `read_file` action requiring `path` (string), `additionalProperties: false`
4. Delete `src/tools/read_file.ts` and `src/schemas/read_file.json`
5. Write `src/tools/filesystem.test.ts` — test read_file action (happy path with a temp file, error on missing file)
6. Run `bun test` to verify everything passes

## Testing scenarios

- **Happy path**: Create a temp file with known content, call `filesystem` handler with `{ action: "read_file", payload: { path } }`, assert returned content matches
- **Missing file**: Call with a non-existent path, assert an error is thrown
- **Unknown action**: Call with `{ action: "bogus", payload: {} }`, assert error about unknown action
