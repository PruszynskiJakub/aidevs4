# `src/` Responsibilities Audit

Generated 2026-04-27. One entry per source file under `src/`. Each entry lists exports, line count, and the concrete responsibilities the file owns. Use this as a baseline for spotting files that do too much, too little, or share a responsibility across multiple sources of truth.

---

## `src/agent/`

### `src/agent/agents.ts`
- **LoC**: 121
- **Exports**: `agentsService`, `makeAgentsService`
- **Responsibilities**:
  - Load and parse agent configuration files (YAML frontmatter + markdown prompt)
  - Validate required agent fields (name, model, system prompt)
  - Resolve tool references to LLMTool objects from registry
  - Cache agent summaries in-memory for list operations

### `src/agent/confirmation.ts`
- **LoC**: 106
- **Exports**: `confirmBatch`, `takePendingConfirmation`, `setConfirmationProvider`
- **Responsibilities**:
  - Inspect tool calls for confirmIf gates requiring operator approval
  - Partition calls into auto-approved and pending batches
  - Store pending confirmations in-memory cache keyed by UUID
  - Build user approval prompts from tool names and arguments

### `src/agent/context.ts`
- **LoC**: 80
- **Exports**: `runWithContext`, `getState`, `requireState`, `getLogger`, `requireLogger`, `getSessionId`, `requireSessionId`, `getAgentName`, `getRunId`, `getRootRunId`, `getParentRunId`, `getTraceId`, `getDepth`
- **Responsibilities**:
  - Provide async-local storage bindings for RunState and Logger
  - Implement required/optional accessors with error handling
  - Support tracing identity (runId, rootRunId, parentRunId, traceId, depth)

### `src/agent/loop.ts`
- **LoC**: 464
- **Exports**: `runAgent`
- **Responsibilities**:
  - Orchestrate the main agent reasoning loop (act→tool-dispatch→reflect cycle)
  - Execute LLM act phase with message context and tools
  - Dispatch approved tool calls and record outcomes
  - Integrate memory processing (observation/reflection) via processMemory hook
  - Handle terminal states (completed, exhausted, waiting) with finalization events
  - Emit telemetry for turns, generations, tools, and batch operations

### `src/agent/orchestrator.ts`
- **LoC**: 295
- **Exports**: `executeRun`, `runAndPersist`, `createChildRun`, `startChildRun`
- **Responsibilities**:
  - Orchestrate run creation, hydration, and persistence
  - Validate input via moderation, pick assistant, assign runId and traceId
  - Hydrate RunState with messages, tools, and persisted memory
  - Persist run results to DB via dbOps (status, exit reason, error)
  - Kick off child runs asynchronously and handle start failures

### `src/agent/resume-run.ts`
- **LoC**: 202
- **Exports**: `resumeRun`
- **Responsibilities**:
  - Resume waiting runs by validating state and matching resolution kind
  - Find pending tool calls from message history
  - Dispatch approved/denied decisions or child_run results as synthetic tool messages
  - Rebuild RunState from DB and re-enter loop via runAndPersist

### `src/agent/run-continuation.ts`
- **LoC**: 95
- **Exports**: `registerContinuationSubscriber`, `reconcileOrphanedWaits`
- **Responsibilities**:
  - Listen for child run terminal events (completed, failed) and resume parents
  - Convert child exit status to result strings for tool message injection
  - Reconcile orphaned waits at startup (crash-gap recovery for lost subscribers)

### `src/agent/run-exit.ts`
- **LoC**: 16
- **Exports**: `RunExit` (type union)
- **Responsibilities**:
  - Define typed RunExit union covering terminal states and waiting non-terminal state

### `src/agent/run-telemetry.ts`
- **LoC**: 202
- **Exports**: `emitRunStarted`, `emitAgentStarted`, `emitTurnStarted`, `emitTurnCompleted`, `emitGenerationStarted`, `emitGenerationCompleted`, `emitToolCalled`, `emitToolSucceeded`, `emitToolFailed`, `emitBatchStarted`, `emitBatchCompleted`, `emitAnswerTerminal`, `emitMaxIterationsTerminal`, `emitFailureTerminal`
- **Responsibilities**:
  - Emit lifecycle events (run, agent, turn, generation) to event bus
  - Emit tool dispatch events (called, succeeded, failed)
  - Wrap composite terminal transitions (answer, max_iterations, failure) with multi-event emission

### `src/agent/session.ts`
- **LoC**: 285
- **Exports**: `sessionService`, `createSessionService`, `messagesToItems`, `itemsToMessages`, `getSessionWorkingDir`
- **Responsibilities**:
  - Convert LLM messages ↔ DB items (users, assistant, function_calls, outputs)
  - Append messages and runs to DB, retrieve transcript by session/run
  - Manage session registry (get-or-create, set assistant pin)
  - Enqueue session tasks serially (per-session queues)
  - Build session paths (date-folder structure, log/shared/output dirs)

### `src/agent/workspace.ts`
- **LoC**: 155
- **Exports**: `workspace`, `buildWorkspaceContext`
- **Responsibilities**:
  - Define workspace path constants (knowledge, scratch, workflows, sessions, browser)
  - Provide universal navigation instructions for agents (file operations, KB rules)
  - Load knowledge index and workflow definitions from disk at runtime
  - Compose workspace context block injected into agent system prompts

### `src/agent/memory/generation.ts`
- **LoC**: 25
- **Exports**: `buildMemoryGeneration`
- **Responsibilities**:
  - Transform LLM call (input messages, response) into MemoryGeneration event payload

### `src/agent/memory/observer.ts`
- **LoC**: 81
- **Exports**: `observe`, `serializeMessages`
- **Responsibilities**:
  - Serialize LLM messages to truncated text (respecting token budgets per message type)
  - Call observer prompt via LLM to extract/append observations from message batch
  - Return text and MemoryGeneration for bus emission

