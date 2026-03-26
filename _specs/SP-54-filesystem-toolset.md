# SP-54 Filesystem Toolset

## Main objective

Replace reliance on the monolithic `bash` tool for file operations with five
dedicated filesystem tools (`read_file`, `write_file`, `edit_file`, `glob`,
`grep`) and harden the `bash` tool signature — enabling agentic RAG over the
local filesystem while reducing shell attack surface.

## Context

Today the agent has one way to interact with files: the `bash` tool. It shells
out to `grep`, `cat`, `find`, etc. This is fragile (LLM must compose valid
shell commands), hard to sandbox (regex-based redirect detection), and opaque
(no structured output). The architecture audit flags "RAG is Static, Not
Agentic" as a High severity gap — the agent cannot autonomously search,
iterate, and build knowledge over files.

The file service (`src/infra/file.ts`) already provides sandboxed primitives
(`readText`, `readdir`, `write`, `stat`, `exists`, `mkdir`). The new tools
wrap these primitives with input validation, structured output, and
LLM-friendly schemas. Bun provides built-in `Bun.Glob` for pattern matching.

Existing tools follow a well-established pattern: `ToolDefinition` interface,
`Document` return type, `createDocument` factory, registration via
`src/tools/index.ts`, OpenAI strict-mode JSON schemas.

## Out of scope

- Vector store or embedding-based search — filesystem search is sufficient for
  current tasks
- Binary file reading (images, PDFs) — remains in `document_processor`
- Modifying the `FileProvider` interface or file service internals
- MCP server integration
- Sub-agent spawning or multi-agent file sharing

## Constraints

- **Sandboxing delegated to file service**: all path access goes through
  `files.*` methods (`src/infra/file.ts`) which enforce `allowedReadPaths`
  and `allowedWritePaths` via `assertPathAllowed`. Tools do NOT implement
  their own sandbox logic — they validate input shape, then delegate.
- **OpenAI strict mode**: all schema properties in `required`, no `oneOf` /
  `anyOf` / type arrays, `additionalProperties: false` on every object.
- **Pure JS grep**: no shelling out to ripgrep or system grep. Use `Bun.Glob`
  for file enumeration + `RegExp` for line matching. Zero external dependencies.
- **Async file enumeration**: use `Bun.Glob.scan()` (async iterator), not
  `scanSync()`, to avoid blocking the event loop on large directories.
- **File size limit**: 10 MB (`config.limits.maxFileSize`) enforced on all
  read operations.
- **Output caps**: glob returns max 500 paths; grep returns max 200 matching
  lines across max 50 files. Truncation is noted in response.
- **No tool-to-tool coupling**: hints describe capabilities, never reference
  tool names.

## Acceptance criteria

- [ ] `read_file` tool reads text files with line numbers, supports
      `offset`/`limit` for pagination, enforces path sandbox
- [ ] `write_file` tool creates/overwrites files in session output dir,
      auto-creates parent directories
- [ ] `edit_file` tool performs exact string replacement with uniqueness
      check, supports `replace_all` flag
- [ ] `glob` tool finds files by pattern using async `Bun.Glob.scan()`,
      returns paths sorted alphabetically, caps at 500 results
- [ ] `grep` tool searches file contents by regex (pure JS), returns
      `file:line:content` format, caps at 200 lines / 50 files
- [ ] `bash` tool gains `description` (string, logged) and `timeout`
      (integer, enforced, clamped 1000–120000 ms) parameters; schema
      description steers LLM away from file operations
- [ ] All six tools registered in `src/tools/index.ts`
- [ ] All tools validate input (max length, empty strings, path traversal,
      prototype pollution) per `_aidocs/tools_standard.md`
- [ ] All tools return `Document` via `createDocument` with appropriate
      metadata (`source`, `type`, `mimeType`)
- [ ] Test file for each new tool covers: happy path, malformed input,
      boundary values, injection attempts
- [ ] `_specs/filesystem-tools.md` (old rough draft) deleted

## Implementation plan

### 1. Implement `read_file`

**File**: `src/tools/read_file.ts`
**Schema**: `src/schemas/read_file.json`

```
Parameters: file_path (string), offset (integer), limit (integer)
```

Handler:
1. Validate `file_path` — `assertMaxLength(1024)`, reject empty.
2. `files.checkFileSize(file_path)` — reject >10 MB (also triggers
   sandbox check via file service).
3. Read via `files.readText(file_path)`, split into lines.
4. Apply `offset` (1-based, default 1) and `limit` (default 2000). Clamp
   offset to `[1, totalLines]`. If offset > totalLines, return informative
   message.
5. Format with line numbers: `"  {n}\t{line}"` (cat -n style).
6. Return Document — description includes line range and total.
7. Hint: `"\nNote: Adjust offset/limit to read other sections, or search
   within the file for specific content."`

### 2. Implement `glob`

**File**: `src/tools/glob.ts`
**Schema**: `src/schemas/glob.json`

```
Parameters: pattern (string), path (string)
```

Handler:
1. Validate `pattern` — `assertMaxLength(512)`, reject empty.
2. Validate `path` — `assertMaxLength(1024)`, default to session output
   dir. Verify directory exists via `files.stat(path)`.
3. Use async `Bun.Glob(pattern).scan({ cwd: path, absolute: true })`.
4. Collect results alphabetically (no stat per file — avoids O(n) syscalls).
5. Cap at 500 entries. Note truncation if hit.
6. Return Document with one path per line, plus total count.
7. Hint: `"\nNote: Read any matched file for full contents, or narrow the
   pattern to reduce results."`

### 3. Implement `grep`

**File**: `src/tools/grep.ts`
**Schema**: `src/schemas/grep.json`

