# SP-48 Observational Memory

## Main objective

Add a two-stage context compression pipeline (observer + reflector) that replaces old conversation messages with structured text observations, keeping the context window stable and predictable across long agent sessions.

## Context

Today the agent accumulates all messages in `state.messages` with no pruning or summarization. A 40-iteration session with verbose tool results will eventually exceed the context window, causing degraded performance or outright failure. There is no memory infrastructure — sessions are in-memory only, documents are ephemeral, and there is no mechanism to compress or evict old context.

The Mastra Observational Memory pattern (Feb 2026) solves this with a text-based approach that scores ~95% on LongMemEval without requiring vector stores or graph databases. It splits context into two blocks — compressed observations and recent raw messages — and uses two LLM-powered stages (observer, reflector) to manage the lifecycle. This is a natural fit for the existing architecture: the prompt service, LLM provider abstraction, and session service already provide the needed foundation.

## Out of scope

- Cross-session memory sharing (each session owns its observations independently)
- Vector stores, embeddings, or semantic search
- Async/background observation (synchronous only for now)
- Changes to the plan phase prompt or think tool
- Multi-agent memory coordination

## Constraints

- Observer and reflector LLM calls use `gpt-4.1-mini` to keep costs low
- Must not break existing agent behavior when memory thresholds are not yet reached (< 30K unobserved tokens = no change to current flow)
- Observation and reflection prompts live in `src/prompts/` as `.md` files (no hardcoded prompt text)
- File I/O through the `files` service only
- Token estimation must be consistent across all components (single utility)
- Observation state persisted to disk as JSON per session (survives process restart)
- Debug artifacts (observer/reflector outputs) saved as numbered markdown files for auditability
- All thresholds configurable via `config.memory`

## Acceptance criteria

- [ ] Conversations under 30K unobserved tokens pass through unchanged (no observation triggered)
- [ ] When unobserved messages exceed 30K tokens, the observer compresses old messages into prioritized bullet-point observations (🔴/🟡/🟢)
- [ ] Recent messages (tail 30% of threshold) remain unobserved to preserve immediate context
- [ ] Observed messages are dropped from the context window and replaced by observations appended to the system prompt
- [ ] When observations exceed 40K tokens, the reflector compresses them (up to 3 levels, targeting 20K tokens)
- [ ] Observation state (activeObservations, lastObservedIndex, observationTokenCount, generationCount) is persisted to disk per session and restored on session resume
- [ ] Debug outputs saved as `observer-NNN.md` and `reflector-NNN.md` with YAML frontmatter in the session output directory
- [ ] `flushMemory` at session end observes any remaining unprocessed messages
- [ ] Existing tests pass; new tests cover observer, reflector, processor, and token estimation
- [ ] Agent loop integration is transparent — no changes to tool implementations or schemas

## Implementation plan

1. **Token estimation utility** (`src/utils/tokens.ts`)
   - Function `estimateTokens(text: string): number` — use `Math.ceil(text.length / 4)` as baseline (matches current document store heuristic), but centralize it
   - Function `estimateMessagesTokens(messages: LLMMessage[]): number` — sums over serialized message content
   - Replace the inline heuristic in `document-store.ts` with this utility

2. **Memory types** (`src/types/memory.ts`)
   - `MemoryState`: `{ activeObservations: string; lastObservedIndex: number; observationTokenCount: number; generationCount: number }`
   - `MemoryConfig`: `{ observationThreshold: number; reflectionThreshold: number; reflectionTarget: number; tailBudgetRatio: number; maxReflectionLevels: number; truncationLimits: { message: number; toolPayload: number } }`
   - `ProcessedContext`: `{ systemPrompt: string; messages: LLMMessage[] }` — the output of the processor

3. **Memory config** (extend `src/config/index.ts`)
   - Add `memory` section with defaults: `observationThreshold: 30_000`, `reflectionThreshold: 40_000`, `reflectionTarget: 20_000`, `tailBudgetRatio: 0.3`, `maxReflectionLevels: 3`, `truncationLimits: { message: 6_000, toolPayload: 3_000 }`
   - Add `models.memory: "gpt-4.1-mini"`

