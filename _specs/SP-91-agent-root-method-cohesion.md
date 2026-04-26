# SP-91 Agent root method cohesion

## Main objective

Stabilize the three fattest, most-edited files in `src/agent/` —
`loop.ts`, `orchestrator.ts`, `session.ts` — by extracting cohesive units
of behavior into named helpers that each do one thing. No folder moves,
no public API changes, no behavioral changes. The goal is that after this
spec a reader can scan the top of each file and see a flat list of small,
single-purpose functions instead of one monster function with five
inlined responsibilities.

This is the prerequisite for SP-92+ (folder reorg into
`runtime/`, `agents/`, `waits/`, `sessions/` mirroring Wonderlands'
`apps/server/src/application/runtime/`). Boundaries must be clear at the
function level before they can be drawn at the folder level.

## Context

The agent root has accreted via SP-72/76/78/82/87/88/89/90 — each spec
landed correctly, but each one bolted its concern onto whatever file was
nearest the seam. The result is three files where the dominant function
mixes 4–6 distinct responsibilities:

### `src/agent/loop.ts` (460 lines)

`runAgent` (`loop.ts:310-461`) is one ~150-line function that interleaves:

1. **Session/log setup** — constructs `MarkdownLogger`, `ConsoleLogger`,
   `JsonlWriter`, attaches bus listeners (already extracted to
   `setupSession`, but `runAgent` still owns disposal).
2. **Agent resolution** — `agentsService.resolve(state.assistant)` +
   default-model fallback + workspace context build + system prompt
   composition (`loop.ts:324-346`).
3. **The cycle loop** — bounded iteration with `dbOps.incrementCycleCount`,
   memory pre/post-processing, generation, exit-on-stop check
   (`loop.ts:350-419`).
4. **Tool dispatch with WaitRequested propagation** — try/catch around
   `dispatchTools` translating thrown `WaitRequested` into a `waiting`
   exit (`loop.ts:395-411`).
5. **Terminal flush + telemetry** — `flushMemory` + `saveMemoryIfChanged`
   + `emitAnswerTerminal` / `emitMaxIterationsTerminal` /
   `emitFailureTerminal` (`loop.ts:371-432`).
6. **Logger/jsonl teardown** in `finally`.

`dispatchTools` (`loop.ts:127-250`) similarly mixes confirmation gating,
`Promise.allSettled` orchestration, `WaitRequested` re-throw, per-call
telemetry emission, denied-tool message synthesis, and assistant message
mutation. Six concerns in one function.

`buildCycleContext` (`loop.ts:263-294`) is a small, well-shaped helper
already; keep it.

### `src/agent/orchestrator.ts` (305 lines)

Four exported entry points (`executeRun`, `runAndPersist`, `createChildRun`,
`startChildRun`) duplicate three nearly-identical pieces of logic:

- **Run row creation**: `dbOps.createRun({...})` is called from
  `executeRun:91-99` and `createChildRun:255-263` with the same shape and
  no shared helper.
- **State hydration**: building `RunState` from a DB row + agent resolution
  + memory load is open-coded in `executeRun:116-131` and `startChildRun:287-302`.
- **Exit → DB persistence**: the `switch (exit.kind)` in `runAndPersist`
  (`orchestrator.ts:152-206`) branches on five cases and each case does
  inline `dbOps.updateRunStatus({...})` + ad-hoc side effects (event
  emission for `waiting`, child-run kickoff for `child_run`).
- **Child kickoff side effect**: the `if (exit.waitingOn.kind === "child_run")`
  branch in `runAndPersist:188-204` nests a fire-and-forget promise with
  inline error logging and a nested `resumeRun(...).catch(...)`. This is
  the only piece of fire-and-forget orchestration in the file and it's
  buried inside a switch case.

The `pickAssistantName` helper at the top (`orchestrator.ts:37-51`) is
the only properly-extracted helper in the file. Use it as the template.

### `src/agent/session.ts` (284 lines)

`createSessionService` is a 130-line factory closure that mixes four
concerns under one return object:

1. **Message ↔ DB-item conversion** — `messagesToItems` /
   `itemsToMessages` are already module-level (good), but the service
   methods that call them (`appendMessage`, `appendRun`, `getMessages`)
   reach directly into `dbOps` and inline `nextSequence` math.
2. **Session row CRUD** — `getOrCreate`, `setAssistant`, persistence
   touchpoints (`touchSession`).
3. **Per-session async serialization** — the `queues` map +
   `enqueue<T>(sessionId, fn)` (`session.ts:149,205-215`). This is its
   own concern (mutex-per-key) and lives nowhere else in the codebase.
4. **Path helpers** — `getEffectiveSessionId`, `sessionDir`, `logDir`,
   `sharedDir`, `outputPath`, `toSessionPath`, `resolveSessionPath`,
   `ensureSessionDir`. Eight methods, 50 lines, no DB or message
   awareness — pure path math against `defaultConfig.paths.sessionsDir`.

