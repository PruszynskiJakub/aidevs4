# Gap Analysis: src/ vs Wonderlands/apps/server

**Date**: 2026-04-26
**Reference**: `/Users/jakubpruszynski/WebstormProjects/aidevs4/Wonderlands/apps/server`
**Scope**: Agent/subagent system, architecture, workspace, large-tool-result handling

---

## 1. SUBAGENT LINK REGISTRY & ALIAS RESOLUTION

**Severity**: Medium | **Effort**: Medium

### Reference
- `agentSubagentLinks` DB table with: alias, childAgentId, delegationMode, parentAgentRevisionId, position
- Unique constraint on (parentAgentRevisionId, alias) — each parent revision defines allowed subagents
- `delegation-service.ts` resolves alias to concrete agent via `subagentLinkRepository.listByParentRevisionId()`
- Rich `DelegationHandoffEnvelope` with parent/target context, inputFileIds, delegationMode
- Access control: `canReadAgent(tenantScope, childAgent)` validates visibility

### Ours
- `delegate.ts` accepts raw agent name string — any agent can delegate to any agent
- No alias concept, no per-parent restrictions, no delegation modes
- Minimal delegation event: just childRunId + agentName + task string

### What's Missing
1. `agent_subagent_links` table (schema + repository)
2. Alias resolution in delegate tool (query link registry before delegation)
3. DelegationMode enum + fields on RunRecord
4. Rich delegation events with alias + mode metadata

### Recommendations
- Add `agent_subagent_links` table to `src/infra/db/schema.ts`
- Create `src/agent/subagent-link-repository.ts` with `resolveAlias()`, `getSubagentLinks()`
- Update `src/tools/delegate.ts` to validate alias against link registry
- Add `delegationMode`, `delegationAlias` columns to `runs` table
- Update `run.delegated` event payload with alias + delegationMode

---

## 2. JOB DEPENDENCY GRAPH & READINESS ENGINE

**Severity**: Medium | **Effort**: Large

### Reference
- `jobs` table with: status (queued|running|waiting|blocked|completed|cancelled|superseded), priority, rootJobId, parentJobId, leaseExpiresAt, lastHeartbeatAt, nextSchedulerCheckAt
- `jobDependencies` edges table: (fromJobId, toJobId, type, metadataJson) with types: depends_on | produces | validates | supersedes | related_to
- `readiness-engine.ts`: Periodic scan of ALL jobs in intermediate states, generates typed decisions
- Decision types: execute_pending_run, resume_waiting_run, requeue_waiting_job, deliver_resolved_child_result, recover_timed_out_wait, requeue_stale_running_run
- `multiagent-worker.ts`: Polling worker that drains decisions in priority order with skip tracking
- `dependenciesSatisfiedForJob()`: Evaluates all dependency edges before allowing execution
- Stale run detection via lease expiry + heartbeat staleness
- Startup reconciliation recovers orphaned jobs

### Ours
- No job abstraction — runs are the only unit
- No dependency edges — parent-child via `waitingOn` JSON field
- Fire-and-forget child execution: `kickChildRunAsync()` starts immediately, no queuing
- Event-driven continuation: `bus.on("run.completed")` finds waiting parent
- Basic `reconcileOrphanedWaits()` at startup
- No priority, no lease tracking, no heartbeat monitoring

### What's Missing
1. `jobDependencies` table with edge types + metadata
2. Readiness engine: decision state machine scanning intermediate jobs
3. Priority + lease management fields on runs
4. Multiagent worker polling loop with batch draining
5. Fan-out/fan-in support (parent waits for N children)

### Recommendations
- Phase 1: Add `job_dependencies` table + extend `runs` with priority, leaseExpiresAt, lastHeartbeatAt
- Phase 2: Implement `readiness-engine.ts` with `pickNextDecision()` + dependency evaluation
- Phase 3: Build readiness actions for each decision type
- Phase 4: Create multiagent worker polling loop with configurable interval + wake signals
- Phase 5: Startup reconciliation sweep for orphaned state

---

## 3. FILE INHERITANCE & DB TRACKING

**Severity**: Medium | **Effort**: Medium

### Reference
- `files` table: id, sourceKind (upload|artifact|generated|derived), status, mimeType, sizeBytes, checksum, accessScope (session_local|account_library), createdByRunId
- `file_links` junction table: fileId, linkType (session|thread|message|run|tool_execution), targetId — unique constraint on (fileId, linkType, targetId)
- `linkInputFilesToChildRun()`: Copies parent's visible file references to child run via file_links
- `loadVisibleFileContext()`: Collects files by messageIds AND runId, merges with run files taking precedence
- `toFileContextMessages()`: Converts files to LLM context with mode-aware filtering (image as data URL, text inline capped, others metadata-only)
- Attachment resolution policies: file_id_only, markdown_only, text_only, url_only, path_inline, smart_default

