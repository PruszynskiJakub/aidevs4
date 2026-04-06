# SP-76 Human-in-the-Loop Confirmation Gate

## Main objective

Add a generic, MCP-aligned confirmation mechanism that pauses the agent loop
before executing tool calls that require human approval — closing the
"no confirmation gates for destructive actions" gap identified in the
architecture audit (item 7).

## Context

The agent dispatches all tool calls immediately via `Promise.allSettled` in
`dispatchTools()` (`src/agent/loop.ts:138`). No tool call is ever held for human
review. SP-18 proposed a `risk` classification and dry-run/checksum safeguards
but explicitly scoped out confirmation gates ("no UI exists"). The `risk` field
has not been implemented yet.

MCP defines `ToolAnnotations` (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`) as hints the **client** uses to decide
whether to gate a call. Our MCP integration (`src/infra/mcp.ts`) currently
ignores these annotations.

The tool standard (`_aidocs/tools_standard.md` §4) requires destroy/irreversible
actions to have confirmation gates or scope locks. Only `shipping` (security
code) and `edit_file` (checksum guard) partially comply.

V1 scope: every `web__scrape` call requires confirmation. CLI and HTTP providers.

## Out of scope

- Automatic confirmation policy based on `risk` field or MCP annotations
  (future: annotations are stored but not consulted)
- Slack confirmation provider (would need interactive message buttons)
- Config-driven per-tool confirmation rules
- Undo/rollback after approval
- Dry-run preview before confirmation (SP-18 covers dry-run separately)

## Constraints

- **Backwards compatible**: if no confirmation provider is set, all calls
  auto-approve. Existing behavior unchanged for any entry point that doesn't
  register a provider.
- **Zero overhead on non-gated calls**: if no calls in a batch need
  confirmation, no prompt/await happens.
- **Batch-aware**: when the LLM returns multiple tool calls, all needing
  confirmation are presented together in one prompt — not one-by-one.
- **Per-call decisions**: within a batch, the human can approve some and deny
  others.
- **MCP-aligned**: our `ToolAnnotations` type mirrors MCP's `ToolAnnotations`
  interface exactly. MCP tool annotations are passed through at registration.
- **HTTP timeout**: if the client doesn't respond within 120 s, all pending
  calls are auto-denied.
- **No new dependencies**.

## Acceptance criteria

- [ ] `ToolDefinition` extended with optional `annotations?: ToolAnnotations`
      and `confirmIf?: (call) => boolean`
- [ ] `confirmIf` receives `{ action, args, callId }` where `action` is the
      action name (e.g. `"scrape"`) not the expanded registry name
- [ ] `ToolAnnotations` type matches MCP spec: `readOnlyHint`,
      `destructiveHint`, `idempotentHint`, `openWorldHint` (all optional bool)
- [ ] `registerRaw` accepts optional `annotations` parameter; MCP registration
      passes `tool.annotations` through
- [ ] `getToolMeta(expandedName)` exported from registry — reuses existing
      `baseName()` helper to resolve multi-action names
- [ ] `confirmBatch(calls)` in `src/agent/confirmation.ts` classifies calls,
      batches those needing approval, calls the provider, returns
      approved/denied partition
- [ ] `dispatchTools()` calls `confirmBatch()` before `Promise.allSettled`;
      `tool.called` emitted only for approved calls; denied calls get error tool
      messages pushed to state
- [ ] Denied tool message to LLM: `"Error: Tool call denied by operator."`
- [ ] Events `confirmation.requested` and `confirmation.resolved` emitted and
      typed in `EventMap`
- [ ] `web.ts` has `confirmIf: (call) => call.action === "scrape"` — every
      scrape requires confirmation
- [ ] CLI confirmation provider: readline prompt, default=approve (Enter),
      "n"=deny
- [ ] HTTP confirmation provider: `confirmation.requested` SSE event streamed
      to client, blocks until `POST /chat/:sessionId/confirm` resolves it or
      120 s timeout auto-denies
- [ ] `POST /chat/:sessionId/confirm` endpoint accepts
      `{ decisions: Record<string, "approve" | "deny"> }`, resolves the pending
      confirmation
- [ ] Non-streaming HTTP mode (`stream: false`) auto-approves all calls (no SSE
      channel for confirmation; documented as known limitation)
- [ ] No provider set → all calls auto-approve (null check, no prompt)
- [ ] If `provider.confirm()` throws, all pending calls are denied and the error
      is logged
- [ ] Pending confirmations cleaned up on `session.completed` / `session.failed`
- [ ] Sub-agent confirmations route through root session's event bus (events
      carry `rootAgentId` / `sessionId` from envelope)
- [ ] Tests cover: approval flow, denial flow, mixed batch, no-provider
      auto-approve, timeout auto-deny, provider-throws-deny

## Implementation plan

### 1. Extend `src/types/tool.ts`

Add `ToolAnnotations` interface and two optional fields to `ToolDefinition`:

```typescript
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// Add to ToolDefinition:
annotations?: ToolAnnotations;
confirmIf?: (call: { action: string; args: Record<string, unknown>; callId: string }) => boolean;
```

`action` is the action name for multi-action tools (e.g. `"scrape"`) or the
tool name for simple tools. This decouples `confirmIf` from the registry's
internal `__` naming convention.

### 2. Update `src/tools/registry.ts`

**a)** Update `registerRaw` signature — add optional `annotations` param. Store
on the `ToolDefinition` in the `handlers` map.

**b)** Add `getToolMeta(expandedName)` export. Reuse the existing private
`baseName()` helper (line 88) for multi-action name resolution:

```typescript
export interface ToolMeta {
  annotations?: ToolAnnotations;
  confirmIf?: ToolDefinition["confirmIf"];
}

export function getToolMeta(expandedName: string): ToolMeta | undefined {
  const direct = handlers.get(expandedName);
  if (direct) return { annotations: direct.annotations, confirmIf: direct.confirmIf };

  const base = baseName(expandedName);
  if (base !== expandedName) {
    const tool = handlers.get(base);
    if (tool) return { annotations: tool.annotations, confirmIf: tool.confirmIf };
  }
  return undefined;
}
```

### 3. Update `src/infra/mcp.ts`

In `registerTools()`, pass `tool.annotations` as the 5th arg to `registerRaw`.
Import `ToolAnnotations` from types.

### 4. Add `src/types/events.ts` confirmation events

```typescript
"confirmation.requested": {
  calls: Array<{ callId: string; toolName: string }>;
};
"confirmation.resolved": {
  approved: string[];
  denied: string[];
};
```

### 5. Create `src/agent/confirmation.ts`

Core module. Exports:

- `ConfirmationRequest` — `{ callId, toolName, args }`
- `ConfirmationProvider` — `{ confirm(requests): Promise<Map<string, "approve" | "deny">> }`
- `setConfirmationProvider(p)` / `clearConfirmationProvider()`
- `confirmBatch(calls: LLMToolCall[]): Promise<GateResult>`

The provider interface has **no `sessionId` parameter**. Session routing is the
provider's internal concern. The HTTP provider reads the session ID from
`AsyncLocalStorage` via `requireState().sessionId` (already available in
`src/agent/context.ts`). CLI provider doesn't need it.

```typescript
export interface ConfirmationProvider {
  confirm(requests: ConfirmationRequest[]): Promise<Map<string, "approve" | "deny">>;
}
```

Flow in `confirmBatch`:
1. No provider → return all approved
2. Classify each call via `getToolMeta(name).confirmIf`
   - For multi-action tools, extract action name from expanded name
   - Pass `{ action, args, callId }` to `confirmIf`
3. None flagged → return all approved
4. Build requests, emit `confirmation.requested`
5. `await provider.confirm(requests)` — wrapped in try/catch
6. If provider throws → log error, treat all pending calls as denied
7. Partition, emit `confirmation.resolved`
8. Missing callId in result → default deny

### 6. Modify `src/agent/loop.ts` — `dispatchTools()`

Move `tool.called` emissions and the confirmation gate so that `tool.called` is
only emitted for approved calls:

```typescript
const { approved, denied } = await confirmBatch(functionCalls);

// Denied calls: push error messages immediately
for (const { call, reason } of denied) {
  state.messages.push({
    role: "tool",
    toolCallId: call.id,
    content: "Error: Tool call denied by operator.",
  });
}

if (approved.length === 0) return;

// Emit tool.called only for approved calls
for (const tc of approved) {
  bus.emit("tool.called", { ... });
}

// Promise.allSettled over `approved` only
const settled = await Promise.allSettled(
  approved.map(async (tc) => { ... })
);
```

### 7. Add `confirmIf` to `src/tools/web.ts`

```typescript
export default {
  name: "web",
  schema: { ... },
  handler: web,
  confirmIf: (call) => call.action === "scrape",
} satisfies ToolDefinition;
```

### 8. Wire CLI provider in `src/cli.ts`

After `initMcpTools()`, register a readline-based provider:

```typescript
import { setConfirmationProvider } from "./agent/confirmation.ts";
import * as readline from "node:readline/promises";

setConfirmationProvider({
  async confirm(requests) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const results = new Map();
    try {
      console.log("\nTool confirmation required:");
      for (const req of requests) {
        console.log(`  Tool: ${req.toolName}`);
        console.log(`  Args: ${JSON.stringify(req.args, null, 2)}`);
        const answer = await rl.question("  Approve? [Y/n] ");
        results.set(req.callId, answer.trim().toLowerCase() === "n" ? "deny" : "approve");
      }
    } finally {
      rl.close();
    }
    return results;
  },
});
```

### 9. Wire HTTP provider in `src/server.ts`

One global provider registered at startup. Routes by session ID internally
using `requireState().sessionId` from `AsyncLocalStorage` context.

**a)** Pending-promise map with centralized cleanup:

```typescript
const pendingConfirmations = new Map<string, {
  resolve: (decisions: Map<string, "approve" | "deny">) => void;
  timeout: Timer;
}>();

