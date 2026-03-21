# SP-40 Purify utils — absorb impure functions into domain services

## Main objective

Eliminate singleton imports from `src/utils/` by moving impure functions into
the domain services that own their context, leaving utils as pure, dependency-free
functions only.

## Context

Most util modules import singletons directly (`files`, `config`, `getSessionId`)
instead of receiving dependencies. This makes them untestable in isolation and
couples every consumer to global state. A utility that imports a singleton service
is a service in disguise.

**Current state of utils with singleton deps:**

| File | Singletons imported | Impure functions |
|------|---------------------|------------------|
| `utils/output.ts` | `files`, `config`, `getSessionId` | `ensureOutputDir()`, `outputPath()`, `toSessionPath()`, `resolveSessionPath()`, `getEffectiveSessionId()` |
| `utils/parse.ts` | `files`, `config` | `resolveInput()`, `checkFileSize()` |
| `utils/document.ts` | `getSessionId` | `createDocument()`, `createErrorDocument()` |
| `utils/csv.ts` | `files` | `parseCsv()`, `writeCsv()` |
| `utils/hub-fetch.ts` | `config` | `hubPost()` |

**Already pure (no changes needed):** `xml.ts`, `timing.ts`, `media-types.ts`.

**Target service architecture (6 canonical services):**

- `documentService` — document lifecycle (create, store, query)
- `fileService` — sandboxed file I/O, size checks
- `sessionService` — session state, output paths, session-scoped dirs
- `promptService` — prompt loading and rendering (already clean)
- `completionService` — LLM calls (rename from `llm`)
- `assistantService` — assistant resolution (already exists)

## Out of scope

- Refactoring `promptService`, `assistantService`, or `completionService` — they
  already follow the factory pattern or are being addressed separately
- Changing the `config` singleton itself — it's immutable (`deepFreeze`) and
  acceptable as a global constant
- Refactoring tools or the agent loop — only update their imports
- Adding new functionality — this is a pure structural move

## Constraints

- Zero behavior change — all existing tests must pass after the move
- Every service keeps the `createXService()` factory + `export const xService`
  singleton pattern (same as `sessionService`, `documentService` today)
- `hubPost()` stays in utils but becomes pure — accept timeout as a parameter
  instead of importing `config`
- No barrel re-exports from old locations — clean break, update all imports
- The `_testReadPaths` / `_testWritePaths` hack in `file.ts` should be replaced
  by using `createBunFileService(customPaths)` in tests

## Acceptance criteria

- [ ] `utils/output.ts` deleted — all functions moved to `sessionService`
- [ ] `utils/document.ts` deleted — `createDocument()` and `createErrorDocument()`
      moved to `documentService` (merged with existing document-store)
- [ ] `utils/csv.ts` deleted — all functions (`parseCsv`, `writeCsv`, `toCsvLine`)
      removed entirely, not relocated
- [ ] `utils/parse.ts` retains only pure functions (`safeParse`, `safeFilename`,
      `validateKeys`, `assertMaxLength`, `assertNumericBounds`); `resolveInput()`
      and `checkFileSize()` moved to `fileService`
- [ ] `utils/hub-fetch.ts` — `hubPost()` parameterized (timeout as arg), no
      singleton imports remain. `HUB_DOC_META` and `stringify()` stay as-is (pure)
- [ ] No file in `src/utils/` imports any singleton (`files`, `config`,
      `getSessionId`)
- [ ] `_testReadPaths` / `_testWritePaths` removed from `file.ts`; tests use
      `createBunFileService()` with explicit paths
- [ ] All existing tests pass (`bun test`)
- [ ] All tool and agent imports updated — no dangling references

## Implementation plan

1. **Expand `documentService`** — merge `createDocument()` and
   `createErrorDocument()` from `utils/document.ts` into
   `services/common/document-store.ts`. `createDocument()` takes `sessionId` as
   an explicit parameter instead of calling `getSessionId()`. Delete
   `utils/document.ts`. Update `formatDocumentXml` / `formatDocumentsXml` — these
   are pure formatters, move to utils or keep alongside the service.

2. **Expand `fileService`** — add `checkFileSize()` and `resolveInput()`
   as methods on the object returned by `createBunFileService()`. These methods
   use `this` context for file I/O instead of importing the singleton. Remove
   `_testReadPaths` / `_testWritePaths`; tests call
   `createBunFileService(tempPaths)` directly. Strip `resolveInput()` and
   `checkFileSize()` from `utils/parse.ts`. Delete `utils/csv.ts` entirely
   (all CSV functions removed, not relocated).

3. **Expand `sessionService`** — absorb `outputPath()`, `ensureOutputDir()`,
   `toSessionPath()`, `resolveSessionPath()` from `utils/output.ts`. These
   methods receive `fileService` and `config.paths` via the factory closure
   rather than importing singletons. Delete `utils/output.ts`.

4. **Purify `hubPost()`** — change signature to accept `timeout` as a parameter
   (with a sensible default). Remove `config` import from `utils/hub-fetch.ts`.
   Callers pass `config.limits.fetchTimeout` at the call site.

5. **Update all consumers** — grep for every import from the deleted/changed
   util files. Update tool files, agent.ts, and any other importers to use
   the new service methods.

6. **Update `utils/index.ts`** barrel — remove deleted modules, keep only
   pure re-exports.

7. **Fix tests** — update test imports. Replace `_testReadPaths` mutation with
   `createBunFileService()` factory calls. Verify `bun test` passes.

## Testing scenarios

- **Pure util isolation**: import `safeParse`, `safeFilename`, etc. from
  `utils/parse.ts` — no setup needed, no singletons touched
- **documentService.createDocument()**: call with explicit `sessionId` param,
  verify metadata contains it. No AsyncLocalStorage setup required.
- **fileService.checkFileSize()**: create via `createBunFileService([tmpDir])`,
  call `checkFileSize()` on the instance — works without global config
- **CSV removal**: verify no remaining imports of `parseCsv`, `writeCsv`, or
  `toCsvLine` anywhere in the codebase
- **sessionService.outputPath()**: verify session-scoped path generation using
  injected config paths, no global `getSessionId()` call
- **hubPost()**: verify it uses the passed timeout, not a config import
- **No singleton leaks**: static analysis — grep `src/utils/` for imports of
  `files`, `config`, `getSessionId` — expect zero matches
- **Integration**: `bun test` — all existing tests pass unchanged or with
  updated imports only