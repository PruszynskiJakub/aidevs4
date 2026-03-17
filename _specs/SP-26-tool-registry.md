# SP-26 Replace dispatcher with toolRegistry

## Main objective

Replace the auto-discovering `dispatcher.ts` with an explicit `toolRegistry` that supports programmatic registration and resolution of tools, removing all filesystem scanning.

## Context

Today `src/tools/dispatcher.ts` combines three responsibilities:

1. **Auto-discovery** — scans `src/tools/*.ts` and `src/schemas/*.json` at runtime via dynamic `import()`, matching by filename convention.
2. **Schema expansion** — converts multi-action tool schemas (with `actions` key) into flat OpenAI function definitions (`tool__action`).
3. **Dispatch** — routes incoming tool calls to the correct handler, splitting on `__` for multi-action tools, wrapping results/errors.

This works but has drawbacks:
- No way to register tools programmatically (e.g., dynamic tools, test doubles).
- Implicit filename coupling between `src/tools/<name>.ts` and `src/schemas/<name>.json`.
- Module-level caching with no reset path — tools can't be added or replaced after first load.
- All three concerns entangled in one file.

The new `toolRegistry` makes registration explicit: a central manifest imports each tool and schema, calls `register()`, and the registry handles expansion and dispatch.

## Out of scope

- Changing the tool file convention (`ToolDefinition` interface, `{ name, handler }` exports) — tools keep their current shape.
- Moving schemas into `.ts` files — schemas stay as separate `.json` files in `src/schemas/`.
- Adding tool dependencies, versioning, or hot-reload.
- Changing the multi-action handler shape (`{ action, payload }`).

## Constraints

- Zero behavioral change for the agent — `getTools()` returns the same `LLMTool[]`, `dispatch()` produces identical results.
- OpenAI strict mode compliance preserved (`strict: true`, `additionalProperties: false`).
- All existing tools must work without modification to their handler or schema files.
- No dynamic `import()` or filesystem scanning in the registry itself.

## Acceptance criteria

- [ ] `toolRegistry` module exists at `src/tools/registry.ts` with `register()`, `getTools()`, `dispatch()`, and `reset()` methods.
- [ ] `register(tool: ToolDefinition, schema: ToolSchema)` accepts a tool definition and its raw schema, stores both, and expands multi-action schemas internally.
- [ ] `getTools()` returns `LLMTool[]` identical to current dispatcher output (same names, descriptions, parameters, `strict: true`).
- [ ] `dispatch(name, argsJson)` routes to the correct handler with the same behavior as current dispatcher (simple tools, multi-action split on `__`, error wrapping, result wrapping).
- [ ] `reset()` clears all registered tools (for testing).
- [ ] Central manifest at `src/tools/index.ts` imports every tool + schema and calls `register()` for each.
- [ ] `agent.ts` imports from the manifest / registry instead of dispatcher.
- [ ] `dispatcher.ts` is deleted.
- [ ] All existing tests pass (updated to use registry).
- [ ] New unit tests cover: register + resolve, multi-action expansion, dispatch routing, duplicate name rejection, reset, unknown tool error.

## Implementation plan

1. **Create `src/tools/registry.ts`** — the `toolRegistry` singleton with:
   - Internal `Map<string, { tool: ToolDefinition, schema: ToolSchema }>` for registered tools.
   - `register(tool, schema)` — validates no duplicate names, stores entry, expands multi-action schemas into cached `LLMTool[]`.
   - `getTools()` — returns the cached expanded `LLMTool[]`.
   - `dispatch(name, argsJson)` — same routing logic as current dispatcher (direct lookup, `__` split for multi-action, error/result wrapping).
   - `reset()` — clears maps and caches (for test isolation).

2. **Create `src/tools/index.ts`** (central manifest) — imports each tool's default export and its schema JSON, calls `toolRegistry.register()` for each. This is the single place that wires tools into the system.

3. **Update `src/agent.ts`** — replace `import { getTools, dispatch } from "./tools/dispatcher"` with imports from registry (via `src/tools/index.ts` or directly from registry).

4. **Delete `src/tools/dispatcher.ts`** and update any remaining imports.

5. **Update `src/tools/dispatcher.test.ts`** — rename to `registry.test.ts`, rewrite tests to use the new registry API. Add tests for `register()`, `reset()`, duplicate rejection.

6. **Run full test suite** — `bun test` to verify no regressions.

## Testing scenarios

- **Registration**: Register a simple tool, verify `getTools()` includes it with correct name/description/parameters/strict.
- **Multi-action expansion**: Register a multi-action tool, verify `getTools()` expands to `tool__action` entries.
- **Dispatch (simple)**: Register a tool, dispatch by name, verify handler called with parsed args and result wrapped.
- **Dispatch (multi-action)**: Register multi-action tool, dispatch `tool__action`, verify handler receives `{ action, payload }`.
- **Unknown tool**: Dispatch unregistered name, verify error response.
- **Duplicate rejection**: Register same name twice, verify error thrown.
- **Reset**: Register tools, call `reset()`, verify `getTools()` returns empty array.
- **Agent integration**: Run `bun run agent "test"` to verify end-to-end tool calling still works.
