# Agent UI — Semantic Streaming Events Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic event streaming over SSE to the agent system, enabling a real-time web UI with full transparency into plan steps, tool calls, approvals, and logs.

**Architecture:** The agent emits events through an `EventEmittingLogger` (implementing the existing SP-33 `Logger` interface) into a buffered `AgentEventEmitter`. The server streams events via SSE. A SvelteKit frontend subscribes and renders them as interactive cards.

**Tech Stack:** Bun, Hono (SSE via `hono/streaming`), SvelteKit, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-17-agent-ui-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/types/events.ts` | `AgentEvent` discriminated union, `PlanStep`, `BaseEvent`, `makeEventId()`, `parsePlanSteps()` |
| `src/types/events.test.ts` | Tests for `parsePlanSteps()` and `makeEventId()` |
| `src/services/event-emitter.ts` | `AgentEventEmitter` — buffered pub/sub with approval gating |
| `src/services/event-emitter.test.ts` | Tests for emit/subscribe/replay, approval flow, timeout |
| `src/services/event-emitting-logger.ts` | `EventEmittingLogger implements Logger` — maps Logger calls to events |
| `src/services/event-emitting-logger.test.ts` | Tests for each Logger method → event mapping |
| `ui/` | SvelteKit frontend (Task 8) |

### Modified files

| File | Change |
|------|--------|
| `src/types/session.ts` | Add optional `emitter` field to `Session` |
| `src/services/session.ts` | Store emitter per session, add `getSessions()` method |
| `src/agent.ts` | Accept emitter, emit `session_start`/`session_end`/`approval_*` directly, wire `EventEmittingLogger` into `CompositeLogger` |
| `src/server.ts` | Add SSE, sessions, approve, logs routes; add `stream` flag to `/chat` |

---

## Task 1: Event Types

**Files:**
- Create: `src/types/events.ts`
- Create: `src/types/events.test.ts`

- [ ] **Step 1: Write tests for parsePlanSteps and makeEventId**

```typescript
// src/types/events.test.ts
import { describe, test, expect } from "bun:test";
import { parsePlanSteps, makeEventId } from "./events.ts";

describe("parsePlanSteps", () => {
  test("parses numbered steps with status markers", () => {
    const text = `1. [x] Download file from hub
2. [>] Parse the JSON response
3. [ ] Send answer to verify endpoint`;

    const steps = parsePlanSteps(text);
    expect(steps).toEqual([
      { index: 1, status: "done", text: "Download file from hub" },
      { index: 2, status: "current", text: "Parse the JSON response" },
      { index: 3, status: "pending", text: "Send answer to verify endpoint" },
    ]);
  });

  test("returns empty array for text without plan steps", () => {
    expect(parsePlanSteps("no steps here")).toEqual([]);
  });

  test("ignores non-matching lines", () => {
    const text = `Some intro text
1. [x] Real step
Not a step
2. [ ] Another step`;
    const steps = parsePlanSteps(text);
    expect(steps).toHaveLength(2);
  });
});

