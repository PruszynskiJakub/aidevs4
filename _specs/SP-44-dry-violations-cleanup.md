# SP-44 DRY Violations Cleanup

## Main objective

Eliminate duplicated size-formatting logic and manual error-document XML construction to reduce maintenance surface and enforce existing abstractions.

## Context

Two DRY violations exist in the current codebase:

1. **Size formatting** — `(size / (1024 * 1024)).toFixed(1)` appears 4 times in `src/services/common/file.ts` (lines 105–106, 115–116), in `checkFileSize()` and `resolveInput()`. Each occurrence converts bytes to a human-readable MB string identically.

2. **Error document XML** — `src/agent.ts:155` manually constructs `<document id="error" ...>Error: ${errorMsg}</document>` instead of using the existing `createErrorDocument()` + `formatDocumentsXml()` from `src/services/common/document-store.ts`. The tools dispatcher (`src/tools/registry.ts:99,105,123`) already uses the proper abstraction correctly.

## Out of scope

- Architectural restructuring (covered by SP-43)
- Any other DRY issues not listed above
- Changes to the document-store API itself

## Constraints

- No new dependencies
- No changes to tool output format — the XML structure must remain identical
- `formatSizeMB` must be a pure function with no side effects

## Acceptance criteria

- [ ] A `formatSizeMB(bytes: number): string` utility exists and is used in all 4 occurrences in `file.ts`
- [ ] `src/agent.ts` uses `createErrorDocument()` + `formatDocumentsXml()` instead of manual XML string
- [ ] XML output from agent error handling is byte-identical to the current manual construction
- [ ] All existing tests pass (`bun test`)
- [ ] No new `toFixed(1)` calls with the `1024 * 1024` pattern exist in the codebase

## Implementation plan

1. Add `formatSizeMB(bytes: number): string` to `src/utils/parse.ts` (it already contains parsing/formatting utilities)
2. Replace all 4 occurrences in `src/services/common/file.ts` with calls to `formatSizeMB()`
3. In `src/agent.ts:155`, replace the manual XML template with `createErrorDocument(tc.function.name, errorMsg)` piped through `formatDocumentsXml()`
4. Verify XML output equivalence by comparing the string patterns
5. Run `bun test` to confirm no regressions

## Testing scenarios

- **Size formatting**: Unit test `formatSizeMB()` with 0, sub-MB, exact MB, and multi-GB values
- **Error document**: Existing agent/registry tests should pass unchanged. If no test covers the agent error path, add one that asserts the XML structure matches the document-store output format
- **Grep check**: Confirm no remaining `(size / (1024 * 1024)).toFixed` patterns in the codebase
