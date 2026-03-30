# SP-61 Replace Document with ToolResult

## Main objective

Replace the `Document` abstraction with a `ToolResult` type using MCP-aligned content parts, so tool results are lightweight by default and only use references for large content.

## Context

SP-36 introduced the `Document` type to unify tool outputs. Every tool returns `Document | Document[]`, which the registry stores in an in-memory `documentService` and serializes to XML (`<document id="uuid">...</document>`) for the LLM message.

This served its purpose but has become a poor fit:

- **Forced overhead**: A `grep` returning 5 lines gets the same UUID + XML envelope + store registration as a 50KB web scrape. Tools like `think` and `glob` aren't "documents" in any meaningful sense.
- **Not MCP-compatible**: MCP tools return `{ content: (TextContent | ImageContent | EmbeddedResource)[] }`. Adding MCP tools would require an adapter layer to bridge two incompatible result shapes.
- **XML token waste**: The `<document id="..." description="...">` wrapper adds ~30 tokens per tool call for no benefit on small results. Most LLM APIs expect plain text or structured JSON in tool results.
- **Conflated concerns**: `Document` serves as both "tool result format" and "large content reference". These should be separate — most tools just return text, a few produce large artifacts that need reference-based passing.
- **Bespoke store**: `documentService` is an in-memory Map that duplicates what session files already provide. `document_processor` uses UUID lookups to retrieve prior results, but file paths would be simpler and more debuggable.

The reference-by-ID pattern for large content is valuable (~50% context efficiency per architecture audit). The goal is to preserve that benefit while dropping the forced wrapping for everything else.

### Current flow

```
Tool handler → Document | Document[]
  → documentService.add(doc)
  → formatDocumentsXml(result) → "<document id=... >text</document>"
  → state.messages.push({ role: "tool", content: xml })
```

### Target flow

```
Tool handler → ToolResult { content: ContentPart[] }
  → resultStore.save(toolCallId, result)
  → serialize(result.content) → plain text string
  → state.messages.push({ role: "tool", content: text })
```

### Existing type collision

`src/types/llm.ts` already defines `ContentPart = TextPart | ImagePart` for LLM message content. The new tool result content parts are a **superset** (adding `ResourceRef`). Strategy: extend `llm.ts` types rather than creating a parallel hierarchy.

## Out of scope

- Database persistence for result store (keep in-memory Map; interface supports future DB)
- MCP server/client implementation (this spec aligns types only)
- Changing `condense.ts` internals (it still returns `{ text, fullPath }`)
- Streaming or chunked tool results
- Multimodal tool result rendering in LLM messages (images stay as file references in text; multimodal LLM calls handled separately by `document_processor`)

## Constraints

- No new runtime dependencies
- All 15 tool handlers must be migrated in one pass (no mixed Document/ToolResult state)
- `condense()` contract unchanged — tools that use it keep using it
- Token counting is the registry's job, not the tool's
- `uri` field on `ResourceRef` uses `file://` scheme for local files. One shared `resolveUri()` helper converts to absolute path.
- Existing event bus events (`tool.dispatched`, `tool.completed`) keep their shape; `result` field changes from XML string to plain text string

## Acceptance criteria

- [ ] `ContentPart` in `src/types/llm.ts` extended with `ResourceRef = { type: "resource"; uri: string; description: string; mimeType?: string }`
- [ ] `ToolResult` interface defined: `{ content: ContentPart[]; isError?: boolean }`
- [ ] Helper functions exported: `text(s)` returns single-text `ToolResult`, `error(msg)` returns error `ToolResult`, `resource(uri, description, mimeType?)` returns a `ResourceRef` content part
- [ ] `ToolDefinition.handler` returns `Promise<ToolResult>` (not `Document | Document[]`)
- [ ] Result store (`src/infra/result-store.ts`) two-phase lifecycle: `create(toolCallId, toolName, args)` before dispatch, `complete(toolCallId, result, tokens)` after. Stores input payload + output. Exposes `get()`, `list()`, `clear()`
- [ ] Registry `dispatch()` accepts `toolCallId` parameter. Calls `resultStore.create()` before handler, `resultStore.complete()` after. Serializes content parts to plain text (no XML), counts tokens
- [ ] Content parts distinguish **content type**, not item count. One text part per result (tool formats multiple items itself), resource refs only for files that `condense()` wrote to disk
- [ ] Serialization rules: `TextContent` → text as-is; `ImageContent` → `[Image: {mimeType}, {size}KB]`; `ResourceRef` → `{description} (ref: {uri})`; parts joined with `\n\n`
- [ ] All 15 tool handlers return `ToolResult`
- [ ] `document_processor` takes `file_paths: string[]` instead of `uuids: string[]` — reads files directly via `files` service
- [ ] `resolveUri(uri)` helper: `file://` → absolute path, throws on unsupported schemes
- [ ] `src/types/document.ts` and `src/infra/document.ts` deleted
- [ ] Agent loop (`loop.ts`) passes `tc.id` to `dispatch()`, uses plain text content (no XML)
- [ ] `bun test` passes
- [ ] End-to-end: agent can scrape a page (returns text + resource ref), then read the full file via `read_file`

## Implementation plan

1. **Extend `src/types/llm.ts`** — add `ResourceRef` type, update `ContentPart` union to include it.

2. **Create `src/types/tool-result.ts`** — define `ToolResult` interface, export `text()`, `error()`, `resource()` helpers. Import `ContentPart` from `llm.ts`.

