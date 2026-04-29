---
title: Production Hardening Audit — src/ vs Wonderlands/apps/server
status: STAGE 1 — scope + dimensions, awaiting user sign-off before deep audit
date: 2026-04-29
prior_work: project memory `Gap analysis vs Wonderlands` (2026-04-26) covered structural gaps (subagents, outbox, multi-tenant, file-tracking). This audit is ORTHOGONAL — focused on line-level engineering hygiene, not features.
deployment_context: Long-running server on a VPS (not a one-shot CLI). Process lifecycle, multi-request concurrency, and crash recovery are FIRST-CLASS concerns.
---

# Stage 1 — Scope and dimension picks

## What this audit is

A production-hardening audit of `src/` against the engineering practices in
`Wonderlands/apps/server`. Question per dimension:

> "When this layer fails, crashes mid-flight, gets bad input, or runs concurrently
> with itself — what breaks, and what does the reference do that we don't?"

## What this audit is NOT

- A feature gap. (Already done — see memory `Gap analysis vs Wonderlands`.)
- A code-style review.
- An architectural redesign. We are not migrating to clean architecture in this audit.
- Performance optimization unless it's a stability issue.

## How findings will be reported

Per finding:
- **What** — anti-pattern + `src/file.ts:line` evidence
- **Failure mode** — concrete scenario where this hurts (not abstract)
- **Wonderlands** — `Wonderlands/.../file.ts` how they handle it
- **Fix** — minimal remediation (not a refactor)
- **Severity** — P0 (correctness/security) / P1 (reliability) / P2 (hygiene)

## Method per dimension

1. Grep `src/` for concrete anti-pattern signature.
2. Grep Wonderlands for the inverse / safe pattern in the same domain.
3. Read 1–2 representative call sites fully in each.
4. Write findings.

## Proposed dimensions (10) — please confirm or trim

VPS deployment changes the ceiling: process lifecycle and crash recovery
move from "deferred" to "first-class". Recommendation: all 10, in two
audit passes (1–5, 6–10) so each dimension still gets real depth without
the doc becoming unreadable.

### 1. Idempotency & retries — P0
External POSTs without idempotency keys; retry loops that re-emit events; tool
handlers that mutate state before validating. *Specific worry: AG3NTS hub
submissions, agent run resumption, MCP tool re-invocation.*

### 2. Error taxonomy & propagation — P0
Typed errors vs raw `throw new Error`; `catch {}` swallows; errors that lose
context across `async` boundaries; errors that bubble up but lose the offending
input. *Signal: SP-92 already replaced one ad-hoc error class — likely more.*

### 3. Persistence atomicity — P0
DB writes wrapped in transactions? File writes atomic (tmp + rename + fsync)?
Multi-step state changes that can land half-applied on crash? Drizzle schema
migrations safe under concurrent run?

### 4. Concurrency & races — P0 (raised: VPS handles parallel requests)
Session-level promise queue exists. What is NOT protected when **two HTTP
requests / two Slack events / a Slack event + an HTTP request** hit
simultaneously? Memory persistence, event bus emission ordering, concurrent
tool calls writing to the same output path, prompt-cache reads during
invalidation, SQLite write-lock contention, MCP client connection sharing,
browser singleton (Playwright) under parallel sessions, the global LLM
provider registry. This is now a primary failure mode, not a hypothetical.

### 5. External-call resilience — P1
Every `fetch`/SDK call needs timeout + retry + cancellation. Grep for raw
`fetch(` without `AbortSignal.timeout`, OpenAI/Gemini SDK calls without
backoff, MCP RPC without budget caps.

### 6. Input validation at trust boundaries — P0
LLM tool args (covered by `_aidocs/tools_standard.md`). What's NOT covered:
HTTP routes in `server.ts`, Slack event payloads, MCP server responses
(remote MCPs are untrusted!), incoming hub responses, file path inputs.

### 7. Secrets / PII in logs, traces, errors — P0 (security)
Does any logger or langfuse subscriber serialize tool args or LLM responses
that may contain keys/tokens? Does an error echo `process.env`? Does a stack
trace leak workspace paths? MCP OAuth tokens in events?

### 8. Resource bounds & DoS surface — P0 (raised: public VPS = exposed surface)
File-size caps on reads, output truncation, max event payload size, max
session duration, max tool-call depth (recursive delegate), runaway loops in
the plan/act state machine, max LLM context tokens enforced. On a VPS:
also rate limiting per remote, request body size cap on Hono, Slack
signature replay window, max concurrent runs.

### 9. Process lifecycle & graceful shutdown — P0 (NEW — VPS-driven)
SIGTERM/SIGINT handling, draining in-flight runs, closing DB connections,
flushing the event bus and Langfuse buffer, stopping the Playwright
browser, cancelling outbound `fetch`es, persisting in-memory state that
can be recovered, exit codes. PM2 / systemd restart loops only work if
the process actually terminates cleanly within the kill grace period.

### 10. Crash recovery & startup invariants — P0 (NEW — VPS-driven)
What happens on cold start after `kill -9` / OOM / VPS reboot? Orphan
run reconciliation exists, but: half-written DB rows, locked SQLite
journal files, stale browser profile lock, in-flight tool calls with no
result row, leaked tmp files in `workspace/sessions/.../shared/`,
Langfuse spans never closed, scheduler entries that should re-fire vs
stay dead. Boot must be deterministic and idempotent.

## Dimensions I'm DEFERRING (and why)

- **Test coverage** — orthogonal to hardening; deserves its own audit.
- **Authn/authz / multi-tenant** — covered by prior gap analysis. Even
  on a public VPS, if only you and your Slack workspace hit it,
  signature checks + an allowlist gate the entry; full multi-tenancy
  is overkill until you onboard others. Will surface as a P1 note in
  dimension #6 (input validation) instead of a full dimension.

## Stage gates

- **Stage 1 (this doc)**: scope + dimensions. — *AWAITING SIGN-OFF*
- **Stage 2a**: audit dimensions 1–5 (idempotency, errors, atomicity,
  concurrency, external calls). — *DONE — see `## Stage 2a findings` below*
- **Stage 2b**: audit dimensions 6–10 (input validation, secrets,
  resource bounds, lifecycle, crash recovery). — *DONE — see `## Stage 2b findings` below*
- **Stage 3**: ordered learning queue. We work through findings ONE AT A
  TIME with deep discussion (concept → why it matters → how it manifests
  in your code → how Wonderlands solves it → minimal fix → trade-offs you
  should know → questions you might have). After comprehension is solid,
  you decide whether to implement, defer, or re-prioritize. Order proposed
  below; you can reshuffle.

## Questions for you before I proceed

1. **Scope**: ship all 8 dimensions, or trim to a top 4–5 so I can go deeper
   per dimension? Recommendation: all 8 at moderate depth; you'll learn more
   from breadth here.
2. **Severity bar**: include P2 (hygiene) findings, or stop at P0/P1? P2 adds
   noise but is sometimes the most teachable. Recommendation: include P2 only
   when the same pattern repeats 3+ times.
3. **Wonderlands depth**: cite reference code (file:line) every finding, or
   only when divergence is non-obvious? Recommendation: cite every time —
   "show your work" is the pedagogical contract.
4. **Format**: keep going in this file (`_cases/production_hardening_audit.md`)
   as the deliverable, OR also produce a remediation-spec under `_specs/`?
   Recommendation: keep in `_cases/` until Stage 3, then graduate top items
   to `_specs/HARDENING-*.md` as actionable backlog.

# Stage 2a findings — dimensions 1–5

Reading guide. Each finding is structured as:
- **Where** — file:line in `src/` showing the anti-pattern
- **What breaks** — concrete failure scenario, not abstract
- **Wonderlands** — file:line in the reference doing it correctly
- **Fix** — minimal remediation
- **Severity** — P0 (correctness/security/data loss) / P1 (reliability)

A handful of P2 hygiene items are included only where the same pattern repeats
3+ times.

---

## Dimension 1 — Idempotency & retries

### 1.1 [P0] HTTP routes have no idempotency key handling
**Where**: `src/server.ts:75–97` (`POST /api/negotiations/search`),
`src/server.ts:115–205` (`POST /chat`), `src/server.ts:211–242` (`POST /resume`).

**What breaks**: A client (or a proxy / CI / browser page-refresh) retries
`POST /chat` after a network blip. Your server runs the agent **twice** —
two LLM bills, two side-effecting tool runs (e.g. `shipping.redirect` POSTs to
the hub twice, the second one fails with "already redirected"). For
`/api/negotiations/search` the contract is HTTP-blind: the caller has no way
to tell duplicate work was done. With Slack retries (built in to Slack on
delivery failure) you get the same problem unless dedup is bulletproof.

You do have *one* dedup mechanism: `src/slack.ts:188` keeps an in-memory
`inFlight` Set keyed by `channelId:messageTs`. Three issues:
1. Process restart → the Set is empty → Slack's redelivery (within 1 hour)
   re-fires the agent. Should persist to DB.
2. Only protects Slack. The HTTP `/chat` route has nothing.
3. The Set is never bounded — it leaks on every message. Small leak, but on
   a long-running VPS it accumulates.

**Wonderlands**: `Wonderlands/apps/server/src/adapters/http/idempotency.ts:84` —
`maybeHandleIdempotentJsonRoute` reads `Idempotency-Key` header,
SHA-256 hashes the request body, stores `{key, scope, request_hash, status,
response_data_json, status_code, expires_at}` in a DB-backed
`http_idempotency_keys` table, and on replay it returns the cached response
WITHOUT re-executing the handler. If the same key arrives with a *different*
body hash, it returns 409 (`'idempotency key was already used with a different
request payload'` — line 196). Scopes are namespaced per-route in
`idempotency-scopes.ts:9` (`run.execute:${runId}`, `session.create`, etc.) so
you can't replay a `runCancel` as a `runResume`. Replay TTL is 5 min for
in-progress, indefinite for completed.

