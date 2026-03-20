# SP-35 agents_hub: dual-purpose input params (file or inline)

## Main objective

Make `agents_hub` actions accept inline JSON / raw strings in addition to file paths, reducing unnecessary file round-trips and saving agent context.

## Context

Today, `verify` requires `answer_file`, `verify_batch` requires `answers_file`, and `api_request` is split into two actions (`api_request_body` for inline JSON, `api_request_file` for file paths). This forces the agent to write a file before verifying a simple answer, wasting a tool call and context.

`api_request` already proves the dual-input concept works — it just uses two separate actions instead of one smart param. We can generalize this with a `resolveInput` helper and collapse the schema.

## Out of scope

- `api_batch` `data_file` param — stays file-only (batch data is typically large)
- Changes to `field_map_json` in `api_batch` (already a JSON string)
- New actions or tools — this is purely a refactor of existing params

## Constraints

- OpenAI strict mode: no `oneOf`, `anyOf`, type arrays. All params remain `"type": "string"`.
- `FileProvider` interface change (`exists()`) must not break existing consumers.
- Resolution order must be deterministic: **file → JSON → raw string**.
- Max length checks must still apply to inline input.
- `checkFileSize` only applies when input resolves to a file.

## Acceptance criteria

- [ ] `FileProvider` interface has an `exists(path: string): Promise<boolean>` method; `createBunFileService` implements it
- [ ] New `resolveInput(input: string, label: string): Promise<unknown>` helper in `src/utils/parse.ts` with resolution chain: file (exists + size check + read + parse) → JSON parse → return raw string
- [ ] `verify` action: param renamed `answer_file` → `answer`; uses `resolveInput`
- [ ] `verify_batch` action: param renamed `answers_file` → `answers`; uses `resolveInput`; still validates result is an array
- [ ] `api_request_body` and `api_request_file` merged into single `api_request` action with params `path` + `body`; uses `resolveInput`; old action names removed from schema and handler switch
- [ ] Schema (`src/schemas/agents_hub.json`) updated: param names, descriptions reflect dual-purpose ("file path, JSON string, or raw value")
- [ ] All existing tests still pass (updated for new param names)
- [ ] New tests cover: inline JSON object, inline JSON array, inline raw string, file path, invalid JSON that is also not a file (throws)

## Implementation plan

1. **Add `exists()` to `FileProvider`**
   - Add `exists(path: string): Promise<boolean>` to `src/types/file.ts`
   - Implement in `src/services/common/file.ts`: use `Bun.file(path).exists()`, respecting `assertPathAllowed` for read paths. Catch access-denied errors and return `false` (not a readable file = not a file for resolution purposes).

2. **Create `resolveInput` helper in `src/utils/parse.ts`**
   ```
   async function resolveInput(input: string, label: string): Promise<unknown>
   ```
   Resolution chain:
   1. `await files.exists(input)` → if true: `checkFileSize` → `files.readText` → `safeParse`
   2. Try `safeParse(input, label)` → if succeeds, return parsed value
   3. Return `input` as raw string (for simple string answers like `"KRAKOW"`)

   Note: step 3 never errors — it's the fallback. Errors from step 1 (file too large, read failure) propagate normally.

3. **Refactor `verify` handler**
   - Rename `payload.answer_file` → `payload.answer`
   - Replace file read + parse block with `const answer = await resolveInput(payload.answer, "answer")`
   - Keep `assertMaxLength(payload.answer, "answer", 100_000)` — raise limit from 500 (file path) since inline JSON can be larger

4. **Refactor `verify_batch` handler**
   - Rename `payload.answers_file` → `payload.answers`
   - Replace file read + parse with `const answers = await resolveInput(payload.answers, "answers")`
   - Keep the `Array.isArray` check after resolution
   - Raise `assertMaxLength` to 100_000

5. **Merge `api_request` actions**
   - Collapse `api_request_body` / `api_request_file` into single `api_request` with `path` + `body`
   - Handler: `const body = await resolveInput(payload.body, "body")` — validate result is an object
   - Remove `api_request_body` and `api_request_file` cases from switch; add single `api_request` case
   - `assertMaxLength(payload.body, "body", 100_000)`

6. **Update schema `src/schemas/agents_hub.json`**
   - `verify`: rename `answer_file` → `answer`, description: `"The answer to submit — file path to a JSON file, inline JSON string, or a raw string value"`
   - `verify_batch`: rename `answers_file` → `answers`, description: `"Array of answers — file path to a JSON array file, or an inline JSON array string"`
   - Replace `api_request_body` + `api_request_file` with single `api_request`: params `path` + `body`, body description: `"Request body — file path to a JSON file, inline JSON string, or a raw string value. apikey is injected automatically."`
   - `api_batch`: `data_file` stays unchanged

7. **Update tests**
   - Rename param references in existing tests
   - Add cases: inline JSON object, inline JSON array, raw string, file path still works, invalid input that isn't a file

## Testing scenarios

| Scenario | Input | Expected |
|---|---|---|
| File path exists | `"/abs/path/answer.json"` containing `{"city":"Krakow"}` | Reads file, parses JSON, returns object |
| Inline JSON object | `'{"city":"Krakow"}'` | Parses JSON, returns object |
| Inline JSON array | `'[1, 2, 3]'` | Parses JSON, returns array |
| Inline raw string | `KRAKOW` | Falls through to raw string, returns `"KRAKOW"` |
| Inline JSON number | `42` | Parses as JSON, returns number `42` |
| File too large | Path to 11 MB file | Throws max size error |
| File not found + invalid JSON | `not/a/file/{bad` | `exists()` returns false, `safeParse` fails, falls back to raw string `"not/a/file/{bad"` |
| verify with inline | `verify` action, `answer: '{"city":"Krakow"}'` | Submits parsed object as answer |
| verify_batch inline array | `answers: '[{"a":1},{"a":2}]'` | Parses array, sends each item |
| verify_batch inline non-array | `answers: '{"a":1}'` | Resolves to object, fails `Array.isArray` check |
| api_request inline body | `body: '{"query":"test"}'` | Parses, injects apikey, POSTs |
| api_request file body | `body: "/path/to/body.json"` | Reads file, parses, injects apikey, POSTs |
