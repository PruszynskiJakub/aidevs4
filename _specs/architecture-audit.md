# Architecture Audit — March 2026 (Revision 3)

Reaudit of the agent system against AI Devs 4 course materials (S01–S03) and the previous audit (Revision 2). Reflects codebase state as of 2026-03-28.

---

## What's Done Well

**Carried forward:**
- **Tool safety model** remains production-grade. Input validation, sandboxing, path restrictions, prototype pollution checks. Aligns with S01E02's mandate for code-level (not prompt-level) security.
- **Plan-Act loop** with separate prompts at different temperatures.
- **Document UUID passing** between tools (instead of dumping content into context). Matches S01E02's "inter-tool data as files" pattern for ~50% efficiency gain.
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

### 2. RAG is Static, Not Agentic (High — unchanged)

The `document_processor` tool still sends files to Gemini for one-shot Q&A. The course advocates **agentic RAG** where the agent autonomously decides what to search, iterates on results, and deepens queries. Missing:

- No vector store or embedding-based similarity search
- No search/retrieval tool for a persistent knowledge base
- No iterative query refinement loop
- Document store (`src/infra/document.ts`) remains in-memory and session-scoped — no indexing, no persistence beyond session
- The memory system captures observations but doesn't build a searchable knowledge base — it compresses, not indexes

The course (S02E03) describes "reverse RAG" — agents building knowledge bases *for themselves*. The memory observer/reflector distills facts from conversations, but there's no retrieval mechanism to query accumulated knowledge semantically. S02E02 recommends hybrid search (lexical + semantic via Reciprocal Rank Fusion) and lists concrete options: SQLite + FTS5, sqlite-vec, Qdrant, Elasticsearch. None are present.

S02E03 also describes graph-based memory (Neo4j) for semantic relationship discovery and multi-hop reasoning. The system has no graph structure.

**Severity: High.**

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

### 4. No Streaming or Real-Time Feedback (Medium — unchanged)

The agent runs synchronously. `POST /chat` blocks until all iterations complete. No intermediate results, no streaming, no ability to interrupt or redirect mid-execution.

- No streaming API in LLM providers (all `await chatCompletion()`)
- No SSE/WebSocket endpoints on the server
- For a 40-iteration loop with memory processing, this means potentially minutes of silence
- S01E05 recommends a heartbeat mechanism to inform users of ongoing progress

**Severity: Medium.**

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

## Resolved Since Revision 2

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
| 2 | Static RAG, no agentic search | High | **High** | ➡ unchanged |
| 3 | Agent composition vertical only | Medium-High | **Medium** | ⬇ delegate tool landed |
| 4 | No streaming | Medium | **Medium** | ➡ unchanged |
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
| S01E03 | MCP, API design for AI, tool consolidation | ⚠️ Partial | Multi-action tools align well; no MCP server/client; no dynamic tool discovery |
| S01E04 | Multimodal support | ✅ Strong | Gemini for multimodal, image handling in providers |
| S01E05 | Limits, cost, heartbeat, event-driven | ⚠️ Partial | Token estimation and limits exist; no cost guards, no heartbeat, no per-user budgets |
| S02E01 | Context management, workspace structure | ✅ Strong | Memory pipeline, context pruning, session workspace; workspace structure simpler than course recommends |
| S02E02 | External context, RAG, hybrid search | ❌ Weak | Document processor is one-shot; no vector store, no hybrid search, no chunking pipeline |
| S02E03 | Long-term memory, knowledge bases, graphs | ⚠️ Partial | Observation memory excellent; no searchable knowledge base, no graph structure |
| S02E04 | Multi-agent patterns, communication | ⚠️ Partial | Delegate enables vertical delegation; no horizontal communication, no parallel agents |
| S02E05 | Agent design, prompt anatomy, tool assignment | ⚠️ Partial | Agent configs exist; prompt anatomy incomplete (no Voice, Protocol, CTA sections) |
| S03E01 | Observability, evaluation, monitoring | ❌ Weak | Event bus + JSONL logs are the right foundation; zero eval/monitoring built on top |
| S03E02 | Project scoping, programmatic security | ✅ Strong | Tool safety model, sandboxing, scoped file access, moderation |
| S03E03 | Proactive agents, triggers, feedback loops | ❌ Weak | Purely reactive; no cron, webhooks, heartbeat, or autonomous triggers |
| S03E04 | Tool building, iterative refinement, testing | ⚠️ Partial | Tool standard is thorough; Zod migration good; no synthetic test datasets or PromptFoo integration |

---

## Bottom Line

The system continues to mature. The delegate tool resolves the most actionable gap from Revision 2 — agents can now spawn sub-agents for subtask delegation. The Zod schema migration eliminates a class of schema drift bugs. The event bus + JSONL telemetry provide a solid foundation that's ready to support evaluation and monitoring.

**The evaluation gap remains the single most important issue** and is now more urgent. Every new capability (delegate, Zod, memory compression) adds an axis of potential regression that goes unmeasured. The telemetry infrastructure is in place — what's missing is the analysis layer on top: eval datasets, LLM-as-judge scoring, regression detection, and cost monitoring.

Two new gaps were identified: proactive agent capabilities (S03E03) and prompt engineering refinements (S02E05). Neither is critical, but proactive triggers represent a pattern the course dedicates an entire lesson to.

**Priority order:**
1. **Evaluation pipeline** — the event bus and JSONL logs are the data source. Build eval datasets, wire up PromptFoo or Langfuse, add CI-gated regression checks. Start with tool selection accuracy and end-to-end task success rate.
2. **Agentic RAG** — vector store + search tool + iterative query refinement. SQLite + FTS5 or sqlite-vec as a pragmatic starting point. Let the memory system feed a searchable knowledge base.
3. **Horizontal agent communication** — the delegate tool handles vertical delegation. Add shared workspace directories (inbox/outbox per agent) and a `message` tool for bidirectional async communication. Enable parallel sub-agent spawning.
4. **Human-in-the-loop gates** — the tool standard already describes the classification (read/create/mutate/destroy/irreversible). Wire the classification into dispatch with confirmation gates for destroy/irreversible actions.
5. **Proactive capabilities** — cron-triggered agent runs, webhook listeners. Start with a simple heartbeat/polling mechanism.
6. Everything else (streaming, workflows, prompt refinement) builds on these five.