# SP-32 Restructure output directory

## Main objective

Move the output directory from `src/output/` to the project root (`output/`) and organise files into `{file_type}/{uuid}/file.xyz` subdirectories for clearer separation by media type.

## Context

Today all tool-generated files land in a flat `src/output/` directory. As the toolbox grows, the directory becomes a grab-bag of JSON results, downloaded images, audio files, etc. with no structure beyond the filename. The output directory also lives inside `src/`, which is meant for source code only.

Key files involved:
- `src/config/index.ts` — defines `OUTPUT_DIR = join(PROJECT_ROOT, "src/output")`
- `src/utils/output.ts` — `ensureOutputDir()` and `outputPath(filename)` helpers
- `src/services/file.ts` — sandboxes writes to `OUTPUT_DIR` and `LOGS_DIR`
- `src/tools/web.ts` — downloads files via HTTP, uses `outputPath()`
- `src/tools/agents_hub.ts` — writes batch results using `files.write()` with explicit paths
- `.gitignore` — ignores `src/output`

## Out of scope

- Playground scripts — they keep their own local `playground/*/output/` dirs unchanged
- Log directory — stays at `logs/` with its existing date/session structure
- Existing files migration — `src/output/` is gitignored; no data to migrate

## Constraints

- File service sandbox must continue to enforce write-path restrictions
- All tools must keep working without API changes visible to the LLM (tool schemas stay the same)
- UUID is always auto-generated (v4) — callers do not control it

## Acceptance criteria

- [ ] Output directory is at project root: `output/`
- [ ] Files are stored as `output/{file_type}/{uuid}/{original_filename}` where `file_type` is one of: `document`, `image`, `audio`, `video`
- [ ] `file_type` is inferred from the file extension (e.g., `.json`/`.csv`/`.txt` → `document`, `.png`/`.jpg` → `image`, `.mp3`/`.wav` → `audio`, `.mp4`/`.webm` → `video`); unknown extensions default to `document`
- [ ] `outputPath(filename)` returns the full structured path and creates intermediate dirs
- [ ] File service sandbox allows writes to the new `output/` root
- [ ] `.gitignore` updated: `src/output` replaced with `/output`
- [ ] All existing tools (`web`, `agents_hub`) work with the new structure without schema changes
- [ ] Existing tests pass; new tests cover file-type inference and path generation

## Implementation plan

1. **Update config** — In `src/config/index.ts`, change `OUTPUT_DIR` from `join(PROJECT_ROOT, "src/output")` to `join(PROJECT_ROOT, "output")`.

2. **Add file-type mapping** — Create a `inferFileType(filename: string): string` function in `src/utils/output.ts` that maps extensions to one of four categories (`document`, `image`, `audio`, `video`), defaulting to `document`.

3. **Rework `outputPath()`** — Change signature to generate structured paths:
   - Generate a UUID v4
   - Infer file type from extension
   - Return `output/{file_type}/{uuid}/{filename}`
   - Ensure intermediate directories exist (call `files.mkdir` with `{ recursive: true }`)

4. **Update `ensureOutputDir()`** — Keep it as a no-op safety net or remove it if `outputPath()` now handles dir creation. Tools calling `ensureOutputDir()` before `outputPath()` should still work.

5. **Update tools** — Verify `web.ts` and `agents_hub.ts` work with the new paths. The `web.ts` tool already uses `outputPath(filename)` so it should work. `agents_hub.ts` uses explicit paths from the caller — confirm it routes through the output utility or update it.

6. **Update `.gitignore`** — Replace `src/output` with `/output`.

7. **Delete `src/output/`** — Remove the old empty directory if it exists.

8. **Write tests** — Cover:
   - Extension → file-type mapping (all four categories + unknown)
   - `outputPath()` returns correct structured path
   - Intermediate dirs are created

## Testing scenarios

- Call `outputPath("result.json")` → path matches `output/document/{uuid}/result.json`, dir exists
- Call `outputPath("photo.png")` → path matches `output/image/{uuid}/photo.png`
- Call `outputPath("recording.mp3")` → path matches `output/audio/{uuid}/recording.mp3`
- Call `outputPath("clip.mp4")` → path matches `output/video/{uuid}/clip.mp4`
- Call `outputPath("data.xyz")` → defaults to `output/document/{uuid}/data.xyz`
- Run `bun test` — all existing tests pass
- Run `bun run agent "download <url>"` — file lands in `output/{type}/{uuid}/filename`
