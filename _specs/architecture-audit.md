# Architecture Audit — March 2026

Audit of the agent system architecture against state-of-the-art patterns described in AI Devs 4 course materials and industry best practices as of March 2026.

---

## What's Done Well

- **Tool safety model** is genuinely production-grade. Input validation, sandboxing, path restrictions, prototype pollution checks — better than most agent systems. The `_aidocs/tools_standard.md` is thorough.
- **Plan-Act loop** with separate prompts at different temperatures is a sound pattern.
- **Document UUID passing** between tools (instead of dumping content into context) is smart context management.
- **Multi-action tool schema** with `tool__action` expansion is clean API design.
- **No tool-to-tool coupling** in hints — exactly what S02E01/S02E02 recommend.
- **Provider abstraction** (OpenAI + Gemini behind `LLMProvider` interface) gives model flexibility.

---

## What's Behind the Curve

### 1. Memory is Completely Absent (Critical)

The course dedicates three full modules (S02E01–S02E03) to context and memory. The agent has zero long-term memory. The `documentService` is an in-memory `Map` that dies with the process. There is no:
- Persistent knowledge base
- Vector store or semantic search
- Agent-optimized document store (the S02E03 "reverse RAG" concept)
- Cross-session context sharing

The course explicitly says agents should build knowledge bases *for themselves*, not just consume human docs.

### 2. Single-Agent Only — No Multi-Agent Support (High)

S02E04 and S02E05 cover multi-agent orchestration, specialist agents, and peer-to-peer communication. The system is a single agent loop with no way to:
- Spawn sub-agents for parallel investigation
- Have specialist agents with different tool sets
- Share context between concurrent threads
- Orchestrate agent-to-agent handoffs

The `assistant` concept exists but it's just a prompt template swap — not a real multi-agent architecture.

### 3. No Evaluation or Observability Pipeline (Critical)

S03E01 describes three verification levels (programmatic, LLM-based, human). Currently:
- Markdown logs exist (good for debugging, not evaluation)
- Zero automated evaluation of agent responses
- No LLM-as-judge scoring
- No metrics tracking (success rate, tool call efficiency, cost per task)
- No regression detection when prompts/tools change

The course warns that "even tiny changes significantly impact behavior." Without eval, changes are made blind.

### 4. RAG is Static, Not Agentic (High)

The `document_processor` tool sends files to Gemini for Q&A. This is 2023-era "stuff documents into context" RAG. The course advocates **agentic RAG** — where the agent autonomously decides what to search, iterates on results, deepens queries based on findings. Missing:
- Search/retrieval tool for a knowledge base
- Ability to iteratively refine queries
- Embedding-based similarity search

### 5. Context Window Management is Naive (High)

All messages accumulate in `state.messages` with no pruning, summarization, or compression. With a 40-iteration loop and verbose XML documents, context limits will be hit on complex tasks. The course (S01E05, S02E01) emphasizes this as a core production constraint. Missing:
- Message summarization/compression
- Selective context loading
- Token budget tracking with overflow strategy

### 6. No Streaming or Real-Time Feedback (Medium)

The agent runs synchronously — user submits prompt, waits for all iterations to complete, gets final answer. No intermediate results, no streaming, no ability to interrupt or redirect mid-execution. For a 40-iteration loop, this is poor UX.

### 7. Model Selection is Dated (Medium)

Config hardcodes `gpt-4.1` as the agent model (March 2025 vintage). The course notes (for March 2026) that GPT-5.2, Claude Opus 4.5, and Gemini 3 Pro are top tier. More importantly, there's no reasoning model integration — the `think` tool calls GPT-4.1 for "deep reasoning" instead of using an actual reasoning model (o3, o4-mini, etc.) which would be far more effective.

### 8. No Workflow Composition (Medium)

The course explicitly distinguishes workflows (deterministic step sequences) from agents (dynamic tool selection) and says **both should coexist** — workflows as tools within agents. The system only has the agent pattern. No way to define a fixed workflow (e.g., "always do X then Y then Z for this task type") and expose it as a callable tool.

### 9. Weak Error Recovery (Medium)

The prompts say "never repeat identical failed call" but the architecture has no structural support. Missing:
- Failure memory within a session
- Automatic tool fallback chains
- Circuit breakers for repeatedly failing tools
- Cost/budget guards to prevent runaway iterations

### 10. No Human-in-the-Loop (Low-Medium)

For destructive or irreversible actions (the course mentions email, external API posts), there's no confirmation gate. The `shipping.redirect` tool mutates external state with no user approval step. The tool standard mentions it but it's not implemented.

---

## Severity Summary

| Gap | Impact | Effort |
|-----|--------|--------|
| No memory/persistence | Critical | Medium |
| No evaluation pipeline | Critical | Medium |
| No context management | High | Medium |
| Single-agent only | High | High |
| Static RAG | High | Medium |
| Dated models, no reasoning | Medium | Low |
| No streaming | Medium | Medium |
| No workflow composition | Medium | Medium |
| Weak error recovery | Medium | Low |
| No human-in-the-loop | Low-Medium | Low |

---

## Bottom Line

The agent is a well-engineered single-turn tool-calling loop with excellent security hygiene. That was state-of-the-art in mid-2024. By March 2026 standards — per the AI Devs 4 course — it's missing the features that separate a "tool-calling wrapper" from an actual autonomous agent system: persistent memory, multi-agent orchestration, agentic search, evaluation, and context management.

The foundation (type system, provider abstraction, tool safety) is solid. But the interesting problems — the ones the course spends 80% of its content on — haven't been built yet. The toolbox is clean; the agent brain is thin.

**Priority order:** memory system, evaluation pipeline, context window management. Everything else compounds on those.