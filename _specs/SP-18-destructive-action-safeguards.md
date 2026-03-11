# SP-18 Destructive Action Safeguards

## Main objective

Classify every tool action by risk level and add safeguards (dry-run mode,
checksum guards) for mutating and irreversible operations — the Medium findings
M4–M6 and Low finding L1 from the tools-standard audit.

## Context

Audit findings from the tools-standard review:

- **M4 — No action classification.** The standard (§4.1) requires every action
  to be classified as read-only / create / mutate / destroy / irreversible.
  Currently none are. `verify`, `api_request*`, and `api_batch` are irreversible
  (external POSTs) with no safeguards beyond input validation.
- **M5 — No dry-run mode.** The standard (§4.3) recommends a `dryRun: true`
  flag for high-impact actions that returns a preview without executing.
  No tool supports this.
- **M6 — No checksum guard.** The standard (§4.2) recommends requiring proof
  that the caller has seen the current state before mutating. `verify` reads a
  file and submits it with no such guard.
- **L1 — No undo/history.** The standard (§4.4) suggests keeping previous
  versions for lossy write operations. No mechanism exists.

Current action classification (implicit, not enforced):

| Action | Actual risk | Current safeguard |
|---|---|---|
| `agents_hub__download` | Create (writes file) | File service path check |
| `agents_hub__verify` | Irreversible (external POST) | None |
| `agents_hub__api_request_body` | Irreversible (external POST) | None |
| `agents_hub__api_request_file` | Irreversible (external POST) | None |
| `agents_hub__api_batch` | Irreversible (external POST × N) | None |
| `geo_distance__find_nearby` | Read-only | N/A |
| `geo_distance__distance` | Read-only | N/A |
| `think` | Read-only | N/A |
| `bash` | Destroy/Irreversible | Out of scope |

## Out of scope

- Bash tool — accepted as-is per prior decision
- Input validation — covered by SP-16
- Response format changes — covered by SP-17
- Confirmation gates via UI (no UI exists — agent is CLI-only)
- Scope locks / allowlisted recipients (only one external target: hub.ag3nts.org)

## Constraints

- Dry-run must be opt-in — existing calls without `dryRun` behave as before
  (backward compatible)
- Checksum approach must work with the file service — no new storage backend
- Classification metadata should be declarative (in schema or tool definition),
  not scattered in handler logic
- Undo/history must not accumulate unbounded disk usage — cap or rotate
- OpenAI strict-mode schemas don't support optional params well — `dryRun` must
  be a required boolean with a default documented in description

## Acceptance criteria

- [ ] `ToolDefinition` type extended with optional `risk` field:
      `"read" | "create" | "mutate" | "destroy" | "irreversible"`
- [ ] Every tool sets its `risk` (or per-action risk for multi-action tools)
- [ ] `agents_hub` irreversible actions (`verify`, `api_request_body`,
      `api_request_file`, `api_batch`) support a `dryRun` boolean parameter:
      - When `true`: builds the full request (URL, headers, body) and returns it
        as a preview without sending
      - When `false`: executes normally
- [ ] `dryRun` parameter added to the relevant schemas with
      `"description": "Preview the request without sending (default: false)"`
- [ ] `agents_hub__verify` requires a `file_checksum` parameter (SHA-256 hex of
      the answer file). Handler computes the actual checksum and rejects if
      mismatched. This ensures the model read the file before submitting.
- [ ] `agents_hub__download` writes files to `output/` with a `.history/`
      subfolder: before overwriting an existing file, the previous version is
      copied to `.history/{filename}.{timestamp}`
- [ ] History folder is capped: max 10 versions per file. Oldest are deleted
      when the cap is exceeded.
- [ ] Dispatcher logs the `risk` classification alongside tool call name in
      the markdown logger
- [ ] Agent system prompt (`src/prompts/system.md`) updated with a note:
      "For irreversible actions, prefer calling with dryRun=true first to
      preview, then re-call with dryRun=false to execute."
- [ ] All new behavior has tests

## Implementation plan

1. **Extend `ToolDefinition`** in `src/types/tool.ts` — add optional `risk`
   field with the union type. For multi-action tools, support a `risks` map
   (`Record<string, Risk>`) as an alternative.

2. **Classify all actions** — set `risk` in each tool's default export:
   - `bash`: `"destroy"` (acknowledged, no safeguards added)
   - `think`: `"read"`
   - `geo_distance`: `"read"` (both actions)
   - `agents_hub`: per-action: `download` → `"create"`,
     `verify/api_request*/api_batch` → `"irreversible"`

3. **Add `dryRun` to irreversible `agents_hub` actions**:
   - Extract request-building logic into a `buildRequest()` helper that returns
     `{ url, method, headers, body }`.
   - When `dryRun === true`, return the built request as preview data.
   - When `dryRun === false`, execute the request.
   - Update schemas to include `dryRun` as a required boolean.

4. **Add checksum guard to `verify`**:
   - Add `file_checksum` required param to the verify schema.
   - In handler: compute SHA-256 of the answer file, compare to
     `payload.file_checksum`. Reject on mismatch with an actionable error
     ("File changed since last read. Read it again and re-submit.").
   - Use `Bun.CryptoHasher` for SHA-256 (built-in, no dependency).

5. **Add download history**:
   - Before `files.write(path, response)` in `download`, check if `path`
     exists. If so, copy to `.history/{filename}.{ISO timestamp}`.
   - After copy, scan `.history/` for files matching `{filename}.*`, sort by
     timestamp, delete oldest beyond cap of 10.
   - Create `.history/` via `files.mkdir()`.

6. **Update dispatcher** — read `risk` from tool definition, pass to logger.

7. **Update markdown logger** — include `[risk: irreversible]` tag next to
   tool call entries.

8. **Update system prompt** — add dry-run guidance for irreversible actions.

9. **Write tests** for each new behavior.

## Testing scenarios

| Criterion | Test |
|---|---|
| Risk classification | Each tool export has correct `risk` value |
| Dry-run preview | `api_request_body` with `dryRun: true` → returns `{ url, method, headers, body }` without calling fetch |
| Dry-run execute | `api_request_body` with `dryRun: false` → calls fetch normally |
| Dry-run in batch | `api_batch` with `dryRun: true` → returns preview of first request, does not execute any |
| Checksum match | `verify` with correct SHA-256 → submits normally |
| Checksum mismatch | `verify` with wrong checksum → rejects with actionable error |
| History creation | `download` overwrites existing file → previous version in `.history/` |
| History cap | 11th download of same file → only 10 history entries remain, oldest deleted |
| History first download | `download` of new file → no history entry created |
| Logger risk tag | Dispatch an irreversible action → markdown log contains `[risk: irreversible]` |
| Backward compat | Existing tests pass — `dryRun: false` is the executing path |
