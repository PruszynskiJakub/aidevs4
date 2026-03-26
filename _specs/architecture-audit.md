# Architecture Audit — March 2026 (Revision 2)

Reaudit of the agent system against AI Devs 4 course materials and the previous audit (Revision 1). Reflects codebase state as of 2026-03-25.

---

## What's Done Well (unchanged + new)

**Carried forward from Revision 1:**
- **Tool safety model** remains production-grade. Input validation, sandboxing, path restrictions, prototype pollution checks.
- **Plan-Act loop** with separate prompts at different temperatures.
- **Document UUID passing** between tools (instead of dumping content into context).
- **Multi-action tool schema** with `tool__action` expansion.
- **No tool-to-tool coupling** in hints — exactly what S02E01/S02E02 recommend.
- **Provider abstraction** (OpenAI + Gemini behind `LLMProvider` interface).

**New since Revision 1:**
- **Memory system is now implemented** with a sophisticated observer → reflector pipeline (`src/agent/memory/`). Persistent cross-session state, multi-level compression, priority-tagged observations. This was the #1 critical gap — now resolved.
- **Context window management is now implemented.** Dynamic message pruning (observed messages discarded, tail budget kept), token estimation, observation compression with configurable thresholds (30K observation, 40K reflection). Tool output condensation via LLM (`src/infra/condense.ts`) keeps large results from bloating context.
- **Multi-agent support via `.agent.md` configs** (`workspace/agents/`). Agents have distinct models, prompts, and tool filters. Session-pinned agent selection. Specialist agents exist (e.g., `proxy.agent.md` with restricted tool set for identity masquerading).
- **Model selection upgraded** to GPT-5 (`gpt-5-2025-08-07`) as default agent model. Gemini 3 Flash for multimodal. GPT-4.1-mini for cost-effective transform/memory tasks. Provider routing handles model→provider dispatch.
- **Error recovery improved** with defensive validation throughout, try-catch tool dispatch, batch `Promise.allSettled`, max iteration guardrails, and memory persistence after each iteration.
- **Comprehensive structured logging** with specialized log methods (step, llm, plan, toolHeader, toolCall, toolOk, toolErr, memoryObserve, memoryReflect, answer, maxIter). Token usage tracked per call and aggregated by phase.
- **AsyncLocalStorage context** (`src/agent/context.ts`) for clean session propagation without parameter threading.
- **Flat, clean architecture** after recent refactor: `agent/` (brain), `llm/` (providers), `infra/` (I/O), `tools/` (capabilities).

---

## What's Still Behind the Curve

### 1. No Evaluation Pipeline (Critical — unchanged)

S03E01 describes a monitoring hierarchy (Session → Trace → Span → Generation → Agent → Tool → Event) and three verification levels (programmatic, LLM-based, human). The system has excellent logging but zero automated evaluation:

- No eval datasets (input + expected output + scoring metric)
- No LLM-as-judge scoring or rubric-based grading
- No metrics tracking (success rate, tool call efficiency, cost per task)
- No regression detection when prompts/tools/models change
- No offline eval runner (CI/CD integration) or online monitoring
- No violation detection (output policy checks, performance anomalies)

The course warns that "even tiny changes significantly impact behavior." The system now has memory, context management, and model upgrades — all of which can silently degrade quality without an eval pipeline to catch regressions. This gap is more dangerous now than in Revision 1 because there are more moving parts.

**Course requirements not met:**
- System prompt versioning synced to observability platform (S03E01)
- Eval datasets covering positive, negative, and edge cases (S03E01)
- Critical path evals: tool selection accuracy, tool usage quality (S03E01)
- Deterministic + LLM-graded scoring metrics (S03E01)

**Severity: Critical. Impact has increased since Revision 1.**

---

### 2. RAG is Static, Not Agentic (High — unchanged)

The `document_processor` tool still sends files to Gemini for Q&A. The course advocates **agentic RAG** where the agent autonomously decides what to search, iterates on results, and deepens queries. Missing:

- No vector store or embedding-based similarity search
- No search/retrieval tool for a persistent knowledge base
- No iterative query refinement loop
- Document store (`src/infra/document.ts`) remains in-memory and session-scoped — no indexing, no persistence beyond session
- The memory system captures observations but doesn't build a searchable knowledge base — it compresses, not indexes

The course (S02E03) describes "reverse RAG" — agents building knowledge bases *for themselves*. The memory observer/reflector is a step in this direction (it distills facts from conversations), but there's no retrieval mechanism to query accumulated knowledge semantically.

**Severity: High.**

---

### 3. No Sub-Agent Spawning or Agent-to-Agent Communication (Medium-High — partially addressed)

The `.agent.md` system supports specialist agents with filtered tool sets — a significant improvement. However, the multi-agent architecture is still selection-based (pick one agent per session), not compositional:

- No ability for an agent to spawn sub-agents for parallel investigation
- No agent-to-agent communication (shared workspace, inbox/outbox)
- No orchestration layer for coordinating multiple concurrent agents
- No agent handoff within a session (session-pinned to one agent)
- The course (S02E04, S02E05) describes workspace organization with inter-agent communication directories and permission boundaries — none of this exists

