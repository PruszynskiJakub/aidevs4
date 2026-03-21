# SP-37 UUID-Based Document Input

## Main objective

Replace file-path parameters in `document_processor` and `agents_hub` with document UUIDs so tools fetch content from `DocumentStore`, choosing between inline text or file loading based on document type.

## Context

Today `document_processor.ask` accepts `paths: string[]` — absolute or session-relative file paths. Similarly, `agents_hub` actions (`verify`, `verify_batch`, `api_request`, `api_batch`) accept file paths or inline strings via `resolveInput()`. This creates two problems:

1. **Redundant content flow** — When `web__download` saves a file and returns a Document (with UUID, metadata, and source path), the LLM must extract the file path from the result and pass it as a string to the next tool. The Document already exists in `DocumentStore` with all the information needed.

2. **Lost type awareness** — File paths are opaque strings. The receiving tool doesn't know whether the content is text (usable inline) or an image (needs binary loading) until it reads the extension. Documents already carry `metadata.type` and `metadata.source`, making this decision trivial.

With UUID-based input, the LLM passes document IDs from previous tool results. The receiving tool calls `DocumentStore.get(uuid)`, checks `metadata.type`, and either uses `doc.text` directly (for `document`/`text` types) or loads the file from `metadata.source` (for `image` type). This is simpler for the LLM, safer (no path manipulation), and leverages the Document infrastructure from SP-36.

## Out of scope

- Migrating tools beyond `document_processor` and `agents_hub` (other tools can adopt the pattern later)
- Changing how tools produce/return Documents — only the input side changes
- Persistent document storage across sessions
- Automatic summarisation or truncation when fetching from store

## Constraints

- `DocumentStore` must be accessible from tool handlers (currently session-scoped in `AgentState`)
- UUIDs only — no fallback to file paths. Clean break.
- Auto-load by type: tools check `metadata.type` to decide how to consume the document. The LLM does not choose.
- Must not break tools that don't use document input (e.g., `bash`, `think`, `web`)
- Schema changes must remain OpenAI strict-mode compatible (no `oneOf`, no type arrays)

## Acceptance criteria

- [ ] `DocumentStore` is accessible from tool handlers — either injected via handler context or importable as a session-scoped singleton
- [ ] `document_processor.ask` accepts `document_uuids: string[]` instead of `paths: string[]`
- [ ] `document_processor.ask` fetches each document from store, auto-loads content: uses `doc.text` for `document`/`text` types, reads binary from `metadata.source` for `image` type
- [ ] `agents_hub.verify` and `agents_hub.api_request` accept document UUIDs in their string fields (`answer`, `body`) — when the value is a valid UUID found in the store, the tool resolves it to document content
- [ ] `agents_hub.api_batch` accepts a document UUID in `data_file` — resolves to the file at `metadata.source`
- [ ] `agents_hub.verify_batch` accepts a document UUID in `answers` — resolves to document text content
- [ ] Schemas updated: `document_processor.json` replaces `paths` with `document_uuids`, descriptions updated to reference document UUIDs
- [ ] `agents_hub.json` descriptions updated to mention document UUID as a valid input
- [ ] Error messages are actionable: "Document UUID not found in store: {uuid}" with hint to check previous tool results
- [ ] All existing tests updated; new tests cover UUID resolution, type-based loading, and missing-UUID errors
- [ ] Agent system prompt (`src/prompts/system.md`) updated to instruct the LLM to pass document UUIDs between tools

## Implementation plan

1. **Make DocumentStore accessible to tool handlers** — Expose `DocumentStore` as a singleton, consistent with other services (e.g., `files`, `llm`). Export a `documentStore` instance from `src/services/common/document-store.ts`. The agent loop initializes/resets it per session. Tool handlers import and use it directly — no handler signature changes needed.

2. **Add a UUID resolution utility** — Create `resolveDocument(uuid: string): Document` in `src/utils/document.ts` that calls `store.get(uuid)` and throws `"Document UUID not found in store: {uuid}. Check previous tool results."` if missing. Add `resolveDocumentContent(uuid: string): { text: string } | { buffer: Buffer, mimeType: string }` that auto-loads based on `metadata.type`:
   - `document` or `text` → return `{ text: doc.text }`
   - `image` → read binary from `metadata.source` via `files.readBinary()`, return `{ buffer, mimeType: doc.metadata.mime_type }`

3. **Migrate `document_processor.ask`** — Replace `paths: string[]` parameter with `document_uuids: string[]`. Rewrite `buildContentParts` to iterate UUIDs, call `resolveDocumentContent(uuid)`, and build `ContentPart[]` accordingly. Update schema.

4. **Migrate `agents_hub` string fields** — In `resolveInput()` (or a wrapper), add UUID detection: if the input matches UUID v4 format and exists in `DocumentStore`, resolve to `doc.text` (for `answer`, `body`, `answers` fields) or `metadata.source` (for `data_file`). This keeps the existing `resolveInput` flow but adds UUID as the first check before file-path and inline-JSON checks.

5. **Update schemas** — Modify `document_processor.json`: rename `paths` → `document_uuids`, update descriptions. Modify `agents_hub.json`: update field descriptions to mention document UUIDs as valid input.

6. **Update system prompt** — Add guidance in `src/prompts/system.md` instructing the LLM to use document UUIDs from `<document id="...">` tags when passing data between tools, rather than extracting file paths.

7. **Update tests** — Update `document_processor.test.ts` and `agents_hub.test.ts` for UUID-based inputs. Add test cases for: valid UUID resolution, missing UUID error, type-based auto-loading (text vs image), and UUID detection in `resolveInput`.

## Testing scenarios

- `document_processor.ask` with UUID of a text document → resolves `doc.text`, sends to LLM as text content part
- `document_processor.ask` with UUID of an image document → reads binary from `metadata.source`, sends as image content part with correct MIME type
- `document_processor.ask` with non-existent UUID → throws actionable error mentioning the UUID
- `document_processor.ask` with multiple UUIDs (mixed text + image) → correctly builds mixed content parts
- `agents_hub.verify` with UUID as `answer` → resolves document text, submits to hub
- `agents_hub.api_request` with UUID as `body` → resolves document text (JSON), submits to hub
- `agents_hub.api_batch` with UUID as `data_file` → resolves `metadata.source` path, reads CSV/JSON from that file
- `agents_hub.verify_batch` with UUID as `answers` → resolves document text (JSON array)
- UUID that looks valid but isn't in store → clear error, not a cryptic failure
- Non-UUID string in `agents_hub` fields → falls through to existing `resolveInput` behavior (inline JSON or raw string) — wait, UUIDs only for `document_processor`, but `agents_hub` still accepts inline strings too since those fields serve dual purpose
- `ToolDefinition` handler signature unchanged for tools that don't use document input