**Fix** (minimal, in scope of this audit):
1. **For `/chat` and `/resume`**: require a client-supplied `Idempotency-Key`
   header on every POST. Add a `idempotency_keys` SQLite table:
   `(key TEXT PK, scope TEXT, request_hash TEXT, status TEXT, response_json TEXT, created_at, expires_at)`.
   Wrap each route in a helper: lookup by key → if completed, replay the
   stored response; if in-progress within TTL, return 409; otherwise insert
   row with status='in_progress' and execute, then update with response on
   success / delete on failure.
2. **For Slack dedup**: replace the in-memory `inFlight` Set
   (`src/slack.ts:135`) with the same DB table, scope `slack.message:{teamId}:{channelId}:{messageTs}`.
   Slack guarantees message timestamps are unique per workspace, so this is a
   natural idempotency key.

### 1.2 [P0] Tool calls to side-effecting external APIs have no idempotency
**Where**: `src/tools/shipping.ts:43` (`redirectPackage` POSTs to the hub
package endpoint), `src/tools/agents_hub.ts:88,125` (hub batch + report
endpoints).

**What breaks**: The agent loop retries a tool when the LLM returns the same
tool call twice (it does — see `confirmation.ts` partial denial flows, plus
plain LLM stutter). For `shipping.redirect`, two POSTs = either double-charge
or "package already redirected" error message that confuses the LLM into a
loop. For `agents_hub.report`, two reports = duplicate scoring attempts on the
hub side, possibly resetting the task counter.

There is no `Idempotency-Key` header sent with `hubPost`. The request itself
contains a UUID-ish-but-not-strictly-unique `code` field, so the hub *could*
dedupe — but you don't know that and shouldn't rely on it.

**Wonderlands**: `Wonderlands/apps/server/src/adapters/ai/openai/openai-request.ts:457` —
the OpenAI request adapter passes `idempotencyKey: request.idempotencyKey` to
the SDK. Wonderlands also seeds the key from the run's `responseId` — a
deterministic key per logical operation.

**Fix**:
1. Add an optional `idempotencyKey: string` parameter to `hubPost`
   (`src/utils/hub-fetch.ts:19`) that adds `Idempotency-Key` header when set.
2. In `shipping.redirect`, derive a deterministic key from
   `(packageid, destination, code)` so retries hit the same key. Note: the hub
   may or may not honor the header — check with the AI Devs maintainers, but
   sending it is harmless if ignored.
3. **Internal idempotency**: even without server cooperation, store
   `(toolCallId, hash) → response` in a small in-memory LRU per session so
   the second LLM-driven call within the same run returns the cached response.
   (toolCallId from OpenAI is unique per call, so any "same call again" is a
   replay — return the previous response.) Bonus: this also handles
   `resume-run.ts:117`, where you re-dispatch the original tool call after a
   user_approval; if the user double-approves, you re-run the side effect.

### 1.3 [P1] LLM call retries: provider SDKs retry, the wrapping code does not — but neither *needs* to
**Where**: `src/llm/openai.ts:106` (`new OpenAI({ maxRetries: ... })`),
`src/llm/gemini.ts:148` (`retryOptions: { attempts: ... }`), no retry around
`hubPost` (`src/utils/hub-fetch.ts:19`), no retry around `serper.scrapeUrl`
(`src/infra/serper.ts:12`).

**What breaks**: The OpenAI SDK retries 5xx and 429 by default; you set
`maxRetries` in config. Same for Gemini. Good. But the SDK's retry is
**unaware of your idempotency key**. If you retry a tool call to OpenAI with
the same prompt and the LLM already saw it once and returned a tool call, the
network blip retry creates *a second function call response* — which the
agent loop might double-process. Probability is small because OpenAI's retry
only happens on certain transient errors, but it's there.

The bigger issue is **non-LLM external calls have no retry at all**.
`hubPost` will fail on a single network blip. `scrapeUrl` will fail on a
single 503 from Serper.

**Wonderlands**: `Wonderlands/apps/server/src/adapters/ai/openai/openai-request.ts:455–461` —
`createRequestOptions` returns `{ idempotencyKey, maxRetries, signal,
timeout }`, so retries reuse the same key, which OpenAI then dedupes
server-side. Defense in depth.

**Fix**:
1. Pass `idempotencyKey` to OpenAI/Gemini SDK calls in `src/llm/openai.ts:117`
   and `src/llm/gemini.ts:160` — derive it from `runId + iteration + role`,
   so the *same logical call* is always retried with the same key.
2. Add a small backoff helper for non-LLM external calls: 3 attempts,
   exponential (250ms, 1s, 4s), only on transient errors (5xx, 429, network).
   Apply to `hubPost` and `scrapeUrl`. Wonderlands itself doesn't have a
   custom helper because its provider SDKs cover this — yours don't, for
   non-LLM POSTs.

### 1.4 [P1] Resume is partially idempotent but bypasses the optimistic lock on the dispatched tool side effect
**Where**: `src/agent/resume-run.ts:75–202`.

**What breaks**: The DB-level resume *is* idempotent — line 83-89 returns
early if the run is no longer `waiting`, and line 157 uses an
`expectedVersion` optimistic lock on the status update. Good. **But** the
tool dispatch on line 117 (`await dispatch(call.function.name, ...)`) happens
*before* the optimistic lock check. So: parent gets `user_approval`, two
clients click "approve" simultaneously → both call `resumeRun(runId, ...)` →
both pass the `status === waiting` check at line 83 → both dispatch the tool
(side effect runs twice!) → only one wins the version-locked status update.

The optimistic lock prevents *DB corruption*, not *side-effect duplication*.

**Wonderlands**: Wonderlands acquires a transactional lock that wraps both
the snapshot check AND the action. See
`Wonderlands/apps/server/src/application/runtime/run-concurrency.ts:7` —
`assertRunSnapshotCurrent` is called *inside* `withTransaction(...)` blocks
(e.g. `persist-tool-outcomes.ts:44`), so a concurrent caller hitting the
same run finds its snapshot stale and bails before the side effect runs.

**Fix**: Move the optimistic lock to BEFORE the dispatch, not after. New flow
in `resume-run.ts`:
1. Read run, get version V.
2. Run a "lease" update: `UPDATE runs SET status='resuming', version=V+1
   WHERE id=? AND version=V`. If rowcount=0, return idempotent no-op.
3. Now dispatch the tools — only the winning resumer executes side effects.
4. After dispatch completes, transition `resuming → running`.
5. Add a `resuming` value to the run status enum
   (`src/infra/db/schema.ts:28-37`).

---

## Dimension 2 — Error taxonomy & propagation

### 2.1 [P0] All errors are `throw new Error(string)` — no structured taxonomy
**Where**: 118 raw `throw new Error` / `throw Error` in `src/` (counted
by grep). Examples: `src/agent/orchestrator.ts:277` (`Unknown run`),
`src/agent/resume-run.ts:81` (`Unknown run`), `src/tools/shipping.ts:14,72`,
`src/llm/router.ts:41` (`No provider registered for model`),
`src/agent/loop.ts` throws via `errorMessage(err)` rethrow.

**What breaks**: At the boundaries you must decide:
- HTTP status code (400 vs 404 vs 409 vs 500 vs 502 vs 504)
- Whether to retry
- Whether to log this as a new alert or drop it as expected
- Whether to expose the message to the client or sanitize it

With only message-strings, you decide by `message.includes(...)` — see
`src/server.ts:198`: `const isClientError = message.includes("Unknown agent")`.
Brittle: rename the error and the status code silently changes; an attacker can
craft input that makes any error look like a client error.

**Wonderlands**: `Wonderlands/apps/server/src/shared/errors.ts:1–22` —
`DomainError` is a discriminated union with 8 types: `validation | auth |
permission | not_found | conflict | capacity | provider | timeout`.
`DomainErrorException` wraps it; `toHttpStatus` (line 27) is total — every
type maps to a definite HTTP code (400/401/403/404/409/429/502/504), no
string parsing.

Then per-adapter mappers translate SDK errors to domain errors:
`Wonderlands/apps/server/src/adapters/ai/openai/openai-domain-error.ts:33` —
`toOpenAiDomainError` switches on `instanceof RateLimitError`,
`AuthenticationError`, `BadRequestError`, etc. and maps each to a
`DomainError`. Same in `google-domain-error.ts`,
`openrouter-domain-error.ts`. Your `src/llm/errors.ts:16` (`isFatalLLMError`)
is the right idea — but it returns a boolean, not a typed mapped error.

**Fix**:
1. Add `src/types/errors.ts` (or extend `src/llm/errors.ts`):
   ```ts
   export type DomainErrorType =
     | "validation" | "auth" | "permission" | "not_found"
     | "conflict" | "capacity" | "provider" | "timeout";
   export class DomainError extends Error {
     constructor(public type: DomainErrorType, message: string,
       public cause?: unknown) { super(message); this.name = "DomainError"; }
   }
   export const toHttpStatus = (t: DomainErrorType): number => ({...}[t]);
   ```
2. Replace the most blast-radius-heavy throws first: `orchestrator.ts:277`
   (`not_found`), `resume-run.ts:81,98` (`not_found`, `validation`),
   `agents.ts` `Unknown agent` (`validation`), `llm/router.ts:41`
   (`validation`).
3. Build adapter mappers: `mapOpenAIError(e: unknown): DomainError`,
   `mapGeminiError`, `mapHubError`. Replace
   the `errorMessage(err)` rethrow in `loop.ts:457` with one that captures
   the original cause.
4. In `server.ts:198`, replace string-parse with
   `if (err instanceof DomainError) return c.json(..., toHttpStatus(err.type))`.