### Ours
- No files table, no file_links table
- Files exist only on filesystem, referenced by path strings in tool results
- `sandbox.ts` provides path-based access control but no metadata persistence
- Child agents inherit nothing — must infer paths from parent transcript
- ResourceRef in ToolResult has no type info, no deduplication, no access control

### What's Missing
1. `files` table with metadata (mimeType, sizeBytes, checksum, sourceKind, accessScope)
2. `file_links` junction table with typed associations
3. File inheritance in `createChildRun()` — copy parent's file links to child
4. File context injection into LLM with mode-aware formatting
5. File registration in tool handlers (read_file, write_file, browser downloads)

### Recommendations
- Add `files` + `file_links` tables to `src/infra/db/schema.ts`
- Create `src/agent/file-service.ts` with `registerFile()`, `inheritFiles()`, `getVisibleFiles()`
- Update `src/tools/delegate.ts` to call `inheritFiles(parentRunId, childRunId)` before WaitRequested
- Update file tools to register files in DB on read/write
- Add `visibleFileIds` to RunContext in `src/agent/context.ts`

---

## 4. EVENT OUTBOX & GUARANTEED DELIVERY

**Severity**: Medium | **Effort**: Medium

### Reference
- 3-table event infrastructure: `domainEvents` (store of record), `eventOutbox` (delivery FSM), `eventPayloadSidecars` (overflow)
- `eventOutbox` with status FSM: pending -> processing -> delivered/failed/quarantined
- 4 topic channels: background, projection, realtime, observability
- Atomic write: `db.sqlite.transaction()` wraps event + outbox rows together
- `outbox-worker.ts`: Two-lane architecture (realtime lane + durable lane), claim-process-complete pattern
- Retry: Exponential backoff via `availableAt`, quarantine after N attempts
- Startup recovery: `reconcileProcessingEntries()` for crashed mid-flight events
- Topic routing: Predefined per event type (e.g., run.completed -> realtime + observability + background)
- Idempotency: Unique constraint on (eventId, topic)

### Ours
- In-memory `EventBus` singleton in `src/infra/events.ts`
- `bus.emit()` is synchronous, in-process — events lost on crash
- No persistence, no replay, no retry
- All listeners fire synchronously in emit loop (slow listener blocks others)
- No topic routing — flat wildcard or type-specific subscriptions
- No idempotency guarantees

### What's Missing
1. `domain_events` + `event_outbox` tables
2. Event store: `emitWithOutbox()` wrapping event + outbox in transaction
3. Outbox worker: Polling loop with claim-process-complete + retry/quarantine
4. Topic routing contract: Event type -> topic[] mapping
5. Multi-lane dispatch: Realtime (low-latency) vs durable (background) separation
6. Startup reconciliation for orphaned processing entries
7. Dispatcher implementations per topic

### Recommendations
- Phase 1 (Schema): Add `domain_events` + `event_outbox` tables, outbox repo with claimNext/complete/retry/quarantine
- Phase 2 (Event store): `emitWithOutbox()` function wrapping atomic write + signalOutboxPending()
- Phase 3 (Worker): Polling outbox-worker with configurable lanes + batch size
- Phase 4 (Routing): `EVENT_TOPIC_ROUTES` contract mapping event types to topics
- Phase 5 (Dispatchers): Per-topic handlers (realtime, observability, background, projection stubs)

---

## 5. CONTEXT BUDGET & CALIBRATION

**Severity**: High | **Effort**: Large

### Reference
- **Context layers**: Typed layers (system_prompt, agent_profile, message_history, file_context, etc.) with volatility classification (stable vs volatile)
- **Granular token estimation**: Per-content-type — text (chars/4), images (256-1536 by detail level), function calls (name + args), reasoning tokens
- **Stable prefix hashing**: SHA256 of stable layers -> `stablePrefixHash` for Claude prompt caching. Separate `stablePrefixTokens` + `volatileSuffixTokens` tracking
- **Budget calibration**: `applyLatestBudgetCalibration()` compares estimated vs actual tokens from provider, adjusts future estimates. Uses `latestCachedTokens`, `latestActualInputTokens`
- **Usage ledger**: DB table with per-turn: inputTokens, outputTokens, cachedTokens, estimatedInputTokens, stablePrefixTokens, volatileSuffixTokens, model, provider
- **Context compaction**: LLM summarization with tokensBefore/tokensAfter proof, stored as `ContextSummaryRecord`
- **Budget API**: `/budget` endpoint returning calibrated estimate + actual breakdown

