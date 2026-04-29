# SP-93 Typed DomainError taxonomy

## Main objective

Replace every `throw new Error(...)` in `src/` with a typed `DomainError`
class carrying one of 8 fixed categories, so error handling at HTTP, Slack,
CLI, and tool boundaries can switch on `error.type` instead of pattern-
matching on `error.message`.

## Context

Today `src/` has ~118 raw `throw new Error("...")` calls across ~30 files.
At the HTTP boundary (`src/server.ts:198`) the only way to decide a
status code is `message.includes("Unknown agent")` — string matching that
silently breaks if any downstream message is renamed. There is no central
mapping from error category to HTTP status, no separation between
log-only context and wire-safe messages, and no compile-time guarantee
that all error categories are handled at every boundary.

The audit document `_cases/production_hardening_audit.md` finding **2.1**
classifies this as P0 because:
- Misclassified errors mislead clients and corrupt alerting (a renamed
  message string flips a 400 into a 500).
- Retryable vs fatal upstream failures cannot be distinguished, so the
  agent loop reacts identically to OpenAI 401 (auth) and OpenAI 429
  (capacity).
- Error messages currently leak absolute filesystem paths from the
  sandbox layer to the HTTP response.

Wonderlands' `apps/server/src/shared/errors.ts` shows the reference
pattern: 8-variant `DomainError` discriminated union, `toHttpStatus` total
mapping, and per-adapter mappers that convert SDK errors to DomainError
at the provider boundary. This spec ports that pattern.

Every dimension of the audit (especially Topics 2–9 of Stage 3) builds on
typed errors. Doing this first is a deliberate prerequisite.

## Out of scope

- Adding new error categories beyond the 8 listed below. Any new failure
  mode must fit one of the existing categories or trigger a follow-up
  spec.
- HTTP-layer redaction of `internalMessage` is enforced at boundaries
  defined in this spec; broader log-redaction (audit finding 7.1, 7.3) is
  a separate spec.
- Error-cause chains via ES2022 `Error.cause` are supported by the new
  class but populating them in every existing throw is not required —
  only at the SDK boundary mappers and at `safeParse`/`safeFilename`.
- ESLint rule preventing future `throw new Error(...)` is documented as a
  follow-up; not implemented in this spec.
- Catch-side migration in third-party-adjacent files (`evals/`,
  `prompts/`) — not covered.
- The 1 occurrence inside `src/tools/sandbox/prelude.ts` (which runs in
  the Deno sandbox subprocess, not the agent process) is left as-is —
  the sandbox cannot import from `src/types/`.

## Constraints

- **No behavior change for the happy path.** All passing tests must
  continue to pass. No request that succeeds today may fail after the
  migration.
- **HTTP status codes for known errors must improve, not regress.** A
  request that returns 400 today must continue to return 400 (or a more
  precise 4xx). A request that returns 500 today may improve to a 4xx if
  reclassification is correct.
- **No new runtime dependencies.** The change is pure TypeScript using
  existing tooling.
- **Compile-time exhaustiveness on `toHttpStatus`.** Adding a 9th
  variant must produce a TypeScript compile error in `toHttpStatus` until
  the new variant is handled.
- **`message` field is wire-safe.** No throw site may put filesystem
  paths, environment variable names, stack traces, or raw upstream
  responses into the user-facing `message`. All such detail goes in
  `internalMessage`.
- **Tool throw semantics preserved.** `tryDispatch` in
  `src/tools/registry.ts:144` already catches errors and converts them
  into `isError: true` tool results that the LLM sees. After migration,
  tool-thrown DomainErrors must still produce the same shape of tool
  result; the LLM must not see internal details.
- **Migration is a single PR.** No long-lived inconsistency window between
  raw `Error` and `DomainError`.

## Acceptance criteria

### Foundation
- [ ] `src/types/errors.ts` exists, exporting `DomainErrorType`,
  `DomainErrorData`, `DomainError` class, `isDomainError(e)`, and
  `toHttpStatus(type)`.
- [ ] `DomainErrorType` is the literal union of `"validation" | "auth" |
  "permission" | "not_found" | "conflict" | "capacity" | "provider" |
  "timeout"`.
- [ ] `toHttpStatus` is a `switch` over the union with no `default` and
  no fallback `return`. The TypeScript compiler must verify exhaustiveness.
- [ ] `DomainError` extends `Error`. Sets `name = "DomainError"`. Forwards
  `cause` to the `Error` constructor when provided.
- [ ] `DomainError.message` is the wire-safe message; `internalMessage`
  (optional) is the detailed log-only message; `provider` (optional) is
  set when type is `"provider"`.

### In-app throw migration
- [ ] All ~118 `throw new Error(...)` and `throw Error(...)` in `src/`
  (excluding `src/tools/sandbox/prelude.ts` and `src/evals/` and
  `src/prompts/`) replaced with `throw new DomainError({...})`.
- [ ] Each migrated throw uses the category from the inventory in
  `_cases/production_hardening_audit.md` Stage 3 / SP-93 inventory.
