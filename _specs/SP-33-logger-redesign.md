# SP-33 Logger Redesign

## Main objective

Redesign the dual-track logging system (console + markdown) to use a shared `Logger` interface, composite dispatch, and fix correctness issues (time zone mismatch, missing methods, unbounded payloads) — so both outputs stay in sync by construction, not by convention.

## Context

The current logging architecture was introduced in SP-08 (console) and SP-27 (markdown files). It works but has accumulated several problems:

**No shared contract.** `createLogger()` returns an object literal and `MarkdownLogger` is a class — both implement the same methods by convention. Adding a method to one without the other is a silent bug. The `Log` type alias (`ReturnType<typeof createLogger>`) gives no compile-time safety for `MarkdownLogger`.

**Manual forwarding.** Every method in `createLogger` calls `md?.method()` by hand. Four methods (`info`, `success`, `error`, `debug`) were never wired to the markdown logger, so those messages are lost from log files — contradicting the project guidance to "always check the latest log file."

**Time zone mismatch.** `dateFolder()` and `timeStamp()` use local time; `formatDate()` uses UTC via `toISOString()`. The folder name can disagree with the log header by hours.

**Unbounded markdown payloads.** The console logger truncates tool results to 120 chars, but the markdown logger writes the full raw JSON with pretty-print. Long-running sessions produce oversized files.

**No log levels.** Every message goes to stdout regardless of verbosity. No way to suppress debug output in production or focus on errors during debugging.

**No flush guarantee.** Nothing ensures `md.flush()` runs before process exit. The `catch(() => {})` in `append` silently drops write errors.

**Misleading API.** `duration(startMs)` takes `performance.now()` values, not epoch milliseconds — the parameter name misleads callers.

### Current consumers

- `src/agent.ts` — creates `MarkdownLogger`, passes it to `createLogger(md)`, uses the returned logger throughout the agent loop, calls `md.flush()` on completion.
- `src/server.ts` — imports the `log` singleton (console-only, no markdown).
- `duration()` is called 4 times in `agent.ts` for timing LLM calls, tool execution, and batch completion.

## Out of scope

- Structured JSON line logging (future enhancement, not this spec)
- External observability integration (OpenTelemetry, etc.)
- Log rotation or cleanup of old log files
- Changes to log directory structure (SP-27) or session ID format (SP-30)
- Changes to `FileProvider` or `file.ts`

## Constraints

- No new runtime dependencies — Bun built-ins and existing services only
- Must not alter data flowing through the agent loop (tool results, message history)
- Must not break existing tests in `logger.test.ts` and `markdown-logger.test.ts` — update them to match new API
- `MarkdownLogger` must continue using `FileProvider` for all I/O
- Keep backward compatibility for the `log` singleton export used by `server.ts`

## Acceptance criteria

- [ ] A `Logger` interface exists in `src/types/logger.ts` defining all log methods (step, llm, plan, toolHeader, toolCall, toolOk, toolErr, batchDone, answer, maxIter, info, success, error, debug)
- [ ] Both `ConsoleLogger` and `MarkdownLogger` implement the `Logger` interface — compiler enforces method parity
- [ ] A `CompositeLogger` class implements `Logger` by delegating to an array of `Logger` targets — no manual `md?.method()` forwarding
- [ ] `info`, `success`, `error`, `debug` are logged to markdown files (currently missing)
- [ ] `ConsoleLogger` accepts a `level` option (`debug | info | warn | error`) and suppresses output below threshold
- [ ] All timestamps in `MarkdownLogger` use UTC consistently — folder names, file names, and header timestamps all derive from the same UTC source
- [ ] Tool results in markdown are truncated when exceeding a configurable limit (default 10 KB); oversized results are written to a sidecar file with a markdown link
- [ ] `MarkdownLogger` registers a `beforeExit` handler to auto-flush pending writes
- [ ] `duration()` is renamed to `elapsed()` with parameter renamed to `startPerfNow` for clarity
- [ ] Truncation lengths in `ConsoleLogger` are configurable via constructor options (not hardcoded)
- [ ] The `log` singleton remains exported for backward compatibility, typed as `Logger`
- [ ] `agent.ts` uses `new CompositeLogger([consoleLogger, markdownLogger])` instead of `createLogger(md)`
- [ ] All existing tests updated; no test regressions

