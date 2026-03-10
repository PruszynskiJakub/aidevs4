# SP-04 File Service Sandbox

## Main objective

Harden the `files` service with configurable read/write allowlists so every
filesystem operation is validated against permitted directories — making the
service the single, sandboxed source of truth for all production file I/O.

## Context

`src/services/file.ts` already abstracts Bun-specific APIs behind a
`FileProvider` interface, and all production tools correctly import the `files`
singleton. However, nothing prevents a tool from reading or writing arbitrary
paths — the service happily operates on any location.

The codebase already centralises output paths via `src/utils/output.ts`
(`ensureOutputDir`, `outputPath`), and `OUTPUT_DIR` lives in `src/config.ts`.
This spec builds on that by adding path-level enforcement inside the service
itself.

## Out of scope

- Playground scripts — they are throwaway prototypes and may use raw `fs` / `Bun`
  APIs freely.
- Test files (`*.test.ts`) — test setup/teardown may use raw `fs/promises` for
  temp dirs and fixtures.
- Changing the `FileProvider` interface shape beyond what's needed for sandbox
  errors.
- Network I/O or non-filesystem sandboxing.

## Constraints

- No new runtime dependencies — use only `node:path` (`resolve`, `normalize`)
  and existing Bun / Node APIs.
- Path validation must use `path.resolve()` to canonicalize, then verify the
  resolved path starts with an allowed directory. This prevents `../` traversal.
- Allowlists are defined in `src/config.ts` — no env vars, no external config
  files.
- Error messages must clearly state: the denied path, the operation attempted
  (read / write), and which directories are allowed.
- Zero breaking changes to existing tool code — tools already use `files.*` and
  write to `OUTPUT_DIR`, so they should keep working without modification.

## Acceptance criteria

- [ ] `src/config.ts` exports `ALLOWED_READ_PATHS: string[]` and
      `ALLOWED_WRITE_PATHS: string[]` with sensible defaults (read: project root;
      write: `OUTPUT_DIR`).
- [ ] Every `FileProvider` method validates the target path before executing:
      read-family methods (`readText`, `readJson`, `readdir`, `stat`) check
      against `ALLOWED_READ_PATHS`; write-family methods (`write`, `mkdir`)
      check against `ALLOWED_WRITE_PATHS`.
- [ ] Validation uses `path.resolve()` to canonicalize the incoming path, then
      checks that the resolved path starts with at least one allowed directory
      (also resolved).
- [ ] On violation, the service throws an `Error` with a message like:
      `Access denied: cannot <read|write> "<path>". Allowed <read|write> directories: [<list>]`.
- [ ] All existing tools and utils pass without code changes (they already
      operate within allowed directories).
- [ ] Unit tests cover: allowed read, denied read, allowed write, denied write,
      `../` traversal attempt, and edge case of exact-boundary path.

## Implementation plan

1. **Add allowlists to `src/config.ts`**
   - `ALLOWED_READ_PATHS` defaults to `[PROJECT_ROOT]` (derive from
     `import.meta.dir` going up to the repo root).
   - `ALLOWED_WRITE_PATHS` defaults to `[OUTPUT_DIR]`.
   - Export a `PROJECT_ROOT` constant as well.

2. **Create a path guard utility**
   - Add a function (e.g. `assertPathAllowed(path, allowedDirs, operation)`) in
     `src/services/file.ts` (private) or a small helper.
   - Uses `path.resolve()` on both the incoming path and each allowed dir.
   - If no allowed dir is a prefix of the resolved path, throw with the
     prescribed error message.

3. **Wire the guard into `createBunFileService()`**
   - Before each underlying call (`Bun.file`, `Bun.write`, `readdir`, `stat`,
     `mkdir`), call `assertPathAllowed` with the appropriate allowlist.
   - Read ops → `ALLOWED_READ_PATHS`, write ops → `ALLOWED_WRITE_PATHS`.

4. **Verify existing tools still work**
   - Run `bun test` — all green.
   - Run `bun run agent "test"` smoke test if applicable.

5. **Add unit tests for the sandbox**
   - Test file: `src/services/file.test.ts`.
   - Cases: allowed read, denied read, allowed write, denied write, `../`
     traversal, boundary path (allowed dir itself vs sibling with same prefix).

## Testing scenarios

| # | Scenario | Verify |
|---|----------|--------|
| 1 | Read a file inside `PROJECT_ROOT` | Resolves and returns content normally |
| 2 | Read a file outside all allowed dirs (e.g. `/etc/passwd`) | Throws `Access denied: cannot read "/etc/passwd"…` |
| 3 | Write a file inside `OUTPUT_DIR` | Writes successfully |
| 4 | Write a file outside `OUTPUT_DIR` (e.g. `/tmp/evil.txt`) | Throws `Access denied: cannot write "/tmp/evil.txt"…` |
| 5 | Read with `../` traversal (e.g. `<project>/src/../../etc/passwd`) | Resolves to `/etc/passwd`, throws access denied |
| 6 | Boundary: path `<project>_sibling/file` must not match `<project>` prefix | Correctly denied (prefix check uses trailing `/`) |
| 7 | Existing tool tests (`csv_processor`, `prompt`) | All pass unchanged |
