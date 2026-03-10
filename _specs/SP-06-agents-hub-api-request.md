# SP-06 Add `api_request` action to `agents_hub` tool

## Main objective

Add a generic `api_request` action to the `agents_hub` tool so the agent can call any `https://hub.ag3nts.org/api/{path}` endpoint with a JSON body and auto-injected API key.

## Context

The `agents_hub` tool currently has two actions — `download` (fetch files) and `verify` (submit answers). Both are special-purpose. Some tasks require calling other hub API endpoints (e.g. `/api/location`). Today there is no generic way for the agent to do this; each new endpoint would need a dedicated action. A single `api_request` action eliminates that gap.

`verify` already demonstrates the pattern: POST JSON with `apikey` merged into the body. `api_request` generalises this to any `/api/*` path.

## Out of scope

- GET or other HTTP methods — POST only for now.
- Endpoints outside `/api/` (e.g. `/verify`, `/data/`).
- Streaming responses.
- File uploads / multipart form-data.

## Constraints

- Must follow the existing multi-action `{ action, payload }` pattern with `oneOf` discriminated schema.
- API key is always injected as `apikey` in the top-level request body (same as `verify`).
- Body source: accept **either** an inline `body` object **or** a `body_file` path (read via file service). Exactly one must be provided.
- Response is returned as-is (parsed JSON or text fallback).

## Acceptance criteria

- [ ] New `api_request` variant added to `src/schemas/agents_hub.json` with `path`, optional `body`, and optional `body_file` fields.
- [ ] Handler in `src/tools/agents_hub.ts` POSTs to `{HUB_BASE_URL}/api/{path}` with `apikey` merged into the body.
- [ ] Inline `body` (object) works — agent passes JSON directly in payload.
- [ ] File-based `body_file` works — handler reads JSON from file via file service, then merges `apikey`.
- [ ] Error if both `body` and `body_file` are provided, or if neither is provided.
- [ ] Non-OK HTTP responses throw with status and status text.
- [ ] Existing `download` and `verify` actions remain unchanged.
- [ ] Unit tests cover: inline body, file-based body, mutual-exclusion error, missing body error, HTTP error.
- [ ] System prompt (`src/prompts/system.md`) updated to document the new action.

## Implementation plan

1. **Schema** — Add `api_request` variant to the `oneOf` array in `agents_hub.json`:
   - `action: { "const": "api_request" }`
   - `payload`: `path` (string, required), `body` (object, optional), `body_file` (string, optional).
2. **Config** — No new constants needed; construct URL as `` `${HUB_BASE_URL}/api/${path}` ``.
3. **Handler** — Add `apiRequest(payload)` function in `agents_hub.ts`:
   - Validate exactly one of `body` / `body_file` is present.
   - If `body_file`, read and parse JSON via `files.readText()`.
   - Merge `{ apikey }` into the body object.
   - POST with `Content-Type: application/json`.
   - Return `{ path, response }`.
4. **Dispatcher wiring** — Add `case "api_request"` to the switch.
5. **System prompt** — Add `api_request` to the agents_hub action list in `system.md`.
6. **Tests** — Extend `agents_hub.test.ts` (or create if absent) with scenarios from acceptance criteria.

## Testing scenarios

- **Inline body**: Call with `{ action: "api_request", payload: { path: "location", body: { query: "test" } } }` → verify POST to correct URL with `apikey` + `query` in body.
- **File body**: Write a temp JSON file, call with `body_file` → same POST behaviour.
- **Both provided**: Provide both `body` and `body_file` → expect thrown error.
- **Neither provided**: Omit both → expect thrown error.
- **HTTP error**: Mock a 404 response → expect thrown error with status.
- **Existing actions**: Verify `download` and `verify` still work (regression).