- [ ] Throw sites that currently echo absolute paths (`src/infra/sandbox.ts:48,59`,
  `src/agent/agents.ts:30,101`) put the path in `internalMessage`, not
  `message`.

### LLM SDK adapter mappers
- [ ] `src/llm/openai.ts` exports `toOpenAIDomainError(err: unknown):
  DomainError` mapping OpenAI SDK error classes (`AuthenticationError`,
  `RateLimitError`, `BadRequestError`, `PermissionDeniedError`,
  `NotFoundError`, `APIConnectionTimeoutError`, `APIConnectionError`,
  `APIError`) to the right `DomainErrorType`.
- [ ] `src/llm/gemini.ts` exports `toGeminiDomainError(err: unknown):
  DomainError` covering Gemini's status-based errors (400, 401, 403,
  RESOURCE_EXHAUSTED → capacity, network → provider, timeout) since
  Gemini lacks typed error classes.
- [ ] `chatCompletion` and `completion` in both providers wrap their
  body in try/catch and re-throw via the mapper.
- [ ] `src/llm/errors.ts` (`isFatalLLMError`, `extractErrorCode`) is
  removed; its callers (`src/llm/router.ts:51`) replaced with checks
  against `DomainError.type` (`fatal` derived from `type !== "capacity"
  && type !== "provider" && type !== "timeout"`).

### FileSizeLimitError removal
- [ ] `class FileSizeLimitError extends Error` deleted from
  `src/infra/fs.ts`.
- [ ] All `instanceof FileSizeLimitError` replaced with
  `isDomainError(e) && e.type === "capacity"`.
- [ ] All call sites that throw `FileSizeLimitError` replaced with
  `throw new DomainError({ type: "capacity", message: "...",
  internalMessage: "..." })`.

### Catch-side updates
- [ ] `src/server.ts:75–97`, `:115–205`, `:211–242`: catch blocks check
  `isDomainError(err)` first; if so, log `internalMessage` (when set)
  and return `{ error: { type, message } }` with status from
  `toHttpStatus(err.type)`. Unknown errors return generic
  `{ error: { type: "provider", message: "Internal error" } }` with
  status 500.
- [ ] `src/slack.ts:213–224`: catches respect DomainError; reply text
  uses `err.message`, log uses `err.internalMessage ?? err.message`.
- [ ] `src/cli.ts:84–94` (or equivalent exit handler): prints
  user-facing `err.message`, exits 1; in non-prod, also prints
  `err.internalMessage` if set.
- [ ] `src/agent/loop.ts:451–459` (the failure-emit catch):
  preserves DomainError type information in the emitted event.
- [ ] `src/tools/registry.ts:144–157` (`tryDispatch`): unchanged
  semantically, but now uses `err.message` (already user-safe with
  DomainError) for the tool-result text the LLM sees.

### Tests
- [ ] `src/types/errors.test.ts` covers: construction; `cause` round-trip;
  `isDomainError` discriminator; `toHttpStatus` covers all 8 variants.
- [ ] One new test verifies `/chat` returns 404 (not 500) for an unknown
  agent.
- [ ] One new test verifies `/resume` returns 409 (not 500) for a run
  not in `waiting` state.
- [ ] All existing tests continue to pass.

## Implementation plan

The order minimizes mid-PR breakage. Each step compiles cleanly before
the next begins.

1. **Add `src/types/errors.ts`** with `DomainError`, `isDomainError`,
   `toHttpStatus`, and the type aliases. Add `src/types/errors.test.ts`
   covering construction, exhaustiveness, and HTTP status mapping.

2. **Migrate `src/utils/parse.ts` (13 throws).** All 13 are `validation`.
   `safeParse` additionally sets `cause` from the original `SyntaxError`.
   This is the highest-frequency call path; getting it right early
   exposes any DomainError-construction issues.

3. **Migrate `src/utils/hub-fetch.ts` (1 throw).** That throw is
   `provider` with `provider: "ag3nts-hub"`. Adds a precedent for the
   `provider` field.

4. **Migrate `src/agent/` files**: `agents.ts` (5 throws), `context.ts`
   (3), `orchestrator.ts` (1), `resume-run.ts` (3), per the inventory
   classifications. The `agents.ts:30,101` throws move filename detail
   into `internalMessage`.

5. **Migrate `src/infra/` non-LLM files**: `fs.ts`, `sandbox.ts`,
   `mcp.ts`, `mcp-oauth.ts`, `scheduler.ts`, `serper.ts`, `browser.ts`,
   `guard.ts`, `log/markdown.ts`. The `sandbox.ts:48,59,184` and
   `fs.ts:64` throws strip absolute paths from `message`.

6. **Remove `FileSizeLimitError`.** Delete the class. Replace all
   `instanceof FileSizeLimitError` with `isDomainError(e) && e.type ===
   "capacity"` in `src/infra/sandbox.ts:190–191`.

