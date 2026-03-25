# SP-49 Input Moderation Guardrails

## Main objective

Add an input moderation layer that checks user prompts against the OpenAI Moderation API and blocks requests that violate content policies before they reach the agent.

## Context

The agent currently has strong sandboxing (file I/O, network, bash commands) and input validation (JSON parsing, filename safety, URL allowlists), but no content-level moderation on user prompts. A user prompt flows from CLI → orchestrator → LLM without any policy check. The OpenAI Moderation API is free to use and provides category-level flagging (hate, self-harm, violence, sexual, etc.) — it's a natural fit for a lightweight guardrail.

The orchestrator (`src/services/agent/orchestrator.ts`) is the right insertion point: it's the single funnel where all user messages enter before being appended to the session and sent to the agent loop.

## Out of scope

- Moderating LLM outputs or tool call arguments (input-only for now)
- Per-category configurable block/warn behavior (all flagged categories block)
- Rate limiting or abuse detection
- Custom content policies beyond OpenAI's built-in categories
- Moderating assistant system prompts or prompt template content

## Constraints

- Must use the OpenAI Moderation API (`openai.moderations.create`)
- Must not add perceptible latency to non-flagged requests (moderation API is fast, ~50-100ms)
- Must reuse the existing OpenAI client from the provider layer — no new API key config
- Must log moderation results (flagged or not) via the existing logger
- Must not break existing tests or the agent flow for clean inputs

## Acceptance criteria

- [ ] A `guardService` (or similar) exists in `src/services/` that calls the OpenAI Moderation API with a text input and returns a structured result (flagged: boolean, categories, scores)
- [ ] The orchestrator calls the guard service before `sessionService.appendMessage()` and throws a descriptive error if the input is flagged
- [ ] Flagged requests never reach the agent loop — the user sees a clear error message listing which categories were violated
- [ ] All moderation calls (flagged and clean) are logged with the markdown logger
- [ ] The guard service is covered by unit tests: flagged input, clean input, API error handling
- [ ] The moderation check can be disabled via config (`config.moderation.enabled`) for local development or testing

## Implementation plan

1. **Add moderation types** — Create `src/types/moderation.ts` with `ModerationResult` interface (flagged, categories map, category scores map)
2. **Create guard service** — `src/services/common/guard.ts` that imports the OpenAI client, calls `openai.moderations.create()`, and maps the response to `ModerationResult`
3. **Add config flag** — Add `moderation: { enabled: boolean }` to `src/config/index.ts`, defaulting to `true`
4. **Integrate in orchestrator** — In `executeTurn()`, call guard service after assistant resolution but before `sessionService.appendMessage()`. If flagged, throw with category details. If disabled via config, skip.
5. **Add logging** — Log moderation results through the existing logger interface (add a `moderation` method or use `info`/`warn` levels)
6. **Write tests** — Unit tests for the guard service covering happy path, flagged content, API failures (should not crash the agent — either block or warn on error)
7. **Error handling** — If the moderation API itself fails (network error, rate limit), decide behavior: default to allowing the request with a logged warning (fail-open), since the moderation is a safety layer, not a hard gate

## Testing scenarios

- **Clean input**: Send a normal prompt → moderation returns `flagged: false` → agent proceeds normally
- **Flagged input**: Send a prompt that triggers moderation → `flagged: true` → orchestrator throws error, user sees category list, agent loop never starts
- **API error**: Mock moderation API failure → guard service logs warning, returns non-flagged (fail-open) → agent proceeds
- **Config disabled**: Set `config.moderation.enabled = false` → moderation API is never called → agent proceeds
- **Logging**: Verify that both flagged and clean results are written to the session log
- **Multi-category**: Input flagged for multiple categories → error message lists all flagged categories
