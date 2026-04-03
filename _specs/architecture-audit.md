# Architecture Audit — April 2026 (Revision 5)

Reaudit of the agent system against AI Devs 4 course materials (S01–S03) and the previous audit (Revision 4). Reflects codebase state as of 2026-04-03.

---

## What's Done Well

**Carried forward:**
- **Tool safety model** remains production-grade. Input validation, sandboxing, path restrictions, prototype pollution checks. Aligns with S01E02's mandate for code-level (not prompt-level) security.
- **Plan-Act loop** with separate prompts at different temperatures.
- **Lightweight `ToolResult` type** with MCP-aligned content parts (`TextContent`, `ImageContent`, `ResourceRef`). Tools return plain text by default; only large content uses `ResourceRef` file references. Replaced the previous `Document` UUID/XML system — eliminates ~30 tokens of XML envelope overhead per tool call while preserving the file-based reference pattern for large outputs (~50% context efficiency). Result store (`src/infra/result-store.ts`) tracks tool calls by `toolCallId` with two-phase lifecycle. Aligns with S01E03's MCP type compatibility.
- **Multi-action tool schema** with `tool__action` expansion. Clean consolidation of related actions (e.g., `web__download`, `web__scrape`) — mirrors S01E03's recommendation to consolidate granular tools into logical groups.
- **No tool-to-tool coupling** in hints — exactly what S02E01/S02E02 recommend.
- **Provider abstraction** (OpenAI + Gemini behind `LLMProvider` interface). Course (S01E05) explicitly recommends unified interface for multiple providers.
- **Memory system** with observer → reflector pipeline (`src/agent/memory/`). Persistent cross-session state, multi-level compression, priority-tagged observations. Directly implements the Observational Memory pattern from S02E01 (observer → log → reflector → compress at 60K).
- **Context window management.** Dynamic message pruning, token estimation, observation compression with configurable thresholds (30K observation, 40K reflection). Tool output condensation via LLM (`src/infra/condense.ts`). Addresses S01E05's context management and S02E01's dynamic context fragments.
- **Multi-agent support via `.agent.md` configs** (`workspace/agents/`). Agents have distinct models, prompts, and tool filters. Session-pinned agent selection. Specialist agents exist (e.g., `proxy.agent.md` for identity masquerading).
- **Model routing** — GPT-5 default, Gemini 3 Flash for multimodal, GPT-4.1-mini for cost-effective tasks. Provider routing dispatches model→provider. Aligns with S01E05's "cheaper models for simpler tasks" and S02E04's model-per-agent approach.
- **Comprehensive structured logging** with specialized log methods, token tracking per call and phase. Event bus (`src/infra/events.ts`) emits typed events for all state transitions — session lifecycle, tool dispatch, memory compression, moderation. JSONL persistence for offline analysis.
- **AsyncLocalStorage context** (`src/agent/context.ts`) — clean session propagation without parameter threading.

