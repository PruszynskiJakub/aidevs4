# Tracing Best Practices for AI Agent Projects

Best practices extracted from `01_05_agent/` — a TypeScript agent system using **Langfuse + OpenTelemetry**.

---

## Architecture Overview

The tracing system follows an **event-driven, subscriber-based** pattern:

```
Runner (emits events) → EventEmitter → Subscribers (Langfuse, Logger)
```

This decouples business logic from observability. The runner never imports Langfuse directly — it just emits typed events. Subscribers translate those events into traces.

---

## 1. Stack: Langfuse over OpenTelemetry

**Dependencies:**
```json
{
  "@langfuse/tracing": "^4.5.1",
  "@langfuse/otel": "^4.5.1",
  "@opentelemetry/sdk-node": "^0.211.0",
  "@opentelemetry/api": "1.9.0",
  "@opentelemetry/resources": "2.5.0",
  "pino": "^10.3.0"
}
```

**Why this stack:** Langfuse provides LLM-specific trace types (generations with token usage, agent spans, tool spans). OpenTelemetry provides the wire protocol and span context propagation. Pino handles structured logging independently.

---

## 2. Graceful Init / Shutdown

```typescript
// tracing.ts
export function initTracing(): void {
  if (!isTracingEnabled()) {
    log.info('langfuse disabled — set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY to enable')
    return
  }

  const processor = new LangfuseSpanProcessor({
    publicKey: config.langfusePublicKey,
    secretKey: config.langfuseSecretKey,
    baseUrl: config.langfuseBaseUrl,
    environment: config.nodeEnv,
  })

  sdk = new NodeSDK({
    spanProcessors: [processor],
    resource: resourceFromAttributes({ 'service.name': 'agent' }),
    autoDetectResources: false,
  })
  sdk.start()
}

export function isTracingEnabled(): boolean {
  return !!(config.langfusePublicKey && config.langfuseSecretKey)
}

export async function shutdownTracing(): Promise<void> {
  if (!sdk) return
  await sdk.shutdown()  // flushes pending spans
}
```

**Key rules:**
- All Langfuse env vars are **optional** — tracing is a no-op when keys are absent
- Every observation factory returns `undefined` when disabled — callers check and skip
- Always flush on shutdown to avoid losing the final spans

---

## 3. Three Observation Types

Create dedicated factory functions for each type:

| Type | Factory | Use for |
|------|---------|---------|
| `agent` | `traceAgent()` | Agent lifecycle (start → end) |
| `generation` | `traceGeneration()` | Individual LLM calls with model, tokens, timing |
| `tool` | `traceTool()` | Tool executions with input args and output |

Each factory accepts `parentSpanContext` for nesting and `startTime` for accurate timing:

```typescript
export function traceGeneration(name: string, opts: {
  model: string
  input?: unknown
  modelParameters?: Record<string, string | number>
  metadata?: Record<string, unknown>
  parentSpanContext?: SpanContext
  startTime?: Date
}) { ... }
```

---

## 4. Event-Driven Decoupling

**Define typed events** — not ad-hoc strings:

```typescript
export type AgentEvent =
  | { type: 'agent.started'; ctx: EventContext; model: string; task: string; ... }
  | { type: 'agent.completed'; ctx: EventContext; durationMs: number; usage?: TokenUsage; result?: string }
  | { type: 'agent.failed'; ctx: EventContext; error: string }
  | { type: 'generation.completed'; ctx: EventContext; model: string; input: unknown[]; output: unknown; usage?: TokenUsage; durationMs: number; startTime: number }
  | { type: 'tool.called'; ctx: EventContext; callId: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool.completed'; ctx: EventContext; callId: string; name: string; arguments: Record<string, unknown>; output: string; durationMs: number; startTime: number }
  | { type: 'tool.failed'; ctx: EventContext; callId: string; name: string; arguments: Record<string, unknown>; error: string; durationMs: number; startTime: number }
  // ... batch, stream, turn events
```

**Wire subscribers at startup:**
```typescript
const events = createEventEmitter()
subscribeEventLogger(events)  // structured logging
subscribeLangfuse(events)     // Langfuse traces
```

**Benefits:**
- Add new subscribers (Datadog, custom analytics) without touching the runner
- Test the runner without any tracing dependency
- Each subscriber manages its own state and cleanup

---

## 5. Context Propagation for Nested Agents

The critical pattern for parent-child trace hierarchy:

```typescript
// In the Langfuse subscriber:
const agentObsMap = new Map<string, AgentObs>()       // agentId → observation
const agentSpanCtxMap = new Map<string, SpanContext>()  // agentId → OTel SpanContext

// On agent.started:
const parentCtx = event.ctx.parentAgentId
  ? agentSpanCtxMap.get(event.ctx.parentAgentId)
  : undefined

const obs = traceAgent(name, { parentSpanContext: parentCtx, ... })
agentSpanCtxMap.set(event.ctx.agentId, getSpanContext(obs))

// On generation.completed or tool.completed:
const parentCtx = agentSpanCtxMap.get(event.ctx.agentId)
const obs = traceGeneration(model, { parentSpanContext: parentCtx, ... })
```