### `src/agent/memory/persistence.ts`
- **LoC**: 60
- **Exports**: `saveState`, `loadState`, `saveDebugArtifact`
- **Responsibilities**:
  - Save/load MemoryState JSON to session directory
  - Generate sequential debug artifacts (observer/reflector .md files) with YAML frontmatter

### `src/agent/memory/processor.ts`
- **LoC**: 242
- **Exports**: `processMemory`, `flushMemory`
- **Responsibilities**:
  - Split messages at tail budget, observe old messages if unobserved tokens exceed threshold
  - Combine new observations into active set, emit observation events
  - Trigger multi-level reflection if observation tokens exceed reflectionThreshold
  - Handle tool-response coherence (prevent splitting assistant + tool output pairs)
  - Flush remaining unobserved messages at session end

### `src/agent/memory/reflector.ts`
- **LoC**: 71
- **Exports**: `reflect`
- **Responsibilities**:
  - Iteratively compress observations via multi-level reflection (reorganize→condense→essential)
  - Return best (smallest) result or first result meeting target token budget
  - Record each reflection level as MemoryGeneration for telemetry

---

## `src/llm/` and `src/prompts/`

### `src/llm/errors.ts`
- **LoC**: 64
- **Exports**: `isFatalLLMError`, `extractErrorCode`
- **Responsibilities**:
  - Classify OpenAI and Gemini errors as fatal (auth, billing, malformed) or transient
  - Detect insufficient_quota, RESOURCE_EXHAUSTED, 400/401/403 status codes as unretryable
  - Extract error codes from APIError and custom Gemini error objects for event telemetry

### `src/llm/gemini.ts`
- **LoC**: 217
- **Exports**: `createGeminiProvider`
- **Responsibilities**:
  - Convert LLM message format to Gemini API structure with system instructions and roles
  - Serialize ContentPart array (text, inline base64 images) to Gemini Part objects
  - Extract tool calls from Gemini response, preserve thoughtSignature for thinking models
  - Handle function response lookups via findToolCallName for tool-result reconciliation
  - Call generateContent with timeout, temperature, maxOutputTokens, and tools config

### `src/llm/llm.ts`
- **LoC**: 25
- **Exports**: `createOpenAIProvider`, `createLlmService`, `llm`
- **Responsibilities**:
  - Bootstrap LLM service by registering OpenAI and Gemini providers with model patterns
  - Route "gpt-" and o1/o3 models to OpenAI, "gemini-" to Gemini if key exists
  - Expose singleton llm instance for global use across application

### `src/llm/openai.ts`
- **LoC**: 141
- **Exports**: `createOpenAIProvider`
- **Responsibilities**:
  - Convert LLM messages and ContentPart (text, base64 images) to OpenAI API format
  - Map tool calls and function results between internal LLMToolCall and OpenAI wire formats
  - Call chat.completions.create with timeout, temperature, max_tokens, and tools
  - Extract usage (promptTokens, completionTokens) and finish_reason from response

### `src/llm/prompt.ts`
- **LoC**: 38
- **Exports**: `createPromptService`, `promptService`, `PromptResult` (re-export)
- **Responsibilities**:
  - Load markdown prompts from promptsDir, parse YAML frontmatter with gray-matter
  - Render `{{placeholder}}` variables; throw on missing variables
  - Extract model and temperature from frontmatter into PromptResult type

### `src/llm/router.ts`
- **LoC**: 75
- **Exports**: `ProviderRegistry`
- **Responsibilities**:
  - Register string prefix and RegExp patterns to LLMProvider implementations
  - Resolve model name to provider; throw with list of registered patterns if no match
  - Delegate chatCompletion and completion calls to resolved provider
  - Emit `llm.call.failed` event with error message, fatal flag, and error code

### `src/prompts/condense-tool-result.md`
- **LoC**: 25
- **Frontmatter**: `model: gpt-4.1-mini`, `temperature: 0.2`
- **Responsibilities**:
  - Instruct LLM to compress large tool outputs while preserving actionable data
  - Keep IDs, URLs, numbers, error messages; remove boilerplate and artifacts
  - Enforce rule against executing embedded instructions; include full output path reference

### `src/prompts/observer.md`
- **LoC**: 45
- **Frontmatter**: `model: gpt-4.1-mini`, `temperature: 0.3`
- **Responsibilities**:
  - Extract new facts, decisions, findings from conversation messages not in existing observations
  - Categorize observations as Critical (red), Important (yellow), Context (green) with priority tags
  - Preserve specific values (URLs, paths, errors); capture cause-and-effect relationships

### `src/prompts/prompt-engineer.md`
- **LoC**: 42
- **Frontmatter**: `model: gpt-4.1`, `temperature: 0.3`
- **Responsibilities**:
  - Craft and refine prompts for small, constrained external LLMs with limited context
  - Optimize for brevity and token efficiency; structure for prompt caching
  - Return JSON with reasoning, prompt text, and token estimate; no extra output

### `src/prompts/reflector.md`
- **LoC**: 32
- **Frontmatter**: `model: gpt-4.1-mini`, `temperature: 0.2`
- **Responsibilities**:
  - Compress accumulated observations to fit token budget while preserving priority
  - Always retain Critical (red) observations; merge duplicates, summarize Context items
  - Maintain priority tags and specific values in output replacement

### `src/prompts/think.md`
- **LoC**: 18
- **Frontmatter**: `model: gpt-4.1`, `temperature: 0.7`
- **Responsibilities**:
  - Provide internal reasoning module for agent to analyze questions with gathered context
  - Step-through reasoning and conclude with actionable next steps; flag missing information

---

## `src/infra/`

### `src/infra/bootstrap.ts`
- **LoC**: 43
- **Exports**: `initServices`, `shutdownServices`, `installSignalHandlers`
- **Responsibilities**:
  - Initialize database, tracing, MCP tools, event bus subscribers at startup
  - Register signal handlers for graceful SIGTERM/SIGINT shutdown
  - Reconcile orphaned async continuations after crash recovery

