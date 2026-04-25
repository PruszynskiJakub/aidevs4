import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonlWriter } from "./jsonl.ts";
import { createEventBus } from "../events.ts";
import type { AgentEvent } from "../../types/events.ts";

describe("JsonlWriter", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function setup() {
    tmpDir = await mkdtemp(join(tmpdir(), "jsonl-test-"));
    const pathFn = (event: AgentEvent) =>
      join(tmpDir, event.sessionId ?? "_global", "events.jsonl");

    const writer = createJsonlWriter(pathFn);
    const bus = createEventBus();
    bus.onAny(writer.listener);
    return { bus, writer };
  }

  it("writes one JSON line per event", async () => {
    const { bus, writer } = await setup();

    bus.emit("run.started", { assistant: "default", model: "gpt-4.1" });
    bus.emit("turn.started", {
      index: 0,
      maxTurns: 40,
      model: "gpt-4.1",
      messageCount: 3,
    });

    await writer.flush();

    const content = await readFile(
      join(tmpDir, "_global", "events.jsonl"),
      "utf-8",
    );
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("run.started");
    expect(first.data.assistant).toBe("default");
    expect(first.id).toBeString();
    expect(first.ts).toBeNumber();

    const second = JSON.parse(lines[1]);
    expect(second.type).toBe("turn.started");
    expect(second.data.index).toBe(0);

    writer.dispose();
  });

  it("preserves event ordering", async () => {
    const { bus, writer } = await setup();

    for (let i = 0; i < 10; i++) {
      bus.emit("turn.started", {
        index: i,
        maxTurns: 40,
        model: "m",
        messageCount: i,
      });
    }

    await writer.flush();

    const content = await readFile(
      join(tmpDir, "_global", "events.jsonl"),
      "utf-8",
    );
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(10);

    for (let i = 0; i < 10; i++) {
      const parsed = JSON.parse(lines[i]);
      expect(parsed.data.index).toBe(i);
    }

    writer.dispose();
  });

  it("omits sid when sessionId is undefined", async () => {
    const { bus, writer } = await setup();

    bus.emit("run.started", { assistant: "a", model: "m" });
    await writer.flush();

    const content = await readFile(
      join(tmpDir, "_global", "events.jsonl"),
      "utf-8",
    );
    const parsed = JSON.parse(content.trim());
    expect(parsed.sid).toBeUndefined();

    writer.dispose();
  });

  it("each line is valid JSON", async () => {
    const { bus, writer } = await setup();

    bus.emit("tool.called", { toolCallId: "c1", name: "web_search", args: "{}", batchIndex: 0, batchSize: 1, startTime: Date.now() });
    bus.emit("tool.succeeded", {
      toolCallId: "c1",
      name: "web_search",
      durationMs: 500,
      result: "found it",
    });
    bus.emit("batch.completed", {
      batchId: "b1",
      count: 1,
      durationMs: 500,
      succeeded: 1,
      failed: 0,
    });

    await writer.flush();

    const content = await readFile(
      join(tmpDir, "_global", "events.jsonl"),
      "utf-8",
    );
    const lines = content.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    writer.dispose();
  });
});