**EventContext carries the threading info:**
```typescript
interface EventContext {
  traceId: string        // shared across entire request
  sessionId: string      // groups multiple requests from same user session
  agentId: string        // this agent's unique ID
  rootAgentId: string    // top-level agent
  parentAgentId?: string // immediate parent (for delegation)
  depth: number          // nesting level (0 = root)
  timestamp: number
}
```

This means:
- All observations in one request share the same `traceId`
- Child agents link to their parent via `parentSpanContext`
- Tools and generations link to their owning agent
- Langfuse renders a proper nested tree

---

## 6. What to Capture on LLM Generations

Format input as a messages array for readability in Langfuse:

```typescript
function formatGenInput(instructions: string, input: ProviderInputItem[]) {
  return [
    { role: 'system', content: instructions },
    ...input.map(item => {
      if (item.type === 'message') return { role: item.role, content: item.content }
      if (item.type === 'function_call') return { role: 'assistant', function_call: { name: item.name, arguments: item.arguments } }
      if (item.type === 'function_result') return { role: 'tool', name: item.name, content: item.output }
      return item
    }),
  ]
}
```

Always capture on generation:
- `model` name
- `input` (formatted messages)
- `output` (text + tool_calls)
- `usage` → `{ input, output, total }` token counts
- `durationMs` and `startTime` for accurate timing

---

## 7. Root Trace Metadata

For the root agent (depth === 0), set trace-level attributes:

```typescript
if (event.ctx.depth === 0) {
  obs.updateTrace({
    name: event.agentName ?? 'agent',
    sessionId: event.ctx.sessionId,
    userId: event.userId,
    input: event.userInput,
  })
}

// And on completion:
if (event.ctx.depth === 0) {
  obs.updateTrace({ output: event.result })
}
```

This gives you filterable traces in Langfuse by user, session, and agent name.

---

## 8. Error Handling in Traces

Mark failed observations with level and message, then always end them:

```typescript
// agent.failed
obs.update({ level: 'ERROR', statusMessage: event.error })
obs.end(new Date(event.ctx.timestamp))

// tool.failed
obs.update({ level: 'ERROR', statusMessage: event.error })
obs.end(new Date(event.startTime + event.durationMs))
```

Always clean up maps on completion/failure to prevent memory leaks:
```typescript
agentObsMap.delete(event.ctx.agentId)
agentSpanCtxMap.delete(event.ctx.agentId)
```

---

## 9. HTTP Header Propagation

Expose trace-related IDs to clients:

```typescript
c.header('X-Session-Id', agent.sessionId)
c.header('X-Agent-Id', agent.id)
c.header('Access-Control-Expose-Headers', 'X-Session-Id, X-Agent-Id')
```

This lets frontends correlate their own telemetry with backend traces.

---

## 10. Subscriber Cleanup Pattern

Each subscriber returns an unsubscribe function:

```typescript
export function subscribeLangfuse(events: AgentEventEmitter): () => void {
  const unsubs: (() => void)[] = []

  unsubs.push(events.on('agent.started', (event) => { ... }))
  unsubs.push(events.on('agent.completed', (event) => { ... }))
  // ...

  return () => {
    for (const unsub of unsubs) unsub()
    agentObsMap.clear()
    agentSpanCtxMap.clear()
  }
}
```

---

## Environment Variables

```env
# All optional — tracing is disabled when keys are absent
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

---

## File Structure Reference

```
src/
  lib/
    tracing.ts              # OTel/Langfuse init + observation factories
    langfuse-subscriber.ts  # Event → Langfuse observation mapping
    event-logger.ts         # Event → structured log (pino)
    config.ts               # Env var schema (zod)
    runtime.ts              # Wires events + subscribers at startup
  events/
    types.ts                # EventContext, AgentEvent union type
    emitter.ts              # Typed event emitter
  runtime/
    runner.ts               # Agent execution loop, emits all events
  routes/
    chat.ts                 # HTTP layer, exposes IDs in headers
```

---

## Summary Checklist

- [ ] Use Langfuse + OTel for LLM-native tracing
- [ ] Make tracing optional — graceful no-op when keys absent
- [ ] Decouple via events — runner emits, subscribers trace
- [ ] Type all events with a discriminated union
- [ ] Three observation types: agent, generation, tool
- [ ] Propagate SpanContext via maps keyed by agentId
- [ ] Carry traceId, sessionId, agentId, depth in every EventContext
- [ ] Format LLM input as messages array for readability
- [ ] Capture token usage and timing on every generation
- [ ] Set trace-level metadata (user, session, name) on root agent
- [ ] Mark errors with level: 'ERROR' and always end() the observation
- [ ] Clean up maps on agent completion/failure
- [ ] Expose session/agent IDs in HTTP response headers
- [ ] Flush tracing on shutdown
- [ ] Subscribers return cleanup functions