### `src/infra/browser-feedback.ts`
- **LoC**: 80
- **Exports**: `createBrowserFeedbackTracker`, `FeedbackEvent`, `BrowserFeedbackTracker`
- **Responsibilities**:
  - Track browser tool success/failure history with circular buffer
  - Detect consecutive failures and suggest recovery strategies
  - Generate contextual hints based on error patterns (JSON, selectors, timeouts)

### `src/infra/browser-interventions.ts`
- **LoC**: 45
- **Exports**: `createBrowserInterventions`, `BrowserInterventions`
- **Responsibilities**:
  - Emit screenshot hint after 2+ consecutive browser failures
  - Suggest saving working approaches to workspace on recovery
  - Recommend persistence of learnings on task completion

### `src/infra/browser.ts`
- **LoC**: 186
- **Exports**: `createBrowserSession`, `createBrowserPool`, `browserPool`, `_setBrowserPoolForTest`
- **Responsibilities**:
  - Manage Chromium browser instances with session persistence
  - Implement idle timeout cleanup of inactive browser sessions
  - Persist and restore browser storage state (cookies, localStorage)
  - Track page feedback and intervention hints per session

### `src/infra/condense.ts`
- **LoC**: 55
- **Exports**: `condense`, `CondenseOpts`, `CondenseResult`
- **Responsibilities**:
  - Summarize large tool outputs via LLM when exceeding token threshold
  - Write full output to session files and return concise summaries
  - Pass through small outputs unchanged for zero cost

### `src/infra/events.ts`
- **LoC**: 87
- **Exports**: `bus`, `createEventBus`, `EventBus`
- **Responsibilities**:
  - Manage process-wide event bus with exact and wildcard listeners
  - Enrich events with session/run/trace context from async context
  - Emit with unique IDs and timestamps for traceability

### `src/infra/fs.ts`
- **LoC**: 72
- **Exports**: `exists`, `readText`, `readBinary`, `readJson`, `write`, `append`, `fsReaddir`, `fsStat`, `fsMkdir`, `fsUnlink`, `fsRename`, `checkFileSize`, `FileSizeLimitError`
- **Responsibilities**:
  - Provide low-level async filesystem operations (no access control)
  - Validate file sizes against configured limits
  - Wrap Bun file APIs with standard Node.js/Promise interface

### `src/infra/guard.ts`
- **LoC**: 75
- **Exports**: `moderateInput`, `assertNotFlagged`, `_setClient`
- **Responsibilities**:
  - Check user input against OpenAI moderation API for policy violations
  - Log flagged categories and fail-open on API errors
  - Throw error if input violates moderation policy

### `src/infra/langfuse-subscriber.ts`
- **LoC**: 540
- **Exports**: `attachLangfuseSubscriber`
- **Responsibilities**:
  - Convert agent domain events (runs, turns, tools, generations) to Langfuse observations
  - Maintain observation hierarchy with OTel context propagation
  - Track memory compression (observation/reflection) metrics
  - Record input moderation results as guardrail observations
  - Map tool outputs and LLM generations to structured trace data

### `src/infra/mcp-oauth.ts`
- **LoC**: 179
- **Exports**: `createOAuthProvider`, `waitForOAuthCallback`
- **Responsibilities**:
  - Persist OAuth tokens, client info, code verifiers to filesystem
  - Open browser for authorization flow and launch callback server
  - Handle OAuth callback parsing and token storage

### `src/infra/mcp.ts`
- **LoC**: 363
- **Exports**: `createMcpService`, `McpService`
- **Responsibilities**:
  - Connect to MCP servers (stdio, SSE, HTTP) with transport abstraction
  - Implement OAuth handshake for authenticated MCP connections
  - Convert MCP tools to registered agent tools with result mapping
  - Handle structured content by writing large payloads to session files
  - Kill stale mcp-remote processes on startup

### `src/infra/result-store.ts`
- **LoC**: 60
- **Exports**: `resultStore`, `createResultStore`, `ToolCallRecord`
- **Responsibilities**:
  - Store tool call records indexed by toolCallId
  - Track status (pending/ok/error) and token usage per call
  - Provide list and clear methods for result inspection

### `src/infra/sandbox.ts`
- **LoC**: 199
- **Exports**: `createSandbox`, `sandbox`, `_setSandboxForTest`, `resolveInput`, `FileSizeLimitError`
- **Responsibilities**:
  - Enforce read/write path allowlists with blocked directory support
  - Narrow session-specific write paths to date-partitioned directories
  - Wrap filesystem operations with access control checks
  - Resolve input as file path, JSON, or raw string fallback

### `src/infra/scheduler.ts`
- **LoC**: 146
- **Exports**: `scheduler`, `parseDelay`, `delayToRunAt`
- **Responsibilities**:
  - Schedule cron jobs from database active jobs on load
  - Poll for due one-shot jobs every 60 seconds
  - Execute jobs via session queue with error tracking
  - Parse delay strings (30m, 2h, 1d) and validate against 30-day limit

### `src/infra/serper.ts`
- **LoC**: 31
- **Exports**: `scrapeUrl`, `ScrapeResult`
- **Responsibilities**:
  - Call Serper scrape API with URL and API key authentication
  - Extract text/content/markdown from response with JSON fallback
  - Apply fetch timeout to prevent hanging

### `src/infra/tracing.ts`
- **LoC**: 42
- **Exports**: `isTracingEnabled`, `initTracing`, `shutdownTracing`
- **Responsibilities**:
  - Initialize OpenTelemetry Node SDK with Langfuse span processor
  - Set environment variables for Langfuse configuration
  - Gracefully handle missing OTel/Langfuse dependencies

### `src/infra/db/connection.ts`
- **LoC**: 17
- **Exports**: `db`, `sqlite`
- **Responsibilities**:
  - Initialize SQLite database with Drizzle ORM schema
  - Enable WAL journal mode and foreign key enforcement
  - Create database directory synchronously at module load

