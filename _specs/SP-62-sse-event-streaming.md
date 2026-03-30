# SP-62 SSE Event Streaming

## Main objective

Stream agent lifecycle events to HTTP clients via Server-Sent Events (SSE),
so consumers see real-time progress (tool calls, plan updates, answers) instead
of waiting for the full turn to complete.

## Context

The production event bus (`src/infra/events.ts`) already emits typed domain
events (`tool.dispatched`, `plan.produced`, `agent.answer`, etc.) during agent
execution. Two consumers exist today:

1. **Rendering listener** (`bridge.ts`) — translates bus events into `Logger`
   method calls for console + markdown output.
2. **JSONL writer** (`jsonl.ts`) — persists every event to disk.

Neither delivers events to HTTP clients. The current `/chat` endpoint blocks
until `executeTurn()` resolves, then returns a single JSON payload. For turns
that take 30-60 seconds (multiple tool calls, planning phases), the client has
no visibility into progress.

A playground prototype in `playground/semantic_events/` demonstrates the SSE
pattern with Hono's `streamSSE()`, buffered replay, and heartbeat. This spec
promotes that pattern into production by bridging the existing event bus to SSE.

### CLI

The CLI already gets real-time event display for free — the `ConsoleLogger` is
wired via the bus bridge and renders events as they're emitted during
`executeTurn()`. No CLI changes are needed.

## Out of scope

- Token-level streaming from LLM providers (real `stream: true`)
- WebSocket transport
- Approval gating / human-in-the-loop (exists in playground, not promoted here)
- Client-side UI (this spec covers the server SSE endpoint only)
- Changes to `EventMap`, `BusEvent`, or `EventBus` interfaces
- Changes to `ConsoleLogger` or CLI entry point

## Constraints

