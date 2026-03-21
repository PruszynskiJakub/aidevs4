# SP-42 Type-safety fixes: handler args, MediaCategory, finishReason

## Main objective

Eliminate three independent type-safety gaps — `any` in tool handler args,
duplicated media-type unions, and the `(string & {})` escape hatch in
`finishReason` — to strengthen compile-time guarantees without changing runtime
behaviour.

## Context

1. **`ToolDefinition.handler: (args: any)`** (`src/types/tool.ts`) — The `any`
   parameter silently accepts `null`, `number`, or any non-object value at
   compile time. An ESLint-disable comment explains why generics were avoided
   (registration complexity), but `Record<string, unknown>` gives the same
   ergonomics while enforcing "object with string keys."

2. **`DocumentMetadata.type` vs `MediaCategory`** — Two identical 5-member
   unions (`"document" | "text" | "image" | "audio" | "video"`) are defined
   independently in `src/types/document.ts` and `src/utils/media-types.ts`.
   `web.ts` already bridges them via `inferCategory()`, but the types are not
   linked. A change to one won't break the other.

3. **`LLMChatResponse.finishReason`** (`src/types/llm.ts`) — The
   `(string & {})` tail defeats the purpose of the literal union; any typo
   compiles. Only `"stop"` is checked in production (`agent.ts:198`). Two
   providers (OpenAI, Gemini) supply raw strings from their SDKs.

## Out of scope

- Generic `ToolDefinition<T>` with per-tool arg types (deferred — too much
  registry churn for the benefit right now)
- Broader type audit beyond these three items
- Runtime behaviour changes — all fixes are type-level only

## Constraints

- Zero runtime impact — no new allocations, no changed control flow
- `bun test` must pass without modification to existing test assertions
- No changes to OpenAI function-calling schemas (JSON files)
- Keep `satisfies ToolDefinition` pattern in all tool files

## Acceptance criteria

- [ ] `ToolDefinition.handler` parameter typed as `Record<string, unknown>`; ESLint-disable comment removed
- [ ] All tool handlers compile without errors (inline casts may need adjustment)
- [ ] `DocumentMetadata.type` uses `MediaCategory` instead of an inline union
- [ ] `document.ts` imports `MediaCategory` from `media-types.ts`
- [ ] The inline union in `DocumentMetadata` is deleted (single source of truth)
- [ ] `LLMChatResponse.finishReason` typed as `string`
- [ ] Each provider adapter maps SDK finish-reason to `string` (no change needed — already the case)
- [ ] `agent.ts` comparison `=== "stop"` still works (string equality — no type narrowing lost)
- [ ] `bun test` passes
- [ ] `bun run tsc --noEmit` passes (or project's equivalent type-check command)

## Implementation plan

1. **`MediaCategory` unification**
   - In `src/types/document.ts`, replace the inline `"document" | "text" | "image" | "audio" | "video"` with an import of `MediaCategory` from `src/utils/media-types.ts`.
   - Update `document-store.test.ts` helper `makeDoc` to use `MediaCategory` instead of its own inline literal union.

2. **`ToolDefinition.handler` args**
   - In `src/types/tool.ts`, change `handler: (args: any)` to `handler: (args: Record<string, unknown>)`.
   - Remove the ESLint-disable comment.
   - In each tool file, update destructuring/casts to work with `Record<string, unknown>` (e.g., add explicit type assertion `as { action: string; payload: ... }`).

3. **`finishReason` simplification**
   - In `src/types/llm.ts`, change `finishReason` from the union+escape-hatch to plain `string`.
   - No provider or agent changes needed — `=== "stop"` works on `string`.

4. **Verify**
   - Run `bun run tsc --noEmit` (or equivalent).
   - Run `bun test`.

## Testing scenarios

- **Compile-time**: `tsc --noEmit` passes — proves no type errors were introduced.
- **Unit tests**: `bun test` passes — proves no runtime regressions.
- **Manual spot-check**: Verify that passing a non-object (e.g., `null`) to a handler now produces a compile error (confirms `Record<string, unknown>` works).
- **MediaCategory single source**: Grep for the old inline union `"document" | "text" | "image" | "audio" | "video"` in `document.ts` — should not exist.
