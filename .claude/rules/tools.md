---
globs: src/tools/**,src/schemas/**
---

# Tool Development Rules

Full standard: `_aidocs/tools_standard.md`. These are the enforced rules.

## Core Assumption

The LLM is untrusted. All tool arguments are attacker-controlled input.
Tools must be safe by construction — never rely on model behaviour.

## File & Export Convention

- Tool: `src/tools/<tool_name>.ts` — exports `default { name, handler } satisfies ToolDefinition`
- Schema: Zod objects co-located in the tool file (not separate JSON files).
  Registered in `src/tools/index.ts`.
- Naming: `snake_case`, unique and unambiguous (`send_email` not `send`)
- Multi-action tools: use `{ action, payload }` handler shape with top-level
  `actions` key in schema. Dispatcher expands to `${tool}__${action}`.
- Return type: `Promise<ToolResult>` from `src/types/tool-result.ts`. Use
  `text(s)` for simple results, `error(msg)` for errors, `resource(uri, desc)`
  for file references. Never return `Document` — that type no longer exists.

## Schema Rules

- `additionalProperties: false` on every object
- All properties in `required`
- No `oneOf`, `anyOf`, type arrays — OpenAI strict mode incompatible
- Descriptions: concise, high signal-to-noise. Never mention shell redirects,
  pipes, or dangerous patterns. State what the tool does, when to use it, what
  it returns.
- Never expose auth tokens, user IDs, or internal record IDs as parameters —
  inject these programmatically in the handler.

## Input Validation (every handler must do this)

1. **JSON parsing**: never raw `JSON.parse()` — use `safeParse()` from
   `src/utils/parse.ts` (wraps in try-catch, labels the field, never echoes
   raw input).
2. **Strings**: enforce max length + char allowlist (prefer `/^[a-zA-Z0-9_.\-]+$/`).
   Reject `..` and leading `/`.
3. **Filenames**: run through `safeFilename()` — `basename()` + char allowlist +
   reject hidden files. Defense in depth on top of file service.
4. **Object keys**: block `__proto__`, `constructor`, `prototype`.
5. **Numbers**: enforce min/max in handler, reject `NaN`/`Infinity`.
6. **Forgiveness** (read-path only): tolerate typos in enums with "did you
   mean…?" suggestions. Trim whitespace, normalize casing. Write-path must
   be strict.

## Sandboxing

- **No general-purpose shell.** Prefer native APIs > fixed commands with
  validated args > command allowlist. Full `bash -c` is last resort and must:
  restrict cwd, reject dangerous chars, set `.timeout(30_000)`, cap output.
- **File I/O**: always use `files` service (`src/infra/file.ts`). Never
  raw `fs`, `Bun.file()`, or `Bun.write()`.
- **Network**: allowlisted hosts only. Never let model control full URL —
  construct from base URL + validated path. Always `AbortSignal.timeout(30_000)`.
- **Resource limits**: truncate output to `MAX_OUTPUT`, check file size before
  reading (reject >10 MB), cap batch arrays (max 1000), limit sequential
  requests in loops.

## Destructive Action Safeguards

Classify every action:
- **Read-only**: input validation only
- **Create**: validate output destination
- **Mutate**: require checksum/version guard (reject if state changed since
  last read)
- **Destroy**: confirmation gate, soft-delete/trash, or disallow entirely
- **Irreversible** (email, external API post): scope-lock to programmatic
  allowlist, or require user confirmation via UI

Support `dryRun: true` for high-impact actions. Consider `.history/` for undo.

## Response Design

Handlers return `ToolResult` (`src/types/tool-result.ts`):
```typescript
import { text, resource } from "../types/tool-result.ts";
// Simple: return text("result string");
// Multi-part: return { content: [{ type: "text", text: "..." }, resource("file:///path", "desc")] };
// Error: throw Error("message"); // dispatcher wraps it
```

- **Success hints**: tell the model what it can do next with the result,
  describing the **capability or goal**, not a specific tool name.
  Format as a separate line: `\nNote: <hint>`.
  Good: `"File saved to X.\nNote: Verify contents or process further."`
  Bad:  `"File saved to X. Use fs_read to verify."` (couples to a tool)
- **Actionable errors**: answer what happened, why, and what to do now.
  Describe what information is missing, not which tool provides it.
  Good: `"team_id required. Fetch the workspace metadata first."`
  Bad:  `"team_id required. Call workspace_metadata to get it."` (couples to a tool)
- **No tool-to-tool coupling**: hints must never reference other tools by
  name. The agent decides which tool to use — the tool just describes what
  is possible or needed. This keeps tools reusable across different agent
  configurations and toolsets.
- **Minimal payloads**: only fields needed for the next step. For large
  results, write to file and return the path.
- **File-based context passing**: tool A writes to file, tool B reads from
  file — avoids re-generating content in the context window.
- **Corrections**: when auto-correcting input, tell the model what changed
  (`"Requested lines 48-70 but file has 59. Loaded 48-59."`)

## Error Handling

- Never leak: file system paths, stack traces, API keys, raw HTTP bodies.
- Log full details internally, return sanitized summary to model.
- Batch failures: write partial results, throw with item index + success count,
  wrap the write in try-catch.

## Prompt Injection Awareness

Prompt injection is unsolved. Design accordingly:
- Damage must be impossible, not merely discouraged
- Limit blast radius to current sandbox
- External content (web, email, uploads) is never injected as instructions
- Log every tool call with arguments and results
- If you can't make an action safe by construction, don't build the tool

## Testing

Tests live next to source: `<tool_name>.test.ts`. Every tool must cover:
- Valid input (happy path)
- Malformed input (bad JSON, missing fields, wrong types)
- Boundary values (empty strings, max lengths, zero/negative numbers)
- Injection attempts (path traversal, prototype pollution, shell metacharacters)