### `src/infra/db/index.ts`
- **LoC**: 301
- **Exports**: `db`, `sqlite`, `createSession`, `getSession`, `touchSession`, `setRootRun`, `setAssistant`, `createRun`, `getRun`, `updateRunStatus`, `incrementCycleCount`, `listRunsBySession`, `findRunWaitingOnChild`, `findOrphanedWaitingRuns`, `nextSequence`, `appendItem`, `appendItems`, `listItemsByRun`, `listItemsBySession`, `getItemByCallId`, `createJob`, `getJob`, `listJobs`, `listActiveJobs`, `listDueOneShots`, `updateJobStatus`, `updateJobExecution`, `deleteJob`, `_clearAll`
- **Responsibilities**:
  - Query and mutate sessions, runs, items, scheduled jobs in SQLite
  - Track run status with optimistic locking by version field
  - Find orphaned waiting runs for crash recovery reconciliation
  - Manage scheduled job execution history and cron status

### `src/infra/db/migrate.ts`
- **LoC**: 4
- **Exports**: (none — runs Drizzle migrations)
- **Responsibilities**:
  - Execute Drizzle migrations from migrations folder on import

### `src/infra/db/schema.ts`
- **LoC**: 93
- **Exports**: `sessions`, `runs`, `items`, `scheduledJobs`, `JobStatus`, `JobRunStatus`
- **Responsibilities**:
  - Define SQLite schema for sessions, runs, items, scheduled jobs
  - Enforce foreign key constraints and run hierarchy invariants
  - Index session/parent/root references and scheduled job status

### `src/infra/log/bridge.ts`
- **LoC**: 146
- **Exports**: `attachLoggerListener`
- **Responsibilities**:
  - Subscribe to domain events and translate to Logger method calls
  - Filter events by session ID to support multi-session concurrent logging
  - Format durations and forward event data to logger targets

### `src/infra/log/composite.ts`
- **LoC**: 17
- **Exports**: `createCompositeLogger`
- **Responsibilities**:
  - Implement Proxy-based composite logger delegating to multiple targets
  - Avoid manual method forwarding for each Logger interface method

### `src/infra/log/console.ts`
- **LoC**: 172
- **Exports**: `ConsoleLogger`, `ConsoleLoggerOptions`
- **Responsibilities**:
  - Log agent loop steps, LLM responses, tool calls with ANSI colors
  - Summarize JSON args and results with configurable truncation
  - Emit token counts and elapsed time for each phase
  - Support debug/info/error filtering based on log level

### `src/infra/log/jsonl.ts`
- **LoC**: 103
- **Exports**: `createJsonlWriter`, `JsonlWriter`
- **Responsibilities**:
  - Append domain events to JSONL files chained by session/date
  - Compact large fields (input, result) before persistence
  - Flush pending writes on demand or exit signal

### `src/infra/log/logger.ts`
- **LoC**: 4
- **Exports**: `log`
- **Responsibilities**:
  - Export singleton ConsoleLogger instance for console output

### `src/infra/log/markdown.ts`
- **LoC**: 182
- **Exports**: `MarkdownLogger`, `formatJson`
- **Responsibilities**:
  - Write human-readable markdown logs with headers, code blocks, sections
  - Write large tool outputs to sidecar .txt files with references
  - Chain async appends to guarantee ordering without blocking
  - Implement beforeExit handler for best-effort flush on process exit

---

## `src/tools/`

### `src/tools/agents_hub.ts`
- **LoC**: 202
- **Exports**: `agentsHub` handler
- **Responsibilities**:
  - Multi-action tool (verify, verify_batch, api_request, api_batch) for hub.ag3nts.org
  - Submit task answers and receive verification responses from the AG3NTS hub
  - Batch processing of answers or API calls with field mapping support
  - File I/O for batch input/output with size checks and error handling

### `src/tools/bash.ts`
- **LoC**: 80
- **Exports**: `bash` handler
- **Responsibilities**:
  - Execute shell commands in session working directory with timeout enforcement
  - Validate write targets (`>`, `>>`, `tee`) stay within session directory only
  - Capture stdout/stderr, enforce 20KB output truncation, return exit codes

### `src/tools/browser.ts`
- **LoC**: 446
- **Exports**: `browserHandler`, `navigate`, `evaluate`, `click`, `typeText`, `takeScreenshot`
- **Responsibilities**:
  - Multi-action tool: navigate URLs, evaluate JavaScript, click elements, fill forms, screenshot
  - Manage Playwright browser session persistence (cookies, localStorage)
  - Save page text and DOM structure artifacts; detect error pages via status/patterns
  - Provide feedback hints via session interventions (discovery, screenshot recommendations)

### `src/tools/delegate.ts`
- **LoC**: 72
- **Exports**: `delegate` handler
- **Responsibilities**:
  - Delegate subtask to specialized child agent with isolated session
  - Create child run linked to parent run context and trace hierarchy
  - Block parent execution (return wait signal) until child reaches terminal state

### `src/tools/document_processor.ts`
- **LoC**: 103
- **Exports**: `documentProcessor`, `ask`
- **Responsibilities**:
  - Multi-action tool: ask questions about documents using AI vision (Gemini)
  - Support text and image files (10-file max); handle file:// URI legacy cleanup
  - Build ContentPart array and stream to LLM for cross-document synthesis

### `src/tools/edit_file.ts`
- **LoC**: 152
- **Exports**: `edit_file` handler
- **Responsibilities**:
  - String-based find-replace in files with single/bulk occurrence support
  - Checksum verification for concurrency safety; prevent ambiguous replacements
  - Generate unified diff for dry-run preview without writing

### `src/tools/execute_code.ts`
- **LoC**: 195
- **Exports**: `executeCode` handler
- **Responsibilities**:
  - Run TypeScript code in sandboxed subprocess (Deno or Bun fallback)
  - Inject bridge prelude providing file access only to session directory
  - Strip absolute paths from output to prevent filesystem leakage

### `src/tools/geo_distance.ts`
- **LoC**: 142
- **Exports**: `geoDistance`, `haversine`
- **Responsibilities**:
  - Multi-action tool: distance calculation and bulk location matching
  - Implement haversine formula for geographic distance computation
  - Match query points against references within radius; sort results ascending