describe("makeEventId", () => {
  test("returns string starting with evt_", () => {
    const id = makeEventId();
    expect(id).toMatch(/^evt_\d+_\d+$/);
  });

  test("returns unique ids on successive calls", () => {
    const a = makeEventId();
    const b = makeEventId();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/types/events.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create event types and helpers**

```typescript
// src/types/events.ts

export interface PlanStep {
  index: number;
  status: "done" | "current" | "pending";
  text: string;
}

interface BaseEvent {
  id: string;
  timestamp: number;
}

export interface SessionStartEvent extends BaseEvent {
  type: "session_start";
  sessionId: string;
  prompt: string;
  assistant?: string;
}

export interface PlanStartEvent extends BaseEvent {
  type: "plan_start";
  iteration: number;
  model: string;
}

export interface PlanUpdateEvent extends BaseEvent {
  type: "plan_update";
  iteration: number;
  steps: PlanStep[];
  durationMs: number;
}

export interface ToolCallEvent extends BaseEvent {
  type: "tool_call";
  iteration: number;
  toolName: string;
  arguments: string;
  batchIndex: number;
  batchSize: number;
}

export interface ToolResultEvent extends BaseEvent {
  type: "tool_result";
  iteration: number;
  toolName: string;
  status: "ok" | "error";
  data: string;
  hints?: string[];
  durationMs: number;
}

export interface ThinkingEvent extends BaseEvent {
  type: "thinking";
  iteration: number;
  content: string;
}

export interface MessageEvent extends BaseEvent {
  type: "message";
  content: string;
}

export interface ErrorEvent extends BaseEvent {
  type: "error";
  message: string;
}

export interface TokenUsageEvent extends BaseEvent {
  type: "token_usage";
  iteration: number;
  phase: "plan" | "act";
  model: string;
  tokens: { prompt: number; completion: number };
  cumulative: { prompt: number; completion: number };
}

export interface SessionEndEvent extends BaseEvent {
  type: "session_end";
  sessionId: string;
  totalDurationMs: number;
  totalTokens: { prompt: number; completion: number };
}

export interface ApprovalRequestEvent extends BaseEvent {
  type: "approval_request";
  iteration: number;
  requestId: string;
  toolCalls: { toolName: string; arguments: string }[];
}

export interface ApprovalResponseEvent extends BaseEvent {
  type: "approval_response";
  requestId: string;
  approved: boolean;
  reason?: "user" | "timeout";
}

export type AgentEvent =
  | SessionStartEvent
  | PlanStartEvent
  | PlanUpdateEvent
  | ToolCallEvent
  | ToolResultEvent
  | ThinkingEvent
  | MessageEvent
  | ErrorEvent
  | TokenUsageEvent
  | SessionEndEvent
  | ApprovalRequestEvent
  | ApprovalResponseEvent;

let counter = 0;

export function makeEventId(): string {
  return `evt_${Date.now()}_${++counter}`;
}

export function parsePlanSteps(planText: string): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const line of planText.split("\n")) {
    const match = line.match(/^\s*(\d+)\.\s*\[(x|>|\s)]\s*(.+)/);
    if (match) {
      const marker = match[2];
      const status: PlanStep["status"] =
        marker === "x" ? "done" : marker === ">" ? "current" : "pending";
      steps.push({ index: steps.length + 1, status, text: match[3].trim() });
    }
  }
  return steps;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/types/events.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/types/events.ts src/types/events.test.ts
git commit -m "feat: add semantic event types for agent UI streaming"
```

---

## Task 2: Event Emitter

**Files:**
- Create: `src/services/event-emitter.ts`
- Create: `src/services/event-emitter.test.ts`

- [ ] **Step 1: Write tests for AgentEventEmitter**

```typescript
// src/services/event-emitter.test.ts
import { describe, test, expect, mock } from "bun:test";
import { AgentEventEmitter } from "./event-emitter.ts";
import type { AgentEvent } from "../types/events.ts";

function fakeEvent(type: string, extra: Record<string, unknown> = {}): AgentEvent {
  return { id: "evt_1", timestamp: Date.now(), type, ...extra } as AgentEvent;
}

describe("AgentEventEmitter", () => {
  test("emits events to listeners", () => {
    const emitter = new AgentEventEmitter();
    const received: AgentEvent[] = [];
    emitter.on((e) => received.push(e));

    const event = fakeEvent("message", { content: "hello" });
    emitter.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  test("replays buffered events on subscribe", () => {
    const emitter = new AgentEventEmitter();
    const e1 = fakeEvent("session_start", { sessionId: "s1", prompt: "hi" });
    const e2 = fakeEvent("message", { content: "bye" });
    emitter.emit(e1);
    emitter.emit(e2);

    const received: AgentEvent[] = [];
    emitter.on((e) => received.push(e));

    expect(received).toHaveLength(2);
    expect(received[0]).toBe(e1);
    expect(received[1]).toBe(e2);
  });

  test("off removes listener", () => {
    const emitter = new AgentEventEmitter();
    const received: AgentEvent[] = [];
    const listener = (e: AgentEvent) => received.push(e);
    emitter.on(listener);
    emitter.off(listener);

    emitter.emit(fakeEvent("message", { content: "ignored" }));
    // Only replayed events, no new ones
    expect(received).toHaveLength(0);
  });

  test("getBuffer returns all emitted events", () => {
    const emitter = new AgentEventEmitter();
    emitter.emit(fakeEvent("message", { content: "a" }));
    emitter.emit(fakeEvent("message", { content: "b" }));
    expect(emitter.getBuffer()).toHaveLength(2);
  });

  test("waitForApproval resolves when resolveApproval is called", async () => {
    const emitter = new AgentEventEmitter();
    const promise = emitter.waitForApproval("req1");
    const resolved = emitter.resolveApproval("req1", true);
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result).toEqual({ approved: true, reason: "user" });
  });

  test("resolveApproval emits ApprovalResponseEvent", async () => {
    const emitter = new AgentEventEmitter();
    const received: AgentEvent[] = [];
    emitter.on((e) => received.push(e));

    emitter.waitForApproval("req_emit");
    emitter.resolveApproval("req_emit", true);

    const response = received.find((e) => e.type === "approval_response") as any;
    expect(response).toBeDefined();
    expect(response.requestId).toBe("req_emit");
    expect(response.approved).toBe(true);
    expect(response.reason).toBe("user");
  });

  test("waitForApproval rejects on timeout and emits ApprovalResponseEvent", async () => {
    const emitter = new AgentEventEmitter();
    const received: AgentEvent[] = [];
    emitter.on((e) => received.push(e));

    const promise = emitter.waitForApproval("req2", 50); // 50ms timeout
    const result = await promise;
    expect(result).toEqual({ approved: false, reason: "timeout" });

    const response = received.find((e) => e.type === "approval_response") as any;
    expect(response).toBeDefined();
    expect(response.approved).toBe(false);
    expect(response.reason).toBe("timeout");
  });

  test("hasPendingApproval returns true when approval is pending", () => {
    const emitter = new AgentEventEmitter();
    expect(emitter.hasPendingApproval()).toBe(false);
    emitter.waitForApproval("req3");
    expect(emitter.hasPendingApproval()).toBe(true);
    emitter.resolveApproval("req3", true);
    expect(emitter.hasPendingApproval()).toBe(false);
  });

  test("resolveApproval returns false for unknown requestId", () => {
    const emitter = new AgentEventEmitter();
    expect(emitter.resolveApproval("nonexistent", true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/event-emitter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create AgentEventEmitter class**

```typescript
// src/services/event-emitter.ts
import type { AgentEvent } from "../types/events.ts";
import { makeEventId } from "../types/events.ts";

type Listener = (event: AgentEvent) => void;

export interface ApprovalResult {
  approved: boolean;
  reason: "user" | "timeout";
}

interface PendingApproval {
  resolve: (result: ApprovalResult) => void;
}

export class AgentEventEmitter {
  private listeners: Set<Listener> = new Set();
  private buffer: AgentEvent[] = [];
  private pendingApprovals = new Map<string, PendingApproval>();

  on(listener: Listener): void {
    for (const event of this.buffer) {
      listener(event);
    }
    this.listeners.add(listener);
  }

  off(listener: Listener): void {
    this.listeners.delete(listener);
  }

  emit(event: AgentEvent): void {
    this.buffer.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getBuffer(): readonly AgentEvent[] {
    return this.buffer;
  }

  hasPendingApproval(): boolean {
    return this.pendingApprovals.size > 0;
  }

  waitForApproval(
    requestId: string,
    timeoutMs = 60 * 60 * 1000,
  ): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApprovals.has(requestId)) {
          this.pendingApprovals.delete(requestId);
          const result: ApprovalResult = { approved: false, reason: "timeout" };
          // Emit ApprovalResponseEvent so SSE stream always reflects the outcome
          this.emit({
            id: makeEventId(),
            timestamp: Date.now(),
            type: "approval_response",
            requestId,
            approved: false,
            reason: "timeout",
          } as AgentEvent);
          resolve(result);
        }
      }, timeoutMs);

      this.pendingApprovals.set(requestId, {
        resolve: (result: ApprovalResult) => {
          clearTimeout(timer);
          resolve(result);
        },
      });
    });
  }

  resolveApproval(requestId: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    // Emit ApprovalResponseEvent so SSE stream always reflects the outcome
    this.emit({
      id: makeEventId(),
      timestamp: Date.now(),
      type: "approval_response",
      requestId,
      approved,
      reason: "user",
    } as AgentEvent);
    pending.resolve({ approved, reason: "user" });
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/event-emitter.test.ts`
Expected: PASS (all 10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/event-emitter.ts src/services/event-emitter.test.ts
git commit -m "feat: add AgentEventEmitter with buffered replay and approval gating"
```

---

## Task 3: EventEmittingLogger

**Files:**
- Create: `src/services/event-emitting-logger.ts`
- Create: `src/services/event-emitting-logger.test.ts`

**Context:** This class implements the SP-33 `Logger` interface (defined in `src/types/logger.ts`) and translates each Logger method call into an `AgentEvent` emission. It maintains internal mutable state for `iteration`, `model`, `batchSize`, `batchIndex`, and `cumulativeTokens` since the Logger signatures don't carry all fields needed by events.

**Important:** The `elapsed()` helper returns formatted strings like `"1.23s"`. This class must parse them back to milliseconds using a `parseElapsedMs()` helper.

- [ ] **Step 1: Write tests for EventEmittingLogger**

```typescript
// src/services/event-emitting-logger.test.ts
import { describe, test, expect } from "bun:test";
import { EventEmittingLogger } from "./event-emitting-logger.ts";
import { AgentEventEmitter } from "./event-emitter.ts";
import type { AgentEvent } from "../types/events.ts";

function collect(emitter: AgentEventEmitter): AgentEvent[] {
  const events: AgentEvent[] = [];
  emitter.on((e) => events.push(e));
  return events;
}

describe("EventEmittingLogger", () => {
  test("step() emits plan_start and sets internal iteration/model", () => {
    const emitter = new AgentEventEmitter();
    const logger = new EventEmittingLogger(emitter);
    const events = collect(emitter);

    logger.step(1, 20, "gpt-4.1", 5);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("plan_start");
    const e = events[0] as any;
    expect(e.iteration).toBe(1);
    expect(e.model).toBe("gpt-4.1");
  });

  test("plan() emits plan_update with parsed steps and token_usage", () => {
    const emitter = new AgentEventEmitter();
    const logger = new EventEmittingLogger(emitter);
    const events = collect(emitter);

    logger.step(1, 20, "gpt-4.1", 5);
    events.length = 0; // clear step event

    const planText = "1. [x] Step one\n2. [>] Step two";
    logger.plan(planText, "gpt-4.1", "1.23s", 100, 50);

    expect(events.some((e) => e.type === "plan_update")).toBe(true);
    const update = events.find((e) => e.type === "plan_update") as any;
    expect(update.steps).toHaveLength(2);
    expect(update.steps[0].status).toBe("done");
    expect(update.durationMs).toBe(1230);

    expect(events.some((e) => e.type === "token_usage")).toBe(true);
    const usage = events.find((e) => e.type === "token_usage") as any;
    expect(usage.phase).toBe("plan");
    expect(usage.tokens.prompt).toBe(100);
  });

  test("toolHeader + toolCall emit tool_call events with batch info", () => {
    const emitter = new AgentEventEmitter();
    const logger = new EventEmittingLogger(emitter);
    const events = collect(emitter);

    logger.step(1, 20, "gpt-4.1", 5);
    events.length = 0;

    logger.toolHeader(3);
    logger.toolCall("web__fetch", '{"url":"https://example.com"}');
    logger.toolCall("think", '{"prompt":"analyze"}');

    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(2);
    expect((toolCalls[0] as any).batchIndex).toBe(1);
    expect((toolCalls[0] as any).batchSize).toBe(3);
    expect((toolCalls[1] as any).batchIndex).toBe(2);
  });

  test("toolOk emits tool_result with status ok", () => {
    const emitter = new AgentEventEmitter();
    const logger = new EventEmittingLogger(emitter);
    const events = collect(emitter);

    logger.step(1, 20, "gpt-4.1", 5);
    events.length = 0;

    logger.toolOk("web__fetch", "0.45s", '{"data":"result"}', ["Check the file"]);

    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.status).toBe("ok");
    expect(result.toolName).toBe("web__fetch");
    expect(result.durationMs).toBe(450);
    expect(result.hints).toEqual(["Check the file"]);
  });

  test("toolErr emits tool_result with status error and durationMs 0", () => {
    const emitter = new AgentEventEmitter();
    const logger = new EventEmittingLogger(emitter);
    const events = collect(emitter);

    logger.step(1, 20, "gpt-4.1", 5);
    events.length = 0;

    logger.toolErr("bash", "command not found");

    const result = events.find((e) => e.type === "tool_result") as any;
    expect(result.status).toBe("error");
    expect(result.durationMs).toBe(0);
    expect(result.data).toContain("command not found");
  });

  test("answer() emits message event", () => {
    const emitter = new AgentEventEmitter();
    const logger = new EventEmittingLogger(emitter);
    const events = collect(emitter);

    logger.answer("The answer is 42");

    const msg = events.find((e) => e.type === "message") as any;
    expect(msg.content).toBe("The answer is 42");
  });

  test("llm() emits token_usage with phase act", () => {
    const emitter = new AgentEventEmitter();
    const logger = new EventEmittingLogger(emitter);
    const events = collect(emitter);

    logger.step(2, 20, "gpt-4.1", 10);
    events.length = 0;

    logger.llm("0.80s", 200, 100);

    const usage = events.find((e) => e.type === "token_usage") as any;
    expect(usage.phase).toBe("act");
    expect(usage.iteration).toBe(2);
    expect(usage.tokens.prompt).toBe(200);
  });

  test("maxIter() emits error event", () => {
    const emitter = new AgentEventEmitter();
    const logger = new EventEmittingLogger(emitter);
    const events = collect(emitter);

    logger.maxIter(20);

    const err = events.find((e) => e.type === "error") as any;
    expect(err.message).toContain("20");
  });

  test("info/success/error/debug are no-ops (no events emitted)", () => {
    const emitter = new AgentEventEmitter();
    const logger = new EventEmittingLogger(emitter);
    const events = collect(emitter);

    logger.info("info msg");
    logger.success("ok msg");
    logger.error("err msg");
    logger.debug("dbg msg");

    expect(events).toHaveLength(0);
  });

  test("getCumulativeTokens returns accumulated tokens", () => {
    const emitter = new AgentEventEmitter();
    const logger = new EventEmittingLogger(emitter);

    logger.step(1, 20, "gpt-4.1", 5);
    logger.plan("1. [x] test", "gpt-4.1", "1.0s", 100, 50);
    logger.llm("0.5s", 200, 100);

    const total = logger.getCumulativeTokens();
    expect(total.prompt).toBe(300);
    expect(total.completion).toBe(150);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/services/event-emitting-logger.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create EventEmittingLogger**

```typescript
// src/services/event-emitting-logger.ts
import type { Logger } from "../types/logger.ts";
import type { AgentEventEmitter } from "./event-emitter.ts";
import { makeEventId, parsePlanSteps } from "../types/events.ts";
import type { AgentEvent } from "../types/events.ts";

function parseElapsedMs(elapsed: string): number {
  const match = elapsed.match(/^([\d.]+)s$/);
  return match ? Math.round(parseFloat(match[1]) * 1000) : 0;
}

export class EventEmittingLogger implements Logger {
  private currentIteration = 0;
  private currentModel = "";
  private batchSize = 0;
  private batchIndex = 0;
  private cumulativeTokens = { prompt: 0, completion: 0 };

  constructor(private emitter: AgentEventEmitter) {}

  private emit(partial: Record<string, unknown> & { type: string }): void {
    this.emitter.emit({
      id: makeEventId(),
      timestamp: Date.now(),
      ...partial,
    } as AgentEvent);
  }

  step(iter: number, _max: number, model: string, _msgCount: number): void {
    this.currentIteration = iter;
    this.currentModel = model;
    this.emit({ type: "plan_start", iteration: iter, model });
  }

  plan(
    planText: string,
    model: string,
    elapsed: string,
    tokensIn?: number,
    tokensOut?: number,
  ): void {
    const durationMs = parseElapsedMs(elapsed);
    const steps = parsePlanSteps(planText);
    this.emit({
      type: "plan_update",
      iteration: this.currentIteration,
      steps,
      durationMs,
    });

    if (tokensIn !== undefined || tokensOut !== undefined) {
      const prompt = tokensIn ?? 0;
      const completion = tokensOut ?? 0;
      this.cumulativeTokens.prompt += prompt;
      this.cumulativeTokens.completion += completion;
      this.emit({
        type: "token_usage",
        iteration: this.currentIteration,
        phase: "plan",
        model,
        tokens: { prompt, completion },
        cumulative: { ...this.cumulativeTokens },
      });
    }
  }

  toolHeader(count: number): void {
    this.batchSize = count;
    this.batchIndex = 0;
  }

  toolCall(name: string, rawArgs: string): void {
    this.batchIndex++;
    this.emit({
      type: "tool_call",
      iteration: this.currentIteration,
      toolName: name,
      arguments: rawArgs,
      batchIndex: this.batchIndex,
      batchSize: this.batchSize,
    });
  }

  toolOk(
    name: string,
    elapsed: string,
    rawResult: string,
    hints?: string[],
  ): void {
    this.emit({
      type: "tool_result",
      iteration: this.currentIteration,
      toolName: name,
      status: "ok",
      data: rawResult,
      hints,
      durationMs: parseElapsedMs(elapsed),
    });
  }

  toolErr(name: string, errorMsg: string): void {
    this.emit({
      type: "tool_result",
      iteration: this.currentIteration,
      toolName: name,
      status: "error",
      data: errorMsg,
      durationMs: 0,
    });
  }

  batchDone(_count: number, _elapsed: string): void {
    // No separate event — derivable from tool_results
  }

  answer(text: string | null): void {
    this.emit({ type: "message", content: text ?? "" });
  }

  llm(elapsed: string, tokensIn?: number, tokensOut?: number): void {
    const prompt = tokensIn ?? 0;
    const completion = tokensOut ?? 0;
    this.cumulativeTokens.prompt += prompt;
    this.cumulativeTokens.completion += completion;
    this.emit({
      type: "token_usage",
      iteration: this.currentIteration,
      phase: "act",
      model: this.currentModel,
      tokens: { prompt, completion },
      cumulative: { ...this.cumulativeTokens },
    });
  }

  maxIter(max: number): void {
    this.emit({
      type: "error",
      message: `Max iterations reached (${max}). Stopping agent loop.`,
    });
  }

  // Operational logging — no-op for event emission
  info(_message: string): void {}
  success(_message: string): void {}
  error(_message: string): void {}
  debug(_message: string): void {}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/services/event-emitting-logger.test.ts`
Expected: PASS (all 10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/services/event-emitting-logger.ts src/services/event-emitting-logger.test.ts
git commit -m "feat: add EventEmittingLogger — maps Logger interface to AgentEvents"
```

---

## Task 4: Session Extension

**Files:**
- Modify: `src/types/session.ts`
- Modify: `src/services/session.ts`
- Modify: `src/services/session.test.ts`

- [ ] **Step 1: Add emitter field to Session type**

In `src/types/session.ts`, add the optional `emitter` field. Import `AgentEventEmitter` type.

```typescript
// Add to imports
import type { AgentEventEmitter } from "../services/event-emitter.ts";

// Add emitter to Session interface
export interface Session {
  id: string;
  assistant?: string;
  messages: LLMMessage[];
  emitter?: AgentEventEmitter;
  createdAt: Date;
  updatedAt: Date;
}
```

- [ ] **Step 2: Add getSessions() method to session service**

In `src/services/session.ts`, add `getSessions()` as a new method on the returned object from `createSessionService()`, after the `_clear()` method:

```typescript
getSessions(): { id: string; ended: boolean; hasPendingApproval: boolean; eventCount: number }[] {
  const list = [];
  for (const [id, session] of sessions) {
    const emitter = session.emitter;
    if (!emitter) {
      list.push({ id, ended: true, hasPendingApproval: false, eventCount: 0 });
      continue;
    }
    const buf = emitter.getBuffer();
    const last = buf[buf.length - 1];
    const ended = last?.type === "session_end";
    const hasPendingApproval = emitter.hasPendingApproval();
    list.push({ id, ended, hasPendingApproval, eventCount: buf.length });
  }
  return list;
},
```

Note: Uses the `hasPendingApproval()` method added to `AgentEventEmitter` in Task 2, avoiding error-prone buffer scanning.

- [ ] **Step 3: Write tests for getSessions()**

```typescript
// Add to src/services/session.test.ts
import { AgentEventEmitter } from "./event-emitter.ts";
import { makeEventId } from "../types/events.ts";
import type { AgentEvent } from "../types/events.ts";

describe("getSessions", () => {
  test("returns empty list when no sessions exist", () => {
    sessionService._clear();
    expect(sessionService.getSessions()).toEqual([]);
  });

  test("returns session without emitter as ended", () => {
    sessionService._clear();
    sessionService.getOrCreate("s1");
    const list = sessionService.getSessions();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ id: "s1", ended: true, hasPendingApproval: false, eventCount: 0 });
  });

  test("returns session with emitter showing event count and ended status", () => {
    sessionService._clear();
    const session = sessionService.getOrCreate("s2");
    const emitter = new AgentEventEmitter();
    session.emitter = emitter;
    emitter.emit({ id: makeEventId(), timestamp: Date.now(), type: "message", content: "hi" } as AgentEvent);
    emitter.emit({ id: makeEventId(), timestamp: Date.now(), type: "session_end", sessionId: "s2", totalDurationMs: 100, totalTokens: { prompt: 0, completion: 0 } } as AgentEvent);
    const list = sessionService.getSessions();
    expect(list[0].ended).toBe(true);
    expect(list[0].eventCount).toBe(2);
  });
});
```

- [ ] **Step 4: Run tests to ensure they pass**

Run: `bun test src/services/session.test.ts`
Expected: PASS (existing + new tests)

- [ ] **Step 5: Commit**

```bash
git add src/types/session.ts src/services/session.ts src/services/session.test.ts
git commit -m "feat: extend Session with optional emitter, add getSessions()"
```

---

## Task 5: Agent Integration

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/services/event-emitting-logger.ts` (add `getCumulativeTokens()`)
- Create: `src/agent.test.ts`

**Context:** The agent currently creates a `CompositeLogger([ConsoleLogger, MarkdownLogger])` at lines 30-32. We add `EventEmittingLogger` as a third target. The agent also emits `session_start`, `session_end`, `thinking`, and `approval_*` events directly on the emitter. The emitter is passed via a new optional parameter. When absent, a no-op emitter is created internally so events always flow regardless of entry point.

- [ ] **Step 1: Add emitter import and parameter to runAgent()**

In `src/agent.ts`, add imports:

```typescript
// Add to imports
import { AgentEventEmitter } from "./services/event-emitter.ts";
import { EventEmittingLogger } from "./services/event-emitting-logger.ts";
import { makeEventId } from "./types/events.ts";
import type { AgentEvent } from "./types/events.ts";
```

Extend the `options` parameter type:

```typescript
options?: {
  model?: string;
  sessionId?: string;
  toolFilter?: ToolFilter;
  emitter?: AgentEventEmitter;  // NEW
}
```

- [ ] **Step 2: Wire EventEmittingLogger into CompositeLogger**

Replace the logger initialization block (currently lines 30-32):

```typescript
const emitter = options?.emitter ?? new AgentEventEmitter();
const md = new MarkdownLogger({ sessionId: options?.sessionId });
md.init(typeof userPrompt === "string" ? userPrompt : "(structured)");
const eventLogger = new EventEmittingLogger(emitter);
const log = new CompositeLogger([new ConsoleLogger(), md, eventLogger]);
```

- [ ] **Step 3: Add getCumulativeTokens() to EventEmittingLogger**

In `src/services/event-emitting-logger.ts`, add a public getter:

```typescript
getCumulativeTokens(): { prompt: number; completion: number } {
  return { ...this.cumulativeTokens };
}
```

- [ ] **Step 4: Emit session_start at the beginning of runAgent()**

After logger initialization, before the loop. Also declare timing variable:

```typescript
const sessionStart = performance.now();
const sid = options?.sessionId ?? md.sessionId;

emitter.emit({
  id: makeEventId(),
  timestamp: Date.now(),
  type: "session_start",
  sessionId: sid,
  prompt: typeof userPrompt === "string" ? userPrompt : "(structured)",
} as AgentEvent);
```

- [ ] **Step 5: Emit thinking event when LLM returns text alongside tool calls**

After the act-phase LLM response (after `log.llm(...)` call), before pushing the assistant message to `messages`, add:

```typescript
if (response.content && response.toolCalls.length > 0) {
  emitter.emit({
    id: makeEventId(),
    timestamp: Date.now(),
    type: "thinking",
    iteration: i + 1,
    content: response.content,
  } as AgentEvent);
}
```

- [ ] **Step 6: Add approval gating before tool execution**

After `log.toolCall()` loop and before `Promise.allSettled(...)` for tool execution, add:

```typescript
// Request user approval before executing tools
const requestId = `approve_${sid}_${i + 1}`;
emitter.emit({
  id: makeEventId(),
  timestamp: Date.now(),
  type: "approval_request",
  iteration: i + 1,
  requestId,
  toolCalls: functionCalls.map((tc) => ({
    toolName: tc.function.name,
    arguments: tc.function.arguments,
  })),
} as AgentEvent);

const approvalResult = await emitter.waitForApproval(requestId);
// Note: emitter.resolveApproval() and timeout both emit ApprovalResponseEvent automatically

if (!approvalResult.approved) {
  const reason = approvalResult.reason === "timeout"
    ? "Approval timed out (no response within 1 hour)."
    : "User rejected this tool call.";
  for (const tc of functionCalls) {
    messages.push({
      role: "tool",
      toolCallId: tc.id,
      content: JSON.stringify({ error: reason }),
    });
  }
  continue;
}
```

- [ ] **Step 7: Add session_end emission helper and wire it to all exit points**

Create a helper at the top of `runAgent()` (after the `sessionStart` declaration from Step 4):

```typescript
const emitSessionEnd = () => {
  emitter.emit({
    id: makeEventId(),
    timestamp: Date.now(),
    type: "session_end",
    sessionId: sid,
    totalDurationMs: Math.round(performance.now() - sessionStart),
    totalTokens: eventLogger.getCumulativeTokens(),
  } as AgentEvent);
};
```

Call `emitSessionEnd()` before each `return` statement:
- Before `return response.content ?? ""` (final answer)
- Before `return ""` (max iterations)
- Wrap the entire loop in try/catch and call `emitSessionEnd()` in `finally`

- [ ] **Step 8: Write basic agent integration test**

Note: `runAgent()` internally calls `promptService.load()`, `getTools()`, and `assistants.get()`. These must be mocked before importing `agent.ts`, following the same pattern used in `server.test.ts`.

```typescript
// src/agent.test.ts
import { describe, test, expect, mock } from "bun:test";
import { AgentEventEmitter } from "./services/event-emitter.ts";
import type { AgentEvent } from "./types/events.ts";

// Mock dependencies before importing agent
mock.module("./services/prompt.ts", () => ({
  promptService: {
    load: async (name: string, vars?: Record<string, string>) => ({
      model: "test-model",
      content: "You are a test agent.",
      temperature: 0.7,
    }),
  },
}));

mock.module("./tools/index.ts", () => ({
  getTools: async () => [],
  dispatch: async () => '{"status":"ok","data":"mock"}',
}));

mock.module("./services/assistants.ts", () => ({
  assistants: {
    get: async () => ({
      name: "default",
      objective: "test",
      tone: "test",
      model: "test-model",
    }),
  },
}));

const { runAgent } = await import("./agent.ts");

describe("agent event integration", () => {
  test("emitter receives session_start and session_end when provided", async () => {
    const emitter = new AgentEventEmitter();
    const events: AgentEvent[] = [];
    emitter.on((e) => events.push(e));

    // Mock LLM provider that returns a final answer immediately (no tool calls)
    const mockProvider = {
      chatCompletion: mock(() =>
        Promise.resolve({
          content: "Test answer",
          toolCalls: [],
          finishReason: "stop" as const,
          usage: { promptTokens: 10, completionTokens: 5 },
        }),
      ),
    };

    await runAgent(
      [{ role: "system", content: "test" }, { role: "user", content: "hello" }],
      mockProvider as any,
      { emitter },
    );

    const types = events.map((e) => e.type);
    expect(types).toContain("session_start");
    expect(types).toContain("session_end");
    expect(types[0]).toBe("session_start");
    expect(types[types.length - 1]).toBe("session_end");
  });
});
```

- [ ] **Step 9: Run all tests to ensure no regressions**

Run: `bun test`
Expected: PASS — all existing tests still pass. The emitter is optional so CLI behavior is unchanged.

- [ ] **Step 10: Commit**

```bash
git add src/agent.ts src/agent.test.ts src/services/event-emitting-logger.ts
git commit -m "feat: wire EventEmittingLogger into agent loop, emit lifecycle and approval events"
```

---

## Task 6: Server Routes

**Files:**
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

**Context:** Add five new routes and modify the existing `POST /chat` to support the `stream` flag and optional `sessionId`. Reference `playground/semantic_events/semantic_events.ts` for the SSE implementation pattern using `streamSSE` from `hono/streaming`.

**Key design decision:** When `stream: true`, `POST /chat` returns `{ sessionId }` as JSON (not SSE). The client then connects separately to `GET /events/:sessionId` for the SSE stream. This two-step approach avoids the problem of trying to parse SSE as JSON.

- [ ] **Step 1: Add imports**

```typescript
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { AgentEventEmitter } from "./services/event-emitter.ts";
import type { AgentEvent } from "./types/events.ts";
```

- [ ] **Step 2: Make sessionId optional in POST /chat**

Replace the current sessionId validation (lines 30-38 of `src/server.ts`) to auto-generate when missing:

```typescript
// sessionId is optional — generate UUID v4 if not provided
const sessionId: string = typeof body.sessionId === "string" ? body.sessionId
  : typeof body.sessionID === "string" ? body.sessionID
  : randomUUID();
```

Remove the `if (!sessionId)` error block entirely.

- [ ] **Step 3: Add GET /sessions route**

```typescript
app.get("/sessions", (c) => {
  return c.json({ sessions: sessionService.getSessions() });
});
```

- [ ] **Step 4: Add GET /events/:sessionId SSE route**

Follow the pattern from `playground/semantic_events/semantic_events.ts`:

```typescript
app.get("/events/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessionService.getOrCreate(sessionId);
  const emitter = session.emitter;

  if (!emitter) {
    return c.json({ error: "session has no active emitter" }, 404);
  }

  return streamSSE(c, async (stream) => {
    let closed = false;

    const listener = (event: AgentEvent) => {
      if (closed) return;
      stream.writeSSE({
        event: "agent_event",
        data: JSON.stringify(event),
        id: event.id,
      }).catch(() => { closed = true; });
    };

    emitter.on(listener);

    const heartbeat = setInterval(() => {
      if (closed) return;
      stream.writeSSE({ event: "heartbeat", data: "" })
        .catch(() => { closed = true; });
    }, 5000);

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const buf = emitter.getBuffer();
        const last = buf[buf.length - 1];
        if (last?.type === "session_end" || closed) {
          clearInterval(check);
          resolve();
        }
      }, 200);

      stream.onAbort(() => {
        closed = true;
        clearInterval(check);
        resolve();
      });
    });

    clearInterval(heartbeat);
    emitter.off(listener);
  });
});
```

- [ ] **Step 5: Add POST /approve/:sessionId route**

```typescript
app.post("/approve/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const session = sessionService.getOrCreate(sessionId);
  const emitter = session.emitter;

  if (!emitter) {
    return c.json({ error: "session not found" }, 404);
  }

  const body = await c.req.json<{ requestId?: string; approved?: boolean }>();
  if (!body?.requestId || typeof body.approved !== "boolean") {
    return c.json({ error: "requestId and approved (boolean) are required" }, 400);
  }

  const resolved = emitter.resolveApproval(body.requestId, body.approved);
  if (!resolved) {
    return c.json({ error: "no pending approval with that requestId" }, 404);
  }

  return c.json({ status: "ok" });
});
```

- [ ] **Step 6: Add GET /logs and GET /logs/:date/:sid/:file routes**

Use `readdir` from `node:fs/promises` (async) and `Bun.file()` for reading log file contents. Validate path components to prevent directory traversal.

```typescript
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

