# SP-36 Document Abstraction

## Main objective

Replace `ToolResponse` and heterogeneous tool outputs with a unified `Document` type. Tools return `Document | Document[]` directly. The LLM receives tool results as XML tags (`<document>`) instead of JSON blobs.

## Context

Today tool handlers return `Promise<unknown>` — some return `ToolResponse<T>` with arbitrary `T`, some return raw strings (bash), some return file paths (web download). The registry normalises everything into a JSON string via `wrapResult()`, but the *shape* of `data` varies per tool. This makes it hard to:

- Estimate how much context a tool result consumes
- Decide whether to inline content or reference it by path
- Build cross-tool workflows where one tool's output feeds another
- Track provenance of content flowing through the agent

`ToolResponse` adds an unnecessary envelope (`status`, `data`, `hints`). Document replaces the entire thing — tools return documents, errors are thrown (caught by registry).

## Out of scope

- Binary/multimodal document content — `text` is always a string (images use a path reference in `text` with `type: 'image'` and appropriate `mime_type`)
- Automatic summarisation or truncation of large documents
- Persistent document storage across sessions

## Constraints

- No new runtime dependencies — token estimation uses `Math.ceil(text.length / 4)`
- `Document.text` is always a `string` — for large content it holds a natural-language pointer ("The webpage content can be found at /path/to/file"), for small content it holds the actual value
- `DocumentMetadata` must be a typed record, not a free-form `Record<string, unknown>`
- UUIDs use `crypto.randomUUID()`
- Must not break existing tool schemas or the dispatcher's auto-discovery

## Acceptance criteria

- [ ] `Document` interface defined in `src/types/document.ts` with fields: `uuid`, `text`, `description`, `metadata`
- [ ] `DocumentMetadata` type defined with required fields (`source: string | null`, `sessionUuid: string`, `tokens: number`, `type: 'document' | 'text' | 'image'`, `mime_type: string`)
- [ ] Helper `createDocument(text, description, metadata)` that auto-generates `uuid`, computes `tokens`, and injects `sessionUuid` from session context
- [ ] `ToolResponse`, `toolOk`, `toolError`, `isToolResponse` removed — tools return `Document | Document[]` directly, errors are thrown
- [ ] Tool result message to LLM uses XML format: `<document id="..." description="...">text</document>` — no JSON stringification
- [ ] For multiple documents, multiple `<document>` tags are concatenated
- [ ] Errors produce a Document with `text: "Error: {message}"`, `description: "Error from {toolName}"`, `type: 'document'`
- [ ] `DocumentStore` class in `src/services/common/document-store.ts` — in-memory `Map<string, Document>` with `add(doc)`, `get(uuid)`, `list()`, `remove(uuid)`, `findByMetadata(key, value)` methods
- [ ] `DocumentStore` is session-scoped (one instance per agent run, accessible via session context)
- [ ] Every tool in `src/tools/` updated to return `Document` or `Document[]`
- [ ] Registry's `dispatch()` updated: calls handler, formats result as XML, registers documents in store
- [ ] Agent loop uses XML-formatted string as tool result `content` (no `parseToolResponse`)
- [ ] All existing tests updated; new tests cover `Document`, `createDocument`, `DocumentStore`, and XML formatting

## Implementation plan

1. **Define types** — Create `src/types/document.ts` with `Document` and `DocumentMetadata` interfaces. All `DocumentMetadata` fields are required — no index signature, no optional fields.

    ```typescript
    export interface DocumentMetadata {
      source: string | null;  // originating URL, file path, or identifier — null if unknown
      sessionUuid: string;    // session that produced this document
      tokens: number;         // estimated token count (Math.ceil(text.length / 4))
      type: 'document' | 'text' | 'image';
      mime_type: string;
    }

    export interface Document {
      uuid: string;
      text: string;
      description: string;
      metadata: DocumentMetadata;
    }
    ```

2. **Create helpers** — Add to `src/utils/document.ts`:
   - `createDocument(text, description, metadata)` — caller provides `source`, `type`, `mime_type`. Helper generates UUID, computes `tokens` as `Math.ceil(text.length / 4)`, injects `sessionUuid` from session context.
   - `formatDocumentXml(doc: Document): string` — renders a single document as `<document id="..." description="...">text</document>`
   - `formatDocumentsXml(docs: Document | Document[]): string` — normalises to array, maps through `formatDocumentXml`, joins with newline
   - `createErrorDocument(toolName: string, message: string): Document` — creates a Document with `text: "Error: {message}"`, `description: "Error from {toolName}"`, `type: 'document'`

    ```
    Example output (single):
    <document id="a1b2c3" description="Bash output for: ls -la">file1.txt\nfile2.txt</document>

    Example output (multiple):
    <document id="a1b2c3" description="Package status">...</document>
    <document id="d4e5f6" description="Redirect confirmation">...</document>

    Example output (error):
    <document id="x7y8z9" description="Error from bash">Error: command not found: foo</document>
    ```

