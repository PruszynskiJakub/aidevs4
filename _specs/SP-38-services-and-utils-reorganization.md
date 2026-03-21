# SP-38 Services & Utils Reorganization

## Main objective

Unify every service to the `createXService()` + `export const` singleton pattern, fix structural issues (broken index, missing barrel exports), and clean up dead code.

## Context

- **Inconsistent service patterns**: some use factory+singleton (`promptService`, `sessionService`), some are class instances (`log`), some are plain objects (`assistants`).
- **Structural bugs**: `src/services/index.ts` references `./session/index.ts` which doesn't exist (should be `./agent/index.ts`).
- **Missing barrel**: `src/utils/` has no `index.ts`.
- **Dead code**: `hub.ts` is a trivial one-liner wrapping `config.aiDevsApiKey`.
- **Unused class**: `DocumentStore` exists but is never instantiated outside tests.

## Out of scope

- Changing tool implementations (tools will just update their import paths)
- Modifying the agent loop (`agent.ts`) behavior
- Changing prompt files or assistant YAML configs
- Refactoring logging internals (ConsoleLogger, MarkdownLogger, CompositeLogger stay as composable classes)
- Adding new functionality — this is purely organizational

## Constraints

- Every import path change must compile (`bun build` / `tsc --noEmit`)
- All existing tests must pass after reorganization
- Singleton pattern: `createXService()` factory + `export const xService = createXService()` — consistently applied to all non-session-scoped services
- Session-scoped services (session-context) keep their current AsyncLocalStorage pattern
- No changes to external API (tool schemas, HTTP endpoints)

## Acceptance criteria

- [ ] Every service follows the `createXService(deps?) → { methods }` + `export const xService` pattern (except loggers which remain composable classes, and session-context which uses AsyncLocalStorage)
- [ ] `src/services/index.ts` correctly references all subdirectory barrels (fix `./session/` → `./agent/`)
- [ ] `src/utils/index.ts` barrel file exists and re-exports all utils
- [ ] `hub.ts` is deleted; call sites inline `config.aiDevsApiKey` or similar
- [ ] `DocumentStore` is converted to a functional `documentService` singleton (`createDocumentService()`) holding a `Map` of documents
- [ ] All imports across the codebase are updated — no broken references
- [ ] `bun test` passes with no regressions
- [ ] Service subdirectory grouping is logical: `common/`, `ai/`, `agent/` (add new subdirs only if needed)

## Implementation plan

1. **Fix the broken barrel** — `src/services/index.ts`: change `./session/index.ts` → `./agent/index.ts`

2. **Delete `hub.ts`** — replace its single usage (`getApiKey()`) with direct `config.aiDevsApiKey` at call sites

3. **Convert DocumentStore to documentService** — refactor `src/services/common/document-store.ts`:
   - Wrap in `createDocumentService()` factory returning `{ add, get, list, remove, findByMetadata }`
   - Export `const documentService = createDocumentService()`
   - Update `common/index.ts` to export it

4. **Add `src/utils/index.ts` barrel** — re-export all utils (`output`, `parse`, `csv`, `document`, etc.)

5. **Unify existing service patterns** to `createXService()`:
   - `services/common/file.ts` — already has `createBunFileService()` + `files` singleton ✓
   - `services/ai/prompt.ts` — already has `createPromptService()` + `promptService` ✓
   - `services/ai/llm.ts` — wrap the provider registry setup in `createLlmService()`, export `const llm = createLlmService()`
   - `services/agent/session.ts` — already has `createSessionService()` + `sessionService` ✓
   - `services/agent/assistant/assistants.ts` — wrap in `createAssistantsService()`, export `const assistantsService`
   - `services/agent/assistant/assistant-resolver.ts` — wrap in `createAssistantResolverService()`, export `const assistantResolverService`
   - Logging classes stay as-is (composable pattern is appropriate)

6. **Update barrel files** — ensure `services/common/index.ts`, `services/ai/index.ts`, `services/agent/index.ts`, and `services/index.ts` export everything correctly.

7. **Run `bun test`** and fix any failures.

## Testing scenarios

- `bun test` — all existing tests pass
- `tsc --noEmit` or `bun build` — no type errors from broken imports
- Verify `documentService.add()` / `.get()` / `.remove()` work via existing DocumentStore tests (updated imports)