4. **Observer prompt** (`src/prompts/observer.md`)
   - Model: `gpt-4.1-mini`, temperature: `0.3`
   - System role: "You are the memory consciousness of an AI assistant"
   - Input: serialized messages (truncated per limits) + existing observations
   - Output: new observations as prioritized bullets grouped by date, with 🔴/🟡/🟢 priority tags
   - Rule: only extract NEW facts not already in existing observations

5. **Observer service** (`src/services/memory/observer.ts`)
   - `observe(messages: LLMMessage[], existingObservations: string): Promise<string>`
   - Serializes messages with truncation limits from config
   - Calls LLM via provider with observer prompt
   - Returns new observation text to append

6. **Reflector prompt** (`src/prompts/reflector.md`)
   - Model: `gpt-4.1-mini`, temperature: `0.2`
   - Input: current observations + compression level instruction
   - Three levels of compression guidance (level 0: reorganize, level 1: condense older aggressively, level 2: keep only durable facts)
   - Output: compressed observations (full replacement)

7. **Reflector service** (`src/services/memory/reflector.ts`)
   - `reflect(observations: string, targetTokens: number): Promise<string>`
   - Tries compression levels 0→2 sequentially, stops when output ≤ target
   - If none reach target, uses best (smallest) result
   - Returns compressed observations

8. **Memory processor** (`src/services/memory/processor.ts`)
   - `processMemory(systemPrompt: string, messages: LLMMessage[], state: MemoryState): Promise<{ context: ProcessedContext; state: MemoryState }>`
   - Decision flow:
     1. Count unobserved message tokens (from `lastObservedIndex` to end)
     2. If below threshold → return messages as-is, append observations to system prompt if any exist
     3. If above threshold → split at tail budget, run observer on old messages, append new observations, update `lastObservedIndex`
     4. If `observationTokenCount` exceeds reflection threshold → run reflector, update `generationCount`
   - Returns processed context (modified system prompt + trimmed messages) and updated state

9. **Memory persistence** (`src/services/memory/persistence.ts`)
   - `saveState(sessionId: string, state: MemoryState): Promise<void>` — writes JSON to session output dir
   - `loadState(sessionId: string): Promise<MemoryState | null>` — reads from disk, returns null if not found
   - `saveDebugArtifact(sessionId: string, type: "observer" | "reflector", content: string, metadata: Record<string, unknown>): Promise<void>` — numbered markdown files with YAML frontmatter

10. **Agent loop integration** (modify `src/agent.ts`)
    - Load memory state at session start (from disk or initialize empty)
    - Before each plan/act phase: call `processMemory()` to get processed context
    - Use processed system prompt and trimmed messages for LLM calls
    - After each iteration: persist memory state to disk
    - On agent completion: call `flushMemory` (observe any remaining unprocessed messages, persist final state)

11. **Logging** — extend markdown logger with memory-specific entries: `memoryObserve(tokensBefore, tokensAfter)`, `memoryReflect(level, tokensBefore, tokensAfter)`

## Testing scenarios

- **Token estimation**: verify `estimateTokens` and `estimateMessagesTokens` produce consistent results; edge cases (empty string, very long text)
- **Observer**: feed sample messages + existing observations → verify output contains only new facts, uses priority tags, respects truncation limits
- **Observer deduplication**: feed messages that repeat known observations → verify no duplicates in output
- **Reflector levels**: feed large observation text → verify each compression level produces smaller output; verify level escalation stops at target
- **Reflector worst-case**: feed observations that can't be compressed to target → verify best result is used
- **Processor below threshold**: 10K tokens of messages → verify pass-through with no observation triggered
- **Processor above threshold**: 35K tokens of messages → verify observer runs, old messages dropped, observations appended to system prompt, tail messages preserved
- **Processor reflection trigger**: inject 45K tokens of observations → verify reflector runs after observation
- **Persistence round-trip**: save state → load state → verify identical
- **Persistence missing file**: load from nonexistent session → verify null/empty state returned
- **Agent integration**: run agent with enough messages to trigger observation → verify context window shrinks, agent still produces coherent output
- **Flush**: end session with unprocessed messages → verify they get observed before shutdown
- **Debug artifacts**: verify observer/reflector outputs saved as numbered markdown files with correct frontmatter
