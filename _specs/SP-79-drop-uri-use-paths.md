# SP-79 Drop file:// URIs — use plain paths in ResourceRef

## Main objective

Replace `uri: string` (containing `file://` URIs) with `path: string` (absolute filesystem paths) in `ResourceRef` and all related code. Delete the URI construction/parsing layer entirely.

## Context

SP-61 introduced `ResourceRef` with a `uri` field using the `file://` scheme. In practice the URI layer adds complexity with no benefit:

- **Only one consumer** (`document_processor`) ever parses URIs back to paths, and it also accepts plain paths via a fallback.
- **Construction is broken**: `file://${path}` string interpolation doesn't percent-encode special characters (`#`, `?`, spaces, `%`), producing invalid URIs that can silently truncate filenames or double-decode.
- **No reverse function**: There's `resolveUri()` (URI->path) but no `pathToUri()`. Each tool hand-rolls the concatenation.
- **LLM sees it as opaque text**: Both OpenAI and Gemini adapters filter out ResourceRef parts. The LLM only sees the serialized `"description (ref: file:///...)"` string — the scheme prefix is noise.
- **MCP bridge trusts external URIs**: `mcp.ts` passes through `resource.uri` from external servers without validation.
- All ResourceRefs in this codebase are local files. No http/s3/other schemes exist or are planned.

Plain absolute paths are simpler, correct, and already what every tool produces before wrapping in `file://`.

## Out of scope

- Adding non-file resource types (http, s3) — if needed later, a URI field can be reintroduced at that point
- Changing how `condense.ts` works
- Modifying LLM provider adapters (they already filter out ResourceRefs)
- Session DB migration (JSON content re-serializes naturally on next write)

## Constraints

- No new runtime dependencies
- Single-pass change — no mixed URI/path state
- `bun test` passes after migration
- Backward compatibility for persisted sessions: `document_processor` should tolerate legacy `file://` strings in `path` field during a transition period (simple `startsWith("file://")` strip)

## Acceptance criteria

- [ ] `ResourceRef` in `src/types/llm.ts`: field renamed from `uri: string` to `path: string`
- [ ] `resource()` helper in `src/types/tool-result.ts`: parameter renamed from `uri` to `path`
- [ ] `src/utils/uri.ts` deleted
- [ ] `src/utils/uri.test.ts` deleted
- [ ] `browser.ts` passes plain paths to `resource()` (no `file://` prefix)
- [ ] `web.ts` passes plain paths to `resource()` (no `file://` prefix)
- [ ] `document_processor.ts`: `toAbsolutePath()` removed, `resolveUri` import removed, schema description updated (no "Supports file:// URIs")
- [ ] `document_processor.ts`: legacy compat — if a path starts with `file://`, strip the prefix with a simple slice (no URL parsing). Log a warning. Remove after one release cycle
- [ ] `registry.ts` `serializeContent()`: uses `part.path` instead of `part.uri`, serializes as `{description} (path: {path})`
- [ ] `mcp.ts` `mapMcpContent()`: converts MCP `resource.uri` to absolute path at the boundary (strip `file://` prefix; warn and use raw string for non-file schemes)
- [ ] All tests updated to use plain paths
- [ ] `bun test` passes

## Implementation plan

### 1. Rename field in `ResourceRef` type

**File**: `src/types/llm.ts`

Change:
```typescript
export interface ResourceRef {
  type: "resource";
  uri: string;          // remove
  path: string;         // add
  description: string;
  mimeType?: string;
}
```

TypeScript compiler will flag every usage site.

### 2. Update `resource()` factory

**File**: `src/types/tool-result.ts`

Change parameter name from `uri` to `path`, update the returned object key.

```typescript
export function resource(path: string, description: string, mimeType?: string): ResourceRef {
  return { type: "resource", path, description, ...(mimeType !== undefined && { mimeType }) };
}
```

### 3. Update `resource()` factory tests

**File**: `src/types/tool-result.test.ts`

Change test values from `"file:///tmp/f.txt"` to `"/tmp/f.txt"` and assert on `path` key instead of `uri`.

### 4. Remove `file://` prefix from tool call sites

