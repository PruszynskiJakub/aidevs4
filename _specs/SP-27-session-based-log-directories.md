# SP-27 Session-based log directories

## Main objective

Organize agent logs into a `date/sessionId/` directory hierarchy so that all runs belonging to the same session are co-located and logs are grouped by day.

## Context

Logs are currently flat Markdown files in `logs/` named `log_YYYY-MM-DD_HH-mm-ss.md`. Each `runAgent()` call creates a new file regardless of session. Sessions already exist in the codebase (`src/services/session.ts`) with a string `id`, but there is no link between sessions and log files. When debugging a multi-turn conversation it's impossible to tell which log files belong to the same session.

The target directory structure:

```
logs/
  2026-03-17/                       ← date folder (one per day)
    {sessionId}/                    ← session folder (from HTTP server or CLI --session)
      log_10-15-30.md               ← individual run log (time-only)
      log_14-22-05.md
    {randomId}/                     ← auto-generated ID when no session specified
      log_11-00-00.md
  2026-03-18/
    ...
```

CLI usage:
```bash
bun run agent "prompt"                    # new random session
bun run agent "prompt" --session abc123   # continue existing session
```

## Out of scope

- Log rotation, cleanup, or retention policies
- Changing the Markdown log format or content
- Persisting sessions to disk (they remain in-memory)
- Log search or indexing
- Structured/JSON logging

## Constraints

- Must not break existing `MarkdownLogger` append/flush semantics
- CLI supports `--session <id>` flag to continue an existing session; when omitted, a random 8-char hex ID is generated
- Directory creation must be lazy (create on first write, not eagerly)
- Log filenames inside session folders use time-only: `log_HH-mm-ss.md` (date is already in the parent folder)
- No new dependencies

## Acceptance criteria

- [ ] Log files are written to `logs/{YYYY-MM-DD}/{sessionId}/log_HH-mm-ss.md`
- [ ] HTTP server passes the session ID to `runAgent()` and it propagates to `MarkdownLogger`
- [ ] CLI accepts `--session <id>` flag; logs go to that session's folder
- [ ] CLI runs without `--session` generate a random 8-char hex ID as the session folder
- [ ] Multiple `runAgent()` calls with the same session ID on the same day write to the same session folder
- [ ] `MarkdownLogger.filePath` reflects the new nested path
- [ ] Existing tests pass; new tests cover directory structure generation
- [ ] `CLAUDE.md` log path references are updated if needed

## Implementation plan

1. **Update `MarkdownLogger` constructor** to accept an optional `sessionId` parameter. Compute the log path as `{logsDir}/{date}/{sessionId}/log_{time}.md`. Create directories lazily on first `append()`.

2. **Generate fallback session ID** — when no `sessionId` is provided, generate an 8-char random hex string (e.g. `crypto.randomUUID().slice(0, 8)` or similar). This keeps CLI runs organized without requiring callers to always provide an ID.

3. **Parse `--session` flag in CLI entry point** (`src/agent.ts` lines 173+) — extract `--session <id>` from `process.argv`. Pass it as `sessionId` to `runAgent()`. Print the session ID to console on startup so the user can reuse it.

4. **Thread `sessionId` through `runAgent()`** — add an optional `sessionId` field to the agent options. `runAgent()` passes it to `MarkdownLogger`. Default: undefined (triggers random ID generation).

5. **Update `src/server.ts`** — pass the HTTP session's `id` into `runAgent()` options so server-originated runs use the real session ID.

6. **Update `createLogger()` in `src/services/logger.ts`** — if it constructs `MarkdownLogger`, pass through the session ID.

7. **Update log path in console output** — the agent currently logs the file path to console; ensure it reflects the new nested path.

8. **Update tests** — verify directory structure, session ID propagation, CLI flag parsing, and fallback random ID generation.

## Testing scenarios

- **Happy path (with session ID)**: Call `MarkdownLogger` with `sessionId="abc123"` on date `2026-03-17` → file is created at `logs/2026-03-17/abc123/log_HH-mm-ss.md`.
- **Fallback (no session ID)**: Call `MarkdownLogger` without `sessionId` → file is created at `logs/2026-03-17/{8-char-hex}/log_HH-mm-ss.md`.
- **Same session, multiple runs**: Create two `MarkdownLogger` instances with the same `sessionId` on the same day → both files are in the same session folder.
- **Cross-day session**: If a session spans midnight, each day's logs go into that day's date folder (same session ID, different date folders).
- **Server integration**: HTTP request with session ID → log file appears under that session's folder.
- **CLI without flag**: `bun run agent "prompt"` → log appears under a random-ID folder, session ID printed to console.
- **CLI with --session**: `bun run agent "prompt" --session abc123` → log appears under `abc123/` folder.
- **CLI with invalid --session**: `bun run agent "prompt" --session "../etc"` → rejected (path traversal).
