import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createEventBus } from "../../src/infra/events.ts";
import type { EventBus } from "../../src/types/events.ts";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus();
  });

  it("delivers events to exact-match listeners", () => {
    const received: unknown[] = [];
    bus.on("turn.started", (e) => received.push(e.data));

    bus.emit("turn.started", {
      iteration: 0,
      maxIterations: 40,
      model: "gpt-4.1",
      messageCount: 3,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      iteration: 0,
      maxIterations: 40,
      model: "gpt-4.1",
      messageCount: 3,
    });
  });

  it("delivers events to wildcard listeners", () => {
    const received: string[] = [];
    bus.onAny((e) => received.push(e.type));

    bus.emit("tool.called", { callId: "c1", name: "web_search", args: "{}", batchIndex: 0, batchSize: 1 });
    bus.emit("tool.succeeded", {
      callId: "c1",
      name: "web_search",
      durationMs: 100,
      result: "ok",
    });

    expect(received).toEqual(["tool.called", "tool.succeeded"]);
  });

  it("does not deliver events to unrelated exact listeners", () => {
    const received: unknown[] = [];
    bus.on("session.opened", (e) => received.push(e.data));

    bus.emit("turn.started", {
      iteration: 0,
      maxIterations: 40,
      model: "gpt-4.1",
      messageCount: 1,
    });

    expect(received).toHaveLength(0);
  });

  it("on() returns an unsubscribe function", () => {
    const received: unknown[] = [];
    const unsub = bus.on("turn.started", (e) => received.push(e.data));

    bus.emit("turn.started", {
      iteration: 0,
      maxIterations: 40,
      model: "m",
      messageCount: 1,
    });
    unsub();
    bus.emit("turn.started", {
      iteration: 1,
      maxIterations: 40,
      model: "m",
      messageCount: 2,
    });

    expect(received).toHaveLength(1);
  });

  it("onAny() returns an unsubscribe function", () => {
    const received: string[] = [];
    const unsub = bus.onAny((e) => received.push(e.type));

    bus.emit("tool.called", { callId: "c1", name: "a", args: "{}", batchIndex: 0, batchSize: 1 });
    unsub();
    bus.emit("tool.called", { callId: "c2", name: "b", args: "{}", batchIndex: 0, batchSize: 1 });

    expect(received).toHaveLength(1);
  });

  it("off() removes an exact listener", () => {
    const received: unknown[] = [];
    const fn = (e: any) => received.push(e.data);
    bus.on("turn.started", fn);
    bus.off("turn.started", fn);

    bus.emit("turn.started", {
      iteration: 0,
      maxIterations: 40,
      model: "m",
      messageCount: 1,
    });

    expect(received).toHaveLength(0);
  });

  it("offAny() removes a wildcard listener", () => {
    const received: string[] = [];
    const fn = (e: any) => received.push(e.type);
    bus.onAny(fn);
    bus.offAny(fn);

    bus.emit("tool.called", { callId: "c1", name: "a", args: "{}", batchIndex: 0, batchSize: 1 });
    expect(received).toHaveLength(0);
  });

  it("clear() removes all listeners", () => {
    const exact: unknown[] = [];
    const wild: unknown[] = [];
    bus.on("turn.started", (e) => exact.push(e));
    bus.onAny((e) => wild.push(e));

    bus.clear();

    bus.emit("turn.started", {
      iteration: 0,
      maxIterations: 40,
      model: "m",
      messageCount: 1,
    });

    expect(exact).toHaveLength(0);
    expect(wild).toHaveLength(0);
  });

  it("populates envelope fields (id, type, ts)", () => {
    let captured: any;
    bus.onAny((e) => (captured = e));

    const before = Date.now();
    bus.emit("session.opened", { assistant: "default", model: "gpt-4.1" });
    const after = Date.now();

    expect(captured.id).toBeString();
    expect(captured.id.length).toBeGreaterThan(0);
    expect(captured.type).toBe("session.opened");
    expect(captured.ts).toBeGreaterThanOrEqual(before);
    expect(captured.ts).toBeLessThanOrEqual(after);
  });

  it("a failing listener does not block other listeners", () => {
    const received: string[] = [];
    const consoleSpy = mock(() => {});
    const origError = console.error;
    console.error = consoleSpy;

    try {
      bus.on("tool.called", () => {
        throw new Error("boom");
      });
      bus.on("tool.called", (e) => received.push(e.data.name));
      bus.onAny((e) => received.push("wild:" + e.type));

      bus.emit("tool.called", { callId: "c1", name: "test_tool" });

      expect(received).toEqual(["test_tool", "wild:tool.called"]);
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      console.error = origError;
    }
  });

  it("a failing wildcard listener does not block other wildcards", () => {
    const received: string[] = [];
    const origError = console.error;
    console.error = mock(() => {});

    try {
      bus.onAny(() => {
        throw new Error("boom");
      });
      bus.onAny((e) => received.push(e.type));

      bus.emit("session.opened", { assistant: "a", model: "m" });
      expect(received).toEqual(["session.opened"]);
    } finally {
      console.error = origError;
    }
  });

  it("supports multiple listeners for the same event type", () => {
    const a: number[] = [];
    const b: number[] = [];
    bus.on("turn.started", (e) => a.push(e.data.iteration));
    bus.on("turn.started", (e) => b.push(e.data.iteration));

    bus.emit("turn.started", {
      iteration: 5,
      maxIterations: 40,
      model: "m",
      messageCount: 1,
    });

    expect(a).toEqual([5]);
    expect(b).toEqual([5]);
  });
});
