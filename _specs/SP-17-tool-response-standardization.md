# SP-17 Tool Response Standardization

## Main objective

Standardize all tool responses to a `{ status, data, hints }` shape so the
agent gets consistent, actionable feedback from every tool call.

## Context

Audit findings M1–M3 and L2–L3 from the tools-standard review:

- **M1 — No standard response shape.** `bash` and `think` return raw strings.
  `agents_hub` and `geo_distance` return bare objects. The dispatcher wraps
  errors as `{ error }` but successes have no wrapper — the model can't
  distinguish structure across tools.
- **M2 — No hints on success.** No tool tells the model what to do next (e.g.,
  "File saved to X — use Y to verify"). The model must infer next steps from
  raw data.
- **M3 — Errors lack context.** Errors answer "what happened" but not "why" or
  "what to do next". No error points to a prerequisite tool.
- **L2 — No auto-corrections communicated.** When a tool silently corrects input
  (e.g., truncates output), the model isn't told.
- **L3 — No schema defaults.** No schema sets `default` values to reduce what
  the model must fill.

The standard (§5.1–5.6) prescribes:

```typescript
{
  status: "ok" | "error",
  data: { /* minimal relevant payload */ },
  hints?: string[]
}
```

## Out of scope

- Input validation / hardening — covered by SP-16
- Destructive action safeguards (dry-run, checksum) — covered by SP-18
- Bash tool changes — accepted as-is per prior decision
- Changing what tools *do* — only changing how they *report*

## Constraints

- Response shape change is a breaking contract — dispatcher, agent loop, logger,
  and tests all parse tool results. Must update them together.
- Hints are optional — tools that have nothing useful to suggest omit the field.
- Existing log format (`logs/log_*.md`) should still be readable — the markdown
  logger may need to extract `data` for display.
- No new dependencies.

## Acceptance criteria

- [ ] New type `ToolResponse<T>` exported from `src/types/tool.ts`:
      `{ status: "ok" | "error"; data: T; hints?: string[] }`
- [ ] Helper `toolOk(data, hints?)` and `toolError(message, hints?)` exported
      from a new `src/utils/tool-response.ts`
- [ ] Dispatcher wraps all handler results in `toolOk()` and all caught errors
      in `toolError()` — handlers can optionally return `ToolResponse` directly
      to include custom hints
- [ ] `agents_hub` actions include hints:
      - `download` → `"File saved to {path}. Inspect with bash: head -5 {path}"`
      - `verify` → `"Verification submitted for task '{task}'."`
      - `api_request*` → `"Response from /api/{path} received."`
      - `api_batch` → `"Processed {count} rows. Results written to {file}."`
- [ ] `geo_distance` actions include hints:
      - `find_nearby` → `"{count} matches found within {radius} km."` (+ suggest
        narrowing radius if count is high)
      - `distance` → (no hint needed — result is self-explanatory)
- [ ] `think` returns `toolOk({ reasoning: string })` instead of raw string
- [ ] Error responses include "what now" guidance where possible:
      - Missing file → `"Hint: check the path or download it first with
        agents_hub__download."`
      - Invalid JSON → `"Hint: the value must be valid JSON. Check for
        unescaped quotes."`
      - Network failure → `"Hint: the hub may be unreachable. Retry in a moment."`
- [ ] Auto-corrections are communicated:
      - `bash` output truncation → include hint `"Output truncated to 20 KB.
        Full output not available."`
- [ ] Schemas updated with `default` values where applicable:
      - `geo_distance.find_nearby.radius_km` → no default (must be explicit)
      - `agents_hub.api_batch.field_map_json` → default `"{}"` in description
- [ ] Agent loop (`src/agent.ts`) parses the new shape correctly — extracts
      `data` for logging, surfaces `hints` in the markdown log
- [ ] Console logger (`src/services/logger.ts`) handles new shape — shows
      `status` indicator and summarizes `data`
- [ ] All existing tests updated and passing

## Implementation plan

1. **Define `ToolResponse<T>`** in `src/types/tool.ts`. Add `toolOk()` and
   `toolError()` helpers in `src/utils/tool-response.ts` with tests.

2. **Update `dispatcher.ts`** — wrap handler returns in `toolOk()` if they
   aren't already a `ToolResponse`. Wrap caught errors in `toolError()`. This
   makes the change backward-compatible: handlers can return raw values (auto-
   wrapped) or return `ToolResponse` directly for custom hints.

3. **Update `agents_hub.ts`** — return `toolOk(data, hints)` from each action
   with contextual hints. Add error hints for common failure modes.

4. **Update `geo_distance.ts`** — return `toolOk(data, hints)` from each
   action.

5. **Update `think.ts`** — wrap return in `toolOk({ reasoning: result })`.

6. **Update `bash.ts`** — add truncation hint when output is clipped.

7. **Update `src/agent.ts`** — parse `ToolResponse` from dispatch results.
   Pass `data` (not the full wrapper) to the LLM as tool result content. Log
   `hints` separately in the markdown log.

8. **Update `src/services/logger.ts`** — handle new shape in `summarizeResult()`.

9. **Update `src/services/markdown-logger.ts`** — log hints in a `> Hints:`
   block when present.

10. **Add `default` annotations** to schema descriptions where useful.

11. **Update all tool tests** to assert the new response shape.

## Testing scenarios

| Criterion | Test |
|---|---|
| `toolOk` / `toolError` | Helpers produce correct shape; hints are optional |
| Dispatcher auto-wrap | Handler returning bare object → wrapped in `toolOk`; handler returning `ToolResponse` → passed through unchanged |
| Dispatcher error wrap | Thrown error → `toolError` with message |
| Hints present | `agents_hub.download` success → hints array includes file path |
| Error guidance | Missing file error → hints include "download it first" |
| Truncation hint | `bash` with >20 KB output → hints include "Output truncated" |
| Agent loop parsing | Mock dispatch returning `ToolResponse` → agent extracts `data` for LLM, logs `hints` |
| Logger formatting | `summarizeResult` handles `{ status, data, hints }` without crashing |
| Backward compat | Old-style raw returns still work (auto-wrapped by dispatcher) |