app.get("/logs", async (c) => {
  const logsDir = config.paths.logsDir;
  try {
    const entries = await readdir(logsDir);
    const dates: string[] = [];
    for (const d of entries) {
      const s = await stat(join(logsDir, d)).catch(() => null);
      if (s?.isDirectory()) dates.push(d);
    }
    dates.sort().reverse();

    const tree = await Promise.all(dates.map(async (date) => {
      const datePath = join(logsDir, date);
      const sessionEntries = await readdir(datePath);
      const sessions = await Promise.all(
        sessionEntries.map(async (sid) => {
          const sessionPath = join(datePath, sid);
          const s = await stat(sessionPath).catch(() => null);
          if (!s?.isDirectory()) return null;
          const allFiles = await readdir(sessionPath);
          const files = allFiles.filter((f) => f.endsWith(".md"));
          return { sessionId: sid, files };
        }),
      );
      return { date, sessions: sessions.filter(Boolean) };
    }));

    return c.json({ logs: tree });
  } catch {
    return c.json({ logs: [] });
  }
});

app.get("/logs/:date/:sid/:file", async (c) => {
  const { date, sid, file } = c.req.param();

  // Validate path components to prevent traversal
  const safePattern = /^[a-zA-Z0-9_\-\.]+$/;
  if (!safePattern.test(date) || !safePattern.test(sid) || !safePattern.test(file)) {
    return c.json({ error: "invalid path" }, 400);
  }

  const filePath = join(config.paths.logsDir, date, sid, file);
  try {
    const content = await Bun.file(filePath).text();
    return c.text(content);
  } catch {
    return c.json({ error: "file not found" }, 404);
  }
});
```

- [ ] **Step 7: Modify POST /chat to support stream flag**

**Handler restructuring required:** The current `POST /chat` handler resolves the assistant inside `sessionService.enqueue()`. To support stream mode, move assistant resolution **before** the stream fork so `resolved` is available to both paths. Restructure the handler body as follows:

1. Parse `sessionId` and `msg` (already done)
2. `getOrCreate(sessionId)` the session
3. Resolve assistant (move the entire assistant pinning + resolveAssistant block outside of `enqueue`)
4. Set up system prompt if first interaction
5. Append user message
6. Create emitter, attach to session
7. Fork on `stream` flag

```typescript
const stream = body.stream === true;

