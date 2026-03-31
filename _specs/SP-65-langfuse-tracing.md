# SP-65 Langfuse Tracing

## Main objective

Add Langfuse observability to the agent system so every LLM call (plan, act, memory observer, memory reflector) and tool dispatch is traced with full inputs, outputs, model name, and token usage — enabling cost analysis, latency debugging, and quality inspection via the Langfuse dashboard.

## Context

The agent loop (`src/agent/loop.ts`) runs a plan/act cycle with tool dispatch, calling two LLM providers (OpenAI, Gemini) through a provider-agnostic `LLMProvider` interface. Memory processing (`observer.ts`, `reflector.ts`) makes additional LLM calls. Today, observability is limited to Markdown logs and a JSONL event stream — neither provides aggregated cost/latency dashboards or per-model analytics.

The Langfuse OTel-based SDK packages are already installed:
- `@langfuse/tracing@5.0.1`
- `@langfuse/otel@5.0.1`
- `@opentelemetry/sdk-node@0.214.0`

The SDK exposes `setLangfuseTracerProvider()` which accepts any OTel `TracerProvider`, meaning we can use `BasicTracerProvider` from `@opentelemetry/sdk-trace-base` (already installed as transitive dep) instead of `NodeSDK` — avoiding Node.js-specific async_hooks issues on Bun.

## Out of scope

- Langfuse prompt management (managing prompts via Langfuse UI)
- User feedback / scoring integration
- Tracing the moderation call in `src/infra/guard.ts` (not an LLM generation)
- OpenAI SDK auto-instrumentation via `observeOpenAI` wrapper (we trace at the loop level instead, covering both providers)
- Dashboard/alerting configuration in Langfuse UI

## Constraints

- **Bun runtime**: Must not depend on `NodeSDK` or `NodeTracerProvider`. Use `BasicTracerProvider` + `setLangfuseTracerProvider()` for guaranteed Bun compatibility.
- **Optional**: When `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` env vars are absent, the system must behave identically to today — zero overhead, no errors.
- **No LLMProvider interface changes**: Instrumentation wraps calls from outside, never touches the provider abstraction.
- **Full inputs**: Send complete LLM message arrays to Langfuse (no truncation). Rely on Langfuse's own handling of large payloads.
- **Fail-open**: Tracing initialization or span export failures must never break the agent. All tracing code paths wrapped in try/catch.

## Acceptance criteria

- [ ] When `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` are set, an agent run (`bun run agent "hello"`) produces a trace in Langfuse with the correct hierarchy
- [ ] Each trace has `sessionId` matching the agent session and `tags` containing the assistant name
- [ ] Plan phase appears as a **generation** with: name="plan", model, input (messages), output (plan text), usageDetails (promptTokens, completionTokens)
- [ ] Act phase appears as a **generation** with: name="act", model, input (messages), output (content + tool call names), usageDetails
- [ ] Each tool call appears as a child **span** (asType="tool") with: name=tool name, input=args, output=result, duration
- [ ] Memory observer calls appear as **generation** (name="observer") with model, input summary, output, usageDetails
- [ ] Memory reflector calls appear as **generation** (name="reflector-level-{n}") with model, usageDetails
- [ ] Each iteration is wrapped in a parent **span** (name="iteration-{n}")
- [ ] When env vars are missing, tracing is fully disabled — no imports fail, no overhead, no console output
- [ ] Tracing failures (network errors, SDK exceptions) are caught and logged as warnings, never crash the agent
- [ ] `forceFlush()` is called before the agent run ends, ensuring all spans are exported
- [ ] Existing tests (`bun test`) continue to pass without Langfuse env vars

## Implementation plan

### 1. Add optional Langfuse env vars to config

**File**: `src/config/env.ts`

Add three optional properties (no validation — absence means tracing disabled):
```
langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY
langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY
langfuseBaseUrl: process.env.LANGFUSE_BASE_URL
```

### 2. Create the tracing module

**File**: `src/infra/tracing.ts` (new)

This is the core of the integration — a single module encapsulating all Langfuse/OTel logic. Exports:

- `initTracing(): void` — conditionally initializes `BasicTracerProvider` with `LangfuseSpanProcessor`, calls `setLangfuseTracerProvider()`. No-op if env vars missing. Wrapped in try/catch.
- `shutdownTracing(): Promise<void>` — calls `provider.forceFlush()` then `provider.shutdown()`.
- `isTracingEnabled(): boolean`

Wrapper functions (all no-ops when tracing disabled, all try/catch internally):

- `traceAgentRun<T>(sessionId, assistant, input, fn): Promise<T>` — creates the root trace via `startActiveObservation("agent-run", fn)` + `propagateAttributes({ sessionId, tags: [assistant] })`. Sets trace input to the user prompt, output to the final answer.
- `traceIteration<T>(iteration, fn): Promise<T>` — wraps in `startActiveObservation("iteration-{n}", fn)`.
- `traceGeneration<T>(name, model, input, fn, extractOutput): Promise<T>` — wraps in `startActiveObservation(name, fn, { asType: "generation" })`. Calls `gen.update({ input, model })` before, and `gen.update({ output, usageDetails })` after.
- `traceToolDispatch<T>(fn): Promise<T>` — wraps in `startActiveObservation("tool-dispatch", fn)`.
- `traceToolCall<T>(toolName, args, fn): Promise<T>` — wraps in `startActiveObservation(toolName, fn, { asType: "tool" })`. Sets input=parsed args, output=result.
- `traceSpan<T>(name, fn): Promise<T>` — generic span wrapper for memory processing.