### `src/tools/glob.ts`
- **LoC**: 73
- **Exports**: `glob` handler
- **Responsibilities**:
  - Find files matching glob pattern in directory; 500-result cap with truncation warning
  - Use Bun.Glob for pattern expansion; return sorted absolute paths

### `src/tools/grep.ts`
- **LoC**: 131
- **Exports**: `grep` handler
- **Responsibilities**:
  - Search files by regex pattern; 200 lines, 50 files, 20 per-file limits
  - Skip directories, oversized files; return file:line:content matches with case sensitivity option

### `src/tools/index.ts`
- **LoC**: 60
- **Exports**: `register`, `registerRaw`, `getTools`, `getToolsByName`, `dispatch`, `reset`, `initMcpTools`, `shutdownMcp`, `mcpService`
- **Responsibilities**:
  - Import and register all native tool definitions (think, bash, browser, etc.)
  - Manage MCP service lifecycle (connect, register remote tools, disconnect)
  - Hot-reload support: disconnect previous instance before creating new one

### `src/tools/prompt_engineer.ts`
- **LoC**: 100
- **Exports**: `promptEngineer` handler
- **Responsibilities**:
  - Craft or refine LLM prompts with goal, constraints, context, and feedback input
  - Load system prompt from prompt-engineer template; parse JSON response stripping markdown fences
  - Return prompt, token estimate, and reasoning as structured JSON

### `src/tools/read_file.ts`
- **LoC**: 63
- **Exports**: `read_file` handler
- **Responsibilities**:
  - Read text files with line numbering and md5 checksum; 1-based offset/limit pagination
  - Display cat -n format with total line count and checksum for verification

### `src/tools/registry.ts`
- **LoC**: 195
- **Exports**: `register`, `registerRaw`, `getTools`, `getToolsByName`, `dispatch`, `reset`, `getToolMeta`, `serializeContent`
- **Responsibilities**:
  - Register single-action and multi-action tools; expand multi-action to separate LLM functions
  - Convert Zod schemas to OpenAI JSON Schema; support pre-built raw schemas for MCP tools
  - Dispatch tool calls by name (with action routing for multi-action); handle errors gracefully
  - Serialize content parts to plain text; estimate tokens for result tracking

### `src/tools/sandbox/bridge.ts`
- **LoC**: 84
- **Exports**: `startBridge`
- **Responsibilities**:
  - Create sandboxed HTTP bridge server (OS-assigned port, localhost only)
  - Expose file operations (read, write, stat, mkdir, exists, listDir, readJson) via REST endpoints
  - Resolve relative paths against session cwd; enforce sandbox read/write path restrictions

### `src/tools/sandbox/prelude.ts`
- **LoC**: 51
- **Exports**: `generatePrelude`
- **Responsibilities**:
  - Generate TypeScript prelude injected into sandboxed scripts
  - Export SESSION_DIR constant and tools object with async file access methods
  - Route all I/O through bridge server via fetch; compatible with Deno and Bun

### `src/tools/scheduler.ts`
- **LoC**: 236
- **Exports**: `schedulerHandler` (schedule, delay, list, get, pause, resume, delete actions)
- **Responsibilities**:
  - Multi-action tool: create recurring cron jobs and one-shot delayed executions
  - Manage job lifecycle (pause, resume, delete); track run count and last execution metadata
  - Validate cron syntax and delay strings (Nm/Nh/Nd format); trigger agent with message payload

### `src/tools/shipping.ts`
- **LoC**: 100
- **Exports**: `shipping` handler
- **Responsibilities**:
  - Multi-action tool: check package status and redirect to new destinations
  - Validate alphanumeric package/destination IDs; extract confirmation code from response
  - Enforce security code authorization for redirects

### `src/tools/think.ts`
- **LoC**: 37
- **Exports**: `think` handler
- **Responsibilities**:
  - Reasoning tool: pause and perform step-by-step thinking before acting
  - Load think system prompt template; call LLM for structured reasoning output
  - No side effects — planning only, does not fetch or modify state

### `src/tools/web.ts`
- **LoC**: 160
- **Exports**: `web`, `download`, `scrape`
- **Responsibilities**:
  - Multi-action tool: download files or scrape web page text
  - Enforce host allowlist for downloads; resolve `{{placeholder}}` variables (hub_api_key)
  - Condense scraped content per URL; save full text artifacts; parallel scraping with independent failure handling

### `src/tools/write_file.ts`
- **LoC**: 48
- **Exports**: `write_file` handler
- **Responsibilities**:
  - Create or overwrite files; auto-create parent directories recursively
  - Write UTF-8 content; report byte count and verification hint

---

## `src/types/`

### `src/types/agent.ts`
- **LoC**: 23
- **Exports**: `AgentConfig`, `ResolvedAgent`, `AgentSummary`
- **Responsibilities**:
  - Models agent configuration including name, model, prompt, tools, and capabilities
  - Represents resolved agent state with tools list and memory flag
  - Defines agent summary for identification and description

### `src/types/browser.ts`
- **LoC**: 38
- **Exports**: `FeedbackEvent`, `BrowserFeedbackTracker`, `BrowserInterventions`, `BrowserSession`, `BrowserPool`
- **Responsibilities**:
  - Tracks browser tool feedback (success/failure) and consecutive failures
  - Generates hints and statistics for browser interaction optimization
  - Manages browser sessions and page instances via Playwright integration
  - Provides pooling mechanism for multiple browser sessions

### `src/types/condense.ts`
- **LoC**: 24
- **Exports**: `CondenseOpts`, `CondenseResult`
- **Responsibilities**:
  - Configures tool output condensation with token thresholds and LLM providers
  - Encapsulates condensation results with original or summarized content

### `src/types/confirmation.ts`
- **LoC**: 21
- **Exports**: `ConfirmationRequest`, `ConfirmationProvider`, `GateResult`
- **Responsibilities**:
  - Models confirmation requests for gated tool calls awaiting operator approval
  - Separates approved and denied calls with reasons
  - Integrates wait descriptors for blocking on confirmation

