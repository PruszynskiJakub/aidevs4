# SP-02 Unified agents_hub tool

## Main objective

Merge `download_file` and `verify_answer` into a single `agents_hub` tool with an `action` discriminator (`download` | `verify`) to reduce tool count and unify all hub interactions behind one interface.

## Context

Today two separate tools handle AG3NTS hub communication:

- **`download_file`** — fetches a file from hub.ag3nts.org, injects API key, saves to disk.
- **`verify_answer`** — reads a JSON answer file and POSTs it to the hub `/verify` endpoint.

Both depend on `src/utils/hub.ts` (`getApiKey`, `buildHubUrl`, `sanitizeUrl`). The project already has a precedent for action-based tools — `csv_processor` (SP-01) successfully consolidated three CSV tools into one with an `action` field.

## Out of scope

- Adding new hub actions (e.g., fetch_task, report) — only `download` and `verify` are implemented.
- Changing download output location (stays in the existing output dir).
- Changing verify input method (stays file-based via `answer_file`).
- Modifying `src/utils/hub.ts` — hub helpers remain as-is.

## Constraints

- Tool args shape is always `{ action: string, payload: Record<string, any> }` — action-specific fields live inside `payload`, never at the top level.
- Must preserve all current behaviour — download saves to disk with API key injection; verify reads JSON file and POSTs to hub.
- The tool name exposed to the LLM must be `agents_hub`.
- Old `download_file.ts`, `verify_answer.ts` and their schemas must be deleted.
- System prompt (`src/prompts/system.ts`) must be updated to reference the new tool.

## Acceptance criteria

- [ ] Single file `src/tools/agents_hub.ts` exports a `ToolDefinition` with name `agents_hub`.
- [ ] Single schema `src/schemas/agents_hub.json` defines `action` + `payload` at the top level.
- [ ] Action `download` accepts `{ action: "download", payload: { url: string } }` and behaves identically to the current `download_file` handler.
- [ ] Action `verify` accepts `{ action: "verify", payload: { task: string, answer_file: string } }` and behaves identically to the current `verify_answer` handler.
- [ ] `src/tools/download_file.ts` and `src/schemas/download_file.json` are deleted.
- [ ] `src/tools/verify_answer.ts` and `src/schemas/verify_answer.json` are deleted.
- [ ] System prompt updated to document `agents_hub` with its two actions.
- [ ] `bun test` passes (no regressions).
- [ ] Agent can still download a file and verify an answer end-to-end using the new tool.

## Implementation plan

1. Create `src/schemas/agents_hub.json` with top-level `action` enum (`download`, `verify`) and a `payload` object containing per-action fields (`{ url }` for download; `{ task, answer_file }` for verify).
2. Create `src/tools/agents_hub.ts` — single handler that switches on `action`, reusing the existing logic from both tools (hub URL building, file download, answer submission).
3. Delete `src/tools/download_file.ts`, `src/schemas/download_file.json`, `src/tools/verify_answer.ts`, `src/schemas/verify_answer.json`.
4. Update `src/prompts/system.ts` to replace `download_file` / `verify_answer` references with `agents_hub` and its actions.
5. Run `bun test` to confirm no regressions.

## Testing scenarios

- **Unit**: Call `agents_hub` handler with `{ action: "download", payload: { url } }` and a mock URL — verify file is saved and result shape matches `{ url, path }`.
- **Unit**: Call `agents_hub` handler with `{ action: "verify", payload: { task, answer_file } }` and a temp JSON file — verify POST is made to hub with correct payload.
- **Integration**: Run the agent with a task that requires downloading a file and verifying an answer — confirm the agent invokes `agents_hub` with the correct actions.
- **Negative**: Call with an unknown action — verify a clear error is returned.
