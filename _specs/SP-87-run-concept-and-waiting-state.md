# SP-87 Run concept and waiting state

## Main objective

Introduce a first-class `Run` primitive with a typed exit union (including a
non-terminal `waiting` state) and rewire HITL confirmations onto it, so the
agent has a single durable abstraction for "one execution attempt that can
pause and resume."

## Context

Our execution model conflates three concepts and the naming reflects it:

- `executeTurn()` (`src/agent/orchestrator.ts:49`) is not a turn — it is one
  full execution from triggering message to exit. It returns
  `{ answer, sessionId }`, hiding every outcome that isn't "model produced a
  string."
- `turn.started`/`turn.completed` events (`src/agent/loop.ts:326,347`) fire
  per plan/act iteration, not per `executeTurn()`.
- The DB `agents` table (`src/infra/db/schema.ts:19-37`) stores one row per
  `executeTurn()` with `parentId`, `sourceCallId`, `task`, and `status`. It
  is a run table wearing the wrong name. Its `turnCount` column is defined
  but never incremented.
- `AgentState` and `agentId`/`parentAgentId`/`rootAgentId` in
  `src/agent/context.ts` are per-run state mislabelled as "agent."
- `src/agent/confirmation.ts:67` blocks on an in-memory promise. Process
  death mid-prompt loses the execution. No persisted waiting state, no
  resume entry point.
- Events `session.opened/completed/failed` fire per run, not per session.

The plumbing is mostly there (`agents.parentId`, `agents.sourceCallId`,
message history keyed by `agentId`). What is missing is a `waiting` status,
a typed exit union, a `resumeRun` entry point, and a coherent vocabulary.

This spec locks in three non-overlapping terms:

| Term    | Meaning                                                   |
|---------|-----------------------------------------------------------|
| session | Conversation container; may hold many runs over time     |
| run     | One execution attempt from triggering message to exit    |
| cycle   | One plan/act iteration (one LLM call + tool dispatch)    |
| agent   | Template only (`.agent.md` files, YAML frontmatter)      |

The analysis in `_specs/wonderlands-reference-analysis.md` §5 flags this as
the #1 architectural priority and the shared prerequisite for async
delegation, writeback gates, and any other typed wait.

## Out of scope

- Async delegation. `delegate.ts` stays synchronous. `child_run` is reserved
  in the `WaitDescriptor` union as a named placeholder but never triggered.
- Sandbox writeback, file-upload, and external-API wait kinds.
- Memory scopes. Memory stays session-scoped exactly as today.
- `Result<T, E>` monad. Tools still throw; only `executeRun` returns a union.
- Event outbox / durable event dispatch.
- Immutable agent revisions, SHA256 checksums, `.agent.md` history.
- Mid-cycle cancellation via `AbortSignal`. `cancelled` exists as an exit
  kind only for explicit terminal transitions.

## Constraints

- **Single Drizzle migration.** No dual-write, no backfill, no compat layer.
  Dev DB may be wiped.
- **No new tables** for the run concept itself. Reuse the renamed `runs`
  table; `waitingOn` and `exitKind` are new columns on it.
- **Vocabulary discipline.** After this spec, `turn`, `run`, `session`,
  `cycle`, and `agent` each have exactly one meaning. Enforced by the grep
  audit in acceptance.
- **Runtime behaviour unchanged except where rewired.** A run that never
  triggers HITL behaves identically to today — same messages, same tool
  dispatch, same memory, same logs.
- **No prompt changes.**
- `bun test` passes at merge.

## Acceptance criteria

### Schema

- [ ] Single migration renames `agents`→`runs`, `turnCount`→`cycleCount`,
      `sessions.rootAgentId`→`sessions.rootRunId`, updates FKs, adds
      `waitingOn` (JSON nullable) and `exitKind` (text nullable), and
      extends the status enum to
      `pending | running | waiting | completed | failed | cancelled | exhausted`.
- [ ] `cycleCount` is actually incremented once per plan/act iteration.

### Run primitive

- [ ] `src/agent/run-exit.ts` exports:

      ```ts
      type RunExit =
        | { kind: 'completed'; result: string }
        | { kind: 'failed';    error: { message: string; cause?: unknown } }
        | { kind: 'cancelled'; reason: string }
        | { kind: 'waiting';   waitingOn: WaitDescriptor }
        | { kind: 'exhausted'; cycleCount: number }
      ```

- [ ] `src/agent/wait-descriptor.ts` exports:

      ```ts
      type WaitDescriptor =
        | { kind: 'user_approval'; confirmationId: string; prompt: string }
        | { kind: 'child_run';     childRunId: string }  // reserved
      ```

- [ ] `executeRun()` (in `orchestrator.ts`, renamed from `executeTurn`)
      returns `Promise<RunExit>`. Every terminal exit persists
      `status`, `exitKind`, `completedAt`, and `result`/`error` before
      returning.