### `src/types/db.ts`
- **LoC**: 101
- **Exports**: `RunStatus`, `ItemType`, `DbSession`, `DbRun`, `DbItem`, `CreateRunOpts`, `DbJob`, `CreateJobOpts`, `NewItem`
- **Responsibilities**:
  - Models database entities for sessions, runs, items, and scheduled jobs
  - Defines run lifecycle statuses and item types for conversation history
  - Specifies creation options for runs and jobs with optional metadata

### `src/types/events.ts`
- **LoC**: 113
- **Exports**: `RunId`, `SessionId`, `TokenPair`, `MemoryGeneration`, `AgentEvent`, `EventType`, `EventOf`, `EventInput`, `Listener`, `WildcardListener`, `EventBus`, `assertNever`
- **Responsibilities**:
  - Defines discriminated union of all agent event types across lifecycle, turns, generation, tools, memory, agent, and moderation
  - Provides event bus interface for subscription and emission
  - **Runtime code**: `assertNever()` function for exhaustiveness checking in event switches

### `src/types/file.ts`
- **LoC**: 25
- **Exports**: `FileStat`, `WritableData`, `FileProvider`
- **Responsibilities**:
  - Abstracts file I/O operations in provider-agnostic interface
  - Supports text, binary, and JSON file operations with directory and stat operations
  - Validates file sizes and handles read/write/append/delete/rename operations

### `src/types/llm.ts`
- **LoC**: 99
- **Exports**: `TextPart`, `ImagePart`, `ResourceRef`, `ContentPart`, `LLMSystemMessage`, `LLMUserMessage`, `LLMAssistantMessage`, `LLMToolResultMessage`, `LLMMessage`, `LLMTool`, `LLMToolCall`, `LLMChatResponse`, `ChatCompletionParams`, `CompletionParams`, `LLMProvider`
- **Responsibilities**:
  - Models LLM message formats with multipart content support (text, images, resources)
  - Defines tool schemas and tool call structures with provider metadata preservation
  - Specifies LLM provider interface for chat and completion operations with usage tracking

### `src/types/logger.ts`
- **LoC**: 40
- **Exports**: `LogLevel`, `GeneralLogger`, `AgentLogger`, `Logger`, `ConsoleLoggerOptions`, `JsonlWriter`
- **Responsibilities**:
  - Defines logging interface for general and agent-specific operations
  - Models JSONL writer for event bus integration and async flushing
  - Specifies console logger options with truncation and log level configuration

### `src/types/mcp.ts`
- **LoC**: 33
- **Exports**: `McpStdioServer`, `McpHttpServer`, `McpServerConfig`, `McpConfig`, `McpService`
- **Responsibilities**:
  - Models MCP server configurations supporting stdio, SSE, and HTTP transports
  - Specifies OAuth support for authenticated remote MCP servers
  - Defines MCP service interface for connection lifecycle and tool registration

### `src/types/media.ts`
- **LoC**: 2
- **Exports**: `MediaCategory`
- **Responsibilities**:
  - Defines media type categories for file classification

### `src/types/memory-ops.ts`
- **LoC**: 12
- **Exports**: `ObserveResult`, `ReflectResult`
- **Responsibilities**:
  - Models observation and reflection operation results with LLM generation metadata
  - Tracks memory operations via generation data structures

### `src/types/memory.ts`
- **LoC**: 23
- **Exports**: `MemoryState`, `ProcessedContext`, `emptyMemoryState`
- **Responsibilities**:
  - Tracks memory state including active observations and token counts
  - Encapsulates processed context with system prompt and LLM messages
  - **Runtime code**: `emptyMemoryState()` factory function for initializing memory

### `src/types/moderation.ts`
- **LoC**: 6
- **Exports**: `ModerationResult`
- **Responsibilities**:
  - Models moderation check results with category flags and confidence scores

### `src/types/prompt.ts`
- **LoC**: 6
- **Exports**: `PromptResult`
- **Responsibilities**:
  - Encapsulates prompt execution result with model, temperature, and rendered content

### `src/types/result-store.ts`
- **LoC**: 13
- **Exports**: `ToolCallRecord`
- **Responsibilities**:
  - Tracks tool call execution history with status, arguments, results, and timing

### `src/types/run-state.ts`
- **LoC**: 25
- **Exports**: `TokenUsage`, `RunState`
- **Responsibilities**:
  - Models complete run state including messages, tokens, iteration, agent, and tools
  - Tracks session and run hierarchy with optional trace and depth information

### `src/types/sandbox.ts`
- **LoC**: 5
- **Exports**: `BridgeHandle`
- **Responsibilities**:
  - Models sandbox bridge server handle with port and lifecycle control

### `src/types/serper.ts`
- **LoC**: 5
- **Exports**: `ScrapeResult`
- **Responsibilities**:
  - Models scrape results from web search operations with text and URL

### `src/types/session.ts`
- **LoC**: 10
- **Exports**: `Session`
- **Responsibilities**:
  - Models session with id, optional assistant, messages, and timestamps

### `src/types/tool-result.ts`
- **LoC**: 25
- **Exports**: `ToolResult`, `text`, `error`, `resource`
- **Responsibilities**:
  - Encapsulates tool execution results with multipart content and error flags
  - **Runtime code**: Three factory functions (`text()`, `error()`, `resource()`) for constructing tool results

### `src/types/tool.ts`
- **LoC**: 59
- **Exports**: `ToolAnnotations`, `Decision`, `ConfirmableToolCall`, `SimpleToolSchema`, `ActionDef`, `MultiActionToolSchema`, `ToolSchema`, `ToolCallContext`, `ToolDefinition`, `ToolMeta`, `DispatchResult`
- **Responsibilities**:
  - Models tool definitions with Zod schemas, handlers, and metadata annotations
  - Supports both single-action and multi-action tool schemas
  - Specifies confirmation conditions and dispatch result with wait descriptor support

