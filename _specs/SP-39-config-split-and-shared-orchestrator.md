# SP-39 Config split and shared orchestrator

## Main objective

Split the overloaded `config/index.ts` into focused modules and extract a shared orchestration layer so CLI and server use identical session, assistant, and state-restoration logic.

## Context

**config/index.ts** currently does four things: path resolution, env-var validation, deep-freeze, and building the config object — including a self-referencing `placeholderMap` lambda that is only consumed by `src/tools/web.ts`. 23 files import config; the module is stable but hard to reason about.

**server.ts** contains HTTP routing (Hono) interleaved with agent orchestration: session management, assistant resolution, system-prompt injection, message persistence. **cli.ts** duplicates the assistant-resolution and message-building logic but skips sessions entirely, meaning `--session` is accepted but never actually restores state.

The goal is:
1. Make config a clean, layered composition (paths → env → object → freeze).
2. Move the `placeholderMap` to its sole consumer (`web.ts`).
3. Extract orchestration into a shared service so both entry points get session persistence, assistant pinning, and state restoration for free.

## Out of scope

- Changing the agent loop (`runAgent`) interface beyond what the orchestrator needs
- Adding new config keys or env vars
- Persistent (on-disk) session storage — sessions remain in-memory
- Refactoring assistant resolution itself (`assistantResolverService`)

## Constraints

- Zero breaking changes to `config.*` access patterns — all 23 importers must work without modification (re-exports from `config/index.ts` preserve the same shape)
- Deep-freeze utility stays inside the config module
- `bun test` must pass after each step
- No new dependencies

## Acceptance criteria

- [ ] `src/config/paths.ts` exports path constants (`projectRoot`, `outputDir`, `logsDir`)
- [ ] `src/config/env.ts` exports validated env values (API keys, optional vars)
- [ ] `src/config/index.ts` composes paths + env into the frozen config object — no path logic, no `process.env` reads, no `placeholderMap`
- [ ] `placeholderMap` lives in `src/tools/web.ts` (its sole consumer)
- [ ] `src/services/agent/orchestrator.ts` exports an `executeTurn()` function that handles: session get-or-create, assistant resolution, system-prompt injection, user-message append, agent execution, post-run message persistence
- [ ] `src/cli.ts` calls `executeTurn()` — always creates/restores sessions (every run is resumable via `--session`)
- [ ] `src/server.ts` calls `executeTurn()` — becomes a thin Hono wrapper (routes, middleware, request parsing only)
- [ ] Existing `config` import shape unchanged — all 23 importers work without edits
- [ ] `bun test` passes

## Implementation plan

1. **Create `src/config/paths.ts`** — move `PROJECT_ROOT`, `OUTPUT_DIR`, `LOGS_DIR` resolution out of `index.ts`. Export named constants.

2. **Create `src/config/env.ts`** — move env-var validation (required + optional keys, the "missing vars" error). Export validated values as a typed object.

3. **Refactor `src/config/index.ts`** — import from `paths.ts` and `env.ts`, compose the final config object, deep-freeze, export. Remove `placeholderMap` from the `web` section.

4. **Move `placeholderMap` into `src/tools/web.ts`** — define the map locally, importing `config.hub.apiKey` directly. No self-referencing lambda needed.

5. **Create `src/services/agent/orchestrator.ts`** — extract from `server.ts`:
   ```
   executeTurn(opts: {
     sessionId?: string;    // auto-generated if omitted
     prompt: string;
     assistant?: string;    // defaults to config.assistant ?? "default"
     model?: string;        // override
   }): Promise<{ answer: string; sessionId: string }>
   ```
   Internally: `sessionService.getOrCreate()` → resolve assistant (pin on first turn) → inject system prompt if new session → append user message → `runAgent()` → persist new messages → return answer + session ID.

6. **Simplify `src/server.ts`** — keep only: Hono app, logging middleware, `/health`, `/chat` route (parse request → `sessionService.enqueue` + `executeTurn` → JSON response). Remove `executeChatTurn`, `pickAssistantName`.

7. **Simplify `src/cli.ts`** — parse CLI args → call `executeTurn()` → print result. Session ID always flows through the orchestrator.

8. **Verify** — `bun test`, manual CLI run with `--session`, manual `/chat` call.

## Testing scenarios

- **Config shape**: existing `src/config/index.test.ts` passes unchanged — validates the frozen object has all expected keys
- **Orchestrator happy path**: new session → executeTurn → returns answer + sessionId; second call with same sessionId restores messages
- **Orchestrator assistant pinning**: first turn sets assistant, second turn with different assistant logs warning and keeps original
- **Orchestrator unknown assistant**: throws with descriptive error
- **CLI --session**: run twice with same session ID, verify second run has prior context in messages
- **Server /chat**: POST with sessionId + msg returns `{ msg }`, session state persists across requests
- **PlaceholderMap**: `web.ts` resolves `{{hub_api_key}}` correctly after the move
