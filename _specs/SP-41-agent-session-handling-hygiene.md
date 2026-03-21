# SP-41 Agent session-handling hygiene

## Main objective

Fix two architectural issues in the agent layer: relocate `randomSessionId()` out of the logging module and eliminate the implicit message-mutation contract between `runAgent` and its callers.

## Context

**randomSessionId()** is defined in `src/services/common/logging/markdown-logger.ts:21` and re-exported from `logging/index.ts`. Session ID generation is an identity concern, not a logging concern. Additionally, `orchestrator.ts:37` duplicates the logic by calling `crypto.randomUUID()` directly instead of using the shared function.

**Message sync** relies on an implicit contract: `orchestrator.ts:52` creates a shallow copy of session messages, passes it to `runAgent()`, which mutates the array in-place via `state.messages.push()` (three call sites in `agent.ts`). After `runAgent` returns, the orchestrator slices off new messages. If `runAgent` ever stops mutating the input array, the orchestrator breaks silently with no error — new messages are simply lost.

## Out of scope

- Refactoring the agent loop itself (tool dispatch, LLM calls)
- Changing the session persistence layer (`sessionService`)
- Changing the `MarkdownLogger` API beyond removing `randomSessionId()`

## Constraints

- `runAgent` is called from `orchestrator.ts` only — but its signature is public, so the change must be backward-compatible or all callers updated in the same PR
- No new dependencies
- Must not break existing session log directory structure (which relies on session IDs)

## Acceptance criteria

- [ ] `randomSessionId()` lives in a dedicated util (e.g. `src/services/common/id.ts` or `src/utils/id.ts`), not in the logging module
- [ ] `MarkdownLogger` imports `randomSessionId` from the new location
- [ ] `orchestrator.ts` uses the shared `randomSessionId()` instead of raw `crypto.randomUUID()`
- [ ] `logging/index.ts` no longer exports `randomSessionId`
- [ ] `runAgent` returns `{ answer: string; messages: LLMMessage[] }` (the new messages produced during the run)
- [ ] `runAgent` does NOT mutate the input `messages` array
- [ ] `orchestrator.ts` uses the returned messages instead of the slice trick
- [ ] All existing tests pass
- [ ] No `grep` hits for the old import path of `randomSessionId` from logging

## Implementation plan

1. Create `src/utils/id.ts` exporting `randomSessionId()` (move, not copy)
2. Update `markdown-logger.ts` to import from `src/utils/id.ts`
3. Remove `randomSessionId` export from `logging/index.ts`
4. Update `orchestrator.ts` to use `randomSessionId()` from the new util instead of `crypto.randomUUID()`
5. Fix all remaining import sites (tests, etc.)
6. Refactor `runAgent` in `agent.ts`:
   - Create an internal `messages` array (clone of input) instead of mutating the passed-in array
   - Return `{ answer, messages: internalMessages.slice(inputLength) }` — the new messages only
7. Update `orchestrator.ts` to use the returned messages from `runAgent` instead of the `.slice()` trick
8. Update any tests that depend on `runAgent`'s mutation behavior or return type
9. Verify all tests pass

## Testing scenarios

- Unit: import `randomSessionId` from `src/utils/id.ts`, confirm it returns a valid UUID
- Unit: confirm `logging/index.ts` does not export `randomSessionId`
- Integration: call `runAgent` with a messages array, confirm the input array is not mutated after the call
- Integration: confirm `runAgent` return value contains the new messages produced during the run
- E2E: run `bun run agent "test prompt"` and verify logs are written correctly with proper session IDs