The current model is "choose the right specialist at session start." The course model is "agents collaborate, delegate, and share context during execution."

**Severity: Medium-High (downgraded from High — specialist agents exist, but composition doesn't).**

---

### 4. No Streaming or Real-Time Feedback (Medium — unchanged)

The agent runs synchronously. `POST /chat` blocks until all iterations complete. No intermediate results, no streaming, no ability to interrupt or redirect mid-execution.

- No streaming API in LLM providers (all `await chatCompletion()`)
- No SSE/WebSocket endpoints on the server
- For a 40-iteration loop with memory processing, this means potentially minutes of silence

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

### 6. No Human-in-the-Loop for Destructive Actions (Medium — mostly unchanged)

Input moderation exists (`src/infra/guard.ts` via OpenAI Moderation API), but there are no confirmation gates for destructive or irreversible actions:

- No approval workflow for write/delete/external API calls
- No UI confirmation step before irreversible actions
- The course (S02E05) explicitly says irreversible/high-risk actions must be confirmed via UI, not text — and that permission validation must happen in code, not prompts
- Tool standard (`_aidocs/tools_standard.md`) describes the safeguard classification (read/create/mutate/destroy/irreversible) but implementation is missing

**Severity: Medium (upgraded from Low-Medium — the system now has more tools that mutate external state).**

---

### 7. Weak Circuit Breakers and Cost Guards (Low-Medium — partially addressed)

Error recovery improved significantly (defensive validation, try-catch dispatch, max iterations), but structural safeguards are still missing:

- No circuit breakers for repeatedly failing tools
- No cost/budget guards to prevent runaway LLM spending
- No automatic tool fallback chains
- No retry logic with exponential backoff for transient failures
- No rate limit handling (the course recommends monitoring HTTP headers for rate limit resets)

The 40-iteration cap is the only hard guard. A failing tool can waste all 40 iterations.

**Severity: Low-Medium (downgraded — basic guardrails now exist).**

---

## Resolved Since Revision 1

| Previous Gap | Status | How Addressed |
|---|---|---|
| Memory is Completely Absent (Critical) | **Resolved** | Observer → reflector pipeline in `src/agent/memory/`. Persistent state via `memory-state.json`. Multi-level compression. Priority-tagged observations. |
| Context Window Management is Naive (High) | **Resolved** | Dynamic message pruning (observed messages dropped, tail budget kept). Token estimation. Observation compression at 30K/40K thresholds. Tool output condensation via LLM. |
| Single-Agent Only (High) | **Partially Resolved** | `.agent.md` configs with per-agent models, prompts, and tool filters. Specialist agents exist. But no spawning, no inter-agent communication, no composition. |
| Model Selection is Dated (Medium) | **Resolved** | Upgraded to GPT-5 default. Gemini 3 Flash for multimodal. GPT-4.1-mini for cost-effective tasks. Provider routing. |
| Weak Error Recovery (Medium) | **Partially Resolved** | Defensive validation, try-catch dispatch, batch allSettled, max iterations, memory persistence. But no circuit breakers or cost guards. |

---

## Severity Summary (Updated)

| Gap | Previous | Current | Trend |
|-----|----------|---------|-------|
| No evaluation pipeline | Critical | **Critical** | ⬆ worse (more moving parts) |
| Static RAG, no agentic search | High | **High** | ➡ unchanged |
| No agent composition/spawning | High | **Medium-High** | ⬇ improved |
| No streaming | Medium | **Medium** | ➡ unchanged |
| No workflow composition | Medium | **Medium** | ➡ unchanged |
| No human-in-the-loop | Low-Medium | **Medium** | ⬆ more tools mutate state |
| No circuit breakers/cost guards | Medium | **Low-Medium** | ⬇ improved |

---

## Bottom Line

The system has matured significantly since Revision 1. Three of the five highest-severity gaps have been addressed: memory, context management, and model selection. The architecture is now a legitimate agent system — not just a tool-calling wrapper. The memory pipeline (observer → reflector → persistence) and context pruning are well-designed and align with course recommendations.

**What remains is the evaluation gap** — and it's now the single most important issue. The system has enough complexity (memory compression, context pruning, multi-agent selection, model routing) that changes in any component can silently degrade overall quality. Without automated evaluation, there's no way to know if a prompt tweak, memory threshold change, or model upgrade helps or hurts.

The secondary gaps (agentic RAG, agent composition, streaming, workflows, HITL) are real but less urgent. Agentic RAG would unlock knowledge accumulation across sessions — the memory system captures facts but can't retrieve them semantically. Agent composition would enable parallel investigation and delegation. Both are course-recommended patterns that would compound on the existing foundation.

**Priority order:**
1. **Evaluation pipeline** — evals for tool selection, tool usage quality, and end-to-end task success. Start with offline/CI, add online monitoring later.
2. **Agentic RAG** — vector store + search tool + iterative query refinement. Let the memory system feed a searchable knowledge base.
3. **Human-in-the-loop gates** — confirmation for destructive/irreversible actions. The tool standard already describes the classification; wire it up.
4. Everything else builds on these three.