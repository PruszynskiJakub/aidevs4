# SP-24 Web download tool

## Main objective

Replace the hub-specific `agents_hub__download` action with a generic `web` tool
that can download files from any allowlisted host, resolving `{{placeholder}}`
template variables in URLs from a predefined set of env vars.

## Context

The current `agents_hub` tool has a `download` action tightly coupled to the hub:
it constructs `{HUB_BASE_URL}/data/{apiKey}/{filename}` and doesn't support
arbitrary URLs. As tasks grow in variety, the agent needs a general-purpose
download capability that still enforces security boundaries (host allowlist,
placeholder allowlist). The `download` action will be removed from `agents_hub`
and replaced by `web__download`.

## Out of scope

- HTTP methods other than GET (no POST/PUT/DELETE) — future actions can add these
- Inline response body return (fetch-style) — download always writes to disk
- Streaming / chunked transfer progress reporting
- Cookie or session management
- Custom request headers beyond what the tool injects

## Constraints

- Host allowlist enforced in the handler — model cannot fetch from arbitrary
  domains. Initial list: `*.ag3nts.org`. List lives in `src/config.ts` for
  easy extension.
- Placeholder allowlist enforced in the handler — only known `{{names}}` are
  resolved. Initial list: `{{hub_api_key}}` → `process.env.HUB_API_KEY`.
  Mapping lives in `src/config.ts`.
- Must use `files` service for all disk writes (never raw `fs` / `Bun.write()`).
- 30 s fetch timeout (`FETCH_TIMEOUT` from config).
- Max response size validated before writing (10 MB from `MAX_FILE_SIZE`).
- Schema must be OpenAI strict-mode compatible (no `oneOf`, `anyOf`, type arrays).
- Tool security rules from `_aidocs/tools_standard.md` apply in full.

## Acceptance criteria

- [ ] `src/tools/web.ts` exists, exports `default { name: "web", handler } satisfies ToolDefinition`.
- [ ] `src/schemas/web.json` exists with a `download` action.
- [ ] `web__download` accepts a `url` parameter (string, required) and an optional
      `filename` parameter (string — if omitted, derived from the URL path).
- [ ] `{{placeholder}}` segments in the URL are resolved from the allowlisted
      mapping before fetching. Unrecognized placeholders cause an error
      (not silently passed through).
- [ ] Host allowlist is checked after placeholder resolution (against the final
      URL). Requests to non-allowlisted hosts are rejected with an actionable
      error message.
- [ ] The downloaded file is written via `files.write()` to the output directory
      (`outputPath()`).
- [ ] Response returns `{ status: "ok", data: { path, bytes }, hints: [...] }`.
- [ ] `download` action is removed from `agents_hub` tool and schema.
- [ ] All existing `agents_hub` actions other than `download` continue to work.
- [ ] `src/tools/web.test.ts` covers: valid download, unknown placeholder,
      disallowed host, filename derivation, missing URL, filename validation.
- [ ] Placeholder and host allowlists are defined in `src/config.ts`.

## Implementation plan

1. **Add config entries** in `src/config.ts`:
   - `WEB_ALLOWED_HOSTS: string[]` — initial value `[".ag3nts.org"]`
     (substring match on hostname, so `hub.ag3nts.org` and
     `centrala.ag3nts.org` both pass).
   - `WEB_PLACEHOLDER_MAP: Record<string, () => string>` — initial value
     `{ hub_api_key: () => process.env.HUB_API_KEY! }`.

2. **Create `src/schemas/web.json`** with a single `download` action:
   - Parameters: `url` (string, required), `filename` (string, optional — for
     explicit output filename override).
   - Description explains placeholder syntax and host restriction.

3. **Create `src/tools/web.ts`**:
   - Handler receives `{ action, payload }`, switches on action.
   - `download` action:
     a. Validate `url` string (max 2048 chars).
     b. Resolve `{{...}}` placeholders using the allowlist. Regex:
        `/\{\{(\w+)\}\}/g`. For each match, look up in `WEB_PLACEHOLDER_MAP`;
        if missing, throw with the unrecognized name.
     c. Parse the resolved URL; extract hostname.
     d. Check hostname against `WEB_ALLOWED_HOSTS` (suffix match).
     e. Derive filename: use `payload.filename` if provided (run through
        `safeFilename()`), else take the last path segment of the URL
        (also run through `safeFilename()`).
     f. `fetch(resolvedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })`.
     g. Check response status; throw on non-2xx.
     h. `await ensureOutputDir(); await files.write(outputPath(filename), response)`.
     i. Return `toolOk({ path: outputPath(filename) }, ["Use fs__read to inspect the downloaded file."])`.

4. **Remove `download` from `agents_hub`**:
   - Delete the `download` case from `agents_hub.ts` handler switch.
   - Delete the `download` action from `agents_hub.json` schema.
   - Clean up any imports that were only used by `download`.

5. **Write tests** in `src/tools/web.test.ts`:
   - Mock `fetch` globally (same pattern as `agents_hub.test.ts`).
   - Test cases:
     - Valid URL with placeholder → resolved correctly, fetch called, file written.
     - Unknown placeholder → error with placeholder name.
     - Disallowed host → error naming the host.
     - Filename from URL path when no explicit filename given.
     - Explicit filename parameter used when provided.
     - Filename validation (reject traversal, hidden files).
     - Missing / empty URL → error.

6. **Update system prompt** (`src/prompts/system.md`) if it references
   `agents_hub__download` — point to `web__download` instead.

## Testing scenarios

| Criterion | Test |
|-----------|------|
| Placeholder resolution | Call with `url: "https://hub.ag3nts.org/data/{{hub_api_key}}/file.txt"` → fetch receives resolved URL |
| Unknown placeholder | Call with `{{bad_key}}` → error mentions `bad_key` |
| Host allowlist | Call with `https://evil.com/file` → rejected |
| Filename derivation | URL `https://hub.ag3nts.org/data/x/report.json` → saved as `report.json` |
| Explicit filename | `filename: "custom.txt"` → saved as `custom.txt` |
| Filename safety | `filename: "../../etc/passwd"` → rejected by `safeFilename()` |
| agents_hub still works | `verify`, `api_request_body`, `api_request_file`, `api_batch` unchanged |
| Non-2xx response | Fetch returns 404 → error with status code |
