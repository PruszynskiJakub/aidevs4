import { describe, expect, test } from "bun:test";
import {
  deriveSessionId,
  toSlackMarkdown,
  splitMessage,
  StatusTracker,
} from "./slack-utils.ts";
import type { AgentEvent } from "./types/events.ts";

// ── deriveSessionId ────────────────────────────────────────

describe("deriveSessionId", () => {
  test("uses thread_ts when present and replaces dots with dashes", () => {
    const id = deriveSessionId("T1", "C1", "1715000000.000100", "1715000001.000200");
    expect(id).toBe("slack-T1-C1-1715000000-000100");
  });

  test("falls back to message ts when no thread_ts", () => {
    const id = deriveSessionId("T1", "C1", undefined, "1715000001.000200");
    expect(id).toBe("slack-T1-C1-1715000001-000200");
  });

  test("different channels produce different session IDs", () => {
    const a = deriveSessionId("T1", "C1", undefined, "1715000000.000100");
    const b = deriveSessionId("T1", "C2", undefined, "1715000000.000100");
    expect(a).not.toBe(b);
  });

  test("different teams produce different session IDs", () => {
    const a = deriveSessionId("T1", "C1", undefined, "1715000000.000100");
    const b = deriveSessionId("T2", "C1", undefined, "1715000000.000100");
    expect(a).not.toBe(b);
  });
});

// ── toSlackMarkdown ────────────────────────────────────────

describe("toSlackMarkdown", () => {
  test("converts bold **text** to *text*", () => {
    expect(toSlackMarkdown("**hello**")).toBe("*hello*");
  });

  test("converts bold __text__ to *text*", () => {
    expect(toSlackMarkdown("__hello__")).toBe("*hello*");
  });

  test("converts strikethrough", () => {
    expect(toSlackMarkdown("~~deleted~~")).toBe("~deleted~");
  });

  test("preserves inline code", () => {
    expect(toSlackMarkdown("`code`")).toBe("`code`");
  });

  test("converts markdown links to Slack format", () => {
    expect(toSlackMarkdown("[click](https://example.com)")).toBe("<https://example.com|click>");
  });

  test("strips language identifier from fenced code blocks", () => {
    expect(toSlackMarkdown("```typescript\nconst x = 1;\n```")).toBe("```\nconst x = 1;\n```");
  });

  test("handles text with no markdown", () => {
    expect(toSlackMarkdown("plain text")).toBe("plain text");
  });
});

// ── splitMessage ───────────────────────────────────────────

describe("splitMessage", () => {
  test("returns single chunk for short messages", () => {
    expect(splitMessage("hello", 100)).toEqual(["hello"]);
  });

  test("splits at paragraph boundaries", () => {
    const text = "a".repeat(50) + "\n\n" + "b".repeat(50);
    const chunks = splitMessage(text, 60);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(50));
    expect(chunks[1]).toBe("b".repeat(50));
  });

  test("splits at line boundaries when no paragraph break", () => {
    const text = "a".repeat(50) + "\n" + "b".repeat(50);
    const chunks = splitMessage(text, 60);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(50));
    expect(chunks[1]).toBe("b".repeat(50));
  });

  test("splits at word boundaries when no line break", () => {
    const text = "word ".repeat(20).trim(); // 99 chars
    const chunks = splitMessage(text, 50);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  test("hard splits when no boundaries found", () => {
    const text = "a".repeat(100);
    const chunks = splitMessage(text, 40);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe("a".repeat(40));
    expect(chunks[1]).toBe("a".repeat(40));
    expect(chunks[2]).toBe("a".repeat(20));
  });

  test("uses default 4000 char limit", () => {
    const short = "a".repeat(3999);
    expect(splitMessage(short)).toEqual([short]);

    const long = "a".repeat(4001);
    expect(splitMessage(long).length).toBe(2);
  });
});

// ── StatusTracker ──────────────────────────────────────────