```
Parameters: pattern (string), path (string), include (string)
```

Handler:
1. Validate `pattern` — `assertMaxLength(512)`, reject empty. Construct
   `new RegExp(pattern)` in try-catch — throw `"Invalid regex"` on failure.
2. Validate `path` — default to session output dir. Verify exists.
3. Validate `include` — glob filter for file types (e.g. `"*.ts"`),
   default `"*"`. Document this default in schema description so the LLM
   knows what to pass when searching all files.
4. Enumerate files via async `Bun.Glob(include).scan({ cwd: path })`.
5. For each file: check size via `files.checkFileSize()`, skip >10 MB.
   Read text, split lines, test each against regex. Bail out of a file
   after 20 matches (per-file cap) to avoid reading entire large files.
   Collect matches as `"{file}:{lineNum}: {line}"`.
6. Stop at 50 files with matches or 200 total matching lines (whichever
   first). Note truncation.
7. Return Document with matches.
8. Hint: `"\nNote: Read any matched file for full context around the
   matches, or refine the pattern to narrow results."`

### 4. Implement `write_file`

**File**: `src/tools/write_file.ts`
**Schema**: `src/schemas/write_file.json`

```
Parameters: file_path (string), content (string)
```

Handler:
1. Validate `file_path` — `assertMaxLength(1024)`, reject empty.
2. Auto-create parent dirs via `files.mkdir(dirname(file_path))`.
3. Write via `files.write(file_path, content)` (file service enforces
   write sandbox).
4. Return Document: `"Wrote {bytes} bytes to {file_path}"`.
5. Hint: `"\nNote: Verify contents or process the file further."`

### 5. Implement `edit_file`

**File**: `src/tools/edit_file.ts`
**Schema**: `src/schemas/edit_file.json`

```
Parameters: file_path (string), old_string (string), new_string (string),
            replace_all (boolean)
```

Handler:
1. Validate inputs — `assertMaxLength` on all strings (64 KB max). Reject
   empty `old_string`. Reject `old_string === new_string`.
2. Read file via `files.readText(file_path)` (file service enforces
   read sandbox).
3. Verify `old_string` exists. If not found, throw with brief context.
4. If `replace_all` is false: count occurrences. If >1, throw with count
   and instruct to provide more context or use `replace_all`.
5. Replace: first occurrence (default) or all (`replaceAll`).
6. Write back via `files.write(file_path, result)` (file service enforces
   write sandbox).
7. Return Document: `"Edited {file_path}: replaced {n} occurrence(s)."`.

Note: read-then-write is not atomic. This is acceptable because files in
the session output dir are only written by the agent within a single
turn — no concurrent writers.

### 6. Modify `bash`

**File**: `src/tools/bash.ts` (modify existing)
**Schema**: `src/schemas/bash.json` (modify existing)

Add two parameters:
- `description` (string, required) — logged for audit, not executed.
- `timeout` (integer, required) — enforced via Bun shell `.timeout(ms)`.
  Clamped to `[1000, 120000]`. Schema description should state
  `"Defaults to 30000 (30s)"` so the LLM knows what to pass.

Update schema description to steer LLM toward dedicated file tools.

### 7. Register all tools

In `src/tools/index.ts`, add imports and `register()` calls for all five
new tools.

### 8. Write tests

One test file per tool in `src/tools/`:
- `read_file.test.ts`
- `write_file.test.ts`
- `edit_file.test.ts`
- `glob.test.ts`
- `grep.test.ts`
- Update `bash.test.ts` for new parameters.

Each covers: happy path, malformed input, boundary values, path traversal
attempts, prototype pollution.

### 9. Clean up

Delete `_specs/filesystem-tools.md` (superseded by this spec).

## Testing scenarios

| Criterion | Test |
|-----------|------|
| read_file reads with line numbers | Read a known file, verify `"  1\t..."` format and correct content |
| read_file offset/limit | Read lines 5-10 of a 20-line file, verify only those lines returned |
| read_file path sandbox | Attempt to read `/etc/passwd` or file outside allowed paths — expect error |
| write_file creates file | Write to new path, verify file exists with correct content |
| write_file auto-mkdir | Write to `a/b/c/file.txt`, verify nested dirs created |
| write_file sandbox | Attempt to write outside session output — expect error |
| edit_file single replace | File with one "foo", replace with "bar", verify content |
| edit_file uniqueness check | File with two "foo", `replace_all: false` — expect error with count |
| edit_file replace_all | File with three "foo", `replace_all: true` — all replaced |
| edit_file not found | `old_string` absent from file — expect descriptive error |
| glob finds files | Create known files, glob for `"*.txt"`, verify all returned |
| glob alphabetical sort | Verify results are sorted alphabetically |
| glob cap at 500 | Directory with >500 files — verify truncation note in output |
| glob sandbox | Glob with path outside allowed dirs — expect error |
| grep finds matches | Files with known content, grep regex, verify `file:line:content` format |
| grep invalid regex | Pass `"[invalid"` — expect `"Invalid regex"` error |
| grep per-file cap | File with 50 matches — verify only 20 collected from that file |
| grep total cap | >200 matches across files — verify truncation note |
| grep respects include | Files of mixed types, `include: "*.ts"` — only .ts files searched |
| bash timeout | Command that sleeps 5s with `timeout: 2000` — expect timeout error |
| bash description logged | Verify description param accepted (does not affect execution) |
| All tools: empty string | Pass empty `file_path` / `pattern` — expect validation error |
| All tools: path traversal | Pass `"../../etc/passwd"` — expect sandbox error |
| All tools: prototype pollution | Pass `__proto__` in args — expect rejection |