The fallback `fallbackSessionId` lives at closure scope and is touched
only by `getEffectiveSessionId` and `_clear` — it's effectively a
process-wide singleton hidden inside a "service" abstraction.

### What this spec does not do

- **No file moves.** Every helper extracted lands in the same file as its
  caller. Folder reorg is SP-92.
- **No public API changes.** `executeRun`, `runAndPersist`, `createChildRun`,
  `startChildRun`, `runAgent`, `sessionService`, and every method on
  `sessionService` keep their current signatures and import paths.
- **No new abstractions** like `Result<T,E>`, branded IDs, or hexagonal
  ports. Those are SP-93+ from the wonderlands analysis.
- **No event renames or new events.** Telemetry call sites move with
  their owning logic but the emitted events are byte-identical.
- **No memory pipeline changes.** `processMemory` / `flushMemory` /
  `saveState` keep their current signatures and call sites.
- **No DB schema changes, no migrations.**
- **No prompt changes.**

## Constraints

- **Same test surface.** Every existing `*.test.ts` in `src/agent/` must
  pass without modification. New tests may be added for newly-named
  helpers but no existing test may be deleted or substantively rewritten
  (renaming a `describe()` block to match the new helper name is fine).
- **Same emitted events.** A diff of the JSONL event stream for a fixed
  scripted run, captured before and after, must be empty modulo
  timestamps and UUIDs. Acceptance includes a recorded baseline.
- **Same import paths.** External callers
  (`src/cli.ts`, `src/server.ts`, `src/slack.ts`, `src/evals/*`,
  `src/agent/resume-run.ts`, `src/agent/run-continuation.ts`,
  `src/tools/delegate.ts`) keep their existing imports unchanged.
