# Backlog

## Observability

- [ ] Langfuse integration — tracing, eval, token tracking. SP-65/SP-67
- [ ] Token usage visibility — no insight into per-session token consumption
- [ ] Evaluation pipeline — eval datasets, LLM-as-judge, regression detection (architecture-audit gap #3)
- [ ] Heartbeat — liveness/health checks for long-running agents

## Agent Core

- [ ] Remove plan phase — halve per-turn latency, enable exploration-first. SP-72 + feeling.md
- [ ] Prompt caching — system prompt mutates every turn, ~200k wasted tokens/session. Move observations to user-role messages, add `cache_control` (architecture-audit gap #1/#5)
- [ ] Agent skillset separation — split agents into focused skill sets
- [ ] Agent mode flag — headless (CLI) vs server as part of AgentContext
- [ ] Smart retry — retry based on API response body, not just status code. SP-70
- [ ] Model routing — route queries to dedicated model based on task type

## Prompt Engineering

- [ ] Prompt rewrite — invert "fewest steps" framing, enable exploration before execution. feeling.md
- [ ] Tool hierarchy in prompts — guide tool selection order (feeling.md Difference 2)
- [ ] Tool schema filtering — default agent gets all 16 schemas, limit to ~10-12 (architecture-audit gap #2)

## Tooling

- [ ] Browser session isolation — singleton causes parallel collisions. SP-75
- [ ] Publish tool — expose files externally (security review required)
- [ ] Share tool — inter-agent file sharing
- [ ] Upload tool — file upload for users and agents
- [ ] Human approval tool — Slack UI for destructive action confirmation
- [ ] Ollama integration — local model support

## Knowledge & Memory

- [ ] Knowledge accumulation — workspace seeded but unused. Add retrieval (grep, FTS5, semantic). (architecture-audit gap #4)
- [ ] Memory vs log separation — shared memory space != shared log space

## Infrastructure

- [ ] Slack bot entry point — event-bus driven progress streaming. SP-71
- [ ] Communication clients — Slack, CLI, Postman as I/O channels
- [ ] File path hygiene — standardize save paths across tools
- [ ] Browser feedback loop — collect tips and patterns during browsing

## Bugs

- [ ] web__download path handling — returns `file:///` URI but agent tries relative paths, looping ~10 glob attempts. Response should hand off absolute path clearly. (partially addressed in bba1d06)