// --- Everything below runs INSIDE the try block, BEFORE enqueue ---
const session = sessionService.getOrCreate(sessionId);

// Determine assistant (existing logic — moved from inside enqueue)
let assistantName: string;
if (session.assistant) {
  assistantName = session.assistant;
  if (requestedAssistant && requestedAssistant !== session.assistant) {
    log.info(`/chat [${sessionId}]: ignoring assistant="${requestedAssistant}", session pinned to "${session.assistant}"`);
  }
} else {
  assistantName = requestedAssistant ?? "default";
}

let resolved;
try {
  resolved = await resolveAssistant(assistantName);
} catch (err) {
  if (err instanceof Error && err.message.includes("Unknown assistant")) {
    return c.json({ error: err.message }, 400);
  }
  throw err;
}

if (!session.assistant) session.assistant = assistantName;
if (session.messages.length === 0) {
  sessionService.appendMessage(sessionId, { role: "system", content: resolved.prompt });
}
sessionService.appendMessage(sessionId, { role: "user", content: msg });

// Always create emitter, attach to session
const emitter = new AgentEventEmitter();
session.emitter = emitter;

// Helper: run agent and persist messages
const runAndPersist = async () => {
  const messages: LLMMessage[] = [...session.messages];
  const result = await runAgent(messages, undefined, {
    model: resolved.model,
    sessionId,
    toolFilter: resolved.toolFilter,
    emitter,
  });
  const newMessages = messages.slice(session.messages.length);
  for (const m of newMessages) {
    sessionService.appendMessage(sessionId, m);
  }
  return result;
};