### Ours
- **Token estimation**: Single `Math.ceil(text.length / 4)` for all content types
- **No context layers**: Flat message array, no stable/volatile distinction
- **No prompt caching**: No stablePrefixHash, no cache_control wiring
- **No calibration**: Estimates never compared to actuals, never adjusted
- **No usage ledger**: `state.tokens` in-memory only, no DB persistence
- **Memory processor**: Observation/reflection pipeline with thresholds, but no global budget
- **Condense**: Per-tool-result summarization at 3000 tokens, not integrated with overall budget

### What's Missing
1. Per-content-type token estimation (images, function calls, reasoning)
2. Context layer abstraction with volatility tagging
3. Stable prefix hash computation + cache_control integration
4. Usage ledger DB table with actual vs estimated per turn
5. Budget calibration loop using last turn's actual tokens
6. Global context budget considering both tool results and message history
7. Budget reporting API endpoint

### Recommendations
- Phase 1: Upgrade `src/utils/tokens.ts` with `estimateContentTokens()` handling images, functions
- Phase 2: Create `src/utils/context-layers.ts` + `src/utils/context-budget.ts` with layer definitions, volatility, `createContextBudgetReport()`
- Phase 3: Add `usage_ledger` table + repository with per-turn metrics
- Phase 4: Implement calibration in `src/agent/loop.ts` — load last turn's usage, apply `applyLatestBudgetCalibration()` before each turn
- Phase 5: Expose `/api/session/{id}/budget` endpoint

---

## 6. EVENT PAYLOAD SIDECARS & COMPRESSION

**Severity**: High | **Effort**: Medium

### Reference
- `event_payload_sidecars` table: eventId (PK, FK to domainEvents), payloadCompressed (blob), encoding ('gzip-json-v1')
- `splitEventPayloadForStorage()`: Identifies heavy keys per event type — `generation.completed` extracts `outputItems`, `outputMessages`, `toolCalls`; `generation.started` extracts `inputMessages`, `tools`
- Size threshold: Only stores sidecar if payload > 1024 bytes
- `normalizeSidecarValueForStorage()`: Recursively replaces `outputJson` with `outputRef: { kind: 'tool_execution', callId }` pointing to `toolExecutions` table
- Compression: `gzipSync()` before storage, `gunzipSync()` on retrieval
- Hydration: `hydrateStoredEventPayload()` merges primary + sidecar, `hydrateToolExecutionRefs()` restores outputJson from tool execution table
- `toolExecutions` table: Stores full tool outcomes separately, referenced by callId

### Ours
- Events carry full payloads in-memory via `bus.emit()`
- `generation.completed` event includes full `input: unknown[]` array (all messages!)
- `tool.succeeded` includes full `result: string` inline
- `resultStore` is in-memory only — tool results not persisted to DB
- No compression, no sidecar extraction, no size threshold
- No `toolExecutions` table

### What's Missing
1. `event_payload_sidecars` table in schema
2. `toolExecutions` table (or extend items table) for persistent tool outcomes
3. `splitEventPayloadForStorage()` with per-event-type heavy key extraction
4. gzip compression pipeline (encode/decode)
5. `normalizeForStorage()` replacing outputJson with outputRef
6. Lazy hydration: `hydrateStoredEventPayload()` + `hydrateToolExecutionRefs()`

### Recommendations
- Phase 1: Add `event_payload_sidecars` + `tool_executions` tables to schema
- Phase 2: Create `src/infra/event-payload-sidecar.ts` with split/normalize/compress/hydrate
- Phase 3: Integrate into event emission — intercept `generation.completed`/`generation.started` before storage
- Phase 4: Update `resultStore` to persist to `tool_executions` table
- Phase 5: Add hydration into event read path (replay, export)

---

## 7. CLEAN ARCHITECTURE & DEPENDENCY INJECTION

**Severity**: Low | **Effort**: Large