function resolvePending(
  sessionId: string,
  decisions: Map<string, "approve" | "deny">,
): void {
  const pending = pendingConfirmations.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingConfirmations.delete(sessionId);
  pending.resolve(decisions);
}
```

**b)** Register one global HTTP provider at startup:

```typescript
setConfirmationProvider({
  async confirm(requests) {
    const { sessionId } = requireState();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const denied = new Map(requests.map(r => [r.callId, "deny" as const]));
        resolvePending(sessionId, denied);
      }, 120_000);

      pendingConfirmations.set(sessionId, { resolve, timeout });
    });
  },
});
```

**c)** Add `POST /chat/:sessionId/confirm` endpoint:

```typescript
app.post("/chat/:sessionId/confirm", async (c) => {
  const { sessionId } = c.req.param();
  const pending = pendingConfirmations.get(sessionId);
  if (!pending) {
    return c.json({ error: "No pending confirmation for this session" }, 404);
  }

  const body = await c.req.json();
  const decisions = new Map(Object.entries(body.decisions ?? {}));
  resolvePending(sessionId, decisions);

  return c.json({ status: "ok" });
});
```

**d)** Session lifecycle cleanup — listen for session end events to clean up
any orphaned pending confirmations:

```typescript
bus.on("session.completed", (e) => {
  const sid = e.sessionId;
  if (sid && pendingConfirmations.has(sid)) {
    const denied = new Map();
    resolvePending(sid, denied);
  }
});
bus.on("session.failed", (e) => {
  const sid = e.sessionId;
  if (sid && pendingConfirmations.has(sid)) {
    const denied = new Map();
    resolvePending(sid, denied);
  }
});
```

**e)** Non-streaming mode (`stream: false`): the global HTTP provider is active
but `requireState()` is available in both modes. For non-streaming callers the
`confirmation.requested` event has no SSE channel to reach the client, so the
120 s timeout will auto-deny. This is a known limitation — non-streaming
callers that need confirmation should use `stream: true`.

### 10. Sub-agent confirmation routing

Sub-agents spawned via `delegate` run in their own session context but share the
same event bus. The event envelope includes `sessionId`, `rootAgentId`, and
`parentAgentId`. The `confirmation.requested` event carries the sub-agent's
`sessionId`. The HTTP SSE subscriber already filters by `sessionId`, so the
client receives confirmation events only for sessions it subscribes to.

For sub-agents to get confirmations via HTTP, the client must subscribe to the
sub-agent's session SSE stream, or the sub-agent must inherit the parent's
`sessionId`. The current `delegate` tool creates a new session — so by default,
sub-agent confirmations will timeout and auto-deny in HTTP mode. This is
acceptable for V1 (safe default: deny if no human is watching).

CLI mode is unaffected — the global readline provider works regardless of which
agent triggers it.

## Testing scenarios

| Scenario | How to verify |
|---|---|
| CLI approve | `bun run agent "scrape example.com"` → prompt appears → press Enter → scrape executes |
| CLI deny | Same → type "n" → LLM sees "Tool call denied by operator.", adjusts |
| Mixed batch | Agent returns scrape + think → only scrape prompts, think auto-executes |
| No provider | Remove `setConfirmationProvider` call → scrape auto-approves |
| HTTP approve | POST /chat (stream:true) → SSE emits `confirmation.requested` → POST /confirm with approve → scrape executes |
| HTTP deny | Same → POST /confirm with deny → LLM sees denial |
| HTTP timeout | POST /chat (stream:true) → don't respond to confirmation → 120s → auto-denied |
| HTTP non-streaming | POST /chat (stream:false) → 120s timeout → auto-denied |
| Download no confirm | `bun run agent "download file"` → no prompt, executes immediately |
| Provider throws | Mock provider that throws → all calls denied, error logged |
| Session cleanup | Session fails mid-confirmation → pending entry cleaned up, no leak |
| Unit: confirmBatch no provider | `confirmBatch(calls)` with null provider → all approved |
| Unit: confirmBatch none flagged | Calls without confirmIf → all approved, provider never called |
| Unit: getToolMeta multi-action | `getToolMeta("web__scrape")` → returns web tool's metadata |
| Unit: confirmIf receives action | `confirmIf` called with `{ action: "scrape" }` not `"web__scrape"` |