if (stream) {
  // Start agent in background — don't await
  sessionService.enqueue(sessionId, runAndPersist).catch((err) => {
    log.error(`Agent error [${sessionId}]: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Return sessionId immediately — client connects to GET /events/:sessionId
  return c.json({ sessionId });
}

// Sync path (stream: false, default)
const answer = await sessionService.enqueue(sessionId, runAndPersist);
return c.json({ msg: answer, sessionId });
```

- [ ] **Step 8: Write tests for new server routes**

Add to `src/server.test.ts`. Use the existing `request()` helper (which wraps `server.fetch(new Request(...))`) — NOT `app.request()`, since `app` is not exported:

```typescript
describe("GET /sessions", () => {
  it("returns empty sessions list initially", async () => {
    const res = await request("/sessions");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessions).toEqual([]);
  });
});

describe("POST /chat with optional sessionId", () => {
  it("auto-generates sessionId when not provided", async () => {
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg: "hello" }),
    });
    // Should succeed (not 400) — sessionId is auto-generated
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.msg).toBeDefined();
  });
});

describe("POST /chat with stream flag", () => {
  it("returns sessionId immediately when stream: true", async () => {
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg: "hello", stream: true, sessionId: "test-stream" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessionId).toBe("test-stream");
    // Note: msg is NOT present (agent runs in background)
    expect(json.msg).toBeUndefined();
  });
});

describe("POST /approve/:sessionId", () => {
  it("returns 400 when requestId or approved missing", async () => {
    const res = await request("/approve/some-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /chat sessionId in response", () => {
  it("returns sessionId in sync response", async () => {
    const res = await request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg: "hello", sessionId: "explicit-id" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.sessionId).toBe("explicit-id");
  });
});

describe("GET /events/:sessionId", () => {
  it("returns 404 when session has no emitter", async () => {
    sessionService.getOrCreate("no-emitter-session");
    const res = await request("/events/no-emitter-session");
    expect(res.status).toBe(404);
  });
});

describe("GET /logs", () => {
  it("returns logs tree", async () => {
    const res = await request("/logs");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.logs).toBeDefined();
  });
});
```

- [ ] **Step 9: Run all server tests**

Run: `bun test src/server.test.ts`
Expected: PASS — existing + new tests

- [ ] **Step 10: Commit**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: add SSE streaming, sessions, approve, logs routes to server"
```

---

## Task 7: CLI --stream Flag

**Files:**
- Modify: `src/agent.ts` (CLI entry point at the bottom of the file)

**Context:** The CLI entry point (`if (import.meta.main)` block, lines 188-224) uses `extractFlag()` for `--session` and `--model`, then resolves the assistant via `assistants.get(assistantName)`. The tool filter comes from `assistant.tools` (not `resolved.toolFilter` — that variable doesn't exist in CLI scope).

- [ ] **Step 1: Parse --stream flag in CLI entry point**

In the CLI section, add `--stream` parsing. Since `--stream` is a boolean flag (no value), use a direct check and splice, similar to how `extractFlag` works but without a value:

```typescript
// Add after const modelOverride = extractFlag(args, "--model");
const streamFlag = args.includes("--stream");
if (streamFlag) {
  args.splice(args.indexOf("--stream"), 1);
}
```

- [ ] **Step 2: When --stream is set, create emitter and pass to runAgent**

Replace the existing `void runAgent(...)` call (line 219) with:

```typescript
if (streamFlag) {
  const emitter = new AgentEventEmitter();
  // ConsoleLogger inside runAgent already handles terminal output.
  // Passing the emitter enables event buffering + session_start/session_end emission.
  void runAgent(messages, undefined, {
    model: agentModel,
    sessionId,
    toolFilter: assistant.tools,
    emitter,
  });
} else {
  void runAgent(messages, undefined, {
    model: agentModel,
    sessionId,
    toolFilter: assistant.tools,
  });
}
```

Note: Uses `assistant.tools` (from `assistants.get()`) not `resolved.toolFilter`. Uses `agentModel` (already computed on line 213).

- [ ] **Step 3: Verify CLI works with and without --stream**

Run: `bun run agent "What is 2+2?"` — should work as before
Run: `bun run agent "What is 2+2?" --stream` — should work identically (ConsoleLogger shows output; emitter enables event lifecycle)

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts
git commit -m "feat: add --stream CLI flag for real-time event output"
```

---

## Task 8: SvelteKit Frontend Setup

**Files:**
- Create: `ui/` directory with SvelteKit scaffold

**Note:** This task scaffolds the frontend. Due to the scope of individual Svelte components, each component's implementation is a follow-up step within this task.

- [ ] **Step 1: Scaffold SvelteKit project**

```bash
cd /Users/jakubpruszynski/WebstormProjects/aidevs4
bunx sv create ui --template minimal --types ts --no-add-ons --no-install
cd ui && bun install
bun add -d @sveltejs/adapter-static
```

- [ ] **Step 2: Configure Vite proxy for backend**

In `ui/vite.config.ts`:

```typescript
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    proxy: {
      "/chat": "http://localhost:3000",
      "/events": "http://localhost:3000",
      "/sessions": "http://localhost:3000",
      "/approve": "http://localhost:3000",
      "/logs": "http://localhost:3000",
      "/health": "http://localhost:3000",
    },
  },
});
```

- [ ] **Step 3: Create shared types re-export**

```typescript
// ui/src/lib/types.ts
// Re-export event types from backend
// Note: uses relative path — SvelteKit resolves via tsconfig paths
export type {
  AgentEvent,
  PlanStep,
  SessionStartEvent,
  PlanStartEvent,
  PlanUpdateEvent,
  ToolCallEvent,
  ToolResultEvent,
  ThinkingEvent,
  MessageEvent,
  ErrorEvent,
  TokenUsageEvent,
  SessionEndEvent,
  ApprovalRequestEvent,
  ApprovalResponseEvent,
} from "../../../src/types/events.ts";
```

- [ ] **Step 4: Create SSE client utility**

The SSE client uses a two-step flow:
1. `sendPrompt()` sends `POST /chat` with `stream: true` → server returns `{ sessionId }` as JSON and starts the agent in the background
2. Caller then connects to `GET /events/:sessionId` via `connectToSession()` for the SSE stream

This avoids the trap of trying to parse an SSE stream as JSON.

```typescript
// ui/src/lib/sse.ts
import type { AgentEvent } from "./types";

export function connectToSession(
  sessionId: string,
  onEvent: (event: AgentEvent) => void,
  onError?: () => void,
): EventSource {
  const source = new EventSource(`/events/${sessionId}`);

  source.addEventListener("agent_event", (e) => {
    const parsed: AgentEvent = JSON.parse((e as MessageEvent).data);
    onEvent(parsed);
  });

  source.onerror = () => {
    source.close();
    onError?.();
  };

  return source;
}

/**
 * Sends a prompt to the server with stream: true.
 * Returns the sessionId — caller should then connect via connectToSession().
 * The server returns { sessionId } as JSON and starts the agent in the background.
 */
export async function sendPrompt(
  prompt: string,
  options?: { assistant?: string; sessionId?: string },
): Promise<string> {
  const res = await fetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msg: prompt,
      stream: true,
      ...options,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "request failed" }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }

  const body = await res.json();
  return body.sessionId;
}

export async function sendApproval(
  sessionId: string,
  requestId: string,
  approved: boolean,
): Promise<void> {
  await fetch(`/approve/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, approved }),
  });
}