### Reference
- **4-layer DDD**: `/adapters` (HTTP routes, AI providers, MCP) -> `/application` (commands, use cases) -> `/domain` (repos, entities) -> `/shared` (cross-cutting)
- **Repository pattern**: Factory functions `createRunRepository(db)` returning typed interfaces. All mutations through repos with versioned input types
- **CommandContext**: Bundles config + DB + services + tenantScope + traceId. Passed to every command
- **AppRuntime**: Centralized container created by `createAppRuntime()`, initialized by `initializeAppRuntime()`, shut down by `closeAppRuntime()`
- **Transactions**: `withTransaction(db, tx => {...})` duck-types with RepositoryDatabase. Commands wrap multi-repo calls atomically
- **Result types**: `Result<T, DomainError>` at repo/domain layer. Typed errors: validation | auth | permission | not_found | conflict
- **Optimistic locking**: Every repo update takes `expectedVersion` + `expectedStatus` in WHERE clause. Returns typed `conflict` error on mismatch. Version incremented on every mutation

### Ours
- **Flat structure**: `src/agent/`, `src/infra/`, `src/tools/`, `src/types/` — no layering
- **Direct DB access**: `dbOps` module with flat exported functions, no repository interfaces
- **Global imports**: Each function imports what it needs — no DI, no context threading
- **Bootstrap**: `initServices()` calls scattered functions sequentially
- **Optimistic locking**: Version-only (when provided), boolean return, no status check in WHERE
- **Errors**: Thrown errors or boolean returns — no typed Result<T, E>
- **No transactions**: Direct db calls, possible race in multi-operation sequences

### What's Missing
1. Domain layer with repository interfaces + typed inputs/outputs
2. Result<T, DomainError> type system
3. CommandContext threading through call stacks
4. AppRuntime container with factory + lifecycle
5. Transaction abstraction: `withTransaction()`
6. Full optimistic locking: expectedVersion + expectedStatus in every mutation
7. Multi-tenant scoping (TenantScope on repo methods)

### Recommendations
- Phase 1: Create `src/domain/shared/{result.ts, errors.ts}` — Result type + DomainError union
- Phase 2: Create `src/domain/run/run-repository.ts` with factory pattern + optimistic locking
- Phase 3: Create `src/application/context.ts` (CommandContext) + first command (execute-run)
- Phase 4: Create `src/infra/runtime.ts` (AppRuntime) + refactor bootstrap
- Phase 5: Add `withTransaction()` wrapper in `src/infra/db/transaction.ts`
- Phase 6: Migrate remaining commands, update orchestrator to use repos + context

---

## PRIORITY MATRIX

| # | Gap | Severity | Effort | Cost Impact | Reliability Impact |
|---|-----|----------|--------|-------------|-------------------|
| 1 | Context budget & calibration | **High** | Large | Direct — token waste 25-50% | Context overflow risk |
| 2 | Event payload sidecars | **High** | Medium | Memory pressure | Event data loss |
| 3 | Stable prefix hashing | **High** | Medium | Direct — no prompt caching | Latency |
| 4 | Subagent link registry | **Medium** | Medium | None | Governance gap |
| 5 | File tracking in DB | **Medium** | Medium | None | Data lineage |
| 6 | Job dependency graph | **Medium** | Large | None | No fan-out/fan-in |
| 7 | Event outbox | **Medium** | Medium | None | Events lost on crash |
| 8 | Clean architecture | **Low** | Large | None | Testability |
| 9 | Optimistic locking | **Low** | Small | None | Race conditions |
| 10 | Multi-tenant workspace | **Low** | Large | None | Not needed yet |

### Recommended Implementation Order

**Wave 1 (Cost & Reliability)**: Items 1-3 — Context budget, payload sidecars, prompt caching
**Wave 2 (Multi-agent Robustness)**: Items 4-7 — Subagent registry, file tracking, job graph, event outbox
**Wave 3 (Architecture)**: Items 8-10 — Clean layers, locking, multi-tenancy

---

## STRENGTHS (Where We're Ahead or At Parity)

| Area | Advantage |
|------|-----------|
| **Memory system** | Our observation -> reflection pipeline is more sophisticated than reference's simple context compaction |
| **Knowledge base** | `workspace/knowledge/` with categorized subdirs + index has no reference equivalent |
| **Session logging** | Markdown + JSONL dual logging richer than reference's event-only approach |
| **Entry points** | CLI + Slack + HTTP vs reference's HTTP-only |
| **Per-result condensation** | `condense.ts` pattern (threshold -> LLM summary + file) is solid |
| **Orphan reconciliation** | Both handle crash recovery at startup |
| **MCP integration** | Both dynamically register MCP tools at startup |
| **Tracing** | Both integrate Langfuse |