### 2.2 [P0] 25+ silent `catch {}` blocks — most lose error context
**Where**: representative cases:
- `src/infra/log/console.ts:38,54` — JSON.parse fails silently in log
  formatter; you might log raw garbage and not know.
- `src/infra/mcp.ts:137,144` — pgrep / process.kill silently absorb errors;
  if SIGTERM permission is denied, stale processes accumulate forever and
  you never find out.
- `src/infra/sandbox.ts:94,196` — JSON.parse / `exists()` errors swallowed.
- `src/agent/session.ts:71,82` — `JSON.parse(fc.content)` silently ignored
  → providerMetadata silently lost on Gemini retries → thoughtSignature
  re-attach fails silently → next call rejected by Gemini with a confusing
  error. (Has bitten you before in SP-91 territory.)
- `src/llm/gemini.ts:68,92` — JSON.parse silenced when extracting tool call
  args / function response. If the LLM returns malformed JSON, you proceed
  with empty `{}` and the tool sees no arguments, returns a generic error,
  and the LLM cannot self-correct because it doesn't know its arguments
  were dropped.
- `src/slack.ts:199,232` — reactions.add/remove silently swallowed (these
  are non-critical, OK).

**What breaks**: Each silent catch is a place where a bug becomes invisible.
The Gemini providerMetadata case is particularly bad — it converts a
"Gemini will reject the next call with a cryptic 400" into a "Gemini just
seems to fail randomly".

**Wonderlands**: `Wonderlands/apps/server/src/adapters/ai/openai/openai-provider.ts:101–169` —
`logOpenAiRequestDebug('error', ...)` is called from every catch block
before re-mapping the error. Errors are *never* dropped without a log line
that includes the relevant request shape (functionToolNames, replay
function-call names, model, runId). The codebase grep also shows almost no
bare `catch {}` blocks — every catch either logs or wraps.

**Fix**: For each silent catch, classify:
- **Truly non-critical** (Slack reactions, log formatter fallback): keep
  silent but add a comment `// non-critical: ...`.
- **Lost context** (Gemini providerMetadata, JSON parse of tool args):
  log at warn with relevant context. For tool args, fail loudly — return a
  domain error to the LLM saying "your arguments were not valid JSON" so it
  can self-correct.
- **Race conditions / "already exists"** (mkdir EEXIST patterns): catch
  *only the specific error code*, rethrow others.

### 2.3 [P1] Errors lose cause chains across async boundaries
**Where**: `src/utils/parse.ts:5–10`:
```ts
export function safeParse<T>(json: string, label: string): T {
  try { return JSON.parse(json) as T; }
  catch { throw new Error(`Invalid JSON for ${label}`); }
}
```
The original `SyntaxError` with the position info is dropped. Same in
`src/agent/orchestrator.ts:233` (`{ kind: "failed", error: { message:
errorMsg, cause: err } }` — note `cause` is preserved here, good — but only
in this one spot).

**What breaks**: When an LLM emits malformed JSON for a complex tool, your
log says `Invalid JSON for shipping.payload` and that's it — no position, no
preview of the raw string. Debug round-trips become longer.

**Wonderlands**: `Wonderlands/apps/server/src/shared/errors.ts:17` keeps the
original `domainError` on `DomainErrorException`; mappers like
`toOpenAiDomainError` preserve `error.message` from the SDK, plus
`requestFunctionToolNames` for context (`openai-domain-error.ts:78`).

**Fix**:
1. Use ES2022 `Error.cause`:
   `throw new Error(`Invalid JSON for ${label}`, { cause: e })`.
2. In your `errorMessage` helper (`src/utils/parse.ts:105`), walk the cause
   chain when formatting. Add `errorChain(err)` returning all messages
   joined by ` ← `.

---

## Dimension 3 — Persistence atomicity

### 3.1 [P0] Multi-row writes in critical paths are NOT in transactions
**Where**: `src/agent/session.ts:124–131`, `src/agent/orchestrator.ts:198–
203`, `src/agent/orchestrator.ts:225–229`.

`persistMessages` (session.ts:124) calls `nextSequence(runId)` then
`appendItems(items)`. The `appendItems` IS transactional (see
`infra/db/index.ts:189`), good. **But**: `persistMessages` is itself called
twice in sequence by `runAndPersist`:
- Line 225: `sessionService.appendRun(sessionId, runId, messages)` — appends
  many items
- Line 226: `persistRunExit(runId, exit)` — updates the run row

Between these two operations, the process can crash. Result: items written,
run still status=`running`. On restart, `findOrphanedWaitingRuns` doesn't
catch this case (it only finds `waiting` runs).

Worse: in `executeRun` (orchestrator.ts:193–203):
1. Line 198: `insertRunRow` (one INSERT)
2. Line 200: `dbOps.setRootRun(sessionId, runId)` (UPDATE on sessions)
3. Line 201: `dbOps.updateRunStatus(runId, { status: "running" })` (UPDATE)
4. Line 203: `sessionService.appendMessage(sessionId, runId, ...)` — INSERT
   into items, plus `touchSession` UPDATE.

Five separate writes. Any crash in between leaves a half-state. After a
crash between (1) and (3), the run is `pending` forever — no reconciliation
sweep handles `pending` runs.

**Wonderlands**: `Wonderlands/apps/server/src/application/runtime/execution/tools/persist-tool-outcomes.ts:111`
— `withTransaction(context.db, (tx) => { ...all repository writes... })`
wraps the entire multi-step persistence (assert run version, append events,
create tool execution rows, create run-dependency rows, append items) in
ONE transaction. Either the whole tool outcome is persisted or none of it.

`Wonderlands/apps/server/src/db/transaction.ts:7` — `withTransaction(db,
execute)` — single-line helper, used 50+ times across the codebase.

**Fix**:
1. Add a `withTransaction(fn)` wrapper in `src/infra/db/index.ts`:
   ```ts
   export function withTransaction<T>(fn: (tx) => T): T {
     return db.transaction((tx) => fn(tx));
   }
   ```
2. Wrap `executeRun`'s setup block (lines 198–203) in a single transaction.
3. Wrap `runAndPersist`'s "append messages + persist exit" pair (lines 225–
   226) in a single transaction.
4. Wrap `resume-run.ts:154–169` (append synthetic messages + status
   transition) in a single transaction.
5. Add a `pending` reconciliation sweep to startup that fails any run stuck
   in `pending` for >N seconds.

### 3.2 [P1] File writes are not atomic — except for ONE place
**Where**: `src/infra/fs.ts:23` — `await Bun.write(path, data)`. Direct
overwrite. Used by `src/agent/memory/persistence.ts:20` (memory state),
`src/infra/log/markdown.ts`, `src/infra/log/jsonl.ts`,
`src/infra/condense.ts`, etc.

**What breaks**: Process killed mid-write. The file on disk is truncated to
zero or partially overwritten. On next boot, `loadState` (memory/
persistence.ts:23) reads garbage, `safeParse` throws "Invalid JSON for
memory-state", and the memory system silently falls back to
`emptyMemoryState()` — losing all memory the agent had built up.

The single counter-example is `src/infra/browser.ts:56–58`, which writes to
`.session-{ts}.tmp` then renames. That's the right pattern. It is used
nowhere else.

**Wonderlands**: `Wonderlands/.../adapters/sandbox/engines/lo/local-dev-lo-engine.ts:209`
— `const temporaryPath = ${input.responsePath}.tmp` followed by write +
rename. Atomic-write is the convention.