/** Store/retrieve last active session for reconnection on page reload */
export function saveActiveSession(sessionId: string): void {
  localStorage.setItem("activeSessionId", sessionId);
}

export function getActiveSession(): string | null {
  return localStorage.getItem("activeSessionId");
}

export function clearActiveSession(): void {
  localStorage.removeItem("activeSessionId");
}
```

- [ ] **Step 5: Create Svelte stores**

```typescript
// ui/src/lib/stores/session.ts
import { writable, derived } from "svelte/store";
import type { AgentEvent, PlanStep } from "../types";

export const events = writable<AgentEvent[]>([]);
export const currentSessionId = writable<string | null>(null);
export const running = writable(false);

export const latestPlan = derived(events, ($events) => {
  const planUpdates = $events.filter((e) => e.type === "plan_update");
  const last = planUpdates[planUpdates.length - 1];
  return last?.type === "plan_update" ? (last as any).steps as PlanStep[] : [];
});

export const cumulativeTokens = derived(events, ($events) => {
  const usages = $events.filter((e) => e.type === "token_usage");
  const last = usages[usages.length - 1];
  if (last?.type === "token_usage") {
    return (last as any).cumulative as { prompt: number; completion: number };
  }
  return { prompt: 0, completion: 0 };
});
```

- [ ] **Step 6: Create the main +page.svelte**

Build the three-panel layout from the spec with:
- Sessions/Logs sidebar (left)
- Event stream (center) — iterate over `$events`, render cards per type
- Plan sidebar (right)
- Input bar (bottom)

Use the existing `playground/semantic_events/ui.ts` as reference for styling (CSS variables, card classes, color scheme).

This is a large Svelte file — implement the basic structure first, then iterate on individual components (EventCard, ToolCallCard, ApprovalCard, etc.) as needed.

**Session reconnection:** On mount, check `getActiveSession()` from `sse.ts`. If a sessionId is stored, fetch `GET /sessions` to verify the session is still active. If active, reconnect via `connectToSession()`. On `session_end`, call `clearActiveSession()`. On new prompt, call `saveActiveSession(sessionId)`.

- [ ] **Step 7: Verify the frontend builds and connects**

```bash
cd ui && bun run dev
# In another terminal:
cd /Users/jakubpruszynski/WebstormProjects/aidevs4 && bun run server
```

Open `http://localhost:5173`, enter a prompt, verify SSE events stream into the UI.

