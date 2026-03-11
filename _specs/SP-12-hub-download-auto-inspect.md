# SP-12 Hub download auto-inspect

## Main objective

Extend the `agents_hub` download action to automatically inspect the downloaded file and return its structure in an `inspection` field, so the agent doesn't need a separate `filesystem inspect` call after every download.

## Context

Today the `agents_hub` download action returns `{ filename, path }`. The agent must then call `filesystem inspect` on the downloaded file to understand its contents (columns, rows, schema, etc.). This wastes a tool-call round-trip on every download. The `filesystem` tool already has inspection logic for CSV, JSON, and Markdown — we can reuse it directly inside the download handler.

## Out of scope

- Adding new inspectable formats to `filesystem` (that's a separate concern)
- Changing the `filesystem inspect` tool itself
- Modifying the download mechanism (fetch, save, URL construction)
- Changing the schema of the `inspect` action's return type

## Constraints

- Must remain backward-compatible — `filename` and `path` stay at the top level
- Reuse existing inspection logic from `filesystem.ts`; do not duplicate parsers
- Inspection must not cause the download to fail — if inspection errors out (e.g. unsupported format), return `inspection: null`
- No new dependencies

## Acceptance criteria

- [ ] `agents_hub` download action returns `{ filename, path, inspection }` where `inspection` is the same shape as `filesystem inspect` output for supported formats (CSV, JSON, Markdown)
- [ ] For unsupported file formats (e.g. `.zip`, `.png`, `.txt`), `inspection` is `null` and the download still succeeds
- [ ] Inspection logic is imported from `filesystem.ts` (not copy-pasted)
- [ ] Existing tests (if any) for download and inspect still pass
- [ ] Schema in `src/schemas/agents_hub.json` does NOT need updating (inspection is in the response, not the request)

## Implementation plan

1. Extract the core inspection logic from `filesystem.ts` into an exported function (e.g. `inspectFile(path: string)`) that can be called externally. Keep the tool handler as a thin wrapper around it.
2. In `agents_hub.ts` download action, after the file is saved, call `inspectFile(path)` wrapped in a try-catch. On success, include the result as `inspection`; on failure, set `inspection: null`.
3. Update the return type of the download action to include the `inspection` field.
4. Add/update tests to verify:
   - Download of a CSV file returns inspection with columns and sample
   - Download of a JSON file returns inspection with schema and sample
   - Download of an unsupported format returns `inspection: null`

## Testing scenarios

- **CSV download**: Mock hub response with CSV content → verify `inspection.format === "csv"`, `inspection.columns` and `inspection.sample` are populated
- **JSON download**: Mock hub response with JSON content → verify `inspection.format === "json"`, `inspection.schema` and `inspection.sample` are populated
- **Unsupported format**: Mock hub response with `.zip` content → verify `inspection === null`, download itself succeeds with valid `filename` and `path`
- **Inspection failure**: Force inspection to throw (e.g. corrupt CSV) → verify `inspection === null`, download still returns `filename` and `path`
