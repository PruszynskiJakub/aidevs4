# `src/` Responsibilities Audit

Goal: every TypeScript file in `src/`, with a grounded list of what it actually does, plus cross-cutting findings about files doing too much, too little, or duplicating responsibilities.

Methodology: each file was read in full; every responsibility below quotes a real symbol or behaviour in the code. After compilation, a sample of claims was spot-checked against the source.

---

## Table of contents

1. [`src/agent/`](#srcagent)
2. [`src/tools/`](#srctools)
3. [`src/infra/`](#srcinfra)
4. [`src/llm/`, `src/config/`, `src/utils/`](#srcllm-srcconfig-srcutils)
5. [`src/types/`](#srctypes)
6. [Top-level + `src/evals/`](#top-level--srcevals)
7. [Cross-cutting findings (consolidated)](#cross-cutting-findings-consolidated)

---

## `src/agent/`

### `src/agent/agents.ts`
**Responsibilities:**
- Loads `.agent.md` files from `AGENTS_DIR` via `Bun.Glob` and `loadOne()`, parsing YAML frontmatter with `gray-matter`.
- Validates frontmatter shape (`validate()`): requires `name`, `model` strings, non-empty body, optional `tools`/`capabilities` string arrays, optional `memory: false`.
- Resolves tool names against the registry (`resolveTools()`), warning via `console.warn` for missing ones.
- Exposes singleton `agentsService` (`makeAgentsService()`) with `listAgents()` (caches), `get()`, `resolve()` (returns `ResolvedAgent` with concrete `LLMTool[]`).

**Notable:** Re-exports `ResolvedAgent`, `AgentSummary` while also re-importing them in the same file. `cachedAgents` never invalidated.

### `src/agent/confirmation.ts`
**Responsibilities:**
- Module-scope `pendingConfirmations: Map<string, PendingConfirmation>`; `takePendingConfirmation(id)` (consume-once).
- `confirmBatch(calls)` — partitions calls into `autoApproved` vs `needsApproval` using `getToolMeta(name).confirmIf`; if any need approval, returns `GateResult` with `waitingOn = { kind: "user_approval", ... }`.
- `extractAction()` strips `${tool}__${action}` prefix using `SEPARATOR` from registry.
- `setConfirmationProvider()` is declared but a no-op (`void p`).

**Notable:** Tight coupling to `tools/registry.ts`. Comment notes the cache is "optional" — durable record is the run row.

### `src/agent/context.ts`
**Responsibilities:**
- Owns the single `AsyncLocalStorage<RunContext>` (`{ state, log }`).
- `runWithContext(state, log, fn)` enters scope.
- Optional + `require*` accessors: `getState`/`requireState`, `getLogger`/`requireLogger`, `getSessionId`/`requireSessionId`, plus convenience getters `getAgentName`, `getRunId`, `getRootRunId`, `getParentRunId`, `getTraceId`, `getDepth`.

**Notable:** Tiny, single-purpose. Pure ALS plumbing, no I/O.

### `src/agent/loop.ts`
**Responsibilities:**
- `setupSession()` builds composite logger (Markdown + Console), attaches bus listener (`attachLoggerListener`), creates JSONL writer; returns `dispose()`.
- `resolveAgentForRun()` calls `agentsService.resolve()`, mutates `state.model`/`state.tools`, builds workspace prefix.
- `executeActPhase()` sends LLM call, accumulates tokens, emits `generation.started`/`generation.completed`.
- `dispatchTools()` runs confirmation gate, dispatches via `tools/registry.dispatch`, records `tool.succeeded`/`tool.failed`, surfaces a `WaitDescriptor` from gate or any tool result.
- `buildCycleContext()` decides memory pipeline involvement (`processMemory` vs pass-through) and swaps `state.messages`.
- `createMemorySaver()` saves only when serialized memory changed.
- `runCycle()` orchestrates one Plan/Act turn: build context, act, splice messages, save memory, return `completed`/`waiting`/`continue`.
- `runIteration()` tracks iteration, increments DB cycle count, emits `turn.started`/`turn.completed`, calls `finalizeTerminal()`.
- `runAgent()` (public) wires session resources, enters context, runs loop, emits `emitFailureTerminal` on error.

**Notable:** Largest agent file. Seven internal types declared inline (`SessionResources`, `RunContext`, `SettledOutcome`, `MemoryContext`, `CycleOutcome`, `IterationDeps`, `LoopResult`).

### `src/agent/orchestrator.ts`
**Responsibilities:**
- `executeRun()` — top-level entry: generates session id, creates session, picks assistant (`pickAssistantName()` preferring session-pinned), runs `moderateAndAssert()` (Moderation API), pins assistant, generates `runId`/`traceId`/`depth`, inserts run row via `dbOps.createRun`, marks running, appends user message, hydrates `RunState`, calls `runAndPersist`.
- `runAndPersist()` — runs the loop, persists messages via `sessionService.appendRun`, writes terminal status via `persistRunExit()`, kicks child runs async on `child_run` waits.
- `createChildRun()`, `startChildRun(runId)` — child entry points.
- `hydrateRunState()` — rebuilds `RunState` from messages + persisted memory.
- `moderateAndAssert()` — emits `input.flagged`/`input.clean`, throws via `assertNotFlagged`.
- `kickChildRunAsync()` — fires `startChildRun` without await; on failure calls `resumeRun(parentRunId, ...)`.

**Notable:** Imports from `resume-run.ts` — circular-conceptual coupling. Two parallel hydration paths (one builds tools=[], one resolves tools eagerly).

### `src/agent/resume-run.ts`
**Responsibilities:**
- `resumeRun(runId, resolution)` — DB-load, idempotent no-op for non-`waiting`, validates `waitingOn.kind`, loads transcript.
- `findPendingToolCalls()` — walks history backwards, finds latest assistant message with unanswered `toolCalls`.
- For `user_approval` resolutions: dispatches each approved call (`dispatch()` from `tools/registry`); denies become `"Error: Tool call denied by operator."` messages.
- For `child_run` resolutions: writes child's `result` string as the tool message body for every pending call.
- Persists synthetic messages, transitions `waiting → running` with optimistic `expectedVersion`, emits `run.resumed`, rebuilds `RunState`, calls `runAndPersist()`.
- `dbRunToExit()` — maps DB rows to `RunExit`.

**Notable:** `parentDepth` heuristic on line 182 is `run.parentId ? 1 : 0` — does not honor any deeper original depth.

### `src/agent/run-continuation.ts`
**Responsibilities:**
- `registerContinuationSubscriber()` subscribes `handleChildTerminal` to `run.completed`/`run.failed` on bus.
- `handleChildTerminal()` finds parent waiting on the child via `dbOps.findRunWaitingOnChild`, formats `result` via `childExitToResult()`, emits `run.child_terminal`, calls `resumeRun(parent.id, ...)`.
- `reconcileOrphanedWaits()` — startup sweep for crash-gap recovery (parents whose child already terminal).

**Notable:** Single coherent concern.

### `src/agent/run-exit.ts`
**Responsibilities:**
- Defines a single discriminated union `RunExit` (`completed | failed | cancelled | waiting | exhausted`).

**Notable:** Pure type file, ~7 lines.

### `src/agent/run-telemetry.ts`
**Responsibilities:**
- Typed thin wrappers around `bus.emit`: `emitRunStarted`, `emitAgentStarted`, `emitTurnStarted`, `emitTurnCompleted`, `emitGenerationStarted`, `emitGenerationCompleted`, `emitToolCalled`, `emitToolSucceeded`, `emitToolFailed`, `emitBatchStarted`, `emitBatchCompleted`.
- Composite terminal helpers: `emitAnswerTerminal`, `emitMaxIterationsTerminal`, `emitFailureTerminal` — each fires multiple events with synchronously-snapshotted tokens.

**Notable:** Mix of single-event one-liners and composite emitters — inconsistent granularity.

### `src/agent/session.ts`
**Responsibilities:**
- Message ↔ DB-item conversion: `userMessageToItem`, `assistantMessageToItems` (also serializes `providerMetadata` like Gemini `thoughtSignature` into `function_call`'s `content` column), `messagesToItems`, `parseUserContent`, `collectAssistantToolCalls`, `itemsToMessages`. Drops `system` messages.
- `persistMessages()` — allocates next sequence via `dbOps.nextSequence`, writes via `dbOps.appendItem`/`appendItems`.
- `createMessageStore()` — `appendMessage`, `appendRun`, `getMessages` (per-run or per-session).
- `createSessionRegistry()` — `getOrCreate`, `setAssistant`, per-session serial queue (`enqueue<T>`), `_clearQueues`.
- `createSessionPaths()` — `sessionDir(date)`, `logDir`, `sharedDir`, `ensureSessionDir`, `outputPath(filename)` (creates `{agentName}/output/`, returns randomized `${randomSessionId}${ext}`), `toSessionPath`/`resolveSessionPath`.
- Composes the three factories into singleton `sessionService` and exposes `_clear()`.

**Notable:** Three independent factories bundled. `outputPath` randomizes filename even for identical inputs.

### `src/agent/wait-descriptor.ts`
**Responsibilities:**
- Defines `WaitDescriptor` union (`user_approval | child_run`), deprecated alias `Wait`, `WaitResolution` union.

**Notable:** Comment claims `child_run` is "Reserved placeholder…not triggered" — but `loop.ts` returns it from `dispatchTools()` and `orchestrator.ts`/`run-continuation.ts` consume it. Comment is stale.

### `src/agent/workspace.ts`
**Responsibilities:**
- Static `workspace` constant (path tree from `config.paths` + `config.browser`).
- Hardcoded `NAV_INSTRUCTIONS` template (long markdown describing workspace layout, knowledge-base rules).
- `readFileSafe()`, `loadWorkflows()` — read live workspace content via `infra/sandbox`.
- `buildWorkspaceContext()` assembles `<workspace-navigation>` system-prompt block combining static text + live knowledge index + workflows.

**Notable:** Hardcoded prompt text in a `.ts` file violates project rule "No hardcoded prompts — never put prompt text in `.ts` files".

### `src/agent/memory/generation.ts`
**Responsibilities:**
- Single helper `buildMemoryGeneration(name, model, inputMessages, response, startTime, durationMs)` — converts input/response to `MemoryGeneration` event payload.

**Notable:** Tiny, single-purpose.

### `src/agent/memory/observer.ts`
**Responsibilities:**
- `truncateToTokens()` — char-budget truncation (`maxTokens * 4`).
- `serializeMessages()` — formats messages into `[USER]`/`[ASSISTANT]`/`[TOOL_RESULT]` blocks with config-driven budgets.
- `observe()` — loads `observer.md` prompt, calls `provider.chatCompletion`, treats `NO_NEW_OBSERVATIONS`/empty as no-op, returns `{ text, generation }`.

**Notable:** Imports `estimateTokens` but never uses it. Re-exports `ObserveResult` while also re-importing it.

### `src/agent/memory/persistence.ts`
**Responsibilities:**
- `sessionOutputDir()` — `{sessionsDir}/{YYYY-MM-DD}/{sessionId}` using current clock.
- `saveState(sessionId, state)` — writes `memory-state.json`.
- `loadState(sessionId)` — reads + parses `memory-state.json`; returns `null` on missing.
- `saveDebugArtifact(sessionId, type, content, metadata)` — writes `${type}-NNN.md` with YAML frontmatter; sequence based on `files.readdir`.

**Notable:** Date is recomputed at every call — day-boundary saves can split. Mixes runtime state with debug-artifact writing.

### `src/agent/memory/processor.ts`
**Responsibilities:**
- `appendObservationsToPrompt()`, `combineObservations()`, `passThrough()` — string composition utilities.
- `processMemory()` — token-budget split heuristic (walks backwards to set `splitIndex`, pulls back so `tool` message stays with its `assistant` `tool_calls`); runs `observe()`, emits `memory.observation.*` events, persists artifact, optionally runs `reflect()` (graceful degradation), emits `memory.reflection.*`. Returns `{ context, state }`.
- `flushMemory()` — end-of-session hook; observes tail above hardcoded 1,000 tokens.

**Notable:** Hardcoded `1_000` in `flushMemory` (everything else is config-driven). Uses `estimateMessagesTokens([m])` per-iteration in backwards walk.

### `src/agent/memory/reflector.ts`
**Responsibilities:**
- `COMPRESSION_GUIDANCE` lookup table (levels 0/1/2) — text guidance about which `🟢/🟡/🔴` priority items to keep.
- `reflect(observations, targetTokens, provider)` — iterates up to `config.memory.maxReflectionLevels` levels, loads `reflector.md`, accumulates `MemoryGeneration[]`, stops early on target hit, falls back to "smallest seen" output.

**Notable:** Hardcoded compression text in `.ts` file (parameterized into the prompt rather than the full prompt, but still text-in-code).

---

## `src/tools/`

### `src/tools/agents_hub.ts`
**Responsibilities:**
- Multi-action tool: `verify | verify_batch | api_request | api_batch`. POSTs to `hub.ag3nts.org` via `hubPost` from `utils/hub-fetch.ts`.
- `verify()` — submits single answer; auto-injects `apikey`; uses `resolveInput` (file/inline JSON/raw).
- `apiRequest()` — POSTs to `${baseUrl}/api/${path}`; rejects non-object resolved bodies.
- `apiBatch()` — reads JSON array file, applies `field_map_json` rename, sequential POST per row, persists partial results, stops on first error.
- `verifyBatch()` — same shape but for verify-style answers.
- Per-payload validation: `assertMaxLength`, `safePath`, `validateKeys`, `safeParse`. Batch row cap via `config.limits.maxBatchRows`.

**Notable:** Mixes hub-verify semantics with generic API calls. `apiBatch`/`verifyBatch` duplicate the sequential-batch loop.

### `src/tools/bash.ts`
**Responsibilities:**
- Resolves per-session CWD (`getBashCwd`) using `getSessionId` + `config.paths.sessionsDir` + date folder.
- `assertWritesInSessionDir(command, cwd)` — regex-extracts `>`/`>>`/`tee` redirects, rejects out-of-CWD targets.
- Executes via `Bun.$`bash -c ${command}``.cwd().quiet().nothrow()` raced against `setTimeout` rejection.
- Clamps `timeout` to `[1000, 120000]`. Truncates output to `MAX_OUTPUT = 20_000` chars.
- Composes stdout+stderr, prefixes `[exit code N]` when nonzero.

**Notable:** Ad-hoc shell sandboxing via regex (redirect detection) lives in the tool, not in `infra/sandbox.ts`.

### `src/tools/browser.ts`
**Responsibilities:**
- Five actions: `navigate`, `evaluate`, `click`, `type_text`, `take_screenshot`.
- Page-artifact persistence: `urlSlug`, `extractNumberedText`, `extractDomStructure` (in-page recursive walk respecting `structMaxNodes`/`structMaxDepth`), `savePageArtifacts`.
- Error-page detection (`detectErrorPage`) — HTTP ≥ 400 + regex pattern list.
- Feedback piping (`appendFeedback`) — calls `feedbackTracker`/`interventions` from session and appends `Note:` lines.
- `navigate` builds multi-part `ContentPart[]` with resource refs; conditionally appends instruction-file note from `workspace/knowledge/browser/<host>.md`.
- `evaluate` races `page.evaluate` with timeout, truncates at `MAX_RESULT = 5000`.
- `click` enforces XOR between `css_selector` and `text`.
- `typeText` substitutes `{{hub_api_key}}` via `resolveValuePlaceholders`.
- `takeScreenshot` falls back to viewport-only when full-page exceeds `screenshotMaxBytes`; returns `{type:"image", data:base64}` + path text.

**Notable:** Big file mixing several concerns (artifact extraction, feedback hints, multimodal results). `resolveValuePlaceholders` duplicated with `web.ts`.

### `src/tools/delegate.ts`
**Responsibilities:**
- Top-level `await agentsService.listAgents()` builds Zod `z.enum(agentNames)` and embeds an agent list into `description`.
- `delegate(args, ctx)` validates non-empty `prompt` (max 10000), reads `getRunId`/`getRootRunId`/`getTraceId`/`getDepth`/`getLogger`.
- Calls `createChildRun` from `agent/orchestrator` with `sourceCallId: ctx?.toolCallId`.
- Emits `bus.emit("run.delegated", ...)`, returns parking signal `{ wait: { kind: "child_run", childRunId } }`.

**Notable:** Couples to `agent/orchestrator`, `agent/context`, `agent/agents`, `infra/events`. Schema is computed via top-level await.

### `src/tools/document_processor.ts`
**Responsibilities:**
- Multi-action shell with one action `ask`.
- `buildContentPart(path)` — classifies extension via `IMAGE_EXTENSIONS`/`TEXT_EXTENSIONS`, enforces `config.limits.maxFileSize`, returns image or text part.
- `cleanPath` strips legacy `file://` prefix with a warn.
- `ask()` — validates `file_paths`, runs `safePath` per entry, builds `ContentPart[]`, calls `llm.chatCompletion({ model: config.models.gemini, ... })`.

**Notable:** Hardcodes Gemini model. Multi-action shape unused beyond `ask`.

### `src/tools/edit_file.ts`
**Responsibilities:**
- Single tool. Validates `file_path`, `old_string`, `new_string`, `replace_all`, `checksum`, `dry_run` (`MAX_STRING_LENGTH = 64KB`).
- Rejects identical `old_string === new_string`.
- Reads via `files.readText`; optionally verifies `md5` matches `checksum`.
- `countOccurrences` enforces uniqueness unless `replace_all`.
- In dry-run, generates `unifiedDiff` (custom hand-rolled `--- a/+++ b/@@` formatter, 3-line context).
- On non-dry-run, writes via `files.write`, returns new md5.

**Notable:** Hand-rolls own diff renderer (~40 lines). `md5` logic duplicated with `read_file.ts`.

### `src/tools/execute_code.ts`
**Responsibilities:**
- `findDeno()` — checks `~/.deno/bin/deno`, `/usr/local/bin/deno`, `/opt/homebrew/bin/deno`, then `which deno`; memoizes via `_denoBin`.
- `getSessionDir` — duplicates `bash.ts`'s `getBashCwd`.
- `sanitizeOutput` — replaces sessionDir → `./`, projectRoot → `WORKSPACE`.
- Validates `code` (max 100,000), `description`, `timeout` (`[1000, 120000]`).
- Spins per-call bridge (`startBridge` from `./sandbox/bridge.ts`).
- Builds prelude + user code, writes to `_exec_<rand>.ts`, spawns `deno run --allow-net=127.0.0.1:<port> --no-prompt` (or `bun run` fallback).
- Captures stdout/stderr, races against timeout, kills on timeout, truncates to `MAX_OUTPUT = 20_000`.
- Cleans tmp file in `finally`; stops bridge.

**Notable:** Imports `* as fs from "../infra/fs.ts"` — only tool bypassing the sandboxed `files` service. Violates project rule.

### `src/tools/geo_distance.ts`
**Responsibilities:**
- Two actions: `find_nearby`, `distance`.
- Pure haversine math (`haversine` exported, `roundTo3`, `toRad`).
- Coordinate validation via `assertNumericBounds`.
- `findNearby` — reads two JSON files, computes O(n*m) pairwise haversine, filters by `radius_km` (validated `[0.001, 40075]`), sorts, returns `{count, matches}`.
- `distance` — single haversine pair from inline lat/lon.

**Notable:** Tight, single-domain.

### `src/tools/glob.ts`
**Responsibilities:**
- Single tool. Validates `pattern` (max 512), `path` (max 1024).
- `files.stat` + `Bun.Glob(pattern).scan({ absolute: true })`.
- Caps at `MAX_RESULTS = 500`, sorts, formats `Total: N file(s)` + truncation note + `\nNote:` hint.

**Notable:** Tiny, single-purpose.

### `src/tools/grep.ts`
**Responsibilities:**
- Single tool. Validates `pattern`, `path`, `include`, `case_insensitive`.
- Compiles `RegExp(pattern, "i" | "")`, throws `Invalid regex` on construct failure.
- Iterates `Bun.Glob(include).scan(...)`; per file: `stat`, `checkFileSize`, `readText`, per-line regex test.
- Caps: `MAX_TOTAL_LINES = 200`, `MAX_FILES_WITH_MATCHES = 50`, `PER_FILE_CAP = 20`.
- Formats `path:line:content` + summary + truncation note + hint.

**Notable:** Mirrors `glob.ts` structurally.

### `src/tools/index.ts`
**Responsibilities:**
- Imports each tool default and calls `register(tool)` for 17 tools.
- Manages MCP service lifecycle: stores instance on `globalThis.__mcpService` for hot-reload disconnect; creates `createMcpService(llm)`; exports `initMcpTools()` and `shutdownMcp()`.
- Re-exports registry surface (`register`, `registerRaw`, `getTools`, `getToolsByName`, `dispatch`, `reset`, `mcpService`).

**Notable:** Two concerns: tool registration + MCP lifecycle. Hot-reload guard is module-side-effecty.

### `src/tools/prompt_engineer.ts`
**Responsibilities:**
- Single tool. Validates 5 string inputs (per-field max lengths from 1000 to 5000).
- Loads `prompt-engineer` template, builds multi-section markdown user prompt.
- Calls `llm.completion({ model: prompt.model ?? config.models.agent, ... })`.
- Strips ` ```json ... ``` ` fences; `safeParse`s; validates `parsed.prompt` is string.
- Returns JSON `{prompt, token_estimate, reasoning}` text.

**Notable:** Same skeleton as `think.ts` (load prompt → completion → return).

### `src/tools/read_file.ts`
**Responsibilities:**
- Single tool. Validates `file_path`, `offset≥1`, `limit≥1` (defaults 1/2000).
- `files.checkFileSize`, `readText`, computes md5 of full content.
- Slices `[offset-1, offset-1+limit)`, formats cat -n style, appends `Checksum: <md5> | Lines: <total>` + hint.

**Notable:** md5 logic duplicates `edit_file.ts`.

### `src/tools/registry.ts`
**Responsibilities:**
- Module state `handlers: Map<string, ToolDefinition>`, `expandedTools: LLMTool[]`.
- `zodToParameters` (`z.toJSONSchema(schema)` minus `$schema`).
- `register(tool)` rejects duplicates; if `schema.actions` exists, expands each action into `${name}__${action}` LLMTool with concatenated description; else single tool. Always `strict: true`.
- `registerRaw(...)` bypasses Zod for MCP tools (`strict: false`).
- `getTools`, `getToolsByName`, `getToolMeta`.
- `serializeContent(parts)` — stringifies text/image/resource parts.
- `tryDispatch`/`dispatch` — `safeParse` of args, invokes handler, completes via `resultStore`, propagates `wait`, wraps errors.
- `reset()` clears state.

**Notable:** Three concerns: registration (Zod conversion + multi-action expansion), dispatch + result-store integration, and content serialization.

### `src/tools/scheduler.ts`
**Responsibilities:**
- Seven actions: `schedule`, `delay`, `list`, `get`, `pause`, `resume`, `delete`.
- `validateId` (regex), `validateCron` (constructs `new Cron()`).
- `scheduleAction` — `randomUUID()`, `dbOps.createJob`, `scheduler.scheduleCron`.
- `delayAction` — `delayToRunAt`, `dbOps.createJob`.
- `listAction`/`getAction` — formats output.
- `pauseAction`/`resumeAction`/`deleteAction` — DB status updates + `scheduler` cancel/re-schedule.

**Notable:** Cleanly delegates to `infra/db` and `infra/scheduler`. Uses `payload as any` casts.

### `src/tools/shipping.ts`
**Responsibilities:**
- Two actions `check` and `redirect` against `${baseUrl}/api/packages` via `hubPost`.
- `validateAlphanumeric` for `packageid`/`destination`.
- `redirect` extracts `confirmation` from response and prepends instructional `IMPORTANT:` line.

**Notable:** Effectively a domain-specific subset of `agents_hub.api_request`.

### `src/tools/think.ts`
**Responsibilities:**
- Single tool. Validates `thought` (max 5000 — error label says `"question"`).
- Loads `think` prompt, calls `llm.completion({ model: prompt.model ?? config.models.agent, ... })`.
- Returns LLM result as text.

**Notable:** Tiny — same skeleton as `prompt_engineer.ts`. `assertMaxLength(thought, "question", 5_000)` — label disagrees with field name.

### `src/tools/web.ts`
**Responsibilities:**
- Two actions: `download`, `scrape`.
- `assertHostAllowed(hostname)` — checks `config.sandbox.webAllowedHosts`.
- `download` — `safeFilename`, substitutes `{{hub_api_key}}`, `fetch` with timeout, writes via `sessionService.outputPath`/`files.write`, returns `[resource(...), text(...)]`.
- `scrape` — validates URL array (cap = `config.limits.maxBatchRows`), `Promise.allSettled` over `scrapeSingle` (`scrapeUrl` from `infra/serper.ts` + `condense` from `infra/condense.ts`).

**Notable:** `{{hub_api_key}}` substitution duplicated with `browser.ts`. `scrape` transparently summarizes via LLM rather than returning raw.

### `src/tools/write_file.ts`
**Responsibilities:**
- Single tool. Validates `file_path` (max 1024), `content` is string.
- Auto-creates parent dir via `files.mkdir(dirname(path))`.
- Writes via `files.write`, reports byte count via `TextEncoder().encode(content).length`.

**Notable:** Tiny, single-purpose. No content-length cap on write (only path length).

### `src/tools/sandbox/bridge.ts`
**Responsibilities:**
- `startBridge({readPaths, writePaths, cwd})` — creates sandboxed `FileProvider` via `createSandbox`.
- Spawns `Bun.serve({port:0, hostname:"127.0.0.1"})` HTTP server with endpoints `read_file`, `read_json`, `write_file`, `list_dir`, `exists`, `stat`, `mkdir`.
- Resolves relative `body.path` against configured `cwd`.
- Returns `{port, stop}` handle.

**Notable:** Single, clear responsibility.

### `src/tools/sandbox/prelude.ts`
**Responsibilities:**
- `generatePrelude(bridgePort, sessionDir)` returns a TypeScript source string.
- Generates `SESSION_DIR`, `_BRIDGE_URL`, `_bridge(endpoint, body)` HTTP wrapper, plus `tools.{readFile, readJson, writeFile, listDir, exists, stat, mkdir}` async methods.

**Notable:** Pure code-generation helper, complementary to `bridge.ts`.

---

## `src/infra/`

### `src/infra/bootstrap.ts`
**Responsibilities:**
- `initServices()` — boot banner, `initTracing()`, `attachLangfuseSubscriber(bus)`, `registerContinuationSubscriber()`, `initMcpTools()`, `scheduler.loadAll()`, `reconcileOrphanedWaits()`.
- `shutdownServices()` — stops scheduler, tracing, MCP, closes sqlite.
- `installSignalHandlers(extra?)` — `SIGTERM`/`SIGINT` graceful shutdown then `process.exit(0)`.

**Notable:** Reaches across layering: imports from `../tools/index.ts` and `../agent/run-continuation.ts` (infra → tools/agent).

### `src/infra/browser-feedback.ts`
**Responsibilities:**
- `createBrowserFeedbackTracker()` factory; closure state `history`, `consecutive`, `lastHostname`, `totalCount`, `successCount`.
- `record(event)` (bounded `MAX_HISTORY = 20`), `consecutiveFailures`, `lastVisitedHostname`, `stats`.
- `generateHints(tool, outcome, error)` — pattern-matches error strings (`json`, `trailing comma`, `timeout`, `null`, `cannot read properties`).

**Notable:** Self-contained; no LLM, no I/O.

### `src/infra/browser-interventions.ts`
**Responsibilities:**
- `createBrowserInterventions(tracker)` — three flags: `screenshotHintSent`, `discoveryHintSent`, `hadFailures`.
- `checkScreenshotHint`, `checkDiscoveryHint`, `checkEndOfTaskHint` — one-shot string hints.

**Notable:** Tiny (~40 lines). Hardcoded user-facing copy and paths (`workspace/scratch/...`).

### `src/infra/browser.ts`
**Responsibilities:**
- `createBrowserSession()` — Playwright `chromium.launch()`, owns `Browser`/`Context`/`Page`, `lastActivity`.
- `launch()` — restores `storageState` from `config.browser.sessionPath`.
- `saveSession()` — atomic write via tmp + `fsRename`.
- Exposes `feedbackTracker` + `interventions` on the session — composes both sibling files.
- `createBrowserPool()` — keyed map by `requireSessionId()`, idle-timeout `setInterval` (30s), `maxPoolSize`.
- Registers `SIGINT`/`SIGTERM` handlers (`browserPool.closeAll()`).

**Notable:** Aggregates two sibling files. Mixes session lifecycle, pool, idle GC, signal handlers.

### `src/infra/condense.ts`
**Responsibilities:**
- Single function `condense(opts)` — token-thresholded summarization.
- Below `DEFAULT_THRESHOLD = 3000` tokens: pass-through.
- Above: writes raw to `sessionService.outputPath(filename)`, loads `condense-tool-result` prompt, calls `provider.completion()`, returns `{ text, fullPath, condensed }`.

**Notable:** Cross-layer (llm + prompt + sandbox + sessionService + tokens).

### `src/infra/db/connection.ts`
**Responsibilities:**
- Synchronous `mkdirSync(dirname(config.database.url))`.
- Opens `bun:sqlite` Database; sets `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.
- Wraps with `drizzle(sqlite, { schema })`. Exports `db` and `sqlite`.

**Notable:** Side effects on import. Comment notes deliberate use of raw `fs` at this layer.

### `src/infra/db/index.ts`
**Responsibilities:**
- Re-exports `db, sqlite`.
- Sessions: `createSession`, `getSession`, `touchSession`, `setRootRun`, `setAssistant`.
- Runs: `createRun`, `getRun`, `updateRunStatus` (optional optimistic lock via `expectedVersion`), `incrementCycleCount`, `listRunsBySession`, `findRunWaitingOnChild`, `findOrphanedWaitingRuns`.
- Items: `nextSequence`, `appendItem`, `appendItems` (transaction), `listItemsByRun`, `listItemsBySession`, `getItemByCallId`.
- Scheduled jobs: `createJob`, `getJob`, `listJobs`, `listActiveJobs`, `listDueOneShots`, `updateJobStatus`, `updateJobExecution`, `deleteJob`.
- `_clearAll()` test helper.

**Notable:** Four CRUD domains in one ~300-line file. `findOrphanedWaitingRuns` does post-fetch filtering in JS.

### `src/infra/db/migrate.ts`
**Responsibilities:**
- One line: `migrate(db, { migrationsFolder: "./src/infra/db/migrations" })`.

**Notable:** Trivial.

### `src/infra/db/schema.ts`
**Responsibilities:**
- Drizzle SQLite schemas: `sessions`, `runs`, `items`, `scheduledJobs`.
- Enums (`JobStatus`, `JobRunStatus`), `timestamp()` column helper using sqlite `strftime`.
- `runs_root_run_rule` check constraint and three indexes.
- `idx_items_run_seq` unique index, `idx_items_call_id`. `idx_jobs_status`.

**Notable:** Pure schema; self-contained.

### `src/infra/events.ts`
**Responsibilities:**
- `createEventBus()` factory; closure over `exact: Map<EventType, Set<Listener>>` and `wildcards: Set<WildcardListener>`.
- `emit(type, data)` — `randomUUID()`, attaches `ts`, pulls envelope from `agent/context.ts` ALS (`sessionId`, `runId`, `rootRunId`, `parentRunId`, `traceId`, `depth`).
- `on/off/onAny/offAny/clear`.
- Singleton `bus` + factory.

**Notable:** Couples `infra` to `agent/context.ts` for envelope injection.

### `src/infra/fs.ts`
**Responsibilities:**
- Thin wrappers around `fs/promises` and `Bun.file/Bun.write`: `exists`, `readText`, `readBinary`, `readJson`, `write`, `append`, `fsReaddir`, `fsStat`, `fsMkdir`, `fsUnlink`, `fsRename`.
- `checkFileSize(stat, maxBytes, displayPath)` — throws `FileSizeLimitError`.
- `class FileSizeLimitError extends Error`.

**Notable:** Header note "no access control" — pairs with `sandbox.ts`.

### `src/infra/guard.ts`
**Responsibilities:**
- Lazy `getClient()` for OpenAI SDK.
- `moderateInput(text)` — short-circuits when `config.moderation.enabled` is false; calls `moderations.create`, normalizes categories, logs, fail-open on errors.
- `assertNotFlagged(result)` — throws if flagged.
- `_setClient(c)` test override.

**Notable:** Uses `log` directly (not bus).

### `src/infra/langfuse-subscriber.ts`
**Responsibilities:**
- `attachLangfuseSubscriber(bus)` — early-out via `isTracingEnabled()`; dynamic `require("@langfuse/tracing")`.
- `SubscriberState` with multiple maps (`agentMap`, `turnMap`, `turnStartMap`, `toolMap`, `agentAnswerMap`, `memoryMap`, `pendingModeration`).
- Seven handler groups: session, turn, generation, tool, agent-answer, memory, moderation. Each opens/ends Langfuse observations keyed by `runId`/`toolCallId`.
- Helpers: `truncate`, `nestGeneration`, `withAgentCtx` (OTel `context.with`), `parentFor`, `endAgentObs`, `clearAll`.

**Notable:** ~540 lines. Largest infra file.

### `src/infra/log/bridge.ts`
**Responsibilities:**
- `attachLoggerListener(bus, log, sessionId?)` — translates bus events to `Logger` method calls.
- Filters by `sessionId`.
- Maps each event class to a logger method (`run.started → log.info`, `tool.called → log.toolHeader`, etc.).

**Notable:** Pure adapter.

### `src/infra/log/composite.ts`
**Responsibilities:**
- `createCompositeLogger(targets)` — Proxy that fans every method call to all targets.

**Notable:** Six effective lines.

### `src/infra/log/console.ts`
**Responsibilities:**
- ANSI color constants and helpers (`truncate`, `formatVal`, `summarizeArgs`, `summarizeResult`, `tokenSuffix`).
- `LEVEL_ORDER` map and `isEnabled` filter.
- `class ConsoleLogger implements Logger` — `step`, `llm`, `toolHeader`/`toolCall`/`toolOk`/`toolErr`, `batchDone`, `answer`, `maxIter` (always-on), plus level-filterable `info`/`success`/`error`/`debug`/`memoryObserve`/`memoryReflect`.

**Notable:** Self-contained presenter.

### `src/infra/log/jsonl.ts`
**Responsibilities:**
- `defaultPathFn(event)` — `{sessionsDir}/{date}/{sessionId}/log/events.jsonl`.
- `extractPayload` strips `ENVELOPE_KEYS`.
- `createJsonlWriter(pathFn?)` — wildcard listener serializing `{id, type, ts, sid?, cid?, data}` per line; chains writes; lazy mkdir cached in `ensuredDirs`.
- `compactData` — drops `input` from `generation.completed`, `result` from `tool.succeeded`.

**Notable:** Persists by date+session.

### `src/infra/log/logger.ts`
**Responsibilities:**
- Single line: `export const log: Logger = new ConsoleLogger();`.

**Notable:** Three-line file.

### `src/infra/log/markdown.ts`
**Responsibilities:**
- `class MarkdownLogger implements Logger` with sandboxed `FileProvider` (per-instance `createSandbox({ writePaths: [sessionDir] })`).
- Validates `sessionId` against `/^[a-zA-Z0-9_\-]+$/`.
- `toolOk` off-loads results > `MAX_INLINE_SIZE = 10240` to a sidecar `.txt` file.
- `flush()`/`dispose()` (removes `beforeExit` listener).

**Notable:** Substantial sidecar logic; owns its own filesystem instance.

### `src/infra/mcp-oauth.ts`
**Responsibilities:**
- Per-server JSON state persistence (`tokens.json`, `client-info.json`, `verifier.txt`, `discovery.json`) using raw `fs`.
- `createOAuthProvider(serverName, callbackPort=8090)` — implements `OAuthClientProvider` interface (clientMetadata, save/load, redirectToAuthorization spawning `open`/`start`/`xdg-open`, codeVerifier, discoveryState, invalidateCredentials).
- `waitForOAuthCallback(port)` — `node:http` server on `127.0.0.1:port` parsing `/callback` query; 5-minute timeout; HTML response pages.

**Notable:** Combines persistence + browser-launching + HTTP callback. Uses raw `fs` (bypasses sandbox).

### `src/infra/mcp.ts`
**Responsibilities:**
- `normalizeName(name)` — strips non-alphanumeric/underscore.
- `createTransport(serverConfig)` — switch over `stdio | sse | http` returning correct transport (wires OAuth for http via `createOAuthProvider`).
- `mapMcpContent(content)` — translates MCP content to local `ContentPart[]`; strips `file://` on resource URIs.
- `handleStructuredContent(...)` — token threshold (`STRUCTURED_CONTENT_TOKEN_LIMIT = 3000`); inline or write+ref.
- `killStaleMcpRemoteProcesses()` — `pgrep -f mcp-remote` + SIGTERM.
- `createMcpService(llmProvider)` — manages connected-server map: `connect()` (with OAuth retry), `setupSamplingHandler` (bridges MCP `CreateMessage` to `llmProvider.chatCompletion`), `registerTools()` (registers `mcp_<server>_<tool>` via `registerRaw`), `disconnect()`.

**Notable:** Crosses many concerns; reaches into `tools/registry.ts` and `agent/session.ts`.

### `src/infra/result-store.ts`
**Responsibilities:**
- `createResultStore()` — `Map<string, ToolCallRecord>` keyed by `toolCallId`.
- `create(toolCallId, toolName, args)` — pre-registers `pending`.
- `complete(toolCallId, result, tokens)` — finalizes with `ok`/`error`; auto-creates if missing.
- `get`, `list`, `clear`. Singleton `resultStore` + factory.

**Notable:** Pure in-memory store.

### `src/infra/sandbox.ts`
**Responsibilities:**
- `toRelative(absolutePath)` — formats paths relative to project root.
- `narrowOutputPaths` — at write, replaces a generic `sessionsDir` allowed entry with `{sessionsDir}/{date}/{sessionId}` when there's a session.
- `assertPathAllowed(target, allowed, blocked, op, sessionsDir)` — resolves and checks containment.
- `createSandbox(opts)` — returns `FileProvider` (`exists`, `readText`, `readBinary`, `readJson`, `write`, `append`, `readdir`, `stat`, `mkdir`, `unlink`, `rename`, `checkFileSize`).
- Default singleton `sandbox`.
- `resolveInput(input, label, fileProvider?)` — file path, inline JSON, or raw string.

**Notable:** Couples to `agent/context.ts` for `getSessionId()`.

### `src/infra/scheduler.ts`
**Responsibilities:**
- `parseDelay(delay)` — regex `/^(\d+)([mhd])$/` → ms; rejects > `MAX_DELAY_DAYS = 30`.
- `delayToRunAt(delay)`.
- `executeJob(job)` — fresh `randomSessionId()`, `sessionService.enqueue` + `executeRun({ sessionId, prompt: job.message, assistant: job.agent })`, updates `dbOps.updateJobExecution`, marks one-shots completed.
- `scheduleCron(job)` — `new Cron(...)` with freshness re-check; tracks in `cronJobs: Map<id, Cron>`.
- `cancelJob(id)`. `pollOneShots()` polls due one-shots.
- `loadAll()` reschedules cron jobs from DB on startup; starts `setInterval(POLL_INTERVAL_MS = 60_000)`.
- `shutdown()` stops crons + clears poll timer.
- `_activeCronCount`, `_hasPollTimer` test hooks.

**Notable:** Reaches into `agent/orchestrator.ts` and `agent/session.ts`.

### `src/infra/serper.ts`
**Responsibilities:**
- `getApiKey()` — reads `config.keys.serperApiKey`, throws if missing.
- `scrapeUrl(url)` — POSTs to `config.urls.serperScrape` with `X-API-KEY`; picks `data.text ?? data.content ?? data.markdown`; returns `{text, url}`.

**Notable:** Tiny single-purpose client.

### `src/infra/tracing.ts`
**Responsibilities:**
- `isTracingEnabled()` — both Langfuse keys present.
- `initTracing()` — sets `LANGFUSE_*` env vars; dynamic `require` of `@opentelemetry/sdk-node` + `@langfuse/otel`; constructs `NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] })`.
- `shutdownTracing()` — `await sdk.shutdown()`.

**Notable:** Dynamic require keeps OTel out of cold paths.

---

## `src/llm/`, `src/config/`, `src/utils/`

### `src/llm/errors.ts`
**Responsibilities:**
- `isFatalLLMError(err)` — duck-type/instanceof checks across OpenAI SDK error classes (`AuthenticationError`, `BadRequestError`, `PermissionDeniedError`, `RateLimitError` with code `insufficient_quota`) and Gemini errors (`status` field, `RESOURCE_EXHAUSTED` substring, HTTP 400/401/403).
- `extractErrorCode(err)` — short code/status string for telemetry.

**Notable:** Mixes two providers' error taxonomies. Imports concrete OpenAI SDK classes — couples a "shared" module to one provider.

### `src/llm/gemini.ts`
**Responsibilities:**
- `findToolCallName(messages, toolCallId)` — walks back to recover function name needed for Gemini's `functionResponse`.
- `contentPartsToGemini(content)` — `ContentPart[]` → Gemini `Part[]`, drops `resource`.
- `toGeminiContents(messages)` — `LLMMessage[]` → `{ systemInstruction, contents }` with `thoughtSignature` round-trip.
- `toGeminiTools(tools)` — `LLMTool[]` → `FunctionDeclaration[]`.
- `extractToolCalls(parts)` — pulls `functionCall` parts, captures `thoughtSignature`.
- `createGeminiProvider(apiKey)` — `GoogleGenAI` client, retry config, `chatCompletion`/`completion` with timeouts.

**Notable:** Mixes message/tool/response translation with retry/timeout wiring and `console.error` diagnostics.

### `src/llm/llm.ts`
**Responsibilities:**
- `createLlmService()` — registers OpenAI for `"gpt-"` + `/^o[1-9]/` and Gemini for `"gemini-"` (only when `config.keys.geminiApiKey`).
- Singleton `llm: LLMProvider`.
- Re-exports `createOpenAIProvider`.

**Notable:** Eager singleton on module load.

### `src/llm/openai.ts`
**Responsibilities:**
- `contentToOpenAI(content)` → `text`/`image_url` (data URL).
- `toOpenAIMessages(messages)` — preserves `tool_calls`/`tool_call_id`.
- `toOpenAITools(tools)`.
- `toResponse(choice, usage)`.
- `createOpenAIProvider(client?)` — `OpenAI` client (with `maxRetries`), `chatCompletion`/`completion` with `AbortSignal.timeout`.

**Notable:** Mirrors Gemini structurally; both files independently translate.

### `src/llm/prompt.ts`
**Responsibilities:**
- `createPromptService(promptsDir)` — `load(name, variables)` reads `<promptsDir>/<name>.md`, parses YAML frontmatter with `gray-matter`, substitutes `{{var}}`, throws on missing variables, returns `{ model?, temperature?, content }`.
- Singleton `promptService` bound to `config.paths.promptsDir`.

**Notable:** Single, focused responsibility.

### `src/llm/router.ts`
**Responsibilities:**
- `ProviderEntry` and `matches(model, pattern)` (string `startsWith` or regex `.test`).
- `ProviderRegistry` implements `LLMProvider`: `register`, `resolve(model)` (linear scan), `chatCompletion`/`completion` delegate; on error calls `emitCallFailed` and rethrows.
- `emitCallFailed(model, err)` — emits `llm.call.failed` with `fatal`/`code`.

**Notable:** Routing + telemetry emission in one class.

### `src/config/env.ts`
**Responsibilities:**
- `requireEnv(name)` helper.
- Upfront validation of `REQUIRED_VARS = ["HUB_API_KEY", "OPENAI_API_KEY"]`.
- Computes `nodeEnv` and `defaultDbPath`.
- Frozen `env` object holding hub/openai/gemini/serper keys + port + assistant + Langfuse keys + browserHeadless + apiSecret + databaseUrl.

**Notable:** Single concern.

### `src/config/index.ts`
**Responsibilities:**
- `deepFreeze(obj)` recursive walker.
- Hardcoded `HUB_BASE_URL`.
- Assembles + freezes `config`: `paths`, `sandbox`, `models`, `hub`, `keys`, `urls`, `limits`, `server`, `memory`, `moderation`, `langfuse`, `retry`, `browser`, `database`, `assistant`.

**Notable:** Single god-config blob spanning many runtime domains.

### `src/config/mcp.ts`
**Responsibilities:**
- Re-exports MCP types.
- Computes local `MCP_CONFIG_PATH` (`workspace/system/mcp.json`).
- `loadMcpConfig()` — reads via `Bun.file`, returns cached `{servers: []}` on missing, parses JSON, pulls `servers` array. Memoizes via `cached`.

**Notable:** Duplicates `MCP_CONFIG_PATH` already in `paths.ts`. Uses raw `Bun.file` (bypasses sandbox).

### `src/config/paths.ts`
**Responsibilities:**
- `PROJECT_ROOT` via `resolve(import.meta.dir, "../..")`.
- Path constants: `WORKSPACE_DIR`, `SESSIONS_DIR`, `SYSTEM_DIR`, `KNOWLEDGE_DIR`, `SCRATCH_DIR`, `WORKFLOWS_DIR`, `BROWSER_DIR`, `AGENTS_DIR`, `PROMPTS_DIR` (under `src/`), `DATA_DIR`, `MCP_OAUTH_DIR`, `MCP_CONFIG_PATH`.

**Notable:** Single concern. `PROMPTS_DIR` lives under `src/`, breaking otherwise-consistent grouping.

### `src/utils/errors.ts`
**Responsibilities:**
- `getErrorMessage(err)` — `err.message` or `String(err)`.

**Notable:** Three lines. Duplicates `errorMessage` in `parse.ts`.

### `src/utils/hub-fetch.ts`
**Responsibilities:**
- `stringify(value)` — coerce unknown to string.
- `hubPost(url, body, label, timeout=30_000)` — POSTs JSON with `AbortSignal.timeout`, content-type-aware response parsing, throws `${label} (${status}): …` on non-OK.

**Notable:** No URL allowlist (caller's responsibility). `stringify` is generic, not hub-specific.

### `src/utils/id.ts`
**Responsibilities:**
- `randomSessionId()` — wraps `randomUUID()`.

**Notable:** Two-line file.

### `src/utils/index.ts`
**Responsibilities:**
- Re-exports from `parse.ts`, `xml.ts`, `timing.ts`, `hub-fetch.ts`, `media-types.ts`, `errors.ts`.

**Notable:** Does not re-export `id.ts` or `tokens.ts`.

### `src/utils/media-types.ts`
**Responsibilities:**
- Extension `Set`s: `IMAGE_EXTENSIONS`, `TEXT_EXTENSIONS`, private `AUDIO_/VIDEO_EXTENSIONS`.
- `MIME_MAP` image MIME lookup.
- Frozen `ALL_SUPPORTED_EXTENSIONS`.
- `getExt`, `inferCategory`, `inferMimeType`.

**Notable:** Single concern.

### `src/utils/parse.ts`
**Responsibilities:**
- `safeParse<T>(json, label)` — try/catch JSON.parse; doesn't echo input.
- `safeFilename(raw)` — non-empty, no `/`, `\`, `..`, no leading `.`, regex allowlist.
- `safePath(raw, label)` — max length 500, rejects `..` components, char allowlist.
- `validateKeys(obj)` — rejects `__proto__`/`constructor`/`prototype`.
- `assertMaxLength(value, name, max)`.
- `formatSizeMB(bytes)` — `"X.Y"` MB string.
- `assertNumericBounds(value, name, min, max)`.
- `errorMessage(err)`.

**Notable:** Mixes JSON parsing, filesystem name validation, prototype-pollution guard, generic assertions, byte formatting, error message extraction.

### `src/utils/timing.ts`
**Responsibilities:**
- `elapsed(startPerfNow)` — `${seconds.toFixed(2)}s`.

**Notable:** Three lines.

### `src/utils/tokens.ts`
**Responsibilities:**
- `estimateTokens(text)` — `Math.ceil(text.length / 4)`.
- `serializeMessage(msg)` (private) — flattens `LLMMessage` to string.
- `estimateMessagesTokens(messages)` — sum.

**Notable:** Imports `LLMMessage` from types — `utils/` taking a hard LLM dep. Not re-exported from `utils/index.ts`.

### `src/utils/xml.ts`
**Responsibilities:**
- `escapeXml(s)` — escapes `&`, `<`, `>`, `"` (not `'`).

**Notable:** Single tiny function.

---

## `src/types/`

### `src/types/agent.ts`
**Responsibilities:** `ResolvedAgent` (`prompt`, `model`, `tools: LLMTool[]`, optional `memory`), `AgentSummary` (`name`, `description`).
**Notable:** Tiny.

### `src/types/assistant.ts`
**Responsibilities:** `AgentConfig` (`name`, `model`, `prompt`, optional `tools[]`, `capabilities[]`, `memory`).
**Notable:** Filename is `assistant.ts` but only export is `AgentConfig` — naming/content mismatch.

### `src/types/browser.ts`
**Responsibilities:** `FeedbackEvent`, `BrowserFeedbackTracker`, `BrowserInterventions`, `BrowserSession` (uses `import("playwright").Page`), `BrowserPool`.
**Notable:** Third-party type leaks (Playwright) into `types/`.

### `src/types/condense.ts`
**Responsibilities:** `CondenseOpts`, `CondenseResult`. Imports `LLMProvider`.
**Notable:** JSDoc documents runtime defaults — defaults belong in implementation.

### `src/types/confirmation.ts`
**Responsibilities:** `ConfirmationRequest`, `ConfirmationProvider`, `GateResult`. Imports `WaitDescriptor` from `agent/`.
**Notable:** Reverse dependency `types/` → `agent/`.

### `src/types/db.ts`
**Responsibilities:** `RunStatus` union, `ItemType` union, `DbSession`, `DbRun`, `DbItem`, `DbJob`, plus insert/options shapes (`CreateRunOpts`, `CreateJobOpts`, `NewItem`).
**Notable:** Mixes run/session/item domain with job persistence.

### `src/types/events.ts`
**Responsibilities:** Envelope helpers (`RunScoped`, `Unscoped`, `RunId`, `SessionId`, `TokenPair`, `MemoryGeneration`); flat `AgentEvent` discriminated union; derived `EventType`/`EventOf`/`EventInput`/`Listener`/`WildcardListener`; `EventBus` interface; runtime `assertNever`.
**Notable:** Contains runtime `assertNever`. Largest types file.

### `src/types/file.ts`
**Responsibilities:** `FileStat`, `WritableData = string | Response`, `FileProvider` interface.
**Notable:** Header claims "no runtime-specific imports" but `WritableData` includes `Response` and `readBinary` returns `Buffer`.

### `src/types/llm.ts`
**Responsibilities:** Content parts (`TextPart`, `ImagePart`, `ResourceRef`, `ContentPart`), message variants (`LLMSystemMessage`/`LLMUserMessage`/`LLMAssistantMessage`/`LLMToolResultMessage`/`LLMMessage`), `LLMTool`/`LLMToolCall`/`LLMChatResponse`, `ChatCompletionParams`/`CompletionParams`, `LLMProvider`.
**Notable:** Self-contained; foundational.

### `src/types/logger.ts`
**Responsibilities:** `LogLevel`, `GeneralLogger`, `AgentLogger`, `Logger`, `ConsoleLoggerOptions`, `JsonlWriter`.
**Notable:** Inline `import("./events.ts").WildcardListener` instead of top-of-file import.

### `src/types/mcp.ts`
**Responsibilities:** `McpStdioServer`, `McpHttpServer`, `McpServerConfig`, `McpConfig`, `McpService`.
**Notable:** Self-contained.

### `src/types/media.ts`
**Responsibilities:** Single union `MediaCategory`.
**Notable:** Tiny.

### `src/types/memory-ops.ts`
**Responsibilities:** `ObserveResult`, `ReflectResult`. Imports `MemoryGeneration` from `events.ts`.
**Notable:** Two interfaces; could fold into `memory.ts`.

### `src/types/memory.ts`
**Responsibilities:** `MemoryState`, `ProcessedContext`, runtime `emptyMemoryState()` factory.
**Notable:** Contains runtime code.

### `src/types/moderation.ts`
**Responsibilities:** Single `ModerationResult`.
**Notable:** Tiny.

### `src/types/prompt.ts`
**Responsibilities:** Single `PromptResult`.
**Notable:** Tiny.

### `src/types/result-store.ts`
**Responsibilities:** Single `ToolCallRecord`.
**Notable:** Tiny.

### `src/types/run-state.ts`
**Responsibilities:** `TokenUsage`, `RunState` (with `messages`, `tokens`, `iteration`, `assistant`, `model`, `tools`, `memory`).
**Notable:** `TokenUsage` shape duplicates `TokenPair` in `events.ts`. `RunStatus` lives in `db.ts`, not here.

### `src/types/sandbox.ts`
**Responsibilities:** Single `BridgeHandle` (`port`, `stop`).
**Notable:** Tiny.

### `src/types/serper.ts`
**Responsibilities:** Single `ScrapeResult`.
**Notable:** Tiny; type is generic despite the file name.

### `src/types/session.ts`
**Responsibilities:** Single `Session` (`id`, `assistant?`, `messages`, `createdAt: Date`, `updatedAt: Date`).
**Notable:** Overlaps conceptually with `DbSession`.

### `src/types/tool-result.ts`
**Responsibilities:** `ToolResult` (`content`, `isError?`, `wait?`); runtime factories `text`, `error`, `resource`.
**Notable:** Contains runtime code (the canonical helpers per `tools_standard.md`).

### `src/types/tool.ts`
**Responsibilities:** `ToolAnnotations`, `Decision`, `ConfirmableToolCall`, `SimpleToolSchema`, `ActionDef`, `MultiActionToolSchema`, `ToolSchema`, `ToolCallContext`, `ToolDefinition`, `ToolMeta`, `DispatchResult`. Imports `z` from `zod`.
**Notable:** Pulls `zod` into `types/`. Imports `WaitDescriptor` from `agent/`.

---

## Top-level + `src/evals/`

### `src/cli.ts`
**Responsibilities:**
- Parses `--session`, `--model` flags + positional args; usage error and `exit(1)` on missing args.
- Bootstraps via `initServices()` + `installSignalHandlers()`; tears down with `shutdownServices()`.
- Wait-loop around `executeRun`/`resumeRun`: while `result.exit.kind === "waiting"`, dispatches by `waitingOn.kind`.
- `promptApproval` — interactive `node:readline/promises` loop; calls `takePendingConfirmation`; reads `Y/n`.
- `waitForChildResume` — DB poll every 200 ms via `dbOps.getRun` until status leaves `waiting`; maps DB rows to `RunExit`.
- `printExit` — branches on exit kind to print result/error/cancellation/exhaustion.

**Notable:** Mixes arg parsing + interactive UX + DB-polling continuation loop.

### `src/server.ts`
**Responsibilities:**
- `parseChatBody` and `parseEventFilter`.
- Hono `app` with timing middleware (`log.info`).
- `GET /health`. Bearer auth middleware on `/chat`.
- `POST /api/negotiations/search` — hard-coded `assistant: "negotiations"`, truncates answer to 500 bytes.
- `POST /chat` — `sessionService.enqueue`-serialized; SSE in stream mode (subscribes to bus, filters by sessionId, sends `agent_event`/`heartbeat`/`done`/`error`); 15 s heartbeat; non-stream returns JSON; classifies "Unknown agent" → 400.
- `POST /resume` — accepts `{ runId, resolution }`, streams via SSE.
- `exitToPayload` maps `RunExit` → wire JSON.
- Bootstraps + signal handlers at module top level.

**Notable:** Mixes routing/auth/SSE/heartbeat/task-specific endpoint/bootstrap. Three independent `RunExit` renderers across cli/server/slack.

### `src/slack.ts`
**Responsibilities:**
- Reads Slack tokens; exits if absent.
- Constructs `@slack/bolt` `App` (socket mode).
- `createStatusUpdater` — per-thread throttled posting/editing using `StatusTracker` from `slack-utils`; rate-limit retry honors `data.retry_after`.
- `runThread: Map<runId, {channel, threadTs}>` for posting final answer post-button.
- Wires `registerConfirmationActions` from `slack-confirmation`.
- `inFlight: Set<dedupeKey>` deduping retries.
- `handleResult` — branches on `RunExit`: `waiting` → fetch confirmations, post interactive message; otherwise post answer.
- `exitToText` mapping.
- `handleMessage` — full Slack-message orchestration (reactions, status updater, executeRun, post result, cleanup).
- Registers `app.message` and `app.event("app_mention")`.
- Bootstraps via `initServices()` + `installSignalHandlers()`.

**Notable:** Heavy file — orchestration + throttling + dedupe + exit rendering all inline.

### `src/slack-confirmation.ts`
**Responsibilities:**
- Action-id codec (`encodeAction`/`decodeAction`) — `cnf_app:`/`cnf_deny:` prefix + pipe-delimited `runId|confirmationId|toolCallId`.
- `getPendingConfirmationRequests(sessionId, runId)` — reads transcript via `sessionService.getMessages`, builds `answered` set from tool messages, walks back to latest assistant with toolCalls.
- `truncateArgs` — pretty-prints + truncates at 200 chars.
- `postConfirmationMessage` — Slack Block Kit assembly + `chat.postMessage`.
- `registerConfirmationActions` registers `app.action(/^cnf_app:/, …)` and `cnf_deny`.
- `handleClick` — decodes, fetches run via `dbOps.getRun`, accumulates partial decisions per `runId:confirmationId`, calls `resumeRun` once all answered.

**Notable:** Mixes codec, transcript walk, DB access, Block Kit rendering, resumption control.

### `src/slack-utils.ts`
**Responsibilities:**
- `SLACK_MESSAGE_LIMIT = 4000`.
- `deriveSessionId(teamId, channelId, threadTs?, messageTs)` — `slack-{team}-{channel}-{ts}`.
- `toSlackMarkdown(md)` — regex transforms.
- `splitMessage(text, limit)` — paragraph → line → word → hard-cut.
- `class StatusTracker` — accumulates `active`/`history` from `tool.called`/`tool.succeeded`/`tool.failed`; `update(event)` returns multi-line status string.

**Notable:** Cleanly scoped, no I/O.

### `src/evals/harness.ts`
**Responsibilities:**
- `runEvalCase(message)` — runs `executeRun({ prompt: message })` and returns `AgentOutput`.
- Subscribes to `tool.succeeded`/`tool.failed` (push tool name), `generation.completed` (sum tokens), `turn.completed` (`event.index + 1` iterations).
- `matchRun` closure captures first event's `runId`.
- Cleans up subscriptions in `finally`.

**Notable:** Single, focused.

### `src/evals/runner.ts`
**Responsibilities:**
- `EVALUATOR_MAP: { "tool-selection": toolSelectionEvaluator }`.
- `parseArgs` — `--dataset`, `--concurrency`, `--langfuse` (parsed but never read), `--ci`.
- `loadDataset(name)` — reads JSON, validates array shape.
- `discoverDatasets()`.
- `runDataset` — sliding `running` array + `Promise.race`; per case calls `runEvalCase` then evaluator; aggregates scores.
- `printReport` — fixed-width text table specialized to `tool-selection` (looks up `tool_decision`/`required_tools`/`forbidden_tools`/`call_count`).
- `main` — installs auto-approve `setConfirmationProvider`, iterates datasets, gates CI exit on `tool_selection_overall < 0.8`.
- Top-level `main().catch(...)` exit 1.

**Notable:** Mixes CLI + dataset I/O + dispatch + concurrency + scoring + reporting + CI gate + bootstrap. Reporting is hardcoded to one evaluator. `--langfuse` unused.

### `src/evals/types.ts`
**Responsibilities:** `EvalCase`, `ScoringMetric`, `AgentOutput`, `Evaluator`, `EvalCaseResult`, `EvalRunResult`.
**Notable:** Pure types.

### `src/evals/evaluators/tool-selection.ts`
**Responsibilities:**
- Local `ToolSelectionExpect` and `parseExpect` to coerce raw `expect` data.
- `toolSelectionEvaluator: Evaluator` — four binary metrics (`decision`, `required`, `forbidden`, `callCount`); `overall = avg`; emits five `ScoringMetric` entries.

**Notable:** Score names are coupled to `runner.ts`'s `printReport` columns.

---

## Cross-cutting findings (consolidated)

### Files doing too much (>~3 distinct concerns)

| File | Concerns bundled |
| --- | --- |
| `src/agent/loop.ts` | Session resource lifecycle, agent resolution, LLM act mechanics, tool dispatch + confirmation gate, memory-pipeline integration, terminal-event emission, DB cycle counting. Seven internal types declared inline. |
| `src/agent/orchestrator.ts` | Run lifecycle DB ops, input moderation, assistant-pinning policy, `RunExit → DB` persistence, child-run kickoff, two parallel hydration paths. |
| `src/agent/session.ts` | Three independent factories (DB-message store, session registry/queues, filesystem paths) bundled into one composed service. |
| `src/agent/workspace.ts` | Static path constants + hardcoded multi-page markdown prompt + live disk-reading prompt assembly. Violates "No hardcoded prompts" project rule. |
| `src/agent/memory/processor.ts` | Drives observer + reflector + persistence; emits five bus events; encodes tail-budget split heuristic; inlines `flushMemory` end-of-session path with hardcoded 1000-token threshold. |
| `src/tools/browser.ts` | Page-artifact persistence + DOM-structure walker + error-page heuristics + intervention/feedback hints + multimodal screenshot construction. |
| `src/tools/execute_code.ts` | Deno binary discovery + session-dir resolution + output sanitization + bridge orchestration + subprocess timeout + tmp-file lifecycle. |
| `src/tools/registry.ts` | Schema-to-LLMTool registration + multi-action expansion + dispatch + result-store integration + content serialization. |
| `src/tools/index.ts` | Static tool registration + MCP service lifecycle (`globalThis.__mcpService`). |
| `src/tools/agents_hub.ts` | Hub-`verify` semantics + generic API calls; two batch handlers duplicate sequential-batch loop. |
| `src/infra/browser.ts` | Playwright session lifecycle + pool keyed by session id + idle-timeout `setInterval` + `SIGINT`/`SIGTERM` handlers + composition of feedback/interventions. |
| `src/infra/mcp.ts` | Transport construction + OAuth orchestration + content mapping + structured-content spillover + sampling bridge to LLM + stale-process killing + tool registration. |
| `src/infra/db/index.ts` | Four CRUD domains (sessions, runs, items, jobs) + crash-recovery queries in one ~300-line file. |
| `src/infra/langfuse-subscriber.ts` | ~540 lines, seven handler groups, OTel context management, Langfuse schema mapping. |
| `src/infra/log/markdown.ts` | Logger implementation + sidecar-file spillover + per-instance `createSandbox`. |
| `src/infra/mcp-oauth.ts` | Per-server JSON state (raw `fs`) + OS-specific browser launching + `node:http` callback server. |
| `src/infra/scheduler.ts` | Delay-string parsing + DB reads/writes + cron management + one-shot polling timer + bridge to `executeRun`. |
| `src/llm/gemini.ts` | Message/tool/response translation + retry/timeout + `console.error` diagnostics. |
| `src/llm/router.ts` | Routing + telemetry-event emission. |
| `src/utils/parse.ts` | JSON parsing + filesystem-name validation + prototype-pollution guard + generic assertions + byte formatting + error-message extraction. |
| `src/config/index.ts` | God-config bundling sandbox/models/hub/keys/limits/server/memory/moderation/langfuse/retry/browser/database. |
| `src/server.ts` | Routing + bearer auth + body validation + SSE + heartbeat + task-specific `/api/negotiations/search` + bootstrap + exit rendering. |
| `src/slack.ts` | Bolt setup + status updater + run-thread map + dedupe + handleMessage orchestration + exit rendering + bootstrap. |
| `src/slack-confirmation.ts` | Action-id codec + transcript walk + Block Kit rendering + DB access + multi-click accumulator + resumeRun invocation. |
| `src/evals/runner.ts` | CLI parsing + dataset I/O + concurrency + auto-approve provider + report rendering hardcoded to one evaluator + CI gate + bootstrap. |

### Files doing too little (could be inlined)

- `src/agent/run-exit.ts` — pure `RunExit` type, ~7 lines.
- `src/agent/memory/generation.ts` — single 25-line helper; only shared by `observer`/`reflector`.
- `src/agent/run-telemetry.ts` — most helpers are one-line `bus.emit` wrappers; only the three composite emitters justify the file.
- `src/tools/document_processor.ts` — declares multi-action shape with one action; the `actions` map is overhead.
- `src/infra/db/migrate.ts` — one effective line.
- `src/infra/log/logger.ts` — three lines.
- `src/infra/log/composite.ts` — six effective lines.
- `src/infra/serper.ts` — single function.
- `src/utils/errors.ts` — three lines, duplicates `errorMessage` in `parse.ts`.
- `src/utils/id.ts` — two-line wrapper.
- `src/utils/timing.ts` — single function.
- `src/utils/xml.ts` — single function.
- `src/types/media.ts`, `src/types/moderation.ts`, `src/types/prompt.ts`, `src/types/sandbox.ts`, `src/types/serper.ts`, `src/types/session.ts`, `src/types/assistant.ts` — each holds one tiny type.

### Responsibilities split across multiple files that should live together

1. **Session/run state is scattered.** `session.ts` writes message items + path layout + per-session queues; `orchestrator.ts` writes run rows + status updates. The DB is touched in both. `RunStatus` lives in `types/db.ts`, `RunState` lives in `types/run-state.ts`, `RunExit` lives in `agent/run-exit.ts`. Three sources of truth for the same domain.

2. **Three different `RunExit` renderers.** `printExit` in `cli.ts`, `exitToPayload` in `server.ts`, `exitToText` in `slack.ts` — each entry point reinvents the mapping.

3. **Three different bootstrap entry points.** `cli.ts`, `server.ts`, `slack.ts` each call `initServices()` + `installSignalHandlers()` and each implement their own wait/confirmation strategy (interactive readline / `/resume` endpoint / Slack buttons).

4. **Three different confirmation flows.** CLI uses `takePendingConfirmation` + interactive prompts; Slack uses `getPendingConfirmationRequests` (transcript walk in `slack-confirmation.ts`); evals use `setConfirmationProvider` with a global auto-approver. Three different paths to the same outcome.

5. **Slack split across three top-level files.** `slack.ts`, `slack-confirmation.ts`, `slack-utils.ts` are at `src/` root while every other concern lives under a directory; a `src/slack/` folder would mirror existing structure.

6. **Browser logic split across three files.** `browser.ts`, `browser-feedback.ts`, `browser-interventions.ts` — the session in `browser.ts` instantiates and exposes both helpers, which have no other consumers.

7. **MCP across two files.** `mcp.ts` directly imports `createOAuthProvider`/`waitForOAuthCallback` from `mcp-oauth.ts`; that module has no other consumers — they are one OAuth+transport unit.

8. **Logging spread across six files.** `log/bridge.ts`, `log/composite.ts`, `log/console.ts`, `log/jsonl.ts`, `log/logger.ts`, `log/markdown.ts`. `composite.ts` and `logger.ts` are tiny.

9. **Memory pipeline contract is implicit between four files.** `observer.ts`/`reflector.ts`/`processor.ts`/`persistence.ts`/`generation.ts` plus `loop.ts` (which owns `createMemorySaver`, calls `flushMemory` in `finalizeTerminal`, performs the `messagesSnapshot` swap dance). The "snapshot, swap, splice" message-mutation protocol between `loop.ts` and `processor.ts` is unencoded.

10. **Confirmation lifecycle split between `confirmation.ts` and `resume-run.ts`.** Module-scope `pendingConfirmations` lives in `confirmation.ts`; consumption of `decisions` + tool re-dispatch lives in `resume-run.ts`. `takePendingConfirmation` is exported but unused on the public resume flow shown.

11. **`WaitDescriptor` handling spans many files.** `wait-descriptor.ts` (types), `confirmation.ts` (constructs `user_approval`), `loop.ts:dispatchTools` (returns it), `orchestrator.ts:persistRunExit`/`kickChildRunAsync` (reacts), `resume-run.ts` (consumes), `run-continuation.ts` (parses JSON). No single owner; JSON shape inferred independently.

12. **Two error-message helpers.** `getErrorMessage` in `utils/errors.ts` and `errorMessage` in `utils/parse.ts` are functionally identical. Both flow through `utils/index.ts`.

13. **MCP path constant duplicated.** `MCP_CONFIG_PATH` defined in `config/paths.ts` (and re-exported through `config.paths.mcpConfigPath`) is recomputed in `config/mcp.ts` with its own `join(WORKSPACE_DIR, "system", "mcp.json")`.

14. **Tokens vs LLM module placement.** `utils/tokens.ts` imports `LLMMessage` from `types/llm.ts` and walks LLM message shapes — belongs under `llm/`, not generic `utils/`.

15. **md5 logic duplicated.** `tools/edit_file.ts` (`md5(text)` helper) and `tools/read_file.ts` (`createHash("md5").update(...)` inline).

16. **Session-dir resolution duplicated.** `getBashCwd` in `tools/bash.ts` and `getSessionDir` in `tools/execute_code.ts` are identical.

17. **`{{hub_api_key}}` placeholder substitution duplicated.** `tools/browser.ts` (`resolveValuePlaceholders`) and `tools/web.ts` (`payload.url.replace("{{hub_api_key}}", ...)`).

18. **Filesystem-access inconsistency.** `infra/sandbox.ts` is the documented path; but `infra/mcp-oauth.ts` and `infra/db/connection.ts` deliberately bypass it (raw `fs`); `tools/execute_code.ts` imports raw `infra/fs.ts`; `config/mcp.ts` uses raw `Bun.file`. Four callers each picking their own layer.

19. **Hub concerns split.** `utils/hub-fetch.ts` owns `hubPost` (generic POST helper) but does not use the hub URL or API key; `config.hub.{baseUrl, verifyUrl, apiKey}` lives in `config/index.ts`. Caller has to glue them.

20. **LLM error classification spans two files.** Predicates in `llm/errors.ts`; only consumer that emits `llm.call.failed` is `llm/router.ts`. Provider files (`openai.ts`, `gemini.ts`) don't use `errors.ts` directly.

21. **Layer leaks from `infra/` upward into `agent/` and `tools/`.** `infra/bootstrap.ts` imports `../tools/index.ts` and `../agent/run-continuation.ts`; `infra/events.ts`, `infra/sandbox.ts`, `infra/mcp.ts` import `../agent/context.ts`/`../agent/session.ts`; `infra/scheduler.ts` imports `../agent/orchestrator.ts` and `../agent/session.ts`; `infra/condense.ts` imports `../llm/llm.ts`, `../llm/prompt.ts`, `../agent/session.ts`. Several "infra" modules are effectively orchestrators.

22. **Reverse `types/` → `agent/` dependencies.** `types/confirmation.ts`, `types/tool-result.ts`, `types/tool.ts`, `types/events.ts` all import from `agent/wait-descriptor.ts`. `types/` is no longer a leaf module.

23. **Runtime code inside `types/`.** `types/events.ts` exports `assertNever`, `types/memory.ts` exports `emptyMemoryState()`, `types/tool-result.ts` exports `text`/`error`/`resource` factories.

24. **Third-party type leakage into `types/`.** `types/browser.ts` imports `playwright`'s `Page`. `types/tool.ts` imports `z` from `zod`. `types/file.ts` references `Buffer` (Node) and `Response` (Web).

25. **Overlapping types across files.** `Session` (`types/session.ts`) vs `DbSession` (`types/db.ts`); `TokenUsage` (`types/run-state.ts`) vs `TokenPair` (`types/events.ts`); `AgentConfig` (`types/assistant.ts` — misnamed file) vs `ResolvedAgent` (`types/agent.ts`).

26. **Action-dispatch `switch(default)` boilerplate** is repeated in every multi-action tool (`agents_hub`, `browser`, `document_processor`, `geo_distance`, `scheduler`, `shipping`, `web`).

27. **Tracing pairs `infra/tracing.ts` (init) with `infra/langfuse-subscriber.ts` (consume)** — `bootstrap.ts` always wires them together.
