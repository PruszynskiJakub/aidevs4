import { describe, it, expect, beforeEach } from "bun:test";
import { sessionService } from "./session.ts";

beforeEach(() => {
  sessionService._clear();
});

describe("sessionService", () => {
  it("creates a new session on getOrCreate", () => {
    const session = sessionService.getOrCreate("s1");
    expect(session.id).toBe("s1");
    expect(session.messages).toEqual([]);
    expect(session.createdAt).toBeInstanceOf(Date);
  });

  it("returns the same session on repeated getOrCreate", () => {
    const a = sessionService.getOrCreate("s1");
    const b = sessionService.getOrCreate("s1");
    expect(a).toBe(b);
  });

  it("appends messages and updates timestamp", async () => {
    sessionService.getOrCreate("s1");
    const before = sessionService.getOrCreate("s1").updatedAt;

    await new Promise((r) => setTimeout(r, 5));

    sessionService.appendMessage("s1", { role: "user", content: "hi" });
    const session = sessionService.getOrCreate("s1");
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual({ role: "user", content: "hi" });
    expect(session.updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it("getMessages returns session messages", () => {
    sessionService.appendMessage("s1", { role: "user", content: "a" });
    sessionService.appendMessage("s1", { role: "user", content: "b" });
    const msgs = sessionService.getMessages("s1");
    expect(msgs).toHaveLength(2);
  });

  it("serializes tasks on the same session", async () => {
    const order: number[] = [];

    const p1 = sessionService.enqueue("s1", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    });

    const p2 = sessionService.enqueue("s1", async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("runs tasks for different sessions concurrently", async () => {
    const order: string[] = [];

    const p1 = sessionService.enqueue("s1", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("s1");
    });

    const p2 = sessionService.enqueue("s2", async () => {
      order.push("s2");
    });

    await Promise.all([p1, p2]);
    // s2 should finish first because it doesn't sleep
    expect(order).toEqual(["s2", "s1"]);
  });
});