- **No new files outside `src/agent/`.** Helpers stay co-located with
  their owning module. If `loop.ts` shrinks below 250 lines, that's a
  positive signal — but splitting it into `loop/setup.ts` +
  `loop/dispatch.ts` is out of scope (that's SP-92).
- **No throw-to-Result conversion.** Throws stay throws; `WaitRequested`
  stays the in-band signal. Restructuring `try/catch` placement is fine
  as long as the externally observable behavior is unchanged.
- **Each extracted helper must be testable in isolation** — no
  `requireState()` calls inside helpers that don't already need
  `AsyncLocalStorage`. Pull `RunState` in as a parameter where possible.
- `bun test` passes at merge.
- `bun run agent "what is 2+2"` produces an answer end-to-end.

## Acceptance criteria

### `loop.ts`

- [ ] `runAgent` is ≤ 60 lines and reads as a sequence of named
      helper calls. The cycle loop body is delegated to a function
      named `runCycle(state, ctx, provider) → CycleOutcome` where
      `CycleOutcome = { kind: 'continue' } | { kind: 'completed', text } | { kind: 'waiting', waitingOn }`.
- [ ] A new helper `resolveAgentForRun(state)` encapsulates
      `agentsService.resolve` + `state.model` defaulting + `state.tools`
      assignment + `buildWorkspaceContext` + system prompt composition.
      Returns `{ systemPrompt, memoryEnabled }`.
- [ ] A new helper `finalizeRun(state, exit, runStartTime, turnStartTime,
      iterationsRun)` owns terminal memory flush + the appropriate
      `emit*Terminal` call. Switches on `exit.kind`.
- [ ] `dispatchTools` is split into:
      - `runConfirmationGate(calls) → { approved, denied }` (currently
        inline at `loop.ts:135-148`).
      - `recordDeniedToolCalls(state, denied)` (inline at `loop.ts:139-145`).
      - `executeApprovedToolCalls(approved, dispatchTime) → SettledOutcome[]`
        (the `Promise.allSettled` block at `loop.ts:175-181`).
      - `recordToolOutcome(state, call, outcome, dispatchTime)` per call
        (the body of the for loop at `loop.ts:190-239`).
      - `dispatchTools` itself becomes a ≤ 40-line orchestrator that
        wires these together and re-throws `WaitRequested` at one
        location.
- [ ] `setupSession` returns a single `dispose()` function rather than
      three separate fields (`detachLogger`, `detachJsonl`, `flushJsonl`)
      so the `finally` block in `runAgent` is one line.
- [ ] `getErrorMessage` (`loop.ts:306-308`) moves to `src/utils/errors.ts`
      (creating the file if missing) and is reused by `orchestrator.ts`
      (`runAndPersist:209-210`) and `resume-run.ts` wherever the same
      `err instanceof Error ? err.message : String(err)` pattern appears.
      Grep audit: zero remaining inline copies of that pattern in
      `src/agent/`.

### `orchestrator.ts`

- [ ] A new helper `insertRunRow(opts)` encapsulates `dbOps.createRun({...})`
      with the field shape used by both `executeRun` and `createChildRun`.
      Both call sites use it.
- [ ] A new helper `hydrateRunState(run, opts) → RunState` builds the
      `RunState` for a DB row + (optional) freshly-resolved agent. Used
      by both `executeRun` (with `parentTraceId`/`parentDepth` overrides)
      and `startChildRun`. Eliminates the two open-coded copies at
      `orchestrator.ts:116-131` and `:287-302`.
- [ ] The `switch (exit.kind)` in `runAndPersist` becomes a dispatch to
      `persistRunExit(runId, exit) → void` whose body is the same switch.
      `runAndPersist` itself loses the inline persistence noise and reads
      as: run loop → append messages → persist exit → maybe kick child.
- [ ] The "kick a child run async" branch is extracted to
      `kickChildRunAsync(parentRunId, childRunId)` with the
      fire-and-forget + nested resume-on-failure logic owned in one place.
      Called from `runAndPersist` in one line. The nested
      `console.error` calls become `log.error` via the existing logger
      (the `bus.emit` at `:185` stays where it is, since it belongs to
      the persist step, not the kick step).
- [ ] `executeRun` is ≤ 50 lines: name resolution → moderation → run
      row → state hydration → `runAndPersist`. The four helpers above
      carry the weight.

### `session.ts`

- [ ] `createSessionService` is split into three internal factory
      sections within the same file, each returning a partial of the
      service object that the outer factory composes. Sections:
      - `createMessageStore({ fileService })` — message↔item conversion
        callers: `appendMessage`, `appendRun`, `getMessages`.
      - `createSessionRegistry()` — `getOrCreate`, `setAssistant`,
        `enqueue`, `_clear`.
      - `createSessionPaths({ sessionsDir, fileService })` —
        `getEffectiveSessionId`, `sessionDir`, `logDir`, `sharedDir`,
        `ensureSessionDir`, `outputPath`, `toSessionPath`,
        `resolveSessionPath`. The closure-scope `fallbackSessionId`
        moves into this section.
      - The composed `sessionService` is the spread of all three.
- [ ] `dateFolderNow` is the only top-level utility; everything else
      lives inside one of the three factories.
- [ ] No service method exceeds 15 lines. `appendRun` and `appendMessage`
      currently inline `dbOps.nextSequence` + `messagesToItems` +
      iteration over items — collapse to one helper
      `persistMessages(runId, msgs) → void`.

### Cross-cutting

- [ ] `wc -l src/agent/loop.ts` < 350 (currently 460).
- [ ] `wc -l src/agent/orchestrator.ts` < 220 (currently 305).
- [ ] `wc -l src/agent/session.ts` < 260 (currently 284) and no method
      in it exceeds 15 lines.
- [ ] No function in any of the three files exceeds 60 lines.
- [ ] `grep -rn "err instanceof Error ? err.message : String(err)" src/agent/`
      returns zero matches.

### Behavioural parity

- [ ] Capture a baseline JSONL event stream:
      `bun run agent "list the files in workspace/system/agents and tell me their names"`
      with a fixed `--session sp91-baseline` ID before the refactor.
      Save the JSONL under `_specs/SP-91-baseline.jsonl`.
- [ ] After the refactor, re-run with the same prompt and a fresh
      session, then diff the JSONL streams (excluding `ts`, `id`,
      `traceId`, `runId`, `sessionId`, message content modulo
      whitespace). Diff must be empty.
- [ ] `bun test` passes — no test file may be deleted; renames of
      `describe()` strings only.
- [ ] `bun run agent "what is 2+2"` produces an answer end-to-end on a
      fresh session.

### Documentation

- [ ] `CLAUDE.md` "Architecture" section updated only if a public
      function name changed (it shouldn't — this is internal cohesion).
      No update expected.

## Non-goals (explicit)

- Folder reorg into `runtime/` / `agents/` / `waits/` / `sessions/`.
  Tracked separately as SP-92.
- Adopting `Result<T, DomainError>`. Tracked as SP-93 (renumber if
  conflicts at merge time).
- Branded prefixed IDs (`run_*`, `wsp_*`). Tracked as SP-94.
- Splitting `Run` from `Job`. Tracked as SP-95 / pulled from
  wonderlands analysis §5.
- Anything in the wonderlands analysis SP-91..SP-98 backlog beyond
  pure cohesion of the existing three files.

## Risk

- **Low.** Pure mechanical extraction with a recorded behavioural
  baseline. The largest risk is a subtle reordering of side effects in
  the `runAgent` `finally` block — the JSONL diff catches this.
- **Mitigation.** Land in three commits, one per file, each with the
  baseline diff re-run. Revert is a single `git revert` per commit if
  any subscriber regresses.