### `src/types/wait.ts`
- **LoC**: 33
- **Exports**: `WaitDescriptor`, `Wait`, `WaitResolution`
- **Responsibilities**:
  - Models run pause states for user approval and child run completion
  - Defines matching resolution payloads for resuming paused runs

---

## `src/utils/`, `src/config/`, `src/evals/`, top-level

### `src/utils/hash.ts`
- **LoC**: 6
- **Exports**: `md5`
- **Responsibilities**:
  - Compute MD5 hex digest of a string using Node crypto

### `src/utils/hub-fetch.ts`
- **LoC**: 42
- **Exports**: `resolveHubPlaceholders`, `stringify`, `hubPost`
- **Responsibilities**:
  - Replace `{{hub_api_key}}` template placeholders in strings
  - Coerce unknown response values to strings for tool results and errors
  - POST JSON to hub endpoints with timeout, auth, and content-type handling

### `src/utils/id.ts`
- **LoC**: 6
- **Exports**: `randomSessionId`
- **Responsibilities**:
  - Generate UUID v4 strings for anonymous sessions

### `src/utils/index.ts`
- **LoC**: 5
- **Exports**: Re-exports from `parse.ts`, `xml.ts`, `timing.ts`, `hub-fetch.ts`, `media-types.ts`
- **Responsibilities**:
  - Aggregate utility module exports into single barrel

### `src/utils/media-types.ts`
- **LoC**: 58
- **Exports**: `MediaCategory` type, `IMAGE_EXTENSIONS`, `TEXT_EXTENSIONS`, `ALL_SUPPORTED_EXTENSIONS`, `inferCategory`, `inferMimeType`
- **Responsibilities**:
  - Define supported file extension sets for images, text, audio, video
  - Infer media category from file extension (image, text, audio, video, document)
  - Infer MIME type from file extension with fallback defaults

### `src/utils/parse.ts`
- **LoC**: 107
- **Exports**: `safeParse`, `safeFilename`, `safePath`, `validateKeys`, `assertMaxLength`, `formatSizeMB`, `assertNumericBounds`, `errorMessage`
- **Responsibilities**:
  - Parse JSON with labelled errors preventing stack trace leakage
  - Validate filenames reject path separators, traversal, hidden files, unsafe characters
  - Validate file paths and reject `..` components, excessive length, unsafe characters
  - Reject prototype-pollution keys (`__proto__`, `constructor`, `prototype`)
  - Assert string length, numeric bounds; format byte counts to MB; extract error messages

### `src/utils/timing.ts`
- **LoC**: 3
- **Exports**: `elapsed`
- **Responsibilities**:
  - Calculate and format elapsed time in seconds from performance.now()

### `src/utils/tokens.ts`
- **LoC**: 43
- **Exports**: `estimateTokens`, `estimateMessagesTokens`
- **Responsibilities**:
  - Estimate token count from text using character-length heuristic (length / 4)
  - Serialize assistant/user/tool messages to text; aggregate token estimates across message arrays

### `src/utils/xml.ts`
- **LoC**: 7
- **Exports**: `escapeXml`
- **Responsibilities**:
  - Escape XML special characters in attribute values and text content

### `src/config/env.ts`
- **LoC**: 36
- **Exports**: `env` object with validated environment variables
- **Responsibilities**:
  - Require and validate HUB_API_KEY, OPENAI_API_KEY at startup
  - Collect optional env vars (GEMINI_API_KEY, SERPER_API_KEY, LANGFUSE_*, etc.)
  - Determine environment (production/development); derive default database path

### `src/config/index.ts`
- **LoC**: 127
- **Exports**: `config` deeply frozen object
- **Responsibilities**:
  - Aggregate env vars, paths, sandbox rules, models, hub endpoints, API keys, limits, timeouts, memory config, langfuse settings into single immutable config object
  - Define model names, rate limits, browser settings, server port, database URL

### `src/config/mcp.ts`
- **LoC**: 27
- **Exports**: Type re-exports from `types/mcp.ts`, `loadMcpConfig` function
- **Responsibilities**:
  - Load MCP server configuration from JSON file with caching and graceful fallback to empty config

### `src/config/paths.ts`
- **LoC**: 22
- **Exports**: `PROJECT_ROOT`, `WORKSPACE_DIR`, `SESSIONS_DIR`, `SYSTEM_DIR`, `KNOWLEDGE_DIR`, `SCRATCH_DIR`, `WORKFLOWS_DIR`, `BROWSER_DIR`, `AGENTS_DIR`, `PROMPTS_DIR`, `DATA_DIR`, `MCP_OAUTH_DIR`, `MCP_CONFIG_PATH`
- **Responsibilities**:
  - Define all well-known project and workspace directory paths relative to project root

### `src/evals/datasets/tool-selection.json`
- **LoC**: 170
- **Shape**: Array of evaluation case objects with `id`, `message`, `expect` (containing `shouldUseTools`, `requiredTools`, `forbiddenTools`, `minToolCalls`/`maxToolCalls`)
- **Responsibilities**:
  - Define 18 test cases for evaluating agent tool selection behavior (when to use tools, which tools to use, call count bounds)

### `src/evals/evaluators/tool-selection.ts`
- **LoC**: 74
- **Exports**: `toolSelectionEvaluator`
- **Responsibilities**:
  - Score tool selection decisions (should/should not use tools)
  - Verify required tools are called; forbid unwanted tools
  - Check tool call counts within min/max bounds; aggregate four metrics to overall score

### `src/evals/harness.ts`
- **LoC**: 73
- **Exports**: `runEvalCase`
- **Responsibilities**:
  - Execute agent on single eval case and capture structured output (response, tool names, iterations, tokens, duration) by subscribing to bus events
  - Isolate each case with ephemeral session; filter events by run ID

