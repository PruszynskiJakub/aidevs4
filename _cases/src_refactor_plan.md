# Fowler-style Refactor Plan for `src/`

Companion to `_cases/src_responsibilities_audit.md`. For each of the 16 problem areas, this document lists smells (Fowler's vocabulary), the named refactorings that address them, and an execution-risk classification.

## Test baseline

`bun test test/` reports **86 failures, 810 pass** before any change is made. The failing tests cover most of `src/agent/`, `src/infra/log/`, parts of `src/infra/`, several tools, and `src/server.ts`. The skill mandates a green bar between every step. Where the baseline is red, the safety net is fictional and architectural moves can't be verified.

**Conclusion:** Execute only mechanical, *behavior-preserving by construction* moves on green-tested or test-free helper code. Defer architectural surgery until a green baseline is restored.

## Risk classification

- 🟢 **Safe-by-construction**: Pure helper consolidation, dedup of identical logic, or moves into new files. No behavior change possible without compile error.
- 🟡 **Needs characterization tests**: Regression risk; verifiable with a small new test or type check.
- 🔴 **Architectural / requires green baseline**: Restructures behavior-laden modules. Defer.

---

## Problem 1 — `src/agent/loop.ts`

**Smell catalog:**
1. **Long Module** — `runAgent` calls 8 internal functions across 6 concerns (~430 lines). → Extract Class (multiple).
2. **Data Clumps** — `IterationDeps`, `MemoryContext`, `SessionResources` shuttle the same state slices. → Introduce Parameter Object (already partial).
3. **Mixed Concerns** — One file owns session resources, agent resolution, LLM act mechanics, tool dispatch, memory, terminal emission, DB cycle counting. → Split Phase / Extract Class.
4. **Comments-as-Headers** — Each internal `function` is effectively a section header. → Extract Class so each becomes a method.

**Plan:**
- 1a. Extract Class `SessionLifecycle` (`setupSession` + `dispose`).
- 1b. Extract Class `ActPhase` (`executeActPhase` + token accounting + `recordDeniedToolCalls`).
- 1c. Extract Class `ToolDispatchPhase` (`dispatchTools` + `executeApprovedToolCalls` + `recordToolOutcome`).
- 1d. Extract Class `MemoryCycle` (`buildCycleContext` + `createMemorySaver` + `flushMemory` orchestration).
- 1e. Move all 7 inline types to `src/types/loop.ts` or co-locate next to consumers.
- 1f. `runAgent` becomes a thin orchestrator over the four phase classes.

**Risk:** 🔴 — covered by `test/agent/loop.test.ts` which is currently failing. Defer until baseline green.

---

## Problem 2 — `src/agent/orchestrator.ts`

**Smell catalog:**
1. **Mixed Concerns** — Run lifecycle DB ops + moderation + assistant pinning + RunExit persistence + child-run kickoff in one file.
2. **Duplicated Code** — Two parallel hydration paths in `executeRun` (tools=[]) and `startChildRun` (tools resolved). → Extract Function `hydrateRunStateFromAgent`.
3. **Feature Envy** — `persistRunExit` reaches deep into `dbOps.updateRunStatus` for each variant. → Replace Conditional with Polymorphism on `RunExit`.
4. **Long Function** — `executeRun` ~80 lines with 12 distinct steps. → Extract Function (×N).

**Plan:**
- 2a. Extract Function `hydrateRunStateFromAgent(agent, ...)` and call from both `executeRun` and `startChildRun`.
- 2b. Extract Function `insertAndStartRun(...)` (wraps `dbOps.createRun` + `setRootRun` + `updateRunStatus("running")`).
- 2c. Move `persistRunExit` to `src/agent/run-exit.ts` next to the type, paired with `dbRunToExit` from `resume-run.ts`.
- 2d. Extract Class `RunLifecycle` (final state).

**Risk:** 🔴 — covered by `test/agent/orchestrator.test.ts` (failing). Defer 2d. 2a/2b/2c are 🟡 if a focused type check is enough.

---

## Problem 3 — `src/agent/session.ts`

**Smell catalog:**
1. **Extract Class** — Three independent factories (`createMessageStore`, `createSessionRegistry`, `createSessionPaths`) bundled into one file/service.
2. **Shotgun Surgery** — Touching session-paths semantics requires editing the same file as message-store semantics.

**Plan:**
- 3a. Move `createMessageStore` to `src/agent/session/messages.ts`.
- 3b. Move `createSessionRegistry` to `src/agent/session/registry.ts`.
- 3c. Move `createSessionPaths` to `src/agent/session/paths.ts`.
- 3d. `src/agent/session.ts` becomes a barrel file composing the three.

**Risk:** 🔴 — `sessionService` is imported by 18 files. Mass-rename. Test/agent/session.test.ts failing. Defer.

---

## Problem 4 — Three `RunExit` renderers

**Smell catalog:**
1. **Duplicated Code** — `printExit` (cli.ts), `exitToPayload` (server.ts), `exitToText` (slack.ts).
2. **Shotgun Surgery** — Adding a new `RunExit` kind requires editing three files.

**Plan:**
- 4a. Extract Function `formatExitText(exit): string` in `src/agent/run-exit.ts`. Inline at slack.ts and cli.ts call sites.
- 4b. Extract Function `formatExitPayload(exit): { kind, ... }` in `src/agent/run-exit.ts`. Inline at server.ts.

**Risk:** 🟡 — server.ts and slack.ts have failing tests; cli.ts has no test coverage. Behavior preservation verifiable by a focused new test of `formatExitText` and `formatExitPayload`.

---

## Problem 5 — Three confirmation flows

**Smell catalog:**
1. **Divergent Change** — Each transport (CLI / Slack / evals) implements its own confirmation pattern.
2. **Speculative Generality** — `setConfirmationProvider` exists but is a no-op in `confirmation.ts`.

**Plan:**
- 5a. Wire `setConfirmationProvider` to actually inject a provider; default to the in-memory `pendingConfirmations` cache.
- 5b. Move `getPendingConfirmationRequests` from `slack-confirmation.ts` into `src/agent/confirmation.ts` so all three callers (cli, slack, evals) use one accessor.
- 5c. Replace evals' auto-approver with a `ConfirmationProvider` implementation registered via `setConfirmationProvider`.

**Risk:** 🔴 — cross-cutting behavior change. Slack tests failing. Defer.

---

## Problem 6 — Layer leaks `infra/` → `agent/`

**Smell catalog:**
1. **Inappropriate Intimacy** — `infra/events.ts`, `infra/sandbox.ts`, `infra/mcp.ts`, `infra/scheduler.ts`, `infra/condense.ts`, `infra/bootstrap.ts` reach into `agent/`.

**Plan:**
- 6a. Move `infra/bootstrap.ts` to `src/bootstrap.ts` (top-level — it already orchestrates across agent/infra/tools).
- 6b. Move `infra/scheduler.ts` to `src/agent/scheduler.ts` (it owns `executeRun` invocations).
- 6c. Pass session/run context envelope as a parameter into `bus.emit` (or split bus envelope injection into a wrapper) instead of `events.ts` reaching into `agent/context.ts`.
- 6d. Move `infra/condense.ts` to `src/llm/condense.ts` (LLM-summarization helper).
- 6e. Hoist `getSessionId()` from `agent/context.ts` into a layer-neutral location (e.g. `src/runtime/context.ts`) so `infra/sandbox.ts` and `infra/events.ts` don't reach upward.

**Risk:** 🔴 — `bus`, `sessionService`, and `executeRun` are widely imported. Defer; do after problem 1–3.

---

## Problem 7 — Reverse `types/` → `agent/` deps + runtime in `types/`

**Smell catalog:**
1. **Inappropriate Intimacy** — `types/confirmation.ts`, `types/tool-result.ts`, `types/tool.ts`, `types/events.ts` import `WaitDescriptor` from `agent/wait-descriptor.ts`.
2. **Mixed Concerns** — `types/events.ts` (`assertNever`), `types/memory.ts` (`emptyMemoryState`), `types/tool-result.ts` (`text`/`error`/`resource`) export runtime helpers.

**Plan:**
- 7a. Move `agent/wait-descriptor.ts` to `types/wait.ts`. Update all imports.
- 7b. Move `assertNever` runtime export from `types/events.ts` to `utils/assert.ts`.
- 7c. Move `emptyMemoryState` from `types/memory.ts` to `agent/memory/state.ts`.
- 7d. Move `text` / `error` / `resource` factories from `types/tool-result.ts` to `tools/result.ts` (keep type in `types/`).

**Risk:** 🟢 → 🟡 — 7a is a pure file move + import rewrite (mechanical). 7b–7d update all callers. Tools standard doc references the helper API path, so 7d also needs a docs update.

---

## Problem 8 — Filesystem-access inconsistency

**Smell catalog:**
1. **Divergent Change** — `infra/sandbox.ts` is the documented entry; bypassed by `infra/mcp-oauth.ts`, `infra/db/connection.ts`, `tools/execute_code.ts`, `config/mcp.ts`.

**Plan:**
- 8a. `tools/execute_code.ts`: replace `import * as fs from "../infra/fs.ts"` with the sandboxed `files` service. Verify session-dir read/write paths are pre-allowed.
- 8b. `config/mcp.ts`: replace `Bun.file(MCP_CONFIG_PATH)` with `files.readText` + `safeParse`.
- 8c. `infra/db/connection.ts`: bootstrap-time DB-dir creation can stay raw (documented in comment); add a code comment confirming this is the deliberate exception.
- 8d. `infra/mcp-oauth.ts`: same — keep raw `fs` (separate cache directory, documented), add a code comment.

**Risk:** 🟡 — 8a and 8b are real code changes. `tools/execute_code.ts` test is failing in baseline so verification requires a new focused test. 8c/8d are 🟢 (comment-only).

---

## Problem 9 — Tiny `utils/` files

**Smell catalog:**
1. **Speculative Generality** — `utils/errors.ts`, `utils/id.ts`, `utils/timing.ts`, `utils/xml.ts` each contain one tiny function.
2. **Duplicated Code** — `utils/errors.ts:getErrorMessage` duplicates `utils/parse.ts:errorMessage`.

**Plan:**
- 9a. Inline `getErrorMessage` callers to use `errorMessage` from `parse.ts`. Delete `utils/errors.ts`.
- 9b. Decide: leave `utils/id.ts`, `utils/timing.ts`, `utils/xml.ts` as-is (each is single-purpose and clearly named) **or** consolidate into `utils/misc.ts`. Prefer leaving them as-is — they aren't harmful, just small.

**Risk:** 🟢 — 9a is mechanical. Tests don't cover error-message helper.

---

## Problem 10 — Tiny `types/` files

**Smell catalog:**
1. **Speculative Generality** — `types/media.ts`, `types/moderation.ts`, `types/prompt.ts`, `types/sandbox.ts`, `types/serper.ts`, `types/session.ts`, `types/assistant.ts` each contain one tiny type.
2. **Mysterious Name** — `types/assistant.ts` exports `AgentConfig`, not an "Assistant".

**Plan:**
- 10a. Rename `types/assistant.ts` → `types/agent-config.ts` (or merge into `types/agent.ts`). Update all imports.
- 10b. Move tiny types next to their owners (Problem 7 already handles `tool-result.ts`).
- 10c. Leave `types/llm.ts`, `types/events.ts`, `types/db.ts` (the central contracts) intact.

**Risk:** 🟢 — 10a is a pure rename. 10b is a mechanical file move per type.

---

## Problem 11 — Specific duplications

### 11a. md5 in `edit_file.ts` + `read_file.ts`

**Plan:** Extract Function `md5(text)` to `src/utils/hash.ts`. Replace both inline calls.
**Risk:** 🟢 — behavior identical. Trivial.

### 11b. `{{hub_api_key}}` in `browser.ts` + `web.ts`

**Plan:** Extract Function `resolveHubPlaceholders(value)` to `src/utils/placeholders.ts`. Replace both call sites (browser.ts uses regex global replace, web.ts uses single replace — unify on regex).
**Risk:** 🟡 — behavioral unification (single → global replace). Is `{{hub_api_key}}` ever expected to appear once vs many? Both should be global. Add small unit test.

### 11c. Session-dir resolution in `bash.ts` + `execute_code.ts`

**Plan:** Extract Function `getSessionWorkingDir()` to `src/agent/session/paths.ts` (or `src/agent/session.ts` for now). Replace both `getBashCwd` and `getSessionDir`.
**Risk:** 🟢 — identical implementation.

### 11d. `MCP_CONFIG_PATH` in `paths.ts` + `mcp.ts`

**Plan:** Inline Variable — delete the local declaration in `config/mcp.ts`, import from `paths.ts`.
**Risk:** 🟢 — `config/paths.ts:MCP_CONFIG_PATH = join(SYSTEM_DIR, "mcp.json")` and `config/mcp.ts:MCP_CONFIG_PATH = join(WORKSPACE_DIR, "system", "mcp.json")` resolve to the same path (`SYSTEM_DIR = join(WORKSPACE_DIR, "system")`). Verified.

### 11e. `getErrorMessage` vs `errorMessage`

**Plan:** Covered by Problem 9a.
**Risk:** 🟢.

---

## Problem 12 — `infra/browser.ts`

**Smell catalog:**
1. **Mixed Concerns** — Session lifecycle + pool + idle GC + signal handlers + composition of `browser-feedback` + `browser-interventions`.
2. **Shotgun Surgery** — Browser logic split across three files; the session aggregates both helpers.

**Plan:**
- 12a. Inline `browser-feedback.ts` and `browser-interventions.ts` into `infra/browser.ts` as private helpers (or into a `infra/browser/` folder). They have only one consumer.
- 12b. Extract Class `BrowserPool` into `infra/browser/pool.ts`. Move idle-GC into the pool.
- 12c. Move signal handlers out of `browser.ts` and into `bootstrap.ts`'s `installSignalHandlers` extras.

**Risk:** 🔴 — `test/infra/browser.test.ts` failing. Defer.

---

## Problem 13 — `infra/mcp.ts`

**Smell catalog:**
1. **Mixed Concerns** — Transport + OAuth orchestration + content mapping + spillover + sampling bridge + stale-process killing + tool registration.
2. **God Function** — `createMcpService` returns a closure-bag of ~7 sub-services.

**Plan:**
- 13a. Extract Function `mapMcpContent` + `handleStructuredContent` into `infra/mcp/content.ts`.
- 13b. Extract Function `createTransport` into `infra/mcp/transport.ts` (with OAuth wired via injected callback).
- 13c. Extract Function `setupSamplingHandler` into `infra/mcp/sampling.ts`.
- 13d. Extract Function `killStaleMcpRemoteProcesses` into `infra/mcp/processes.ts`.
- 13e. Inline `mcp-oauth.ts` into `infra/mcp/oauth.ts` (already its only consumer).

**Risk:** 🔴 — no MCP test coverage. Heavy I/O. Defer.

---

## Problem 14 — `infra/db/index.ts`

**Smell catalog:**
1. **Long Module** — Four CRUD domains (sessions, runs, items, jobs) in one ~300-line file.
2. **Shotgun Surgery** — Touching one domain forces editing one file shared with three others.

**Plan:**
- 14a. Extract Module `infra/db/sessions.ts` (sessions CRUD).
- 14b. Extract Module `infra/db/runs.ts` (runs CRUD + `findRunWaitingOnChild` + `findOrphanedWaitingRuns`).
- 14c. Extract Module `infra/db/items.ts` (items CRUD).
- 14d. Extract Module `infra/db/jobs.ts` (scheduled jobs CRUD).
- 14e. `infra/db/index.ts` becomes a barrel re-exporting the four.

**Risk:** 🟡 — `dbOps` is the imported namespace; consumers use `dbOps.createSession`, `dbOps.createRun`, etc. The barrel must preserve the flat surface. DB tests partially failing but a focused infra/db test could verify shape preservation. Mechanical-ish.

---

## Problem 15 — `utils/parse.ts`

**Smell catalog:**
1. **Mixed Concerns** — JSON parsing + filesystem-name validation + prototype-pollution guard + generic assertions + byte formatting + error-message extraction.

**Plan:**
- 15a. Extract Function `formatSizeMB` to `utils/format.ts` (or co-locate with `infra/fs.ts:checkFileSize` which is its primary consumer).
- 15b. Extract Function `errorMessage` to `utils/errors.ts` (Problem 9 will instead delete `utils/errors.ts`; pick one direction).
- 15c. Move `safeFilename`/`safePath` to `utils/path.ts`. Keep `safeParse`/`validateKeys`/`assertMaxLength`/`assertNumericBounds` in `utils/parse.ts` (parse + assertions are arguably one concern: input validation).

**Risk:** 🟡 — `utils/parse.ts` exports are imported broadly; barrel re-export from `utils/index.ts` softens this.

---

## Problem 16 — `tools/registry.ts`

**Smell catalog:**
1. **Mixed Concerns** — Schema-to-LLMTool registration + multi-action expansion + dispatch + result-store integration + content serialization.
2. **Misplaced Member** — `serializeContent` operates on `ContentPart[]` from `types/llm.ts` and arguably belongs nearer to that type or in `types/tool-result.ts`.

**Plan:**
- 16a. Extract Function `serializeContent` to `src/llm/content.ts` (next to `ContentPart` type).
- 16b. Extract Class `ToolDispatcher` (`tryDispatch` + `dispatch`) into `tools/dispatcher.ts`.
- 16c. `tools/registry.ts` keeps only `register` / `registerRaw` / `getTools` / `getToolsByName` / `getToolMeta` / `reset`.

**Risk:** 🔴 — every dispatch goes through this; any wiring slip breaks all tools. Defer until baseline green.

---

## Execution order (constrained by red baseline)

Execute now (🟢 + carefully scoped 🟡):

1. **11d** — Inline duplicate `MCP_CONFIG_PATH` (single import change).
2. **11a** — Extract `md5` helper to `utils/hash.ts`.
3. **11c** — Extract `getSessionWorkingDir` helper, replacing `getBashCwd` + `getSessionDir`.
4. **11b** — Extract `resolveHubPlaceholders` helper, unifying browser/web.
5. **9a** — Delete `utils/errors.ts`; replace `getErrorMessage` callers with `errorMessage` from `parse.ts`.
6. **10a** — Rename `types/assistant.ts` → merge into `types/agent.ts`.
7. **8b** — `config/mcp.ts` switches from `Bun.file` to `files.readText`.
8. **7a** — Move `agent/wait-descriptor.ts` → `types/wait.ts`. Mechanical rewrite of imports.

Defer until baseline green (🔴):

- **1, 2, 3** — Phase classes for loop/orchestrator/session decomposition.
- **5** — Confirmation flow unification.
- **6** — Layer leak repair.
- **12, 13** — Browser/MCP module splits.
- **14** — DB module split (mechanical-ish but failing tests block verification).
- **16** — Registry/dispatcher split.

Documented exceptions (kept as-is):

- **9b** — `utils/id.ts`, `utils/timing.ts`, `utils/xml.ts` — leave; each is single-purpose and harmlessly small.
- **8c, 8d** — `infra/db/connection.ts` and `infra/mcp-oauth.ts` raw-fs use is deliberate; leave with code comment.