# SP-31 Per-request assistant selection

## Main objective

Allow `/chat` callers to specify which assistant to use via `body.assistant`, so the server can host multiple assistants on a single instance without restarting.

## Context

Today the server resolves the assistant **once at startup** from the `ASSISTANT` env var (line 10 of `src/server.ts`). The prompt, model, and tool filter are computed at boot and shared across every request. This means all sessions are locked to a single assistant for the lifetime of the process.

The CLI already supports per-invocation assistant selection (`bun run agent proxy "prompt"`), but the HTTP server does not.

## Out of scope

- Adding new assistants or modifying the assistant YAML format
- Authentication / authorization per assistant
- Changing the CLI assistant selection logic

## Constraints

- Backward compatible: requests without `body.assistant` must still work (fall back to `"default"`)
- Assistant configs are loaded and cached at startup by `assistants` service — no per-request file I/O
- The `ASSISTANT` / `PERSONA` env var config key is removed (no longer used by server)
- Session continuity: once a session is created with an assistant, subsequent messages to the same session should use the same assistant (not switch mid-conversation)

## Acceptance criteria

- [ ] `POST /chat` accepts optional `assistant` field (string) in the request body
- [ ] When `assistant` is provided, the server uses that assistant's config (prompt, model, tools)
- [ ] When `assistant` is omitted, the server falls back to `"default"`
- [ ] When `assistant` names a non-existent assistant, the server returns 400 with available names listed
- [ ] The `config.assistant` env var is removed from server usage (CLI may still use it)
- [ ] Prompt, model, and tool filter are resolved per-request, not at startup
- [ ] Session stores which assistant it was created with; subsequent messages reuse that assistant
- [ ] Existing tests pass; new tests cover the new behavior

## Implementation plan

1. **Move assistant resolution into the `/chat` handler** — read `body.assistant` (default `"default"`), call `assistants.get()`, load prompt, resolve model and tool filter per-request.
2. **Cache rendered prompts** — to avoid re-reading and re-rendering `act.md` on every request, cache by assistant name (the prompt content is deterministic per assistant).
3. **Store assistant name in session** — extend `Session` to include an `assistant` field. On first message, record it. On subsequent messages, ignore `body.assistant` and use the stored one (or warn if they differ).
4. **Remove startup assistant resolution** — delete the top-level `assistantName`, `assistant`, `actPrompt`, `agentModel`, `toolFilter` constants from `server.ts`.
5. **Remove `config.assistant`** from server usage — keep it in config for CLI backward compat if needed.
6. **Update error response** — if assistant name is invalid, return 400 with `{ error: "Unknown assistant 'foo'. Available: default, proxy" }`.
7. **Update tests** — cover: no assistant field (default), valid assistant, invalid assistant, session assistant persistence.

## Testing scenarios

- `POST /chat { msg: "hi" }` → uses `default` assistant → 200
- `POST /chat { msg: "hi", assistant: "proxy" }` → uses `proxy` config → 200
- `POST /chat { msg: "hi", assistant: "nonexistent" }` → 400 with available names
- Two requests to same sessionId with different `assistant` values → second request uses the assistant from the first request (logged warning optional)
- `POST /chat { msg: "hi", sessionId: "s1", assistant: "proxy" }` then `POST /chat { msg: "hello", sessionId: "s1" }` → both use `proxy`
