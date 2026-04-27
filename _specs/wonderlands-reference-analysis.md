# Wonderlands Server — Reference Architecture Analysis

**Source:** `/Users/jakubpruszynski/WebstormProjects/aidevs4/Wonderlands/apps/server`
**Purpose:** Gap-analysis baseline. We compare our agent (`src/`) against this
reference to find missing features, misconfigurations, and bad decisions.
**Scope covered:** agent/subagent system, overall architecture, workspace
organization, large-tool-result handling.
**Date:** 2026-04-10

---

## 0. TL;DR — What Wonderlands has that we don't

The **Impact** column describes the concrete cost of the gap for our agent
— what it limits us from doing today, or what it would unlock.

| Theme | Our agent (`src/`) | Wonderlands | Impact on our agent |
|---|---|---|---|
| Agent definition | `.agent.md` file loaded at start | DB-backed agents with **immutable revisions**, SHA256 dedup, active-pointer swap, versioned rollback | Editing a live `.agent.md` silently changes behavior mid-session. No rollback on regressions, no audit of what an agent was doing three days ago, no safe A/B between prompt variants. Low blast radius today (single user) but painful the moment we start tuning prompts seriously. |
| Subagents | Delegate tool + `agents` DB rows with `parentId`/`sourceCallId` but no explicit child lifecycle | First-class **delegation graph** via `agent_subagent_links` + dedicated delegation tool with async wait/resume | We can *spawn* a child but can't *pause* the parent and wait for real async work. Forces everything into a synchronous call-chain. Blocks parallel sub-task fan-out, long-running research delegates, and human-in-the-loop branches. **#1 architectural cost.** |
| Runtime model | Single plan/act loop (`agent/loop.ts`) with turn counting | Split **Run** (LLM state) × **Job** (scheduler unit) × **Thread** (message group) × **Session** | No retries on failed runs without losing state. No scheduler can re-pick-up a crashed turn. No clean way to resume a conversation where an earlier agent left off — session state and execution state are conflated. |
| Waits / suspension | HITL `confirmation.ts` but no first-class waiting state | Explicit `waiting` state + typed wait handlers + resume service | `confirmation.ts` blocks the process. If Slack times out or the CLI goes away, the run is orphaned. Generalizing this to a typed wait + resume unlocks: child-run waits, tool result waits, external API callbacks, long-running sandbox ops. |
| Workspace | Shared `workspace/` folder with `system/`, `knowledge/`, `sessions/{date}/{id}/` | **Per-account, per-tenant workspace DB row** with disk `rootRef` + sub-areas (vault, sessions, runs, agents) | Zero isolation between runs. A parallel agent writing to `workspace/knowledge/` right now can trample another agent's work. Also blocks any future multi-project or per-experiment scoping. |
| Memory | Observer/processor/reflector under `agent/memory/` (same pattern!) | Same pattern + **scopes** (`run_local`, `thread_shared`, `session_shared`, `agent_profile`) + DB-backed `memoryRecords` with `visibility`/`status` lifecycle | Memory bleeds across tasks. A run-local observation becomes permanent agent folklore. No mechanism to *promote* a validated insight vs keep an experiment private. Manifests as drift and unbounded `knowledge/` growth. |
| Tool result large text | `resource()` refs + `result-store.ts` keyed by `toolCallId`; `condense.ts` for summarization | Tool-level `attachmentRefResolutionPolicy` (9 modes) | The seam exists but each consumer decides ad-hoc how to render a ref. A sandbox tool re-inlines a 2 MB CSV while a browser tool returns a URL — no per-tool declared contract. Symptom: context-window bloat on heavy tasks. |
| Attachment refs in args | No ref-token format; refs resolved ad-hoc per consumer | `{{attachment:msg_X:kind:file:index:N}}` tokens resolved per-tool by policy | When the LLM wants to pass "that file from three turns ago" to another tool, it has to quote a full path or file ID string. No stable, indexed reference — leads to path leakage in prompts and fragile agent behavior across turn boundaries. |
| Sandbox artifacts | Writes to `sessionService.outputPath()`; no durable file record | Glob-based **promotion** → blob store → `files` row → `file_links` to session/run/tool-call, plus `presentationHint` | Sandbox outputs aren't searchable later. Nothing links "the chart this run produced" to the run/session/tool-call. After the session ends the files are dead weight on disk with no metadata. |
| Sandbox writeback | None | **Staging → review → approval gate → writeback** lifecycle with delete-confirmation wait | If we ever let the agent mutate the workspace vault (which we're inching toward), a hallucinated `rm` call has no gate. Hard cap on how much autonomy we can safely grant. |
| Tool access | Per-agent allowlist via `tools:` YAML field in `.agent.md` (default: all tools). Verified: `proxy.agent.md` = `[shipping, think]`. `agents.ts:106-117`. | **Tool profiles** (tenant-shared/account-private) + per-revision `toolPolicyJson` + capability-derived tools (auto-add `execute`/`browse`) | Minor today — our model works for a single user. Becomes limiting when we want "this agent has sandbox therefore auto-gets `execute`" or shared tool-set presets across agents. |
| Multi-tenancy | None (local single-user) | Tenant/account scope threaded through every layer; 5 roles | **Not an impact for us.** We're single-user local; adding tenancy now would be pure overhead. Noted only for completeness. |
| Architecture | Layered `src/{agent,llm,infra,tools,config,types,utils}` with explicit concerns | **Hexagonal/DDD**: `domain` → `application` → `adapters` → `app` | Low impact in practice. Our layout is pragmatic and works. Adopting hexagonal boundaries would be cleanup, not capability. |
| Persistence | **Drizzle + SQLite** via `infra/db/` with migrations; tables: `sessions`, `agents` (with `parentId`!), `items`, `scheduled_jobs` | **Drizzle + SQLite** (WAL), 59 tables, migration journal, `withTransaction` wrapper | Parity on the plumbing, not on the schema. We're under-using SQL for what we already store — memory, files, tool executions, events are all still ad-hoc on disk. Every time we need to query "what did this tool produce last week" we grep files. |
| Events | In-process bus (`infra/events.ts`) | **Event outbox** in DB + polling dispatcher (4 lanes) | Events are lost on crash. Langfuse drops traces if the HTTP call fails mid-flight. No retry, no replay. Debugging "why did agent X do Y" past the current process is hard. |
| IDs | Free-form strings via `utils/id.ts` | **Branded prefixed IDs** (36 types) with validation | A session ID and an agent ID are both `string` at compile time. Cheap category of bugs: passing the wrong ID to a function compiles fine and fails at runtime. |
| Errors | Throws + tool dispatcher catches to `isError` | `Result<T, DomainError>` monad everywhere | Failure paths aren't in the type signature — each caller has to remember what can throw. Leads to missing error handling in leaf code. |
| HTTP | Hono (`src/server.ts`) | Hono + 25 route groups, session + API-key auth, CSRF, tenant header | Our HTTP surface is minimal — no real impact unless we start exposing the agent to network clients. |
| MCP | Client usage + `mcp-oauth.ts` | **Gateway** with OAuth flows, tool-cache fingerprinting, path rewriting, `direct` vs `code` mode | Missing "code mode" means every MCP tool call burns a full LLM turn. With the gateway pattern, an agent can bind many MCP tools as functions and call them from inside a single sandbox script — massive turn-count reduction for MCP-heavy tasks. |
| Observability | Langfuse subscriber (`infra/langfuse-subscriber.ts`) + tracing + composite logger (console/markdown/jsonl) | Langfuse dispatcher wired to event outbox (guaranteed delivery) | Same gap as Events. Current setup works in the happy path; drops data when anything is under pressure. |

---

## 0.5. What our agent already does well

Not every gap in §0 is a gap — several of our building blocks are genuinely
solid and, in some cases, punch above Wonderlands' weight for a local
single-user system. These are worth preserving as we adopt patterns from the
reference.

The **Impact** column describes what each strength concretely enables or
protects against in day-to-day agent operation.

| Area | What we have | Why it's good | Impact on our agent |
|---|---|---|---|
| **Memory pipeline** | `agent/memory/{observer,processor,reflector,persistence,generation}.ts` with co-located tests | Same conceptual model as Wonderlands (observer → reflection) and actually simpler to reason about. Reflector + observer prompts are externalized in `src/prompts/{observer,reflector}.md`. | Long sessions don't drown in raw transcript — the reflector periodically compresses observations. Directly enables multi-hour tasks without context-window panic. |
| **SQLite persistence** | `infra/db/` with drizzle + migrations; tables `sessions`, `agents` (with `parentId`/`sourceCallId`!), `items`, `scheduled_jobs` | We already have the foundations for Run × Thread split. `agents.parentId` is a delegation link waiting to be wired up. Migration tooling exists (`infra/db/migrate.ts`). | Enables resumable sessions, post-hoc inspection, and a clean path to SP-88 (Run status). Without this we'd have to build the storage layer before touching any of the Wonderlands-style patterns. |
| **Tool result store** | `infra/result-store.ts` keyed by `toolCallId` | Already decouples "large tool output" from "what gets sent back to the LLM next turn" — the exact seam where attachment-refs would slot in. | Large tool outputs don't have to round-trip through the LLM message history. Prerequisite for attachment-refs: the store is where tokens would resolve to. |
| **Context condensation** | `infra/condense.ts` + `prompts/condense-tool-result.md` | Dedicated prompt-driven summarization of large tool results. Wonderlands does this via layered budgeting; ours is simpler but effective. | A 5 MB scraped page becomes a 1 KB summary before it hits the next turn. Single biggest defense against context bloat today. |
| **Structured logging** | `infra/log/{console,markdown,jsonl,composite,bridge,logger}.ts` | Markdown session logs under `workspace/sessions/{date}/{id}/log/log_{HH-mm-ss}.md` + JSONL event stream. Matches Wonderlands' telemetry fidelity without an event outbox. | Every debugging session starts with "what does the log say" and the answer is always there. The markdown format is human-readable without tooling. Massive productivity multiplier. |
| **Evals harness** | `src/evals/{harness,runner,types}.ts` + `datasets/` + `evaluators/` | Wonderlands has no eval framework visible at this level. Ours is a real competitive advantage for iterating on prompts and tools. | Prompt/tool changes can be validated against a dataset before merging. Prevents regressions that would otherwise only show up mid-task. |
| **Prompt service** | `llm/prompt.ts` loads `.md` + YAML frontmatter, enforces `{{var}}` strictly | Same pattern as Wonderlands' `agent-markdown` for agents; consistent and testable. No hardcoded prompts in `.ts` files. | Prompts are editable without redeploying code. Missing variables fail loudly instead of producing weird LLM behavior. |
| **Tool standard** | `.claude/rules/tools.md` + `_aidocs/tools_standard.md` | Explicit input-validation rules (safeParse, `safeFilename()`, prototype-pollution block, size caps). Many Wonderlands tools rely on runtime policy checks; ours push validation into every handler. | Each tool fails safely regardless of how the model tries to abuse it. Defense-in-depth — even if the registry layer has a bug, the handler still validates. |
| **Input moderation** | `infra/guard.ts` (OpenAI Moderation API) | Gate on *incoming* user text — Wonderlands does not have a visible equivalent at the entry point. | Blocks obvious abuse before it even enters the turn loop. Cheap insurance. |
| **HITL confirmation** | `agent/confirmation.ts` + `slack-confirmation.ts` | Human-approval flow already exists and is reused across Slack and CLI. This is the nucleus of a typed "waiting" state — we just need to generalize it. | Destructive ops can already be gated today. Generalizing this is the fastest path to typed waits (SP-88). |
| **Browser automation with feedback** | `infra/browser.ts` + `browser-feedback.ts` + `browser-interventions.ts` | Visual feedback loop and intervention handling are richer than what Wonderlands' kernel adapter exposes at this level (their kernel is mostly a thin adapter over local/cloud Kernel API). | Complex web tasks (captchas, interactive flows) actually work. Wonderlands would need to build the intervention layer from scratch. |
| **Sandbox with bridge + prelude** | `tools/sandbox/{bridge,prelude}.ts` + `tools/execute_code.ts` | Code-execution with injected prelude for tool access — conceptually aligned with Wonderlands' "MCP code mode" but implemented directly on top of Bun. | The agent can write a script that calls multiple tools in one turn. Biggest turn-count reduction on data-transformation tasks. |
| **Scheduler** | `infra/scheduler.ts` + `tools/scheduler.ts` + `scheduled_jobs` table | Recurring job scheduler backed by SQLite, including cron-like schedules. Wonderlands has a multiagent scheduler but no user-facing recurring job tool. | Agent can set up recurring tasks ("check hub.ag3nts every morning"). Survives process restarts thanks to SQLite backing. |
| **Delegate tool + DB linkage** | `tools/delegate.ts` + `agents_hub.ts` + `orchestrator.ts:85-92` persists child `agents` rows with `parentId` and `sourceCallId` | Child agents are **already created and linked in the DB** on every delegation. The structural plumbing (parent ID, source call ID, row insertion) is done — what's missing is explicit async `waiting` status + wait/resume handlers + result injection into the parent on child completion. Smaller lift than "build subagents from scratch." | Partial subagent support works *today*. We can reason about agent hierarchies post-hoc from the DB. Shrinks SP-97 from "months" to "weeks". |
| **MCP with OAuth** | `infra/mcp.ts` + `infra/mcp-oauth.ts` | OAuth support for MCP already implemented. | External MCP servers that require auth (Linear, GitHub, Slack) work out of the box. |
| **Filesystem discipline** | `infra/fs.ts` sandboxed file service; tools forbidden from raw `fs`/`Bun.file()` | Hard-enforced via the tool standard. Prevents path-traversal by construction. | A hallucinated `../../etc/passwd` argument can't escape the workspace. Makes the "all tools untrusted" assumption actually true. |
| **Tests co-located** | `xyz.ts` ↔ `xyz.test.ts` everywhere under `src/`, including tools | Higher test coverage density than the Wonderlands `test/` top-level directory. bun test integrated, fast. | Refactors are safe. A broken tool is caught before it reaches the agent loop. |
| **Input safety rules** | Project-wide `.claude/rules/tools.md` enforces safeParse / `safeFilename()` / prototype-pollution blocks / size caps / allowlisted network hosts | Wonderlands relies more on runtime policies; we push the discipline into individual handlers, which is more defensive. | Prompt-injection damage is bounded by what tool handlers validate, not by what the model decides to do. |
| **Single-user ergonomics** | CLI (`bun run agent "..."`) + Slack bot + HTTP server share the same orchestrator | Wonderlands is primarily an HTTP server; we already run in three frontends without duplicating loop logic. | We can iterate from the terminal during development and demo from Slack without touching two codepaths. Big DX win. |
| **Bun runtime** | Fast startup, built-in TS, `bun test`, `bun run` — no build step | Wonderlands uses tsx + npm scripts. For a local agent, Bun is meaningfully snappier. | Tight edit-run-test loop. Cold start of the agent CLI is under a second. |

**Net takeaway:** the memory pipeline, evals, sandboxed fs, tool validation
rules, prompt service, condense/result-store seam, and SQLite schema (with
its already-present `parentId` column) are real strengths to build ON TOP of
— not things to replace. The gaps in §5 are additive: we mostly need to
*wire up* what we already have into Wonderlands-style abstractions (Run
status + waits, attachment refs, sandbox promotion, memory scopes).

---

## 1. Overall Architecture

### 1.1 Stack

- **Runtime:** Node.js + tsx (not Bun). We use Bun — fine, just note.
- **Framework:** Hono v4.12.9 + `@hono/node-server`
- **ORM:** Drizzle v0.45.2 + `better-sqlite3` v12.8.0
- **Testing:** Vitest v4.1.2, forks pool, 15s timeout
- **Lint/format:** Biome v2.4.9
- **AI:** `openai`, `@google/genai`, `@openrouter/sdk`
- **MCP:** `@modelcontextprotocol/sdk` v1.28.0
- **Observability:** `@langfuse/tracing`, `@langfuse/otel`
- **Validation:** Zod v4.3.6 everywhere (config, schemas, tool args)

### 1.2 Layer boundaries (hexagonal / clean)

```
domain/       — entity types, repository interfaces (ports), pure functions
  └─ database-port.ts → RepositoryDatabase = Pick<AppDatabase, 'select'|'insert'|'update'|'delete'>
application/  — use cases, orchestration, policies; depends only on domain
adapters/     — concrete implementations: ai providers, blob, http, kernel,
                mcp, observability, sandbox
app/          — bootstrap: config, create-app, runtime (DI container),
                middleware, guards
shared/       — cross-cutting: ids, result, errors, scope, secret-box, logger
```

**Dependency rule:** strictly inward — `domain` imports nothing from outer
layers; `application` imports from `domain` only; `adapters` implement
`domain` ports; `app` wires everything together. 44 domain repositories are
pure interfaces with zero implementation code in the domain layer.

**Our gap:** we have `src/agent/`, `src/llm/`, `src/infra/`, `src/tools/` —
flat layout with no formal boundary. `src/infra/file.ts` is both a port and
an implementation. There's no "port" concept, no ORM, no DB at all.

### 1.3 Startup flow

```
index.ts → loadEnvFileIntoProcess()
        → loadConfig() (Zod-validated env)
        → createAppRuntime(config)
        → initializeAppRuntime(runtime)       // DI: adapters, services, workers
        → createApp(runtime)                  // Hono app + middleware stack
        → serve() (hono/node-server)
```

Middleware stack (in order):
1. `secureHeaders()` (OWASP)
2. `runtimeContextMiddleware` — injects config/db/services into Hono context
3. `requestContextMiddleware` — generates `requestId`/`traceId`
4. `authSessionAuthMiddleware` — session cookie + `X-Tenant-Id`
5. `apiKeyAuthMiddleware` — `Authorization: Bearer`
6. `accessLogMiddleware`
7. per-API-path: `apiResponseMiddleware`, `requestSizeGuardMiddleware`,
   `browserCsrfMiddleware`, `cors`, `bodyLimit`

### 1.4 Shared primitives (`src/shared/`)

- **`ids.ts`** — 36 prefixed branded ID types. `createPrefixedId('run')` →
  `run_<uuid-no-dashes>`. Strict casters like `asRunId()` validate prefix.
- **`result.ts`** — `Result<T,E> = { ok: true, value } | { ok: false, error }`.
  `ok()`/`err()` helpers. Used in EVERY domain/application function return.
- **`errors.ts`** — `DomainError` tagged union with HTTP status mapping.
- **`scope.ts`** — `TenantScope = { tenantId, accountId, role }`,
  `RequestScope`, role enum.
- **`secret-box.ts`** — `crypto.subtle` AES encryption for MCP creds, API
  keys at rest. `EncryptedSecret = { ciphertext, iv, version: 1 }`.
- **`api-key.ts`** — SHA-256 hashes API keys before storing.
- **`auth-session.ts`** — session secret hashing.

**Design principle:** **no thrown exceptions in business logic.** Domain
operations all return `Result<T, DomainError>`. Exceptions are reserved for
unrecoverable bugs and are caught at the HTTP boundary (`DomainErrorException`
→ HTTP status).

### 1.5 Persistence

- **Client:** `db/client.ts` — Drizzle + `better-sqlite3`, pragmas: `WAL`,
  `synchronous=NORMAL`, `busy_timeout=5000`, FK enforcement ON.
- **Schema:** 13 modules under `db/schema/` totaling ~59 tables and ~1990 LOC:
  `agents`, `collaboration`, `runtime`, `events`, `mcp`, `sandbox`, `identity`,
  `kernel`, `files`, `garden`, `memory`, `preferences`, `tool-access`.
- **Migrations:** drizzle-kit generated; `db/apply-migrations.ts` +
  `ensure-migration-journal.ts` (idempotent tracking via `_drizzle_migrations`).
- **Transactions:** `db/transaction.ts` exports `withTransaction(db, fn)` —
  thin wrapper over drizzle's `.transaction()`. Multi-step domain operations
  (e.g. delegation) wrap all writes atomically.
- **Port abstraction:** `domain/database-port.ts` defines
  `RepositoryDatabase = Pick<AppDatabase,'select'|'insert'|'update'|'delete'>
  & { sqlite? }`. All 44 repositories accept this minimal interface — enables
  test doubles and future DB swap.

### 1.6 Commands / Events / CQRS

**Commands** (30+ under `application/commands/`): each exports an object
with `execute(context, args)` returning `CommandResult<T>`. Every command
receives `CommandContext = { db, services, tenantScope, requestId, traceId }`.

**Events**: event-sourced-ish. Domain changes write rows to `domainEvents`,
then queued into `eventOutbox`. A polling worker
(`application/events/outbox-worker.ts`, batch 100, 1-sec retry, quarantine
after 3 failures) dispatches each entry to **four lanes**:

1. **`background-dispatcher`** — triggers async ops (agent spawning, etc.)
2. **`projection-dispatcher`** — updates read models (activity, run snapshots)
3. **`observability-dispatcher`** (langfuse) — telemetry export
4. **`realtime-relay`** — SSE broadcast to browser clients

No in-memory pub/sub — events are DB rows pulled by a polling worker. This
gives **durability + retry + audit trail** out of the box.

**Our gap:** we have `src/infra/events.ts` (in-process) and
`src/infra/langfuse-subscriber.ts`. Events are lost if the process crashes,
no retry semantics, no durable audit.

### 1.7 Polling worker pattern

`application/polling-worker.ts` — generic abstraction. Config: `runOnce`,
`computeNextDelay`, `supportsWake`. Reused by:

- sandbox worker (stage → run → promote → writeback)
- multiagent (scheduler) worker
- garden auto-build worker
- event outbox worker

**Why we care:** this is a simple, robust pattern for any long-running
background work. We should crib it rather than inventing ad-hoc loops.

### 1.8 Scale

- **~369** TS files in `src/`
- **~59** DB tables
- **25+** HTTP route files (~200+ endpoints)
- **44** domain repositories
- **30+** commands, **12+** application services, **7** adapters
- Rough **~150k** LOC

---

## 2. Agent / Subagent System

### 2.1 Agent definition & storage

Three layers:

**A. Markdown source (authoring format)** — `application/agents/agent-markdown.ts`

```yaml
---
schema: agent/v1
slug: my-agent                        # unique per tenant per status
name: Display Name
kind: primary|specialist|derived
visibility: account_private|tenant_shared|system
model:
  provider: openai|google|openrouter
  model_alias: gpt-4o|gemini-2.0-flash|...
  reasoning: { effort: low|medium|high }  # optional
tools:
  native: [delegate_to_agent, suspend_run, execute, ...]
  mcp_mode: direct|code
  tool_profile_id: tpf_xxxxx
kernel:
  enabled: bool
  browser: { max_concurrent_sessions, max_duration_sec, default_viewport }
  network: { mode, allowed_hosts, blocked_hosts }
  outputs: { allow_screenshot, allow_pdf, allow_html }
sandbox:
  enabled: bool
  runtime: { max_duration_sec, max_memory_mb, node_version, ... }
  packages: { mode, allowed_packages, allowed_registries }
  vault: { mode, approval_requirements }
  network: { ... }
  shell: { ... }
memory:
  profile_scope: bool
  child_promotion: string
subagents:
  - alias: researcher
    slug: deep-researcher
    mode: async_join
garden:
  preferred_slugs: [...]
---
You are ...  (the system prompt body)
```

Parsed with a strict Zod schema. Slug regex `^[a-z0-9][a-z0-9_-]*$`. Dedup
checks on native tools, subagent aliases, subagent slugs, garden slugs.

**B. `agents` table** (`domain/agents/agent-repository.ts`)

```
id, slug, name, kind, visibility, status,
activeRevisionId (FK, nullable),
baseAgentId (optional, for derivation),
ownerAccountId (nullable for system agents),
createdBy, createdAt, updatedAt, tenantId
```

Visibility enum: `account_private | tenant_shared | system`.
Kind enum: `primary | specialist | derived` (semantic only).
Status: `active | archived | deleted`.

**C. `agent_revisions` table** (`domain/agents/agent-revision-repository.ts`)

```
id, agentId, version (monotonic),
checksumSha256,                 # rejects duplicate imports
sourceMarkdown,                 # canonical form for re-export
instructionsMd,                 # system prompt body
frontmatterJson,                # raw parsed frontmatter
modelConfigJson,                # { modelAlias, provider, reasoning }
toolProfileId,                  # FK to tool_profiles
toolPolicyJson,                 # { native: [...], mcpMode: 'direct'|'code' }
kernelPolicyJson,
sandboxPolicyJson,
memoryPolicyJson,
workspacePolicyJson,
gardenFocusJson,
resolvedConfigJson              # computed composite
```

**Key pattern: immutable revisions + active pointer.**

- Agent metadata (slug/name/visibility) is mutable in place.
- Execution config is captured as an immutable snapshot in a revision.
- `agents.activeRevisionId` is swapped atomically → zero-downtime updates.
- In-flight runs keep using their pinned revision (`run.agentRevisionId`).
- Rollback = swap the active pointer back.
- Identical re-import (same SHA256) is rejected as conflict.

### 2.2 Subagent links / delegation graph

Separate table (`agent_subagent_link-repository.ts`):

```
id, parentAgentRevisionId (FK), childAgentId (FK),
alias (unique per parent revision, max 120 chars),
delegationMode ('async_join' currently the only mode),
position (int for ordering), createdAt
```

One child can be linked to many parents (reuse). A parent revision knows
its children by listing rows where `parentAgentRevisionId = revision.id`.
**The alias is what the parent agent calls the subagent by** (e.g.
`delegate_to_agent({ target: "researcher", ... })`).

### 2.3 Delegation flow (`application/agents/delegation-service.ts`)

`createChildRun(parentRun, targetAlias, task, instructions, ...)`:

1. Validate parent run has `agentRevisionId`.
2. Look up subagent link `(parentAgentRevisionId, alias) → childAgentId`.
3. Verify child agent is `active` and has `activeRevisionId`.
4. Check `canReadAgent(scope, childAgent)` visibility.
5. **In a single transaction**:
   - Resolve child runtime settings via
     `resolveRuntimeSettingsFromAgentRevision()`.
   - Create child `run`:
     - `parentRunId = parentRun.id` (immediate parent link)
     - `rootRunId = parentRun.rootRunId` (all runs in a tree share a root)
     - `configSnapshot` = child revision's model settings (frozen)
     - `sourceCallId` = parent's tool-call ID
     - `workspaceId` = parent's workspace (shared workspace)
     - `targetKind = 'agent'`
   - Create child `job` (`kind: 'task'`, `status: 'queued'`)
     - Assigned to `childAgentId` + `childRevisionId`
     - If parent has a job, create `job_dependencies` edge (parent→child)
   - Link parent-visible files to child run (so child can read attachments).
   - Inject developer message "You are {childAgent.name}. Another agent
     delegated to you..." plus user message with task + instructions.
   - Emit events: `run.created`, `child_run.created`, `delegation.started`.
6. Return `DelegationHandoffEnvelope` + `DelegationTaskEnvelope` as tool result.

**Delegation mode: `async_join`** — parent suspends waiting for child; child
runs asynchronously; on child completion (or failure/cancel/suspend) result
is injected into parent's message context and parent resumes.

**Root vs delegated runs:**
- Root run: `rootRunId == id`, `parentRunId == null`, user-triggered.
- Delegated run: `rootRunId` points up to ancestor root, `parentRunId` to
  immediate parent, `sourceCallId` references the delegation tool call.

**Resume** (`resume-delegated-run-service.ts`): when a child is suspended
waiting for input, parent calls `resume_delegated_run` with wait ID +
`{ output | errorMessage | approve }`. Validates wait is active, resolves
via `resolveRunWait()`, returns new wait state.

### 2.4 Capabilities & tool access

Four tool domains: `native`, `mcp`, `provider`, `system`.

**Per-agent allowlist** comes from `revision.toolPolicyJson.native`.

**Capability-derived tools** (`application/agents/agent-capability-tools.ts`):
the set is automatically expanded based on other policies —

- `sandbox.enabled=true` → adds `execute`, `commit_sandbox_writeback`
  (if vault mode allows writes)
- `sandbox.enabled && tools.mcp_mode=='code'` → adds `search_tools`,
  `get_tools` (MCP code mode — the agent writes TS and calls MCP tools as
  functions from inside the sandbox instead of as top-level function calls)
- `kernel.enabled=true` → adds `browse`

`buildEffectiveNativeTools()` returns the union — the markdown doesn't have
to list these.

**Runtime enforcement** (`application/agents/agent-runtime-policy.ts`):

```
isToolAllowedForRun(db, scope, run, tool):
  if !run.agentRevisionId → allow only mcp (fallback profile)
  if tool.domain == 'native' → hasNativeToolGrant(revision, tool.name)
  if tool.domain == 'mcp'    → toolProfileId matches + tool in assignments
  if tool.domain in ('provider','system') → deny
```

Handles aliases: `suspend_run ↔ block_run`,
`resume_delegated_run ↔ delegate_to_agent`, `get_tools ↔ get_tool`.

**7 native agent tools** registered in
`application/agents/register-agent-native-tools.ts`:

1. `delegate_to_agent` — creates child run, injects messages, returns waiting envelope
2. `suspend_run` — halts with wait reason, returns waiting envelope
3. `resume_delegated_run` — resolves child wait with output/error/approval
4. `get_garden_context` — returns workspace/vault structure for navigation
5. `search_tools` (MCP code mode) — regex/text search over MCP catalog
6. `get_tools` (MCP code mode) — resolves tool names to TS bindings
7. `generate_image` — calls AI image service with edits support

### 2.5 Runtime policy & constraints

`resolveRuntimeSettingsFromAgentRevision()` composes:
- Model from `revision.modelConfigJson` (with overrides)
- Tool profile from `revision.toolProfileId` or account-preferences fallback
- MCP mode from `revision.toolPolicyJson.mcpMode`

`resolveMcpModeForRun()`:
```
if !run.agentRevisionId → 'direct'
if !sandbox.enabled → 'direct'
if mcp_mode=='code' && 'execute' granted → 'code'
else → 'direct'
```

**Constraints are distributed, not centralized:**
- **Max turns**: `config.multiagent.maxRunTurns` checked in `drive-run.ts:100`.
- **Token/cost**: tracked in `usage-ledger-repository`.
- **Sandbox limits**: `maxDurationSec`, `maxMemoryMb`, `maxInputBytes`,
  `maxOutputBytes` enforced by sandbox runtime.
- **Kernel limits**: `maxDurationSec`, `maxConcurrentSessions`, network
  allow/block lists enforced by kernel adapter.
- **Vault approvals**: `requireApprovalFor{Write,Delete,Move,WorkspaceScript}`
  enforced by sandbox writeback flow.

### 2.6 Sessions, threads, runs, jobs

Four-level hierarchy:

```
WorkSession (the user's conversation container)
  └─ SessionThread (message group within a session)
       └─ Run (LLM execution state)
            └─ Job (scheduler unit, 1:1 with run)
```

**`work_sessions`**: `id, status, rootRunId?, workspaceId?, workspaceRef?,
createdByAccountId, title, metadata, createdAt, archivedAt, deletedAt`

**`session_threads`**: `id, sessionId, runId, status, createdAt, updatedAt` —
groups messages so resumed runs can see prior context.

**`runs`** (the core of execution):

```
id, sessionId, rootRunId (self-ref if root),
parentRunId (null if root), agentId?, agentRevisionId?,
status: pending|running|cancelling|waiting|completed|failed|cancelled,
task: string,
configSnapshot: { model, modelAlias, provider, reasoning, version, eventThreadId? },
toolProfileId?, targetKind: 'assistant'|'agent',
sourceCallId? (parent's tool call id if delegated),
threadId?, workspaceId, workspaceRef,
jobId?, startedAt, completedAt, lastProgressAt,
turnCount, version (optimistic lock),
errorJson, resultJson
```

**`jobs`**: parallel hierarchy for the scheduler:

```
id, sessionId, rootJobId, parentJobId?, currentRunId?,
assignedAgentId?, assignedAgentRevisionId?,
status: queued|running|waiting|completed|failed|cancelled,
kind: 'task', inputJson, resultJson, statusReasonJson,
lastSchedulerSyncAt, nextSchedulerCheckAt, lastHeartbeatAt,
priority, version
```

**`job_dependencies`**: `type: 'depends_on'` edges for parent→child blocking.

**Why split Run from Job?**
- Run = what the LLM is doing (turn-by-turn state)
- Job = what the scheduler cares about (queue position, retries, deps)
- One run per job execution; if run fails/times out, scheduler can requeue
  the job with a new run attempt.

**Execution loop** (`application/runtime/execution/drive-run.ts`):

```
executeRunTurnLoop(context, run, overrides):
  register active run (for cancellation via AbortSignal)
  while turnCount < maxRunTurns:
    check abort signal
    verify run.status == 'running'
    load thread context (prior messages + items)
    filter tool specs by agent permissions
    build interaction request (system prompt, model, tools)
    stream LLM generation
    handle tool calls one at a time (sequential), persist outcomes
    loop until model stops calling tools
    if assistant message with no tool calls → mark completed, persist, return
    if run transitions to waiting → mark waiting, return waiting result (suspend)
```

**Waits / suspensions** — typed wait descriptors for every reason a run can
pause:
- child run completion (delegation)
- user approval (sandbox delete, writeback)
- file upload
- tool result arrival
- external API

Each wait type has a handler in `application/runtime/waits/handlers/` that
knows how to resume the parent run when the condition is met.

### 2.7 Access control & multi-tenancy

`application/agents/agent-access.ts`:

```
canReadAgent(scope, agent):
  - system agents: always readable
  - tenant_shared: readable within tenant
  - account_private: readable only by ownerAccountId

canEditAgent(scope, agent):
  - system: never editable
  - others: only by ownerAccountId

canWriteAgents(role):
  - owner|admin|member|service allowed
```

**No cross-tenant agent sharing.** Subagent links are within-tenant only.
Every repository query filters by `tenantId`.

### 2.8 Agent sync (file → DB)

No file watcher. Explicit sync via `AgentSyncService.importMarkdown(md)`:

1. Parse YAML frontmatter + markdown body
2. Validate against Zod schema
3. Resolve subagent slugs → agent IDs (must be active)
4. Check slug availability
5. Compute policies
6. Validate no self-delegation cycle
7. Compute SHA256; reject if duplicate of existing revision
8. Create `agent_revisions` row with `version++`
9. Create/update `agent_subagent_links` rows
10. Atomically swap `agents.activeRevisionId`
11. Emit `agent.created` and/or `agent.revision.created` events

Export (`exportMarkdown`) reconstructs the canonical markdown from DB.

---

## 3. Workspace Management

### 3.1 What IS a workspace?

**A per-account, per-tenant persistent container** — one DB row plus a
filesystem directory.

- **DB:** `workspaces` table (`domain/agents/workspace-repository.ts:18-28`,
  schema in `db/schema/agents.ts:154-181`):
  `id (wsp_*), accountId, tenantId, kind, status, rootRef, label,
   createdAt, updatedAt`
- **Disk:** `rootRef = {baseRoot}/ten_{tenantId}/acc_{accountId}`
- **Uniqueness:** `workspaces_tenant_account_kind_unique` — one workspace
  per account-tenant-kind triple.
- **Status:** `active | archived | deleted`
- **Lifecycle:** lazily created on first access via `ensureAccountWorkspace()`
  or `requireWritableWorkspace()` in `application/workspaces/workspace-service.ts`.
- **Events:** `workspace.created` (on creation), `workspace.resolved`
  (every access).

### 3.2 Workspace sub-areas

Five distinct areas, each with a clear purpose:

```
{rootRef}/
  ├─ agents/                            # Agent profile index for this workspace
  ├─ vault/                             # Persistent knowledge base (long-term)
  │   └─ attachments/                   # User uploads, organized by date/shard
  ├─ sessions/{sessionId}/              # Session-local scratch
  ├─ runs/{runId}/                      # Run-specific execution context
  │   └─ sandboxes/{executionId}/
  │       ├─ input/                     # Staged attachments + vault inputs
  │       ├─ work/                      # Execution cwd
  │       ├─ output/                    # Generated artifacts (promoted to files)
  │       ├─ logs/                      # Sandbox stdout/stderr
  │       ├─ vault/                     # Staged vault copy (read or RW)
  │       ├─ request.json               # Execution request snapshot
  │       └─ policy.json                # Sandbox policy snapshot
```

**Vault** = persistent knowledge. Agent-readable, agent-writable (via
approved writeback). Source for vault inputs to sandboxes.

**Memory** is NOT on disk — it lives in the `memoryRecords` DB table for
efficient querying.

**Sessions/{sessionId}/** = session-local scratch (ephemeral files used in
one conversation).

**Runs/{runId}/** = run-specific; each sandbox execution gets a full
`input/work/output/logs/vault` layout with frozen `request.json`/`policy.json`
snapshots so you can later diff what changed.

### 3.3 Memory system

Two independent axes: **kind** and **scope**.

**Kinds** (`db/schema/memory.ts`):

1. **`observation`** — short bullets extracted from a sealed context summary
   by an observer LLM stage. Up to **8 observations, max 280 chars each**
   (`application/memory/observe-summary.ts:14-22`).
2. **`reflection`** — compressed summary of run-local observations.
   Max 1200 chars. Produced by reflector LLM stage when observation token
   count exceeds
   `config.memory.reflection.triggerRatio * contextWindow`.
   **Generational** — new reflections supersede old ones via `generation`
   field; `status` transitions `active → superseded`.

**Scopes** (`application/memory/memory-scope.ts`):

- **`run_local`** — private to one run; not inherited by parent
- **`thread_shared`** — across all runs in a thread
- **`session_shared`** — across a whole session
- **`agent_profile`** — per-agent long-term memory (top-level root runs only)

Resolution:
```
resolveWritableMemoryScope(run):
  if run.parentRunId==null && run.agentId → agent_profile
  else → run_local

resolveReadableMemoryScopes(run):
  own scope + all higher scopes
```

**`visibility`** enum: `private | promoted` — allows promoting a memory from
private to shared.

**Sourcing**: `memoryRecordSources` table links each observation to the
summary + run that generated it — full traceability.

**Our gap:** we have observer/processor/reflector already (good!) but we
store memory in workspace knowledge files. Wonderlands' scoped memory with
promotion + generation lifecycle is a more mature model.

### 3.4 Garden (knowledge publishing)

A **compiled, searchable knowledge site** per account — manually authored
markdown in vault gets built into a static site.

Tables (`db/schema/garden.ts`):
- **`gardenSites`** — site definitions with `sourceScopePath`, `buildMode`
  (`manual|debounced_scan`), `deployMode` (`api_hosted|github_pages`),
  `protectedAccessMode` (`none|site_password`), `isDefault` flag.
- **`gardenBuilds`** — build history with `sourceFingerprintSha256` +
  `configFingerprintSha256` for change detection, `manifestJson`,
  `publicArtifactRoot`, `protectedArtifactRoot`.
- **`gardenDeployments`** — deploy history with `externalUrl`.

Auto-rebuild worker watches vault changes (debounced scan). Uses pagefind
for search. Tagged as `gardenAdminRoles = ['admin','owner']`.

**Conceptual distinction:**
- **Garden** = curated, versioned, published (knowledge artifact)
- **Memory** = ephemeral, auto-generated run reflections (internal state)
- **Files** = user uploads or sandbox artifacts (attachments)

### 3.5 File handling

**Three tables** (`db/schema/files.ts`):

1. **`uploads`** — upload lifecycle: `status: pending|completed|failed|cancelled`,
   `stagedStorageKey`, session-scoped. Two-phase upload with resumability.
2. **`files`** — durable file records:
   ```
   id, storageKey, sourceKind: upload|artifact|generated|derived,
   accessScope: session_local|account_library,
   createdByAccountId, createdByRunId,
   checksumSha256 (dedup),
   metadata (JSON: sandbox execution id, relative path, ...),
   originalFilename, mimeType, sizeBytes, status, title
   ```
3. **`fileLinks`** — many-to-many: `linkType: session|thread|message|run|tool_execution`,
   `targetId`. One file can be linked to many contexts.

**Blob storage** (`domain/files/blob-store.ts`):
```typescript
interface BlobStore {
  get(key): Promise<Result<BlobReadResult, DomainError>>
  put({ data, storageKey }): Promise<Result<BlobObject, DomainError>>
  delete(key): Promise<Result<void, DomainError>>
}
```
Local implementation: `adapters/blob/local-blob-store.ts`. Stores at
`{root}/files/{tenantId}/{fileId}` or workspace-scoped paths. Validates
paths to prevent directory escape.

**Storage key pattern** (`application/files/attachment-storage.ts`):
```
{blobStorageRoot}/workspaces/ten_{tenantId}/acc_{accountId}/attachments/
  {YYYY}/{MM}/{DD}/{shard}/{fileId}{ext}
```
Sharding uses first 2 chars of fileId (normalized) to avoid directory
explosion.

### 3.6 Attachment refs (the key abstraction for large data)

**Ref token format** (`application/files/attachment-ref-context.ts`):

```
{{attachment:msg_{messageId}:kind:{file|image}:index:{N}}}
```

Examples:
- `{{attachment:msg_abc123:kind:file:index:2}}`
- `{{attachment:msg_abc123:kind:image:index:0}}`

Descriptor fields:
```typescript
{
  fileId, indexInMessageAll, indexInMessageByKind,
  internalPath,    // /vault/attachments/...
  kind, messageCreatedAt, messageId, messageSequence,
  mimeType, name,
  ref,             // the token
  renderUrl,       // /api/files/{fileId}/content
  sourceMessageState  // 'live' | 'sealed'
}
```

The LLM sees tokens in message history. When the LLM passes a token as a
tool arg, the tool registry resolves it according to the tool's policy
(next section).

### 3.7 Ref resolution policies (THE big idea)

Every tool declares how it wants attachment refs resolved in its args:

```typescript
interface ToolSpec<TArgs> {
  attachmentRefResolutionPolicy?: AttachmentRefResolutionPolicy
  attachmentRefTargetKeys?: string[]   // which arg keys to scan
  ...
}

type AttachmentRefResolutionPolicy =
  | 'file_id_only'    // → 'fil_xxx'
  | 'metadata_only'   // → { fileId, mime, size, ... }
  | 'markdown_only'   // → '![img](...)' or '[file](...)'
  | 'none'            // don't touch
  | 'path_only'       // → '/vault/attachments/...'
  | 'path_inline'     // replace token in string with path
  | 'smart_default'   // auto: url/text/image based on type
  | 'text_only'       // load + return text (fallback to metadata)
  | 'url_only'        // → '/api/files/{id}/content'
```

Resolution runs in three stages (`application/files/ref-resolution.ts`):

1. **Exact string**: arg is exactly a ref token → resolve per policy.
2. **Inline string**: ref appears inside a longer string → `path_inline`
   or `smart_default` substitution.
3. **Policy fallback**: per-tool default.

**Why it matters:** the same ref gets served differently depending on what
the consumer needs. `execute` (sandbox) wants `file_id_only` so it can
stage the file into `/input/`. `write_to_file` wants `path_inline` to
embed the path in a destination. A vision tool wants `smart_default` to
get an image URL.

### 3.8 Large-text handling

**`FILE_INLINE_TEXT_BYTES` = 65,536** (64 KiB) default in `app/config.ts`.

`application/files/file-context.ts:40-46`:
```typescript
const toInlineText = (file, body, maxBytes) => {
  const sliced = body.byteLength > maxBytes ? body.slice(0, maxBytes) : body
  const suffix = body.byteLength > maxBytes ? '\n\n[truncated]' : ''
  return `Attached file: ${label}\nMIME: ${mime}\n\n${decode(sliced)}${suffix}`
}
```

Only **text-like** MIME types are inlined:
- `text/*`
- `application/json`
- `application/xml`
- `application/javascript`

**Everything else → metadata only** (name, mime, size, fileId). Non-text
binaries are never inlined.

### 3.9 Image handling

Two paths:

1. **Inline data URLs** (`shared/data-url.ts`):
   - `parseDataUrl(value)` → `{ mimeType, isBase64, payload }`
   - `estimateDataUrlBytes(value)` → for token budgeting
   - `decodeDataUrl(value)` → Buffer for actual send

2. **OpenAI upload normalization**
   (`adapters/ai/openai/openai-input-images.ts`):
   - Data URLs in messages are uploaded to OpenAI Files API before the
     request is sent.
   - Deduplicated via `cacheKey = sha256(url)` — same image across turns
     uploads once.
   - Uploaded file IDs replace the inline data URL in the outgoing payload.

Detail level (`low|high|auto`) drives token estimate: 256–1536 tokens per
image.

### 3.10 Sandbox result model

**`SandboxRunResult`** (`domain/sandbox/sandbox-runner.ts`):
```typescript
{
  status: 'cancelled'|'completed'|'failed',
  startedAt, completedAt, durationMs,
  stdoutText,                       // full (or policy-truncated)
  stderrText,                       // full (or policy-truncated)
  failure: SandboxRunFailure|null,  // with stdoutPreview + stderrPreview
  externalSandboxId, networkMode, vaultAccessMode,
  packages: SandboxRunPackageResult[],
  provider, runtime
}
```

**`SandboxPolicy.runtime.maxOutputBytes`** is a hard cap. Exceeding it
triggers a failure with code `SANDBOX_OUTPUT_LIMIT_EXCEEDED`, phase
`script_execution`.

**Failure includes previews, not full streams** — when the sandbox explodes,
the error envelope keeps `stdoutPreview` + `stderrPreview` (truncated) so
the LLM can diagnose without context bloat.

### 3.11 Sandbox artifacts lifecycle

**Staging → execution → promotion → writeback.**

**Staging** (`application/sandbox/sandbox-staging.ts:93-310`):
1. Resolve workspace
2. Build layout `{runRef}/sandboxes/{execId}/{input,work,output,logs,vault}`
3. Stage attachments into `input/` (copied from blob store)
4. Stage vault inputs into `vault/` (copied or linked from workspace vault)
5. Stage CWD if specified
6. Write `request.json` + `policy.json` snapshots
7. Record staged files in `sandboxExecutionFiles` with role
   `attachment_input` or `vault_input`

**Execution** runs isolated in the sandbox runtime (Deno, Node, Python,
LibreOffice). Output files end up under `output/`.

**Promotion** (`application/sandbox/sandbox-artifacts.ts:110-268`):
```
for each file in walkFiles(outputRoot):
  if not matching request.outputs.attachGlobs: skip
  body = readFile(path)
  checksum = sha256(body)
  storageKey = toAttachmentStorageKey(...)
  blobStore.put({ data: body, storageKey })
  fileRepo.create({
    id: fil_*,
    sourceKind: 'artifact',
    accessScope: 'session_local',
    createdByRunId, metadata: { relativePath, execId, sandboxPath },
    checksumSha256, storageKey, mime, size, originalFilename
  })
  fileLinkRepo.create({ linkType: 'session', targetId: sessionId, fileId })
  fileLinkRepo.create({ linkType: 'run', targetId: runId, fileId })
  fileLinkRepo.create({ linkType: 'tool_execution', targetId: toolCallId, fileId })
  sandboxFileRepo.create({ role: 'generated_output', ..., createdFileId: fileId })
```

**Only files matching `attachGlobs` are promoted** — the sandbox is a
scratch space by default; the agent opts into which outputs become durable.

### 3.12 Sandbox result envelope (what the LLM sees)

`application/sandbox/sandbox-read-model.ts:84-194`:

```typescript
{
  kind: 'sandbox_result',
  sandboxExecutionId, status, provider, runtime,
  durationMs, effectiveNetworkMode,
  outputDir: '/output',
  stdout, stderr,                         // may be truncated per policy
  failure: SandboxRunFailure | null,
  files: SandboxResultFile[],             // promoted artifacts only
  packages: SandboxResultPackage[],
  writebacks: SandboxResultWriteback[],   // pending vault writes
  isolation: SandboxIsolationSummary,
  presentationHint: string
}
```

**`presentationHint`** is a natural-language instruction to the LLM:
> "Files listed in files are already attached to the conversation UI. In
> the follow-up reply, tell the user the file is attached by filename
> instead of pasting raw API or /vault paths unless asked."

This is a nice trick — bake the "how to refer to this result" convention
into the tool output itself so the LLM doesn't leak ugly paths.

### 3.13 Sandbox writeback (persistence to vault)

Writebacks are **pending mutations** of the workspace vault staged by a
sandbox run.

**Table:** `sandboxWritebackOperations` (`db/schema/sandbox.ts:166-197`):
```
id, sandboxExecutionId,
operation: 'write'|'copy'|'move'|'delete',
sourcePath, targetVaultPath, requiresApproval,
status: 'pending'|'approved'|'rejected'|'applied'|'failed',
approvedByAccountId?, approvedAt?
```

**Review** (`sandbox-review-service.ts`): user reviews each writeback →
`approve`/`reject`. Sets status and records who/when.

**Commit** (`sandbox-writeback.ts:64-214`): iterates approved writebacks:
- `move`: copy output→vault, then delete source
- `copy`: copy output→vault
- `delete`: remove from vault

Path safety validated (must stay inside roots). Status → `applied`/`failed`.

**Delete confirmation gate** (`sandbox-delete-confirmation.ts`): if any
writeback is a delete with `requiresApproval`, the sandbox cannot even
start until the user confirms — creates a wait of type
`sandbox_execute:delete_writeback`.

### 3.14 File-picker search

`application/files/file-picker-search.ts` — lightweight discovery tool.

Constants:
- `FILE_INDEX_TTL_MS = 30_000` — cache indexes 30s
- `MAX_CACHED_INDEXES = 5`
- `DEFAULT_LIMIT = 30`, `MAX_LIMIT = 50`

Scans workspace files (excluding `node_modules`, `.git`, `dist`,
`__pycache__`, etc.) + attachment metadata. Returns ranked results with
match-index highlighting.

**Purpose:** let the agent *find* files by keyword before reading them —
avoids dumping a whole directory listing into context.

### 3.15 Context condensation & budgeting

`application/interactions/context-bundle.ts:76-200`:

```typescript
interface ContextLayer {
  kind: ContextLayerKind  // system_prompt | attachment_ref_context | run_transcript | ...
  volatility: 'stable' | 'volatile'
  messages: AiMessage[]
  estimatedInputTokens: number
}

interface ContextBudgetReport {
  rawEstimatedInputTokens: number
  calibratedEstimatedInputTokens: number | null
  estimatorVersion: 'calibrated_v1' | 'rough_v1'
  requestOverheadTokens: number
  reservedOutputTokens: number | null
  stablePrefixHash: string         // for prompt caching
  stablePrefixTokens: number
  volatileSuffixTokens: number
  layerReports: ContextLayerBudgetReport[]
}
```

Per-layer estimation:
- Text: `Math.ceil(length / 4)`
- Data URLs: `estimateDataUrlBytes() / 4 + image detail overhead`
- Image files: 256–1536 tokens based on detail level

**Stable prefix hash** → enables provider-side prompt caching (OpenAI).

`context-compaction.ts` drops/summarizes old volatile layers when budget
exceeds threshold. Tool results get their content dropped but refs stay,
so the LLM can re-read them on demand.

### 3.16 LLM adapter message building

`adapters/ai/openai/openai-request.ts:114-160` — translates internal
`AiMessageContent` union into OpenAI `ResponseInputContent[]`:

```
'text'       → { type:'input_text', text }
'image_url'  → { type:'input_image', image_url, detail }
'image_file' → { type:'input_image', file_id, detail }
'file_url'   → { type:'input_file', file_url, filename }
'file_id'    → { type:'input_file', file_id, filename }
```

Internal content types match LLM content parts almost 1:1 — the cost is
deciding **upstream** whether an attachment becomes `image_url` vs
`image_file`, `file_url` vs `file_id`, inline text vs truncated. That
decision happens in `file-context.ts` and in the ref-resolution stage.

---

## 4. Notable patterns worth stealing

1. **Hexagonal ports for the DB.** `RepositoryDatabase` is 5 method names
   (`select|insert|update|delete` + optional `sqlite`). Repositories are
   pure interfaces. We should formalize `domain` vs `application` vs
   `adapters` and define minimal ports.

2. **`Result<T, DomainError>` everywhere in business logic.** No throws
   inside domain/application. Only the HTTP boundary unwraps into HTTP
   status. Eliminates a whole class of bugs.

3. **Prefixed branded IDs.** Every entity has a prefix (`run_*`, `agt_*`,
   `wsp_*`), a branded TypeScript type, and a validator. You can never
   confuse a run ID with an agent ID at compile time.

4. **Immutable revisions + active pointer.** Agents are mutable at the
   metadata level; execution uses a frozen snapshot. Trivially rollbackable,
   zero-downtime update, in-flight runs unaffected.

5. **Run × Job split.** Run = LLM state. Job = scheduler state. Decoupled,
   retryable, queueable.

6. **Typed waits + resume handlers.** Every reason a run can pause has a
   typed descriptor and a dedicated handler. Async delegation, user
   approval, sandbox-delete confirmation, file upload — all unified.

7. **`presentationHint` in sandbox results.** The tool output tells the
   LLM how to talk about it. We can do this in our tool results too —
   "Saved to X. Reference by filename, not path, in your reply."

8. **Attachment refs with per-tool resolution policy.** The LLM sees
   opaque `{{attachment:msg_X:kind:file:index:N}}` tokens; each tool
   decides whether to resolve to `file_id`, `path`, `url`, inline text,
   markdown, etc. Keeps the LLM context clean and lets each tool get
   exactly what it needs.

9. **Sandbox promotion via `attachGlobs`.** The sandbox is a scratch space;
   only files matching glob patterns become durable attachments. Cheap
   and explicit.

10. **Sandbox writeback lifecycle: stage → review → approve → commit.**
    No destructive operation ever touches the vault without an explicit
    human approval gate (or an agent policy that pre-authorizes).

11. **Event outbox with polling worker.** Durable, retryable, auditable
    event dispatch. Our in-process bus can be replaced with a DB table
    and a polling loop with minimal code.

12. **`withTransaction` + `RepositoryDatabase`.** Domain operations that
    touch multiple tables are wrapped atomically; repositories accept
    either the root DB or a transaction handle polymorphically.

13. **Per-account, per-tenant workspace with lazy creation.** We have one
    global `workspace/`; their workspaces are isolated per identity with
    sub-areas for vault (persistent), sessions (ephemeral), runs (per-run).

14. **Memory scopes + generational reflection.** Observations are bounded
    (8 items × 280 chars). Reflections are generational with `status`
    transitions (`active → superseded`) — no accidental unbounded growth.

15. **Tool profiles as indirection.** Agents reference `toolProfileId`;
    MCP tool assignments are resolved at runtime from the profile. Lets
    you revoke or update tool access without re-importing agent markdown.

16. **MCP "code mode".** When sandbox is enabled and `mcp_mode: 'code'`,
    MCP tools become TypeScript function bindings inside the sandbox.
    The LLM calls `search_tools` / `get_tools` to discover and binds,
    then writes TS. Vastly reduces top-level tool-call count for complex
    MCP workflows.

---

## 5. Concrete gaps in our agent (`src/`)

Ordered by expected value:

### High value

1. **No typed `Result<T, E>`.** We throw everywhere. Even a tiny
   `result.ts` with `ok()/err()` would give us type-safe error channels in
   tools and services.

2. **No `Run` / `Job` / `Thread` separation.** Our `session.ts` conflates
   all of these. Adding `Run` with explicit `status` + `waiting` state
   would let us model delegation, sandbox approvals, user input waits
   cleanly.

3. **Subagents: structural linkage exists, lifecycle wiring missing.** We
   have `tools/delegate.ts`, `agents_hub`, and `orchestrator.ts` already
   persists child rows in the `agents` table with `parentId` + `sourceCallId`.
   What's missing: an explicit `waiting` status on the parent, a wait/resume
   handler for child completion, result injection on resume, and a
   `rootRunId` for tree-wide tracing. Much smaller lift than starting from
   scratch. This is still the #1 architectural priority given where we
   want to head.

4. **No attachment-ref system.** Every tool that produces a file returns
   either raw text or a `resource()` URI. There's no per-tool resolution
   policy — the LLM sees the URI as just a string. We should add
   `{{attachment:...}}`-style tokens + a per-tool resolution hook.

5. **Inconsistent size guards on inlined text.** Several tools already
   enforce a per-tool `MAX_OUTPUT` (e.g. `execute_code.ts` and `bash.ts`
   cap at 20,000 chars; `browser.ts` / `glob.ts` / `grep.ts` truncate
   with a hint). What's missing is a **global** enforcement point in the
   tool dispatcher so every tool benefits (including `read_file` and any
   new tool that forgets). Wonderlands' `FILE_INLINE_TEXT_BYTES = 64 KiB`
   is applied at the file-context layer, not per-tool.

6. **No sandbox artifact promotion with `attachGlobs`.** Our execute tool
   writes to `output/` but doesn't have the glob-based opt-in promotion
   model. Everything the sandbox produces is either all-in-context or
   all-on-disk; there's no in-between (durable attachment record with
   metadata + link to run/session).

7. **No sandbox writeback review gate.** If we ever let the agent mutate
   workspace vault, we need the staging → review → approval → commit
   model. Right now we'd just let it overwrite.

### Medium value

8. **No immutable agent revisions.** Our `.agent.md` files are edited in
   place; there's no history, no rollback, no SHA256 checksum. Even
   file-based, we could snapshot revisions into a `workspace/system/agents/.history/`
   dir on change.

9. **No memory scopes beyond "knowledge".** We have `run_local` conceptually
   but no `agent_profile`, no `thread_shared`, no `session_shared`. Memory
   promotion (private → promoted) is also missing.

10. **No `presentationHint` in tool results.** We should bake "how to
    reference this in the next message" into tool outputs directly.

11. **No `file_picker_search` equivalent.** Our agent has to `ls` the
    workspace and then `read_file`. A keyword-indexed picker tool would
    save turns.

12. **No context layer budgeting.** We don't estimate tokens per message
    layer or split stable vs volatile prefixes for prompt caching.

13. **No event outbox / durable events.** In-process event bus loses
    events on crash. A SQLite `events` table + polling dispatcher would
    give us durability + retries for free.

### Low value / intentional simplicity

14. No multi-tenancy. We're a single-user local agent — skip.
15. No HTTP API auth. Skip for now.
16. No garden. Skip.
17. No Drizzle + SQLite. Probably worth adding when workspace state gets
    complex, but file-backed is fine for now.
18. No `Result<T,E>` at the domain/application boundary (we have no such
    boundary) — see #1.

---

## 6. Potential misconfigurations / bad decisions in our code

Hypotheses based on contrast with Wonderlands. Each one was spot-checked
by an independent audit subagent — verdicts recorded inline.

1. **Tool results likely inline large content.** **REFUTED (partially).**
   `execute_code.ts`, `bash.ts`, `browser.ts`, `glob.ts`, `grep.ts` all
   enforce per-tool `MAX_OUTPUT` and truncate with a hint. `condense.ts`
   exists for LLM-driven summarization of oversized results. The real
   problem is **coverage, not absence** — no global dispatcher-level
   guard, so tools like `read_file` can still bomb the context.

2. **`resource()` refs are probably opaque strings to the LLM.**
   **UNVERIFIED.** Needs inspection of actual tool-result rendering.

3. **Workspace paths are probably leaking into prompts.** **UNVERIFIED.**
   Can only confirm by reading live agent logs.

4. **Sandbox output is probably unbounded.** **REFUTED.** `execute_code.ts`
   enforces `MAX_OUTPUT = 20,000` chars.

5. **No cancellation plumbing.** **PARTIAL.** `AbortSignal` is used in
   network/fetch calls but not threaded through the LLM turn loop or tool
   execution. Graceful cancel mid-tool is still missing.

6. **Agent config is probably re-read per-run, not versioned.** **REFUTED.**
   Agent config is loaded once per `executeTurn()` in `orchestrator.ts`
   and pinned to the `AgentState` for the whole run. No mid-run re-reads.
   What's still missing vs Wonderlands is **revision identity** — we have
   no SHA256 checksum, no history, no rollback.

7. **`workspace/knowledge/preferences.md` is ad-hoc memory promotion.**
   **UNVERIFIED.** File exists untracked; growth unbounded in principle
   unless a lifecycle exists. Worth a separate investigation.

---

## 7. File cross-reference for deeper dives

### Architecture
- `index.ts`, `app/create-app.ts`, `app/runtime.ts`, `app/config.ts`
- `db/client.ts`, `db/transaction.ts`, `db/schema/*.ts`
- `shared/{ids,result,errors,scope,secret-box}.ts`
- `application/polling-worker.ts`
- `application/events/outbox-worker.ts`

### Agent system
- `domain/agents/{agent-types,agent-repository,agent-revision-repository,agent-subagent-link-repository}.ts`
- `application/agents/{agent-markdown,agent-sync-service,delegation-service,resume-delegated-run-service,agent-capabilities,agent-capability-tools,agent-runtime-policy,agent-access,register-agent-native-tools}.ts`
- `application/runtime/execution/drive-run.ts`
- `domain/runtime/{run-repository,job-repository,job-dependency-repository,run-dependency-repository,item-repository}.ts`
- `domain/sessions/{work-session-repository,session-thread-repository,session-message-repository}.ts`

### Workspace
- `domain/agents/workspace-repository.ts`
- `application/workspaces/{workspace-service,workspace-events}.ts`
- `application/garden/*`, `db/schema/garden.ts`
- `application/memory/{observe-summary,reflect-run-local-memory,memory-scope}.ts`
- `domain/memory/memory-record-repository.ts`
- `application/preferences/account-preferences-service.ts`
- `application/naming/thread-title-generator.ts`

### Large results / attachments
- `application/files/{attachment-metadata,attachment-ref-context,attachment-storage,file-context,file-picker-search,ref-resolution,upload-file}.ts`
- `application/images/*`
- `application/sandbox/{sandbox-result,sandbox-artifacts,sandbox-staging,sandbox-writeback,sandbox-read-model,sandbox-review-service,sandbox-delete-confirmation}.ts`
- `application/interactions/{context-bundle,context-compaction,attachment-ref-prompt}.ts`
- `adapters/ai/openai/{openai-request,openai-input-images}.ts`
- `adapters/blob/local-blob-store.ts`
- `shared/data-url.ts`
- `domain/tooling/tool-registry.ts`
- `domain/sandbox/{types,sandbox-runner}.ts`

---

## 8. Suggested follow-ups (as backlog items to draft)

- **SP-87 (proposed):** Introduce `Result<T, DomainError>` in tool handlers
  and tool dispatcher; migrate incrementally from throw-based errors.
- **SP-88:** Add `run` concept to session store with explicit `status`,
  `waiting`, `parentRunId`, `rootRunId` fields — prerequisite for subagents.
- **SP-89:** Design attachment-ref tokens (`{{attachment:...}}`) + per-tool
  `attachmentRefResolutionPolicy` + resolution helper.
- **SP-90:** Global `MAX_INLINE_TEXT_BYTES` guard in tool dispatcher;
  enforce on any text content before it enters the next LLM turn.
- **SP-91:** Sandbox output glob-based promotion to durable
  `workspace/files/` records (metadata + link to run/session).
- **SP-92:** `presentationHint` field in `ToolResult` + dispatcher passes
  it to the LLM as a tool-message suffix.
- **SP-93:** File-picker search tool indexing workspace by keyword.
- **SP-94:** Context layer budgeting + condensation (drop old volatile
  layers first, compute stable prefix hash for caching).
- **SP-95:** Immutable agent revisions: snapshot `.agent.md` on change,
  store SHA256, refuse duplicate imports, keep history under `.history/`.
- **SP-96:** Memory scopes (`run_local`, `thread_shared`, `session_shared`,
  `agent_profile`) + promotion lifecycle.
- **SP-97:** Subagent delegation (prerequisite: SP-88). Parent-child run
  linkage, shared workspace, `delegate_to_agent` native tool, wait/resume.
- **SP-98:** Event outbox on SQLite + polling dispatcher (migration from
  in-process `events.ts`).

---

---

## 8.5. Audit trail (independent reviews)

This report was quality-audited by two independent subagents after the
initial draft. The audits cross-checked claims against both codebases.
Findings applied above:

**Wonderlands-side audit (grade B+):**
- ✗ Event outbox "three lanes" → corrected to **four**
  (`background`, `projection`, `observability`, `realtime`).
- ✗ Sandbox writeback `operation` enum missing `'write'` → added.
- ✓ Verified: 369 TS files, 13 schema modules / ~59 tables, stack versions
  (hono 4.12.9, drizzle 0.45.2, better-sqlite3 12.8.0, vitest 4.1.2,
  biome 2.4.9, mcp-sdk 1.28.0), 9 ref-resolution policies, 7 native
  tools, observation constraints (8 × 280), reflection cap (1200),
  `FILE_INLINE_TEXT_BYTES = 65536`, file-picker constants,
  `database-port` shape, attachment ref token format.
- ~ Unverified: exact repo count (44), LOC total (~150k), polling-worker
  reuse count. All plausible.

**Our-agent-side audit (grade B-):**
- ✗ "Tool access: all tools for all agents" → corrected. Per-agent
  `tools:` YAML field filters the set. `proxy.agent.md` uses only
  `[shipping, think]`. Verified at `agents.ts:106-117`.
- ✗ "No size guard on inlined text" → downgraded to "inconsistent size
  guards, no global enforcement". Per-tool `MAX_OUTPUT` does exist.
- ~ Delegate tool row in §0.5 understated: child agents **are** already
  persisted with `parentId` + `sourceCallId` via `orchestrator.ts:85-92`.
  Updated the strengths table and §5 gap #3 accordingly.
- §6 hypothesis #6 ("agent config re-read per run") → **refuted**.
- §6 hypothesis #4 ("sandbox output unbounded") → **refuted**.
- ✓ Verified: memory pipeline files + prompts, SQLite schema
  (`sessions`/`agents`/`items`/`scheduled_jobs` with expected fields),
  `infra/events.ts` is in-process, `confirmation.ts` + `slack-confirmation.ts`,
  `infra/mcp-oauth.ts`, log stack (composite/console/markdown/jsonl),
  browser trio, sandbox bridge/prelude, evals harness structure,
  tool standard rules, Bun runtime, single orchestrator across CLI/Slack/HTTP.

**Residual risk:** §5 gaps #2 (`Result<T,E>`), #4 (attachment refs), #6
(sandbox promotion), #7 (writeback gate), #9–#13 (misc) were not
independently verified but are consistent with codebase grep results.
§6 hypotheses #2, #3, #5, #7 remain UNVERIFIED — worth a follow-up pass.

---

## 9. Open questions for the human

1. How much of Wonderlands' DB-backed model do we want? A minimal SQLite
   with `runs`, `threads`, `files`, `memory_records`, `events` tables
   would unlock most of the above patterns without dragging in the full
   59-table schema.

2. Do we want multi-agent delegation soon, or are we still
   single-assistant? This drives whether SP-88/SP-97 are near-term or
   exploratory.

3. Should we adopt the `.agent.md` revisions pattern for our own agents
   folder, or is file edits + git history sufficient?

4. Do we want an HTTP layer with real auth, or will the current local-only
   server + Slack bot remain the only entry points?