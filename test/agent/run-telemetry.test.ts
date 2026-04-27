import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { bus } from "../../src/infra/events.ts";
import type { AgentEvent, EventType } from "../../src/types/events.ts";
import {
  emitRunStarted,
  emitAgentStarted,
  emitTurnStarted,
  emitTurnCompleted,
  emitGenerationStarted,
  emitGenerationCompleted,
  emitToolCalled,
  emitToolSucceeded,
  emitToolFailed,
  emitBatchStarted,
  emitBatchCompleted,
  emitAnswerTerminal,
  emitMaxIterationsTerminal,
  emitFailureTerminal,
} from "../../src/agent/run-telemetry.ts";

// ── Helpers ─────────────────────────────────────────────────

function capture(): { events: AgentEvent[]; detach: () => void } {
  const events: AgentEvent[] = [];
  const detach = bus.onAny((e) => events.push(e));
  return { events, detach };
}

function types(events: AgentEvent[]): EventType[] {
  return events.map((e) => e.type);
}

let detach: (() => void) | undefined;

beforeEach(() => {
  bus.clear();
});

afterEach(() => {
  detach?.();
  detach = undefined;
  bus.clear();
});

// ── Single-event helpers ────────────────────────────────────

describe("run-telemetry single-event helpers", () => {
  it("emitRunStarted emits run.started", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitRunStarted({ assistant: "a", model: "m", userInput: "hi" });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.started");
    expect((events[0] as any).assistant).toBe("a");
    expect((events[0] as any).model).toBe("m");
    expect((events[0] as any).userInput).toBe("hi");
  });

  it("emitAgentStarted emits agent.started", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitAgentStarted({ agentName: "test", model: "m", task: "do stuff", depth: 0 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("agent.started");
    expect((events[0] as any).agentName).toBe("test");
  });

  it("emitTurnStarted emits turn.started", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitTurnStarted({ index: 0, maxTurns: 40, model: "m", messageCount: 3 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("turn.started");
  });

  it("emitTurnCompleted emits turn.completed", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitTurnCompleted({ index: 1, outcome: "continue", durationMs: 200, tokens: { promptTokens: 0, completionTokens: 0 } });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("turn.completed");
    expect((events[0] as any).outcome).toBe("continue");
  });

  it("emitGenerationStarted emits generation.started", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitGenerationStarted({ name: "act", model: "m", startTime: 1000 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("generation.started");
  });

  it("emitGenerationCompleted emits generation.completed", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitGenerationCompleted({
      name: "act",
      model: "m",
      input: [],
      output: { content: "hi" },
      usage: { input: 1, output: 2, total: 3 },
      durationMs: 50,
      startTime: 1000,
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("generation.completed");
  });

  it("emitToolCalled emits tool.called", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitToolCalled({ toolCallId: "tc1", name: "foo", args: "{}", batchIndex: 0, batchSize: 1, startTime: 100 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.called");
  });

  it("emitToolSucceeded emits tool.succeeded", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitToolSucceeded({ toolCallId: "tc1", name: "foo", durationMs: 10, result: "ok", args: "{}", startTime: 100 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.succeeded");
  });

  it("emitToolFailed emits tool.failed", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitToolFailed({ toolCallId: "tc1", name: "foo", durationMs: 10, error: "err", args: "{}", startTime: 100 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tool.failed");
  });

  it("emitBatchStarted emits batch.started", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitBatchStarted({ batchId: "b1", toolCallIds: ["a", "b"], count: 2 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("batch.started");
  });

  it("emitBatchCompleted emits batch.completed", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitBatchCompleted({ batchId: "b1", count: 2, durationMs: 100, succeeded: 1, failed: 1 });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("batch.completed");
  });
});

// ── Composite emitters ──────────────────────────────────────

describe("run-telemetry composite emitters", () => {
  it("emitAnswerTerminal emits turn.completed, agent.answered, agent.completed, run.completed in order", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitAnswerTerminal({
      agentName: "a",
      iterationIndex: 2,
      iterationCount: 3,
      turnDurationMs: 100,
      runDurationMs: 500,
      tokens: { promptTokens: 10, completionTokens: 20 },
      answerText: "done",
    });
    expect(types(events)).toEqual([
      "turn.completed",
      "agent.answered",
      "agent.completed",
      "run.completed",
    ]);
    expect((events[0] as any).outcome).toBe("answer");
    expect((events[0] as any).index).toBe(2);
    expect((events[1] as any).text).toBe("done");
    expect((events[2] as any).iterations).toBe(3);
    expect((events[3] as any).reason).toBe("answer");
  });

  it("emitMaxIterationsTerminal emits turn.completed, agent.completed, run.completed in order", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitMaxIterationsTerminal({
      agentName: "a",
      maxIterations: 40,
      turnDurationMs: 100,
      runDurationMs: 500,
      tokens: { promptTokens: 10, completionTokens: 20 },
    });
    expect(types(events)).toEqual([
      "turn.completed",
      "agent.completed",
      "run.completed",
    ]);
    expect((events[0] as any).outcome).toBe("max_iterations");
    expect((events[0] as any).index).toBe(39);
    expect((events[1] as any).result).toBeNull();
    expect((events[2] as any).reason).toBe("max_iterations");
  });

  it("emitFailureTerminal emits agent.failed, run.failed in order", () => {
    const { events, detach: d } = capture();
    detach = d;
    emitFailureTerminal({
      agentName: "a",
      iterations: 5,
      runDurationMs: 300,
      tokens: { promptTokens: 10, completionTokens: 20 },
      error: "kaboom",
    });
    expect(types(events)).toEqual(["agent.failed", "run.failed"]);
    expect((events[0] as any).error).toBe("kaboom");
    expect((events[1] as any).error).toBe("kaboom");
  });
});

// ── Token snapshot semantics ────────────────────────────────

describe("run-telemetry token snapshots", () => {
  it("emitAnswerTerminal snapshots tokens — mutation after call does not affect emitted payload", () => {
    const { events, detach: d } = capture();
    detach = d;
    const tokens = { promptTokens: 10, completionTokens: 20 };
    emitAnswerTerminal({
      agentName: "a",
      iterationIndex: 0,
      iterationCount: 1,
      turnDurationMs: 50,
      runDurationMs: 100,
      tokens,
      answerText: "ok",
    });
    // Mutate after call
    tokens.promptTokens = 999;
    tokens.completionTokens = 999;

    for (const e of events) {
      if ("tokens" in e) {
        expect((e as any).tokens.promptTokens).toBe(10);
        expect((e as any).tokens.completionTokens).toBe(20);
      }
    }
  });

  it("emitTurnCompleted snapshots tokens", () => {
    const { events, detach: d } = capture();
    detach = d;
    const tokens = { promptTokens: 5, completionTokens: 3 };
    emitTurnCompleted({ index: 0, outcome: "continue", durationMs: 10, tokens });
    tokens.promptTokens = 999;
    expect((events[0] as any).tokens.promptTokens).toBe(5);
  });

  it("emitMaxIterationsTerminal snapshots tokens independently across all emitted events", () => {
    const { events, detach: d } = capture();
    detach = d;
    const tokens = { promptTokens: 10, completionTokens: 20 };
    emitMaxIterationsTerminal({
      agentName: "a",
      maxIterations: 40,
      turnDurationMs: 100,
      runDurationMs: 500,
      tokens,
    });
    tokens.promptTokens = 999;
    for (const e of events) {
      if ("tokens" in e) {
        expect((e as any).tokens.promptTokens).toBe(10);
      }
    }
  });

  it("emitFailureTerminal snapshots tokens", () => {
    const { events, detach: d } = capture();
    detach = d;
    const tokens = { promptTokens: 3, completionTokens: 1 };
    emitFailureTerminal({ agentName: "a", iterations: 1, runDurationMs: 100, tokens, error: "x" });
    tokens.promptTokens = 999;
    const runFailed = events.find((e) => e.type === "run.failed")!;
    expect((runFailed as any).tokens.promptTokens).toBe(3);
  });
});