Key implementation detail for `BasicTracerProvider` setup:
```typescript
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";

const langfuseProcessor = new LangfuseSpanProcessor({ publicKey, secretKey, baseUrl });
const provider = new BasicTracerProvider({ spanProcessors: [langfuseProcessor] });
setLangfuseTracerProvider(provider);
```

This bypasses `NodeSDK` entirely. Context propagation still works via `startActiveObservation` which internally manages OTel span context using the `@opentelemetry/api` context manager.

### 3. Initialize tracing at entry points

**Files**: `src/cli.ts`, `src/server.ts`

Add `import { initTracing } from "./infra/tracing.ts"` and call `initTracing()` at the top, before any agent logic runs.

### 4. Instrument the agent loop

**File**: `src/agent/loop.ts`

Changes (wrapping, not rewriting):

**`runAgent()`**: Wrap the body inside `runWithContext(...)` with `traceAgentRun()`. In the `finally` block, add `await shutdownTracing()`.

**Iteration loop**: Wrap each iteration body with `traceIteration(i, async () => { ... })`.

**`processMemory` call**: Wrap with `traceSpan("memory-processing", () => processMemory(...))`.

**`executePlanPhase` call**: Wrap with:
```typescript
traceGeneration("plan", planPrompt.model!, messages,
  () => executePlanPhase(planPrompt, provider),
  (planText) => ({
    output: planText,
    usageDetails: { input: state.tokens.plan.promptTokens, output: state.tokens.plan.completionTokens }
  })
)
```

**`executeActPhase` call**: Wrap with:
```typescript
traceGeneration("act", state.model, messages,
  () => executeActPhase(planText, context.systemPrompt, provider),
  (response) => ({
    output: { content: response.content, toolCalls: response.toolCalls.map(tc => tc.function.name) },
    usageDetails: response.usage ? { input: response.usage.promptTokens, output: response.usage.completionTokens } : undefined
  })
)
```

**`dispatchTools` call**: Wrap with `traceToolDispatch(() => dispatchTools(functionCalls))`.

**Individual tool calls inside `dispatchTools`**: Wrap each `dispatch()` call with `traceToolCall(tc.function.name, tc.function.arguments, () => dispatch(...))`.

**`flushMemory` call**: Wrap with `traceSpan("flush-memory", () => flushMemory(...))`.

### 5. Instrument memory observer

**File**: `src/agent/memory/observer.ts`

Wrap the `provider.chatCompletion()` call inside `observe()` with:
```typescript
traceGeneration("observer", model,
  { systemPrompt: prompt.content, existingObservations: existingObservations.length, messageCount: messages.length },
  () => provider.chatCompletion({...}),
  (resp) => ({
    output: resp.content,
    usageDetails: resp.usage ? { input: resp.usage.promptTokens, output: resp.usage.completionTokens } : undefined
  })
)
```

### 6. Instrument memory reflector

**File**: `src/agent/memory/reflector.ts`

Wrap each `provider.chatCompletion()` call in the reflection loop with:
```typescript
traceGeneration(`reflector-level-${level}`, model,
  { level, targetTokens, observationLength: observations.length },
  () => provider.chatCompletion({...}),
  (resp) => ({
    output: resp.content,
    usageDetails: resp.usage ? { input: resp.usage.promptTokens, output: resp.usage.completionTokens } : undefined
  })
)
```

### Expected trace hierarchy

```
Trace: "agent-run" [sessionId, tags: [assistant]]
  input: user prompt
  output: final answer
  ├── Span: "iteration-0"
  │   ├── Span: "memory-processing"
  │   │   ├── Generation: "observer" [model, usage]
  │   │   └── Generation: "reflector-level-0" [model, usage]
  │   ├── Generation: "plan" [model, messages, planText, usage]
  │   ├── Generation: "act" [model, messages, response, usage]
  │   └── Span: "tool-dispatch"
  │       ├── Tool: "web_search" [args, result]
  │       └── Tool: "read_file" [args, result]
  ├── Span: "iteration-1"
  │   └── ...
  └── Span: "flush-memory"
      └── Generation: "observer" (flush)
```

### Files modified (summary)

| File | Change |
|---|---|
| `src/config/env.ts` | Add 3 optional env vars |
| `src/infra/tracing.ts` | **New** — tracing module with init, shutdown, wrapper functions |
| `src/cli.ts` | Add `initTracing()` call |
| `src/server.ts` | Add `initTracing()` call |
| `src/agent/loop.ts` | Wrap runAgent, iterations, plan/act/tools with tracing helpers |
| `src/agent/memory/observer.ts` | Wrap LLM call with `traceGeneration` |
| `src/agent/memory/reflector.ts` | Wrap LLM calls with `traceGeneration` |

## Testing scenarios

1. **Tracing disabled (no env vars)**: Run `bun test` — all existing tests pass unchanged. Run `bun run agent "hello"` — agent works normally, no Langfuse-related console output.

2. **Tracing enabled**: Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` in `.env`. Run `bun run agent "what tools do you have?"`. Open Langfuse dashboard → Traces → verify:
   - Trace named "agent-run" exists with correct sessionId
   - Contains iteration spans, each with plan generation + act generation
   - Generations show model name, token usage, full input/output
   - Tool calls (if any) appear as child tool-type spans

3. **Tracing init failure**: Temporarily set invalid `LANGFUSE_BASE_URL`. Run agent — should work normally with a warning in console, no crash.

4. **Unit tests for tracing module**: `src/infra/tracing.test.ts` — verify wrapper functions are identity functions when tracing is disabled (pass through return values and propagate errors).
