import { describe, it, expect, beforeEach } from "bun:test";
import { attachLoggerListener } from "./bridge.ts";
import { createEventBus } from "../events.ts";
import type { EventBus } from "../../types/events.ts";
import type { Logger } from "../../types/logger.ts";

function createSpyLogger() {
  const calls: { method: string; args: unknown[] }[] = [];
  const handler = {
    get(_target: Logger, prop: string) {
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
      };
    },
  };
  const logger = new Proxy({} as Logger, handler);
  return { logger, calls };
}

describe("attachLoggerListener (Bus→Logger)", () => {
  let bus: EventBus;
  let calls: { method: string; args: unknown[] }[];
  let logger: Logger;
  let detach: () => void;

  beforeEach(() => {
    bus = createEventBus();
    const spy = createSpyLogger();
    calls = spy.calls;
    logger = spy.logger;
    detach = attachLoggerListener(bus, logger);
  });

  it("agent.started → log.info()", () => {
    bus.emit("agent.started", {
      agentName: "solver",
      model: "gpt-4.1",
      task: "solve the puzzle",
      depth: 0,
    });

    const call = calls.find((c) => c.method === "info");
    expect(call).toBeDefined();
    expect(call!.args[0]).toContain("solver");
  });

  it("turn.started → log.step()", () => {
    bus.emit("turn.started", {
      iteration: 3,
      maxIterations: 40,
      model: "gpt-4.1",
      messageCount: 5,
    });

    const call = calls.find((c) => c.method === "step");
    expect(call).toBeDefined();
    expect(call!.args).toEqual([3, 40, "gpt-4.1", 5]);
  });

  it("generation.completed (plan) → log.plan() with content", () => {
    bus.emit("generation.completed", {
      name: "plan",
      model: "gpt-4.1",
      input: [],
      output: { content: "1. Search for docs\n2. Extract endpoints" },
      usage: { input: 1000, output: 200, total: 1200 },
      durationMs: 1500,
      startTime: Date.now(),
    });

    const call = calls.find((c) => c.method === "plan");
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe("1. Search for docs\n2. Extract endpoints");
    expect(call!.args[1]).toBe("gpt-4.1");
    expect(call!.args[3]).toBe(1000);
    expect(call!.args[4]).toBe(200);
  });

  it("generation.completed (act) → log.llm()", () => {
    bus.emit("generation.completed", {
      name: "act",
      model: "gpt-4.1",
      input: [],
      output: { content: "response" },
      usage: { input: 800, output: 150, total: 950 },
      durationMs: 450,
      startTime: Date.now(),
    });

    const call = calls.find((c) => c.method === "llm");
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe("450ms");
    expect(call!.args[1]).toBe(800);
    expect(call!.args[2]).toBe(150);
  });

  it("tool.called → log.toolHeader() on first + log.toolCall()", () => {
    bus.emit("tool.called", {
      callId: "c1",
      name: "web_search",
      args: '{"query":"test"}',
      batchIndex: 0,
      batchSize: 2,
      startTime: Date.now(),
    });
    bus.emit("tool.called", {
      callId: "c2",
      name: "read_file",
      args: '{"path":"/tmp"}',
      batchIndex: 1,
      batchSize: 2,
      startTime: Date.now(),
    });

    const headers = calls.filter((c) => c.method === "toolHeader");
    expect(headers).toHaveLength(1);
    expect(headers[0].args[0]).toBe(2);

    const toolCalls = calls.filter((c) => c.method === "toolCall");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].args).toEqual(["web_search", '{"query":"test"}']);
    expect(toolCalls[1].args).toEqual(["read_file", '{"path":"/tmp"}']);
  });

  it("tool.succeeded → log.toolOk()", () => {
    bus.emit("tool.succeeded", {
      callId: "c1",
      name: "web_search",
      durationMs: 1200,
      result: "",
    });

    const call = calls.find((c) => c.method === "toolOk");
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe("web_search");
    expect(call!.args[1]).toBe("1.20s");
  });

  it("tool.failed → log.toolErr()", () => {
    bus.emit("tool.failed", {
      callId: "c1",
      name: "web_search",
      durationMs: 0,
      error: "timeout",
    });

    const call = calls.find((c) => c.method === "toolErr");
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe("web_search");
    expect(call!.args[1]).toBe("timeout");
  });

  it("batch.completed → log.batchDone()", () => {
    bus.emit("batch.completed", {
      batchId: "b1",
      count: 3,
      durationMs: 2500,
      succeeded: 2,
      failed: 1,
    });

    const call = calls.find((c) => c.method === "batchDone");
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe(3);
    expect(call!.args[1]).toBe("2.50s");
  });

  it("memory.observation → log.memoryObserve()", () => {
    bus.emit("memory.observation", {
      tokensBefore: 30000,
      tokensAfter: 15000,
    });

    const call = calls.find((c) => c.method === "memoryObserve");
    expect(call).toBeDefined();
    expect(call!.args).toEqual([30000, 15000]);
  });

  it("memory.reflection → log.memoryReflect()", () => {
    bus.emit("memory.reflection", {
      level: 2,
      tokensBefore: 40000,
      tokensAfter: 20000,
    });

    const call = calls.find((c) => c.method === "memoryReflect");
    expect(call).toBeDefined();
    expect(call!.args).toEqual([2, 40000, 20000]);
  });

  it("session.completed max_iterations → log.maxIter()", () => {
    bus.emit("session.completed", {
      reason: "max_iterations",
      iterations: 40,
      tokens: {
        plan: { promptTokens: 0, completionTokens: 0 },
        act: { promptTokens: 0, completionTokens: 0 },
      },
    });

    const call = calls.find((c) => c.method === "maxIter");
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe(40);
  });

  it("session.failed → log.error()", () => {
    bus.emit("session.failed", {
      iterations: 3,
      tokens: {
        plan: { promptTokens: 0, completionTokens: 0 },
        act: { promptTokens: 0, completionTokens: 0 },
      },
      error: "something went wrong",
    });

    const call = calls.find((c) => c.method === "error");
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe("Session failed: something went wrong");
  });

  it("detach() stops all event delivery", () => {
    detach();

    bus.emit("turn.started", {
      iteration: 1,
      maxIterations: 40,
      model: "m",
      messageCount: 1,
    });

    expect(calls).toHaveLength(0);
  });
});