- [ ] The loop catches a new `WaitRequested` signal, persists
      `status='waiting'` + `waitingOn`, emits `run.waiting`, and returns
      `{ kind: 'waiting', ... }`. All other exceptions propagate or map to
      `{ kind: 'failed', ... }` at the orchestrator boundary.

### HITL rewire

- [ ] `confirmation.ts` persists a durable pending confirmation and throws
      `WaitRequested({ kind: 'user_approval', ... })` instead of blocking.
- [ ] `src/agent/resume-run.ts` exports `resumeRun(runId, resolution)`:
      validates `status==='waiting'` and the resolution kind matches
      `waitingOn.kind`, appends a synthetic tool-result message to the
      transcript, clears `waitingOn`, sets `status='running'`, emits
      `run.resumed`, and re-enters the loop. Returns `RunExit`.
- [ ] CLI, Slack, and HTTP entry points handle a `waiting` exit and
      eventually call `resumeRun`. Slack and HTTP must survive process
      restart between the pause and the resolution.
- [ ] HTTP gains `POST /resume` that takes `{ runId, resolution }` and
      streams the subsequent exit.

### Rename audit

- [ ] Events `session.opened/completed/failed` renamed to
      `run.started/completed/failed`; `run.waiting` and `run.resumed` added.
- [ ] Events `turn.started/completed` renamed to `cycle.started/completed`
      with an explicit `cycleIndex` field.
- [ ] `AgentState` → `RunState` (file and type).
      `getAgentId`/`getParentAgentId`/`getRootAgentId` →
      `getRunId`/`getParentRunId`/`getRootRunId`.
- [ ] `grep -rE "executeTurn|AgentState|getAgentId|parentAgentId|rootAgentId|turn\.(started|completed)|session\.(opened|completed|failed)|turnCount|createAgent" src/`
      returns zero matches. Allowlist: `src/tools/agents_hub.ts` (external
      AG3NTS hub, unrelated), `.agent.md` template files, YAML `agents:`
      frontmatter keys, and the migration file itself.

### Tests

- [ ] `bun test` passes.
- [ ] New test: `executeRun` happy path returns
      `{ kind: 'completed', ... }` and transitions the DB row
      `pending → running → completed`.
- [ ] New test: full HITL cycle — `executeRun` returns `waiting`,
      `resumeRun` re-enters and reaches `completed`, DB row transitions
      `running → waiting → running → completed`.
- [ ] New test: loop exhaustion returns `{ kind: 'exhausted', cycleCount }`
      with the matching DB state.

## Implementation plan

1. **Migration.** One Drizzle migration for all schema changes above. Apply
   to dev DB.
2. **DB ops + schema types.** Rename
   `createAgent/updateAgentStatus/incrementTurnCount/listItemsByAgent` to
   the run-prefixed equivalents in `src/infra/db/`. Fix call sites until it
   compiles.
3. **RunState + context.** Rename `agent-state.ts` → `run-state.ts` and
   the context accessors. Propagate through tools that read run identity.
4. **Run primitives.** Add `run-exit.ts`, `wait-descriptor.ts`, and a
   `WaitRequested` error class that carries a `WaitDescriptor`.
5. **Loop.** Rename cycle events, call `incrementCycleCount`, and make the
   loop return `RunExit`. `WaitRequested` is the only exception type that
   turns into a `waiting` exit; everything else becomes `failed`.
6. **Orchestrator.** Rename to `executeRun`, wrap the loop with the
   terminal-exit persistence, rename `session.*` events to `run.*`.
7. **Confirmation + resume.** Rewire `confirmation.ts` to the durable
   pattern. Implement `resume-run.ts`. Drop the in-memory pending maps
   from `server.ts` and `slack.ts`.
8. **Entry points.** CLI, Slack, HTTP each handle `waiting` and loop
   through `resumeRun` until terminal. HTTP adds `POST /resume`.
9. **Tests + grep audit.** Add the three new tests. Run the grep audit
   and fix survivors before merge.

## Testing scenarios

1. **HITL via CLI with process restart.** Trigger a confirmation, kill the
   CLI, start a new CLI command that resumes the waiting run by ID, verify
   it completes with intact message history.
2. **HITL via Slack with process restart.** Confirmation buttons appear,
   kill the Slack process, restart, click Approve, thread receives the
   final answer.
3. **HITL via HTTP.** `POST /chat`, SSE stream emits `waiting` with
   `confirmationId`, client `POST /resume`, stream emits the final answer.
4. **No regression.** `bun run agent "simple prompt"` (no HITL) matches
   `main` byte-for-byte in final answer and produces identical event
   sequences apart from the `session.*`→`run.*` rename.