## Implementation plan

1. **Define the `Logger` interface** in `src/types/logger.ts`
   - All 14 methods with their current signatures
   - Export the interface

2. **Create `ConsoleLogger` class** in `src/services/console-logger.ts`
   - Implements `Logger`
   - Constructor: `{ level?: LogLevel; truncateArgs?: number; truncateResult?: number }`
   - Move ANSI constants, `truncate`, `formatVal`, `summarizeArgs`, `summarizeResult`, `tokenSuffix` into this file as private helpers
   - Implement `info`, `success`, `error`, `debug` (already exist) and all agent-loop methods (moved from `createLogger`)
   - Filter output based on `level`

3. **Refactor `MarkdownLogger`** in `src/services/markdown-logger.ts`
   - Add `implements Logger` to the class declaration
   - Add `info`, `success`, `error`, `debug` methods (append as simple markdown lines)
   - Fix timestamps: create a `utcTimestamp()` helper returning `{ folder, stamp, display }` — all derived from `new Date().toISOString()`
   - Add size guard to `toolOk`: if `rawResult.length > MAX_INLINE_SIZE` (default 10240), write to sidecar `{sessionDir}/{tool}_{timestamp}.json` and link from the log
   - Register `process.on("beforeExit", () => this.flush())` in constructor
   - Keep `flush()`, `filePath`, `sessionId` public API unchanged

4. **Create `CompositeLogger`** in `src/services/composite-logger.ts`
   - Implements `Logger`
   - Constructor: `(targets: Logger[])`
   - Each method iterates `targets` and calls the corresponding method
   - Export class

5. **Rename `duration()` to `elapsed()`**
   - In `src/services/logger.ts` (or move to a small `src/utils/timing.ts`)
   - Rename parameter to `startPerfNow`
   - Update all 4 call sites in `agent.ts` and test

6. **Rewire `logger.ts`**
   - Remove `createLogger` function and the object literal
   - Export `log` singleton as `new ConsoleLogger()` typed as `Logger`
   - Re-export `elapsed` (previously `duration`) for backward compat
   - Keep `Log` type alias pointing to `Logger` interface for any external consumers

7. **Update `agent.ts`**
   - Replace `createLogger(md)` with `new CompositeLogger([new ConsoleLogger(), md])`
   - Replace `duration()` calls with `elapsed()`
   - Remove manual `md.flush()` if `beforeExit` hook is sufficient, or keep as belt-and-suspenders

8. **Update tests**
   - `logger.test.ts` → test `ConsoleLogger` directly, verify level filtering
   - `markdown-logger.test.ts` → verify `info/success/error/debug` produce output, verify UTC consistency, verify sidecar file creation for large payloads, verify `beforeExit` registration
   - Add `composite-logger.test.ts` → verify delegation to all targets

## Testing scenarios

- **Interface compliance**: TypeScript compiler confirms both `ConsoleLogger` and `MarkdownLogger` satisfy `Logger` — a missing method is a build error
- **CompositeLogger delegation**: create two mock `Logger` objects, wrap in `CompositeLogger`, call each method, assert both mocks received the call with correct args
- **Log level filtering**: create `ConsoleLogger({ level: "warn" })`, call `debug()` and `info()`, capture stdout, assert nothing printed; call `error()`, assert output present
- **UTC consistency**: create `MarkdownLogger`, inspect `filePath` — folder and filename should contain UTC date/time components that match
- **Sidecar for large payloads**: call `toolOk()` with a 20 KB result string, assert the markdown log contains a link (not inline JSON) and a sidecar `.json` file was written
- **Auto-flush on exit**: verify `beforeExit` listener is registered after `MarkdownLogger` construction
- **Backward compatibility**: import `log` and `elapsed` from `logger.ts`, verify they work as before (types + runtime)
- **info/success/error/debug in markdown**: call each on `MarkdownLogger`, flush, read file, assert content present
- **agent.ts integration**: run agent with mock LLM, verify both console output and markdown file contain the same set of events