### `src/evals/runner.ts`
- **LoC**: 282
- **Exports**: Main script; exports `parseArgs`, `loadDataset`, `discoverDatasets`, `runDataset`, `printReport`
- **Responsibilities**:
  - Parse CLI args (dataset, concurrency, langfuse, ci flags)
  - Load JSON datasets; discover registered evaluators
  - Run eval cases with concurrency control and aggregate scores per metric
  - Print formatted case results table and aggregated scores; exit with non-zero on CI failure

### `src/evals/types.ts`
- **LoC**: 42
- **Exports**: `EvalCase`, `ScoringMetric`, `AgentOutput`, `Evaluator` function type, `EvalCaseResult`, `EvalRunResult`
- **Responsibilities**:
  - Define core evaluation pipeline types: test case structure, scoring metrics, agent output shape, evaluator callback signature

### `src/cli.ts`
- **LoC**: 162
- **Exports**: Main script (executable)
- **Responsibilities**:
  - Parse CLI args (assistant name, prompt, session ID, model override)
  - Initialize services; execute run with user approval flow for tool confirmation
  - Handle waiting states (child runs, user approval); poll DB until parent resumes
  - Print exit status and result to stdout/stderr

### `src/server.ts`
- **LoC**: 254
- **Exports**: Hono app instance and port (executable)
- **Responsibilities**:
  - Set up HTTP endpoints: `/health`, `/chat` (POST), `/resume` (POST), `/api/negotiations/search` (POST)
  - Parse chat requests (sessionId, msg, assistant, stream flag); validate API secret
  - Stream agent events via SSE or return JSON response
  - Queue runs per session to ensure serial execution; handle waiting states
  - Initialize services and signal handlers; log request timing

### `src/slack.ts`
- **LoC**: 268
- **Exports**: Main script (executable)
- **Responsibilities**:
  - Set up Slack Bolt app in socket mode; validate tokens
  - Listen to messages and app mentions; route to `executeRun`
  - Track in-flight requests to deduplicate retries; derive stable session IDs from thread metadata
  - Update status messages in thread with throttled tool activity via `StatusTracker`
  - Delegate waiting runs to confirmation flow; post final result to thread

### `src/slack-utils.ts`
- **LoC**: 107
- **Exports**: `SLACK_MESSAGE_LIMIT`, `deriveSessionId`, `toSlackMarkdown`, `splitMessage`, `StatusTracker` class
- **Responsibilities**:
  - Derive stable session ID from Slack team, channel, thread timestamp
  - Convert GitHub-flavored markdown to Slack mrkdwn (bold, strikethrough, links, code blocks)
  - Split long messages at paragraph/line/word boundaries respecting 4000-char limit
  - Track active and completed tools; render compact single-line status string per event

### `src/slack-confirmation.ts`
- **LoC**: 218
- **Exports**: `getPendingConfirmationRequests`, `postConfirmationMessage`, `registerConfirmationActions`
- **Responsibilities**:
  - Extract pending tool calls from persisted transcript (latest assistant message without matching tool outputs)
  - Post Slack block-kit message with approve/deny buttons per tool; truncate args to 200 chars
  - Register button action handlers; accumulate partial decisions; call `resumeRun` when all tools decided
  - Encode/decode action IDs with runId, confirmationId, toolCallId; survive process restart via DB state

---

## Quick observations (not analysis — just patterns visible from this catalog)

These are patterns visible directly from the export/responsibility listing above. They are NOT yet validated as problems, just candidates for the user to investigate next.

1. **Three slack files at top-level** (`slack.ts`, `slack-utils.ts`, `slack-confirmation.ts`) sit alongside `cli.ts` and `server.ts`, while every other domain (agent, llm, infra, tools) is folder-scoped. Candidate consolidation under `src/slack/`.
2. **Two scheduler files**: `src/infra/scheduler.ts` (cron loop, polling, execution) and `src/tools/scheduler.ts` (multi-action tool exposing job CRUD). Splitting by layer is intentional per the project's tool-vs-infra split — flag if any logic is duplicated.
3. **Two sandbox concepts**: `src/infra/sandbox.ts` (filesystem path allowlist) and `src/tools/sandbox/` (HTTP bridge + prelude for code execution). Same word, different concerns — name collision worth checking.
4. **Browser feedback / interventions split into 3 files** (`browser-feedback.ts`, `browser-interventions.ts`, `browser.ts` in `src/infra/`). Each is small (45–80 LoC). Possible over-decomposition.
5. **`src/types/` files with runtime code**: `events.ts` (`assertNever`), `memory.ts` (`emptyMemoryState`), `tool-result.ts` (`text`, `error`, `resource`). Mixes pure-type and runtime-helper conventions.
6. **Two tool-registry files**: `src/tools/index.ts` (60 LoC) re-exports from `src/tools/registry.ts` (195 LoC) plus adds MCP lifecycle. Worth checking why the wrapper exists.
7. **`src/agent/loop.ts` (464 LoC)** is by far the largest agent file — handles loop, tool dispatch, memory hooks, terminal states, and telemetry emission. Candidate for review against single-responsibility.
8. **`src/infra/langfuse-subscriber.ts` (540 LoC)** is the single largest file. Pure event-to-observation translation but very wide — covers all event domains in one module.
9. **`src/infra/db/index.ts` (301 LoC, 28 exports)** is a flat function bag spanning sessions, runs, items, jobs. No sub-grouping.
10. **`src/agent/session.ts` (285 LoC)** mixes message↔item conversion, DB persistence wrapper, session registry, per-session task queue, and path building. Five concerns in one module.
11. **Memory persistence vs DB**: `src/agent/memory/persistence.ts` writes JSON to session dir via filesystem, while everything else durable goes through `src/infra/db/`. Two persistence stores for run-related state.
12. **Workspace paths surfaced through three layers**: `src/config/paths.ts` declares flat constants (`WORKSPACE_DIR`, `KNOWLEDGE_DIR`, etc.); `src/config/index.ts` re-exposes them under `config.paths.*`; `src/agent/workspace.ts` builds a structured `workspace` object on top of `config.paths.*`. Not duplicate values, but three names for the same paths — agents/tools could pick any of them inconsistently.