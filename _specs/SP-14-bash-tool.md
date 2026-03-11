# SP-14 Replace filesystem and data_transformer with bash tool

## Main objective

Replace the `filesystem` and `data_transformer` tools with a single `bash` tool that executes shell commands, giving the agent universal data processing via `jq`, standard Unix tools, and file I/O — eliminating rigid data shape constraints that block multi-step pipelines.

## Context

Today the agent has two data-processing tools (`filesystem` with 1 action, `data_transformer` with 4 actions) that only handle flat JSON arrays and CSV. Real-world data from APIs and downloads is nested, keyed, or wrapped in `{input, response}` pairs. The agent cannot:

- Reshape nested objects into flat arrays (`jq` one-liner)
- Flatten api_batch output for use with `geo_distance`
- Write a single JSON object (every tool writes arrays)
- Create small intermediate files (coordinate mappings, answer payloads)

This forces the LLM to misuse `add_field` (LLM-powered) for trivial extractions and attempt lossy CSV roundtrips — wasting iterations and producing wrong results (see `findhim` task log: 18 iterations, wrong answer).

A bash tool with access to `jq` and standard Unix tools solves all of these as one-liners while reducing tool count from 13 to 9. The playground prototype at `playground/bash/bash.ts` demonstrates the pattern.

## Out of scope

- Changes to `agents_hub`, `geo_distance`, or `think` tools
- Changes to the dispatcher or schema-loading mechanism
- Changes to `src/services/file.ts` or `src/utils/csv.ts` (still used by `agents_hub` api_batch)
- System prompt (`system.md`) updates — handled separately if needed
- Sandboxing beyond CWD lock (no chroot, no command blocklist)

## Constraints

- CWD locked to `OUTPUT_DIR` (`src/output/`) — all relative paths resolve there
- Output truncated at 20 KB to prevent context bloat
- Must follow the simple tool pattern (like `think`) — single schema with `parameters`, not multi-action
- Must use Bun `$` shell API for execution
- Schema must comply with OpenAI strict mode (`additionalProperties: false`)
- Non-zero exit codes are reported but do not throw — the LLM sees the error and can retry

## Acceptance criteria

- [ ] `src/tools/bash.ts` exists, exports `ToolDefinition` with `name: "bash"`
- [ ] `src/schemas/bash.json` exists with simple (non-action) schema: `{ command: string }`
- [ ] Commands execute with CWD set to `OUTPUT_DIR` (resolved absolute path)
- [ ] stdout and stderr are captured and merged in the result
- [ ] Non-zero exit codes are included in output as `[exit code N]` prefix, not thrown
- [ ] Output longer than 20,000 characters is truncated with `...(truncated)` suffix
- [ ] Dispatcher auto-discovers the tool and registers `bash` as an LLM function
- [ ] Old files deleted: `src/tools/filesystem.ts`, `src/tools/filesystem.test.ts`, `src/schemas/filesystem.json`
- [ ] Old files deleted: `src/tools/data_transformer.ts`, `src/tools/data_transformer.test.ts`, `src/schemas/data_transformer.json`
- [ ] `src/tools/dispatcher.test.ts` updated — tool count changes from 13 to 9 (agents_hub: 5 + geo_distance: 2 + think: 1 + bash: 1)
- [ ] `src/tools/bash.test.ts` covers: simple command, non-zero exit, output truncation
- [ ] `bun test` passes

## Implementation plan

1. Create `src/schemas/bash.json` — simple schema (not multi-action):
   ```json
   {
     "name": "bash",
     "description": "Execute a shell command. CWD is the output directory. Use jq for JSON processing, standard Unix tools for text. Use absolute paths to read files outside CWD.",
     "parameters": {
       "type": "object",
       "properties": {
         "command": {
           "type": "string",
           "description": "The bash command to execute"
         }
       },
       "required": ["command"],
       "additionalProperties": false
     }
   }
   ```

2. Create `src/tools/bash.ts` — promote from playground prototype:
   - Import `OUTPUT_DIR` from config, resolve to absolute path for CWD
   - Handler: `async (args: { command: string }) => Promise<string>`
   - Execute via `$`bash -c ${command}`.cwd(resolvedOutputDir).quiet().nothrow()`
   - Merge stdout + stderr, prefix with exit code on failure
   - Truncate at 20,000 chars
   - Export `default { name: "bash", handler } satisfies ToolDefinition`

3. Delete old tools:
   - `src/tools/filesystem.ts`, `src/tools/filesystem.test.ts`, `src/schemas/filesystem.json`
   - `src/tools/data_transformer.ts`, `src/tools/data_transformer.test.ts`, `src/schemas/data_transformer.json`

4. Update `src/tools/dispatcher.test.ts`:
   - Tool count: 13 → 9
   - Remove assertions for `filesystem__inspect`, `data_transformer__filter`, etc.
   - Add assertion for `bash` tool presence

5. Write `src/tools/bash.test.ts`:
   - Simple command: `echo hello` → `"hello"`
   - Non-zero exit: `exit 42` → contains `[exit code 42]`
   - Output truncation: command producing >20KB → ends with `...(truncated)`
   - CWD verification: `pwd` → resolves to output directory

6. Run `bun test` to verify

## Testing scenarios

| Scenario | Command | Expected |
|---|---|---|
| Simple output | `echo hello` | `"hello"` |
| Non-zero exit | `ls /nonexistent` | Contains `[exit code` and error message |
| JSON processing | `echo '{"a":1}' \| jq '.a'` | `"1"` |
| CWD is output dir | `pwd` | Absolute path ending in `src/output` |
| Output truncation | `seq 1 100000` | Truncated at 20KB with suffix |
| File write + read | `echo '{"x":1}' > test.json && cat test.json` | `{"x":1}` |