3. **Build DocumentStore** — `src/services/common/document-store.ts` with a `Map<string, Document>` backend. Methods: `add(doc)` (stores by uuid, returns uuid), `get(uuid)`, `list()`, `remove(uuid)`, `findByMetadata(key, value)`. Expose via session context so each agent run gets its own store.

4. **Remove ToolResponse** — Delete `src/utils/tool-response.ts`. Remove `ToolResponse` from `src/types/tool.ts`. Update `ToolDefinition.handler` return type to `Promise<Document | Document[]>`.

5. **Update registry** — `dispatch()` changes:
   - Calls handler → gets `Document | Document[]`
   - Registers each document in session's `DocumentStore`
   - Returns `formatDocumentsXml(result)` (a string)
   - On error: creates error document via `createErrorDocument(toolName, message)`, registers it, returns XML

6. **Update agent loop** — Simplify `dispatchTools`:
   - Remove `parseToolResponse` — registry returns ready-to-use XML string
   - Push tool result directly: `{ role: "tool", toolCallId, content: xmlString }`
   - Remove hints extraction (hints are gone — tools put guidance in `description` or `text`)

7. **Migrate tools one by one** — Update each tool handler to return `Document | Document[]` via `createDocument()`.

   **Rule**: `type: 'document'` means content is inline in `text`. Any other type (`'text'`, `'image'`) means a file — `text` holds a path/pointer reference.

   - `think` → type = `'document'`, mime_type = `'text/plain'`, text = reasoning result, description = "Reasoning about: {thought snippet}", source = null
   - `bash` → type = `'document'`, mime_type = `'text/plain'`, text = stdout (or truncation note), description = "Bash output for: {command snippet}", source = null
   - `web` download → type depends on what was downloaded: `'document'` for HTML/JSON (inline), `'text'` for plain text files, `'image'` for images. mime_type inferred from response. source = url
   - `agents_hub` → type = `'document'`, mime_type = `'application/json'`, text = response content, source = "hub.ag3nts.org"
   - `document_processor` → type = `'document'`, mime_type = `'text/plain'`, text = LLM answer, source = input file path
   - `shipping`, `geo_distance`, `prompt_engineer` → type = `'document'`

8. **Tests** — Unit tests for `createDocument`, `createErrorDocument`, `formatDocumentXml`, `formatDocumentsXml`, `DocumentStore`, and updated tool handlers. Remove tests for `toolOk`/`toolError`/`isToolResponse`.

## Testing scenarios

- `createDocument("hello", "greeting", { source: null, type: "document", mime_type: "text/plain" })` → uuid is valid v4, `metadata.tokens` = 2, `metadata.sessionUuid` = current session
- `createDocument` with all metadata fields → preserves `source`, `type`, `mime_type`, computes `tokens`, injects `sessionUuid`
- `formatDocumentXml` → produces `<document id="uuid" description="desc">text</document>`
- `formatDocumentsXml` with array of 2 docs → two `<document>` tags separated by newline
- `createErrorDocument("bash", "command not found")` → Document with text = `"Error: command not found"`, description = `"Error from bash"`
- XML special characters in `text` are preserved as-is (LLMs handle raw text)
- `DocumentStore.add()` stores and `get()` retrieves by uuid
- `DocumentStore.findByMetadata("type", "image")` returns matching docs
- `DocumentStore.remove()` deletes and subsequent `get()` returns undefined
- Each migrated tool returns `Document | Document[]` (no ToolResponse wrapper)
- Bash tool: `type: 'document'`, `mime_type: 'text/plain'`, `source: null`, text = actual stdout
- Web tool (HTML): `type: 'document'`, text = inline content, `source` = original URL
- Web tool (image): `type: 'image'`, text = file path pointer, `source` = original URL
- Token estimate: 400-char text → `metadata.tokens` = 100
- Registry formats documents as XML and registers them in store
- Agent loop passes XML string directly as tool message content