**New since Revision 2:**
- **Sub-agent delegation is now implemented** via `delegate` tool (`src/tools/delegate.ts`). An agent can spawn a child agent in an isolated session with a different assistant config. The delegate tool dynamically discovers available agents from `workspace/agents/` and passes context through a prompt parameter. Child agents run with their own memory, logging, and tool sets. This was the #3 gap — now substantially addressed.
- **Zod schema migration** (SP-60). All tool schemas migrated from hand-written JSON to Zod objects. Registry converts via `z.toJSONSchema()` with OpenAI `strict: true` enforcement. Eliminates schema drift, provides runtime validation at the type level, and makes schemas co-located with handler code.
- **Event-driven telemetry matured.** JSONL writer compacts large fields (strips `fullText` from plans, `result` from tool completions) before persisting. Bridge pattern (`src/infra/log/bridge.ts`) converts bus events to logger calls. This is the foundation for the observability hierarchy S03E01 describes (Session → Trace → Span → Generation → Tool → Event) — the events exist, the analysis layer doesn't.
- **ToolResult refactor** (SP-61). Replaced `Document` type with `ToolResult { content: ContentPart[]; isError?: boolean }`. Tool results are now plain text by default, with `ResourceRef` content parts only for large files. Registry serializes content parts to plain text (no XML). `document_processor` takes file paths instead of UUIDs. `resolveUri()` helper for `file://` URI conversion. All 15 tool handlers migrated in one pass.
- **Knowledge workspace seeded** — `workspace/knowledge/` exists with `_index.md`, `procedures/`, and `reference/` directories. Default agent prompt references it. However, no agent writes to it (see gap #2).

---

## What's Still Behind the Curve

### 1. No Evaluation Pipeline (Critical — unchanged, risk increasing)

S03E01 describes a monitoring hierarchy and three verification levels (programmatic, LLM-based, human). The system has excellent telemetry infrastructure (typed events, JSONL logs, token tracking) but **zero automated evaluation on top of it**:

- No eval datasets (input + expected output + scoring metric)
- No LLM-as-judge scoring or rubric-based grading
- No metrics tracking (success rate, tool call efficiency, cost per task)
- No regression detection when prompts/tools/models change
- No offline eval runner (CI/CD integration) or online monitoring
- No violation detection (output policy checks, performance anomalies)
- No prompt versioning synced to an observability platform
- An empty `src/evals/` directory exists but contains no code
- A task-specific evaluation script exists in `playground/evaluation/` but it's not a general framework

The irony: the event bus and JSONL logs are *exactly* the data source an eval pipeline would consume. The plumbing is there — the analysis layer is not. Each new capability (delegate tool, memory compression, Zod schemas) adds another axis of potential regression that goes unmeasured.

**Course requirements not met:**
- Eval datasets covering positive, negative, and edge cases (S03E01)
- Critical path evals: tool selection accuracy, tool usage quality (S03E01)
- Deterministic + LLM-graded scoring metrics (S03E01)
- Cost monitoring per user/session with anomaly detection (S01E05, S03E01)
- PromptFoo or Langfuse integration (both mentioned in backlog, neither started)

**Severity: Critical. Impact continues to increase with each new capability.**

---

### 2. No Knowledge Accumulation or Exploratory Retrieval (High — reframed)

The previous audit framed this gap as "no vector store or embeddings." That misses the point. The course (S02E02, S02E03) presents a **spectrum** of retrieval approaches and explicitly says vector stores are not always necessary:

1. **Filesystem + grep/ripgrep** — simplest, no indexing overhead, often sufficient for markdown-based knowledge
2. **SQLite + FTS5** — full-text search with minimal complexity
3. **sqlite-vec / Qdrant** — semantic search when meaning-based matching is needed
4. **Neo4j graphs** — for multi-hop relationship discovery across documents

The course says: *"instead of asking 'which approach is best?' ask 'which is best for the problem I'm solving?'"* (S02E02). The system already has `grep`, `glob`, `read_file` — basic exploration tools. For a markdown-based workspace, these could be sufficient for retrieval. **The real gap is not technology — it's the pattern.**

#### What's actually missing: Reverse RAG

S02E03's central insight is **reverse RAG** — instead of connecting agents to existing human-written documents, agents **build knowledge bases for themselves**. The key difference:

- **Traditional RAG**: chunk existing docs → index → search → hope the agent finds the right fragments
- **Reverse RAG**: agent writes structured notes → navigates via internal references → always knows where things are

The course illustrates this with a Task Manager agent that reads `workflows/` for instructions, follows a reference to `projects/overview.md`, discovers a project link, and navigates there — all through **document-internal references**, not similarity search. This mirrors how coding agents navigate codebases: grep to find an entry point, then follow imports/references to discover dependencies.

The course identifies four navigation modes that make this work:
- **Perspective** (bird's-eye view): overview of available materials
- **Navigation** (search): searching filenames and content
- **References** (links): cross-references between documents
- **Details** (read): reading original document content

The system has navigation (#2 via grep/glob) and details (#4 via read_file). What it lacks:

- ❌ **No knowledge accumulation across sessions.** The memory system compresses observations into a running log, but doesn't write structured notes or documents that persist as searchable files. Observations are ephemeral summaries, not a growing knowledge base. An agent can't say "I learned X about project Y last week" and find the note.
- ❌ **No perspective tool.** No way for an agent to get a bird's-eye overview of accumulated knowledge — a category map, a table of contents, or a directory listing of what it "knows."
- ❌ **No reference-following pattern.** Documents don't contain cross-references to other documents. The agent can't follow a chain of `→ see also: ./related-topic.md` links.
- ❌ **No dedicated knowledge directory.** The workspace has `sessions/` (ephemeral) and `shared/` (empty). There's no `knowledge/` or `notes/` directory where agents write persistent, structured notes that outlive sessions.
- ❌ **No document-building agents.** S02E03 describes specialized agents for knowledge organization (e.g., a meeting transcription processor that writes structured notes). No such agents exist.
- ❌ **`document_processor` is one-shot.** Sends files to Gemini for Q&A — no iterative deepening, no writing findings back to a persistent location.

#### What this is NOT about

This gap is **not** primarily about:
- Needing a vector database (filesystem search may suffice for the current scale)
- Needing embeddings (grep + glob cover lexical search)
- Needing Neo4j (overkill without a clear multi-hop use case)

It **is** about:
- Agents writing structured notes that persist beyond sessions
- A workspace directory structure designed for agent navigation (per S02E03's examples)
- Cross-references between documents that agents can follow
- The memory system feeding a searchable knowledge base, not just compressing into a running log

The Observational Memory implementation is excellent for *within-session* context management. But S02E03's vision is broader: agents that accumulate knowledge *across sessions* by writing notes, organizing them, and navigating them later. The infrastructure (file tools, workspace, agent configs) is all there — the pattern just hasn't been applied.

**Severity: High (reframed — the gap is knowledge accumulation and exploratory navigation, not specific technology).**

---

### 3. Agent Composition is Vertical Only (Medium — improved from Medium-High)

The `delegate` tool enables an agent to spawn sub-agents in isolated sessions — a significant step. However, the multi-agent architecture supports only **vertical delegation** (parent → child), not the full compositional patterns the course describes:

- ✅ Agent can spawn sub-agents for subtask delegation
- ✅ Child agents run with isolated sessions, memory, and tool sets
- ✅ Dynamic agent discovery (reads `workspace/agents/` at runtime)
- ❌ No horizontal agent-to-agent communication (shared workspace, inbox/outbox)
- ❌ No parallel agent spawning (delegate is sequential — parent waits for child)
- ❌ No orchestration layer for coordinating multiple concurrent agents
- ❌ No shared context or workspace directories between agents (S02E04's workspace structure with `inbox/`, `outbox/`, `notes/` per agent)
- ❌ No agent handoff within a session (session-pinned to one agent)

The course (S02E04) describes six multi-agent patterns: Pipeline, Blackboard, Orchestrator, Tree, Mesh, Swarm. The system implements a simplified Orchestrator (root delegates to specialist) but can't do Pipeline (sequential handoff) or Blackboard (shared state). S02E04 also describes `delegate` (context reset) vs `message` (bidirectional async) communication — only `delegate` exists.

**Severity: Medium (downgraded from Medium-High — vertical delegation now works).**

---

### 4. Limited Streaming and Real-Time Feedback (Medium — partially resolved)

SSE event streaming is now implemented (SP-62). `POST /chat` with `stream: true` returns a Server-Sent Events stream of all agent lifecycle events in real-time (tool dispatch, plan updates, answers, session lifecycle). Includes server-side event filtering (`?events=type1,type2`), 15-second heartbeat keepalive, and graceful disconnect cleanup. Non-streaming path unchanged for backward compatibility.

- ✅ SSE endpoint on the server (`POST /chat` with `stream: true`)
- ✅ Real-time agent lifecycle events (tool calls, plan steps, answers)
- ✅ Heartbeat mechanism (15s interval, per S01E05)
- ✅ Server-side event filtering for bandwidth control
- ❌ No token-level streaming from LLM providers (still `await chatCompletion()`)
- ❌ No ability to interrupt or redirect mid-execution

**Severity: Medium (downgraded from full gap — SSE streaming and heartbeat now work).**

---

### 5. No Workflow Composition (Medium — unchanged)

The course distinguishes workflows (deterministic step sequences) from agents (dynamic tool selection) and says both should coexist — workflows as callable tools within agents. The system only has the agent pattern:

- No workflow definitions as data structures or DAGs
- No conditional branching or deterministic step sequences
- Plan is ephemeral (regenerated each iteration, not a persistent workflow definition)
- No way to define "always do X then Y then Z for this task type" and expose it as a tool

**Severity: Medium.**

---

### 6. No Human-in-the-Loop for Destructive Actions (Medium — unchanged)

Input moderation exists (`src/infra/guard.ts` via OpenAI Moderation API), but there are no confirmation gates for destructive or irreversible actions:

- No approval workflow for write/delete/external API calls
- No UI confirmation step before irreversible actions
- The course (S02E05) explicitly says irreversible/high-risk actions must be confirmed via UI, not text — and that permission validation must happen in code, not prompts
- Tool standard (`_aidocs/tools_standard.md`) describes the safeguard classification (read/create/mutate/destroy/irreversible) but implementation is missing
- The `delegate` tool now enables spawning sub-agents that inherit destructive tools — widening the blast radius without confirmation gates

S03E02 reinforces this: "Block dangerous actions at code level, not prompt level." The shipping tool's security code requirement is the only example of a programmatic gate.

**Severity: Medium.**

---

### 7. Weak Circuit Breakers and Cost Guards (Low-Medium — unchanged)

Error recovery improved significantly (defensive validation, try-catch dispatch, max iterations), but structural safeguards are still missing:

- No circuit breakers for repeatedly failing tools
- No cost/budget guards to prevent runaway LLM spending
- No automatic tool fallback chains
- No retry logic with exponential backoff for transient failures
- No rate limit handling (S01E05 recommends monitoring HTTP headers for rate limit resets)
- No per-user or per-session token budgets (S01E05, S03E01)

The 40-iteration cap is the only hard guard. A failing tool can waste all 40 iterations. The delegate tool adds another dimension: a child agent also gets up to 40 iterations, so a single user request could trigger 80+ LLM calls with no budget check.

**Severity: Low-Medium.**

---

### 8. No Proactive Agent Capabilities (Low-Medium — new gap)

S03E03 describes autonomous triggers beyond user-initiated messages: hooks (internal events), webhooks (external notifications), cron (scheduled), and heartbeat (periodic health checks). The system is entirely request-response:

- No cron/scheduled agent execution
- No webhook listeners that trigger agent runs
- No heartbeat mechanism for proactive monitoring
- No `tasks.md` pattern where agents check and execute pending work
- The backlog mentions "heartbeat" as a planned feature but nothing is implemented

S03E03's calendar/meeting agent example shows an agent that proactively checks schedules, enriches contacts, and sends reminders — all without user initiation. This pattern is absent.

**Severity: Low-Medium (new gap — the system is purely reactive).**

---

### 9. Prompt Engineering Gaps (Low — new gap)

S02E05 provides a detailed system prompt anatomy: Identity → Protocol → Voice → Tools/Agents → Workspace → CTA. Comparing against the agent prompts:

- ✅ Identity section exists in agent configs
- ✅ Tools section generated dynamically
- ⚠️ No Voice section (tone, vocabulary, style examples, anti-patterns)
- ⚠️ No Protocol section for error recovery and context management rules
- ⚠️ CTA ("Now do X") is implicit, not explicit
- ⚠️ No workspace section injected with current memory/observation state (observations are appended to system prompt, but not in the structured format S02E05 describes)

S01E02 also emphasizes prompt caching as the "highest priority optimization." The system doesn't appear to leverage provider-level prompt caching (stable system instructions that hit cache). With the plan prompt regenerated each iteration, cache hit rates will be low.

**Severity: Low (functional but not optimized per course recommendations).**

---

## Resolved Since Revision 3

| Previous Gap | Status | How Addressed |
|---|---|---|
| Document UUID/XML overhead (implicit) | **Resolved** | SP-61 ToolResult refactor. `Document` type replaced with lightweight `ToolResult`. Tool results are plain text by default. `ResourceRef` content parts for large files only. ~30 tokens saved per tool call. Result store tracks by `toolCallId`. `document_processor` uses file paths instead of UUIDs. MCP-aligned content part types. |

---

## Resolved Since Revision 2 (carried forward)

| Previous Gap | Status | How Addressed |
|---|---|---|
| No sub-agent spawning (Medium-High) | **Substantially Resolved** | `delegate` tool enables vertical delegation. Child agents run in isolated sessions with own memory, tools, and logging. Dynamic agent discovery from `workspace/agents/`. |
| JSON schema drift risk (implicit) | **Resolved** | Zod migration (SP-60). Schemas co-located with handlers. Runtime validation + JSON Schema generation via `z.toJSONSchema()`. |

---

## Resolved Since Revision 1 (carried forward)

| Previous Gap | Status | How Addressed |
|---|---|---|
| Memory is Completely Absent (Critical) | **Resolved** | Observer → reflector pipeline in `src/agent/memory/`. Persistent state via `memory-state.json`. Multi-level compression. Priority-tagged observations. |
| Context Window Management is Naive (High) | **Resolved** | Dynamic message pruning (observed messages dropped, tail budget kept). Token estimation. Observation compression at 30K/40K thresholds. Tool output condensation via LLM. |
| Single-Agent Only (High) | **Resolved** | `.agent.md` configs + `delegate` tool. Specialist agents with per-agent models, prompts, and tool filters. Vertical delegation with session isolation. |
| Model Selection is Dated (Medium) | **Resolved** | GPT-5 default. Gemini 3 Flash for multimodal. GPT-4.1-mini for cost-effective tasks. Provider routing. |
| Weak Error Recovery (Medium) | **Partially Resolved** | Defensive validation, try-catch dispatch, batch allSettled, max iterations, memory persistence. But no circuit breakers or cost guards. |

---

## Severity Summary

| # | Gap | Rev 2 | Rev 3 | Trend |
|---|-----|-------|-------|-------|
| 1 | No evaluation pipeline | Critical | **Critical** | ⬆ worse (delegate + Zod add untested axes) |
| 2 | No knowledge accumulation / exploratory retrieval | High | **High** | 🔄 reframed (pattern, not technology) |
| 3 | Agent composition vertical only | Medium-High | **Medium** | ⬇ delegate tool landed |
| 4 | Limited streaming | Medium | **Medium** | ⬇ SSE event streaming landed (SP-62) |
| 5 | No workflow composition | Medium | **Medium** | ➡ unchanged |
| 6 | No human-in-the-loop | Medium | **Medium** | ➡ delegate widens blast radius |
| 7 | No circuit breakers/cost guards | Low-Medium | **Low-Medium** | ➡ delegate amplifies risk |
| 8 | No proactive capabilities | — | **Low-Medium** | 🆕 new gap identified |
| 9 | Prompt engineering gaps | — | **Low** | 🆕 new gap identified |

---

## Course Alignment Scorecard

How the system maps to each course module:

| Module | Topic | Alignment | Notes |
|--------|-------|-----------|-------|
| S01E01 | Structured outputs, few-shot, parallel processing | ✅ Strong | JSON schemas, batch tool dispatch, file-based progress |
| S01E02 | Prompt caching, tool design, security | ⚠️ Partial | Tool design excellent; prompt caching not leveraged; progressive disclosure not implemented |
| S01E03 | MCP, API design for AI, tool consolidation | ⚠️ Partial | Multi-action tools align well; ToolResult content parts are MCP-aligned (TextContent, ImageContent, ResourceRef); no MCP server/client; no dynamic tool discovery |
| S01E04 | Multimodal support | ✅ Strong | Gemini for multimodal, image handling in providers |
| S01E05 | Limits, cost, heartbeat, event-driven | ⚠️ Partial | Token estimation and limits exist; heartbeat via SSE (SP-62); no cost guards, no per-user budgets |
| S02E01 | Context management, workspace structure | ✅ Strong | Memory pipeline, context pruning, session workspace; workspace structure simpler than course recommends |
| S02E02 | External context, RAG, hybrid search | ⚠️ Partial | File exploration tools (grep, glob, read) cover lexical search. Missing: iterative query deepening, document-building agents, structured knowledge output |
| S02E03 | Long-term memory, knowledge bases, graphs | ⚠️ Partial | Observation memory excellent for in-session compression. Missing: cross-session knowledge accumulation, reverse RAG pattern (agents writing persistent structured notes), reference-following navigation |
| S02E04 | Multi-agent patterns, communication | ⚠️ Partial | Delegate enables vertical delegation; no horizontal communication, no parallel agents |
| S02E05 | Agent design, prompt anatomy, tool assignment | ⚠️ Partial | Agent configs exist; prompt anatomy incomplete (no Voice, Protocol, CTA sections) |
| S03E01 | Observability, evaluation, monitoring | ❌ Weak | Event bus + JSONL logs are the right foundation; zero eval/monitoring built on top |
| S03E02 | Project scoping, programmatic security | ✅ Strong | Tool safety model, sandboxing, scoped file access, moderation |
| S03E03 | Proactive agents, triggers, feedback loops | ❌ Weak | Purely reactive; no cron, webhooks, heartbeat, or autonomous triggers |
| S03E04 | Tool building, iterative refinement, testing | ⚠️ Partial | Tool standard is thorough; Zod migration good; no synthetic test datasets or PromptFoo integration |

---

## Bottom Line

The system continues to mature. The ToolResult refactor (SP-61) replaces the heavyweight Document/XML system with lightweight MCP-aligned content parts — tool results are now plain text by default, saving ~30 tokens per call and aligning with MCP's type system for future interoperability. The result store provides structured tracking of tool call lifecycle by `toolCallId`.

**The evaluation gap remains the single most important issue** and is now more urgent. Every new capability (delegate, Zod, ToolResult, memory compression) adds an axis of potential regression that goes unmeasured. The telemetry infrastructure is in place — what's missing is the analysis layer on top: eval datasets, LLM-as-judge scoring, regression detection, and cost monitoring.

Two gaps identified in Revision 3 remain: proactive agent capabilities (S03E03) and prompt engineering refinements (S02E05). Neither is critical, but proactive triggers represent a pattern the course dedicates an entire lesson to.

**Priority order:**
1. **Evaluation pipeline** — the event bus and JSONL logs are the data source. Build eval datasets, wire up PromptFoo or Langfuse, add CI-gated regression checks. Start with tool selection accuracy and end-to-end task success rate.
2. **Knowledge accumulation (reverse RAG)** — agents write structured notes to a persistent `knowledge/` directory, with cross-references between documents. Start with filesystem + existing grep/glob tools — no vector store needed yet. Let the memory system feed a navigable knowledge base, not just a compressed log.
3. **Horizontal agent communication** — the delegate tool handles vertical delegation. Add shared workspace directories (inbox/outbox per agent) and a `message` tool for bidirectional async communication. Enable parallel sub-agent spawning.
4. **Human-in-the-loop gates** — the tool standard already describes the classification (read/create/mutate/destroy/irreversible). Wire the classification into dispatch with confirmation gates for destroy/irreversible actions.
5. **Proactive capabilities** — cron-triggered agent runs, webhook listeners. Start with a simple heartbeat/polling mechanism.
6. Everything else (token-level streaming, workflows, prompt refinement) builds on these five.