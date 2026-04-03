---
name: audit
description: Audit the codebase architecture for scalability, gaps, bottlenecks, and best practices in building effective AI agents.
disable-model-invocation: true
allowed-tools: Read Grep Glob Bash Agent
---

# Codebase Architecture Audit

Perform a deep, thorough audit of this AI agent codebase. Think carefully and critically about every aspect.

## Scope

Audit the full codebase at `/Users/jakubpruszynski/WebstormProjects/aidevs4/`, focusing on `src/` (production agent system) and `workspace/agents/` (agent definitions).

If `$ARGUMENTS` is provided, narrow focus to that area: $ARGUMENTS

## Audit Dimensions

### 1. Architecture & Design
- Evaluate the overall agent architecture (loop, orchestration, session, memory)
- Assess separation of concerns across modules
- Review the event system design and usage
- Check for circular dependencies or tight coupling
- Evaluate the tool registry and dispatch pattern
- Assess the prompt management system

### 2. Scalability
- Can the agent handle longer conversations / larger context windows?
- How well does the session/memory system scale?
- Are there bottlenecks in the agent loop or orchestration layer?
- How does the tool registry perform as tool count grows?
- Is the file-based storage approach sustainable?
- Can multiple agents run concurrently without conflicts?

### 3. AI Agent Best Practices
- Is the plan/act state machine well-structured for reliable agent behavior?
- How robust is error recovery in the agent loop?
- Is tool result handling safe and efficient (truncation, file-based context passing)?
- Are prompts well-structured for consistent LLM behavior?
- Is the observation/reflection/persistence memory cycle effective?
- How well does the system handle tool failures and retries?
- Is there adequate guardrailing and input moderation?

### 4. Gaps & Missing Pieces
- Identify missing capabilities that would make the agent more effective
- Look for error paths that are unhandled or poorly handled
- Find areas where the system silently fails or degrades
- Check for missing validation at system boundaries
- Identify opportunities for better observability/debugging

### 5. Code Quality & Robustness
- Review error handling patterns for consistency
- Check for resource leaks (open files, connections, timeouts)
- Assess type safety and TypeScript usage
- Look for race conditions or concurrency issues
- Verify that tool sandboxing rules are followed consistently

## Output Format

Organize findings by severity:

1. **Critical** - Issues that could cause failures, data loss, or security problems
2. **Important** - Architectural weaknesses that limit scalability or reliability
3. **Improvement** - Opportunities to make the system more effective
4. **Observations** - Minor notes and patterns worth noting

For each finding, provide:
- **What**: Clear description of the issue
- **Where**: File paths and line numbers
- **Why it matters**: Impact on the system
- **Recommendation**: Concrete suggestion to address it