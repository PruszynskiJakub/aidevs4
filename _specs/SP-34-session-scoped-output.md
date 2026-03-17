# SP-34 Session-scoped output directories

## Main objective

Route all tool-generated files into `output/{sessionId}/{file_type}/{uuid}/{filename}` so every agent session has an isolated, browsable output folder.

## Context

SP-32 moved output to `output/{file_type}/{uuid}/{filename}`. This gives type-based grouping but no session awareness — files from different agent runs intermix, making it hard to find all artifacts from a single session or clean up after one.

Session ID already exists in `MarkdownLogger` (generated or passed via `--session`), but it never reaches `outputPath()` or the file service. Tools call `outputPath(filename)` which has no concept of the current session.

Key files:
- `src/utils/output.ts` — `outputPath()`, `ensureOutputDir()`, `inferFileType()`
- `src/config/index.ts` — `OUTPUT_DIR`, sandbox allowlists
- `src/services/file.ts` — write-path enforcement
- `src/agent.ts` — creates `MarkdownLogger` with sessionId, dispatches tools
- `src/tools/web.ts`, `src/tools/agents_hub.ts` — primary file-producing tools

## Out of scope

- Playground scripts — keep their local `playground/*/output/` dirs unchanged
- Log directory structure — stays at `logs/{date}/{sessionId}/`
- Migration of existing output files
- Session persistence or session metadata storage
- Changing tool schemas (LLM-facing API stays the same)

## Constraints

- Tools must not need to know or pass sessionId — injection is transparent via `outputPath()`
- **Concurrency-safe**: Multiple agent sessions may run in the same process simultaneously (e.g. via the Hono API server). A module-level singleton would cause sessions to overwrite each other's context. Use `AsyncLocalStorage` (Bun-native) to scope session context per async call chain.
- File service sandbox must be narrowed: once a sessionId is set, the allowed write path tightens from `output/` to `output/{sessionId}/` — tools cannot read or write files belonging to other sessions
- When no session context exists (e.g. standalone script using `outputPath()` outside an agent run), fall back to a generated UUID as sessionId so the function never breaks; sandbox stays at `output/` root in this case
- UUID-per-file subdirectory is kept for collision safety

## Acceptance criteria

- [ ] `outputPath(filename)` returns `output/{sessionId}/{file_type}/{uuid}/{filename}` and creates intermediate dirs
- [ ] Session context is stored in `AsyncLocalStorage`, not a module-level variable — safe for concurrent sessions in the same process
- [ ] A `runWithSession(sessionId, fn)` wrapper in a new `src/services/session-context.ts` runs `fn` inside an `AsyncLocalStorage` context
- [ ] `agent.ts` wraps the entire agent loop in `runWithSession(sessionId, async () => { ... })`
- [ ] `outputPath()` reads sessionId from `AsyncLocalStorage`; when called outside any session context, falls back to a generated UUID
- [ ] All existing tools (`web`, `agents_hub`, `bash`) work without changes — their `outputPath()` calls automatically route to the session folder
- [ ] File service sandbox is tightened: once sessionId is set, allowed write/read paths for output narrow to `output/{sessionId}/` only — tools cannot access other sessions' files
- [ ] Before sessionId is set (fallback mode), the sandbox allows the full `output/` root
- [ ] Existing tests pass; new tests cover session-scoped path generation and fallback behavior
- [ ] Running `bun run agent "download X"` places the file in `output/{sessionId}/...` where sessionId matches the one printed to console

## Implementation plan

1. **Create `src/services/session-context.ts`** — New service built on `AsyncLocalStorage`:
   - Store: `{ sessionId: string }`
   - Export `runWithSession(sessionId: string, fn: () => Promise<T>): Promise<T>` — runs `fn` inside the async context
   - Export `getSessionId(): string | undefined` — reads from current context, returns `undefined` if outside any session
   - Export `requireSessionId(): string` — like `getSessionId()` but throws if no session is active (for code that must never run outside a session)

2. **Update `outputPath()`** — Change path construction from `output/{file_type}/{uuid}/{filename}` to `output/{sessionId}/{file_type}/{uuid}/{filename}`. Call `getSessionId()` from session-context; if undefined, generate + cache a process-level fallback UUID (for standalone scripts).

3. **Wire sessionId in `agent.ts`** — Wrap the entire agent loop in `runWithSession(md.sessionId, async () => { ... })`. All tool dispatches happen inside this context, so `outputPath()` and the file service automatically see the correct sessionId.

4. **Tighten sandbox per-session** — The file service's `assertPathAllowed()` must be session-aware. When `getSessionId()` returns a value, dynamically narrow the allowed output write/read path from `output/` to `output/{sessionId}/`. This can be done by checking `getSessionId()` inside `assertPathAllowed()` itself — no need to mutate global allowlists. Read paths for output should also be narrowed.

5. **Update `bash` tool cwd** — The bash tool sets `cwd` to `config.paths.outputDir`. Change it to read from session context: `output/{sessionId}` when inside a session, falling back to `output/` otherwise. Use `getSessionId()` from session-context.

6. **Update tests** — Extend `output.test.ts` and add `session-context.test.ts`:
   - `runWithSession("test-session", () => outputPath("file.json"))` → returns `output/test-session/document/{uuid}/file.json`
   - `outputPath("file.json")` called outside any session → path contains a fallback UUID as session segment
   - Two concurrent `runWithSession` calls with different IDs → each sees its own sessionId (no cross-talk)
   - `inferFileType` tests unchanged (already covered)
   - File service rejects cross-session writes inside a `runWithSession` context

7. **Manual verification** — Run `bun run agent "download <url>"`, confirm file lands in `output/{sessionId}/...` and sessionId matches console output.

## Testing scenarios

- `runWithSession("abc-123", () => outputPath("result.json"))` → path matches `output/abc-123/document/{uuid}/result.json`, dir exists on disk
- `outputPath("photo.png")` called outside any session → path matches `output/{fallback-uuid}/image/{uuid}/photo.png`, fallback is stable across calls in same process
- **Concurrency**: Run two `runWithSession` calls in parallel (`sess-A` and `sess-B`), each calling `outputPath()` — each gets its own sessionId, no cross-contamination
- Inside `runWithSession("sess-A", ...)`, attempt `files.write("output/sess-B/document/x.json", data)` → rejected by sandbox
- Inside `runWithSession("sess-A", ...)`, attempt `files.readText("output/sess-B/document/x.json")` → rejected by sandbox
- Inside `runWithSession("sess-A", ...)`, `files.write("output/sess-A/document/x.json", data)` → succeeds
- Run `bun test` — all existing tests pass
- Run `bun run agent "download <url>"` — file appears under `output/{sessionId}/` matching the session printed to console