- [ ] **Step 8: Commit**

```bash
git add ui/
git commit -m "feat: add SvelteKit frontend with SSE streaming, three-panel layout"
```

---

## Task 9: Integration Test

**Files:** None new — manual verification

- [ ] **Step 1: Start the server**

```bash
bun run server
```

- [ ] **Step 2: Test sync mode (backward compat)**

```bash
curl -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"msg": "What is 2+2?", "sessionId": "test-sync"}'
```

Expected: `{ "msg": "...", "sessionId": "test-sync" }` (sessionId echoed back)

- [ ] **Step 3: Test stream mode (two-step)**

First, start the agent in background:

```bash
curl -X POST http://localhost:3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"msg": "What is 2+2?", "stream": true, "sessionId": "test-stream"}'
```

Expected: `{ "sessionId": "test-stream" }` — agent starts in background.

Then connect to the SSE stream:

```bash
curl -N http://localhost:3000/events/test-stream
```

Expected: SSE events streaming (event: agent_event, data: {...})

- [ ] **Step 4: Test sessions listing**

```bash
curl http://localhost:3000/sessions
```

Expected: `{ "sessions": [{ "id": "test-sync", ... }, { "id": "test-stream", ... }] }`

- [ ] **Step 5: Test logs endpoint**

```bash
curl http://localhost:3000/logs
```

Expected: JSON tree of log files

- [ ] **Step 6: Test CLI --stream**

```bash
bun run agent "What is 2+2?" --stream
```

Expected: Real-time event output in terminal

- [ ] **Step 7: Test full UI flow**

Start both server and UI dev server. Open browser. Enter prompt. Verify:
- Events stream in real-time
- Plan sidebar updates
- Token counter increments
- Session appears in session list

- [ ] **Step 8: Commit any fixes**

```bash
git add -A && git commit -m "fix: integration test corrections"
```