3. **Update `src/types/tool.ts`** — change `ToolDefinition.handler` return type from `Promise<Document | Document[]>` to `Promise<ToolResult>`. Remove `Document` import.

4. **Create `src/infra/result-store.ts`** — in-memory Map keyed by `toolCallId`. Two-phase lifecycle: `create()` before dispatch (records intent), `complete()` after dispatch (records outcome). Interface:
   ```typescript
   interface ToolCallRecord {
     toolCallId: string;
     toolName: string;
     args: Record<string, unknown>;   // input payload
     result: ToolResult | null;        // null while pending
     tokens: number;
     status: "pending" | "ok" | "error";
     createdAt: number;
     completedAt: number | null;
   }
   ```
   Methods: `create(toolCallId, toolName, args)`, `complete(toolCallId, result, tokens)`, `get(toolCallId)`, `list()`, `clear()`.

5. **Create `resolveUri()` helper** in `src/utils/uri.ts` — converts `file:///path` to `/path`. Throws on unsupported schemes. Used by `document_processor` and any future consumer of `ResourceRef`.

6. **Update `src/tools/registry.ts`**:
   - Import `ToolResult` instead of `Document`
   - `dispatch(name, argsJson, toolCallId)` — new param
   - `tryDispatch()` → call handler, serialize content parts, count tokens, save to result store
   - `serializeContent(parts: ContentPart[]): string` — local function, rules per acceptance criteria
   - Error path: `{ content: [{ type: "text", text: message }], isError: true }`
   - `DispatchResult` becomes `{ content: string; isError: boolean; tokens: number }`

7. **Update `src/agent/loop.ts`**:
   - `dispatch(tc.function.name, tc.function.arguments, tc.id)` — pass tool call ID
   - Use `result.content` instead of `result.xml`
   - Remove `createErrorDocument` / `formatDocumentsXml` imports from crash handler — use inline error string

8. **Migrate simple tool handlers** (10 files — think, grep, glob, bash, read_file, write_file, edit_file, execute_code, geo_distance, shipping):
   - Replace `return createDocument(text, ...)` with `return text(resultString)` (or `return { content: [...] }` for multi-part)
   - Remove imports: `createDocument`, `Document`, `getSessionId`, `documentService`
   - `prompt_engineer` same pattern

9. **Migrate `agents_hub.ts`**:
   - Each action returns `text(JSON.stringify(response))`
   - Batch returns `{ content: results.map(r => ({ type: "text", text: ... })) }`

10. **Migrate `web.ts`**:
    - `download`: return resource ref + text hint
      ```typescript
      return {
        content: [
          resource(`file://${path}`, `Downloaded: ${filename}`, mimeType),
          { type: "text", text: "File saved. Verify contents or process further." },
        ],
      };
      ```
    - `scrape` (multi-URL): tool composes one text part with all summaries (tool owns formatting, e.g. `## url\nSummary...` per URL). Resource refs appended only for URLs where `condense()` wrote a full file to disk. Small scrapes have zero resource refs.
      ```typescript
      return {
        content: [
          { type: "text", text: "## example-a.com\nSummary of A...\n\n## example-b.com\nSummary of B..." },
          resource(`file:///.../scrape-a.txt`, "Full content of A (12KB)"),
          resource(`file:///.../scrape-b.txt`, "Full content of B (8KB)"),
        ],
      };
      ```
    - `delegate`: return `text(result.answer)`

11. **Migrate `document_processor.ts`**:
    - Schema: `file_paths: string[]` replaces `uuids: string[]`
    - Handler: read files directly via `files.readText()` / `files.readBinary()` using paths
    - Remove `documentService` import
    - `resolveUri()` used if paths come as `file://` URIs from prior tool results

12. **Delete `src/types/document.ts` and `src/infra/document.ts`**

13. **Update tests** — all `*.test.ts` files that assert on Document shape or XML output. New tests for `result-store.ts`, `resolveUri()`, and serialization logic.

## Testing scenarios

| What | How |
|------|-----|
| `text()` helper | `text("hello")` → `{ content: [{ type: "text", text: "hello" }] }` |
| `error()` helper | `error("fail")` → `{ content: [...], isError: true }` |
| `resource()` helper | Returns `ResourceRef` with uri, description, optional mimeType |
| `resolveUri("file:///tmp/f.txt")` | Returns `/tmp/f.txt` |
| `resolveUri("https://...")` | Throws unsupported scheme |
| Serialization: text only | `[{ type: "text", text: "hi" }]` → `"hi"` |
| Serialization: text + resource | Two parts → joined with `\n\n`, resource shows description + uri |
| Serialization: image | Shows placeholder with mimeType and size |
| Result store save/get | Store by toolCallId, retrieve same result |
| Result store tokens | Tokens counted from serialized content length |
| Registry dispatch | Handler returning ToolResult → serialized plain text, stored in result store |
| Registry error | Handler throwing → error ToolResult, `isError: true` |
| Simple tool (grep) | Returns `ToolResult` with text content, no Document/XML |
| Web download | Returns resource ref + text hint |
| Web scrape (large) | Returns condensed text + resource ref to full output |
| document_processor | Takes file_paths, reads files directly, returns text answer |
| Agent loop integration | Tool result message content is plain text (no `<document>` tags) |
| End-to-end | `bun run agent "scrape example.com"` → logs show plain text results, resource refs |
