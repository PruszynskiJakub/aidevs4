# SP-16 Tool Input Hardening

## Main objective

Add shared validation utilities and apply them across all tool handlers to
eliminate unsafe JSON parsing, path traversal, prototype pollution, missing
timeouts, and unbounded inputs — the Critical and High findings from the
tools-standard audit.

## Context

An audit of `src/tools/` against `_aidocs/tools_standard.md` found:

- **No `safeParse()` utility** — raw `JSON.parse()` in 6+ locations (agents_hub,
  geo_distance, dispatcher). Malformed JSON surfaces raw stack traces.
- **No `safeFilename()`** — `agents_hub.download` passes model-supplied filenames
  directly into URL construction and `outputPath()` with zero sanitization.
  `../../.env` would traverse paths (file service catches this, but defense in
  depth requires tool-layer validation too).
- **No prototype-pollution guard** — `agents_hub.apiBatch` parses
  `field_map_json` into object keys without checking `__proto__`, `constructor`,
  `prototype`.
- **No fetch timeouts** — all `fetch()` calls in `agents_hub` (download, verify,
  apiRequest, apiBatch) lack `AbortSignal.timeout()`. A hung upstream blocks the
  agent forever.
- **No string constraints** — no parameter has a max length, char allowlist, or
  path-escape check.
- **No numeric bounds** — `geo_distance` doesn't reject NaN/Infinity or enforce
  min/max on lat/lon/radius.
- **No batch cap** — `apiBatch` will process unbounded rows (100k rows = 100k
  sequential API calls).
- **No file-size check** — `agents_hub` and `geo_distance` read files without
  checking size first.

The `files` service path allowlist and the dispatcher's error-catching are solid
foundations. This spec adds the missing tool-layer validation.

## Out of scope

- **Bash tool** — accepted as-is (Level 4 shell, local-only dev tool)
- **Response format** (`{ status, data, hints }`) — deferred to a separate spec
- **Dry-run mode / checksum guards** — deferred (Medium-priority findings)
- **Actionable hints in responses** — deferred
- **Undo / history** — deferred (Low-priority)
- **Schema changes** — schemas stay as they are; validation is handler-side

## Constraints

- No new runtime dependencies — validation is pure TypeScript
- File service interface (`FileProvider`) must not change
- Existing tests must continue to pass
- Tool handler signatures stay compatible with the dispatcher
- `TRANSFORM_BATCH_SIZE` (25) already exists in config — new constants follow
  the same pattern

## Acceptance criteria

- [ ] `src/utils/parse.ts` exports `safeParse<T>(json, label)` — wraps
      `JSON.parse` with a labelled error that never echoes raw input
- [ ] `src/utils/parse.ts` exports `safeFilename(raw)` — rejects path
      separators, `..`, hidden files, chars outside `[a-zA-Z0-9_.\-]`
- [ ] `src/utils/parse.ts` exports `validateKeys(obj)` — rejects `__proto__`,
      `constructor`, `prototype` keys
- [ ] Every `JSON.parse()` in tool code (`agents_hub`, `geo_distance`) and
      `dispatcher.ts` is replaced with `safeParse()`
- [ ] `agents_hub.download` validates `filename` through `safeFilename()`
- [ ] `agents_hub.apiBatch` validates `fieldMap` keys through `validateKeys()`
- [ ] Every `fetch()` in `agents_hub` uses `signal: AbortSignal.timeout(30_000)`
- [ ] String params have max-length checks enforced in handlers:
      `command` (10_000), `filename` (255), `task` (100), `path` (200),
      `body_json` (100_000), file paths (500), `question` (5_000),
      `context` (50_000)
- [ ] `geo_distance` numeric params validated: lat ∈ [-90, 90], lon ∈ [-180, 180],
      radius_km ∈ (0, 40_075], reject NaN/Infinity
- [ ] `agents_hub.apiBatch` caps rows at `MAX_BATCH_ROWS` (config, default 1000)
- [ ] `agents_hub` and `geo_distance` check file size before reading — reject
      files > `MAX_FILE_SIZE` (config, default 10 MB)
- [ ] New constants added to `src/config.ts`: `FETCH_TIMEOUT`, `MAX_BATCH_ROWS`,
      `MAX_FILE_SIZE`
- [ ] All new utilities have tests covering: valid input, malformed input,
      boundary values, and injection attempts
- [ ] Existing tests still pass

## Implementation plan

1. **Create `src/utils/parse.ts`** with `safeParse()`, `safeFilename()`,
   `validateKeys()`. Write tests in `src/utils/parse.test.ts`.

2. **Add config constants** to `src/config.ts`: `FETCH_TIMEOUT = 30_000`,
   `MAX_BATCH_ROWS = 1000`, `MAX_FILE_SIZE = 10 * 1024 * 1024`.

3. **Add a `checkFileSize()` helper** in `src/utils/parse.ts` that calls
   `files.stat()` (or `Bun.file().size`) and throws if over limit. This keeps
   it reusable without changing `FileProvider`.

4. **Harden `agents_hub.ts`**:
   - Replace all `JSON.parse()` with `safeParse()`
   - Add `safeFilename()` to `download`
   - Add `validateKeys()` to `apiBatch` field map
   - Add `AbortSignal.timeout(FETCH_TIMEOUT)` to every `fetch()`
   - Add string max-length checks at the top of each action handler
   - Add file-size check before reading in `verify`, `apiRequest` (file mode),
     `apiBatch`
   - Cap `apiBatch` rows at `MAX_BATCH_ROWS`

5. **Harden `geo_distance.ts`**:
   - Add numeric bounds validation for lat, lon, radius_km
   - Add file-size check before reading in `findNearby`
   - Add max-length checks on file path strings

6. **Harden `think.ts`**:
   - Add max-length checks on `question` and `context`

7. **Harden `dispatcher.ts`**:
   - Replace `JSON.parse(argsJson)` with `safeParse(argsJson, name)`

8. **Update existing tests** if any assertions depend on raw `JSON.parse` error
   messages. Add new test cases for boundary/injection scenarios to each tool's
   test file.

## Testing scenarios

| Criterion | Test |
|---|---|
| `safeParse` | Valid JSON parses; invalid JSON throws with label, no raw input in message |
| `safeFilename` | Clean name passes; `../etc/passwd` rejects; `.hidden` rejects; `foo bar.txt` rejects; empty string rejects |
| `validateKeys` | Normal keys pass; `__proto__` rejects; `constructor` rejects; `prototype` rejects |
| Fetch timeout | Mock a hanging endpoint; verify `agents_hub` rejects within ~30s (or use a short timeout in test) |
| String max-length | `filename` of 256 chars rejects; `body_json` of 100_001 chars rejects |
| Numeric bounds | lat=91 rejects; lon=NaN rejects; radius_km=0 rejects; radius_km=-1 rejects; Infinity rejects |
| Batch cap | JSON array of 1001 items rejects with clear error |
| File-size check | Mock/create a file > 10 MB; verify tool rejects before reading content |
| `safeFilename` in download | `../../secret` rejects; `data.csv` passes |
| `validateKeys` in apiBatch | `field_map_json` with `__proto__` key rejects |
| Existing tests | `bun test` passes without modification (or with minimal message updates) |