7. **Add LLM SDK adapter mappers**:
   - In `src/llm/openai.ts`, add `toOpenAIDomainError(err)` mapping the
     OpenAI SDK error classes. Wrap `chatCompletion` and `completion`
     bodies in try/catch that calls the mapper.
   - In `src/llm/gemini.ts`, add `toGeminiDomainError(err)` mapping by
     status code and message substrings.
   - Delete `src/llm/errors.ts`. Update `src/llm/router.ts:51` to derive
     `fatal` and `code` from `DomainError`.

8. **Migrate `src/tools/` files** (60+ throws across ~14 files), per
   inventory classification. Tool-error messages remain user-facing
   because `tryDispatch` exposes them to the LLM — no `internalMessage`
   leakage to LLM context.

9. **Migrate the remaining files**: `src/cli.ts`, `src/llm/prompt.ts`,
   `src/config/env.ts`. The `env.ts` throws happen at module load — keep
   them simple (no internalMessage needed).

10. **Update HTTP/Slack/CLI catch sites** (`src/server.ts`,
    `src/slack.ts`, `src/cli.ts`) to use `isDomainError` + `toHttpStatus`.
    The unknown-error fallback returns a generic 500 with no leakage.

11. **Run full test suite + manual smoke tests**: `bun run agent
    "test prompt"`, `curl /chat` with unknown agent, `curl /resume` with
    a non-waiting run, `curl /chat` with malformed body. Verify status
    codes match expectations.

12. **Add a one-paragraph note to `CLAUDE.md`** documenting the
    DomainError convention so future agents (human and AI) know to use
    it for new throws.

## Testing scenarios

### Compile-time
- **TS-1**: Open `src/types/errors.ts`. Add a 9th variant
  `"unsupported_media"` to `DomainErrorType`. Verify `toHttpStatus`
  produces a TypeScript compile error. Revert.

### Unit
- **U-1** (`errors.test.ts`): Construct `DomainError` with each of the 8
  types; assert `e.type`, `e.message`, `e.name === "DomainError"`,
  `isDomainError(e) === true`, `toHttpStatus(e.type)` matches the
  required code (400, 401, 403, 404, 409, 429, 502, 504 respectively).
- **U-2**: Construct `DomainError` with a `cause`; assert the
  `Error.cause` chain is preserved via `e.cause`.
- **U-3**: `isDomainError` returns `false` for `new Error()`, `null`,
  `undefined`, plain objects.

### Boundary
- **B-1** (`/chat` unknown agent): `POST /chat { sessionId, msg,
  assistant: "no_such_agent" }`. Expect status 404, body
  `{ error: { type: "not_found", message: "..." } }`. Server log
  contains the internal detail (`Unknown agent: "no_such_agent"`).
- **B-2** (`/resume` wrong state): `POST /resume` for a runId that is
  `completed`. Expect 409, type `conflict`. (Note: current code returns
  the existing exit idempotently; this test validates the *invalid
  resolution kind* path which throws `validation`.)
- **B-3** (`/resume` mismatched resolution kind): runId waiting on
  `child_run`, resolution kind `user_approval`. Expect 400, type
  `validation`.
- **B-4** (Sandbox path leak): trigger an `Access denied` from
  `sandbox.ts` via a malicious read path. Verify the HTTP response body
  contains a generic message, not the absolute filesystem path. Verify
  the server log contains the absolute path in `internalMessage`.
- **B-5** (LLM rate limit): force OpenAI to return 429 (mock or
  fixture). Expect the run to fail with `DomainError.type ===
  "capacity"` propagated through the loop, observable via the
  `llm.call.failed` event.
- **B-6** (LLM auth): mock OpenAI to throw `AuthenticationError`.
  Expect `DomainError.type === "auth"` and `fatal: true` semantics.

### Integration
- **I-1** (Slack flow): Slack message triggering a tool that throws
  validation (e.g. `shipping` with bad packageid). Verify the bot reply
  contains the user-safe `message`, not stack traces or paths.
- **I-2** (Tool result to LLM): a tool throws a validation
  `DomainError`. Verify `tryDispatch` returns
  `{ content: [{ type: "text", text: "Error: ..." }], isError: true }`
  using `err.message`. Verify `internalMessage` is NOT included in the
  tool result.

### Manual smoke
- **M-1**: `bun run agent "redirect package XYZ"` with a malformed
  package id. Verify the agent receives a useful error and self-corrects.
- **M-2**: `bun run server`, then `curl -X POST localhost:3000/chat`
  with various malformed bodies. Verify each gets the right 4xx code.
- **M-3**: Confirm no test suite regression: `bun test`.

## Notes for follow-up specs

- Topic 2 (transactions) will throw `conflict` for optimistic-lock
  failures.
- Topic 3 (idempotency) will throw `conflict` (key reused with
  different body) and `not_found` (replay of a key that was abandoned).
- Topic 7 (input validation with Zod) will produce `validation` errors
  whose `internalMessage` contains the Zod issue list, while `message`
  stays terse.
- A future ESLint rule (`no-restricted-syntax` against `throw new
  Error`) prevents drift; deferred until after the migration settles.