- No new runtime dependencies (Hono's `streamSSE` is already available)
- Must not alter the agent loop, tool dispatch, or event bus internals
- SSE endpoint must handle client disconnection gracefully (no leaked listeners)
- Events for one session must not leak to another session's SSE stream
- Must work with the existing session queue (`sessionService.enqueue`) — only
  one turn executes per session at a time
- Heartbeat interval to prevent proxy/load-balancer timeouts

## Architecture

### Client flow

```
POST /chat  { sessionId, msg, stream: true }
  Content-Type: text/event-stream

  event: agent_event
  data: {"id":"...","type":"turn.began","ts":1711353600000,"sessionId":"abc","data":{...}}

  event: agent_event
  data: {"id":"...","type":"tool.dispatched","ts":1711353601000,"sessionId":"abc","data":{...}}

  event: heartbeat
  data:

  event: agent_event
  data: {"id":"...","type":"agent.answer","ts":1711353610000,"sessionId":"abc","data":{"text":"The answer is..."}}

  (stream closes)
```

When `stream: true` is absent or false, `/chat` behaves exactly as today
(blocks, returns `{ msg: answer }`). This preserves backward compatibility.

### Server-side event filtering

Clients may pass `?events=tool.dispatched,agent.answer` to receive only
specific event types. When omitted, all events are forwarded. The filter is
applied server-side before writing to the SSE stream, reducing bandwidth for
clients that only care about specific transitions.

### Data flow

```
loop.ts / orchestrator.ts
         |
         |  bus.emit("tool.dispatched", {...})
         v
   EventBus (singleton)
         |
    onAny listeners
         |
    +-----------+-------------+----------------+
    |           |             |                |
 bridge.ts   jsonl.ts   SSE listener      (future)
 (console)   (disk)    (per-connection)
```

The SSE listener is **not** a permanent bus subscriber. It is created
per-request, subscribes when the SSE connection opens, and unsubscribes when
the connection closes or the turn ends. This avoids accumulating listeners
across requests.

### SSE listener lifecycle

```typescript
// Inside the /chat handler when stream: true
return streamSSE(c, async (stream) => {
  const allowedEvents = parseEventFilter(c.req.query("events"));
  let closed = false;

  const unsubscribe = bus.onAny((event) => {
    if (closed) return;
    if (event.sessionId !== sessionId) return;       // session isolation
    if (allowedEvents && !allowedEvents.has(event.type)) return; // filter

    stream.writeSSE({
      event: "agent_event",
      data: JSON.stringify(event),
      id: event.id,
    }).catch(() => { closed = true; });
  });

  // Heartbeat every 15s
  const heartbeat = setInterval(() => {
    if (closed) return;
    stream.writeSSE({ event: "heartbeat", data: "" })
      .catch(() => { closed = true; });
  }, 15_000);

  stream.onAbort(() => { closed = true; });

  // Run the actual turn — events stream as they're emitted
  try {
    const { answer } = await sessionService.enqueue(sessionId, () =>
      executeTurn({ sessionId, prompt: msg, assistant }),
    );
    // Send a final "done" event with the answer for convenience
    if (!closed) {
      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ answer }),
      });
    }
  } catch (err) {
    if (!closed) {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      });
    }
  } finally {
    clearInterval(heartbeat);
    unsubscribe();
  }
});
```

Key decisions:

1. **Session isolation** — the `onAny` listener checks `event.sessionId`
   before forwarding. Events from other concurrent sessions are silently
   dropped.

2. **No buffering needed** — unlike the playground's two-step flow
   (POST /chat returns sessionId, then GET /events/:sessionId), the single-
   endpoint approach means the SSE connection is open *before* `executeTurn`
   starts. No events can be missed, so no replay buffer is needed.

3. **Graceful close** — the stream ends naturally after `executeTurn` resolves
   (or errors). The `done` / `error` meta-events let the client distinguish
   clean completion from connection drops.

4. **Heartbeat** — 15-second interval prevents reverse proxies and load
   balancers from killing idle connections during long LLM calls.

### SSE event format

Each SSE message uses:
- `event: agent_event` — the SSE event name (constant, for `addEventListener`)
- `data:` — the full `BusEvent` envelope as JSON (same shape as JSONL)
- `id:` — the event UUID (enables `Last-Event-ID` reconnection in future)

Special meta-events:
- `event: done` — turn completed, `data` contains `{ answer: string }`
- `event: error` — turn failed, `data` contains `{ error: string }`
- `event: heartbeat` — keepalive, empty data

### Changes to server.ts

The `/chat` handler gains a conditional branch:

```typescript
app.post("/chat", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = parseChatBody(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const { sessionId, msg, requestedAssistant } = parsed;
  const wantsStream = (body as any)?.stream === true;

  if (wantsStream) {
    return streamSSE(c, async (stream) => {
      // ... SSE listener lifecycle as above
    });
  }

  // Existing non-streaming path (unchanged)
  try {
    const { answer } = await sessionService.enqueue(sessionId, () =>
      executeTurn({ sessionId, prompt: msg, assistant: requestedAssistant }),
    );
    return c.json({ msg: answer });
  } catch (err) { /* ... existing error handling ... */ }
});
```

### File changes

```
src/
  server.ts              # Add SSE branch to /chat handler
                         # Add parseEventFilter() helper
                         # Import streamSSE from hono/streaming, bus from infra/events
```

No new files. All logic lives in the `/chat` handler. If the SSE logic grows
complex, it can be extracted to `src/infra/sse.ts` later — but for now a single
handler branch is simpler.

## Acceptance criteria

- [ ] `POST /chat` with `stream: true` returns `Content-Type: text/event-stream`
- [ ] Bus events emitted during `executeTurn` are forwarded as SSE `agent_event` messages
- [ ] Events from other sessions are not leaked to the SSE stream
- [ ] `?events=type1,type2` filters events server-side; omitting sends all
- [ ] `event: done` with `{ answer }` is sent when the turn completes
- [ ] `event: error` with `{ error }` is sent when the turn fails
- [ ] Heartbeat events are sent every 15 seconds
- [ ] Client disconnection unsubscribes the bus listener and clears the heartbeat
- [ ] `POST /chat` without `stream: true` behaves exactly as before (JSON response)
- [ ] No changes to `EventMap`, `EventBus`, agent loop, or CLI

## Implementation plan

1. Add `streamSSE` import from `hono/streaming` and `bus` import from
   `src/infra/events.ts` to `server.ts`
2. Add `parseEventFilter(query: string | undefined): Set<string> | null`
   helper — splits comma-separated event types, returns null if empty/absent
3. Extend `parseChatBody` to extract `stream?: boolean` from request body
4. Add the `wantsStream` branch in the `/chat` handler with the SSE listener
   lifecycle (subscribe, heartbeat, session filter, event filter, cleanup)
5. Keep existing non-streaming path unchanged

## Testing scenarios

- **SSE happy path**: POST with `stream: true`, verify event stream contains
  `turn.began`, tool events, and `done` event with answer
- **Non-streaming unchanged**: POST without `stream: true`, verify JSON
  response as before
- **Session isolation**: Run two concurrent sessions with streaming, verify
  each stream only receives its own events
- **Event filtering**: POST with `?events=agent.answer`, verify only
  `agent.answer` events (plus `done`/`error`/`heartbeat` meta-events) arrive
- **Client disconnect**: Abort the connection mid-turn, verify bus listener
  is unsubscribed and no errors are thrown
- **Error propagation**: Trigger a turn error (e.g., unknown agent), verify
  `error` SSE event is sent
- **Heartbeat**: Hold a connection open during a long turn, verify heartbeat
  events arrive at ~15s intervals