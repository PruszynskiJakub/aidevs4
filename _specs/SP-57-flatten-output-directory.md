# SP-57 Flatten output directory

## Main objective

Remove the `{mediaType}/{uuid}/` nesting from agent output paths and replace
the original filename with `{uuid}.{ext}`, so output files live flat under
`{agentName}/output/` while staying compatible with the Document abstraction.

## Context

Today `sessionService.outputPath(filename)` builds:

```
{sessionDir}/{agentName}/output/{mediaType}/{uuid}/{originalFilename}
```

This creates three unnecessary directory levels. The media-type grouping is
redundant because `Document.metadata.type` already carries it. The UUID
subdirectory exists only to isolate files with the same name across calls, but
renaming the file to `{uuid}.{ext}` achieves the same uniqueness without the
extra directory.

Target structure:

```
{sessionDir}/{agentName}/output/{uuid}.{ext}
```

`toSessionPath()` continues returning a relative path (e.g.
`default/output/{uuid}.{ext}`) for LLM context.

## Out of scope

- Removing the `{agentName}/` level — kept for multi-agent isolation
- Changing the Document abstraction itself (types, store, XML formatting)
- Migrating existing session data on disk

## Constraints

- Must preserve the original extension so MIME-type inference
  (`inferCategory()`) still works when reading files back
- `resolveSessionPath()` must still round-trip correctly with `toSessionPath()`
- File service sandbox assertions remain unchanged — output paths must still
  fall within the session directory
- Document `metadata.source` stores the absolute path; tools that reference
  files after writing must keep working

## Acceptance criteria

- [ ] `outputPath("report.pdf")` returns
      `{sessionDir}/{agentName}/output/{uuid}.pdf` (flat, UUID filename)
- [ ] `toSessionPath()` on that path returns `{agentName}/output/{uuid}.pdf`
- [ ] `resolveSessionPath()` inverts `toSessionPath()` correctly
- [ ] No `{mediaType}/` or `{uuid}/` subdirectory is created under `output/`
- [ ] Document metadata (`source`, `type`, `mimeType`) is unchanged
- [ ] All existing tool tests pass
- [ ] Agent end-to-end test: `bun run agent` with a download task writes files
      to the new flat structure

## Implementation plan

1. **Update `outputPath()` in `src/agent/session.ts`**
   - Remove `inferCategory()` directory level
   - Remove UUID subdirectory creation
   - Generate `{uuid}.{ext}` filename (extract extension from the input
     filename, generate UUID, combine)
   - Create `output/` directory (single `mkdir` instead of nested)
   - Return `join(outputDir, `${uuid}.${ext}`)`

2. **Update `toSessionPath()`** — verify it still strips correctly with the
   simpler path (should work as-is since it strips everything before
   `/{sessionId}/`)

3. **Update tests in `src/agent/session.test.ts`**
   - Adjust path assertions to match new flat structure
   - Verify UUID filename format
   - Verify no extra subdirectories are created

4. **Verify downstream consumers** — grep for `outputPath` and confirm tools
   (`web.ts`, `bash.ts`, `condense.ts`, etc.) don't depend on the directory
   structure beyond what `outputPath()` returns

## Testing scenarios

- **Unit**: `outputPath("image.png")` → path ends with
  `output/{uuid}.png`, parent dir is `output/`, no intermediate dirs
- **Unit**: `outputPath("file.tar.gz")` → preserves compound extension as
  `.gz` (last extension), UUID prefix
- **Unit**: `toSessionPath(outputPath("x.txt"))` → `{agentName}/output/{uuid}.txt`
- **Unit**: `resolveSessionPath(toSessionPath(p)) === p` round-trip
- **Unit**: Two concurrent `outputPath("same.txt")` calls produce different
  UUID filenames (no collision)
- **Integration**: Run agent with download tool, verify file lands in
  `{sessionDir}/default/output/{uuid}.{ext}`