**File**: `src/tools/browser.ts` (lines 209-210)

```typescript
// Before
resource(`file://${textPath}`, `Page text: ${title}`, "text/plain"),
resource(`file://${structPath}`, `DOM structure: ${title}`, "text/plain"),

// After
resource(textPath, `Page text: ${title}`, "text/plain"),
resource(structPath, `DOM structure: ${title}`, "text/plain"),
```

**File**: `src/tools/web.ts` (lines 53, 107)

```typescript
// Before
resource(`file://${path}`, `Downloaded: ${payload.filename}`, mimeType),
resource(`file://${result.value.fullPath}`, `Full content of ${urls[i]} (${sizeKB}KB)`),

// After
resource(path, `Downloaded: ${payload.filename}`, mimeType),
resource(result.value.fullPath, `Full content of ${urls[i]} (${sizeKB}KB)`),
```

### 5. Simplify `document_processor.ts`

**File**: `src/tools/document_processor.ts`

- Remove `import { resolveUri } from "../utils/uri.ts"`
- Replace `toAbsolutePath()` with a legacy-compat shim:
  ```typescript
  /** Strip legacy file:// prefix if present. */
  function cleanPath(p: string): string {
    if (p.startsWith("file://")) {
      console.warn(`[document_processor] Legacy file:// URI detected, stripping prefix: ${p}`);
      return p.slice(7); // "file:///abs" → "/abs"
    }
    return p;
  }
  ```
- Update schema description: remove "Supports file:// URIs"

### 6. Update registry serialization

**File**: `src/tools/registry.ts` (line 133)

```typescript
// Before
case "resource":
  return `${part.description} (ref: ${part.uri})`;

// After
case "resource":
  return `${part.description} (path: ${part.path})`;
```

### 7. Update registry tests

**File**: `src/tools/registry.test.ts`

Change all `uri: "file:///tmp/f.txt"` to `path: "/tmp/f.txt"` and update expected output from `(ref: file:///tmp/f.txt)` to `(path: /tmp/f.txt)`.

### 8. Convert MCP URIs at boundary

**File**: `src/infra/mcp.ts` (lines 66-73)

```typescript
if (type === "resource") {
  const res = item.resource as Record<string, unknown>;
  const rawUri = res.uri as string;
  let path: string;
  if (rawUri.startsWith("file://")) {
    path = rawUri.slice(7);
  } else {
    console.warn(`[mcp] Non-file URI from MCP resource, using raw: ${rawUri}`);
    path = rawUri;
  }
  return {
    type: "resource",
    path,
    description: (res.text as string) ?? rawUri,
    mimeType: res.mimeType as string | undefined,
  };
}
```

### 9. Delete URI utility

Delete `src/utils/uri.ts` and `src/utils/uri.test.ts`.

### 10. Update `document_processor.test.ts`

Remove or convert the `"supports file:// URIs"` test case to verify the legacy compat shim instead.

### 11. Run tests

`bun test` — fix any remaining compiler errors from the `uri` → `path` rename.

## Testing scenarios

| What | Expected |
|------|----------|
| `resource("/tmp/f.txt", "desc")` | `{ type: "resource", path: "/tmp/f.txt", description: "desc" }` |
| `resource("/tmp/f.txt", "desc", "text/plain")` | Includes `mimeType` |
| `serializeContent([resourceRef])` | `"desc (path: /tmp/f.txt)"` |
| browser navigate | ResourceRef.path is absolute path, no `file://` |
| web download | ResourceRef.path is absolute path, no `file://` |
| document_processor with plain path | Works directly |
| document_processor with legacy `file:///tmp/f.txt` | Strips prefix, logs warning, works |
| MCP resource with `file://` URI | Converted to plain path at boundary |
| MCP resource with non-file URI | Warning logged, raw string stored |
| `bun test` | All pass |

## Risk

**Low**. This is a mechanical rename + deletion with compiler assistance. The `file://` prefix was only added and stripped — never used for actual URI semantics (no scheme dispatch, no encoding, no authority). The legacy compat shim in `document_processor` handles any persisted session data that still contains the old format.