describe("StatusTracker", () => {
  const makeEvent = (type: string, data: Record<string, unknown>): AgentEvent => ({
    id: "test",
    type,
    ts: Date.now(),
    sessionId: "s1",
    ...data,
  } as AgentEvent);

  test("shows active tool on tool.called", () => {
    const tracker = new StatusTracker();
    const result = tracker.update(makeEvent("tool.called", { name: "web", toolCallId: "c1", args: "{}", batchIndex: 0, batchSize: 1, startTime: Date.now() }));
    expect(result).toContain("`web`");
    expect(result).toContain(":gear:");
  });

  test("shows completed tool after tool.succeeded", () => {
    const tracker = new StatusTracker();
    tracker.update(makeEvent("tool.called", { name: "web", toolCallId: "c1", args: "{}", batchIndex: 0, batchSize: 1, startTime: Date.now() }));
    const result = tracker.update(makeEvent("tool.succeeded", { name: "web", toolCallId: "c1", durationMs: 100, result: "ok" }));
    expect(result).toContain(":white_check_mark:");
    expect(result).toContain("`web`");
    expect(result).not.toContain(":gear:"); // no longer active
  });

  test("shows failed tool with x emoji", () => {
    const tracker = new StatusTracker();
    tracker.update(makeEvent("tool.called", { name: "web", toolCallId: "c1", args: "{}", batchIndex: 0, batchSize: 1, startTime: Date.now() }));
    const result = tracker.update(makeEvent("tool.failed", { name: "web", toolCallId: "c1", durationMs: 0, error: "timeout" }));
    expect(result).toContain(":x:");
    expect(result).toContain("`web`");
  });

  test("tracks multiple concurrent tools", () => {
    const tracker = new StatusTracker();
    tracker.update(makeEvent("tool.called", { name: "glob", toolCallId: "c1", args: "{}", batchIndex: 0, batchSize: 2, startTime: Date.now() }));
    const result = tracker.update(makeEvent("tool.called", { name: "grep", toolCallId: "c2", args: "{}", batchIndex: 1, batchSize: 2, startTime: Date.now() }));
    expect(result).toContain("`glob`");
    expect(result).toContain("`grep`");
    expect(result).toContain(":gear:");
  });

  test("returns null for unrelated events", () => {
    const tracker = new StatusTracker();
    expect(tracker.update(makeEvent("generation.started", { name: "act", model: "m", startTime: Date.now() }))).toBeNull();
    expect(tracker.update(makeEvent("run.started", { assistant: "a", model: "m" }))).toBeNull();
  });

  test("lists all completed tools in history", () => {
    const tracker = new StatusTracker();
    tracker.update(makeEvent("tool.called", { name: "glob", toolCallId: "c1", args: "{}", batchIndex: 0, batchSize: 1, startTime: Date.now() }));
    tracker.update(makeEvent("tool.succeeded", { name: "glob", toolCallId: "c1", durationMs: 10, result: "ok" }));
    tracker.update(makeEvent("tool.called", { name: "grep", toolCallId: "c2", args: "{}", batchIndex: 0, batchSize: 1, startTime: Date.now() }));
    const result = tracker.update(makeEvent("tool.succeeded", { name: "grep", toolCallId: "c2", durationMs: 20, result: "ok" }));
    expect(result).toContain("`glob`");
    expect(result).toContain("`grep`");
    // Both should have checkmarks (multiline)
    const lines = result!.split("\n");
    expect(lines.filter(l => l.includes(":white_check_mark:")).length).toBe(2);
  });

  test("shows history + active tools together", () => {
    const tracker = new StatusTracker();
    tracker.update(makeEvent("tool.called", { name: "glob", toolCallId: "c1", args: "{}", batchIndex: 0, batchSize: 1, startTime: Date.now() }));
    tracker.update(makeEvent("tool.succeeded", { name: "glob", toolCallId: "c1", durationMs: 10, result: "ok" }));
    const result = tracker.update(makeEvent("tool.called", { name: "read_file", toolCallId: "c2", args: "{}", batchIndex: 0, batchSize: 1, startTime: Date.now() }));
    expect(result).toContain(":white_check_mark:");
    expect(result).toContain("`glob`");
    expect(result).toContain(":gear:");
    expect(result).toContain("`read_file`");
  });
});