**Fix**: Add `writeAtomic(path, data)` to `src/infra/fs.ts`:
```ts
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${Date.now()}.${randomUUID()}.tmp`;
  await Bun.write(tmp, data);
  await rename(tmp, path);
}
```
Replace `Bun.write(...)` in `memory/persistence.ts:20`, jsonl writers, and
the markdown logger's flush. (Append-mode files like jsonl are a slightly
different problem — for those, `fsync` after each write or accept the loss.)

### 3.3 [P1] No SQLite synchronous mode set; default may be NORMAL not FULL
**Where**: `src/infra/db/connection.ts:13–14`. Sets `journal_mode = WAL`
(good) and `foreign_keys = ON` (good). Does NOT set `synchronous`.

**What breaks**: Bun's `bun:sqlite` defaults to whatever SQLite's compile-time
default is — usually `NORMAL` in WAL mode. NORMAL means a power loss / VPS
hard-reset can lose the *last* committed transaction even though `commit`
returned. For an agent session DB this is mostly fine, but for the
idempotency key table (when you add it for #1.1), losing the last commit
could mean replaying a side-effecting POST.

**Wonderlands**: `Wonderlands/apps/server/src/db/sqlite-adapter.ts` — sets
SQLite pragmas at boot; verify yours.

**Fix**: Add `sqlite.run("PRAGMA synchronous = FULL")` for hard
durability, OR `synchronous = NORMAL` and accept the small loss but add
`PRAGMA wal_autocheckpoint = 1000`. For your VPS (probably not battery-backed
disk), `FULL` is the right default.

### 3.4 [P1] Memory state save is not gated by run lifecycle
**Where**: `src/agent/loop.ts:296–304`. `createMemorySaver` writes
`memory-state.json` on every cycle. Multiple parallel runs in the same
session (which now happens on the VPS — see dimension 4) all write the same
file. Last-writer-wins. Not even atomically (see #3.2).

**What breaks**: Two parallel runs in the same Slack thread → both write
memory-state.json → corrupt or one's memory is silently overwritten.

**Fix**: Either (a) include `runId` in the filename so each run has its own
state file and a session-level merge happens at end of run, or (b) acquire
a session-level mutex around the write — and use atomic write per #3.2.

---

## Dimension 4 — Concurrency & races (VPS-critical)

### 4.1 [P0] HTTP `/chat` enqueues onto a per-session promise queue, BUT every other entry point bypasses it
**Where**: `src/agent/session.ts:184–193` defines the queue. `src/server.ts:155,
184` use `sessionService.enqueue(sessionId, ...)`. **But**:

- `src/slack.ts:211` — `await executeRun({ sessionId, prompt: text })` — NOT
  enqueued. Two messages in the same Slack thread fire two `executeRun`s in
  parallel.
- `src/server.ts:83` — `executeRun({ prompt: params, assistant: "negotiations" })`
  — no sessionId provided, but multiple concurrent requests still create
  multiple parallel runs which all share the global singletons (LLM
  registry, MCP client map, browser).
- `src/agent/run-continuation.ts:38` — `resumeRun(parent.id, ...)` from the
  bus subscriber — NOT enqueued; if a child completes while a /chat for the
  same session is mid-flight, you get parallel executions.
- `src/agent/orchestrator.ts:166` — `kickChildRunAsync` — fires a child
  run NOT inside the session queue.

**What breaks**: All the singletons that don't hold per-session state are
fine. The shared singletons that DO are: `bus` (events.ts), `sessionService`
(session.ts:285), the LLM registry (llm.ts:24), MCP servers (mcp.ts), the
browser (browser.ts), the markdown logger (one per run, but its
`md.filePath` is timestamp-based so collisions on same-millisecond runs are
possible). Most are stateless or per-run, so this is mostly OK except:
1. **Markdown logger filename collision** — `MarkdownLogger` initializes with
   `init(prompt)` and writes to a file derived from session+timestamp. Two
   simultaneous runs in the same session at the same second → same filename →
   one overwrites the other.
2. **DB optimistic-lock thrash** — two `resumeRun`s on the same parent
   compete; the loser silently no-ops (per #1.4 you may run side effects
   twice).
3. **AsyncLocalStorage context leakage** — if two parallel `runAgent` calls
   share an AsyncLocalStorage frame at any point, getSessionId() returns the
   wrong session. AsyncLocalStorage *should* isolate them, but this is the
   class of bug that's invisible until it isn't.

**Wonderlands**: It uses an `ActiveRunRegistry`
(`Wonderlands/apps/server/src/application/runtime/active-run-registry.ts`)
keyed by runId — registers the AbortController on entry, unregisters on
exit. Per-run isolation, plus an explicit abort path. Concurrency model is
"one run per runId at a time" enforced at the runtime layer, not the HTTP
layer.

**Fix**:
1. Push the session-queue enqueue down into `executeRun` itself, not the HTTP
   layer. So *every* entry point is serialized per-session: HTTP, Slack,
   continuation subscriber, child-run kicker.
2. For the markdown logger: include `runId` in the filename, not timestamp
   alone.
3. Add a process-wide `ActiveRunRegistry` similar to Wonderlands so an admin
   can list/cancel in-flight runs.

### 4.2 [P1] Event bus has no per-listener queue — synchronous emit can interleave
**Where**: `src/infra/events.ts:33–49`. `emit()` calls listeners synchronously
in a `for` loop. If a listener is async (returns a Promise), the bus does
NOT await it. The next event can be emitted while the listener is still
processing the previous one.

**What breaks**: The Langfuse subscriber and the JSONL writer are async.
Under high event throughput (e.g. a tight tool batch), event A's processing
overlaps with event B's processing. The JSONL file may have lines out of
order, or interleaved (since `Bun.write` for append is not atomic for >1 line).

The Slack `createStatusUpdater` listener (slack.ts:83) is sync but mutates
shared state (`latestText`, `timer`). Under concurrent emits from a parallel
run on the same session, you get interleaved updates.

**Wonderlands**: Wonderlands uses an event outbox (DB table) with a separate
worker (`event_outbox` schema, `events.ts:40`). Events are persisted in a
transaction, then drained by a worker — this serializes delivery and
guarantees no loss. You don't need the full outbox today, but **you do need
a per-listener queue** so async listeners don't interleave.

**Fix**: Wrap async listeners in a per-listener queue:
```ts
function asyncQueued<T>(handler: (e: T) => Promise<void>) {
  let chain: Promise<void> = Promise.resolve();
  return (e: T) => { chain = chain.then(() => handler(e)).catch(() => {}); };
}
```
Apply to the Langfuse subscriber, JSONL writer, and Slack status updater.

### 4.3 [P1] `inFlight` Set in Slack is non-atomic check-and-add
**Where**: `src/slack.ts:188–189`.
```ts
if (inFlight.has(dedupeKey)) return;
inFlight.add(dedupeKey);
```
JS is single-threaded so this *particular* sequence is atomic, BUT: Slack
delivers retries that cross the await boundary at line 193+. If Slack
delivers retry 1 at ts=0, you add the key, await line 211 (executeRun),
Slack delivers retry 2 at ts=2 (its 1-min retry window), and **only if
executeRun completed and the `finally` block at line 224 deleted the key
already** can the retry get through.

**What breaks**: For long-running agent runs (many seconds), the dedup
window is "duration of the run" — fine. For very short runs that complete
faster than Slack's retry window, the second retry sneaks through. Slack's
default retry is 3 attempts at delays like 1s/2s/4s; a run completing in
sub-second can get re-fired.

This is also a P1 because the Set is unbounded — see #1.1.

**Fix**: Move dedup to DB (per #1.1) so it survives the run lifetime, with a
TTL of 1h (Slack's longest retry window).

### 4.4 [P1] Browser singleton shared across runs
**Where**: `src/infra/browser.ts` — Playwright browser instance is a module-
level singleton. Two parallel runs that both call `browser`-using tools
share the same browser. State (cookies, localStorage, current page URL)
bleeds between runs.

**What breaks**: Run A logs into a site. Run B navigates to the same site
and inherits A's cookies. For your AI Devs course this is mostly fine, but
on a VPS exposed to multiple users it becomes a privilege-escalation route.

**Wonderlands**: Wonderlands isolates per-run via the sandbox engine
(`Wonderlands/apps/server/src/adapters/sandbox/`), which spins up a fresh
process per execution — heavy but bulletproof.

**Fix** (cheap): Use a fresh `BrowserContext` per run rather than a fresh
browser. `browser.newContext()` is cheap; close on run end. Add a per-run
context registry keyed by runId.

---

## Dimension 5 — External-call resilience

### 5.1 [P1] Timeouts on every external call — but values are not differentiated
**Where**: All external calls have `AbortSignal.timeout(...)`. Good.
- `src/llm/openai.ts:118,134` — `config.limits.openaiTimeout`
- `src/llm/gemini.ts:168,209` — `config.limits.geminiTimeout`
- `src/utils/hub-fetch.ts:29` — caller-provided, default 30s
- `src/infra/serper.ts:20`, `src/tools/web.ts:41` — `config.limits.fetchTimeout`
- `src/infra/mcp.ts:302` — `config.limits.fetchTimeout`

The issue: there's likely one generic `fetchTimeout` used for everything.
LLM calls legitimately need 60–120s for long completions; web scraping
should fail fast at 10–15s; MCP RPC timeouts depend on the server.

**What breaks**: One stuck remote MCP server holding a 60s timeout slot
serializes all your concurrent /chat requests' MCP calls behind it (or
worse, blocks shutdown — see dimension 9).

**Fix**: Differentiate in `src/config/index.ts`:
- `llm.openaiTimeout = 120_000`
- `llm.geminiTimeout = 120_000`
- `web.scrapeTimeout = 15_000`
- `mcp.callTimeout = 30_000`
- `hub.postTimeout = 30_000`

Pass each to its caller explicitly.

### 5.2 [P1] No circuit breaker — repeated failures keep retrying
**Where**: All providers. The OpenAI/Gemini SDK retries on its own (good),
but if OpenAI is down for an hour, every incoming `/chat` request burns
60s × N retries before failing. No fast-fail.

**What breaks**: Your VPS becomes unresponsive during provider outages
because every request queues behind an LLM timeout.

**Wonderlands**: The provider error mapping
(`openai-domain-error.ts:33–120`) returns typed errors that the upstream
caller can use to decide circuit logic. There isn't a built-in circuit
breaker but the typed errors enable one to be added on top.

**Fix**: Add a small circuit-breaker wrapper in `src/llm/router.ts`:
- Track consecutive failures per provider.
- After N=5 consecutive `provider`-typed errors within a 1-minute window,
  open the circuit for 30s (fail fast with `capacity` error).
- Half-open after 30s — let one request through. Success closes the circuit.

This is a small file (40 lines), and it makes a big stability difference on
a VPS with public traffic.

### 5.3 [P0] No request body size cap on Hono routes (DoS surface)
**Where**: `src/server.ts:51`. Hono `app` is created with no body-size middleware.
`/chat`, `/resume`, `/api/negotiations/search` will accept arbitrarily large
bodies (until Bun's default of 100MB+).

**What breaks**: Attacker sends 100MB JSON to `/chat`. Bun parses it, your
moderation API receives the full prompt, OpenAI rejects it (eventually) —
but in the meantime the VPS has held 100MB in memory and used CPU on
moderation. Three or four concurrent attackers OOM the box.

**Wonderlands**: `Wonderlands/.../app/middleware/request-size-guard.ts:6` —
`requestSizeGuardMiddleware(maxBytes)` reads `Content-Length`, returns 413
if over limit. Applied app-wide.

**Fix**: Add the same middleware in `src/server.ts:51`, cap at 1MB by
default. Slack's `/chat` payload is small; AI Devs negotiation payloads are
small. 1MB is generous.

### 5.4 [P0] No request rate limiting (DoS / cost-bombing surface)
**Where**: `src/server.ts` has no rate limiter at all.

**What breaks**: Your `/chat` endpoint, once known, can be hit at 100 RPS by
a hostile or buggy client. Every request fires an LLM call. You burn through
your OpenAI quota in minutes. Your `apiSecret` (line 63) protects against
this if set, but:
- Negotiations endpoint at line 75 has NO auth.
- Slack signature is not verified (you depend on Bolt's Socket Mode, which
  IS authenticated by app token — but if you ever switch to events API,
  you need signature verification).

**Fix** (in scope of #5):
1. Add a simple in-memory token-bucket rate limiter middleware to Hono:
   N requests per IP per minute, configurable per route.
2. For long-term: front the VPS with Caddy / Nginx with rate limiting at the
   edge, but app-level is a defense-in-depth must.

### 5.5 [P1] MCP calls do not constrain max payload size returned
**Where**: `src/infra/mcp.ts:299–322`. A remote MCP server returns
`result.content` and `result.structuredContent`. Your code does inline
inlining of structuredContent <= 3KB tokens (line 109), then writes large
payloads to disk. Good for that field. **But**: nothing bounds the size of
`result.content` itself or the stringified return from `mapMcpContent`. A
hostile/buggy MCP server can send 100MB of "text" content; you put that in
your tool result, which goes into the LLM context, which OpenAI rejects with
a context-window error after you've paid for the token count.

**Fix**: Cap `mapMcpContent` text parts at e.g. 200KB each (config.limits)
and truncate with a warning note appended.

### 5.6 [P2] (pattern repeats 3+) `fetch` retry has no backoff jitter
**Where**: `src/infra/mcp.ts:264–266` — `delay = 1000 * (attempt + 1)`. Linear
backoff, no jitter. Single-instance app so thundering-herd isn't a real
concern, but on a VPS that PM2 restarts on crash, two restarts back-to-back
will retry MCP connect at exactly the same offsets.

**Fix** (low priority): Add jitter — `delay = 1000 * (attempt + 1) +
Math.random() * 500`. One-line change, gives free isolation between
restart waves.

---

## Stage 2a summary

P0 findings (8): 1.1, 1.2, 1.4, 2.1, 2.2, 3.1, 4.1, 5.3, 5.4
P1 findings (10): 1.3, 2.3, 3.2, 3.3, 3.4, 4.2, 4.3, 4.4, 5.1, 5.2, 5.5
P2 (1): 5.6

The most concentrated risk is around **DB-level idempotency + transactions
+ optimistic locking**: items 1.1, 1.2, 1.4, 3.1, 4.1 all share a common
foundation. Building one helper module
(`src/infra/db/idempotency.ts`, `withTransaction`, push enqueue down into
`executeRun`) closes 5 of the 8 P0s.

The next concentrated risk is the **DoS surface** on the VPS server: items
5.3, 5.4 are 30 lines of Hono middleware away from being closed.


# Stage 2b findings — dimensions 6–10

Same finding format as Stage 2a. VPS-deployment context applies — every
finding here assumes the server takes inbound traffic from the public
internet, Slack, and your AG3NTS hub callbacks.

---

## Dimension 6 — Input validation at trust boundaries

### 6.1 [P0] HTTP route body parsing relies on shape-only checks, no schema validation
**Where**: `src/server.ts:18–39` (`parseChatBody`), `src/server.ts:75–80`
(`/api/negotiations/search`), `src/server.ts:212–218` (`/resume`).

`parseChatBody` does five `typeof === "string"` checks. `/resume` accepts
`resolution` as `Record<string, unknown>` and casts it `as any` at line 225
before passing to `resumeRun`. `/api/negotiations/search` only checks
`params` is a string.

**What breaks**:
1. **Type confusion** — submitting `{"sessionId": "x", "msg": ["malicious", "array"]}`
   passes the string check (msg is the second arg)... wait, line 19 does
   verify `msg` is a string. OK. But `requestedAssistant` could be the
   string `"../../etc/passwd"` and `agentsService.get(name)` (`agents.ts:99`)
   uses it as a filename: `resolve(AGENTS_DIR, '${name}.agent.md')`.
   The `safeFilename` helper exists in `parse.ts:19` — but it's NOT
   called by `agents.ts:99`. **Path traversal opportunity**: a hostile
   `requestedAssistant: "../../tools/registry"` reads the registry source
   file as if it were an agent definition, fails `validate()`, but the
   error message *includes the path* (line 30: `Invalid agent
   "../../tools/registry.agent.md": missing required field "name"`),
   leaking project structure.
2. **Resolution `any` cast** — `/resume` line 225 trusts that the
   `resolution` payload is well-formed. `resumeRun` does some shape
   checking (e.g. `resolution.kind === waitingOn.kind` at line 96) but
   relies on type-assertions for everything else. A `resolution: { kind:
   "child_run", result: <enormous string> }` from a malicious caller is
   just inserted into the message history and re-fed to the LLM.

**Wonderlands**: Wonderlands uses Zod-validated request DTOs at every HTTP
route boundary (search the `routes/v1/*.ts` files — every route validates
its body before passing to the handler). Plus the
`request-size-guard.ts` middleware caps the total body size, and
`access-log.ts` logs `requestId/traceId` for forensics
(`Wonderlands/.../app/middleware/access-log.ts:38`).

**Fix**:
1. Define a Zod schema per route in `src/server.ts`:
   ```ts
   const ChatBody = z.object({
     sessionId: z.string().min(1).max(120),
     msg: z.string().min(1).max(50_000),
     assistant: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(50).optional(),
     stream: z.boolean().optional(),
   });
   ```
2. In `agents.ts:99`, call `safeFilename(name)` *before* `resolve()`. Better:
   restrict `name` to a known regex.
3. Define a `WaitResolution` Zod schema and parse `body.resolution` against
   it at `server.ts:218`, removing the `as any` cast at line 225.

### 6.2 [P0] No Slack request signature verification — but Bolt covers it for Socket Mode
**Where**: `src/slack.ts:109–113`. Uses `socketMode: true` with a Slack app
token. In Socket Mode, the WebSocket connection itself is authenticated via
the app token, so individual events do NOT need signature verification.
Currently safe.

**What breaks**: The day you switch to events API (recommended for higher
reliability — Socket Mode can drop events on long-running runs), you
*must* verify the `x-slack-signature` header. Forgetting that step turns the
Slack endpoint into "anyone with the URL can fire your agent". This is a
P0 with a "future trip wire" character.

**Fix**: Add a TODO + comment in `slack.ts:113`:
`// SOCKET MODE: relies on app token. If switching to events API, add bolt's
verifyRequestSignature using SLACK_SIGNING_SECRET.`

### 6.3 [P0] MCP server responses are trusted as well-formed
**Where**: `src/infra/mcp.ts:57–89` (`mapMcpContent`). The MCP protocol is
JSON-typed but every field comes from a remote process. Code accesses:
- `item.text as string` — trusts type
- `item.data as string` (image base64) — no length cap
- `item.mimeType as string` — used in your tool result, displayed to LLM
- `res.uri as string` — used as a path after `slice(7)` (line 75) →
  resource ref content part with `path: ...`. **Not validated** —
  a malicious MCP can return `file:///etc/passwd` and your sandbox
  layer might (depending on call site) read it.

`mcp.ts:299` calls `srv.client.callTool(...)` then
`Array.isArray(result.content) ? mapMcpContent(...) : ...`. Result content is
trusted. `result.isError === true` is honored as a flag (line 317), but if a
malicious server omits it on actual errors, the agent treats them as success.

**What breaks**: A malicious or compromised remote MCP can:
- Inject arbitrary text into tool results that contain instructions for the
  LLM (prompt injection on a privileged path — your tool registry).
- Provide a path that, when later passed to `read_file` etc., reads
  unrelated files.
- Provide gigabytes of `text` content (no length cap) to OOM your VPS or
  burn your LLM budget.

**Wonderlands**: Wonderlands sandbox-quarantines tool runs through
controlled adapters (`adapters/sandbox/`), and tool outputs go through a
typed `ToolExecutionResult` validation. They don't trust raw string fields
from remote sources.

**Fix**:
1. In `mapMcpContent`, validate `item.mimeType` against an allowlist
   (text/*, image/png, image/jpeg, application/json, etc.). Reject others.
2. Cap `item.text.length` (e.g. 200KB), truncate with notice.
3. Validate URIs with a strict scheme check: `file://` AND the path lives
   under `WORKSPACE_DIR` after `resolve()`. Reject `..`, reject anything
   outside.
4. Even better: have remote MCP return `file://session/...` paths
   (relative-ish to session dir) that the sandbox resolves itself, not raw
   absolute paths.

### 6.4 [P0] Hub responses are not schema-validated
**Where**: `src/utils/hub-fetch.ts:32–41`. Reads JSON, falls back to text on
parse failure. Returns `unknown`. Callers in `src/tools/shipping.ts:56–58`
inspect `response.confirmation` via `(response as Record<string,unknown>)
.confirmation`. No schema check.

**What breaks**: The hub returns a non-2xx with a JSON body like
`{ error: "...", code: 999 }` that you pass back to the LLM as if it were
the success payload. Or the hub returns `{ confirmation: "<script>..."}`
and that ends up in the Slack reply or the markdown log. Cross-context
injection risk.

**Fix**: Co-locate Zod schemas per hub action; parse responses through them.
On parse failure, log full response internally, return a generic error to
the LLM.

### 6.5 [P1] File path inputs in tools are validated locally per tool, but inconsistently
**Where**: `safeFilename` in `parse.ts:19` exists. `safePath` exists. But
they're not uniformly applied:
- `src/tools/read_file.ts`, `write_file.ts`, `edit_file.ts` — verify in those
  tools (assumed).
- `src/agent/agents.ts:99` (above) — does NOT use safeFilename.
- `src/agent/memory/persistence.ts:11` — uses `sessionId` in path; if a
  malicious session ID like `../foo` slips through, traversal. Currently
  `randomSessionId()` is the source, so trusted, but the
  `MarkdownLogger` constructor (`infra/log/markdown.ts:45`) DOES validate
  with `SAFE_ID` — good. The discrepancy means there's no central
  enforcement.
- `src/server.ts` accepts `sessionId` from request body and passes it
  straight to `executeRun`. Validation only happens when something
  downstream parses it as a path.

**Fix**: Centralize. Add `safeSessionId(s: string)` in `parse.ts`, validate
once at every entry point: HTTP body parse, Slack message handler,
scheduler. Reject anything that doesn't match `/^[a-zA-Z0-9_-]+$/`.

### 6.6 [P1] `fileService.exists` returns `true|false` — but `false` from access denial vs nonexistent are indistinguishable
**Where**: `src/infra/sandbox.ts:90–96`.
```ts
async exists(path: string): Promise<boolean> {
  try { assertRead(path); return await fs.exists(path); }
  catch { return false; }
}
```
Same boolean for "this file does not exist" and "you tried to read outside
your sandbox". Caller has no way to distinguish.

**What breaks**: A tool that calls `exists()` to gate behavior (e.g. memory/
persistence.ts:27) can be tricked: pointing at a path outside sandbox makes
it look like the file doesn't exist, then a subsequent `write` (which
re-checks and DOES throw) fails with a confusing error.

**Fix**: Distinguish: throw on access-denied (or return a tagged result).
Only return `false` for genuine ENOENT.

---

## Dimension 7 — Secrets / PII in logs, traces, errors

### 7.1 [P0] Langfuse subscriber sends EVERY tool input and LLM message verbatim
**Where**: `src/infra/langfuse-subscriber.ts:241–253` —
`tool.called` handler sends `e.args` (the full tool argument JSON) to
Langfuse as the `input`. `langfuse-subscriber.ts:209–234` —
`generation.completed` sends `e.input` (the entire prompt array, including
all message history) and `e.output`.

**What breaks**: Tools like `agents_hub.ts`, `shipping.ts`, `web.ts` may
receive arguments from the LLM that contain user-supplied secrets, hub API
keys (e.g. `apikey: config.hub.apiKey` in shipping.ts:24 is *injected*, not
LLM-provided — but the LLM could also see hub responses that include keys).
The full message history includes the user's original prompt — which may
contain credentials, PII, or proprietary info. All shipped to Langfuse
Cloud.

This is also a privacy/compliance question — Langfuse is a third-party SaaS
unless you self-host. For a CLI dev tool: your data, your call. For a VPS
serving Slack messages from any team member: you may be silently exporting
their content.

**Wonderlands**: Wonderlands has the same architecture (Langfuse exporter
sees the full conversation), but it gates by `services.logger.level`
(`access-log.ts:34`) and by tenant flags in observability config. They also
truncate aggressively — see `langfuse-subscriber.ts:42` in YOUR repo:
`truncate(s, max = 2000)`, applied inconsistently.

**Fix**:
1. **Add an outbound redaction pass** before sending to Langfuse. Match
   patterns: `sk-[a-zA-Z0-9]{20,}` (OpenAI keys), `AKIA[0-9A-Z]{16}` (AWS),
   anything that looks like `Bearer\s+[A-Za-z0-9._-]+`, env var-shaped
   tokens. Replace with `***REDACTED***`.
2. Apply truncation universally — current `truncate()` is only used on
   `agent.answered` (line 293). Apply to `tool.called` args and
   `generation.completed` input/output too.
3. Add a `disableTracing` env flag for sensitive sessions.

### 7.2 [P0] Error messages leak filesystem paths
**Where**: `src/infra/sandbox.ts:48–50`:
```ts
throw new Error(
  `Access denied: cannot ${operation} "${toRelative(resolved)}". Allowed
   ${operation} directories: [${effective.map(...)}]`
);
```
And `src/agent/agents.ts:30,101` (filenames of agent definitions).

**What breaks**: When this error reaches `/chat`'s response (`server.ts:198`
returns `error: message`), an attacker scanning your endpoint receives:
```
Access denied: cannot read "../../.env". Allowed read directories:
[workspace/, /Users/jakubpruszynski/WebstormProjects/aidevs4]
```
That second part is a free disclosure of your VPS's username + project
location.

**Wonderlands**: Domain errors at the boundary go through `errorEnvelope`
with status-code-specific messages. Internal error context is logged but
not echoed.

**Fix**:
1. In `server.ts`, on caught errors, send only the high-level type:
   `{ error: { type: "validation", message: "Invalid input" } }`. Log full
   message internally with a request ID. Surface the request ID in the
   response so debugging is still possible: `{ error: ..., requestId: "..." }`.
2. Don't echo absolute paths in `sandbox.ts:48–50` — use only the relative
   path from project root.

### 7.3 [P1] Console logs include full prompt text on errors
**Where**: `src/llm/gemini.ts:172–173`:
```ts
console.error(`[gemini] ${(err as Error).message} | roles=[${roles}]
parts=${contents.reduce(...)}`);
```
That's restrained — only metadata. Good. But `src/server.ts:202`:
```ts
log.error(`/chat error [${sessionId}]: ${message}`);
```
The `message` may include LLM-generated content from a thrown tool error,
which may include user PII. Same in `slack.ts:215`.

**What breaks**: Production logs (which often go to a third-party log
shipper) accumulate user PII. GDPR risk if you ever onboard EU users.

**Fix**: Log a stable request ID and a one-line classifier (e.g.
`error.type`); store the full message in the DB along with the request ID
for forensics. Don't put user content into stdout/stderr logs by default.

### 7.4 [P0] Stack traces expose internal paths
**Where**: Any uncaught error in `src/`. JS stacks include the full source
file path: `at /Users/jakubpruszynski/WebstormProjects/aidevs4/src/...`.
If a stack trace ever escapes to a HTTP response or Slack reply (it can —
see `server.ts:202` if `err.stack` is part of `message`, which it may be
for some errors), you've leaked your home directory + project layout.

**What breaks**: Same as 7.2 + reveals `src/` structure to anyone who can
trigger an error.

**Fix**: At HTTP boundary, never serialize `err.stack`. Strip `err.message`
to safe text. (Bun does NOT include stack in `err.message` by default, so
this is mostly a future-proofing concern — but check before ever logging
`err.toString()` to a remote sink.)

### 7.5 [P0] OAuth tokens persisted to disk in plaintext
**Where**: `src/infra/mcp-oauth.ts:85–87`:
```ts
saveTokens(tokens: OAuthTokens): void {
  writeJson(tokensPath, tokens);
}
```
Tokens are JSON-written to `data/mcp-oauth/<server>/tokens.json` with no
encryption, no `chmod 0600`, no atomic write.

**What breaks**: Anyone with read access to the VPS filesystem (other
users, a misconfigured backup, a compromised process) reads your refresh
tokens. On a single-user VPS this is acceptable; on shared hosting it is
not.

**Wonderlands**: It does NOT have MCP OAuth (you do).

**Fix**:
1. After write, `chmod 0600 tokens.json` (Bun: `chmod` from `node:fs`).
2. Atomic write (per #3.2).
3. Optional: encrypt at rest with a passphrase from env. For now, file
   permissions + atomic write is enough.

### 7.6 [P1] Bash + execute_code can echo env vars to LLM if invoked carelessly
**Where**: `src/tools/bash.ts:44` runs the literal command via Bun's `$`
shell. The LLM-supplied command can be `env`, `printenv`, `echo $OPENAI_API_KEY`,
`cat .env`, etc. Output flows back to the LLM as the tool result. Bun's
`$` inherits the parent process env unless overridden. **It is overridden
in execute_code (line 114–118)** — only `HOME`, `PATH`, `TMPDIR` — but
**not in bash.ts** (line 44 has no env override).

**What breaks**: A malicious prompt or compromised MCP that influences the
LLM can issue `bash { command: "env" }` and exfiltrate every secret on the
VPS to the LLM provider, then to Langfuse, then potentially out to
attacker-controlled URLs via subsequent tool calls.

**Wonderlands**: Sandbox engines pass an explicit env allowlist
(`adapters/sandbox/engines/.../engine.ts`) — never inherit.

**Fix**: Add explicit `env: { HOME, PATH, TMPDIR }` to the `$` invocation
in bash.ts:44, matching execute_code.ts:114. Specifically: `await
$\`bash -c ${command}\`.cwd(cwd).env({ HOME: ..., PATH: ..., TMPDIR: cwd })
.quiet().nothrow()`. Bun supports `.env(obj)` on shell commands.

---

## Dimension 8 — Resource bounds & DoS

### 8.1 [P0] No max recursive delegation depth
**Where**: `src/agent/orchestrator.ts:195` —
`depth = opts.parentRunId ? (opts.parentDepth ?? 0) + 1 : 0`.
Depth is tracked, NOT enforced. `delegate.ts` (the tool that creates child
runs) has no depth check.

**What breaks**: An LLM that gets confused (or a hostile prompt) can drive
infinite delegation: agent A delegates to agent B which delegates to A
which... Each child run does `config.limits.maxIterations = 40` cycles
before exhausting. Two-deep recursion = 40² = 1600 LLM calls. Three-deep =
64,000. You stop only when context window saturates or your billing alerts
fire.

**Fix**: Hard cap depth to e.g. 4. In `orchestrator.ts:195`:
```ts
if (depth > config.limits.maxDelegationDepth) {
  throw new DomainError("validation",
    `Delegation depth ${depth} exceeds limit`);
}
```
Add `maxDelegationDepth: 4` to config.limits.

### 8.2 [P0] No max session/run duration
**Where**: `runAgent` (`src/agent/loop.ts:441`) loops up to `maxIterations`
(40). Each iteration can take 60–180 seconds (LLM timeout). Worst case:
40 × 180 = 7200 seconds = **2 hours per request**.

**What breaks**: A run that hits cycle 40 with no completion is acceptable.
But on the VPS, a slow LLM can keep an HTTP connection open for 2 hours.
PM2 restart kills it; until then, it's a connection slot held. Multiple
such requests exhaust HTTP connection pool.

**Fix**: Add `maxRunDurationMs` (e.g. 600_000 = 10 min). Wrap the iteration
loop in a deadline check; on overrun, exit with a synthetic
`exit: { kind: "exhausted", reason: "deadline" }`. Bonus: emit a
`run.deadline_exceeded` event so the user sees a clean error.

### 8.3 [P0] No max concurrent runs per process
**Where**: `src/server.ts`, `src/slack.ts`. Nothing limits how many in-
flight `runAgent` calls can exist simultaneously. If 50 Slack users
message simultaneously, you start 50 concurrent runs — 50 × ~50MB
context-buffered = 2.5GB RSS, plus 50 × OpenAI rate-limit slots.

**What breaks**: VPS OOMs and PM2 restarts under load. OpenAI rate limit
hits and every request fails. Worse, the active runs that crash mid-write
leave half-state.

**Fix**: A semaphore in `runAgent`. e.g. global N=8 max concurrent. Beyond
that: queue or 429.

### 8.4 [P1] Event payloads have no size limit
**Where**: `src/infra/events.ts:18–32`. The `bus.emit(type, data)` accepts
`data: EventInput<T>` of arbitrary size. `tool.succeeded` carries the full
tool result string (`recordToolOutcome` in loop.ts:198). For a tool that
returned a 1MB string, the event carries 1MB; the JSONL writer writes 1MB
per line (file growth becomes massive); Langfuse receives 1MB per
observation.

**What breaks**: Disk fills (sessions/jsonl), Langfuse rejects oversized
spans, you stop getting traces and don't know why.

**Fix**: At `bus.emit` time, if total event size > `maxEventBytes` (e.g.
64KB), truncate the largest field and add `_truncated: true`. Or better:
extract heavy fields to a sidecar (Wonderlands' approach — `event_outbox`
sidecars; for you, write-to-file + put a path in the event).

### 8.5 [P1] Bash output cap = 20KB; OK. But there's no cap on number of
parallel tool calls per turn
**Where**: `src/agent/loop.ts:175–183` — `Promise.allSettled(approved.map(...))`.
If the LLM emits 50 tool calls in one turn (rare but possible), you fan out
50 simultaneous tool invocations: 50 simultaneous `bash` spawns, 50
simultaneous browser pages, etc.

**What breaks**: VPS OOM. Or rate-limit thrash on external APIs (each
fetch counted separately).

**Fix**: Cap `approved.length` to e.g. 10. Beyond that, batch sequentially
or reject the LLM's request: `recordToolOutcome` for the overflow as
`Error: too many parallel tool calls; retry with at most 10`.

### 8.6 [P1] No rate limiting on the per-IP `/chat` POSTs (echoes 5.4)
Already covered in 5.4.

### 8.7 [P2] Same pattern repeats: `MAX_OUTPUT = 20_000` hardcoded in 3 places
**Where**: `src/tools/bash.ts:9`, `src/tools/execute_code.ts:12`, similar
caps elsewhere. Same number, three definitions, no central source.

**Fix** (cosmetic): Move to `config.limits.toolOutputBytes`.

---

## Dimension 9 — Process lifecycle & graceful shutdown

### 9.1 [P0] SIGTERM does NOT drain in-flight runs
**Where**: `src/infra/bootstrap.ts:30–43`:
```ts
process.on("SIGTERM", async () => {
  await gracefulShutdown();   // closes scheduler, tracing, mcp, db
  process.exit(0);
});
```
What does NOT happen on SIGTERM:
- In-flight `runAgent` loops are NOT signaled to stop. They keep iterating
  until they complete naturally or PM2's kill grace period elapses (default
  ~1.6s with PM2, longer with systemd).
- The HTTP server (`Bun.serve` returned by exporting from server.ts) is
  NOT explicitly closed. New requests can land between SIGTERM receipt and
  exit.
- The Langfuse buffer flush only runs from `shutdownTracing()`. If a run
  was mid-LLM-call when SIGTERM arrived, that span is never closed.
- Memory state save (`memory/persistence.ts:14`) is only triggered by
  `runAgent`'s normal flow. SIGTERM mid-cycle = lost memory delta.

**What breaks**: `kill <pid>` or `systemctl restart` mid-conversation: the
conversation's last few turns are not persisted (the items are written
each turn — see `loop.ts:225` — so DB-side messages survive, BUT the
final memory snapshot, Langfuse trace, and any in-flight tool side effect
are inconsistent). User sees their next message land in a session whose
memory state is one cycle stale.

**Wonderlands**: `Wonderlands/apps/server/src/index.ts:31–86` —
`closeHttpServer` calls `closeIdleConnections()` then `server.close()`,
then `closeAppRuntime(runtime)` which flushes everything in order
(stop scheduler → drain workers → close DB → flush Langfuse). Uses
`process.once('SIGINT', ...)` (not `.on`) to avoid re-entrant invocations.

**Fix** (in scope of this dimension):
1. Use `process.once` not `process.on` so a second signal forces exit.
2. Add a `shutdownDeadlineMs` (e.g. 25s — under PM2/systemd default 30s
   kill timeout). After deadline, force `process.exit(1)`.
3. Add an HTTP close step before `shutdownServices`. Bun.serve returns a
   server with `.stop(closeActiveConnections)` — `await server.stop(false)`
   first stops accepting new requests but lets active SSE streams finish.
4. Add an `AbortController` registry per `runAgent` (per #4.1's
   ActiveRunRegistry). On shutdown, abort all runs; loop's `try/finally`
   then runs cleanup paths.
5. Order: stop accepting → wait up to N seconds for active runs → abort
   remaining → flush Langfuse → close DB → exit.

### 9.2 [P1] No idempotent re-entry guard on signal handlers
**Where**: `src/infra/bootstrap.ts:36,40`. `process.on("SIGTERM", ...)`. If
the process receives two SIGTERMs (which can happen during PM2 reload
storms), `gracefulShutdown` runs twice, double-closing the DB connection.

**Wonderlands**: Uses `let shutdownPromise: Promise<void> | null = null`
guard (`index.ts:51`) — second call returns the in-flight promise.

**Fix**: Same guard pattern. 5 lines.

### 9.3 [P1] `SLACK_BOT_TOKEN` and other required env are checked at module top, but the process exits with code 0
**Where**: `src/slack.ts:26–29`:
```ts
if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
  console.error(...);
  process.exit(0);   // ← code 0 = "success"
}
```
**What breaks**: PM2 / systemd interpret `0` as a clean exit and DON'T
restart. Your bot just stops. Should be `process.exit(1)`.

**Fix**: One-character fix.

### 9.4 [P1] Bun.serve has no explicit timeout / connection limit
**Where**: `src/server.ts:249–252`. `export default { fetch: app.fetch, port }`
uses Bun's default settings. Bun.serve has `idleTimeout` (default 10s),
but no max body, no max concurrent connections.

**What breaks**: Slowloris-style attacker holds 1000 connections open with
slow reads. Bun's per-connection idleTimeout closes them eventually, but
during the hold period your VPS is unresponsive.

**Fix**: `export default { fetch: ..., port, maxRequestBodySize: 1_048_576,
idleTimeout: 30 }`. Combined with the rate limiter (5.4) this is
sufficient for solo VPS hosting.

---

## Dimension 10 — Crash recovery & startup invariants

### 10.1 [P0] Startup reconciliation only handles `waiting` runs — not `running` or `pending`
**Where**: `src/agent/run-continuation.ts:72–95` — `reconcileOrphanedWaits()`.

**What breaks**:
- A run was `running` when SIGKILL hit. On boot, it's still `running` in
  the DB. Nothing requeues or fails it. It sits forever, blocks any
  optimistic-lock-based resume, never appears in cleanup.
- A run was `pending` (between `insertRunRow` and `updateRunStatus`). Same
  problem. Sits forever in pending.
- A scheduled job was running when crash hit. `updateJobExecution`
  (scheduler.ts:58) was never called. On reboot, `loadAll()` re-schedules
  the cron, and if it's an interval-based job, it might fire again
  *immediately* — duplicate run.

**Wonderlands**: It has a full `requeueStaleRunningRun` action
(`Wonderlands/.../scheduling/actions/requeue-stale-running-run.ts`)
distinguishing `claim_expired` vs `process_restarted` reasons, with a
`maxStaleRecoveries` cap (line 21) — runs that have been requeued too many
times get failed.

**Fix**:
1. Extend `reconcileOrphanedWaits` to also handle:
   - `running` runs older than N minutes → mark `failed` with reason
     `"process restart"` (or `pending` if you want to retry).
   - `pending` runs older than N minutes → same.
2. Add a `staleRecoveryCount` column to runs; cap at 3, then permanently
   fail the run.
3. Run this BEFORE the HTTP server starts accepting requests.

### 10.2 [P0] No transaction-rollback recovery for half-applied writes
**Where**: Linked to #3.1. Multi-step operations not in transactions =
half-state on crash.

**Fix**: covered in #3.1.

### 10.3 [P1] SQLite WAL files can be left in a stale state after crash; recovery is automatic but slow
**Where**: `src/infra/db/connection.ts:13`. WAL mode is set, which is good
— SQLite auto-recovers from WAL on boot. But `wal_autocheckpoint` is
default (1000 pages). If your prod DB had heavy writes before crash, the
WAL can be 100MB+; first read after restart triggers a long checkpoint,
delaying boot.

**Fix**: Add `sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)")` once on
graceful shutdown so the WAL is flushed and truncated. On crash recovery,
add an explicit `wal_checkpoint` call right after opening, before the app
serves traffic.

### 10.4 [P1] Browser session lock not cleaned up on crash
**Where**: Playwright stores its session in
`config.browser.sessionPath = workspace/browser/session.json`
and Chromium sometimes leaves a `SingletonLock` file in the user data dir.
On boot after crash, a new launch can fail with "user data directory in
use".

**Fix**: On boot, delete any `SingletonLock` and `LOCK` files under
`config.browser.userDataDir` before launching. (Bun: `unlink` with
ignore-ENOENT.) Idempotent.

### 10.5 [P1] Stale `mcp-remote` processes are killed at boot but only by name match
**Where**: `src/infra/mcp.ts:120–147` — `killStaleMcpRemoteProcesses()`
uses `pgrep -f "mcp-remote"`. Sends `SIGTERM`. Doesn't wait. Doesn't
SIGKILL if SIGTERM is ignored.

**What breaks**: A truly hung mcp-remote child won't respond to SIGTERM;
your new boot collides with it (port already in use, OAuth callback
collision on port 8090).

**Fix**: After SIGTERM, wait 2s, then `process.kill(pid, "SIGKILL")` if
still alive. Cap iteration to known pids, since `pgrep` can return new
pids.

### 10.6 [P1] Leaked tmp files in execute_code if process is killed mid-execution
**Where**: `src/tools/execute_code.ts:94–96, 170–175`. Writes
`_exec_<uuid>.ts` to session dir. Unlinks in `finally`. **But** if the
parent process is killed (not the spawned subprocess), the `finally`
doesn't run. Tmp files accumulate per-session forever.

**Fix**: At startup, sweep `workspace/sessions/*/*/` for `_exec_*.ts`
files older than e.g. 1 hour and delete them. One-shot at boot.

### 10.7 [P0] Migration system is import-time + run-once: there is no version table check
**Where**: `src/infra/db/migrate.ts:1–4`:
```ts
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "./connection.ts";
migrate(db, { migrationsFolder: "./src/infra/db/migrations" });
```
Drizzle's migrator does maintain its own journal table. Good. But:
- `connection.ts:8–10` does `mkdirSync(dirname(config.database.url), { recursive: true })`
  before opening — fine.
- There's no startup invariant check: "expected schema vs actual".
- If migrations are partially applied and the migrator crashed, no
  recovery path other than manual.

**What breaks**: A failed migration leaves your DB in an unknown state.
Boot then proceeds and writes fail in confusing ways.

**Fix**: After `migrate(...)`, run a quick "schema fingerprint" check —
verify a known invariant column exists. If not, refuse to start (`process.exit(1)`)
with a clear message.

### 10.8 [P1] Scheduler poll timer fires immediately on boot, can re-execute jobs
**Where**: `src/infra/scheduler.ts:95–102` — `pollOneShots` selects all jobs
with `runAt <= now`. On boot, any job that should have run during
downtime is fired *now*. For email-style notifications this is fine; for
"send an alert if not done by 10am" it's noisy.

**Fix** (small): Add a `lastRunAt > runAt` check, or skip jobs more than
N hours overdue with a warning.

---

## Stage 2b summary

P0 findings (10): 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.4, 7.5, 8.1, 8.2, 8.3, 9.1, 10.1, 10.2, 10.7
P1 findings (12): 6.5, 6.6, 7.3, 7.6, 8.4, 8.5, 8.6, 9.2, 9.3, 9.4, 10.3, 10.4, 10.5, 10.6, 10.8
P2 (1): 8.7

Concentrated risk:
- **Trust boundary discipline** (6.1, 6.3, 6.4, 7.1) — every external input
  goes in untyped, every output goes out untruncated/unredacted. One Zod
  + redaction layer at HTTP/MCP/hub boundaries closes ~40% of P0s.
- **Lifecycle + reconciliation** (9.1, 10.1, 10.2) — together they
  determine whether `pm2 reload` corrupts state or is invisible to users.
  These three plus #3.1 are the "it must survive a restart" foundation.
- **Resource bounds** (8.1, 8.2, 8.3) — three separate config-line caps
  (depth, duration, concurrency). 30 minutes of work, kills 3 P0s.


# Stage 3 — Ordered learning queue

## Format we'll use per topic

Each topic is one focused conversation. You read; you ask follow-ups; we
loop until you can explain it back to a peer. Then we decide: implement
now, schedule a spec, or defer. Move to the next topic only when you're
solid on the current one.

Each topic includes:
1. **The concept** in plain language (no jargon dump).
2. **Why it matters specifically for your VPS server** — concrete failure
   scenarios, not "best practice".
3. **Where it manifests in your code** — exact file:line walkthroughs.
4. **How Wonderlands solves it** — code reading of the reference.
5. **Minimal fix for your codebase** — code, not prose.
6. **The 3 trade-offs you should know** — every fix has costs.
7. **Comprehension questions** I'll ask, that you should be able to answer
   before we move on.

## Why this order

Topics are ordered by **prerequisite chain**, not by severity. Some P0s
require concepts taught by earlier P1s. The order minimizes back-and-forth
"wait, what's optimistic locking" interruptions.

The rough arc:
- Topics 1–3: foundations that everything else builds on (errors, transactions, idempotency).
- Topics 4–6: the "make crashes survivable" cluster (atomicity, reconciliation, lifecycle).
- Topics 7–9: the "VPS perimeter" cluster (input validation, DoS, secrets).
- Topics 10–12: the "concurrency under load" cluster.
- Topics 13–14: polish.

## The queue

### Topic 1 — Typed errors as the foundation [P0; covers finding 2.1] — DONE
Domain error taxonomy, discriminated unions, why HTTP status codes need a
total mapping, why `message.includes(...)` is brittle. We need this FIRST
because every other fix references typed errors.

### Topic 2 — Atomic state changes: SQLite transactions [P0; covers 3.1, 10.2]
What a transaction is at the SQLite level (BEGIN/COMMIT, the WAL log, what
"atomic" really means), the `withTransaction` pattern, why your current
`db.transaction(...)` usage isn't enough. Prerequisite for Topic 3.

### Topic 3 — Idempotency keys as a contract [P0; covers 1.1, 1.2, 1.4]
What an idempotency key is, why HTTP doesn't make POSTs idempotent
naturally, the request-hash-vs-key trick, scope namespacing, replay vs
in-progress vs conflict. We design YOUR `idempotency_keys` table together,
based on Wonderlands' schema.

### Topic 4 — Optimistic locking and the "lease before side-effect" pattern [P0; covers 1.4, 4.1 partial]
Optimistic vs pessimistic locking, the version column, why your `expectedVersion`
is half the answer, why the lock must precede the side effect not follow
it. We re-design `resume-run.ts` together.

### Topic 5 — File writes that survive a crash [P1; covers 3.2]
The tmp+rename trick, why it works (POSIX rename atomicity), what fsync
adds, why your one example in `browser.ts` is right and the rest are
wrong. Quick — this is mostly tactical.

### Topic 6 — Graceful shutdown as a state machine [P0; covers 9.1, 9.2, 9.3, 10.1]
SIGTERM vs SIGKILL, PM2/systemd kill grace, why "drain in-flight" is
non-trivial, the AbortController pattern, the shutdown deadline, the
reconciliation sweep on next boot. This is the BIG topic of Stage 3 —
will probably split into 2 sub-conversations.

### Topic 7 — Trust boundaries and Zod-validated request DTOs [P0; covers 6.1, 6.4]
What a "trust boundary" is, why parsing is validation, why typeof checks
fail under attack, designing schemas that fail closed. We rewrite
`parseChatBody` together using Zod.

### Topic 8 — Resource bounds: the three caps [P0; covers 8.1, 8.2, 8.3]
Max recursion depth, max run duration, max concurrent runs. Why each one
exists; concrete failure scenarios for your VPS; how to enforce without
making the agent feel broken. Short topic.

### Topic 9 — Secrets, redaction, and observability hygiene [P0; covers 7.1, 7.2, 7.5, 7.6]
What can leak from your codebase to Langfuse, to logs, to error responses,
to PM2 stdout. The redaction-filter pattern. Why `bash.ts` is your biggest
exfiltration risk. Tokens-on-disk hygiene.

### Topic 10 — Concurrency: pushing the queue down [P0; covers 4.1]
Why session-level serialization belongs in `executeRun` not the HTTP
handler, AsyncLocalStorage gotchas, the singleton-per-process problem
(browser, MCP), per-run isolation patterns.

### Topic 11 — Rate limiting and the public perimeter [P0; covers 5.3, 5.4]
Token bucket vs sliding window, where to enforce (app vs reverse proxy),
why /api/negotiations/search is unprotected, body size caps. 30-line
fix.

### Topic 12 — MCP responses as untrusted input [P0; covers 6.3]
Why remote MCP servers are NOT in your trust boundary, prompt injection
on a privileged path, URI scheme validation, content size caps.

### Topic 13 — Outbound resilience: timeouts, retries, circuit breakers [P1; covers 5.1, 5.2, 1.3]
Differentiated timeouts, why backoff exists, what a circuit breaker
actually does and when to add one. Optional — your VPS may not need this
yet.

### Topic 14 — Crash-recovery housekeeping [P1; covers 10.3, 10.4, 10.5, 10.6, 10.8]
WAL checkpointing, browser locks, mcp-remote zombies, leaked tmp files,
overdue scheduler jobs. Mostly a "boot-time sweep" function. Quick.

## How we'll proceed

I'll wait for your **go** signal on Topic 1. Each topic ends with me
asking the comprehension questions; if you nail them, we move on; if
not, we drill deeper on the unclear part. After each topic you also
choose:
- **Implement now** — I write the code; you review.
- **Spec it** — I write a `_specs/HARDENING-XX-<topic>.md` you can
  implement later or hand to another agent.
- **Defer** — note in this doc, move on.

You're driving.

